/**
 * 能力探测测试（设计v2 §13.1）
 *
 * 断言诚实性原则：静态检查核对事实；实测项一律 not-measured（不假通过）；
 * 静态 fail → assertProbeUsable 明确拒绝（不静默 fallback）。
 * amagi 包 fixture 手工落盘（非真实 pi 安装），与真实安装链路的差异在
 * build-runtime-package.test.ts 的假 CLI fixture 中另行覆盖。
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BuildRuntimeProbeError, MEASURED_PROBE_RUNBOOK, assertProbeUsable, piVersionInRange,
  runStaticProbes,
} from '../src/agent/build-runtime/capability-probe.js';
import { computePackageContentHash, INSTALL_RECORD_FILENAME } from '../src/agent/build-runtime/amagi-package.js';
import {
  computeAgentDirConfigHash, planBuildDirectories, renderAgentDirConfigFiles,
  writeAgentDirConfig,
} from '../src/agent/build-runtime/agent-dir-config.js';
import { makeSpec } from './build-runtime-contracts.test.js';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-probe-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

/** 手工落盘一个「已安装」的 amagi-pi 版本化目录（带正确记录与哈希）。 */
function installFixture(root: string, version = '2.21.31'): { packageRoot: string; contentHash: string } {
  const installDir = path.join(root, 'agent', 'runtime-packages', `amagi-pi@${version}`);
  const packageRoot = path.join(installDir, 'npm', 'node_modules', 'amagi-pi');
  fs.mkdirSync(path.join(packageRoot, 'extensions', 'amagi-core'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'amagi-pi', version, pi: { extensions: ['./extensions'] } }, null, 2));
  fs.writeFileSync(path.join(packageRoot, 'extensions', 'amagi-core', 'index.ts'), '// fixture\n');
  for (const agent of ['luban', 'diting', 'baize']) {
    fs.writeFileSync(path.join(packageRoot, 'agents', `${agent}.md`), '---\ndescription: f\ntype: work\ntools: read\n---\n');
  }
  const { contentHash } = computePackageContentHash(packageRoot);
  fs.writeFileSync(path.join(installDir, INSTALL_RECORD_FILENAME), JSON.stringify({
    schemaVersion: 1, package: 'amagi-pi', version, installedAt: new Date().toISOString(),
    installedVia: { nodePath: '/n', piCliPath: '/p' }, contentHash, hashedFiles: 5, hashedBytes: 100,
  }));
  return { packageRoot, contentHash };
}

const BRIDGE = { bridgeCommand: '/usr/local/bin/node', bridgeArgs: ['/app/bridge.cjs'] };

function probeInput(root: string, over: Partial<Parameters<typeof runStaticProbes>[0]> = {}) {
  return {
    dataRoot: root,
    amagiVersion: '2.21.31',
    knowledgeBaseRoot: path.join(root, 'raw-lib'),
    outputRoot: path.join(root, 'std-kb'),
    hasZhipuApiKey: true,
    piVersion: '1.4.0',
    ...over,
  };
}

describe('runStaticProbes', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('就绪组合：静态项全 pass，实测项全 not-measured，fullyVerified 恒 false', () => {
    const fixture = installFixture(root);
    const spec = makeSpec();
    spec.amagiPackage = { version: '2.21.31', installDir: path.dirname(path.dirname(fixture.packageRoot)), packageRoot: fixture.packageRoot, contentHash: fixture.contentHash };
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    writeAgentDirConfig(spec, dirs, BRIDGE);
    const report = runStaticProbes(probeInput(root, { spec, agentDir: dirs.homeDir }));
    const staticChecks = report.checks.filter((c) => c.kind === 'static');
    expect(staticChecks.map((c) => `${c.id}:${c.state}`)).toEqual(expect.arrayContaining([
      'pi-version:pass', 'amagi-package:pass', 'amagi-package-hash:pass',
      'model-key-mapping:pass', 'model-key-present:pass', 'spec-valid:pass',
      'thinking-level-map:pass', 'forbidden-roots:warn', 'agent-dir-config:pass', 'workdir-clean:pass',
    ]));
    expect(report.staticOk).toBe(true);
    expect(report.fullyVerified).toBe(false);
    const measured = report.checks.filter((c) => c.kind === 'measured');
    expect(measured).toHaveLength(MEASURED_PROBE_RUNBOOK.length);
    expect(measured.every((c) => c.state === 'not-measured')).toBe(true);
    expect(assertProbeUsable(report)).toBeUndefined();
  });

  it('pi 版本越界 → fail + 拒绝启用', () => {
    installFixture(root);
    const report = runStaticProbes(probeInput(root, { piVersion: '2.0.0' }));
    expect(report.staticOk).toBe(false);
    expect(() => assertProbeUsable(report)).toThrow(BuildRuntimeProbeError);
  });

  it('包未安装 → amagi-package fail（提示指向设置卡默认 Git 安装/本地目录，不再指向已知 404 的 npm）', () => {
    const report = runStaticProbes(probeInput(root));
    const check = report.checks.find((c) => c.id === 'amagi-package')!;
    expect(check.state).toBe('fail');
    expect(check.detail).toContain('构建编排');
    expect(check.detail).toContain('官方 Git');
    expect(check.detail).not.toContain('npm:amagi-pi');
    expect(() => assertProbeUsable(report)).toThrow('拒绝启用');
  });

  it('包被原地篡改 → hash fail（不默认可信）', () => {
    const fixture = installFixture(root);
    fs.appendFileSync(path.join(fixture.packageRoot, 'extensions', 'amagi-core', 'index.ts'), '// drift\n');
    const report = runStaticProbes(probeInput(root));
    expect(report.checks.find((c) => c.id === 'amagi-package-hash')!.state).toBe('fail');
    expect(report.staticOk).toBe(false);
  });

  it('密钥不可用 → fail（不假通过）', () => {
    installFixture(root);
    const report = runStaticProbes(probeInput(root, { hasZhipuApiKey: false }));
    expect(report.checks.find((c) => c.id === 'model-key-present')!.state).toBe('fail');
  });

  it('agentDir 配置被篡改 → fail 并指出差异', () => {
    const fixture = installFixture(root);
    const spec = makeSpec();
    spec.amagiPackage = { version: '2.21.31', installDir: root, packageRoot: fixture.packageRoot, contentHash: fixture.contentHash };
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    writeAgentDirConfig(spec, dirs, BRIDGE);
    // 篡改：mcp.json 移除 autoEnableCodemode
    const mcpPath = path.join(dirs.homeDir, 'mcp.json');
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    delete mcp.autoEnableCodemode;
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));
    const report = runStaticProbes(probeInput(root, { spec, agentDir: dirs.homeDir }));
    const configCheck = report.checks.find((c) => c.id === 'agent-dir-config')!;
    expect(configCheck.state).toBe('fail');
    expect(configCheck.detail).toContain('autoEnableCodemode');
  });

  it('工作目录混入 amagi.json → workdir-clean fail', () => {
    const fixture = installFixture(root);
    const spec = makeSpec();
    spec.amagiPackage = { version: '2.21.31', installDir: root, packageRoot: fixture.packageRoot, contentHash: fixture.contentHash };
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    writeAgentDirConfig(spec, dirs, BRIDGE);
    fs.writeFileSync(path.join(dirs.workDir, 'amagi.json'), '{}');
    const report = runStaticProbes(probeInput(root, { spec, agentDir: dirs.homeDir }));
    expect(report.checks.find((c) => c.id === 'workdir-clean')!.state).toBe('fail');
  });

  it('spec 非法 → spec-valid fail 且列出问题', () => {
    installFixture(root);
    const spec = makeSpec({ buildId: 'kb_bad' });
    const report = runStaticProbes(probeInput(root, { spec }));
    const check = report.checks.find((c) => c.id === 'spec-valid')!;
    expect(check.state).toBe('fail');
    expect(check.detail).toContain('buildId');
  });
});

describe('piVersionInRange', () => {
  it('1.4.x 支持、2.x 不支持、1.3 不支持', () => {
    expect(piVersionInRange('1.4.0')).toBe(true);
    expect(piVersionInRange('1.9.2')).toBe(true);
    expect(piVersionInRange('2.0.0')).toBe(false);
    expect(piVersionInRange('1.3.9')).toBe(false);
  });
});
