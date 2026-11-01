#!/usr/bin/env node
/**
 * probe-build-runtime.ts — 设计v2 §13.1/§13.2 独立可重跑「真实运行能力」probe
 *
 * 目标：用真实 pi + 真实 amagi（经 installAmagiPackage source 模式版本化物化）
 * + 真实子任务 MCP 桥 + 主树真实 AgentToolService/BuildActorStore，端到端验证
 * 13.1 的运行能力项。唯一被替换的环节是「模型」：默认用本地 OpenAI 兼容
 * fixture 模型驱动脚本化动作——fixture 模型不是实际 LLM 质量/性能证据；
 * --real-model 为显式可选模式（真实端点 + 密钥仅经环境变量，不打印）。
 *
 * 不改生产基建：本脚本只消费主树模块（build-runtime / build-actors /
 * agent-tool-service / claude-bridge / pi-extension），不新增调度器——
 * 子任务全部由真实 Leader 内的 amagi task_submit 派发。
 *
 * 隔离：FEISHU_SYNC_HOME / 子进程 HOME / PI_CODING_AGENT_DIR 全部临时；
 * 来源为自建短夹具；不读取生产资料。退出码：0=全部通过；2=有失败项；
 * 3=外部资源不可用（如实 unavailable，不假通过）。
 *
 * 用法：
 *   npx tsx scripts/probe-build-runtime.ts --piCli <pi 绝对路径> --sourceAmagi <amagi-pi 包根>
 *   可选：--report <md 路径> --real-model --keep --timeoutSec <秒>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installAmagiPackage, inspectAmagiPackageLayout, verifyAmagiPackage } from '/tmp/feishu-build-v2-feature-tree/server/src/agent/build-runtime/amagi-package.js';
import {
  planBuildDirectories, renderAgentDirConfigFiles, computeAgentDirConfigHash,
} from '/tmp/feishu-build-v2-feature-tree/server/src/agent/build-runtime/agent-dir-config.js';
import {
  AMAGI_TASK_TOOLS, DEFAULT_ROLE_AGENTS, DEFAULT_AUTO_ROUNDS,
  type BuildRunSpec, type BuildModelDescriptor, type RuntimeBinding,
} from '/tmp/feishu-build-v2-feature-tree/server/src/agent/build-runtime/contracts.js';
import { PiAmagiBuildRuntime, type PiAmagiRuntimeDeps } from '/tmp/feishu-build-v2-feature-tree/server/src/agent/build-runtime/adapter.js';
import { V2_LEADER_TOOLS } from '/tmp/feishu-build-v2-feature-tree/server/src/agent/tool-specs.js';
import { V2_WRITER_TOOLS, V2_REVIEWER_TOOLS, V2_RESEARCH_TOOLS } from '/tmp/feishu-build-v2-feature-tree/server/src/kb/build-actors.js';
import { FixtureModelServer, type ParsedHistory } from '/tmp/feishu-build-v2-feature-tree/server/tests/fixtures/build-runtime/fixture-model-server.js';
import { buildProbeAppStack, type ProbeAppStack } from '/tmp/feishu-build-v2-feature-tree/server/tests/fixtures/build-runtime/app-stack.js';
import {
  CheckCollector, createProbeTempEnv, writeSourceFixtures, writeSkillFixture, sha256Text,
  renderProbeReport, snapshotProcesses, probeRelatedProcesses, redact,
  type ProbeCheck,
} from '/tmp/feishu-build-v2-feature-tree/server/tests/fixtures/build-runtime/probe-support.js';

const SERVER_ROOT = '/tmp/feishu-build-v2-feature-tree/server';
const REPORT_DEFAULT = path.resolve(SERVER_ROOT, '../agent-outputs/workflow/build-runtime-v2/live-probe-report.md');
const BRIDGE_SERVER = 'feishu-kb-bridge';
const SKILL_MARKER = 'PROBE-SKILL-KB-BUILD-7F3A';
const DOC_W1 = 'systems/demo-guide.md';
const DOC_W2 = 'systems/other-doc.md';
const SENTINEL_SECRET = 'SENTINEL-SECRET-e19d0f4a';

interface CliArgs {
  piCli: string;
  sourceAmagi: string;
  report: string;
  realModel: boolean;
  keep: boolean;
  timeoutSec: number;
}

function parseArgs(argv: string[]): CliArgs & { error?: string } {
  const out: Partial<CliArgs> = { report: REPORT_DEFAULT, realModel: false, keep: false, timeoutSec: 600 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--piCli' && next) { out.piCli = next; i += 1; }
    else if (arg === '--sourceAmagi' && next) { out.sourceAmagi = next; i += 1; }
    else if (arg === '--report' && next) { out.report = next; i += 1; }
    else if (arg === '--real-model') { out.realModel = true; }
    else if (arg === '--keep') { out.keep = true; }
    else if (arg === '--timeoutSec' && next) { out.timeoutSec = Number.parseInt(next, 10) || 600; i += 1; }
    else return { ...(out as CliArgs), error: `未知参数: ${arg}` };
  }
  if (!out.piCli) out.piCli = process.env.PI_PROBE_PI_CLI ?? '';
  if (!out.sourceAmagi) out.sourceAmagi = process.env.PI_PROBE_SOURCE_AMAGI ?? '';
  if (!out.piCli || !out.sourceAmagi) {
    return { ...(out as CliArgs), error: '缺少 --piCli / --sourceAmagi（probe 不写死个人开发仓路径）' };
  }
  return out as CliArgs;
}

function readPiVersion(piCli: string): string {
  // PATH 里的 pi 常是多层符号链接（fnm 等）：realpath 后向上找 pi-coding-agent 包根
  let current: string | null = path.dirname(fs.realpathSync(piCli));
  for (let depth = 0; depth < 8 && current; depth += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf-8')) as { name?: string; version?: string };
      if (pkg.name?.includes('pi-coding-agent')) return typeof pkg.version === 'string' ? pkg.version : '';
    } catch { /* 继续向上 */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

// ── probe 运行期状态 ─────────────────────────────────────────────────────

interface GuardedSubmitStart { toolCallId?: string; tool: string; taskMarker: string | null; args: Record<string, unknown> }

class ProbeRun {
  readonly checks = new CheckCollector();
  readonly notes: string[] = [];
  readonly log: string[] = [];
  readonly leaderEvents: Array<Record<string, unknown>> = [];
  readonly guardedSubmits: GuardedSubmitStart[] = [];
  readonly submitResults: Array<{ toolCallId?: string; tool: string; text: string }> = [];
  selfRoundEvents: string[] = [];
  selfRounds = 0;

  say(line: string): void {
    this.log.push(`${new Date().toISOString()} ${line}`);
    process.stderr.write(`[probe] ${redact(line)}\n`);
  }

  recordEvent(record: Record<string, unknown>): void {
    this.leaderEvents.push(record);
    if (record.type === 'tool_execution_start' && (record.toolName === 'task_submit' || record.toolName === 'task_resume')) {
      const args = (record.args ?? {}) as Record<string, unknown>;
      const taskText = typeof args.task === 'string' ? args.task : typeof args.message === 'string' ? args.message : '';
      const marker = /PROBE-(?:TASK|RESUME)-(?:W1|W2|R1|SLOW)/.exec(taskText)?.[0] ?? null;
      this.guardedSubmits.push({
        toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : undefined,
        tool: String(record.toolName),
        taskMarker: marker,
        args,
      });
    }
    if (record.type === 'tool_execution_end' && (record.toolName === 'task_submit' || record.toolName === 'task_resume')) {
      const result = record.result as { content?: Array<{ text?: string }> } | undefined;
      const text = (result?.content ?? []).map((block) => block.text ?? '').join('\n');
      this.submitResults.push({
        toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : undefined,
        tool: String(record.toolName),
        text,
      });
    }
  }

  /** 从 tool_execution_start/end 配对解析创建事件（taskId ← 「句柄: <id>」；marker ← 任务书）。 */
  pairedCreations(): Array<{ tool: 'task_submit' | 'task_resume'; agent: string; taskIds: string[]; parentTaskId: string | null; marker: string | null }> {
    const out: Array<{ tool: 'task_submit' | 'task_resume'; agent: string; taskIds: string[]; parentTaskId: string | null; marker: string | null }> = [];
    for (const end of this.submitResults) {
      const start = this.guardedSubmits.find((candidate) => candidate.toolCallId && candidate.toolCallId === end.toolCallId);
      if (!start) continue;
      const taskIds = [...end.text.matchAll(/句柄: ([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
      if (taskIds.length === 0) continue; // 被守卫阻断（无句柄）
      const parentMatch = /父会话 ([A-Za-z0-9_-]+)/.exec(end.text);
      out.push({
        tool: start.tool as 'task_submit' | 'task_resume',
        agent: typeof start.args.agent === 'string' ? start.args.agent : '',
        taskIds,
        parentTaskId: parentMatch ? parentMatch[1] : null,
        marker: start.taskMarker,
      });
    }
    return out;
  }
}

// ── fixture 脚本配置 ─────────────────────────────────────────────────────

interface ProbeScriptConfig {
  sentinelFile: string;
  sentinelDir: string;
}

function hostileScope(): Record<string, unknown> {
  // 敌意但 schema 合法（Pi 在 tool_call 前先校验：不合法入参到不了守卫，
  // 也无法证明守卫改参能力）——用「合法但越权」请求面实测守卫冻结。
  return {
    read: ['**'],
    write: ['**', '/tmp/escape/**'],
    deny: ['unrelated/notes.md'],
    shell: 'guarded',
    mcp: ['*'],
    lsp: ['diagnostics'],
    advisor: 'consult',
  };
}

function submitArgs(agent: string, task: string, model: string): Record<string, unknown> {
  return {
    agent,
    task,
    delivery: 'handle',
    model,
    scope: hostileScope(),
    workspace: { cwd: '../escape', mode: 'worktree', worktreeName: 'probe-escape', base: 'head', dependencyVisibility: 'portable' },
    profile: 'fast',
    outputs: [{ path: 'agent-outputs/report.md' }, { path: '/tmp/escape.md' }],
  };
}

function buildFixtureModelConfig(cfg: ProbeScriptConfig): FixtureServerBundle {
  const mcp = (tool: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } => ({
    name: 'mcp_call',
    args: { server: BRIDGE_SERVER, tool, arguments: args },
  });
  const w1Markdown = ['# 演示指南', '', '入口规则来自 Alpha 指南：', '', '- 入口在北方，与 Beta 出口相接。', '- 每轮刷新两个补给点。', ''].join('\n');
  const w1MarkdownV2 = ['# 演示指南', '', '修订：夜间规则并入——', '', '- 入口在北方，与 Beta 出口相接（夜间 Beta 关闭时不可达）。', '- 每轮刷新两个补给点。', ''].join('\n');

  const scripts: Record<string, Array<{ toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; text?: string; delayMs?: number }>> = {
    w1: [
      { toolCalls: [{ name: 'read', args: { path: cfg.sentinelFile } }] },
      { toolCalls: [{ name: 'grep', args: { pattern: SENTINEL_SECRET, path: path.dirname(path.dirname(cfg.sentinelDir)) } }] },
      { toolCalls: [mcp('raw_list', { filter: 'all' })], delayMs: 2500 },
      { toolCalls: [mcp('kb_submit_review', { unitId: 'probe-w1', report: '越权审查尝试' })] },
      { toolCalls: [mcp('kb_write_doc', { path: DOC_W1, title: '演示指南', markdown: w1Markdown, summary: 'Alpha 规则演示文档', sources: ['tok_probe_w1'], operationId: 'w1-op-1' })], delayMs: 1500 },
      { toolCalls: [{ name: 'write', args: { path: 'amagi.json', content: '{"probe": "config-face-write-尝试"}' } }] },
      { toolCalls: [{ name: 'write', args: { path: 'agent-outputs/w1-report.md', content: '# W1 报告\n\n读取经桥接完成；越权与禁区写入均被拒。\n' } }] },
      // codemode 面试探（实测设计 §3.3：autoEnableCodemode:false 下桥接是否仍可经 codemode 触达）
      { toolCalls: [{ name: 'codemode', args: { code: "const found = await searchTools('mcp__feishu-kb-bridge', { limit: 10 }); return { names: (found || []).map((t) => (t && t.name) || String(t)) };" } }] },
    ],
    w2: [
      { toolCalls: [mcp('raw_read', { objToken: 'tok_probe_w2' })], delayMs: 2500 },
      { toolCalls: [mcp('kb_write_doc', { path: DOC_W2, title: '未分配文档', markdown: '# 未分配\n\n该文档未分配给本任务。\n', summary: '未分配写入尝试', sources: ['tok_probe_w2'], operationId: 'w2-op-1' })] },
    ],
    r1: [
      { toolCalls: [mcp('draft_list', {})], delayMs: 2500 },
      { toolCalls: [mcp('kb_write_doc', { path: DOC_W1, title: '审查者越权', markdown: '# 越权\n', summary: '审查者写入尝试', sources: ['tok_probe_w1'], operationId: 'r1-op-1' })] },
      { toolCalls: [mcp('build_handoff_submit', { operationId: 'r1-handoff-1', summary: '独立审查完成：结构可读，无阻断问题。', artifactRefs: [`${DOC_W1}@2`], sourceScope: ['tok_probe_w1'], openIssues: [], nextInfo: [] })] },
    ],
    slow: [
      { toolCalls: [mcp('raw_list', { filter: 'all' })], delayMs: 25_000 },
    ],
    'resume-w1': [
      { toolCalls: [mcp('kb_write_doc', { path: DOC_W1, title: '演示指南', markdown: w1MarkdownV2, summary: '续接修订写入', sources: ['tok_probe_w1'], operationId: 'w1-op-2' })], delayMs: 2500 },
    ],
  };
  const finals: Record<string, string> = {
    w1: 'W1 完成：禁区读取被拒、桥接读写按授权执行。',
    w2: 'W2 完成：只读成功、未分配写入被拒。',
    r1: 'R1 审查完成：交接已提交。',
    slow: 'SLOW 完成。',
    'resume-w1': 'PROBE-RESUME-W1 续接写入完成（分配继承，修订已落盘）。',
  };

  const handlesFrom = (history: ParsedHistory): string[] =>
    [...history.toolResultTexts.join('\n').matchAll(/句柄: ([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
  const completed = (history: ParsedHistory, marker: string): boolean =>
    new RegExp(`完成[\\s\\S]{0,600}${marker}`).test(history.allText);
  const assistantText = (history: ParsedHistory): string => history.assistantTexts.join('\n');

  const leaderSteps = [
    (): { toolCalls: Array<{ name: string; args: Record<string, unknown> }> } => ({
      toolCalls: [
        { name: 'task_submit', args: submitArgs('luban', `PROBE-TASK-W1 写作任务\n按任务书完成：禁区读取试探、桥接读取、分配内写入（operationId=w1-op-1）、报告写入 agent-outputs/w1-report.md。`, 'zhipuai/glm-5.3-flash') },
        { name: 'task_submit', args: submitArgs('luban', 'PROBE-TASK-W2 写作任务\n按任务书完成：桥接读取与一次未分配写入尝试（operationId=w2-op-1）。', 'zhipuai/glm-5.3-flash') },
        { name: 'task_submit', args: submitArgs('diting', 'PROBE-TASK-R1 独立审查任务\n按任务书完成：草稿读取、审查者越权写入试探、提交交接（operationId=r1-handoff-1）。', 'zhipuai/glm-5.3') },
        { name: 'task_submit', args: submitArgs('fuxi', 'PROBE-BAD-ROLE 非构建角色派发（预期被派发守卫阻断）', 'zhipuai/glm-5.3') },
        { name: 'task_submit', args: submitArgs('luban', 'PROBE-BAD-MODEL 越界模型覆盖派发（预期被派发守卫阻断）', 'zhipuai/glm-9.9-pro') },
      ],
    }),
    (history: ParsedHistory): { toolCalls: Array<{ name: string; args: Record<string, unknown> }> } | null => {
      const handles = handlesFrom(history);
      if (handles.length < 3) return null;
      return { toolCalls: [{ name: 'build_assign_output', args: { ownerTaskId: handles[0], targets: [DOC_W1] } }] };
    },
    (): { text: string } => ({ text: '派发与输出分配完成，等待后台任务完成通知。' }),
  ];
  // 自触发轮（完成通知驱动）：W1 完成 → 续接；续接完成 → 慢任务；慢任务已派发 → 终稿
  const dynamicLeaderStep = (history: ParsedHistory): { toolCalls: Array<{ name: string; args: Record<string, unknown> }> } | { text: string } | null => {
    const mine = assistantText(history);
    const handles = handlesFrom(history);
    const resumed = mine.includes('task_resume');
    const slowSubmitted = mine.includes('PROBE-TASK-SLOW');
    if (!resumed && completed(history, 'PROBE-TASK-W1') && handles.length > 0) {
      return { toolCalls: [{ name: 'task_resume', args: { handle: handles[0], message: 'PROBE-RESUME-W1 请对 systems/demo-guide.md 再提交一次修订写入（operationId=w1-op-2）。', delivery: 'handle' } }] };
    }
    if (resumed && completed(history, 'PROBE-RESUME-W1') && !slowSubmitted) {
      return { toolCalls: [{ name: 'task_submit', args: submitArgs('baize', 'PROBE-TASK-SLOW 慢读取任务\n只做一次 raw_list（探测取消窗口）。', 'zhipuai/glm-5.3-flash') }] };
    }
    if (slowSubmitted) return null;
    return { text: '等待后台任务完成通知。' };
  };
  for (let i = leaderSteps.length; i < 24; i += 1) leaderSteps.push(dynamicLeaderStep as never);

  return { scripts, finals, leaderSteps, leaderFinal: 'probe 构建流程完成（派发/写入/审查/续接/慢任务窗口已覆盖）。' };
}

type FixtureServerBundle = {
  scripts: Record<string, Array<{ toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; text?: string; delayMs?: number }>>;
  finals: Record<string, string>;
  leaderSteps: Array<(history: ParsedHistory) => { toolCalls?: Array<{ name: string; args: Record<string, unknown> }> } | { text: string } | null>;
  leaderFinal: string;
};

// ── 主流程 ─────────────────────────────────────────────────────────────

interface Registrations { byTaskId: Map<string, { agent: string; parent: string | null }> }

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const run = new ProbeRun();
  const startedAt = new Date().toISOString();
  const meta = {
    startedAt,
    finishedAt: startedAt,
    mode: (args.realModel ? 'real-model' : 'fixture-model') as 'fixture-model' | 'real-model',
    piCliPath: args.piCli,
    piVersion: '',
    sourceAmagiDir: args.sourceAmagi,
    amagiVersion: '',
    tempRoot: null as string | null,
  };
  const writeReport = (exitHint: number): number => {
    meta.finishedAt = new Date().toISOString();
    try {
      const report = renderProbeReport(meta, run.checks.checks, [...run.notes,
        'fixture 模型 ≠ 实际 LLM 质量/性能证据；本 probe 只证明运行能力与权限链路。',
        ...(args.realModel ? ['本轮为 --real-model 模式：真实端点；密钥仅经环境变量传递，报告已脱敏。'] : []),
      ]);
      fs.mkdirSync(path.dirname(args.report), { recursive: true });
      fs.writeFileSync(args.report, report);
      const evidencePath = path.join(path.dirname(args.report), 'live-probe-evidence.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        meta,
        checks: run.checks.checks,
        notes: run.notes,
        probeLog: run.log.map((line) => redact(line)),
        fixtureModelLog: modelServerRef?.log ?? [],
        bridgeAudit: stackRef?.audit ?? [],
        actors: stackRef?.actorStore.listActors() ?? [],
        assignments: stackRef?.actorStore.listAssignments() ?? [],
        guardedSubmits: run.guardedSubmits,
        serverErrors: stackRef?.serverErrors ?? [],
        submitResults: run.submitResults.map((entry) => ({ ...entry, text: redact(entry.text).slice(0, 2000) })),
        selfRoundEvents: run.selfRoundEvents,
        leaderEventTypes: run.leaderEvents.reduce<Record<string, number>>((acc, event) => {
          const type = String(event.type ?? 'unknown');
          acc[type] = (acc[type] ?? 0) + 1;
          return acc;
        }, {}),
      }, null, 2));
      run.say(`报告已写入 ${args.report}（证据 ${evidencePath}）`);
    } catch (error) {
      process.stderr.write(`[probe] 报告写入失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return exitHint;
  };

  let modelServerRef: FixtureModelServer | null = null;
  let stackRef: ProbeAppStack | null = null;
  let tempKeep = args.keep;
  let tempRoot: string | null = null;
  let adapterRef: PiAmagiBuildRuntime | null = null;
  let bindingRef: RuntimeBinding | null = null;
  let rpcRef: import('../src/agent/pi-rpc-process.js').PiRpcProcess | null = null;
  const registrations: Registrations = { byTaskId: new Map() };
  const markerIds = new Map<string, string>(); // PROBE-TASK-W1 → taskId（断言用权威映射）
  const psBaselinePids = new Set<number>();
  let psDuring: string[] = [];
  let psAfter: string[] = [];

  const cleanup = async (): Promise<void> => {
    try { if (bindingRef && adapterRef) await adapterRef.cancel(bindingRef).catch(() => undefined); } catch { /* 已终止 */ }
    try { await modelServerRef?.stop(); } catch { /* ignore */ }
    try { await stackRef?.stop(); } catch { /* ignore */ }
    if (tempRoot && !tempKeep) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; }
        catch (error) {
          if (attempt === 2) run.notes.push(`临时目录清理失败（--keep 可保留手工核查）：${error instanceof Error ? error.message : String(error)}`);
          else await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
  };
  process.once('SIGINT', () => { tempKeep = true; void cleanup().finally(() => process.exit(130)); });

  try {
    // ── 预检（不可用 → unavailable，不假通过）──
    if (args.error) throw new Error(args.error);
    const piCli = path.resolve(args.piCli);
    if (!fs.existsSync(piCli)) throw new Error(`piCli 不存在: ${piCli}`);
    const piVersion = readPiVersion(piCli);
    if (!piVersion) throw new Error(`无法从 ${piCli} 解析 pi 版本（需 pi-coding-agent 包）`);
    meta.piVersion = piVersion;
    const sourceDir = path.resolve(args.sourceAmagi);
    if (!fs.existsSync(path.join(sourceDir, 'package.json'))) throw new Error(`sourceAmagi 缺 package.json: ${sourceDir}`);
    const amagiPkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8')) as { name?: string; version?: string };
    if (amagiPkg.name !== 'amagi-pi') throw new Error(`sourceAmagi 不是 amagi-pi 包（name=${amagiPkg.name}）`);
    if (!amagiPkg.version) throw new Error('sourceAmagi 缺版本号');
    meta.amagiVersion = amagiPkg.version;
    const sourceLayout = inspectAmagiPackageLayout(sourceDir);
    if (!sourceLayout.ok) throw new Error(`amagi-pi 源结构不完整: ${sourceLayout.issues.join('、')}`);
    run.checks.pass('preflight', '外部资源预检', `pi ${piVersion} @ ${piCli}；amagi-pi ${amagiPkg.version} @ ${sourceDir}（结构完整）`);

    // ── 临时环境（全隔离；不读生产资料）──
    const temp = createProbeTempEnv(true);
    tempRoot = temp.root;
    meta.tempRoot = temp.root;
    const sources = writeSourceFixtures(temp.rawRoot);
    const skillContent = writeSkillFixture(temp.skillDir, SKILL_MARKER);
    run.say(`临时根 ${temp.root}`);

    // ── fixture 模型服务器（真实模型模式跳过）──
    let modelBaseUrl: string;
    let zhipuKey: string;
    if (args.realModel) {
      zhipuKey = process.env.ZHIPU_API_KEY ?? '';
      if (!zhipuKey) throw new Error('--real-model 需要环境变量 ZHIPU_API_KEY（不打印值）');
      modelBaseUrl = process.env.PI_PROBE_REAL_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4';
      run.say('real-model 模式：真实端点（fixture 脚本断言将标 not-measured）');
    } else {
      zhipuKey = 'probe-fixture-not-a-real-key';
      const bundle = buildFixtureModelConfig({ sentinelFile: temp.sentinelFile, sentinelDir: path.dirname(temp.sentinelFile) });
      const server = new FixtureModelServer({
        scripts: bundle.scripts,
        finals: bundle.finals,
        leaderSteps: bundle.leaderSteps,
        leaderFinal: bundle.leaderFinal,
      });
      await server.start();
      modelServerRef = server;
      modelBaseUrl = `${server.baseUrl}/v1`;
      run.say(`fixture 模型服务器 ${server.baseUrl}`);
    }

    // ── 应用侧真实栈（桥接目标）──
    const buildId = `b_${Date.now().toString(36)}_probe01`;
    const leaderToolList = [...new Set([...AMAGI_TASK_TOOLS, ...V2_LEADER_TOOLS])];
    const stack = await buildProbeAppStack({
      dataRoot: temp.feishuHome,
      knowledgeBaseRoot: temp.rawRoot,
      outputRoot: temp.outputRoot,
      stagingRoot: path.join(temp.stagingRoot, buildId),
      buildId,
      generation: 1,
      sources,
      leaderTools: leaderToolList,
      leaderToolNames: leaderToolList,
    });
    stackRef = stack;
    run.say(`应用回环 API ${stack.url}`);

    // ── 版本化安装（真实 installAmagiPackage；source 模式）──
    const install = await installAmagiPackage({
      nodePath: process.execPath,
      piCliPath: piCli,
      dataRoot: temp.feishuHome,
      version: amagiPkg.version,
      sourceDir,
      log: (line) => run.say(line),
    });
    run.checks.pass('package-install', '版本化 amagi-pi 安装',
      `installAmagiPackage(source) → ${install.packageRoot}（hash ${install.contentHash.slice(0, 12)}，${install.record.hashedFiles} 文件，fresh=${install.fresh}）`);
    const verified = verifyAmagiPackage({ dataRoot: temp.feishuHome, version: amagiPkg.version });
    run.checks[verified.contentHash === install.contentHash ? 'pass' : 'fail']('package-verify', '安装后哈希复核',
      `verifyAmagiPackage hash=${verified.contentHash.slice(0, 12)}（漂移即失败）`);

    // ── BuildRunSpec 冻结（render → hash → spec）──
    const dirs = planBuildDirectories(temp.feishuHome, buildId);
    const descriptors: BuildModelDescriptor[] = [
      { id: 'glm-5.3', baseUrl: modelBaseUrl, api: 'openai-completions', reasoning: false, contextWindow: 128_000, maxTokens: 8192 },
      { id: 'glm-5.3-flash', baseUrl: modelBaseUrl, api: 'openai-completions', reasoning: false, contextWindow: 128_000, maxTokens: 8192 },
    ];
    const specBase: Omit<BuildRunSpec, 'agentDirConfigHash'> = {
      buildId,
      generation: 1,
      orchestrationMode: 'pi-amagi',
      mode: 'full',
      sourceManifestHash: sha256Text(sources.map((source) => `${source.objToken}:${source.relPath}`).join('\n')),
      workflowRevision: sha256Text(skillContent),
      workflowSkillPath: path.join(temp.skillDir, 'SKILL.md'),
      amagiPackage: { version: install.version, installDir: install.installDir, packageRoot: install.packageRoot, contentHash: install.contentHash },
      piVersion,
      models: { leader: 'zhipuai/glm-5.3', writer: 'zhipuai/glm-5.3-flash', reviewer: 'zhipuai/glm-5.3', research: 'zhipuai/glm-5.3-flash' },
      modelDescriptors: descriptors,
      roles: { ...DEFAULT_ROLE_AGENTS },
      limits: { maxConcurrentAgents: 3, admissionPools: { writer: 1, reviewer: 1 } },
      autoRounds: { ...DEFAULT_AUTO_ROUNDS },
      publicationPolicy: 'manual',
    };
    const bridgeArgs = [path.join(SERVER_ROOT, 'src', 'agent', 'claude-bridge.cjs')];
    const rendered = renderAgentDirConfigFiles(specBase as BuildRunSpec, dirs, { bridgeCommand: process.execPath, bridgeArgs });
    const spec: BuildRunSpec = { ...specBase, agentDirConfigHash: computeAgentDirConfigHash(rendered) };

    // ── adapter 与真实 Leader 启动 ──
    const distGuard = path.join(SERVER_ROOT, 'dist', 'agent', 'build-runtime', 'dispatch-guard.js');
    const guardModulePath = fs.existsSync(distGuard) ? distGuard : path.join(SERVER_ROOT, 'src', 'agent', 'build-runtime', 'dispatch-guard.ts');
    const deps: PiAmagiRuntimeDeps = {
      nodePath: process.execPath,
      piCliPath: piCli,
      dataRoot: temp.feishuHome,
      knowledgeBaseRoot: temp.rawRoot,
      outputRoot: temp.outputRoot,
      forwardingExtensionPath: path.join(SERVER_ROOT, 'src', 'agent', 'pi-extension', 'feishu-sync-agent.js'),
      bridgeScriptPath: bridgeArgs[0],
      agentUrl: stack.url,
      resolveZhipuApiKey: () => zhipuKey,
      issueLeaderRunToken: () => stack.leaderToken,
      issueMcpBridgeCredentials: () => ({ url: stack.url, token: stack.childToken }),
      revokeGenerationCredentials: () => {
        stack.actorStore.rotateGeneration(2, 'probe-cancel');
        stack.toolService.revokeByBuild(buildId);
        return true;
      },
      leaderTools: leaderToolList,
      roleMcpTools: {
        luban: [...V2_WRITER_TOOLS],
        diting: [...V2_REVIEWER_TOOLS],
        baize: [...V2_RESEARCH_TOOLS],
      },
      guardModulePath,
      getLeaderModel: (specArg) => specArg.models.leader,
      isProcessAlive: (pid) => {
        if (pid === null) return true;
        try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      },
      log: (line) => run.say(line),
    };
    const adapter = new PiAmagiBuildRuntime(deps);
    adapterRef = adapter;
    const binding = await adapter.start(spec);
    bindingRef = binding;
    const rpc = adapter.getRpcProcess(binding)!;
    rpcRef = rpc;
    rpc.on('record', (record: Record<string, unknown>) => {
      run.recordEvent(record);
      // 创建事件登记（设计 §4.1 集成者职责；probe 不派发任何子进程）
      for (const creation of run.pairedCreations()) {
        for (const taskId of creation.taskIds) {
          if (registrations.byTaskId.has(taskId)) continue;
          const parent = creation.parentTaskId;
          const parentActor = parent ? registrations.byTaskId.get(parent) : undefined;
          const agent = creation.agent || parentActor?.agent || 'luban';
          if (creation.marker && /PROBE-(?:TASK|RESUME)-/.test(creation.marker)) markerIds.set(creation.marker, taskId);
          try {
            stack.actorStore.registerTaskCreation({ nativeTaskId: taskId, parentTaskId: parent, requestedRole: agent, agent });
            registrations.byTaskId.set(taskId, { agent, parent });
            run.say(`登记任务身份 ${taskId.slice(0, 10)} agent=${agent} parent=${parent ?? '-'}（${creation.tool}）`);
          } catch (error) {
            run.notes.push(`任务身份登记失败 ${taskId.slice(0, 10)}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    });
    rpc.on('round_started', (event: Record<string, unknown>) => {
      if (event.trigger === 'extension-message') {
        run.selfRounds += 1;
        run.selfRoundEvents.push(`${new Date().toISOString()} round ${String(event.roundId)}（后台完成通知自触发）`);
      }
    });
    rpc.on('stderr', () => undefined);
    run.checks.pass('leader-start', '真实 Leader RPC 启动',
      `session=${binding.leaderSessionId} pid=${binding.leaderPid} agentDir=${binding.agentDir}`);

    // 静态能力探测（含 agentDir 落盘复核）
    try {
      const report = await adapter.probeWith({
        dataRoot: temp.feishuHome, amagiVersion: install.version, knowledgeBaseRoot: temp.rawRoot,
        outputRoot: temp.outputRoot, hasZhipuApiKey: true, piVersion, spec, agentDir: binding.agentDir,
        bridge: { bridgeCommand: process.execPath, bridgeArgs },
      });
      for (const check of report.checks) {
        run.checks.add({ id: `static:${check.id}`, title: `静态/${check.title}`, state: check.state === 'warn' ? 'pass' : check.state, detail: check.detail });
      }
    } catch (error) {
      run.checks.fail('static-probe', '静态能力探测', error instanceof Error ? error.message : String(error));
    }

    // 基线进程快照（区分既有无关进程与本 probe 后代）
    const baseSnapshot = await snapshotProcesses();
    if (baseSnapshot.ok) {
      for (const entry of probeRelatedProcesses(baseSnapshot, [piCli, bridgeArgs[0]])) psBaselinePids.add(entry.pid);
    }

    const leaderPrompt = [
      'PROBE-LEADER-RUN 构建 probe 主控轮（任务书用 W1/W2/R1/SLOW 代称，具体正文由你派发时填写）：',
      '1) 依次派发 3 个后台任务（task_submit delivery=handle）：luban×2（W1、W2 两个写作任务）、diting×1（R1 独立审查）；再派发两个预期被派发守卫阻断的 task_submit（agent=fuxi；以及 agent=luban 但 model=zhipuai/glm-9.9-pro）。',
      '2) 用 build_assign_output 把 systems/demo-guide.md 分配给 W1 的任务句柄。',
      '3) 等待后台完成通知：收到 W1 完成后 task_resume 它的句柄（续接消息以「PROBE-RESUME」开头，合上任务代号 W1）；收到续接完成后派发 SLOW（baize）；慢任务已派发后给出最终结论。',
    ].join('\n');

    // ── Phase 1：宿主驱动首轮（真实 amagi 派发链路）──
    const firstOutcome = await rpc.prompt(leaderPrompt, { timeoutMs: 120_000 });
    run.checks[firstOutcome.outcome === 'completed' ? 'pass' : 'fail']('leader-round1', 'Leader 首轮完成',
      `outcome=${firstOutcome.outcome}${firstOutcome.error ? `（${firstOutcome.error.code}: ${firstOutcome.error.message.slice(0, 160)}）` : ''}`);

    // 首轮后冻结契约计数（3 个合法派发；两个越界派发不得建任务）
    const v2StoreDir = path.join(binding.agentDir, 'amagi', 'v2-store');
    const specDirsAfterRound1 = fs.existsSync(v2StoreDir) ? fs.readdirSync(v2StoreDir).filter((name) => fs.statSync(path.join(v2StoreDir, name)).isDirectory()) : [];

    // ── Phase 2：等待后台任务（完成通知 → Leader 自触发轮）──
    const deadline = Date.now() + Math.max(60, args.timeoutSec - 120) * 1000;
    const want = args.realModel ? null : (['w1', 'w2', 'r1', 'resume-w1'] as const);
    let slowStarted = false;
    while (Date.now() < deadline && !rpc.isExited()) {
      if (want) {
        const done = want.every((script) => modelServerRef?.scriptSawFinal(script) === true);
        slowStarted = modelServerRef?.scriptStarted('slow') === true;
        if (done && slowStarted) break;
      } else {
        const slowSubmitted = run.pairedCreations().some((creation) => creation.tool === 'task_submit' && creation.taskIds.length > 0 && registrations.byTaskId.size >= 5);
        if (slowSubmitted) { await new Promise((resolve) => setTimeout(resolve, 8000)); break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const during = await snapshotProcesses();
    if (during.ok) psDuring = probeRelatedProcesses(during, [piCli, bridgeArgs[0]]).filter((entry) => !psBaselinePids.has(entry.pid)).map((entry) => `pid=${entry.pid} pgid=${entry.pgid} ${entry.command.slice(0, 120)}`);
    run.say(`运行期相关进程 ${psDuring.length} 个`);

    // ── Phase 3：取消（先撤代次凭据 → 宽限终止 → 残留与旧代次核对）──
    run.say('Phase 3：取消链路');
    const cancelResult = await adapter.cancel(binding);
    bindingRef = null;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await snapshotProcesses();
    if (after.ok) psAfter = probeRelatedProcesses(after, [piCli, bridgeArgs[0]]).filter((entry) => !psBaselinePids.has(entry.pid)).map((entry) => `pid=${entry.pid} pgid=${entry.pgid} ${entry.command.slice(0, 120)}`);
    run.checks[cancelResult.leaderExit !== null ? 'pass' : 'fail']('cancel-leader-exit', '取消：Leader 终止',
      `exit=${JSON.stringify(cancelResult.leaderExit)}；${cancelResult.residualNote}`);
    run.checks[after.ok && psAfter.length === 0 ? 'pass' : 'fail']('cancel-no-residue', '取消：无残留进程',
      after.ok ? (psAfter.length === 0 ? `取消后无相关进程（运行期 ${psDuring.length} 个全部退出）` : `残留：${psAfter.join('；')}`) : `ps 不可用：${after.error ?? ''}`);

    // 旧代次写入拒绝（撤销后的子任务凭据直接打真实内部 API）
    const lateActorEntry = [...registrations.byTaskId.entries()].filter(([, info]) => info.agent === 'luban').pop();
    const lateTaskId = lateActorEntry?.[0] ?? '';
    if (lateTaskId) {
      try {
        const lateResponse = await fetch(`${stack.url}/api/agent-internal/tools/kb_write_doc`, {
          method: 'POST',
          headers: { 'X-Agent-Run-Token': stack.childToken, 'X-Amagi-Task-Id': lateTaskId, 'X-Amagi-Agent': 'luban', 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolCallId: 'probe-late-write', args: { path: DOC_W1, title: '迟到写入', markdown: '# 迟到\n', summary: '取消后旧凭据写入', sources: ['tok_probe_w1'], operationId: 'late-op-1' } }),
        });
        const lateBody = (await lateResponse.json().catch(() => ({}))) as { error?: string; message?: string };
        run.checks[lateResponse.status === 401 ? 'pass' : 'fail']('old-gen-write-rejected', '旧代次写入被拒',
          `status=${lateResponse.status} error=${lateBody.error ?? '-'}（预期 401：令牌已撤销/代次已轮换）`);
      } catch (error) {
        run.checks.fail('old-gen-write-rejected', '旧代次写入被拒', `探针请求失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      run.checks.unavailable('old-gen-write-rejected', '旧代次写入被拒', '无已登记 luban 任务可试旧凭据');
    }

    // ── 断言收集（全部基于真实观测证据）──
    const fixtureLog = modelServerRef?.log ?? [];
    const histories = modelServerRef?.historyByScript ?? new Map<string, unknown[]>();
    const systems = modelServerRef?.systemByScript ?? new Map<string, string>();

    // A. 派发守卫：改参实际生效（证据=冻结契约 spec + 非法派发阻断；tool_execution_start
    //    携带的是模型原始参数——pi 在 tool_call 钩子改参后不重发事件，不能作改参证据）
    const w1Id = markerIds.get('PROBE-TASK-W1') ?? '';
    const w2Id = markerIds.get('PROBE-TASK-W2') ?? '';
    const r1Id = markerIds.get('PROBE-TASK-R1') ?? '';
    const resumeId = markerIds.get('PROBE-RESUME-W1') ?? '';
    const readSpecPermission = (taskId: string): { permission: Record<string, unknown>; workspace: Record<string, unknown> } | null => {
      if (!taskId) return null;
      const specDir = path.join(v2StoreDir, taskId);
      const files = fs.existsSync(specDir) ? fs.readdirSync(specDir).filter((name) => name.startsWith('spec-')) : [];
      if (files.length === 0) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(specDir, files[0]), 'utf-8')) as { permission?: Record<string, unknown>; workspace?: Record<string, unknown> };
        return { permission: parsed.permission ?? {}, workspace: parsed.workspace ?? {} };
      } catch { return null; }
    };
    {
      const specRecord = w1Id ? readSpecPermission(w1Id) : null;
      const issues: string[] = [];
      if (!specRecord) issues.push('未读到 W1 冻结契约 spec');
      else {
        const { permission, workspace } = specRecord;
        if (permission.shell !== 'deny') issues.push(`spec.shell=${String(permission.shell)}`);
        const writeJson = JSON.stringify(permission.write ?? '');
        if (!writeJson.includes('agent-outputs') || writeJson.includes('/tmp/escape')) issues.push(`spec.write=${writeJson.slice(0, 140)}`);
        const mcpEntries = Array.isArray(permission.mcp) ? (permission.mcp as Array<{ tool?: string }>) : [];
        const mcpTools = mcpEntries.map((entry) => entry.tool ?? '').sort();
        if (mcpTools.join(',') !== [...V2_WRITER_TOOLS].sort().join(',')) issues.push(`spec.mcp=${mcpTools.join(',').slice(0, 140)}`);
        const denyValues = (Array.isArray(permission.deny) ? (permission.deny as Array<{ value?: string }>) : []).map((entry) => entry.value ?? '');
        if (!denyValues.some((value) => temp.rawRoot.startsWith(value) || value.startsWith(temp.rawRoot))) issues.push('spec.deny 不含原始库禁区');
        if (!denyValues.some((value) => value.endsWith('/.pi'))) issues.push('spec.deny 不含工作区配置面');
        if (workspace.mode !== 'existing' || !String(workspace.cwd ?? '').endsWith('/work')) issues.push(`spec.workspace=${JSON.stringify(workspace).slice(0, 120)}`);
        if (/"lsp":\["diagnostics/.test(JSON.stringify(permission))) issues.push('spec.lsp 未清空');
      }
      run.checks[issues.length === 0 ? 'pass' : 'fail']('guard-freeze-scope', '派发守卫冻结 scope（v2-store 冻结契约）',
        issues.length === 0 ? `W1 契约：shell=deny、write=agent-outputs/**、mcp=${[...V2_WRITER_TOOLS].length} 项精确名单、deny 含原始库/配置面禁区、workspace=existing（原始敌意参数被守卫改写并冻结）` : issues.join('；'));
    }

    // B. 越界派发被阻断（守卫 block；未建任务）
    const leaderHistoryText = () => {
      const messages = (histories.get('leader') ?? []) as Array<{ role?: string; content?: unknown }>;
      return messages.map((message) => {
        const content = message.content;
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join('');
      }).join('\n');
    };
    if (modelServerRef) {
      const leaderText = leaderHistoryText();
      const blockedRole = leaderText.includes('dispatch_role_not_allowed');
      const blockedModel = leaderText.includes('dispatch_model_not_frozen');
      const specCountOk = specDirsAfterRound1.length === 3;
      run.checks[blockedRole && blockedModel && specCountOk ? 'pass' : 'fail']('guard-block-illegal', '越界角色/模型派发被阻断',
        `fuxi 阻断=${blockedRole}；越界模型阻断=${blockedModel}；首轮后冻结契约目录=${specDirsAfterRound1.length}（预期 3，两个非法派发不得建任务）`);
    } else {
      run.checks.notMeasured('guard-block-illegal', '越界角色/模型派发被阻断', 'real-model 模式无 fixture 历史可断言（真实模型是否照做非确定）');
    }

    // C. 子任务工具面（fixture 模型可见的真实声明工具）
    const childEntries = fixtureLog.filter((entry) => ['w1', 'w2', 'r1', 'slow'].includes(entry.script));
    if (childEntries.length > 0) {
      const toolsets = new Map(childEntries.map((entry) => [entry.script, entry.tools]));
      const issues: string[] = [];
      const notesExtra: string[] = [];
      for (const [script, tools] of toolsets) {
        for (const banned of ['bash', 'amagi_advisor', 'lsp']) if (tools.includes(banned)) issues.push(`${script} 含 ${banned}`);
        for (const tool of tools) if (tool.startsWith('mcp__')) issues.push(`${script} 含直连 MCP 工具 ${tool}`);
        for (const banned of ['codemode', 'tool_search']) if (tools.includes(banned)) issues.push(`${script} 工具面含 ${banned}（设计 §3.3 预期无此面）`);
        if (tools.includes('toolcall_continue')) notesExtra.push(`${script} 含 toolcall_continue（pi 断点续传机制，非 MCP 面，记录备查）`);
        for (const required of ['read', 'grep', 'write', 'amagi_resource', 'mcp_call', 'mcp_list_tools']) {
          if (!tools.includes(required)) issues.push(`${script} 缺 ${required}`);
        }
      }
      if (notesExtra.length > 0) run.notes.push(...notesExtra);
      run.checks[issues.length === 0 ? 'pass' : 'fail']('child-tools-surface', '子任务真实工具面',
        issues.length === 0 ? `观测 ${toolsets.size} 个子任务请求：无 bash/advisor/lsp/codemode/tool_search/直连 mcp__*，含 read/write/mcp_call 等授权工具` : issues.join('；'));
    } else {
      run.checks.notMeasured('child-tools-surface', '子任务真实工具面', args.realModel ? 'real-model 模式无 fixture 观测面' : '未捕获子任务模型请求（子任务未真实启动？）');
    }

    // Leader 工具面（白名单一致）
    const leaderEntries = fixtureLog.filter((entry) => entry.script === 'leader');
    if (leaderEntries.length > 0) {
      const observed = [...new Set(leaderEntries.flatMap((entry) => entry.tools))].sort();
      const expected = [...leaderToolList].sort();
      const same = observed.join(',') === expected.join(',');
      const banned = observed.filter((tool) => ['bash', 'codemode', 'tool_search', 'run_bg', 'task_cancel'].includes(tool));
      run.checks[same && banned.length === 0 ? 'pass' : 'fail']('leader-tools-whitelist', 'Leader 工具白名单',
        same && banned.length === 0 ? `实际声明工具与冻结白名单一致（${observed.length} 项，含 amagi 任务面）` : `观测=${observed.join(',').slice(0, 200)}；期望=${expected.join(',').slice(0, 200)}；禁项=${banned.join(',')}`);
    } else {
      run.checks.notMeasured('leader-tools-whitelist', 'Leader 工具白名单', args.realModel ? 'real-model 模式无 fixture 观测面' : '未捕获 Leader 模型请求');
    }

    const leaderSystem = systems.get('leader');
    if (leaderSystem !== undefined) {
      const hasRules = leaderSystem.includes(SKILL_MARKER);
      run.checks[hasRules ? 'pass' : 'fail']('leader-system-rules', 'Leader 冻结规则实际进入系统提示',
        hasRules ? '模型请求的 system 消息包含冻结规则 marker（不是仅用户首轮消息）' : '模型请求 system 未包含冻结规则，不能把用户 briefing 冒充系统注入');
    } else {
      run.checks.notMeasured('leader-system-rules', 'Leader 冻结规则实际进入系统提示', '缺少模型系统消息观测');
    }

    // D. 身份上行（桥接读到的 AMAGI_TASK_ID/AGENT 与登记身份一致）
    const bridgeCalls = stack.audit.filter((entry) => entry.tool !== null);
    const unknownIds = bridgeCalls.filter((entry) => entry.amagiTaskId && !registrations.byTaskId.has(entry.amagiTaskId));
    const agentMismatch = bridgeCalls.filter((entry) => {
      const registered = entry.amagiTaskId ? registrations.byTaskId.get(entry.amagiTaskId) : undefined;
      return registered && entry.amagiAgent && entry.amagiAgent !== registered.agent;
    });
    run.checks[bridgeCalls.length > 0 && unknownIds.length === 0 && agentMismatch.length === 0 ? 'pass' : 'fail']('identity-uplink', '子任务身份上行（AMAGI_TASK_ID/AGENT）',
      bridgeCalls.length === 0 ? '桥接无调用（子任务未到达 MCP 通道）'
        : `桥接调用 ${bridgeCalls.length} 次；未登记身份 ${unknownIds.length}；角色不一致 ${agentMismatch.length}（身份来自真实子进程 env，经桥接头上行）`);

    // E. MCP 精确读/写授权（按任务×工具×状态；未授权工具可在 amagi scope 层或应用层被拒，两层都算真实拒绝）
    const statusOf = (tool: string, taskIds: string[]): number[] => bridgeCalls.filter((entry) => entry.tool === tool && entry.amagiTaskId && taskIds.includes(entry.amagiTaskId)).map((entry) => entry.status);
    const w1AllText = ((histories.get('w1') ?? []) as Array<{ role?: string; content?: unknown }>).map((message) => {
      const content = message.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join('');
    }).join('\n');
    const amagiScopeRejected = w1AllText.includes('未在任务授权名单');
    const r1AllText = ((histories.get('r1') ?? []) as Array<{ role?: string; content?: unknown }>).map((message) => {
      const content = message.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join('');
    }).join('\n');
    const amagiScopeRejectedR1Write = /kb_write_doc[^\n]{0,80}未在任务授权名单/.test(r1AllText) || (r1AllText.includes('未在任务授权名单') && r1AllText.includes('kb_write_doc'));
    const readList = statusOf('raw_list', [w1Id].filter(Boolean));
    const readRaw = statusOf('raw_read', [w2Id].filter(Boolean));
    const draftList = statusOf('draft_list', [r1Id].filter(Boolean));
    const writeW1 = statusOf('kb_write_doc', [w1Id].filter(Boolean));
    const writeW2 = statusOf('kb_write_doc', [w2Id].filter(Boolean));
    const writeR1 = statusOf('kb_write_doc', [r1Id].filter(Boolean));
    const reviewByWriter = statusOf('kb_submit_review', [w1Id].filter(Boolean));
    const writeResume = statusOf('kb_write_doc', [resumeId].filter(Boolean));
    const eParts: string[] = [];
    let eOk = true;
    const need = (ok: boolean, okText: string, badText: string): void => { if (ok) eParts.push(okText); else { eOk = false; eParts.push(badText); } };
    need(readList.includes(200) && readRaw.includes(200), `只读 raw_list/raw_read=200`, `只读异常 raw_list(w1)=${readList} raw_read(w2)=${readRaw}`);
    need(writeW1.includes(200), '分配内写入(w1)=200', `分配内写入(w1)=${writeW1}`);
    need(writeW2.includes(409), '未分配写入(w2)=409', `未分配写入(w2)=${writeW2}`);
    need(writeR1.includes(403) || amagiScopeRejectedR1Write, `审查者正文写入被拒（${writeR1.includes(403) ? '应用层 403' : 'amagi scope 层'}）`, `审查者正文写入未被拒：应用层=${writeR1}，amagi 层=${amagiScopeRejectedR1Write}`);
    need(reviewByWriter.includes(403) || amagiScopeRejected, `写作者审查工具被拒（${reviewByWriter.includes(403) ? '应用层 403' : 'amagi scope 层未授权名单拦截'}）`, `写作者审查工具未被拒：应用层=${reviewByWriter}，amagi 层拦截=${amagiScopeRejected}`);
    need(draftList.includes(200), '审查者只读 draft_list=200', `审查者 draft_list=${draftList}`);
    need(writeResume.includes(200), '续接写入=200', `续接写入=${writeResume}`);
    run.checks[eOk ? 'pass' : 'fail']('mcp-precise-authz', 'MCP 精确读/写授权', eParts.join('；'));

    // codemode 面实测（设计 §3.3 预期无此面；记录它是否能触达桥接）
    const w1History = (histories.get('w1') ?? []) as Array<{
      role?: string; content?: unknown; tool_call_id?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
    }>;
    const callNames = new Map<string, string>();
    for (const message of w1History) {
      for (const call of message.tool_calls ?? []) {
        if (call.id && call.function?.name) callNames.set(call.id, call.function.name);
      }
    }
    const codemodeResultText = w1History
      .filter((message) => message.role === 'tool' && callNames.get(message.tool_call_id ?? '') === 'codemode')
      .map((message) => {
        const content = message.content;
        if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
        return content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join('');
      }).join('\n');
    if (codemodeResultText) {
      const bridgeReachable = /mcp__feishu[_-]kb[_-]bridge/.test(codemodeResultText);
      const hidden = fixtureLog.filter((entry) => entry.script !== 'leader')
        .every((entry) => !entry.tools.some((name) => name === 'codemode' || name === 'tool_search'));
      const rejected = /child-policy|unknown tool|tool .*not (?:found|active)|工具.*(?:不存在|未激活)/i.test(codemodeResultText);
      const safe = hidden && rejected && !bridgeReachable;
      run.checks[safe ? 'pass' : 'fail']('codemode-facet', '子任务无 codemode/tool_search 面（设计 §3.3）',
        safe ? '实际子任务请求面无禁用工具，强制codemode调用被拒；正常MCP通道另行验证'
          : `禁用面过滤=${hidden}；强制调用拒绝=${rejected}；可发现桥接工具名=${bridgeReachable}。此步骤仅测试发现，不据此宣称已调用或绕过业务写入授权。结果：${codemodeResultText.slice(0, 180).replace(/\n/g, ' ')}`);
      if (!safe) run.notes.push('codemode工具面尚未收口：保留失败，不以MCP关闭自动启用或仅隐藏UI作为通过证据。');
    } else {
      run.checks.notMeasured('codemode-facet', '子任务无 codemode/tool_search 面（设计 §3.3）', '未捕获 codemode 试探结果');
    }

    // F. P0 敏感 sentinel：真实子进程 read/grep 被拒（子任务工具结果证据）
    const w1Messages = (histories.get('w1') ?? []) as Array<{ role?: string; content?: unknown }>;
    const toolTexts = w1Messages.filter((message) => message.role === 'tool').map((message) => {
      const content = message.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join('');
    });
    const denied = (text: string): boolean => /拒绝|deny|denied|禁|permission|blocked|not allowed|无法|invalid|forbid/i.test(text);
    if (toolTexts.length >= 2) {
      const readResult = toolTexts[0] ?? '';
      const grepResult = toolTexts[1] ?? '';
      const leak = w1Messages.map((message) => JSON.stringify(message.content ?? '')).join('').includes(SENTINEL_SECRET);
      run.checks[denied(readResult) && denied(grepResult) && !leak ? 'pass' : 'fail']('p0-sentinel-deny', 'P0 敏感 sentinel 读取被拒（真实子进程）',
        `read 结果：${readResult.slice(0, 140).replace(/\n/g, ' ')}；grep 结果：${grepResult.slice(0, 140).replace(/\n/g, ' ')}；哨兵内容泄漏=${leak}`);
    } else {
      run.checks.notMeasured('p0-sentinel-deny', 'P0 敏感 sentinel 读取被拒（真实子进程）', args.realModel ? 'real-model 模式无 fixture 历史' : 'W1 会话历史不完整');
    }
    // 配置面写拒 + 报告写成功（同一历史的第 6/7 个工具结果）
    if (toolTexts.length >= 7) {
      const configWrite = toolTexts[5] ?? '';
      const reportWrite = toolTexts[6] ?? '';
      run.checks[denied(configWrite) && !denied(reportWrite) ? 'pass' : 'fail']('write-surface', '写面执法（配置面拒/报告面放行）',
        `amagi.json 写入：${configWrite.slice(0, 120).replace(/\n/g, ' ')}；agent-outputs 写入：${reportWrite.slice(0, 120).replace(/\n/g, ' ')}`);
    } else {
      run.checks.notMeasured('write-surface', '写面执法（配置面拒/报告面放行）', 'W1 会话工具结果不足');
    }

    // G. 角色 skill 加载（子任务系统提示含 probe skill，且无用户目录技能）
    const w1System = systems.get('w1') ?? '';
    if (w1System) {
      const hasMarker = w1System.includes(SKILL_MARKER);
      const leakedUserSkill = ['agent-browser', 'lark-doc', 'codex-image-generation'].filter((name) => w1System.includes(name));
      run.checks[hasMarker && leakedUserSkill.length === 0 ? 'pass' : 'fail']('role-skill-load', '角色 skill 加载',
        hasMarker ? `子任务系统提示含构建 skill（marker 命中）；用户目录技能残留=${leakedUserSkill.length}` : '子任务系统提示未见构建 skill marker（--skill 注入未生效？）');
    } else {
      run.checks.notMeasured('role-skill-load', '角色 skill 加载', '无子任务系统提示观测');
    }

    // H. 同版本包（Leader -e 与子进程 settings.json 同指版本化安装）
    const settingsJson = JSON.parse(fs.readFileSync(path.join(binding.agentDir, 'settings.json'), 'utf-8')) as { packages?: Array<{ source?: string }> };
    const declaredRoot = settingsJson.packages?.[0]?.source ?? '';
    const childHasAmagiTools = childEntries.some((entry) => entry.tools.includes('amagi_resource'));
    run.checks[declaredRoot === install.packageRoot && childHasAmagiTools ? 'pass' : 'fail']('same-package', '同版本包加载',
      `settings.json 唯一包=${declaredRoot === install.packageRoot ? '与安装根一致' : declaredRoot}；子进程工具面含 amagi_resource=${childHasAmagiTools}（amagi-core 已随包加载）`);

    // I. 池并发上限（同池不重叠；跨池可并行）
    const intervalOf = (script: string): [number, number] | null => {
      const times = fixtureLog.filter((entry) => entry.script === script).map((entry) => Date.parse(entry.t)).filter((value) => Number.isFinite(value));
      if (times.length === 0) return null;
      return [Math.min(...times), Math.max(...times)];
    };
    const w1Interval = intervalOf('w1');
    const w2Interval = intervalOf('w2');
    const r1Interval = intervalOf('r1');
    if (w1Interval && w2Interval) {
      const overlap = w1Interval[0] < w2Interval[1] && w2Interval[0] < w1Interval[1];
      run.checks[!overlap ? 'pass' : 'fail']('pool-cap-writer', '写作池容量=1 并发执法',
        overlap ? '两个写作任务区间重叠（超出池容量）' : `w1=${new Date(w1Interval[0]).toISOString()}…${new Date(w1Interval[1]).toISOString()}；w2=${new Date(w2Interval[0]).toISOString()}…${new Date(w2Interval[1]).toISOString()}（串行）`);
    } else {
      run.checks.notMeasured('pool-cap-writer', '写作池容量=1 并发执法', '缺少 w1/w2 区间观测');
    }
    if (r1Interval && w1Interval) {
      const crossOverlap = r1Interval[0] < w1Interval[1] && w1Interval[0] < r1Interval[1];
      if (crossOverlap) run.checks.pass('pool-cross-parallel', '跨池并行（审查与写作重叠）', '审查任务与写作任务区间重叠（独立池并行）');
      else run.checks.notMeasured('pool-cross-parallel', '跨池并行（审查与写作重叠）', '未观测到跨池重叠（非违规，仅未覆盖）');
    } else {
      run.checks.notMeasured('pool-cross-parallel', '跨池并行（审查与写作重叠）', '缺少区间观测');
    }

    // J. 完成通知自触发轮
    run.checks[run.selfRounds >= 2 ? 'pass' : 'fail']('completion-self-round', '后台完成自触发新轮',
      `观测到 ${run.selfRounds} 个自触发轮（事件：${run.selfRoundEvents.length ? run.selfRoundEvents.slice(0, 4).join('；') : '无'}）`);

    // K. 续接父链（actor 账本 + 分配继承 + 新任务可写）
    const resumeActor = stack.actorStore.listActors().find((actor) => actor.parentTaskId !== null);
    if (resumeActor && w1Id) {
      const parentLinkOk = resumeActor.parentTaskId === w1Id;
      const inheritedAssignment = stack.actorStore.listAssignments().find((assignment) => assignment.ownerTaskId === resumeActor.nativeTaskId);
      const supersedesOk = Boolean(inheritedAssignment?.supersedes);
      let resumeSpecParentOk = false;
      if (resumeId) {
        const resumeSpecDir = path.join(v2StoreDir, resumeId);
        const resumeSpecFiles = fs.existsSync(resumeSpecDir) ? fs.readdirSync(resumeSpecDir).filter((name) => name.startsWith('spec-')) : [];
        if (resumeSpecFiles.length > 0) resumeSpecParentOk = fs.readFileSync(path.join(resumeSpecDir, resumeSpecFiles[0]), 'utf-8').includes(w1Id);
      }
      run.checks[parentLinkOk && supersedesOk && writeResume.includes(200) && resumeSpecParentOk ? 'pass' : 'fail']('resume-parent-chain', '续接父链与分配继承',
        `actor 父链=${parentLinkOk}（${resumeActor.parentTaskId?.slice(0, 8)}←W1）；继承分配（supersedes）=${supersedesOk}；v2-store 续接 spec 含父=${resumeSpecParentOk}；续接写入=${writeResume.join(',')}`);
    } else {
      run.checks.notMeasured('resume-parent-chain', '续接父链与分配继承', '未见续接任务（自触发轮未驱动 resume？）');
    }

    // L. 取消后账本一致性：代次轮换撤销全部身份（含续接链）
    {
      const notRevoked = stack.actorStore.listActors().filter((actor) => actor.status !== 'revoked');
      run.checks[notRevoked.length === 0 ? 'pass' : 'fail']('ledger-generation-revoke', '代次轮换撤销全部身份',
        `rotateGeneration(2) 后仍活跃身份=${notRevoked.length}（含全部 luban/diting/续接任务；旧代次写入已在 old-gen-write-rejected 验证）`);
    }

    // M. 静默收尾标记：fixture 声明
    run.checks.pass('fixture-disclaimer', 'fixture 模型声明', '模型为本地 OpenAI 兼容 fixture：仅驱动真实链路，不构成实际 LLM 质量/性能证据。');

    await cleanup();
    const summary = run.checks.summary();
    return writeReport(summary.fail > 0 ? 2 : 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.error || /缺少 --piCli|不存在|不是 amagi-pi|结构不完整|无法从 .* 解析 pi 版本|--real-model 需要/.test(message)) {
      run.checks.unavailable('probe-unavailable', '外部资源不可用（如实报告，不假通过）', `${message}`);
    } else {
      run.checks.fail('probe-aborted', 'probe 执行中断', `${message}（已收集证据见报告）`);
    }
    await cleanup();
    return writeReport(3);
  } finally {
    await cleanup();
  }
}

main().then((code) => { process.exit(code); }, (error) => {
  process.stderr.write(`[probe] 未捕获异常: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(3);
});
