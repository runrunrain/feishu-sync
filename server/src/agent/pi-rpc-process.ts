/**
 * PiRpcProcess — 单个 pi RPC 子进程封装（设计 §4）
 *
 * - 严格 JSONL 帧：只按 LF 分帧（不用 readline —— U+2028/U+2029 在 JSON
 *   字符串内合法，readline 会误分帧）。
 * - 命令白名单：只允许 prompt/steer/follow_up/abort/get_state/
 *   get_available_models/get_messages/set_auto_retry/abort_retry/
 *   set_session_name/compact。禁止 bash/switch_session/fork/clone/
 *   new_session/export_html（bash 会绕过工具白名单直接执行 shell）。
 * - extension_ui_request 对话类请求立即回 cancelled。
 * - 完成判定（§4.4）：prompt success:false 立即失败；success:true 后等待
 *   agent_settled；aborted → cancelled；最后 assistant stopReason ∈
 *   {error, aborted} → failed；auto_retry 累计 > maxRetries → abort +
 *   failed；超时 → abort + failed；进程意外退出 → failed。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { piThinkingLevels } from './thinking-capabilities.js';
import type { AgentThinkingLevel } from '../types/agent-knowledge.js';

/** RPC 命令白名单（§4.3）。 */
export const RPC_COMMAND_WHITELIST: ReadonlySet<string> = new Set([
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'get_state',
  'get_available_models',
  'get_messages',
  'set_auto_retry',
  'abort_retry',
  'set_session_name',
  'compact',
]);

/** 显式禁止的高危命令（防御性：白名单之外的都拒）。 */
export const RPC_COMMAND_BLACKLIST: ReadonlySet<string> = new Set([
  'bash',
  'abort_bash',
  'switch_session',
  'fork',
  'clone',
  'new_session',
  'export_html',
  'set_model',
  'cycle_model',
]);

export interface RpcSpawnOptions {
  nodePath: string;
  piCliPath: string;
  extensionPath?: string;
  additionalExtensionPaths?: string[];
  allowExternalPluginTools?: boolean;
  additionalSkillPaths?: string[];
  additionalPromptPaths?: string[];
  additionalThemePaths?: string[];
  tools: string[];
  sessionDir?: string;
  sessionId?: string;
  /** 无会话（探测与构建运行用） */
  noSession?: boolean;
  /** --no-tools（探测用） */
  noTools?: boolean;
  model?: string;
  thinking?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** agent_settled 前单 prompt 超时（ms） */
  promptTimeoutMs?: number;
  /** auto_retry_start 累计上限（超过即 abort 并判失败） */
  maxAutoRetries?: number;
}

export interface RpcEventPayload {
  type: string;
  [key: string]: unknown;
}

export interface RunOutcome {
  outcome: 'completed' | 'failed' | 'aborted';
  error?: { code: string; message: string };
  lastAssistantText?: string;
}

interface PendingCommand {
  resolve: (value: { success: boolean; data?: unknown; error?: string }) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class PiRpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_AUTO_RETRIES = 3;

export class PiRpcProcess extends EventEmitter {
  readonly id: string;
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingCommand>();
  private nextSeq = 1;
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private stderrTail: string[] = [];
  private stdoutBuffer = '';
  private readonly options: RpcSpawnOptions;

  // 单次运行判定状态
  private activeRun: {
    runId: string;
    resolve: (outcome: RunOutcome) => void;
    autoRetryCount: number;
    lastStopReason: string | null;
    lastAssistantText: string | null;
    lastErrorText: string | null;
    settled: boolean;
    aborting: boolean;
    timeoutTimer?: NodeJS.Timeout;
    finished: boolean;
  } | null = null;

  constructor(options: RpcSpawnOptions) {
    super();
    this.options = options;
    this.id = `rpc_${crypto.randomBytes(6).toString('hex')}`;
  }

  /** 启动子进程并等待进程就绪（首行 JSON 或短暂静默即认为已启动）。 */
  async start(startupTimeoutMs = 15_000): Promise<void> {
    if (this.child) throw new PiRpcError('already_started', '进程已启动');

    const args: string[] = [this.options.piCliPath, '--mode', 'rpc'];
    args.push(
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-themes',
      '--no-mcp',
      '--no-approve',
      '--offline',
    );
    if (this.options.noSession) {
      args.push('--no-session');
    } else {
      if (this.options.sessionDir) args.push('--session-dir', this.options.sessionDir);
      if (this.options.sessionId) args.push('--session-id', this.options.sessionId);
    }
    if (this.options.noTools) {
      args.push('--no-tools');
    } else if (this.options.tools.length > 0 && !this.options.allowExternalPluginTools) {
      args.push('--tools', this.options.tools.join(','));
    }
    for (const extension of new Set([this.options.extensionPath, ...(this.options.additionalExtensionPaths ?? [])])) {
      if (extension) args.push('-e', extension);
    }
    for (const [flag, paths] of [
      ['--skill', this.options.additionalSkillPaths],
      ['--prompt-template', this.options.additionalPromptPaths],
      ['--theme', this.options.additionalThemePaths],
    ] as const) for (const resource of paths ?? []) args.push(flag, resource);
    if (this.options.model) {
      const slash = this.options.model.indexOf('/');
      if (slash > 0) {
        args.push('--provider', this.options.model.slice(0, slash));
        args.push('--model', this.options.model.slice(slash + 1));
      } else {
        args.push('--model', this.options.model);
      }
    }
    if (this.options.thinking) {
      args.push('--thinking', this.options.thinking);
    }

    // 目录准备
    fs.mkdirSync(this.options.cwd, { recursive: true });
    if (this.options.sessionDir) fs.mkdirSync(this.options.sessionDir, { recursive: true });

    this.child = spawn(this.options.nodePath, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const child = this.child;
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new PiRpcError('pi_spawn_failed', '无法建立子进程 stdio 管道');
    }

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.onStdoutData(chunk));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.join('').length > 16_000) {
        // 保留尾部约 16KB
        const joined = this.stderrTail.join('');
        this.stderrTail = [joined.slice(-12_000)];
      }
      this.emit('stderr', chunk);
    });
    child.on('error', (error) => {
      this.failPending(new PiRpcError('pi_spawn_failed', error.message));
      this.finishActiveRun({
        outcome: 'failed',
        error: { code: 'pi_spawn_failed', message: error.message },
      });
    });
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      this.failPending(new PiRpcError('pi_process_exited', `pi 进程退出（code=${code} signal=${signal}）`));
      this.finishActiveRun({
        outcome: 'failed',
        error: {
          code: 'pi_process_exited',
          message: `pi 进程意外退出（code=${code} signal=${signal}）\nstderr 尾部：\n${this.stderrTailText()}`,
        },
      });
      this.emit('exit', { code, signal });
    });

    // 等待启动信号：收到任一 JSON 行（response 或事件）即认为 RPC 就绪。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 没有任何输出：主动探测一次 get_state（其 response 会触发 ready）
        this.sendCommand('get_state', {}).catch(() => undefined);
        setTimeout(() => {
          if (this.exited) return;
          resolve(); // 仍无输出也放行，后续命令会以超时/退出报错
        }, 3000);
      }, Math.min(startupTimeoutMs, 8000));
      timer.unref?.();
      const onFirst = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('first-line', onFirst);
      // 立即握手；stdin会缓冲到Pi启动完成，避免每次RPC先空等8秒。
      this.sendCommand('get_state', {}, startupTimeoutMs).catch(() => undefined);
      this.once('exit', () => {
        clearTimeout(timer);
        reject(new PiRpcError('pi_spawn_failed', `pi 进程启动即退出：${this.stderrTailText()}`));
      });
    });
  }

  private stderrTailText(limitBytes = 4096): string {
    const joined = this.stderrTail.join('');
    return joined.length > limitBytes ? `…${joined.slice(-limitBytes)}` : joined;
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    // 只按 LF 分帧（容忍尾部 CR）
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit('protocol_error', line);
      return;
    }
    this.emit('first-line');
    this.emit('record', record);

    const type = record.type;
    if (type === 'response') {
      const id = typeof record.id === 'string' ? record.id : null;
      const command = typeof record.command === 'string' ? record.command : '';
      const success = record.success === true;
      if (id && this.pending.has(id)) {
        const pendingEntry = this.pending.get(id)!;
        this.pending.delete(id);
        if (pendingEntry.timer) clearTimeout(pendingEntry.timer);
        if (success) {
          pendingEntry.resolve({ success: true, data: record.data });
        } else {
          pendingEntry.resolve({ success: false, error: typeof record.error === 'string' ? record.error : 'unknown error' });
        }
      }
      // 启动期 get_state 的 response 可能先于事件到达
      this.handleResponseForRun(command, success, record);
      return;
    }
    if (type === 'extension_ui_request') {
      this.handleExtensionUiRequest(record);
      return;
    }
    // 会话事件
    this.handleSessionEvent(record as RpcEventPayload);
  }

  /** prompt 命令的 response 直接决定运行成败（§4.4）。 */
  private handleResponseForRun(command: string, success: boolean, record: Record<string, unknown>): void {
    if (!this.activeRun || this.activeRun.finished) return;
    if (command !== 'prompt' && command !== 'steer' && command !== 'follow_up') return;
    if (!success) {
      const errorText = typeof record.error === 'string' ? record.error : 'prompt 被拒绝';
      this.finishActiveRun({
        outcome: 'failed',
        error: { code: classifyPromptError(errorText), message: errorText.slice(0, 500) },
      });
    }
    // success:true → 继续等待事件（agent_settled 等）。
  }

  private handleExtensionUiRequest(record: Record<string, unknown>): void {
    const id = typeof record.id === 'string' ? record.id : '';
    const method = typeof record.method === 'string' ? record.method : '';
    const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);
    if (id && dialogMethods.has(method)) {
      this.writeLine(JSON.stringify({ type: 'extension_ui_response', id, cancelled: true }));
    }
    // notify/setStatus 等即发即弃：忽略。
  }

  private handleSessionEvent(event: RpcEventPayload): void {
    this.emit('event', event);
    const run = this.activeRun;
    if (event.type === 'message_end') {
      const message = event.message as { role?: string; stopReason?: string; content?: unknown } | undefined;
      if (message && message.role === 'assistant') {
        if (run) {
          run.lastStopReason = message.stopReason ?? null;
          run.lastAssistantText = extractText(message.content);
        }
        this.emit('assistant_message_end', message);
      } else if (message) {
        this.emit('other_message_end', message);
      }
      return;
    }
    if (event.type === 'message_update') {
      const assistantEvent = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (assistantEvent?.type === 'text_delta' && typeof assistantEvent.delta === 'string') {
        this.emit('text_delta', assistantEvent.delta);
      }
      return;
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      this.emit(event.type, event);
      return;
    }
    if (event.type === 'auto_retry_start') {
      if (run && !run.finished) {
        run.autoRetryCount += 1;
        if (run.autoRetryCount > (this.options.maxAutoRetries ?? DEFAULT_MAX_AUTO_RETRIES)) {
          run.aborting = true;
          this.sendCommand('abort', {}).catch(() => undefined);
          this.sendCommand('abort_retry', {}).catch(() => undefined);
          this.finishActiveRun({
            outcome: 'failed',
            error: {
              code: 'model_request_failed',
              message: `模型请求自动重试超过上限（${this.options.maxAutoRetries ?? DEFAULT_MAX_AUTO_RETRIES} 次）`,
            },
          });
        }
      }
      return;
    }
    if (event.type === 'agent_settled') {
      if (run && !run.finished) {
        const aborted = event.aborted === true || run.aborting;
        if (aborted) {
          this.finishActiveRun({ outcome: 'aborted' });
          return;
        }
        if (run.lastStopReason === 'error') {
          this.finishActiveRun({
            outcome: 'failed',
            error: { code: 'model_request_failed', message: (run.lastErrorText ?? '模型返回 error').slice(0, 500) },
          });
          return;
        }
        if (run.lastStopReason === 'aborted') {
          this.finishActiveRun({ outcome: 'aborted' });
          return;
        }
        this.finishActiveRun({ outcome: 'completed' });
      }
      return;
    }
    if (event.type === 'extension_error') {
      this.emit('extension_error', event);
      return;
    }
  }

  private writeLine(line: string): void {
    const child = this.child;
    if (!child || this.exited || !child.stdin || child.stdin.destroyed) {
      throw new PiRpcError('pi_process_exited', 'pi 进程已退出，无法发送命令');
    }
    child.stdin.write(`${line}\n`);
  }

  /** 发送白名单命令并等待 response。 */
  async sendCommand<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    if (!RPC_COMMAND_WHITELIST.has(type)) {
      throw new PiRpcError(
        'rpc_command_forbidden',
        `RPC 命令不在白名单内: ${type}（高危命令已被宿主拒绝）`,
      );
    }
    if (RPC_COMMAND_BLACKLIST.has(type)) {
      throw new PiRpcError('rpc_command_forbidden', `RPC 命令被禁止: ${type}`);
    }
    if (this.exited) {
      throw new PiRpcError('pi_process_exited', 'pi 进程已退出');
    }
    const id = `cmd_${this.nextSeq}`;
    this.nextSeq += 1;
    const record = { id, type, ...payload };
    return new Promise<{ success: boolean; data?: T; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError('rpc_timeout', `RPC 命令超时: ${type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as { success: boolean; data?: T; error?: string }),
        reject,
        timer,
      });
      try {
        this.writeLine(JSON.stringify(record));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  /**
   * 发送 prompt 并等待运行完成（§4.4 完成判定）。
   * streamingBehavior 由调用方按运行态决定（运行中需 steer/followUp）。
   */
  async prompt(message: string, options: { streamingBehavior?: 'steer' | 'followUp'; timeoutMs?: number } = {}): Promise<RunOutcome> {
    if (this.activeRun && !this.activeRun.finished) {
      throw new PiRpcError('run_in_progress', '已有运行未完成');
    }
    const runId = `run_${crypto.randomBytes(6).toString('hex')}`;
    const payload: Record<string, unknown> = { message };
    if (options.streamingBehavior) payload.streamingBehavior = options.streamingBehavior;

    const outcomePromise = new Promise<RunOutcome>((resolve) => {
      this.activeRun = {
        runId,
        resolve,
        autoRetryCount: 0,
        lastStopReason: null,
        lastAssistantText: null,
        lastErrorText: null,
        settled: false,
        aborting: false,
        finished: false,
      };
    });
    // 命令本身的 response（success:false）走 handleResponseForRun 立即结束运行。
    const timeoutMs = options.timeoutMs ?? this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    const run = this.activeRun!;
    run.timeoutTimer = setTimeout(() => {
      if (run.finished) return;
      run.aborting = true;
      this.sendCommand('abort', {}).catch(() => undefined);
      this.finishActiveRun({
        outcome: 'failed',
        error: { code: 'model_timeout', message: `模型响应超时（${Math.round(timeoutMs / 1000)}s）` },
      });
    }, timeoutMs);
    run.timeoutTimer.unref?.();

    const response = await this.sendCommand('prompt', payload, 30_000);
    if (!response.success) {
      // handleResponseForRun 已处理（或兜底）
      if (this.activeRun === run && !run.finished) {
        this.finishActiveRun({
          outcome: 'failed',
          error: { code: classifyPromptError(response.error ?? ''), message: (response.error ?? 'prompt 被拒绝').slice(0, 500) },
        });
      }
    }
    const outcome = await outcomePromise;
    return outcome;
  }

  /** 请求中止当前运行（幂等）。 */
  async abort(): Promise<void> {
    const run = this.activeRun;
    if (run && !run.finished) {
      run.aborting = true;
    }
    try {
      await this.sendCommand('abort', {}, 15_000);
    } catch {
      // 进程可能已退出；退出事件会终结运行
    }
    if (run && !run.finished) {
      // abort 命令返回后给 agent_settled 一个窗口；进程退出兜底
      setTimeout(() => {
        if (!run.finished) {
          this.finishActiveRun({ outcome: 'aborted' });
        }
      }, 2000).unref?.();
    }
  }

  private finishActiveRun(partial: Omit<RunOutcome, 'lastAssistantText'> & { lastAssistantText?: string }): void {
    const run = this.activeRun;
    if (!run || run.finished) return;
    run.finished = true;
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    const outcome: RunOutcome = {
      outcome: partial.outcome,
      ...(partial.error ? { error: partial.error } : {}),
      lastAssistantText: partial.lastAssistantText ?? run.lastAssistantText ?? undefined,
    };
    this.activeRun = null;
    run.resolve(outcome);
    this.emit('run_finished', outcome);
  }

  private failPending(error: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  isExited(): boolean {
    return this.exited;
  }

  /** 与 finishActiveRun 同步更新；存活的 idle 进程不能接受旧 run 的投递。 */
  hasActiveRun(): boolean {
    return this.activeRun !== null && !this.activeRun.finished;
  }

  getExitInfo(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo;
  }

  /**
   * 终止进程：stdin.end() 请求有序退出，宽限后 SIGKILL。
   * Windows 用 taskkill /T /F（§4.5）。
   */
  async terminate(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const exitedPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(resolve, graceMs).unref?.();
    });
    try {
      child.stdin?.end();
    } catch {
      /* stdin may already be closed */
    }
    await exitedPromise;
    if (!this.exited && child.pid) {
      try {
        if (process.platform === 'win32') {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined);
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }
  }

  /** 探测辅助：get_state + get_available_models。 */
  async probeState(): Promise<{
    state: Record<string, unknown> | null;
    models: string[];
    capabilities: Record<string, AgentThinkingLevel[]>;
  }> {
    const stateResponse = await this.sendCommand('get_state', {});
    const modelsResponse = await this.sendCommand('get_available_models', {});
    const models: string[] = [];
    const capabilities: Record<string, AgentThinkingLevel[]> = {};
    if (modelsResponse.success && modelsResponse.data) {
      const data = modelsResponse.data as { models?: Array<{ provider?: string; id?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }> };
      for (const model of data.models ?? []) {
        if (model.provider && model.id) {
          const id = `${model.provider}/${model.id}`;
          models.push(id);
          if (typeof model.reasoning === 'boolean') capabilities[id] = piThinkingLevels(model);
        }
      }
    }
    return {
      state: stateResponse.success ? (stateResponse.data as Record<string, unknown>) : null,
      models,
      capabilities,
    };
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: string }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function classifyPromptError(errorText: string): string {
  if (/no api key/i.test(errorText)) return 'model_auth_missing';
  if (/not found/i.test(errorText) && /model/i.test(errorText)) return 'model_unconfigured';
  return 'model_request_failed';
}

/** 计算子进程环境（§4.2）：app-llm 白名单继承；pi-agent-dir 继承并剔除敏感变量。 */
export function buildPiProcessEnv(input: {
  mode: 'app-llm' | 'pi-agent-dir';
  parentEnv: NodeJS.ProcessEnv;
  dataRoot: string;
  agentUrl: string;
  runToken: string;
  apiKey?: string;
}): NodeJS.ProcessEnv {
  const dangerous = new Set([
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_PRELOAD',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
  ]);
  const feishuSensitive = /^FEISHU_SYNC_AGENT_/;
  let env: NodeJS.ProcessEnv;
  if (input.mode === 'app-llm') {
    const whitelist = new Set([
      'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'SystemDrive',
      'PATHEXT', 'ComSpec', 'USER', 'LOGNAME', 'SHELL', 'TZ',
    ]);
    env = {};
    for (const key of Object.keys(input.parentEnv)) {
      if (whitelist.has(key) && !dangerous.has(key)) {
        env[key] = input.parentEnv[key];
      }
    }
    env.PI_CODING_AGENT_DIR = path.join(input.dataRoot, 'agent', 'pi-home');
    try {
      fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
    } catch {
      /* mkdir 失败留给 pi 报错 */
    }
  } else {
    env = {};
    for (const key of Object.keys(input.parentEnv)) {
      if (dangerous.has(key) || feishuSensitive.test(key)) continue;
      env[key] = input.parentEnv[key];
    }
  }
  // 包/设置始终限定在应用Pi home；本机凭据只由桥接扩展经Pi只读存储使用。
  if (input.mode === 'pi-agent-dir') {
    env.FEISHU_SYNC_AGENT_SHARED_PI_HOME = path.resolve(input.parentEnv.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'));
  }
  env.PI_CODING_AGENT_DIR = path.join(input.dataRoot, 'agent', 'pi-home');
  fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  env.FEISHU_SYNC_AGENT_URL = input.agentUrl;
  env.FEISHU_SYNC_AGENT_RUN_TOKEN = input.runToken;
  if (input.mode === 'app-llm' && input.apiKey) {
    env.FEISHU_SYNC_AGENT_API_KEY = input.apiKey;
  }
  return env;
}
