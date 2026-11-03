/**
 * amagi 只读发现单测（amagi-discovery）：假 Pi SDK（list 契约 + resolve 抛错正控）
 * 验证候选/版本/path 如实区分、声明实体缺失不吞、settings 损坏显式透出、
 * SDK 不可用=unavailable（≠未安装）、官方全局 home 解析语义。
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  piSdkAvailable, preferredConfiguredAmagi, resolveAppPiAgentDir, resolveGlobalPiAgentDir, scanAmagiHome,
} from '../src/agent/build-runtime/amagi-discovery.js';
import { makeFakePiSdk } from './helpers/fake-pi-git-sdk.js';
import { piWorkbenchPackageRoot } from '../src/agent/agent-assets.js';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amagi-disc-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const HELPER_ROOT = piWorkbenchPackageRoot();

interface ScanInput {
  root: string;
  sdkRoot?: string;
  settings?: unknown;
  origin?: 'global-pi-home' | 'app-pi-home';
}

/** 组装一次扫描（settings 可为任意 JSON 或损坏字符串）。 */
function setupHome(input: ScanInput): { agentDir: string; sdkRoot: string } {
  const agentDir = path.join(input.root, 'home');
  fs.mkdirSync(agentDir, { recursive: true });
  if (input.settings !== undefined) {
    fs.writeFileSync(path.join(agentDir, 'settings.json'), typeof input.settings === 'string' ? input.settings : JSON.stringify(input.settings));
  }
  return { agentDir, sdkRoot: input.sdkRoot ?? makeFakePiSdk(input.root) };
}

function scan(root: string, agentDir: string, sdkRoot: string, pinnedVersion = '2.21.31') {
  return scanAmagiHome({
    nodePath: process.execPath,
    helperPackageRoot: HELPER_ROOT,
    piPackageRoot: sdkRoot,
    agentDir,
    origin: 'global-pi-home',
    pinnedVersion,
  });
}

/** 落一个本地 amagi-pi 实体目录。 */
function makeLocalPackage(root: string, name: string, version: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'amagi-pi', version }));
  return dir;
}

it('自动优选已安装的最高稳定版本；无实体声明、预发布版和旧版不参与', () => {
  const candidate = (version: string, sourceType: 'local' | 'git' | 'npm' = 'local', packagePath: string | null = `/pkg/${version}`) => ({
    origin: 'global-pi-home' as const, source: `/pkg/${version}`, sourceType,
    packagePath, version, matchesPin: false,
  });
  const selected = preferredConfiguredAmagi([
    candidate('2.21.36'), candidate('2.21.38-rc.1'), candidate('2.21.37', 'git'), candidate('2.21.39', 'npm', null), candidate('2.21.35'),
  ], '2.21.31');
  expect(selected?.version).toBe('2.21.37');
  expect(preferredConfiguredAmagi([candidate('2.21.30')], '2.21.31')).toBeNull();
  expect(preferredConfiguredAmagi([candidate('2.21.36', 'npm'), candidate('2.21.36', 'local')], '2.21.31')?.sourceType).toBe('local');
});

describe('scanAmagiHome（只读发现）', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('本地声明按 manifest 收录：2.21.36 ≠ pin 如实标记；2.21.31 → matchesPin', async () => {
    const pkg36 = makeLocalPackage(root, 'amagi-36', '2.21.36');
    const pkg31 = makeLocalPackage(root, 'amagi-31', '2.21.31');
    const { agentDir, sdkRoot } = setupHome({ root, settings: { packages: [pkg36, pkg31] } });
    const result = await scan(root, agentDir, sdkRoot);
    expect(result.status).toBe('ok');
    expect(result.candidates).toHaveLength(2);
    const c36 = result.candidates.find((item) => item.version === '2.21.36');
    expect(c36).toMatchObject({ origin: 'global-pi-home', source: pkg36, sourceType: 'local', packagePath: pkg36, version: '2.21.36', matchesPin: false });
    expect(result.candidates.find((item) => item.version === '2.21.31')?.matchesPin).toBe(true);
  });

  it('非 amagi-pi 的本地包不收录（manifest 名为准，防路径段误报）', async () => {
    const other = path.join(root, 'amagi-pi-like');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other-package', version: '1.0.0' }));
    const { agentDir, sdkRoot } = setupHome({ root, settings: { packages: [other] } });
    const result = await scan(root, agentDir, sdkRoot);
    expect(result.candidates).toEqual([]);
  });

  it('git/npm 声明按 source 文本收录；声明实体缺失 → packagePath=null 如实（不吞作未声明）', async () => {
    const gitSource = 'git:github.com/runrunrain/amagi-pi@929000ecbd8725e72b191493345d6abeef51c147';
    const { agentDir, sdkRoot } = setupHome({ root, settings: { packages: [gitSource, 'npm:amagi-pi@2.21.31'] } });
    const result = await scan(root, agentDir, sdkRoot);
    expect(result.candidates).toHaveLength(2);
    const git = result.candidates.find((item) => item.sourceType === 'git');
    expect(git).toMatchObject({ source: gitSource, sourceType: 'git', packagePath: null, version: null, matchesPin: false });
    const npm = result.candidates.find((item) => item.sourceType === 'npm');
    expect(npm).toMatchObject({ source: 'npm:amagi-pi@2.21.31', sourceType: 'npm', packagePath: null });
  });

  it('git 声明实体在 → 带 manifest 版本', async () => {
    const gitSource = 'git:github.com/runrunrain/amagi-pi@929000ecbd8725e72b191493345d6abeef51c147';
    const { agentDir, sdkRoot } = setupHome({ root, settings: { packages: [gitSource] } });
    const entity = path.join(agentDir, 'git', 'github.com', 'runrunrain', 'amagi-pi');
    fs.mkdirSync(entity, { recursive: true });
    fs.writeFileSync(path.join(entity, 'package.json'), JSON.stringify({ name: 'amagi-pi', version: '2.21.31' }));
    const result = await scan(root, agentDir, sdkRoot);
    expect(result.candidates[0]).toMatchObject({ sourceType: 'git', packagePath: entity, version: '2.21.31', matchesPin: true });
  });

  it('已安装的 Git/npm 新版可自动优选；未安装的更高声明不触发获取', async () => {
    const gitSource = 'git:github.com/runrunrain/amagi-pi@newer';
    const npmSource = 'npm:amagi-pi@2.21.37';
    const { agentDir, sdkRoot } = setupHome({ root, settings: { packages: [gitSource, npmSource, 'git:github.com/other/amagi-pi@future'] } });
    const gitEntity = path.join(agentDir, 'git', 'github.com', 'runrunrain', 'amagi-pi');
    const npmEntity = path.join(agentDir, 'npm', 'node_modules', 'amagi-pi');
    for (const [entity, version] of [[gitEntity, '2.21.36'], [npmEntity, '2.21.37']]) {
      fs.mkdirSync(entity, { recursive: true });
      fs.writeFileSync(path.join(entity, 'package.json'), JSON.stringify({ name: 'amagi-pi', version }));
    }
    const result = await scan(root, agentDir, sdkRoot);
    expect(result.status).toBe('ok');
    expect(result.candidates).toHaveLength(3);
    expect(preferredConfiguredAmagi(result.candidates, '2.21.31')).toMatchObject({ sourceType: 'npm', packagePath: npmEntity, version: '2.21.37' });
    expect(result.candidates.find((item) => item.source.includes('future'))?.packagePath).toBeNull();
  });

  it('settings.json 损坏 → settingsErrors 显式透出（不静默当未声明）', async () => {
    const { agentDir, sdkRoot } = setupHome({ root, settings: '{broken json' });
    const result = await scan(root, agentDir, sdkRoot);
    expect(result.status).toBe('ok'); // 扫描本身完成；损坏经由 settingsErrors 表达
    expect(result.settingsErrors.length).toBeGreaterThan(0);
    expect(result.settingsErrors[0].scope).toBe('global');
    expect(result.settingsErrors[0].message).toBeTruthy();
    expect(result.candidates).toEqual([]);
  });

  it('SDK 不可用（包根缺失/无 package-manager）→ unavailable（≠未安装，不谎报）', async () => {
    const { agentDir } = setupHome({ root, settings: {} });
    const result = await scanAmagiHome({
      nodePath: process.execPath, helperPackageRoot: HELPER_ROOT,
      piPackageRoot: path.join(root, 'no-such-sdk'), agentDir,
      origin: 'app-pi-home', pinnedVersion: '2.21.31',
    });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('不可用');
    expect(result.candidates).toEqual([]);
  });

  it('只读正控：list 模式绝不触发 resolve（假 SDK resolve 一旦被调用即失败）', async () => {
    const pkg36 = makeLocalPackage(root, 'amagi-36', '2.21.36');
    const { agentDir, sdkRoot } = setupHome({ root, settings: { packages: [pkg36] } });
    const result = await scan(root, agentDir, sdkRoot);
    // 若实现误调 resolve()，假 SDK 会抛 RESOLVE_MUST_NOT_RUN_IN_LIST_MODE → status=error
    expect(result.status).toBe('ok');
    expect(result.candidates).toHaveLength(1);
  });

  it('helper 崩溃（SDK 导入失败）→ error 状态带详情', async () => {
    const brokenSdk = path.join(root, 'broken-sdk', 'dist', 'core');
    fs.mkdirSync(brokenSdk, { recursive: true });
    fs.writeFileSync(path.join(brokenSdk, 'settings-manager.js'), 'throw new Error("boom");');
    fs.writeFileSync(path.join(brokenSdk, 'package-manager.js'), 'throw new Error("boom");');
    const { agentDir } = setupHome({ root, settings: {} });
    const result = await scanAmagiHome({
      nodePath: process.execPath, helperPackageRoot: HELPER_ROOT,
      piPackageRoot: path.join(root, 'broken-sdk'), agentDir,
      origin: 'global-pi-home', pinnedVersion: '2.21.31',
    });
    expect(result.status).toBe('error');
    expect(result.detail).toBeTruthy();
  });
});

describe('home 解析与 SDK 可用性', () => {
  it('resolveGlobalPiAgentDir：PI_CODING_AGENT_DIR 覆盖优先，缺省 ~/.pi/agent（官方语义）', () => {
    expect(resolveGlobalPiAgentDir({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.pi', 'agent'));
    expect(resolveGlobalPiAgentDir({ PI_CODING_AGENT_DIR: '/x/y' } as NodeJS.ProcessEnv)).toBe('/x/y');
    expect(resolveGlobalPiAgentDir({ PI_CODING_AGENT_DIR: '~' })).toBe(os.homedir());
    expect(resolveGlobalPiAgentDir({ PI_CODING_AGENT_DIR: '~/.pi/agent' })).toBe(path.join(os.homedir(), '.pi', 'agent'));
  });

  it('resolveAppPiAgentDir：dataRoot/agent/pi-home', () => {
    expect(resolveAppPiAgentDir('/data')).toBe(path.join('/data', 'agent', 'pi-home'));
  });

  it('piSdkAvailable：需要 node 与 dist/core/package-manager.js 同时在', () => {
    const sdk = makeFakePiSdk(tmpRoot());
    expect(piSdkAvailable(sdk, process.execPath)).toBe(true);
    expect(piSdkAvailable(path.join(sdk, 'missing'), process.execPath)).toBe(false);
    expect(piSdkAvailable(sdk, path.join(sdk, 'no-node'))).toBe(false);
    expect(piSdkAvailable(null, process.execPath)).toBe(false);
  });
});
