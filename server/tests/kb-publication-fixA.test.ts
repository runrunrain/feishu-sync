/**
 * T4b 修复批 A 正式回归（按 diting 终审复验归因固化反例）：
 *   - T4b-01 发布互斥同步准入：同实例同 kbPath 并发双请求仅单 fulfilled
 *   - T4b-02 第二遍互链回写前的执行期时间门：他人修改 → 阻断 + 确认值
 *     升级 OVERWRITE_PUBLISHED（不再沿用 PUBLISH 覆盖）
 *   - T4b-03 发布根候选配置联合校验：通用 PUT /api/config 两方向都拒；
 *     祖先链不可读 fail-closed；身份未变不触发云端解析
 *   - T4b-04 发布 overwrite 写前锚点：无锚/落库失败拒绝覆盖 + push_log 落行
 *   - T4b-06（create）写后结果不确定（parse/缺 document_id）→ unknown，
 *     普通重发被 state_unknown 阻断
 *   - T4b-07 旧云 token 谱系：previousCloudTokens 并入快照排除全集，
 *     状态/警告更新不擦除谱系
 *
 * 反例来源：agent-outputs/workflow/2026-10-27-kb-agent-upgrade/
 * T4b-diting-final-review.md「复验归因」与附录 runner。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LarkCliClient, LarkCliError } from '../src/modules/lark-cli-client.js';
import { configRoutes } from '../src/routes/config.js';
import {
  KbPublishService,
  PublicationError,
  createPublishOverlapConfigHook,
} from '../src/kb/publication-service.js';
import { countText } from '../src/kb/text-stats.js';
import type { PublishTargetConfig } from '../src/types/index.js';

const BASE_TIME = 1759000000;
const TARGET: PublishTargetConfig = { kind: 'drive_folder', token: 'fldcnPublishRoot01', label: '发布根' };

// ---------------------------------------------------------------------------
// lark-cli stub（与 kb-publication.test.ts 同构；history 默认有锚）
// ---------------------------------------------------------------------------

interface LarkStub {
  calls: Array<{ op: string; args: unknown[] }>;
  createdDocs: Map<string, string>;
  metaTimes: Map<string, number | null>;
  [key: string]: unknown;
}

function makeLarkStub(overrides: Record<string, unknown> = {}): LarkStub {
  const calls: LarkStub['calls'] = [];
  const createdDocs = new Map<string, string>();
  const metaTimes = new Map<string, number | null>();
  let seq = 0;
  const stub: LarkStub = {
    calls,
    createdDocs,
    metaTimes,
    checkAuthReady: async () => ({
      ready: true, verified: true, identity: 'user',
      currentScopes: ['docx:document:write_only', 'wiki:node:retrieve'], missingScopes: [],
    }),
    getDocumentMetas: async (reqs: Array<{ docToken: string; docType: string }>) => ({
      metas: reqs.map((req) => ({
        docToken: req.docToken, docType: req.docType,
        latestModifyTime: metaTimes.has(req.docToken) ? metaTimes.get(req.docToken)! : BASE_TIME,
        title: '',
      })),
      failed: [],
    }),
    fetchDocumentRevision: async (token: string) => {
      calls.push({ op: 'fetchRevision', args: [token] });
      if (!createdDocs.has(token)) {
        throw new LarkCliError('doc not found: 404 (981003)', 'not_found', false, '981003');
      }
      return { revisionId: 11, title: 'cloud' };
    },
    createDocumentMarkdown: async (options: { title: string; markdown: string; parentToken: string }) => {
      calls.push({ op: 'create', args: [{ ...options }] });
      seq += 1;
      const id = `docxcnFixA${String(seq).padStart(4, '0')}`;
      createdDocs.set(id, options.markdown);
      metaTimes.set(id, BASE_TIME);
      return { documentId: id, url: `https://x.feishu.cn/docx/${id}`, revisionId: 1 };
    },
    overwriteDocument: async (token: string, markdown: string, revisionId: number) => {
      calls.push({ op: 'overwrite', args: [token, markdown, revisionId] });
      createdDocs.set(token, markdown);
      return { revisionId: revisionId + 1, warnings: [], raw: {} };
    },
    parseDocumentProfile: async (token: string) => {
      calls.push({ op: 'parse', args: [token] });
      const body = createdDocs.get(token) ?? '';
      return { charCount: countText(body).chars, wordCount: 1, blockCount: 1 };
    },
    listDocumentHistory: async (token: string, opts?: { pageSize?: number }) => {
      calls.push({ op: 'historyList', args: [token, opts?.pageSize] });
      return {
        entries: [{
          historyVersionId: `hist-${token}`, revisionId: 9,
          editTime: new Date(BASE_TIME * 1000).toISOString(),
          editorIds: ['ou-test'], type: 2, raw: {},
        }],
        hasMore: false, nextPageToken: null,
      };
    },
    getNode: async (token: string) => ({ node_token: token, parent_node_token: '' }),
    ...overrides,
  };
  return stub;
}

// ---------------------------------------------------------------------------
// 标准库 release fixture
// ---------------------------------------------------------------------------

function writeRelease(outputRoot: string, releaseId: string, docs: Array<{ path: string; markdown: string }>): void {
  const releaseDir = path.join(outputRoot, 'releases', releaseId);
  fs.mkdirSync(path.join(releaseDir, 'docs'), { recursive: true });
  for (const doc of docs) {
    const file = path.join(releaseDir, 'docs', doc.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, doc.markdown, 'utf-8');
  }
  const manifest = {
    schemaVersion: 1, releaseId, buildId: `build-${releaseId}`, mode: 'incremental' as const,
    baseReleaseId: null, publishedAt: new Date().toISOString(), model: null,
    sourceSnapshot: [], skippedSources: [],
    docs: docs.map((doc, index) => ({
      docId: `doc-${index}`, path: doc.path, title: path.basename(doc.path, '.md'),
      summary: '', headings: [], tags: [], sources: [`src-${index}`],
      contentHash: `h-${releaseId}-${index}`, updatedInBuild: `build-${releaseId}`,
    })),
  };
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  fs.writeFileSync(
    path.join(outputRoot, 'CURRENT.json'),
    JSON.stringify({ schemaVersion: 1, releaseId, publishedAt: manifest.publishedAt }),
    'utf-8',
  );
}

const DOC_A = '<!--\nfeishu_sync_kb:\n  doc_id: doc-0\n  build_id: build-rel-001\n  sources:\n    - src-0\n-->\n\n# 标题A\n\n参见 [B篇](../b/b.md)。\n\n正文A内容。\n';
const DOC_B = '# 标题B\n\n正文B内容。\n';

interface Fixture {
  outputRoot: string;
  dataRoot: string;
  store: LocalMapStore;
  lark: LarkStub;
  config: Record<string, unknown>;
  configManager: Record<string, unknown>;
  service: KbPublishService;
  cleanup: () => void;
}

function makeFixture(opts: {
  larkOverrides?: Record<string, unknown>;
  configOverrides?: Record<string, unknown>;
} = {}): Fixture {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4b-fixa-kb-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4b-fixa-data-'));
  writeRelease(outputRoot, 'rel-001', [
    { path: 'dirA/a.md', markdown: DOC_A },
    { path: 'b/b.md', markdown: DOC_B },
  ]);
  const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
  store.initialize();
  const lark = makeLarkStub(opts.larkOverrides ?? {});
  const config: Record<string, unknown> = {
    knowledgeBaseRoot: path.join(dataRoot, 'raw'),
    standardKb: { outputRoot },
    feishuWrite: { enabled: true },
    feishuPublish: { enabled: true, target: TARGET },
    watchedRoots: [],
    ...opts.configOverrides,
  };
  const configManager = {
    getConfig: () => config,
    load: async () => config,
    updateConfig: async (partial: Record<string, unknown>) => {
      Object.assign(config, partial);
      return config;
    },
  };
  const service = new KbPublishService({
    configManager: configManager as never,
    localMapStore: store,
    larkCliClient: lark,
    dataRoot,
  });
  return {
    outputRoot, dataRoot, store, lark, config, configManager, service,
    cleanup: () => {
      store.close();
      fs.rmSync(outputRoot, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

function overwriteCalls(fx: Fixture): Array<{ op: string; args: unknown[] }> {
  return fx.lark.calls.filter((c) => c.op === 'overwrite');
}

// ===========================================================================
// T4b-01：发布互斥异步准入窗口
// ===========================================================================

describe('T4b-01 发布互斥同步准入', () => {
  it('同实例同 kbPath 并发双请求：仅单 fulfilled，create 恰一次，第二请求 409 publish_in_progress', async () => {
    const fx = makeFixture();
    try {
      // 放大原反例的异步窗口：buildPlan 尾部延时，第二请求在此期间尝试准入
      const original = (fx.service as unknown as { buildPlan: (o: unknown) => Promise<unknown> }).buildPlan
        .bind(fx.service);
      let planDone = false;
      (fx.service as unknown as Record<string, unknown>).buildPlan = async (o: unknown) => {
        const plan = await original(o);
        await new Promise((resolve) => setTimeout(resolve, 10));
        planDone = true;
        return plan;
      };
      const p1 = fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      let secondSettledDuringPlan = false;
      const p2 = fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] })
        .then(
          () => { throw new Error('第二个请求不应成功'); },
          (error: PublicationError) => { secondSettledDuringPlan = !planDone; return error; },
        );
      const [first, second] = await Promise.all([p1, p2]);
      // 第二请求在第一请求计划仍进行中被拒（准入为同步占用，无异步窗口）
      expect(secondSettledDuringPlan).toBe(true);
      expect(second).toBeInstanceOf(PublicationError);
      expect(second.code).toBe('publish_in_progress');
      expect(second.status).toBe(409);
      expect(first.counts.created).toBe(1);
      expect(fx.lark.calls.filter((c) => c.op === 'create')).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  it('门控/确认校验失败同样释放准入（finally 兜底），后续发布不被卡死', async () => {
    const fx = makeFixture();
    try {
      await expect(fx.service.execute({ confirm: 'WRONG' })).rejects.toMatchObject({ code: 'confirmation_required' });
      await expect(fx.service.execute({ confirm: 'PUBLISH', planKey: 'stale' })).rejects.toMatchObject({ code: 'publish_plan_changed' });
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      expect(result.counts.created).toBe(2);
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// T4b-02：第二遍互链回写绕过云端冲突保护
// ===========================================================================

describe('T4b-02 每次 overwrite 前重新取云端时间（第一遍/第二遍共用门）', () => {
  it('第二遍场景：A 为 skip_unchanged，B 创建期间他人改 A → 阻断 + 确认值升级，不覆盖他人正文', async () => {
    const fx = makeFixture();
    try {
      // 第一步：仅发布 A（对 B 的链接降级为文字）
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['dirA/a.md'] });
      const a = fx.store.getKbPublication('dirA/a.md')!;
      expect(a.state).toBe('published');

      // 第二步：B 创建成功的同时，A 的云端时间被推进且正文被他人修改
      const rawCreate = fx.lark.createDocumentMarkdown.bind(fx.lark);
      (fx.lark as unknown as Record<string, unknown>).createDocumentMarkdown =
        async (options: { title: string; markdown: string; parentToken: string }) => {
          const result = await rawCreate(options);
          fx.lark.metaTimes.set(a.cloudToken!, BASE_TIME + 100);
          fx.lark.createdDocs.set(a.cloudToken!, 'OTHER USER CLOUD EDIT');
          return result;
        };
      fx.lark.calls.length = 0;
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      // B 创建成功；A（首遍 skip → 第二遍 hash 变化）在 overwrite 前被时间门阻断
      expect(result.counts.created).toBe(1);
      expect(result.counts.blocked).toBe(1);
      expect(result.counts.secondPass).toBe(1);
      // results 含 A 的两条：首遍 skipped + 第二遍 blocked
      const aItems = result.items.filter((i) => i.kbPath === 'dirA/a.md');
      expect(aItems.map((i) => i.outcome)).toEqual(['skipped', 'blocked']);
      const blocked = aItems[1];
      expect(blocked.error).toContain('OVERWRITE_PUBLISHED');
      expect(overwriteCalls(fx).some((c) => c.args[0] === a.cloudToken)).toBe(false);
      expect(fx.lark.createdDocs.get(a.cloudToken!)).toBe('OTHER USER CLOUD EDIT');
      // 行置 conflict，重新派生批准：无 force → 仍 blocked；force → 确认值升级
      const rowA = fx.store.getKbPublication('dirA/a.md')!;
      expect(rowA.state).toBe('conflict');
      const planNoForce = await fx.service.plan({});
      expect(planNoForce.items.find((i) => i.kbPath === 'dirA/a.md')!.blockedReason).toBe('publish_cloud_edited');
      expect(planNoForce.confirmRequired).toBe('PUBLISH');
      const planForce = await fx.service.plan({ force: true });
      expect(planForce.items.find((i) => i.kbPath === 'dirA/a.md')!.action).toBe('update');
      expect(planForce.confirmRequired).toBe('OVERWRITE_PUBLISHED');
    } finally {
      fx.cleanup();
    }
  });

  it('第一遍 update 同样过执行期时间门：计划后云端被改 → blocked，零 overwrite', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n本地更新正文。\n' },
      ]);
      const rowB = fx.store.getKbPublication('b/b.md')!;
      // 计划阶段时间未推进（execute 内 buildPlan 批量取值为第 1 次），
      // 执行期门的重新取值（第 2 次）才看到推进 —— 只能被执行期门拦下
      const originalFetch = (fx.service as unknown as { fetchCloudEditTimes: (t: string[]) => Promise<Map<string, number | null>> }).fetchCloudEditTimes
        .bind(fx.service);
      let fetchCalls = 0;
      (fx.service as unknown as Record<string, unknown>).fetchCloudEditTimes = async (tokens: string[]) => {
        fetchCalls += 1;
        if (fetchCalls >= 2) fx.lark.metaTimes.set(rowB.cloudToken!, BASE_TIME + 50);
        return originalFetch(tokens);
      };
      const result = await fx.service.execute({ releaseId: 'rel-002', confirm: 'PUBLISH' });
      expect(fetchCalls).toBeGreaterThanOrEqual(2);
      const b = result.items.find((i) => i.kbPath === 'b/b.md')!;
      expect(b.outcome).toBe('blocked');
      expect(overwriteCalls(fx).some((c) => c.args[0] === rowB.cloudToken)).toBe(false);
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('conflict');
    } finally {
      fx.cleanup();
    }
  });

  it('云端时间不可读 → 同样 fail-closed 阻断（第一遍）', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n不可读时间门正文。\n' },
      ]);
      const rowB = fx.store.getKbPublication('b/b.md')!;
      // 计划阶段时间可读，执行期重新取值不可读 → 阻断
      const originalFetch = (fx.service as unknown as { fetchCloudEditTimes: (t: string[]) => Promise<Map<string, number | null>> }).fetchCloudEditTimes
        .bind(fx.service);
      let fetchCalls = 0;
      (fx.service as unknown as Record<string, unknown>).fetchCloudEditTimes = async (tokens: string[]) => {
        fetchCalls += 1;
        if (fetchCalls >= 2) fx.lark.metaTimes.set(rowB.cloudToken!, null);
        return originalFetch(tokens);
      };
      const result = await fx.service.execute({ releaseId: 'rel-002', confirm: 'PUBLISH' });
      const b = result.items.find((i) => i.kbPath === 'b/b.md')!;
      expect(b.outcome).toBe('blocked');
      expect(overwriteCalls(fx).some((c) => c.args[0] === rowB.cloudToken)).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// T4b-03：发布根候选配置联合校验（通用入口两方向 + fail-closed）
// ===========================================================================

const WIKI_ROOT_ANC = 'wikcnRootAnc00001';
const WIKI_TARGET = 'wikcnTarget0001';
const WIKI_DEEP_CHILD = 'wikcnDeepChild0001';

function wikiRoot(id: string, localDir: string): Record<string, unknown> {
  return {
    id, url: `https://t.feishu.cn/wiki/${id}`, localDir,
    layoutProfile: 'directory-readme', enabled: true,
  };
}

function makeManagerWithHook(
  parents: Record<string, string>,
  opts: { failGetNode?: boolean } = {},
): { manager: ConfigManager; getNodeCalls: () => number; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't4b-fixa-cfg-'));
  const manager = new ConfigManager(path.join(dir, 'config.json'));
  let getNodeCalls = 0;
  manager.setPublishOverlapHook(createPublishOverlapConfigHook(async (token: string) => {
    getNodeCalls += 1;
    if (opts.failGetNode) throw new Error('permission denied');
    return { parent_node_token: parents[token] ?? '' };
  }));
  return {
    manager,
    getNodeCalls: () => getNodeCalls,
    cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function buildConfigApp(manager: ConfigManager): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as Record<string, unknown>).configManager = manager;
    await next();
  });
  app.route('/', configRoutes);
  return app;
}

async function putConfig(app: Hono, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe('T4b-03 发布根候选配置联合校验（通用 PUT /api/config）', () => {
  it('方向 B：已配置发布根，通用入口新增其祖先 watchedRoot → 409 且不落盘', async () => {
    const { manager, cleanup } = makeManagerWithHook({ [WIKI_TARGET]: WIKI_ROOT_ANC });
    try {
      await manager.load();
      // 先合法设置 wiki 发布根（此时无监听根，无重叠）
      await manager.updateConfig({
        feishuPublish: { enabled: true, target: { kind: 'wiki_node', token: WIKI_TARGET, label: '发布根' } },
      });
      // 通用配置入口新增 T 的祖先 R 作为 watchedRoot → 必须拒绝
      const app = buildConfigApp(manager);
      const { status, json } = await putConfig(app, { watchedRoots: [wikiRoot(WIKI_ROOT_ANC, 'w1')] });
      expect(status).toBe(409);
      expect(json.error).toBe('publish_target_invalid');
      expect((json.details as Record<string, unknown>).code).toBe('publish_target_inside_watched_root');
      // 拒绝后配置不落盘
      const saved = await manager.load();
      expect(saved.watchedRoots).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('方向 A：通用入口直接提交位于 watchedRoot 内的 target → 409 且不落盘', async () => {
    const { manager, cleanup } = makeManagerWithHook({ [WIKI_DEEP_CHILD]: WIKI_ROOT_ANC });
    try {
      await manager.load();
      await manager.updateConfig({ watchedRoots: [wikiRoot(WIKI_ROOT_ANC, 'w1') as never] });
      const app = buildConfigApp(manager);
      const { status, json } = await putConfig(app, {
        feishuPublish: { enabled: true, target: { kind: 'wiki_node', token: WIKI_DEEP_CHILD, label: '内层发布根' } },
      });
      expect(status).toBe(409);
      expect((json.details as Record<string, unknown>).code).toBe('publish_target_inside_watched_root');
      const saved = await manager.load();
      expect(saved.feishuPublish.target ?? null).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('祖先链不可读 → 502 fail-closed 拒绝', async () => {
    const { manager, cleanup } = makeManagerWithHook({}, { failGetNode: true });
    try {
      await manager.load();
      await manager.updateConfig({ watchedRoots: [wikiRoot(WIKI_ROOT_ANC, 'w1') as never] });
      const app = buildConfigApp(manager);
      const { status, json } = await putConfig(app, {
        feishuPublish: { enabled: true, target: { kind: 'wiki_node', token: WIKI_TARGET, label: '发布根' } },
      });
      expect(status).toBe(502);
      expect((json.details as Record<string, unknown>).code).toBe('publish_target_unverifiable');
    } finally {
      cleanup();
    }
  });

  it('身份未变（同 target + 同 watchedRoots 重放）→ 跳过云端解析，保存成功', async () => {
    const { manager, getNodeCalls, cleanup } = makeManagerWithHook({});
    try {
      await manager.load();
      const target = { kind: 'wiki_node', token: WIKI_TARGET, label: '发布根' };
      const roots = [wikiRoot(WIKI_ROOT_ANC, 'w1')];
      await manager.updateConfig({ feishuPublish: { enabled: true, target }, watchedRoots: roots as never });
      const before = getNodeCalls();
      const app = buildConfigApp(manager);
      // 无关字段 + 同身份重放：不应触发祖先链云端解析
      const { status } = await putConfig(app, {
        enableNotifications: false,
        feishuPublish: { enabled: true, target },
        watchedRoots: roots,
      });
      expect(status).toBe(200);
      expect(getNodeCalls()).toBe(before);
    } finally {
      cleanup();
    }
  });

  it('收敛点在 ConfigManager.updateConfig：绕过路由直连同样拒绝', async () => {
    const { manager, cleanup } = makeManagerWithHook({ [WIKI_TARGET]: WIKI_ROOT_ANC });
    try {
      await manager.load();
      await manager.updateConfig({
        feishuPublish: { enabled: true, target: { kind: 'wiki_node', token: WIKI_TARGET, label: '发布根' } },
      });
      await expect(manager.updateConfig({ watchedRoots: [wikiRoot(WIKI_ROOT_ANC, 'w1')] as never }))
        .rejects.toMatchObject({ code: 'publish_target_invalid', status: 409 });
      expect((await manager.load()).watchedRoots).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// ===========================================================================
// T4b-04：发布 overwrite 写前历史锚点 + push_log
// ===========================================================================

describe('T4b-04 发布 overwrite 写前锚点', () => {
  it('history-list 为空（无锚）→ 拒绝覆盖：零 overwrite、行 failed、零 push_log', async () => {
    const fx = makeFixture({
      larkOverrides: {
        listDocumentHistory: async () => ({ entries: [], hasMore: false, nextPageToken: null }),
      },
    });
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n内容变化触发 update。\n' },
      ]);
      const rowB = fx.store.getKbPublication('b/b.md')!;
      const overwritesBefore = overwriteCalls(fx).length;
      const result = await fx.service.execute({ releaseId: 'rel-002', confirm: 'PUBLISH' });
      const b = result.items.find((i) => i.kbPath === 'b/b.md')!;
      expect(b.outcome).toBe('failed');
      expect(b.error).toContain('回退锚点');
      expect(overwriteCalls(fx).length).toBe(overwritesBefore);
      const row = fx.store.getKbPublication('b/b.md')!;
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain('回退锚点');
      expect(row.publishedContentHash).toBe(rowB.publishedContentHash); // 基线保留，可重试
      expect(fx.store.listSourcePushLogs(rowB.cloudToken!)).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  it('正常路径：overwrite 前落 push_log 锚点行，成功后 outcome=pushed + 写后时间', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n有锚点时的更新正文。\n' },
      ]);
      const result = await fx.service.execute({ releaseId: 'rel-002', confirm: 'PUBLISH' });
      expect(result.items.find((i) => i.kbPath === 'b/b.md')!.outcome).toBe('updated');
      const rowB = fx.store.getKbPublication('b/b.md')!;
      const logs = fx.store.listSourcePushLogs(rowB.cloudToken!);
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.mode).toBe('overwrite');
      expect(log.actor).toBe('publish:ui');
      expect(log.anchorHistoryId).toBe(`hist-${rowB.cloudToken}`);
      expect(log.preObjEditTime).toBe(String(BASE_TIME));
      expect(log.postObjEditTime).toBe(String(BASE_TIME));
      expect(log.outcome).toBe('pushed');
      // 锚点行先于云端 overwrite（historyList 调用在 overwrite 之前）
      const historyIdx = fx.lark.calls.findIndex((c) => c.op === 'historyList' && c.args[0] === rowB.cloudToken);
      const overwriteIdx = fx.lark.calls.findIndex((c) => c.op === 'overwrite' && c.args[0] === rowB.cloudToken);
      expect(historyIdx).toBeGreaterThanOrEqual(0);
      expect(overwriteIdx).toBeGreaterThan(historyIdx);
    } finally {
      fx.cleanup();
    }
  });

  it('push_log 落库失败 → 拒绝覆盖（云端零写入）', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n落库失败场景正文。\n' },
      ]);
      const rowB = fx.store.getKbPublication('b/b.md')!;
      const original = fx.store.insertSourcePushLog.bind(fx.store);
      (fx.store as unknown as Record<string, unknown>).insertSourcePushLog = (input: { actor: string }) => {
        if (input.actor.startsWith('publish:')) throw new Error('INJECTED sqlite failure');
        return original(input as never);
      };
      const overwritesBefore = overwriteCalls(fx).length;
      const result = await fx.service.execute({ releaseId: 'rel-002', confirm: 'PUBLISH' });
      const b = result.items.find((i) => i.kbPath === 'b/b.md')!;
      expect(b.outcome).toBe('failed');
      expect(b.error).toContain('锚点日志写入失败');
      expect(overwriteCalls(fx).length).toBe(overwritesBefore);
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('failed');
      void rowB;
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// T4b-06（create 部分）：写后结果不确定 → unknown，禁止普通重发
// ===========================================================================

describe('T4b-06 create 写后结果不确定 → unknown', () => {
  it('create 命令发出后解析失败（parse）→ unknown；普通重发被 state_unknown 阻断', async () => {
    const fx = makeFixture();
    try {
      let attempts = 0;
      const rawCreate = fx.lark.createDocumentMarkdown.bind(fx.lark);
      (fx.lark as unknown as Record<string, unknown>).createDocumentMarkdown =
        async (options: { title: string; markdown: string; parentToken: string }) => {
          attempts += 1;
          if (attempts === 1) throw new LarkCliError('bad JSON output', 'parse', false);
          return rawCreate(options);
        };
      const first = await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      expect(first.items[0].outcome).toBe('unknown');
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('unknown');
      // 不带 force 的普通重发：计划层面即被 state_unknown 阻断，不再 create
      const second = await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      expect(second.items[0].outcome).toBe('blocked');
      expect(second.items[0].error).toContain('state_unknown');
      expect(attempts).toBe(1);
      // force 重新发布为新文档（人工核对后的显式通道）可恢复
      const third = await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'], force: true });
      expect(third.items[0].outcome).toBe('created');
      expect(attempts).toBe(2);
    } finally {
      fx.cleanup();
    }
  });

  it('客户端：create 响应缺 document_id → LarkCliError incomplete_response（命令已发出）', async () => {
    const client = new LarkCliClient({ requiredScopes: [], timeout: 1000 });
    (client as unknown as Record<string, unknown>).execute = async () => ({
      data: { document: { revision_id: 1, url: 'https://x.feishu.cn/docx/docxMaybe1' } },
    });
    const error = await client.createDocumentMarkdown({ title: 't', markdown: 'x', parentToken: 'p' })
      .catch((e: unknown) => e as LarkCliError);
    expect(error).toBeInstanceOf(LarkCliError);
    expect((error as LarkCliError).code).toBe('incomplete_response');
    expect((error as LarkCliError).retryable).toBe(false);
  });

  it('服务分类：incomplete_response → unknown；写前校验错误（普通 Error）→ failed', async () => {
    const fx = makeFixture();
    try {
      (fx.lark as unknown as Record<string, unknown>).createDocumentMarkdown =
        async () => { throw new LarkCliError('missing document_id', 'incomplete_response', false); };
      const unknown = await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      expect(unknown.items[0].outcome).toBe('unknown');
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('unknown');

      (fx.lark as unknown as Record<string, unknown>).createDocumentMarkdown =
        async () => { throw new Error('createDocumentMarkdown requires a non-empty title'); };
      const failed = await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['dirA/a.md'] });
      expect(failed.items[0].outcome).toBe('failed');
      expect(fx.store.getKbPublication('dirA/a.md')!.state).toBe('failed');
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// T4b-07：旧云 token 谱系并入快照排除全集
// ===========================================================================

describe('T4b-07 发布产物 token 谱系', () => {
  it('force 重发后旧 token 仍在 listPublishedCloudTokens 全集（快照排除不丢身份）', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      const old = fx.store.getKbPublication('b/b.md')!;
      fx.store.upsertKbPublication({ ...old, state: 'unknown' });
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'], force: true });
      const row = fx.store.getKbPublication('b/b.md')!;
      expect(row.cloudToken).not.toBe(old.cloudToken);
      const tokens = fx.store.listPublishedCloudTokens();
      expect(tokens).toContain(old.cloudToken);
      expect(tokens).toContain(row.cloudToken);
    } finally {
      fx.cleanup();
    }
  });

  it('后续 update 的警告/状态更新不擦除 previousCloudTokens 谱系', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      const old = fx.store.getKbPublication('b/b.md')!;
      fx.store.upsertKbPublication({ ...old, state: 'unknown' });
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'], force: true });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n谱系保全场景正文。\n' },
      ]);
      const result = await fx.service.execute({ releaseId: 'rel-002', kbPaths: ['b/b.md'], confirm: 'PUBLISH' });
      expect(result.items[0].outcome).toBe('updated');
      const row = fx.store.getKbPublication('b/b.md')!;
      const warnings = JSON.parse(row.warningsJson!) as { previousCloudTokens?: string[] };
      expect(warnings.previousCloudTokens).toContain(old.cloudToken);
      expect(fx.store.listPublishedCloudTokens()).toContain(old.cloudToken);
    } finally {
      fx.cleanup();
    }
  });
});
