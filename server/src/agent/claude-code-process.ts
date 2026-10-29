/** Claude Code adapter for the application's bounded Agent process contract. */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PiRpcProcess, type RunOutcome } from './pi-rpc-process.js';
import { inspectClaudeCode } from './claude-runtime.js';

export interface ClaudeCodeOptions {
  executable: string;
  /** Test-only prefix for an injected executable. */
  executableArgs?: string[];
  nodePath: string;
  bridgePath: string;
  cwd: string;
  sessionDir: string;
  sessionId: string;
  tools: string[];
  model: string;
  baseUrl: string;
  apiKey: string;
  authType?: 'api-key' | 'auth-token';
  thinking?: import('../types/agent-knowledge.js').AgentThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
  agentUrl: string;
  runToken: string;
  parentEnv: NodeJS.ProcessEnv;
  pluginSnapshot?: { path: string; revision: string };
  promptTimeoutMs?: number;
  ephemeral?: boolean;
}

export function buildClaudeEnvironment(opts: ClaudeCodeOptions): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'SystemDrive', 'PATHEXT', 'ComSpec', 'USER', 'LOGNAME', 'SHELL', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']);
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(opts.parentEnv)) if (allowed.has(key)) env[key] = opts.parentEnv[key];
  if (opts.authType === 'auth-token') env.ANTHROPIC_AUTH_TOKEN = opts.apiKey;
  else env.ANTHROPIC_API_KEY = opts.apiKey;
  env.ANTHROPIC_BASE_URL = opts.baseUrl;
  // Native background requests also use the selected app preset. Do not let
  // Claude's built-in aliases route auxiliary work to an unconfigured model.
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) env[name] = opts.model;
  env.FEISHU_SYNC_AGENT_URL = opts.agentUrl;
  env.FEISHU_SYNC_AGENT_RUN_TOKEN = opts.runToken;
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (!opts.thinking || opts.thinking === 'off') env.CLAUDE_CODE_DISABLE_THINKING = '1';
  else env.CLAUDE_CODE_EFFORT_LEVEL = opts.thinking;
  if (opts.contextWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(opts.contextWindow);
  if (opts.maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(opts.maxTokens);
  return env;
}

function snapshotText(snapshot?: ClaudeCodeOptions['pluginSnapshot']): string {
  if (!snapshot) return '';
  const raw = fs.readFileSync(snapshot.path, 'utf8');
  if (crypto.createHash('sha256').update(raw).digest('hex') !== snapshot.revision) throw new Error('应用上下文快照已变化');
  const parsed = JSON.parse(raw) as { schemaVersion?: number; plugins?: Array<{ name?: string; enabled?: boolean; content?: string }> };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) throw new Error('应用上下文快照无效');
  return parsed.plugins.filter((p) => p.enabled && typeof p.content === 'string' && p.content.trim())
    .map((p) => `## ${p.name ?? '上下文'}\n\n${p.content}`).join('\n\n');
}

/** Claude Code can write retry errors only to its private session JSONL. */
export function claudeFatalApiError(record: unknown, secrets: string[]): string | null {
  if (!record || typeof record !== 'object') return null;
  const entry = record as { type?: string; subtype?: string; error?: { status?: unknown; formatted?: unknown; message?: unknown } };
  if (entry.type !== 'system' || entry.subtype !== 'api_error') return null;
  const status = Number(entry.error?.status);
  if (![400, 401, 403, 404].includes(status)) return null;
  let detail = String(entry.error?.formatted ?? entry.error?.message ?? `HTTP ${status}`);
  for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, '[redacted]');
  detail = detail.slice(0, 350);
  return status === 401 || status === 403
    ? `模型服务认证失败（${status}）：${detail}。请检查提供商 API Key、接口地址和访问权限。`
    : `模型服务请求失败（${status}）：${detail}`;
}

/** Implements the process surface consumed by SessionService, tasks and builds. */
export class ClaudeCodeProcess extends PiRpcProcess {
  private readonly settings: ClaudeCodeOptions;
  private readonly historyPath: string;
  private readonly sessionMarker: string;
  private readonly claudeId: string;
  private configDir: string | null = null;
  private childProcess: ChildProcess | null = null;
  private closed = false;
  private running = false;
  private aborted = false;
  private contextText = '';
  private historyParent: string | null = null;
  private readonly temporaryId: string;
  private readonly ephemeralDir: string | null;
  private readonly claudeHome: string;

  constructor(options: ClaudeCodeOptions) {
    super({ nodePath: options.nodePath, piCliPath: '', tools: [], cwd: options.cwd, env: {} });
    this.settings = options;
    const key = crypto.createHash('sha256').update(options.sessionId).digest('hex');
    this.temporaryId = key.slice(0, 32);
    this.claudeId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
    if (options.ephemeral) {
      const parent = path.join(options.sessionDir, 'claude-ephemeral');
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      this.ephemeralDir = fs.mkdtempSync(path.join(parent, 'run-'));
      this.claudeHome = path.join(this.ephemeralDir, 'home');
      this.historyPath = path.join(this.ephemeralDir, 'history.jsonl');
      this.sessionMarker = path.join(this.ephemeralDir, 'session');
    } else {
      this.ephemeralDir = null;
      this.claudeHome = path.join(options.sessionDir, 'claude', `${key}.home`);
      this.historyPath = path.join(options.sessionDir, 'claude', `${key}.jsonl`);
      this.sessionMarker = path.join(options.sessionDir, 'claude', `${key}.session`);
    }
  }

  override async start(): Promise<void> {
    if (this.closed) throw new Error('Claude Code 进程已关闭');
    if (!fs.existsSync(this.settings.executable) || !fs.existsSync(this.settings.nodePath) || !fs.existsSync(this.settings.bridgePath)) throw new Error('Claude Code 或工具桥不可用');
    if (!(await inspectClaudeCode(this.settings.executable)).supported) throw new Error('Claude Code 缺少安全运行所需参数，请更新 Claude Code');
    this.contextText = snapshotText(this.settings.pluginSnapshot);
    fs.mkdirSync(this.settings.cwd, { recursive: true });
    fs.mkdirSync(path.dirname(this.historyPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.historyPath)) {
      const lines = fs.readFileSync(this.historyPath, 'utf8').split('\n');
      for (const line of lines) { try { const item = JSON.parse(line); if (item.id && item.type !== 'session') this.historyParent = String(item.id); } catch { /* skip trailing invalid line */ } }
    }
    this.configDir = fs.mkdtempSync(path.join(path.dirname(this.historyPath), `.claude-${this.temporaryId}-`));
    const mcp = { mcpServers: { feishu_sync: { command: this.settings.nodePath, args: [this.settings.bridgePath] } } };
    fs.writeFileSync(path.join(this.configDir, 'mcp.json'), JSON.stringify(mcp), { mode: 0o600 });
    if (this.contextText) fs.writeFileSync(path.join(this.configDir, 'context.txt'), this.contextText, { mode: 0o600 });
  }

  private appendMessage(message: Record<string, unknown>): void {
    const id = crypto.randomBytes(12).toString('hex');
    const entry = { type: 'message', id, parentId: this.historyParent, timestamp: new Date().toISOString(), message };
    fs.appendFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.historyParent = id;
  }

  recordToolResult(event: { toolCallId?: string; toolName: string; resultSummary?: string; isError?: boolean }): void {
    this.appendMessage({ role: 'toolResult', toolCallId: event.toolCallId ?? '', toolName: event.toolName,
      isError: event.isError === true, content: [{ type: 'text', text: event.resultSummary ?? '' }] });
  }

  override async prompt(message: string, options: { streamingBehavior?: 'steer' | 'followUp'; timeoutMs?: number } = {}): Promise<RunOutcome> {
    if (this.closed || !this.configDir) throw new Error('Claude Code 未启动');
    if (this.running) throw new Error('已有运行未完成');
    this.running = true; this.aborted = false;
    const args = [
      ...(this.settings.executableArgs ?? []), '-p', '--bare', '--tools', '', '--strict-mcp-config',
      '--mcp-config', path.join(this.configDir, 'mcp.json'), '--permission-mode', 'dontAsk',
      '--allowedTools', this.settings.tools.map((name) => `mcp__feishu_sync__${name}`).join(','),
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--model', this.settings.model,
      '--system-prompt-snapshot', 'off',
      ...(this.contextText ? ['--append-system-prompt-file', path.join(this.configDir, 'context.txt')] : []),
      ...(fs.existsSync(this.sessionMarker) ? ['--resume', this.claudeId] : ['--session-id', this.claudeId]),
    ];
    const env = buildClaudeEnvironment(this.settings);
    env.CLAUDE_CONFIG_DIR = this.claudeHome;
    let diagnosticPath: string | null = null;
    let diagnosticOffset = 0;
    const projectsDir = path.join(this.claudeHome, 'projects');
    try {
      if (fs.existsSync(projectsDir)) for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const candidate = path.join(projectsDir, dir.name, `${this.claudeId}.jsonl`);
        if (fs.existsSync(candidate)) { diagnosticPath = candidate; diagnosticOffset = fs.statSync(candidate).size; break; }
      }
    } catch { /* The session may not have a diagnostic file yet. */ }
    let child: ChildProcess;
    try {
      this.appendMessage({ role: 'user', content: message });
      child = spawn(this.settings.executable, args, { cwd: this.settings.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.childProcess = child;
    } catch (error) { this.running = false; throw error; }
    let buffer = '', stderr = '', result: Record<string, unknown> | null = null;
    let lastText = '', initialized = false, streamError: Error | null = null, timedOut = false;
    let fatalApiError: string | null = null;
    let diagnosticBuffer = '';
    const inspectDiagnostics = () => {
      try {
        if (!diagnosticPath && fs.existsSync(projectsDir)) {
          for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
            if (!dir.isDirectory()) continue;
            const candidate = path.join(projectsDir, dir.name, `${this.claudeId}.jsonl`);
            if (fs.existsSync(candidate)) { diagnosticPath = candidate; break; }
          }
        }
        if (!diagnosticPath || fatalApiError || this.aborted) return;
        const size = fs.statSync(diagnosticPath).size;
        if (size < diagnosticOffset) { diagnosticOffset = 0; diagnosticBuffer = ''; }
        if (size === diagnosticOffset) return;
        const fd = fs.openSync(diagnosticPath, 'r');
        try {
          const chunk = Buffer.alloc(Math.min(size - diagnosticOffset, 256 * 1024));
          diagnosticOffset += fs.readSync(fd, chunk, 0, chunk.length, diagnosticOffset);
          diagnosticBuffer += chunk.toString('utf8');
        } finally { fs.closeSync(fd); }
        const lines = diagnosticBuffer.split('\n'); diagnosticBuffer = lines.pop() ?? '';
        for (const line of lines) {
          try { fatalApiError = claudeFatalApiError(JSON.parse(line), [this.settings.apiKey, this.settings.runToken]); } catch { /* ignore non-JSON records */ }
          if (fatalApiError) { void this.abort(); break; }
        }
      } catch { /* Missing/incomplete diagnostic files do not fail the run. */ }
    };
    const diagnosticTimer = setInterval(inspectDiagnostics, 1000);
    diagnosticTimer.unref?.();
    const consume = (line: string) => {
      let record: any;
      try { record = JSON.parse(line); } catch { return; }
      try {
      if (record.type === 'system' && record.subtype === 'init' && record.session_id === this.claudeId) {
        initialized = true;
        fs.writeFileSync(this.sessionMarker, this.claudeId, { mode: 0o600 });
      }
      if (record.type === 'stream_event' && record.event?.type === 'content_block_delta' && record.event.delta?.type === 'text_delta') {
        this.emit('text_delta', String(record.event.delta.text ?? ''));
      }
      if (record.type === 'assistant' && record.message && !record.parent_tool_use_id) {
        const original = Array.isArray(record.message.content) ? record.message.content : [];
        const content = original.map((block: any) => block?.type === 'tool_use'
          ? { type: 'toolCall', id: block.id, name: String(block.name ?? '').replace(/^mcp__feishu_sync__/, ''), arguments: block.input }
          : block);
        const assistant = { role: 'assistant', content, model: record.message.model, stopReason: record.message.stop_reason };
        lastText = content.filter((block: any) => block?.type === 'text').map((block: any) => block.text ?? '').join('') || lastText;
        this.appendMessage(assistant);
        this.emit('assistant_message_end', assistant);
      }
      if (record.type === 'result') result = record;
      } catch (error) {
        streamError = error instanceof Error ? error : new Error(String(error));
        void this.abort();
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 20 * 1024 * 1024) { child.kill(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) consume(line); }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(message);
    const timeout = setTimeout(() => { timedOut = true; void this.abort(); }, options.timeoutMs ?? this.settings.promptTimeoutMs ?? 900_000);
    timeout.unref?.();
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('close', (code) => resolve({ code }));
    });
    clearTimeout(timeout); clearInterval(diagnosticTimer); this.childProcess = null; this.running = false;
    if (buffer.trim()) consume(buffer);
    const output = result as Record<string, unknown> | null;
    let outcome: RunOutcome;
    if (timedOut) outcome = { outcome: 'failed', error: { code: 'model_timeout', message: 'Claude Code 响应超时' } };
    else if (streamError) outcome = { outcome: 'failed', error: { code: 'agent_error', message: 'Claude Code 会话记录写入失败' } };
    else if (fatalApiError) outcome = { outcome: 'failed', error: { code: 'model_request_failed', message: fatalApiError } };
    else if (this.aborted) outcome = { outcome: 'aborted' };
    else if (exit.error || exit.code !== 0 || !output || output.is_error === true || !initialized) {
      const messageText = String(output?.result ?? exit.error?.message ?? stderr ?? 'Claude Code 未返回完整结果')
        .replaceAll(this.settings.apiKey, '[redacted]').replaceAll(this.settings.runToken, '[redacted]').slice(0, 500);
      outcome = { outcome: 'failed', error: { code: 'model_request_failed', message: messageText || 'Claude Code 未返回完整结果' } };
    } else outcome = { outcome: 'completed', lastAssistantText: lastText || (typeof output.result === 'string' ? output.result : undefined) };
    this.emit('run_finished', outcome);
    return outcome;
  }

  override async sendCommand<T = unknown>(type: string): Promise<{ success: boolean; data?: T; error?: string }> {
    if (type === 'get_state') return { success: true, data: { sessionFile: this.historyPath } as T };
    if (type === 'set_auto_retry') return { success: true };
    if (type === 'steer' || type === 'follow_up') return { success: false, error: 'Claude Code 暂不支持运行中插话或排队，请等待本轮完成' };
    if (type === 'abort') { await this.abort(); return { success: true }; }
    return { success: false, error: `Claude Code 不支持命令 ${type}` };
  }
  override hasActiveRun(): boolean { return this.running; }
  override isExited(): boolean { return this.closed; }
  override async abort(): Promise<void> {
    this.aborted = true;
    const child = this.childProcess;
    if (!child?.pid) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { child.off('close', onClose); resolve(false); }, 3000);
      const onClose = () => { clearTimeout(timeout); resolve(true); };
      child.once('close', onClose);
    });
    if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => child.kill());
    else child.kill('SIGTERM');
    if (!(await closed)) child.kill('SIGKILL');
  }
  override async terminate(): Promise<void> {
    if (this.closed) return;
    await this.abort(); this.closed = true;
    try {
      if (this.configDir) fs.rmSync(this.configDir, { recursive: true, force: true });
      if (this.ephemeralDir) fs.rmSync(this.ephemeralDir, { recursive: true, force: true });
    } finally { this.emit('exit'); }
  }
}
