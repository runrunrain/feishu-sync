/**
 * P1-S5：可选读 scope 机制 + slides 截图采集（同步侧）。
 *
 * 覆盖任务书测试面：
 * - scope 缺失 → 跳过且正文字节一致（主验证面：主上尚未授权 screenshot scope）
 * - enabled + granted mock → 采集调用与 all-or-none（任一页失败零截图引用）
 * - 配置解析（sync.slidesScreenshot additive）
 * - auth-status optionalScopes 形态；device flow 可选 scope 并入
 * - 默认行为零变化（既有 slides 同步测试不改全绿，另以「关闭态零调用 +
 *   字节一致」在此直接断言）
 *
 * 输入证据：P1-S1 实测（agent-outputs/.../P1-S1-probe.md）——scope 校验先于
 * 一切、missing_scopes 仅 slides:presentation:screenshot、--slide-number
 * 逗号 ints 可解析；SP-2/SP-3/SP-4 授权后待实测（本文件用 mock 输出形态）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// child_process mock：LarkCliManager device flow 直连 execFile（绕过串行
// 队列），逐用例注入 handler 捕获 argv（范式同 lark-cli-manager.test.ts）。
// ---------------------------------------------------------------------------
type ExecHandlerResult = {
  error?: Error | null;
  stdout?: string;
  stderr?: string;
};

const { execFileMock, setExecHandler } = vi.hoisted(() => {
  type Handler = (file: string, args: string[]) => ExecHandlerResult | Promise<ExecHandlerResult>;
  let handler: Handler = () => ({ stdout: '' });
  return {
    execFileMock: vi.fn(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        Promise.resolve()
          .then(() => handler(_file, _args))
          .then((result) => {
            callback(result?.error ?? null, {
              stdout: result?.stdout ?? '',
              stderr: result?.stderr ?? '',
            });
          })
          .catch((error) => callback(error as Error));
      },
    ),
    setExecHandler: (next: Handler) => {
      handler = next;
    },
  };
});

vi.mock('child_process', () => ({ execFile: execFileMock, spawn: vi.fn() }));

import {
  LarkCliClient,
  LarkCliError,
  type SlidesScreenshotOutput,
} from '../src/modules/lark-cli-client.js';
import {
  LarkCliManager,
  OPTIONAL_READ_SCOPES,
  allOptionalReadScopes,
  enabledOptionalScopes,
  optionalScopesForFeature,
} from '../src/modules/lark-cli-manager.js';
import {
  ConfigManager,
  normalizeSyncConfigLoose,
  validateSyncConfig,
  InvalidConfigError,
} from '../src/modules/config-manager.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { feishuRoutes } from '../src/routes/feishu.js';
import type { ChangedDocument } from '../src/types/index.js';

const DEVICE_AUTH_JSON =
  '{"device_code":"dc-123","expires_in":600,"verification_url":"https://open.feishu.cn/device-verify?dc=dc-123"}';

/** 最小合法 PNG 头（8 字节魔数即满足校验）。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function writePng(file: string, size = 64): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([PNG_MAGIC, Buffer.alloc(Math.max(0, size - 8), 0x00)]));
}

// ---------------------------------------------------------------------------
// LarkCliClient.screenshotSlides
// ---------------------------------------------------------------------------

type ClientInternals = {
  classifyError(message: string, upstreamCode?: string): LarkCliError;
};

function createClient(): LarkCliClient {
  return new LarkCliClient({
    requiredScopes: [],
    timeout: 1_000,
    larkCliPath: 'lark-cli-not-invoked-by-these-tests',
  });
}

describe('LarkCliClient.screenshotSlides（P1-S5 追加方法）', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function makeOutputDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slides-shot-'));
    tempDirs.push(dir);
    return dir;
  }

  it('argv：逗号 ints 页码、--as user、输出目录相对化 + cwd 父目录、JSON 映射返回', async () => {
    const client = createClient();
    const outputDir = makeOutputDir();
    // CLI 映射返回真实存在的输出文件（saved_path；文件存在时 realpath
    // 归一才能通过输出围栏——macOS /var 与 /private/var 的已知兑底）。
    writePng(path.join(outputDir, 'slide-1.png'));
    writePng(path.join(outputDir, 'slide-2.png'));
    const calls: Array<{ args: string[]; options?: { cwd?: string } }> = [];
    (client as any).execute = async (args: string[], _api: string, options?: { cwd?: string }) => {
      calls.push({ args, options });
      return {
        ok: true,
        data: {
          screenshots: [
            { slide_number: 1, path: `${path.basename(outputDir)}/slide-1.png` },
            { slide_number: 2, saved_path: `${path.basename(outputDir)}/slide-2.png` },
          ],
        },
      };
    };

    const result = await client.screenshotSlides('PresToken1234567890', {
      slideNumbers: [2, 1],
      outputDir,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      'slides', '+screenshot', '--as', 'user',
      '--presentation', 'PresToken1234567890',
      '--slide-number', '1,2',
      '--output-dir', path.basename(outputDir),
      '--format', 'json',
    ]);
    expect(calls[0].options?.cwd).toBe(path.dirname(path.resolve(outputDir)));
    // 相对路径以子进程 cwd 为基准解析，且逐条落在请求目录内。
    expect(result.map((entry) => path.basename(entry.path))).toEqual(['slide-1.png', 'slide-2.png']);
    expect(result.every((entry) => entry.path.startsWith(path.resolve(outputDir)))).toBe(true);
    expect(result.every((entry) => fs.existsSync(entry.path))).toBe(true);
  });

  it.each([
    ['空列表', []],
    ['超过 10 页', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
    ['非正整数', [0]],
    ['非整数', [1.5]],
  ])('拒绝页码入参：%s', async (_label, slideNumbers) => {
    const client = createClient();
    const outputDir = makeOutputDir();
    (client as any).execute = async () => ({ ok: true });
    await expect(
      client.screenshotSlides('PresToken1234567890', { slideNumbers: slideNumbers as number[], outputDir }),
    ).rejects.toThrow(/1–10|页码/);
  });

  it('JSON 映射缺失时退化扫描输出目录并按文件名数值配对页号', async () => {
    const client = createClient();
    const outputDir = makeOutputDir();
    // 文件名乱序 + 字典序陷阱（slide-10 < slide-2）：数值键排序必须纠正。
    writePng(path.join(outputDir, 'slide-10.png'));
    writePng(path.join(outputDir, 'slide-2.png'));
    writePng(path.join(outputDir, 'slide-1.png'));
    (client as any).execute = async () => ({ ok: true, data: { note: 'no mapping' } });

    const result = await client.screenshotSlides('PresToken1234567890', {
      slideNumbers: [1, 2, 10],
      outputDir,
    });
    expect(result.map((entry) => entry.slideNumber)).toEqual([1, 2, 10]);
    expect(result.every((entry) => fs.existsSync(entry.path))).toBe(true);
  });

  it('映射与文件数均不可得时拒绝（all-or-none 调用方按失败处理）', async () => {
    const client = createClient();
    const outputDir = makeOutputDir();
    (client as any).execute = async () => ({ ok: true, data: {} });
    await expect(
      client.screenshotSlides('PresToken1234567890', { slideNumbers: [1], outputDir }),
    ).rejects.toMatchObject({ name: 'LarkCliError', code: 'parse' });
  });

  it('输出围栏：映射路径逃逸请求目录时拒绝', async () => {
    const client = createClient();
    const outputDir = makeOutputDir();
    (client as any).execute = async () => ({
      ok: true,
      data: { screenshots: [{ slide_number: 1, path: '../escape.png' }] },
    });
    await expect(
      client.screenshotSlides('PresToken1234567890', { slideNumbers: [1], outputDir }),
    ).rejects.toMatchObject({ name: 'LarkCliError', code: 'upstream' });
  });
});

describe('classifyError：missing_scope 透传（P1-S1 SP-1 错误原文）', () => {
  it('missing required scope(s) 原文 → code=missing_scope、不可重试、原文保留', () => {
    const client = createClient();
    // P1-S1 实测错误体（tests/fixtures/p1s1-lark-cli/ 同源样本）
    const upstream = JSON.stringify({
      error: {
        type: 'authorization',
        subtype: 'missing_scope',
        message: 'missing required scope(s): slides:presentation:screenshot',
        missing_scopes: ['slides:presentation:screenshot'],
      },
    });
    const error = (client as unknown as ClientInternals).classifyError(upstream);
    expect(error.code).toBe('missing_scope');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('missing required scope(s): slides:presentation:screenshot');
  });
});

// ---------------------------------------------------------------------------
// OPTIONAL_READ_SCOPES / device flow 合成
// ---------------------------------------------------------------------------

describe('OPTIONAL_READ_SCOPES 注册表与 device flow 合成（P1-B §3.1/§3.4）', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s5-manager-'));
    vi.clearAllMocks();
    setExecHandler(() => ({ error: new Error('unexpected execFile call'), stdout: '' }));
  });
  afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  function createManager(options: {
    authReadiness?: Record<string, unknown>;
    config?: Record<string, unknown>;
  }) {
    const client = {
      checkAuthReady: vi.fn(
        async () =>
          options.authReadiness ?? {
            ready: false,
            currentScopes: [],
          },
      ),
    };
    const config = { requiredScopes: ['wiki:node:retrieve', 'offline_access'], ...options.config };
    const configManager = {
      getConfig: vi.fn(() => config),
      load: vi.fn(async () => config),
    };
    const manager = new LarkCliManager(client, configManager, {
      platform: 'darwin',
      env: { PATH: path.join(tmpRoot, 'empty-bin') },
      homeDir: tmpRoot,
    });
    return { manager, client, configManager };
  }

  function capturedScopes(): string[][] {
    return execFileMock.mock.calls
      .map((call) => (call as unknown as [string, string[]])[1])
      .filter((args) => args.includes('auth') && args.includes('--scope'))
      .map((args) => args[args.indexOf('--scope') + 1].split(' ').filter(Boolean));
  }

  it('注册表首项：slidesScreenshots → slides:presentation:screenshot', () => {
    expect(OPTIONAL_READ_SCOPES).toEqual([
      { feature: 'slidesScreenshots', scopes: ['slides:presentation:screenshot'] },
    ]);
    expect(optionalScopesForFeature('slidesScreenshots')).toEqual(['slides:presentation:screenshot']);
    expect(allOptionalReadScopes()).toEqual(['slides:presentation:screenshot']);
  });

  it('enabledOptionalScopes：开关关 → 空集；开 → 单条目并集', () => {
    expect(enabledOptionalScopes(null)).toEqual([]);
    expect(enabledOptionalScopes({})).toEqual([]);
    expect(enabledOptionalScopes({ sync: { slidesScreenshot: { enabled: false } } })).toEqual([]);
    expect(enabledOptionalScopes({ sync: { slidesScreenshot: { enabled: true } } }))
      .toEqual(['slides:presentation:screenshot']);
  });

  it('includeOptionalScopes=true：可选 scope 并入请求集，scopeSet 沿用已授集合自动判定', async () => {
    // 已授含写 scope → 自动 write：请求集 = 必需 ∪ WRITE ∪ 可选 ∪ 已授
    const { manager } = createManager({
      authReadiness: {
        ready: true,
        currentScopes: ['wiki:node:retrieve', 'offline_access', 'docx:document:write_only'],
      },
      config: { sync: { slidesScreenshot: { enabled: true } } },
    });
    setExecHandler(() => ({ stdout: DEVICE_AUTH_JSON }));
    const session = await manager.startDeviceAuth('reauthorize', { includeOptionalScopes: true });
    expect(session.scopeSet).toBe('write');
    expect(session.requestedScopes).toEqual(expect.arrayContaining([
      'wiki:node:retrieve',
      'offline_access',
      'docx:document:write_only',
      'slides:presentation:screenshot',
    ]));
    expect(capturedScopes()[0]).toEqual(expect.arrayContaining(['slides:presentation:screenshot']));
    await manager.cancelDeviceAuth(session.deviceCode);
  });

  it('includeOptionalScopes=true 且已授无写集：scopeSet=read，不意外申请写权限', async () => {
    const { manager } = createManager({
      authReadiness: { ready: true, currentScopes: ['wiki:node:retrieve'] },
      config: { sync: { slidesScreenshot: { enabled: true } } },
    });
    setExecHandler(() => ({ stdout: DEVICE_AUTH_JSON }));
    const session = await manager.startDeviceAuth('reauthorize', { includeOptionalScopes: true });
    expect(session.scopeSet).toBe('read');
    const requested = capturedScopes()[0];
    expect(requested).toContain('slides:presentation:screenshot');
    expect(requested).not.toContain('docx:document:write_only');
    await manager.cancelDeviceAuth(session.deviceCode);
  });

  it('includeOptionalScopes 缺省：argv 与既有行为字节一致（可选集不出现）', async () => {
    const { manager } = createManager({
      authReadiness: { ready: true, currentScopes: ['wiki:node:retrieve'] },
      config: { sync: { slidesScreenshot: { enabled: true } } },
    });
    setExecHandler(() => ({ stdout: DEVICE_AUTH_JSON }));
    const session = await manager.startDeviceAuth('reauthorize');
    expect(session.requestedScopes).not.toContain('slides:presentation:screenshot');
    await manager.cancelDeviceAuth(session.deviceCode);
  });

  it('整单 invalid scope 拒绝时降级最小必需集重试（可选集退场）', async () => {
    const { manager } = createManager({
      authReadiness: { ready: true, currentScopes: [] },
      config: { sync: { slidesScreenshot: { enabled: true } } },
    });
    let call = 0;
    setExecHandler(() => {
      call += 1;
      if (call === 1) {
        return {
          error: Object.assign(new Error('Command failed'), {
            stderr: 'Error: The provided scope list contains invalid or malformed scopes',
          }),
        };
      }
      return { stdout: DEVICE_AUTH_JSON };
    });
    const session = await manager.startDeviceAuth('reauthorize', { includeOptionalScopes: true });
    const attempts = capturedScopes();
    expect(attempts[0]).toContain('slides:presentation:screenshot');
    expect(attempts[1]).not.toContain('slides:presentation:screenshot');
    expect(session.requestedScopes).not.toContain('slides:presentation:screenshot');
    await manager.cancelDeviceAuth(session.deviceCode);
  });
});

// ---------------------------------------------------------------------------
// 配置段：sync.slidesScreenshot（additive）
// ---------------------------------------------------------------------------

describe('配置段 sync.slidesScreenshot', () => {
  const tempPaths: string[] = [];
  afterEach(() => {
    while (tempPaths.length) fs.rmSync(tempPaths.pop()!, { recursive: true, force: true });
  });

  it('normalizeSyncConfigLoose：缺失/非法 → 默认关闭；合法保留', () => {
    // P0-S6 后 sync 段还含 whiteboardExport 默认段——本用例只断言 slidesScreenshot 段（toMatchObject）
    expect(normalizeSyncConfigLoose(undefined)).toMatchObject({ slidesScreenshot: { enabled: false } });
    expect(normalizeSyncConfigLoose('junk')).toMatchObject({ slidesScreenshot: { enabled: false } });
    expect(normalizeSyncConfigLoose({ slidesScreenshot: { enabled: 'yes' } }))
      .toMatchObject({ slidesScreenshot: { enabled: false } });
    expect(normalizeSyncConfigLoose({ slidesScreenshot: { enabled: true } }))
      .toMatchObject({ slidesScreenshot: { enabled: true } });
  });

  it('validateSyncConfig：非法类型拒绝，合法/缺失通过', () => {
    expect(() => validateSyncConfig('junk')).toThrow(InvalidConfigError);
    expect(() => validateSyncConfig({ slidesScreenshot: { enabled: 1 } })).toThrow(InvalidConfigError);
    expect(() => validateSyncConfig({ slidesScreenshot: 'x' })).toThrow(InvalidConfigError);
    expect(() => validateSyncConfig(undefined)).not.toThrow();
    expect(() => validateSyncConfig({ slidesScreenshot: { enabled: true } })).not.toThrow();
  });

  it('ConfigManager：旧配置无段 → 默认关闭；updateConfig 显式提供时采用并落盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s5-config-'));
    tempPaths.push(dir);
    const configPath = path.join(dir, 'config.json');
    const manager = new ConfigManager(configPath);
    const loaded = await manager.load();
    // P0-S6 后 sync 段还含 whiteboardExport 默认段——本用例只断言 slidesScreenshot 段
    expect(loaded.sync).toMatchObject({ slidesScreenshot: { enabled: false } });

    await manager.updateConfig({ sync: { slidesScreenshot: { enabled: true } } });
    expect(manager.getConfig()!.sync).toMatchObject({ slidesScreenshot: { enabled: true } });
    // 落盘可回读
    const reloaded = await new ConfigManager(configPath).load();
    expect(reloaded.sync).toMatchObject({ slidesScreenshot: { enabled: true } });
    // 非法 partial 拒绝
    await expect(
      manager.updateConfig({ sync: { slidesScreenshot: { enabled: 'on' } as unknown as boolean } }),
    ).rejects.toThrow(InvalidConfigError);
  });
});

// ---------------------------------------------------------------------------
// 同步侧：scope 缺失跳过 / all-or-none / 授权采集
// ---------------------------------------------------------------------------

const temps: string[] = [];
const stores: LocalMapStore[] = [];

function makeWorkspace(syncEnabled: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s5-sync-'));
  temps.push(root);
  const kb = path.join(root, 'kb');
  const ops = path.join(root, 'ops');
  fs.mkdirSync(kb, { recursive: true });
  fs.mkdirSync(ops, { recursive: true });
  const store = new LocalMapStore(path.join(root, 'map.db'));
  stores.push(store);
  store.initialize();
  const watchedRoots = [{
    id: 'dev',
    url: 'https://example.feishu.cn/wiki/dev',
    localDir: '技术 - Dev',
    layoutProfile: 'directory-readme' as const,
    enabled: true,
  }];
  const config = {
    knowledgeBaseRoot: kb,
    operationManifestDir: ops,
    watchedRoots,
    watchedRootUrls: watchedRoots.map((root_) => root_.url),
    llm: { temperature: 0.2, timeoutMs: 1000 },
    sync: { slidesScreenshot: { enabled: syncEnabled } },
  };
  return { root, kb, ops, store, config };
}

function makeDoc(overrides: Partial<ChangedDocument> = {}): ChangedDocument {
  return {
    objToken: 'tok-slides',
    objType: 'slides',
    title: '演示文稿',
    changeType: 'modified',
    cloudModifiedTime: '2026-10-28T00:00:00.000Z',
    localSyncedTime: null,
    localMdPath: null,
    wikiNodeToken: 'node-slides',
    watchedRootId: 'dev',
    hasChild: false,
    isWatchedRootNode: false,
    parentChainTitles: [],
    observedObjEditTime: 1_700_000_000_000,
    ...overrides,
  };
}

function slidesXml(pageCount: number, imageToken?: string): string {
  const slides: string[] = [];
  for (let index = 1; index <= pageCount; index += 1) {
    const media = imageToken && index === 1
      ? `<img src="${imageToken}"/>`
      : '';
    slides.push(`<slide id="slide-${index}"><content><p>第${index}页内容</p></content>${media}</slide>`);
  }
  return `<presentation><slides>${slides.join('')}</slides></presentation>`;
}

interface MockClientOptions {
  grantedScopes?: string[] | null;
  screenshotImpl?: (
    presentationToken: string,
    options: { slideNumbers: number[]; outputDir: string },
  ) => Promise<SlidesScreenshotOutput[]>;
  imageToken?: string;
}

function makeMockClient(options: MockClientOptions = {}) {
  const calls: Array<{ slideNumbers: number[] }> = [];
  const client = {
    checkAuthReady: vi.fn(async () => ({
      ready: true,
      currentScopes: options.grantedScopes ?? [],
    })),
    fetchSlidesXml: async () => ({
      data: { xml_presentation: { content: slidesXml(2, options.imageToken) } },
    }),
    downloadMedia: async (token: string, outputPath: string, type: string) => {
      const saved = `${outputPath}${type === 'whiteboard' ? '.jpg' : '.png'}`;
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.writeFileSync(saved, `media-${token}`);
      return saved;
    },
    screenshotSlides: vi.fn(async (
      presentationToken: string,
      screenshotOptions: { slideNumbers: number[]; outputDir: string },
    ) => {
      calls.push({ slideNumbers: [...screenshotOptions.slideNumbers] });
      if (options.screenshotImpl) return options.screenshotImpl(presentationToken, screenshotOptions);
      return screenshotOptions.slideNumbers.map((slideNumber) => {
        const file = path.join(screenshotOptions.outputDir, `slide-${slideNumber}.png`);
        writePng(file);
        return { slideNumber, path: file };
      });
    }),
  };
  return { client, calls };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('SyncEngine slides 截图采集（P1-S5 主验证面）', () => {
  it('scope 缺失 → 零采集调用，正文与功能关闭态逐字节一致', async () => {
    // 运行 A：开关开启但 scope 未授权（主上当前真实形态）
    const workspaceA = makeWorkspace(true);
    const mockA = makeMockClient({ grantedScopes: ['wiki:node:retrieve'] });
    const engineA = new SyncEngine({
      larkCliClient: mockA.client, localMapStore: workspaceA.store, config: workspaceA.config,
    });
    const mdPathA = path.join(workspaceA.kb, '技术 - Dev', '演示文稿', 'README.md');
    const resultA = await engineA.syncDocuments(
      [makeDoc({ localMdPath: mdPathA, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    expect(resultA.success).toBe(true);
    expect(mockA.calls).toHaveLength(0);

    // 运行 B：开关关闭
    const workspaceB = makeWorkspace(false);
    const mockB = makeMockClient({ grantedScopes: ['slides:presentation:screenshot'] });
    const engineB = new SyncEngine({
      larkCliClient: mockB.client, localMapStore: workspaceB.store, config: workspaceB.config,
    });
    const mdPathB = path.join(workspaceB.kb, '技术 - Dev', '演示文稿', 'README.md');
    await engineB.syncDocuments(
      [makeDoc({ localMdPath: mdPathB, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    expect(mockB.calls).toHaveLength(0);

    // 关闭态（B）即使已授权也零调用；A 的正文字节与 B 完全一致
    expect(fs.readFileSync(mdPathA, 'utf-8')).toBe(fs.readFileSync(mdPathB, 'utf-8'));
    expect(fs.readFileSync(mdPathA, 'utf-8')).not.toContain('截图');
  });

  it('enabled + granted → 每页恰一行截图引用，位于该页既有媒体行之前，文件随原子提交落库', async () => {
    const imageToken = 'SlideImageToken123456789';
    const workspace = makeWorkspace(true);
    const mock = makeMockClient({
      grantedScopes: ['wiki:node:retrieve', 'slides:presentation:screenshot'],
      imageToken,
    });
    const engine = new SyncEngine({
      larkCliClient: mock.client, localMapStore: workspace.store, config: workspace.config,
    });
    const mdPath = path.join(workspace.kb, '技术 - Dev', '演示文稿', 'README.md');
    const result = await engine.syncDocuments(
      [makeDoc({ localMdPath: mdPath, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );

    expect(result.success).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].slideNumbers).toEqual([1, 2]);
    // 2 页截图 + 1 页内图片 → imagesCount = 3
    expect(result.syncedDocuments[0]).toMatchObject({ imagesCount: 3 });

    const markdown = fs.readFileSync(mdPath, 'utf-8');
    const shot1 = markdown.indexOf('- 幻灯片 1 截图：![幻灯片 1 截图](images/README-p01.png)');
    const media1 = markdown.indexOf(`- 幻灯片 1 图片：![图片](images/01-${imageToken}.png)`);
    const shot2 = markdown.indexOf('- 幻灯片 2 截图：![幻灯片 2 截图](images/README-p02.png)');
    expect(shot1).toBeGreaterThanOrEqual(0);
    expect(media1).toBeGreaterThan(shot1);
    expect(shot2).toBeGreaterThan(media1);
    // 文件随原子提交进入知识库
    expect(fs.existsSync(path.join(path.dirname(mdPath), 'images', 'README-p01.png'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(mdPath), 'images', 'README-p02.png'))).toBe(true);
  });

  it('无媒体页的文档：截图行单独创建「## 媒体资源」区', async () => {
    const workspace = makeWorkspace(true);
    const mock = makeMockClient({
      grantedScopes: ['slides:presentation:screenshot'],
    });
    const engine = new SyncEngine({
      larkCliClient: mock.client, localMapStore: workspace.store, config: workspace.config,
    });
    const mdPath = path.join(workspace.kb, '技术 - Dev', '演示文稿', 'README.md');
    await engine.syncDocuments(
      [makeDoc({ localMdPath: mdPath, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    expect(markdown).toContain('## 媒体资源\n\n- 幻灯片 1 截图：');
    expect(markdown.trimEnd().endsWith('- 幻灯片 2 截图：![幻灯片 2 截图](images/README-p02.png)')).toBe(true);
  });

  it('12 页 → 分批 ≤10（[1..10] 与 [11,12] 两次调用）', async () => {
    const workspace = makeWorkspace(true);
    const mock = makeMockClient({ grantedScopes: ['slides:presentation:screenshot'] });
    mock.client.fetchSlidesXml = async () => ({
      data: { xml_presentation: { content: slidesXml(12) } },
    });
    const engine = new SyncEngine({
      larkCliClient: mock.client, localMapStore: workspace.store, config: workspace.config,
    });
    const mdPath = path.join(workspace.kb, '技术 - Dev', '演示文稿', 'README.md');
    const result = await engine.syncDocuments(
      [makeDoc({ localMdPath: mdPath, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    expect(result.success).toBe(true);
    expect(mock.calls.map((call) => call.slideNumbers)).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [11, 12],
    ]);
  });

  it('任一页失败 → 全部已暂存截图删除，正文零截图引用且与关闭态逐字节一致（all-or-none）', async () => {
    // 运行 A：第二批抛错（12 页 → 第一批成功、第二批失败）
    const workspaceA = makeWorkspace(true);
    const mockA = makeMockClient({
      grantedScopes: ['slides:presentation:screenshot'],
      screenshotImpl: async (_token, options) => {
        if (options.slideNumbers[0] > 10) throw new Error('simulated page failure');
        return options.slideNumbers.map((slideNumber) => {
          const file = path.join(options.outputDir, `slide-${slideNumber}.png`);
          writePng(file);
          return { slideNumber, path: file };
        });
      },
    });
    mockA.client.fetchSlidesXml = async () => ({
      data: { xml_presentation: { content: slidesXml(12) } },
    });
    const engineA = new SyncEngine({
      larkCliClient: mockA.client, localMapStore: workspaceA.store, config: workspaceA.config,
    });
    const mdPathA = path.join(workspaceA.kb, '技术 - Dev', '演示文稿', 'README.md');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resultA = await engineA.syncDocuments(
      [makeDoc({ localMdPath: mdPathA, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    // 截图失败是警告不是阻断：文档照常提交
    expect(resultA.success).toBe(true);
    expect(resultA.syncedDocuments[0]).toMatchObject({ imagesCount: 0 });
    expect(fs.readFileSync(mdPathA, 'utf-8')).not.toContain('截图');
    const committedImages = fs.existsSync(path.join(path.dirname(mdPathA), 'images'))
      ? fs.readdirSync(path.join(path.dirname(mdPathA), 'images'))
      : [];
    expect(committedImages.filter((name) => name.includes('-p'))).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('slides_screenshot_unavailable(reason=capture_failed)'),
      expect.anything(),
    );

    // 运行 B：同文档关闭态 → 字节一致
    const workspaceB = makeWorkspace(false);
    const mockB = makeMockClient({});
    mockB.client.fetchSlidesXml = async () => ({
      data: { xml_presentation: { content: slidesXml(12) } },
    });
    const engineB = new SyncEngine({
      larkCliClient: mockB.client, localMapStore: workspaceB.store, config: workspaceB.config,
    });
    const mdPathB = path.join(workspaceB.kb, '技术 - Dev', '演示文稿', 'README.md');
    await engineB.syncDocuments(
      [makeDoc({ localMdPath: mdPathB, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    expect(fs.readFileSync(mdPathA, 'utf-8')).toBe(fs.readFileSync(mdPathB, 'utf-8'));
    warnSpy.mockRestore();
  });

  it('非图片魔数输出判失败（SP-4），文档照常提交', async () => {
    const workspace = makeWorkspace(true);
    const mock = makeMockClient({
      grantedScopes: ['slides:presentation:screenshot'],
      screenshotImpl: async (_token, options) => {
        const entries = options.slideNumbers.map((slideNumber) => {
          const file = path.join(options.outputDir, `slide-${slideNumber}.png`);
          fs.mkdirSync(options.outputDir, { recursive: true });
          fs.writeFileSync(file, 'definitely not an image');
          return { slideNumber, path: file };
        });
        return entries;
      },
    });
    const engine = new SyncEngine({
      larkCliClient: mock.client, localMapStore: workspace.store, config: workspace.config,
    });
    const mdPath = path.join(workspace.kb, '技术 - Dev', '演示文稿', 'README.md');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await engine.syncDocuments(
      [makeDoc({ localMdPath: mdPath, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    warnSpy.mockRestore();
    expect(result.success).toBe(true);
    expect(fs.readFileSync(mdPath, 'utf-8')).not.toContain('截图');
  });

  it('超过 60 页 → too_many_pages 跳过，不发起任何截图调用', async () => {
    const workspace = makeWorkspace(true);
    const mock = makeMockClient({ grantedScopes: ['slides:presentation:screenshot'] });
    mock.client.fetchSlidesXml = async () => ({
      data: { xml_presentation: { content: slidesXml(61) } },
    });
    const engine = new SyncEngine({
      larkCliClient: mock.client, localMapStore: workspace.store, config: workspace.config,
    });
    const mdPath = path.join(workspace.kb, '技术 - Dev', '演示文稿', 'README.md');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await engine.syncDocuments(
      [makeDoc({ localMdPath: mdPath, localRelPath: '技术 - Dev/演示文稿/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    expect(result.success).toBe(true);
    expect(mock.calls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('slides_screenshot_unavailable(reason=too_many_pages)'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 路由：auth-status optionalScopes / device start includeOptionalScopes
// ---------------------------------------------------------------------------

describe('routes/feishu.ts：P1-B 授权交互入口', () => {
  function makeApp(deps: Record<string, unknown>) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      Object.assign(c as unknown as Record<string, unknown>, deps);
      await next();
    });
    app.route('/', feishuRoutes);
    return app;
  }

  it('GET /api/feishu/auth-status：optionalScopes 分档 granted/missing', async () => {
    const app = makeApp({
      larkCliClient: {
        checkAuthReady: async () => ({
          ready: true,
          currentScopes: ['wiki:node:retrieve', 'slides:presentation:screenshot'],
        }),
      },
    });
    const response = await app.request('/api/feishu/auth-status');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.optionalScopes).toEqual({
      granted: ['slides:presentation:screenshot'],
      missing: [],
    });
    expect(body.writeScopesGranted).toBe(false);
  });

  it('GET /api/feishu/auth-status：scope 未授权 → missing 全量；异常态形态稳定', async () => {
    const app = makeApp({
      larkCliClient: {
        checkAuthReady: async () => ({ ready: true, currentScopes: ['wiki:node:retrieve'] }),
      },
    });
    const ok = await (await app.request('/api/feishu/auth-status')).json();
    expect(ok.optionalScopes).toEqual({
      granted: [],
      missing: ['slides:presentation:screenshot'],
    });

    const failing = makeApp({
      larkCliClient: {
        checkAuthReady: async () => {
          throw new Error('cli unavailable');
        },
      },
    });
    const errorResponse = await failing.request('/api/feishu/auth-status');
    expect(errorResponse.status).toBe(500);
    const errorBody = await errorResponse.json();
    expect(errorBody.optionalScopes).toEqual({
      granted: [],
      missing: ['slides:presentation:screenshot'],
    });
  });

  it('POST /api/feishu/auth/device/start：includeOptionalScopes 透传给 Manager', async () => {
    const startDeviceAuth = vi.fn(async () => ({
      verificationUrl: 'https://open.feishu.cn/verify',
      deviceCode: 'dc-1',
      expiresIn: 600,
      requestedScopes: ['wiki:node:retrieve', 'slides:presentation:screenshot'],
      scopeSet: 'read',
      mode: 'reauthorize',
    }));
    const app = makeApp({ larkCliClient: {}, larkCliManager: { startDeviceAuth } });

    const response = await app.request('/api/feishu/auth/device/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeOptionalScopes: true }),
    });
    expect(response.status).toBe(200);
    expect(startDeviceAuth).toHaveBeenCalledWith('reauthorize', { includeOptionalScopes: true });

    // 非法类型拒绝
    const bad = await app.request('/api/feishu/auth/device/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeOptionalScopes: 'yes' }),
    });
    expect(bad.status).toBe(400);
  });
});
