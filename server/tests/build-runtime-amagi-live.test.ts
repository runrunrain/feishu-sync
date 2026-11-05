/**
 * amagi Git 官方获取链真机测试（plugin-install-fix 必验项）：
 * 真实网络 git clone（github.com/runrunrain/amagi-pi 固定 commit）+ 正式 Pi CLI
 * + 真实 Pi SDK 解析 → source 冻结 → 正式 pi local install 登记 → 状态已装 →
 * 重复安装=完整校验复用。临时 FEISHU_SYNC_HOME/dataRoot 隔离，不加载任务、
 * 不访问生产资料；找不到真实 Node/Pi 运行时时跳过（CI 无运行环境不硬跑）。
 */

import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildRuntimeHost } from '../src/kb/build-runtime-host.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import {
  AMAGI_PI_GIT_COMMIT, INSTALL_RECORD_FILENAME,
} from '../src/agent/build-runtime/amagi-package.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amagi-git-live-'));
const previousPiHome = process.env.PI_CODING_AGENT_DIR;
process.env.FEISHU_SYNC_HOME = root; // 隔离：任何 resolveDataRoot 缺省都指回临时根
process.env.PI_CODING_AGENT_DIR = path.join(root, 'isolated-pi-home');
afterAll(() => {
  delete process.env.FEISHU_SYNC_HOME;
  if (previousPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiHome;
  fs.rmSync(root, { recursive: true, force: true });
});

it('真实 Git 获取→冻结安装→状态已装→重复完整校验（官方 commit 固定 2.21.31）', async (ctx) => {
  const manager = new ConfigManager(path.join(root, 'config.json'));
  await manager.load();
  const resolver = new PiRuntimeResolver();
  const runtime = await resolver.resolveRuntime(manager.getConfig()!.agent);
  if (!runtime.nodePath || !runtime.piCliPath || !runtime.piPackageRoot) {
    ctx.skip(); // 无真实 Pi 运行时环境（不硬跑、不 mock 冒充）
    return;
  }
  const host = new BuildRuntimeHost({
    bundledAmagi: () => null, // Explicit Git installation acceptance, independent of the shipped offline bundle.
    dataRoot: root,
    resolver,
    toolService: null as never, // 本用例只触达 install/status 路径，不消费
    pool: null as never,
    configProvider: () => manager.getConfig(),
    internalBaseUrl: () => '',
    knowledgeBaseRoot: () => '',
    outputRoot: () => '',
  });

  // 1) 默认安装：真实 pi git install（网络 clone 固定 commit）→ 冻结 → local 登记
  const logs: string[] = [];
  const installed = await host.installAmagi({ log: (line) => logs.push(line) });
  expect(installed.version).toBe('2.21.31');
  expect(installed.fresh).toBe(true);
  expect(logs.some((line) => line.includes('git:github.com/runrunrain/amagi-pi@929000ecbd8725e72b191493345d6abeef51c147'))).toBe(true);
  const record = installed.record as {
    layout: string; dependenciesIncluded: boolean;
    acquisition?: { commit: string; acquiredPackageRoot: string; gitSource: string };
    contentHash: string; hashedFiles: number; hashedBytes: number;
  };
  expect(record.layout).toBe('source');
  expect(record.dependenciesIncluded).toBe(true);
  expect(record.acquisition?.commit).toBe(AMAGI_PI_GIT_COMMIT);
  // 获取实体在临时获取 root 内（约束成立），且最终已清理
  expect(record.acquisition?.acquiredPackageRoot).toContain('.acquire-');
  const acquireResidue = fs.readdirSync(path.join(root, 'agent', 'runtime-packages')).filter((name) => name.startsWith('.acquire-'));
  expect(acquireResidue).toEqual([]);
  // 依赖冻结 + 关键运行资源在（amagi 扩展/LSP bin；转发 shim 让目标在原位置执行）
  const packageRoot = installed.packageRoot;
  expect(fs.existsSync(path.join(packageRoot, 'extensions', 'amagi-core'))).toBe(true);
  expect(fs.existsSync(path.join(packageRoot, 'agents', 'luban.md'))).toBe(true);
  const lspBin = path.join(packageRoot, 'node_modules', '.bin', 'typescript-language-server');
  expect(fs.existsSync(lspBin)).toBe(true);
  expect(fs.lstatSync(lspBin).isSymbolicLink()).toBe(false);
  // 真实执行：官方 31 冻结包的 LSP CLI 必须能跑通（相对 package.json 定位不漂移）。
  // 前一版字节拷贝实测 ENOENT exit 1（Leader 真机 + /tmp 复现）；转发 shim 后应为 6.0.0。
  const { execFileSync } = await import('node:child_process');
  const versionOut = execFileSync(lspBin, ['--version'], { encoding: 'utf-8', timeout: 60_000 }).trim();
  expect(versionOut).toBe('6.0.0');
  expect(record.hashedFiles).toBeGreaterThan(1000); // 真实包（含依赖）量级锚点
  expect(record.hashedBytes).toBeGreaterThan(10 * 1024 * 1024);
  // 记录不落密钥
  const recordText = fs.readFileSync(path.join(root, 'agent', 'runtime-packages', 'amagi-pi@2.21.31', INSTALL_RECORD_FILENAME), 'utf-8');
  expect(recordText).not.toMatch(/ZHIPU_API_KEY|FEISHU_SYNC_AGENT_RUN_TOKEN/);

  // 2) 状态端点：已装事实 + 官方来源常量
  const dto = await host.statusDto();
  expect(dto.amagi?.installed).toBe(true);
  expect(dto.amagi?.installState).toBe('installed');
  expect(dto.amagi?.version).toBe('2.21.31');
  expect(dto.amagi?.pinnedVersion).toBe('2.21.31');
  expect(dto.amagi?.gitSource).toBe(`git:github.com/runrunrain/amagi-pi@${AMAGI_PI_GIT_COMMIT}`);

  // 3) 重复默认安装 → 完整哈希校验复用（fresh=false，不重新 clone）
  const again = await host.installAmagi({});
  expect(again.fresh).toBe(false);
  expect(again.contentHash).toBe(installed.contentHash);
}, 420_000);
