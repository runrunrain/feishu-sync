/**
 * P1-S8 反向发布测试（设计 P1 §4；P1-S7 renderForPublish / P1-S1 PB 定稿）。
 *
 * 覆盖任务书验收点：
 *   - 计划渲染→执行→回读校验全链（mock lark-cli；两遍发布互链回填）
 *   - 冲突 fail-closed（云端时间前进/不可读 → blocked publish_cloud_edited；
 *     force → update + 确认值升级 OVERWRITE_PUBLISHED）
 *   - creating 重启对账 → unknown（不重建）；unknown/cloud_missing 计划阻断
 *   - 门控双向校验（发布根在监听树内被拒 / 监听树在发布根内被拒 /
 *     祖先链不可解析 fail-closed）
 *   - 命令表登记 + 确认值派生（confirmPlan）+ config.set 禁改 feishuPublish
 *   - kb_publications 迁移双登记 + 行方法
 *   - 回读校验比值边界（publish_verify_mismatch / unavailable）
 *   - 404/981003 → cloud_missing；子进程超时 → unknown
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliError } from '../src/modules/lark-cli-client.js';
import { KbPublishService, PublicationError } from '../src/kb/publication-service.js';
import {
  checkPublishTargetOverlapCore,
  nodeTokenFromWikiUrl,
  parsePublishTargetUrl,
  resolveWikiAncestry,
  validatePublishTargetAgainstWatchedRoots,
  PUBLISH_VERIFY_RATIO_MIN,
  PUBLISH_VERIFY_RATIO_MAX,
} from '../src/kb/publication-service.js';
import { kbPublicationsRoutes } from '../src/routes/kb-publications.js';
import { countText } from '../src/kb/text-stats.js';
import { findOpsCommand, OpsArgumentError } from '../src/ops/command-table.js';
import type { PublishTargetConfig } from '../src/types/index.js';

const BASE_TIME = 1759000000;
const TARGET: PublishTargetConfig = { kind: 'drive_folder', token: 'fldcnPublishRoot01', label: '发布根' };

// ---------------------------------------------------------------------------
// lark-cli stub：云端状态模拟（createdDocs = 云端正文字面镜像）
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
      ready: true,
      verified: true,
      identity: 'user',
      currentScopes: ['docx:document:write_only', 'wiki:node:retrieve'],
      missingScopes: [],
    }),
    getDocumentMetas: async (reqs: Array<{ docToken: string; docType: string }>) => ({
      metas: reqs.map((req) => ({
        docToken: req.docToken,
        docType: req.docType,
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
      const id = `docxcnPub${String(seq).padStart(4, '0')}`;
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
    // T4b-04：发布 overwrite 写前锥点（与 source-push 同款默认锥点形态；
    // 无锥/失败场景用 larkOverrides 覆盖）。
    listDocumentHistory: async (token: string, opts?: { pageSize?: number }) => {
      calls.push({ op: 'historyList', args: [token, opts?.pageSize] });
      return {
        entries: [{
          historyVersionId: `hist-${token}`,
          revisionId: 9,
          editTime: new Date(BASE_TIME * 1000).toISOString(),
          editorIds: ['ou-test'],
          type: 2,
          raw: {},
        }],
        hasMore: false,
        nextPageToken: null,
      };
    },
    getNode: async (token: string) => ({ node_token: token, parent_node_token: '' }),
    ...overrides,
  };
  return stub;
}

// ---------------------------------------------------------------------------
// 标准库 release fixture（StandardKbStore 布局）
// ---------------------------------------------------------------------------

function writeRelease(
  outputRoot: string,
  releaseId: string,
  docs: Array<{ path: string; markdown: string }>,
): void {
  const releaseDir = path.join(outputRoot, 'releases', releaseId);
  fs.mkdirSync(path.join(releaseDir, 'docs'), { recursive: true });
  for (const doc of docs) {
    const file = path.join(releaseDir, 'docs', doc.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, doc.markdown, 'utf-8');
  }
  const manifest = {
    schemaVersion: 1,
    releaseId,
    buildId: `build-${releaseId}`,
    mode: 'incremental' as const,
    baseReleaseId: null,
    publishedAt: new Date().toISOString(),
    model: null,
    sourceSnapshot: [],
    skippedSources: [],
    docs: docs.map((doc, index) => ({
      docId: `doc-${index}`,
      path: doc.path,
      title: path.basename(doc.path, '.md'),
      summary: '',
      headings: [],
      tags: [],
      sources: [`src-${index}`],
      contentHash: `h-${releaseId}-${index}`,
      updatedInBuild: `build-${releaseId}`,
    })),
  };
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  fs.writeFileSync(
    path.join(outputRoot, 'CURRENT.json'),
    JSON.stringify({ schemaVersion: 1, releaseId, publishedAt: manifest.publishedAt }),
    'utf-8',
  );
}

const DOC_A = [
  '<!--',
  'feishu_sync_kb:',
  '  doc_id: doc-0',
  `  build_id: build-rel-001`,
  '  sources:',
  '    - src-0',
  '-->',
  '',
  '# 标题A',
  '',
  '参见 [B篇](../b/b.md)。',
  '',
  '正文A内容。',
  '',
].join('\n');

const DOC_B = [
  '# 标题B',
  '',
  '正文B内容。',
  '',
].join('\n');

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
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s8-kb-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s8-data-'));
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

async function expectError(fn: () => Promise<unknown>, code: string): Promise<PublicationError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).code).toBe(code);
    return error as PublicationError;
  }
  throw new Error(`expected PublicationError ${code}`);
}

// ===========================================================================
// A. 计划 → 执行 → 回读校验全链（两遍发布）
// ===========================================================================

describe('KbPublishService — 计划', () => {
  it('全新 release：全部 create，planKey = releaseId|kbPath:action 排序拼接', async () => {
    const fx = makeFixture();
    try {
      const plan = await fx.service.plan({});
      expect(plan.releaseId).toBe('rel-001');
      expect(plan.items.map((i) => [i.kbPath, i.action])).toEqual([
        ['b/b.md', 'create'],
        ['dirA/a.md', 'create'],
      ]);
      expect(plan.planKey).toBe('rel-001|b/b.md:create,dirA/a.md:create');
      expect(plan.target).toEqual(TARGET);
      // dirA/a.md 链接未发布的 b/b.md → 渲染警告 link_target_unpublished
      const a = plan.items.find((i) => i.kbPath === 'dirA/a.md')!;
      expect(a.warnings.some((w) => w.code === 'link_target_unpublished')).toBe(true);
      expect(plan.gates).toMatchObject({ feishuWriteEnabled: true, writeScopesGranted: true, publishEnabled: true, targetConfigured: true });
      expect(plan.confirmRequired).toBe('PUBLISH');
    } finally {
      fx.cleanup();
    }
  });

  it('kbPaths 指定不存在路径 → kb_doc_not_found；空数组/形态非法 → invalid_request', async () => {
    const fx = makeFixture();
    try {
      await expectError(() => fx.service.plan({ kbPaths: ['nope.md'] }), 'kb_doc_not_found');
      await expectError(() => fx.service.plan({ kbPaths: [] }), 'invalid_request');
      await expectError(() => fx.service.plan({ releaseId: '../evil' }), 'invalid_request');
      await expectError(() => fx.service.plan({}), 'kb_not_published').catch(async () => {
        /* rel-001 存在，此路径不应走到 */
      });
    } finally {
      fx.cleanup();
    }
  });

  it('manifest 引用缺失文件 → blocked(render_failed)', async () => {
    const fx = makeFixture();
    try {
      fs.rmSync(path.join(fx.outputRoot, 'releases/rel-001/docs/b/b.md'));
      const plan = await fx.service.plan({});
      const ghost = plan.items.find((i) => i.kbPath === 'b/b.md')!;
      expect(ghost.action).toBe('blocked');
      expect(ghost.blockedReason).toBe('render_failed');
    } finally {
      fx.cleanup();
    }
  });

  it('无 CURRENT 发布 → 缺省 kb_not_published；显式 releaseId 仍可发布（release 不可变）', async () => {
    const fx = makeFixture();
    try {
      fs.rmSync(path.join(fx.outputRoot, 'CURRENT.json'));
      await expectError(() => fx.service.plan({}), 'kb_not_published');
      const plan = await fx.service.plan({ releaseId: 'rel-001' });
      expect(plan.releaseId).toBe('rel-001');
      expect(plan.items).toHaveLength(2);
    } finally {
      fx.cleanup();
    }
  });
});

describe('KbPublishService — 执行全链（两遍发布）', () => {
  it('首发布：create ×2 → 互链回填后对 hash 变化文档 overwrite 一次', async () => {
    const fx = makeFixture();
    try {
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      expect(result.counts).toMatchObject({ created: 2, updated: 0, skipped: 0, blocked: 0, secondPass: 1 });
      const creates = fx.lark.calls.filter((c) => c.op === 'create');
      expect(creates).toHaveLength(2);
      expect((creates[0].args[0] as { title: string }).title).toBe('标题B');
      // 第二遍：dirA/a.md 的链接改写为 b 的云端 URL → hash 变化 → overwrite 一次
      const overwrites2 = fx.lark.calls.filter((c) => c.op === 'overwrite');
      expect(overwrites2).toHaveLength(1);
      // 行状态与基线
      const rowA = fx.store.getKbPublication('dirA/a.md')!;
      const rowB = fx.store.getKbPublication('b/b.md')!;
      expect(rowA.state).toBe('published');
      expect(rowB.state).toBe('published');
      expect(rowA.publishedObjEditTime).toBe(String(BASE_TIME));
      expect(rowB.publishedReleaseId).toBe('rel-001');
      // 第二遍 overwrite 的正文包含 b 的云端 URL（互链完整）
      const bRow = fx.store.getKbPublication('b/b.md')!;
      const overwriteBody = String(overwrites2[0].args[1]);
      expect(overwriteBody).toContain(bRow.cloudUrl);
      expect(rowA.publishedContentHash).not.toBe(rowB.publishedContentHash);
      // title 经 --title 单独传（P1-S1：CLI 不去重 H1，同名 H1 已被本地移除）
      const aCreate = creates.find((c) => (c.args[0] as { title: string }).title === '标题A')!;
      expect((aCreate.args[0] as { markdown: string }).markdown).not.toContain('# 标题A');
      expect((aCreate.args[0] as { markdown: string }).markdown).not.toMatch(/^#\s/m);
      // 审计
      const audit = fs.readFileSync(path.join(fx.dataRoot, 'agent/audit/kb-publish.jsonl'), 'utf-8')
        .trim().split('\n').map((line) => JSON.parse(line) as { event: string });
      expect(audit.map((e) => e.event)).toEqual(
        expect.arrayContaining(['publish_started', 'item_created', 'item_created', 'item_updated', 'publish_finished']),
      );
    } finally {
      fx.cleanup();
    }
  });

  it('无变更再发布：全部 skip_unchanged，零云端写调用', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      const plan = await fx.service.plan({});
      expect(plan.items.every((i) => i.action === 'skip_unchanged')).toBe(true);
      expect(plan.confirmRequired).toBe('PUBLISH');
      const writesBefore = fx.lark.calls.filter((c) => c.op === 'create' || c.op === 'overwrite').length;
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      expect(result.counts.skipped).toBe(2);
      const writesAfter = fx.lark.calls.filter((c) => c.op === 'create' || c.op === 'overwrite').length;
      expect(writesAfter).toBe(writesBefore);
    } finally {
      fx.cleanup();
    }
  });

  it('内容变化 → update（三段式 revision + overwrite + 回读）', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n正文B内容更新版本。\n' },
      ]);
      const plan = await fx.service.plan({});
      expect(plan.items.find((i) => i.kbPath === 'b/b.md')!.action).toBe('update');
      const result = await fx.service.execute({ confirm: 'PUBLISH', releaseId: 'rel-002' });
      expect(result.counts.updated).toBe(1);
      const row = fx.store.getKbPublication('b/b.md')!;
      expect(row.publishedReleaseId).toBe('rel-002');
      const overwrites = fx.lark.calls.filter((c) => c.op === 'overwrite');
      expect(overwrites.length).toBeGreaterThanOrEqual(1);
      // fetchDocumentRevision 先于 overwrite（三段式）
      const fetchCalls = fx.lark.calls.filter((c) => c.op === 'fetchRevision');
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      fx.cleanup();
    }
  });

  it('门控：publish 关 / feishuWrite 关 / scope 缺 / target 缺 → 各拒绝码', async () => {
    const fx = makeFixture();
    try {
      (fx.config.feishuPublish as { enabled: boolean }).enabled = false;
      await expectError(() => fx.service.execute({ confirm: 'PUBLISH' }), 'publish_disabled');
      (fx.config.feishuPublish as { enabled: boolean }).enabled = true;
      (fx.config.feishuWrite as { enabled: boolean }).enabled = false;
      await expectError(() => fx.service.execute({ confirm: 'PUBLISH' }), 'feishu_write_disabled');
      (fx.config.feishuWrite as { enabled: boolean }).enabled = true;
      (fx.lark as Record<string, unknown>).checkAuthReady = async () => ({ ready: true, currentScopes: [], missingScopes: ['docx:document:write_only'] });
      await expectError(() => fx.service.execute({ confirm: 'PUBLISH' }), 'feishu_write_scope_missing');
      (fx.lark as Record<string, unknown>).checkAuthReady = async () => ({ ready: true, currentScopes: ['docx:document:write_only'], missingScopes: [] });
      // enabled 但无 target → publish_target_not_configured（enabled 关是另一门）
      (fx.config as Record<string, unknown>).feishuPublish = { enabled: true };
      await expectError(() => fx.service.execute({ confirm: 'PUBLISH' }), 'publish_target_not_configured');
    } finally {
      fx.cleanup();
    }
  });

  it('确认门：confirm 错值 / planKey 过期 → 拒绝且零写调用', async () => {
    const fx = makeFixture();
    try {
      await expectError(() => fx.service.execute({ confirm: 'WRONG' }), 'confirmation_required');
      await expectError(() => fx.service.execute({ confirm: 'PUBLISH', planKey: 'stale' }), 'publish_plan_changed');
      expect(fx.lark.calls.filter((c) => c.op === 'create')).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});

describe('KbPublishService — 回读校验（§4.5）', () => {
  it('比值越界 → published_with_warnings + publish_verify_mismatch{local,cloud}', async () => {
    const fx = makeFixture();
    try {
      (fx.lark as Record<string, unknown>).parseDocumentProfile = async () => ({ charCount: 99999, wordCount: 1, blockCount: 1 });
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      for (const item of result.items.filter((i) => i.outcome === 'created')) {
        expect(item.state).toBe('published_with_warnings');
        expect(item.warnings.some((w) => w.code === 'publish_verify_mismatch' && typeof w.local === 'number' && typeof w.cloud === 'number')).toBe(true);
      }
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('published_with_warnings');
    } finally {
      fx.cleanup();
    }
  });

  it('parse 失败 → publish_verify_unavailable，不判失败', async () => {
    const fx = makeFixture();
    try {
      (fx.lark as Record<string, unknown>).parseDocumentProfile = async () => { throw new Error('parse down'); };
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      expect(result.counts.created).toBe(2);
      expect(result.items.every((i) => i.outcome === 'created' || i.outcome === 'updated')).toBe(true);
      expect(fx.store.getKbPublication('dirA/a.md')!.state).toBe('published_with_warnings');
      const warnings = JSON.parse(fx.store.getKbPublication('dirA/a.md')!.warningsJson!) as { warnings: Array<{ code: string }> };
      expect(warnings.warnings.some((w) => w.code === 'publish_verify_unavailable')).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('区间常量与比值口径（P1-S1：cloud ≈ 不含 title 的正文可见字符）', () => {
    expect(PUBLISH_VERIFY_RATIO_MIN).toBe(0.8);
    expect(PUBLISH_VERIFY_RATIO_MAX).toBe(1.25);
    expect(countText('# 标题\n\n正文十个字符。').chars).toBeGreaterThan(0);
  });
});

// ===========================================================================
// B. 冲突 fail-closed（§4.4 update 前置时间门）
// ===========================================================================

describe('KbPublishService — 冲突 fail-closed', () => {
  it('云端时间越过发布基线 → blocked(publish_cloud_edited)，行置 conflict，零写调用', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      // KB 内容变化（hash 不同才会进 update 时间门；hash 相同按契约 skip）
      writeRelease(fx.outputRoot, 'rel-c1', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n被同事在云端改过后本地文也变更了。\n' },
      ]);
      const row = fx.store.getKbPublication('b/b.md')!;
      fx.lark.metaTimes.set(row.cloudToken!, BASE_TIME + 500);
      const plan = await fx.service.plan({ releaseId: 'rel-c1', kbPaths: ['b/b.md'] });
      const item = plan.items.find((i) => i.kbPath === 'b/b.md')!;
      expect(item.action).toBe('blocked');
      expect(item.blockedReason).toBe('publish_cloud_edited');
      expect(item.cloudEdited).toBe(true);
      expect(plan.confirmRequired).toBe('PUBLISH'); // 无 force 不升级
      const writesBefore = fx.lark.calls.filter((c) => c.op === 'overwrite').length;
      const result = await fx.service.execute({ releaseId: 'rel-c1', kbPaths: ['b/b.md'], confirm: 'PUBLISH' });
      expect(result.counts.blocked).toBe(1);
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('conflict');
      expect(fx.store.getKbPublication('b/b.md')!.lastError).toContain('publish_cloud_edited');
      expect(fx.lark.calls.filter((c) => c.op === 'overwrite').length).toBe(writesBefore);
    } finally {
      fx.cleanup();
    }
  });

  it('云端时间不可读 → 同样 fail-closed（publish_cloud_edited）', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      writeRelease(fx.outputRoot, 'rel-c2', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n时间门不可读场景正文。\n' },
      ]);
      const row = fx.store.getKbPublication('b/b.md')!;
      fx.lark.metaTimes.set(row.cloudToken!, null);
      const plan = await fx.service.plan({ releaseId: 'rel-c2', kbPaths: ['b/b.md'] });
      expect(plan.items[0].blockedReason).toBe('publish_cloud_edited');
    } finally {
      fx.cleanup();
    }
  });

  it('force → 计划动作 update、确认值升级 OVERWRITE_PUBLISHED，执行覆盖', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      writeRelease(fx.outputRoot, 'rel-c3', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\nforce 覆盖场景正文。\n' },
      ]);
      const row = fx.store.getKbPublication('b/b.md')!;
      fx.lark.metaTimes.set(row.cloudToken!, BASE_TIME + 500);
      const plan = await fx.service.plan({ releaseId: 'rel-c3', kbPaths: ['b/b.md'], force: true });
      expect(plan.items[0].action).toBe('update');
      expect(plan.confirmRequired).toBe('OVERWRITE_PUBLISHED');
      // 旧确认值被拒
      await expectError(() => fx.service.execute({ releaseId: 'rel-c3', kbPaths: ['b/b.md'], force: true, confirm: 'PUBLISH' }), 'confirmation_required');
      const result = await fx.service.execute({ releaseId: 'rel-c3', kbPaths: ['b/b.md'], force: true, confirm: 'OVERWRITE_PUBLISHED' });
      expect(result.counts.updated).toBe(1);
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('published');
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// C. creating 重启对账 / unknown / cloud_missing / 超时 / kb_removed
// ===========================================================================

describe('KbPublishService — 状态机边界', () => {
  it('LMS 启动对账：creating → unknown（不重建，人工核对），幂等', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s8-rec-'));
    try {
      const store = new LocalMapStore(path.join(dataRoot, 'rec.db'));
      store.initialize();
      store.upsertKbPublication({ kbPath: 'x.md', targetToken: 't', state: 'creating' });
      store.upsertKbPublication({ kbPath: 'y.md', targetToken: 't', state: 'published', cloudToken: 'tok1' });
      expect(store.reconcileKbPublicationsCreating()).toBe(1);
      expect(store.getKbPublication('x.md')!.state).toBe('unknown');
      expect(store.getKbPublication('x.md')!.lastError).toContain('发布中断');
      expect(store.getKbPublication('y.md')!.state).toBe('published');
      expect(store.reconcileKbPublicationsCreating()).toBe(0);
      store.close();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('unknown / creating 计划 → blocked(state_unknown)；force → 重新发布为新文档（旧 token 归档）', async () => {
    const fx = makeFixture();
    try {
      fx.store.upsertKbPublication({
        kbPath: 'b/b.md', targetToken: TARGET.token, state: 'unknown',
        cloudToken: 'docxOldUncertain01', cloudUrl: 'https://x.feishu.cn/docx/docxOldUncertain01',
        warningsJson: JSON.stringify({ warnings: [] }),
      });
      let plan = await fx.service.plan({ kbPaths: ['b/b.md'] });
      expect(plan.items[0].action).toBe('blocked');
      expect(plan.items[0].blockedReason).toBe('state_unknown');
      plan = await fx.service.plan({ kbPaths: ['b/b.md'], force: true });
      expect(plan.items[0].action).toBe('create');
      expect(plan.confirmRequired).toBe('PUBLISH');
      const result = await fx.service.execute({ kbPaths: ['b/b.md'], force: true, confirm: 'PUBLISH' });
      expect(result.counts.created).toBe(1);
      const row = fx.store.getKbPublication('b/b.md')!;
      expect(row.state).toBe('published');
      const warnings = JSON.parse(row.warningsJson!) as { previousCloudTokens?: string[] };
      expect(warnings.previousCloudTokens).toContain('docxOldUncertain01');
      expect(row.cloudToken).not.toBe('docxOldUncertain01');
    } finally {
      fx.cleanup();
    }
  });

  it('cloud_missing → blocked；404/981003 on update → cloud_missing（不重建）；超时 → unknown', async () => {
    const fx = makeFixture();
    try {
      // 首发布后把 b 置 cloud_missing
      await fx.service.execute({ confirm: 'PUBLISH' });
      fx.store.upsertKbPublication({ ...fx.store.getKbPublication('b/b.md')!, state: 'cloud_missing' });
      let plan = await fx.service.plan({ kbPaths: ['b/b.md'] });
      expect(plan.items[0].blockedReason).toBe('cloud_missing');
      // 内容也变化一下再强制重建
      writeRelease(fx.outputRoot, 'rel-003', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n全新正文。\n' },
      ]);
      plan = await fx.service.plan({ kbPaths: ['b/b.md'], releaseId: 'rel-003', force: true });
      expect(plan.items[0].action).toBe('create');

      // 404 on update：a 已发布但云端 404
      const rowA = fx.store.getKbPublication('dirA/a.md')!;
      (fx.lark as Record<string, unknown>).fetchDocumentRevision = async () => {
        throw new LarkCliError('doc not found: 404 (981003)', 'not_found', false, '981003');
      };
      writeRelease(fx.outputRoot, 'rel-004', [
        { path: 'dirA/a.md', markdown: '# 标题A\n\n更新后的 A。\n' },
        { path: 'b/b.md', markdown: DOC_B },
      ]);
      const result = await fx.service.execute({ releaseId: 'rel-004', confirm: 'PUBLISH' });
      const a = result.items.find((i) => i.kbPath === 'dirA/a.md')!;
      expect(a.outcome).toBe('cloud_missing');
      expect(fx.store.getKbPublication('dirA/a.md')!.state).toBe('cloud_missing');
      void rowA;

      // 超时 → unknown（写入结果未知）
      (fx.lark as Record<string, unknown>).createDocumentMarkdown = async () => {
        throw new LarkCliError('lark-cli 执行超时', 'timeout', true);
      };
      const result2 = await fx.service.execute({
        releaseId: 'rel-004', kbPaths: ['b/b.md'], force: true, confirm: 'PUBLISH',
      });
      expect(result2.items[0].outcome).toBe('unknown');
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('unknown');
    } finally {
      fx.cleanup();
    }
  });

  it('kb_removed：全量发布标记 KB 中已删除路径（零远端动作）；路径重现 → update 沿用旧 token', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH' });
      const bRow = fx.store.getKbPublication('b/b.md')!;
      // 新 release 移除 b/b.md
      writeRelease(fx.outputRoot, 'rel-005', [{ path: 'dirA/a.md', markdown: DOC_A }]);
      let plan = await fx.service.plan({ releaseId: 'rel-005' });
      expect(plan.removed).toEqual(['b/b.md']);
      const writesBefore = fx.lark.calls.filter((c) => c.op === 'create' || c.op === 'overwrite').length;
      const result = await fx.service.execute({ releaseId: 'rel-005', confirm: 'PUBLISH' });
      expect(result.removedMarked).toEqual(['b/b.md']);
      expect(fx.store.getKbPublication('b/b.md')!.state).toBe('kb_removed');
      expect(fx.lark.calls.filter((c) => c.op === 'create' || c.op === 'overwrite').length).toBe(writesBefore);
      // 子集模式不触发 removed 标记
      plan = await fx.service.plan({ releaseId: 'rel-005', kbPaths: ['dirA/a.md'] });
      expect(plan.removed).toEqual([]);
      // b/b.md 重现（内容变化）→ update 沿用旧 cloud_token
      writeRelease(fx.outputRoot, 'rel-006', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n回归的 B 正文。\n' },
      ]);
      plan = await fx.service.plan({ releaseId: 'rel-006' });
      expect(plan.items.find((i) => i.kbPath === 'b/b.md')!.action).toBe('update');
      expect(plan.items.find((i) => i.kbPath === 'b/b.md')!.cloudToken).toBe(bRow.cloudToken);
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// D. 门控双向校验（§4.1 防线 1：发布根 × watchedRoots）
// ===========================================================================

describe('发布根双向校验', () => {
  const watched = [{ id: 'wikcnWatchedRoot01', url: 'https://x.feishu.cn/wiki/wikcnWatchedRoot01' }];

  it('纯核心：target == watchedRoot 身份 → publish_target_inside_watched_root', () => {
    const result = checkPublishTargetOverlapCore({
      target: { kind: 'wiki_node', token: 'wikcnWatchedRoot01', label: 'x' },
      watchedRoots: watched,
      targetAncestors: [],
      watchedAncestorsByRootId: {},
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('publish_target_inside_watched_root');
  });

  it('纯核心：target 祖先链命中 watchedRoot → 方向 A 拒绝；watchedRoot 祖先链含 target → 方向 B 拒绝', () => {
    const a = checkPublishTargetOverlapCore({
      target: { kind: 'wiki_node', token: 'wikcnDeepChild0001', label: 'x' },
      watchedRoots: watched,
      targetAncestors: ['wikcnMidNode00001', 'wikcnWatchedRoot01'],
      watchedAncestorsByRootId: {},
    });
    expect(!a.ok && a.code).toBe('publish_target_inside_watched_root');
    const b = checkPublishTargetOverlapCore({
      target: { kind: 'wiki_node', token: 'wikcnPublishPare', label: 'x' },
      watchedRoots: watched,
      targetAncestors: [],
      watchedAncestorsByRootId: { wikcnWatchedRoot01: ['wikcnPublishPare'] },
    });
    expect(!b.ok && b.code).toBe('watched_root_inside_publish_target');
    // 互不相干 → ok
    const c = checkPublishTargetOverlapCore({
      target: { kind: 'wiki_node', token: 'wikcnElsewhere001', label: 'x' },
      watchedRoots: watched,
      targetAncestors: ['wikcnOtherAncest01'],
      watchedAncestorsByRootId: { wikcnWatchedRoot01: ['wikcnSpaceRoot0001'] },
    });
    expect(c.ok).toBe(true);
  });

  it('纯核心：drive_folder 与 wiki 子树不同命名空间 → 双向天然不重叠', () => {
    const result = checkPublishTargetOverlapCore({
      target: { kind: 'drive_folder', token: 'fldcnAnywhere0001', label: 'x' },
      watchedRoots: watched,
      targetAncestors: [],
      watchedAncestorsByRootId: {},
    });
    expect(result.ok).toBe(true);
  });

  it('resolveWikiAncestry：父链上溯、深度截断、环路停止', async () => {
    const parents: Record<string, string> = {
      child: 'mid', mid: 'root', root: '',
    };
    const ancestors = await resolveWikiAncestry(async (token) => ({ parent_node_token: parents[token] ?? '' }), 'child', 2);
    expect(ancestors).toEqual(['mid', 'root']);
    // 环路：a→b→a 停止
    const loop: Record<string, string> = { a: 'b', b: 'a' };
    const loopAncestors = await resolveWikiAncestry(async (token) => ({ parent_node_token: loop[token] ?? '' }), 'a', 50);
    expect(loopAncestors).toEqual(['b']);
  });

  it('validatePublishTargetAgainstWatchedRoots：getNode 失败 → fail-closed unverifiable', async () => {
    const result = await validatePublishTargetAgainstWatchedRoots(
      { kind: 'wiki_node', token: 'wikcnUnreadable01', label: 'x' },
      watched,
      async () => { throw new Error('permission denied'); },
    );
    expect(!result.ok && result.code).toBe('publish_target_unverifiable');
  });

  it('parsePublishTargetUrl / nodeTokenFromWikiUrl', () => {
    expect(parsePublishTargetUrl('https://x.feishu.cn/drive/folder/fldcnPublishRoot01')).toEqual({ kind: 'drive_folder', token: 'fldcnPublishRoot01' });
    expect(parsePublishTargetUrl('https://x.feishu.cn/wiki/wikcnNode0000001?from=x')).toEqual({ kind: 'wiki_node', token: 'wikcnNode0000001' });
    expect(parsePublishTargetUrl('https://x.feishu.cn/docx/docxcnSomething1')).toBeNull();
    expect(nodeTokenFromWikiUrl('https://x.feishu.cn/wiki/wikcnWatchedRoot01')).toBe('wikcnWatchedRoot01');
  });

  it('执行门：发布根 token 等于 watchedRoot → publish_target_invalid（廉价复核）', async () => {
    const fx = makeFixture({
      configOverrides: {
        feishuPublish: { enabled: true, target: { kind: 'wiki_node', token: 'wikcnWatchedRoot01', label: '发布根' } },
        watchedRoots: [{ id: 'wikcnWatchedRoot01', url: 'https://x.feishu.cn/wiki/wikcnWatchedRoot01', localDir: 'w', layoutProfile: 'flat', enabled: true }],
      },
    });
    try {
      await expectError(() => fx.service.execute({ confirm: 'PUBLISH' }), 'publish_target_invalid');
    } finally {
      fx.cleanup();
    }
  });
});

describe('routes — PUT /api/kb/publish/target', () => {
  function makeApp(fx: Fixture) {
    const app = new Hono();
    app.route('/', kbPublicationsRoutes({
      configManager: fx.configManager as never,
      localMapStore: fx.store,
      larkCliClient: fx.lark,
      dataRoot: fx.dataRoot,
    }));
    return app;
  }

  it('粘贴 wiki URL 祖先命中 watchedRoot → 409 publish_target_inside_watched_root', async () => {
    const fx = makeFixture({
      configOverrides: {
        watchedRoots: [{ id: 'wikcnWatchedRoot01', url: 'https://x.feishu.cn/wiki/wikcnWatchedRoot01', localDir: 'w', layoutProfile: 'flat', enabled: true }],
      },
    });
    try {
      (fx.lark as Record<string, unknown>).getNode = async (token: string) => ({
        node_token: token,
        parent_node_token: token === 'wikcnDeepChild0001' ? 'wikcnWatchedRoot01' : '',
      });
      const app = makeApp(fx);
      const res = await app.request('/api/kb/publish/target', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.feishu.cn/wiki/wikcnDeepChild0001' }),
      });
      expect(res.status).toBe(409);
      const json = await res.json() as { error: string };
      expect(json.error).toBe('publish_target_inside_watched_root');
    } finally {
      fx.cleanup();
    }
  });

  it('drive_folder URL → 校验通过并写入配置；target:null 清除', async () => {
    const fx = makeFixture();
    try {
      const app = makeApp(fx);
      const res = await app.request('/api/kb/publish/target', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.feishu.cn/drive/folder/fldcnNewRoot00001', label: '新发布根' }),
      });
      expect(res.status).toBe(200);
      const publish = (fx.config as { feishuPublish?: { target?: PublishTargetConfig } }).feishuPublish!;
      expect(publish.target).toMatchObject({ kind: 'drive_folder', token: 'fldcnNewRoot00001', label: '新发布根' });
      const res2 = await app.request('/api/kb/publish/target', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: null }),
      });
      expect(res2.status).toBe(200);
      expect((fx.config as { feishuPublish?: { target?: unknown } }).feishuPublish!.target).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  it('CLI 主体 → 403；无效 URL → 400', async () => {
    const fx = makeFixture();
    try {
      const app = makeApp(fx);
      const res = await app.request('/api/kb/publish/target', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'X-Feishu-Sync-Actor': 'cli' },
        body: JSON.stringify({ url: 'https://x.feishu.cn/drive/folder/fldcnNewRoot00001' }),
      });
      expect(res.status).toBe(403);
      const res2 = await app.request('/api/kb/publish/target', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/nope' }),
      });
      expect(res2.status).toBe(400);
    } finally {
      fx.cleanup();
    }
  });
});

describe('routes — publish/preview/publish/publications', () => {
  it('preview 返回计划 DTO；publish 走确认门；详情/列表', async () => {
    const fx = makeFixture();
    try {
      const app = new Hono();
      app.route('/', kbPublicationsRoutes({
        configManager: fx.configManager as never,
        localMapStore: fx.store,
        larkCliClient: fx.lark,
        dataRoot: fx.dataRoot,
      }));
      const preview = await app.request('/api/kb/publish/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(preview.status).toBe(200);
      const plan = await preview.json() as { planKey: string; items: unknown[]; confirmRequired: string };
      expect(plan.items).toHaveLength(2);
      const missingConfirm = await app.request('/api/kb/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'NOPE' }),
      });
      expect(missingConfirm.status).toBe(400);
      const ok = await app.request('/api/kb/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: plan.confirmRequired, planKey: plan.planKey }),
      });
      expect(ok.status).toBe(200);
      const list = await app.request('/api/kb/publications');
      expect(list.status).toBe(200);
      const listJson = await list.json() as { publications: Array<{ kbPath: string; state: string }> };
      expect(listJson.publications.map((p) => p.kbPath).sort()).toEqual(['b/b.md', 'dirA/a.md']);
      const detail = await app.request(`/api/kb/publications/${encodeURIComponent('dirA/a.md')}`);
      expect(detail.status).toBe(200);
      const detailJson = await detail.json() as { kbPath: string; warnings: { warnings: unknown[] } };
      expect(detailJson.kbPath).toBe('dirA/a.md');
      expect(Array.isArray(detailJson.warnings.warnings)).toBe(true);
      const none = await app.request('/api/kb/publications/ghost.md');
      expect(none.status).toBe(404);
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// E. 命令表登记 + 确认值派生（CLI / app_command 双通道）
// ===========================================================================

describe('命令表 — kb.publish-preview / kb.publish / kb.publications（P1-S8 登记）', () => {
  it('三条命令已登记：风险级、agentExposed、路由映射', () => {
    const preview = findOpsCommand('kb.publish-preview')!;
    expect(preview.risk).toBe('read');
    expect(preview.agentExposed).toBe(true);
    expect(preview.request({})[0]).toMatchObject({ method: 'POST', path: '/api/kb/publish/preview' });

    const publish = findOpsCommand('kb.publish')!;
    expect(publish.risk).toBe('remote_write');
    expect(publish.agentExposed).toBe(true);
    expect(publish.confirm).toEqual({ field: 'confirm', value: 'PUBLISH' });
    const spec = publish.request({})[0];
    expect(spec.method).toBe('POST');
    expect(spec.path).toBe('/api/kb/publish');
    expect((spec.body as Record<string, unknown>).actor).toBe('cli');
    expect((spec.body as Record<string, unknown>).confirm).toBe('PUBLISH');
    // force 静态猜测升级（与 source.push 同款基线）
    expect((publish.request({ force: true })[0].body as Record<string, unknown>).confirm).toBe('OVERWRITE_PUBLISHED');

    const publications = findOpsCommand('kb.publications')!;
    expect(publications.risk).toBe('read');
    expect(publications.request({})[0]).toMatchObject({ method: 'GET', path: '/api/kb/publications' });
  });

  it('kb.publish-preview 请求体透传 releaseId/kbPaths/force', () => {
    const preview = findOpsCommand('kb.publish-preview')!;
    const spec = preview.request({ releaseId: 'rel-001', kbPaths: ['a.md'], force: true })[0];
    expect(spec.body).toEqual({ releaseId: 'rel-001', kbPaths: ['a.md'], force: true });
  });

  it('confirmPlan：force 且含被解除冲突 → OVERWRITE_PUBLISHED；否则 PUBLISH', () => {
    const publish = findOpsCommand('kb.publish')!;
    const plan = publish.confirmPlan!;
    const previewJson = {
      planKey: 'rel-001|a.md:update',
      items: [
        { kbPath: 'a.md', action: 'update', cloudEdited: true },
        { kbPath: 'b.md', action: 'create', cloudEdited: false },
      ],
    };
    expect(plan.deriveConfirm(previewJson, { force: true })).toBe('OVERWRITE_PUBLISHED');
    expect(plan.deriveConfirm(previewJson, {})).toBe('PUBLISH');
    expect(plan.planKey(previewJson)).toBe('rel-001|a.md:update');
    const noConflict = { planKey: 'r|a.md:create', items: [{ action: 'create', cloudEdited: false }] };
    expect(plan.deriveConfirm(noConflict, { force: true })).toBe('PUBLISH');
  });

  it('confirmPlan：全部阻断（无可执行项）→ OpsArgumentError，不发起发布', () => {
    const publish = findOpsCommand('kb.publish')!;
    expect(() => publish.confirmPlan!.deriveConfirm(
      { items: [{ action: 'blocked', blockedReason: 'publish_cloud_edited', cloudEdited: true }] },
      { force: true },
    )).toThrow(OpsArgumentError);
  });

  it('config.set feishuPublish.* 被 CLI 通道拒绝（与 feishuWrite 同门）', () => {
    const configSet = findOpsCommand('config.set')!;
    expect(() => configSet.request({ path: 'feishuPublish', value: { enabled: true } })).toThrow(OpsArgumentError);
    expect(() => configSet.request({ path: 'feishuPublish.target', value: { kind: 'drive_folder' } })).toThrow(OpsArgumentError);
  });
});

// ===========================================================================
// F. 迁移双登记 + LMS 行方法 + 快照排除数据面
// ===========================================================================

describe('LocalMapStore — kb_publications 迁移与行方法', () => {
  function makeStore(): { store: LocalMapStore; dbPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s8-lms-'));
    const dbPath = path.join(dir, 'test.db');
    const store = new LocalMapStore(dbPath);
    store.initialize();
    return { store, dbPath };
  }

  it('新库建表 + 索引 + state CHECK 约束（DDL 登记）', () => {
    const { store, dbPath } = makeStore();
    try {
      const db = new Database(dbPath, { readonly: true });
      const columns = (db.prepare('PRAGMA table_info(kb_publications)').all() as Array<{ name: string }>).map((c) => c.name);
      db.close();
      expect(columns).toEqual([
        'kb_path', 'cloud_token', 'cloud_url', 'target_token', 'published_release_id',
        'published_content_hash', 'published_obj_edit_time', 'state',
        'warnings_json', 'last_error', 'created_at', 'updated_at',
      ]);
      const db2 = new Database(dbPath, { readonly: true });
      const indexes = (db2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='kb_publications'").all() as Array<{ name: string }>).map((r) => r.name);
      db2.close();
      expect(indexes).toContain('idx_kb_publications_cloud');
      // 非法 state 被 CHECK 拒绝
      expect(() => store.upsertKbPublication({ kbPath: 'bad.md', targetToken: 't', state: 'nonsense' as string })).toThrow();
    } finally {
      store.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it('双登记一致：applyAdditiveMigrations exec 与 getCreateTablesDDL 两处登记（源码级防漂移）', () => {
    const source = fs.readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/modules/local-map-store.ts'),
      'utf-8',
    );
    const occurrences = source.match(/CREATE TABLE IF NOT EXISTS kb_publications/g) ?? [];
    expect(occurrences.length).toBe(2);
    // 表被删（模拟旧库/漂移）后重跑 initialize() 恢复
    const { store, dbPath } = makeStore();
    try {
      const db = new Database(dbPath);
      db.exec('DROP TABLE kb_publications');
      db.close();
      store.initialize();
      expect(store.getKbPublication('x.md')).toBeNull();
      store.upsertKbPublication({ kbPath: 'x.md', targetToken: 't', state: 'published', cloudToken: 'tok9' });
      expect(store.getKbPublication('x.md')!.cloudToken).toBe('tok9');
    } finally {
      store.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it('upsert 保留 created_at / 更新 updated_at；listPublishedCloudTokens 排除空 token', async () => {
    const { store, dbPath } = makeStore();
    try {
      store.upsertKbPublication({ kbPath: 'a.md', targetToken: 't', state: 'creating' });
      const first = store.getKbPublication('a.md')!;
      await new Promise((resolve) => setTimeout(resolve, 20));
      store.upsertKbPublication({ kbPath: 'a.md', targetToken: 't', state: 'published', cloudToken: 'tokA', cloudUrl: 'https://x/docx/tokA' });
      const second = store.getKbPublication('a.md')!;
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt > first.updatedAt).toBe(true);
      store.upsertKbPublication({ kbPath: 'b.md', targetToken: 't', state: 'unknown' });
      store.upsertKbPublication({ kbPath: 'c.md', targetToken: 't', state: 'kb_removed', cloudToken: 'tokC' });
      expect(store.listPublishedCloudTokens().sort()).toEqual(['tokA', 'tokC']);
      expect(store.listKbPublications().map((r) => r.kbPath)).toEqual(['a.md', 'b.md', 'c.md']);
    } finally {
      store.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// G. release 使用中标记（§4.6：清理跳过）
// ===========================================================================

describe('release 使用中标记', () => {
  it('markReleaseInUse / isReleaseInUse / releaseInUseEnded', async () => {
    const { markReleaseInUse, releaseInUseEnded, isReleaseInUse } = await import('../src/kb/publication-service.js');
    expect(isReleaseInUse('rel-x')).toBe(false);
    markReleaseInUse('rel-x');
    expect(isReleaseInUse('rel-x')).toBe(true);
    releaseInUseEnded('rel-x');
    expect(isReleaseInUse('rel-x')).toBe(false);
  });

  it('执行期间 release 被标记使用中（执行结束释放）', async () => {
    const fx = makeFixture();
    try {
      const pub = await import('../src/kb/publication-service.js');
      const seen: boolean[] = [];
      (fx.lark as Record<string, unknown>).createDocumentMarkdown = async (options: { title: string; markdown: string; parentToken: string }) => {
        seen.push(pub.isReleaseInUse('rel-001'));
        fx.lark.calls.push({ op: 'create', args: [{ ...options }] });
        return { documentId: `docxProbe${seen.length}`, url: `https://x.feishu.cn/docx/docxProbe${seen.length}`, revisionId: 1 };
      };
      await fx.service.execute({ kbPaths: ['b/b.md'], confirm: 'PUBLISH' });
      expect(seen).toEqual([true]);
      expect(pub.isReleaseInUse('rel-001')).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});
