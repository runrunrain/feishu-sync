/**
 * probe-support.ts — 构建 v2 真实运行能力 probe 的共享支撑（测试夹具，非生产代码）
 *
 * 设计来源：设计v2 §13.1/§13.2 与 workflow P3 任务书。职责：
 * - 临时环境（FEISHU_SYNC_HOME / HOME / PI_CODING_AGENT_DIR 全部临时化）；
 * - 日志脱敏（密钥值、Bearer、token 字段统一 [redacted]）；
 * - 进程面扫描（ps：pi 子进程 / MCP 桥接进程的启动与残留核对）；
 * - 检查项收集与 Markdown 报告落盘。
 *
 * 本文件只被 server/scripts/probe-build-runtime.ts 与
 * server/tests/build-runtime-live-probe.test.ts 消费；不进生产链路。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 检查项 ───────────────────────────────────────────────────────────────

export type ProbeCheckState = 'pass' | 'fail' | 'unavailable' | 'not-measured';

export interface ProbeCheck {
  id: string;
  title: string;
  state: ProbeCheckState;
  detail: string;
  /** 证据来源描述（文件路径 / 观测通道），供报告回溯。 */
  evidence?: string;
}

export class CheckCollector {
  readonly checks: ProbeCheck[] = [];

  add(check: ProbeCheck): void {
    this.checks.push(check);
  }

  pass(id: string, title: string, detail: string, evidence?: string): void {
    this.add({ id, title, state: 'pass', detail, evidence });
  }

  fail(id: string, title: string, detail: string, evidence?: string): void {
    this.add({ id, title, state: 'fail', detail, evidence });
  }

  unavailable(id: string, title: string, detail: string, evidence?: string): void {
    this.add({ id, title, state: 'unavailable', detail, evidence });
  }

  notMeasured(id: string, title: string, detail: string, evidence?: string): void {
    this.add({ id, title, state: 'not-measured', detail, evidence });
  }

  summary(): { pass: number; fail: number; unavailable: number; notMeasured: number } {
    const acc = { pass: 0, fail: 0, unavailable: 0, notMeasured: 0 };
    for (const check of this.checks) {
      if (check.state === 'not-measured') acc.notMeasured += 1;
      else acc[check.state] += 1;
    }
    return acc;
  }
}

// ── 脱敏 ─────────────────────────────────────────────────────────────────

/** 报告与日志脱敏：已知密钥值、Bearer、常见凭据字段一律替换。 */
export function redact(text: string, extraSecrets: Array<string | undefined> = []): string {
  let safe = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) safe = safe.split(secret).join('[redacted]');
  }
  safe = safe.replace(/\bBearer\s+[^\s"',}\]]+/gi, 'Bearer [redacted]');
  safe = safe.replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|password|authorization|run[_-]?token)"\s*:\s*")[^"]{4,}(")/gi, '$1[redacted]$2');
  safe = safe.replace(/(ZHIPU_API_KEY=)[^\s"']+/g, '$1[redacted]');
  return safe;
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ── 临时环境 ─────────────────────────────────────────────────────────────

export interface ProbeTempEnv {
  root: string;
  /** FEISHU_SYNC_HOME（应用数据根，全临时）。 */
  feishuHome: string;
  /** 子进程 HOME（隔离 ~/.pi、~/.agents、~/.feishu-sync）。 */
  userHome: string;
  /** 原始库夹具根（短来源夹具 + 敏感 sentinel）。 */
  rawRoot: string;
  /** 标准库输出根（空）。 */
  outputRoot: string;
  /** 构建 skill 夹具目录（含 SKILL.md）。 */
  skillDir: string;
  /** 敏感 sentinel 文件（P0：真实子进程 read/grep 必须被拒）。 */
  sentinelFile: string;
  /** F12-R1：raw 禁区的祖先目录（搜索根不落 deny 的递归泄漏反例搜索根）。 */
  ancestorDir: string;
  /** F12-R1：指向祖先目录的 symlink 别名（自身不在 deny——别名形态递归反例）。 */
  aliasDir: string;
  /** F12-R1 二段：白名单外合成文件（任意系统路径反例；不读真凭据）。 */
  outsideFile: string;
  /** 候选区 staging 根。 */
  stagingRoot: string;
  /** 证据输出目录。 */
  evidenceDir: string;
}

export function createProbeTempEnv(fresh: boolean): ProbeTempEnv {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `fs-build-probe-${fresh ? Date.now().toString(36) : 'x'}-`)));
  const env: ProbeTempEnv = {
    root,
    feishuHome: path.join(root, 'feishu-home'),
    userHome: path.join(root, 'user-home'),
    rawRoot: path.join(root, 'fixtures', 'raw'),
    outputRoot: path.join(root, 'fixtures', 'standard-kb'),
    skillDir: path.join(root, 'fixtures', 'skill', 'kb-build'),
    sentinelFile: '',
    ancestorDir: path.join(root, 'fixtures'),
    aliasDir: path.join(root, 'raw-alias'),
    outsideFile: '',
    stagingRoot: path.join(root, 'staging'),
    evidenceDir: path.join(root, 'evidence'),
  };
  for (const dir of [env.feishuHome, env.userHome, env.rawRoot, env.outputRoot, env.skillDir, env.stagingRoot, env.evidenceDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // 敏感 sentinel：放在原始库根下的敏感目录（属于构建禁读禁写区）
  const sentinelDir = path.join(env.rawRoot, 'sentinel');
  fs.mkdirSync(sentinelDir, { recursive: true });
  env.sentinelFile = path.join(sentinelDir, 'secret-token.md');
  fs.writeFileSync(env.sentinelFile, [
    '# 内部凭据（probe sentinel）',
    '',
    'SENTINEL-SECRET-e19d0f4a：这行内容绝不允许出现在任何子任务输出或报告里。',
    '',
  ].join('\n'), { mode: 0o600 });
  // F12-R1：symlink 别名指向 raw 祖先目录（别名自身不在任何 deny 内；无递归工具面时
  // grep/find/ls 经别名同样到不了执行层）
  fs.symlinkSync(env.ancestorDir, env.aliasDir, 'dir');
  // F12-R1 二段：白名单外合成文件（不在 deny 也不在信封白名单——黑名单不枚举的任意路径形态）
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  env.outsideFile = path.join(outsideDir, 'synthetic-secret.md');
  fs.writeFileSync(env.outsideFile, [
    '# 合成外部文件（probe）',
    '',
    'SYNTHETIC-OUTSIDE-PROBE：这行内容绝不允许出现在任何子任务输出里（read 根约束反例）。',
    '',
  ].join('\n'), { mode: 0o600 });
  return env;
}

/** 短来源夹具：两个极简 docx 源（进快照，供 raw_list/raw_read/kb_write_doc sources 引用）。 */
export function writeSourceFixtures(rawRoot: string): Array<{ objToken: string; relPath: string; title: string }> {
  const sources = [
    { objToken: 'tok_probe_w1', relPath: 'probe/alpha-guide.md', title: 'Alpha 指南', body: ['# Alpha 指南', '', 'Alpha 系统有三条规则：', '- A1：入口在北方。', '- A2：每轮刷新两个补给点。', '- A3：雨天视野减半。', ''].join('\n') },
    { objToken: 'tok_probe_w2', relPath: 'probe/beta-notes.md', title: 'Beta 笔记', body: ['# Beta 笔记', '', 'Beta 系统与 Alpha 共享地图：', '- B1：Beta 出口即 Alpha 入口。', '- B2：夜间 Beta 关闭。', ''].join('\n') },
  ];
  for (const source of sources) {
    const file = path.join(rawRoot, source.relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source.body, { mode: 0o644 });
  }
  return sources.map(({ objToken, relPath, title }) => ({ objToken, relPath, title }));
}

/** 构建 skill 夹具（写入临时目录；marker 供子任务系统提示断言）。 */
export function writeSkillFixture(skillDir: string, marker: string): string {
  const content = [
    '---',
    'name: kb-build',
    `description: 构建 probe 技能（${marker}）。按任务书完成知识写作与审查。`,
    '---',
    '',
    '# 知识构建 skill（probe 夹具）',
    '',
    `- 技能指纹：${marker}`,
    '- 写作子任务经 mcp_call 调用桥接工具读写知识库；本地只写 agent-outputs/。',
    '- 严禁读取任何 sentinel/secret 文件。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, { mode: 0o644 });
  return content;
}

// ── 进程面扫描 ───────────────────────────────────────────────────────────

export interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** ps 快照（失败返回空并如实标注；不猜测进程状态）。 */
export async function snapshotProcesses(): Promise<{ entries: ProcessSnapshotEntry[]; ok: boolean; error?: string }> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn('ps', ['axo', 'pid,ppid,pgid,command'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf-8'); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf-8'); });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`ps 退出码 ${code}: ${err.slice(0, 200)}`))));
    });
    const entries: ProcessSnapshotEntry[] = [];
    for (const line of result.split('\n').slice(1)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      entries.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] });
    }
    return { entries, ok: true };
  } catch (error) {
    return { entries: [], ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 与本 probe 相关的进程（Leader=pi --mode rpc、子任务=pi --mode json、
 * 桥接=node <bridgeScript>）。匹配只认命令行特征，不猜 pid 复用。
 */
export function probeRelatedProcesses(
  snapshot: { entries: ProcessSnapshotEntry[] },
  signatures: string[],
): ProcessSnapshotEntry[] {
  return snapshot.entries.filter((entry) => signatures.some((sig) => entry.command.includes(sig)));
}

// ── 报告 ─────────────────────────────────────────────────────────────────

export interface ProbeReportMeta {
  startedAt: string;
  finishedAt: string;
  mode: 'fixture-model' | 'real-model';
  piCliPath: string;
  piVersion: string;
  sourceAmagiDir: string;
  amagiVersion: string;
  tempRoot: string | null;
}

export function renderProbeReport(meta: ProbeReportMeta, checks: ProbeCheck[], notes: string[]): string {
  const summary = (() => {
    const acc = { pass: 0, fail: 0, unavailable: 0, 'not-measured': 0 } as Record<ProbeCheckState, number>;
    for (const check of checks) acc[check.state] += 1;
    return acc;
  })();
  const lines: string[] = [];
  lines.push('# 构建 v2 独立可重跑真实运行能力 probe 报告', '');
  lines.push('> 生成：`server/scripts/probe-build-runtime.ts`（测试/证据切片，不改生产基建）。');
  lines.push('> 真实链路：真实 pi + 真实 amagi（版本化安装）+ 真实子任务 MCP 桥；模型为本地 OpenAI 兼容 fixture'
    + (meta.mode === 'real-model' ? '（本轮为 --real-model 模式）' : '——**明确不是实际 LLM 质量/性能证据**，仅用于驱动真实 Leader 派发与工具链路。'), '');
  lines.push('## 环境', '');
  lines.push(`- 时间：${meta.startedAt} → ${meta.finishedAt}`);
  lines.push(`- pi：\`${meta.piCliPath}\`（${meta.piVersion}）`);
  lines.push(`- amagi-pi 源：\`${meta.sourceAmagiDir}\`（${meta.amagiVersion}，经 installAmagiPackage source 模式版本化物化）`);
  lines.push(`- 临时根：${meta.tempRoot ?? '（未创建）'}（FEISHU_SYNC_HOME / HOME / PI_CODING_AGENT_DIR 全临时；未读生产资料）`);
  lines.push(`- 结果：**pass ${summary.pass} / fail ${summary.fail} / unavailable ${summary.unavailable} / not-measured ${summary['not-measured']}**`, '');
  lines.push('## 检查项', '');
  lines.push('| ID | 检查 | 状态 | 结论与证据 |', '|---|---|---|---|');
  for (const check of checks) {
    const detail = redact(check.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const evidence = check.evidence ? redact(check.evidence).replace(/\|/g, '\\|').replace(/\n/g, ' ') : '';
    lines.push(`| ${check.id} | ${check.title} | **${check.state}** | ${detail}${evidence ? `（证据：${evidence}）` : ''} |`);
  }
  if (notes.length > 0) {
    lines.push('', '## 备注', '');
    for (const note of notes) lines.push(`- ${redact(note)}`);
  }
  lines.push('', '## 复跑', '');
  lines.push('```bash');
  lines.push('npx tsx scripts/probe-build-runtime.ts --piCli <pi 绝对路径> --sourceAmagi <amagi-pi 包根目录>');
  lines.push('# 可选：--real-model（显式真实模型模式，需 ZHIPU_API_KEY 环境；不打印密钥）、--keep、--report <路径>');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}
