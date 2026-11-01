/**
 * build-runtime-live-probe.test.ts — 设计v2 §13.1 独立可重跑真实运行能力 probe 的测试面
 *
 * 两个层级：
 * 1. 纯本地单元（始终运行）：probe 支撑模块的脱敏/临时环境/skill 夹具行为；
 * 2. live probe（需外部资源）：真实 pi + 真实 amagi 源目录。资源缺失时
 *    【显式 skip 并说明 unavailable】，绝不假通过；资源存在时以子进程运行
 *    server/scripts/probe-build-runtime.ts 并核对退出码与报告检查项。
 *
 * 外部资源解析顺序（不写死个人开发仓路径）：
 *   piCli      ：环境变量 PI_PROBE_PI_CLI → PATH 中的 pi
 *   sourceAmagi：环境变量 PI_PROBE_SOURCE_AMAGI
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { CheckCollector, createProbeTempEnv, redact, writeSkillFixture, writeSourceFixtures } from './fixtures/build-runtime/probe-support.js';

const runExecFile = promisify(execFile);
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(SERVER_ROOT, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface LiveResources { piCli: string; sourceAmagi: string }

async function resolveLiveResources(): Promise<LiveResources | null> {
  const sourceAmagi = process.env.PI_PROBE_SOURCE_AMAGI ?? '';
  if (!sourceAmagi || !existsSync(path.join(sourceAmagi, 'package.json'))) return null;
  let piCli = process.env.PI_PROBE_PI_CLI ?? '';
  if (!piCli) {
    try {
      piCli = (await runExecFile('which', ['pi'])).stdout.trim();
    } catch {
      return null;
    }
  }
  if (!piCli || !existsSync(piCli)) return null;
  return { piCli, sourceAmagi };
}

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 保留供人工核查 */ }
  }
});

describe('probe 支撑模块（纯本地）', () => {
  it('redact 覆盖密钥值、Bearer 与常见凭据字段', () => {
    const out = redact('ZHIPU_API_KEY=abc123def "token":"xyzsecret99" Bearer sk-1234567890', ['abc123def']);
    expect(out).not.toContain('abc123def');
    expect(out).not.toContain('xyzsecret99');
    expect(out).not.toContain('sk-1234567890');
    expect(out).toContain('[redacted]');
  });

  it('临时环境创建短来源与 sentinel；skill 夹具含唯一 marker', () => {
    const env = createProbeTempEnv(true);
    tmpRoots.push(env.root);
    const sources = writeSourceFixtures(env.rawRoot);
    expect(sources).toHaveLength(2);
    expect(existsSync(env.sentinelFile)).toBe(true);
    const content = writeSkillFixture(env.skillDir, 'PROBE-SKILL-TEST-1');
    expect(content).toContain('PROBE-SKILL-TEST-1');
    expect(existsSync(path.join(env.skillDir, 'SKILL.md'))).toBe(true);
  });

  it('CheckCollector 汇总四种状态', () => {
    const collector = new CheckCollector();
    collector.pass('a', 'A', '');
    collector.fail('b', 'B', '');
    collector.unavailable('c', 'C', '');
    collector.notMeasured('d', 'D', '');
    expect(collector.summary()).toEqual({ pass: 1, fail: 1, unavailable: 1, notMeasured: 1 });
  });
});

describe('build-runtime live probe（真实 pi + 真实 amagi）', () => {
  // 外部资源缺失（无 PI_PROBE_SOURCE_AMAGI）→ 显式 skip；资源存在但不可用时用例内如实报 unavailable，不假通过。
  it.skipIf(!process.env.PI_PROBE_SOURCE_AMAGI)('运行 probe 脚本并核对报告', async () => {
    const resources = await resolveLiveResources();
    if (!resources) {
      throw new Error('外部资源 unavailable：需要 PI_PROBE_SOURCE_AMAGI（amagi-pi 包根）与 PI_PROBE_PI_CLI 或 PATH 中的 pi。live probe 显式跳过，不假通过。');
    }
    const reportDir = mkdtempSync(path.join(os.tmpdir(), 'build-live-probe-test-'));
    tmpRoots.push(reportDir);
    const reportPath = path.join(reportDir, 'live-probe-report.md');
    const child = spawn(process.execPath, [
      tsxCli,
      path.join(SERVER_ROOT, 'scripts', 'probe-build-runtime.ts'),
      '--piCli', resources.piCli,
      '--sourceAmagi', resources.sourceAmagi,
      '--report', reportPath,
      '--timeoutSec', '420',
    ], { cwd: SERVER_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    void stdout; // 保留采集供断言失败时扩展诊断（当前只核 stderr 尾部）
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('probe 超时（10 分钟）被终止'));
      }, 10 * 60_000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1); });
    });
    if (exitCode !== 0) {
      throw new Error(`probe 退出码 ${exitCode}（要求0=全过；已知失败也不能替代合规）\n--- stderr 尾部 ---\n${stderr.slice(-4000)}`);
    }
    const report = readFileSync(reportPath, 'utf-8');
    // 关键能力项必须为 pass（运行能力证据，不因 fixture 模型打折）
    const mustPass = ['preflight', 'package-install', 'leader-start', 'leader-round1', 'guard-freeze-scope', 'guard-block-illegal', 'identity-uplink', 'mcp-precise-authz', 'p0-sentinel-deny', 'write-surface', 'cancel-no-residue', 'same-package', 'completion-self-round', 'resume-parent-chain', 'role-skill-load', 'pool-cap-writer'];
    const problems: string[] = [];
    for (const line of report.split('\n')) {
      const match = /^\| ([a-z0-9:-]+) \|.*\| \*\*(fail|unavailable)\*\* \|/.exec(line);
      if (!match) continue;
      problems.push(line.slice(0, 220));
    }
    for (const id of [...mustPass, 'child-tools-surface', 'codemode-facet', 'leader-system-rules']) {
      const row = report.split('\n').find((line) => line.startsWith(`| ${id} |`));
      if (!row) problems.push(`${id}（缺行）`);
      else if (!row.includes('**pass**')) problems.push(row.slice(0, 200));
    }
    expect(problems, `报告存在未预期失败/缺项：\n${problems.join('\n')}\n--- 完整报告 ---\n${report.slice(0, 4000)}`).toEqual([]);
    expect(report).toContain('fixture');
  }, 10 * 60_000);
});
