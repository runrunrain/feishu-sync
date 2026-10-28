/**
 * T4b 修复批 C 正式回归（T4b-recheck.md F06/F07 反例固化）：
 *   - F06-a overwrite 命令已发出后响应 parse 不可判定 → unknown（与
 *     create/revert/move 同口径），普通重发被计划层 state_unknown 阻断
 *     （attempts=1），push_log outcome=unknown
 *   - F06-b overwrite timeout → unknown 且同批第二遍互链回写零重发
 *     （每文档单次尝试语义；第二遍准入排除本轮 unknown/失败行）
 *   - F06-c 写前只读失败（fetchRevision 抛 parse）仍 failed，不笼统改
 *     unknown（与写后未知区分的反向锚定）
 *   - F07 force 重建失败（行已清 cloud_token）后再次 force 成功：旧 token
 *     谱系 previousCloudTokens 持久化，listPublishedCloudTokens 不丢旧身份
 *
 * 反例来源：agent-outputs/workflow/2026-10-27-kb-agent-upgrade/
 * T4b-recheck.md「剩余 finding」与附录 runner（t4b-secondpass-timeout /
 * t4b-replay-review）。断言为安全行为（修复后预期）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliError } from '../src/modules/lark-cli-client.js';
import { KbPublishService } from '../src/kb/publication-service.js';
import { countText } from '../src/kb/text-stats.js';
import type { PublishTargetConfig } from '../src/types/index.js';

const BASE_TIME = 1759000000;
const TARGET: PublishTargetConfig = { kind: 'drive_folder', token: 'fldcnPublishRoot01', label: '发布根' };

// ---------------------------------------------------------------------------
// lark-cli stub（与 kb-publication-fixA.test.ts 同构；history 默认有锚）
// ---------------------------------------------------------------------------

interface LarkStub {
  calls: Array<{ op: string; args: unknown[] }>;
  createdDocs: Map<string, string>;
  metaTimes: Map<string, number | null>;
  [key: string]: unknown;
}

function makeLarkStub(): LarkStub {
  const calls: LarkStub['calls'] = [];
  const createdDocs = new Map<string, string>();
  const metaTimes = new Map<string, number | null>();
  let seq = 0;
  return {
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
      const id = `docxcnFixC${String(seq).padStart(4, '0')}`;
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
  };
}

// ---------------------------------------------------------------------------
// 标准库 release fixture（与 fixA 同构）
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
  service: KbPublishService;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4b-fixc-kb-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4b-fixc-data-'));
  writeRelease(outputRoot, 'rel-001', [
    { path: 'dirA/a.md', markdown: DOC_A },
    { path: 'b/b.md', markdown: DOC_B },
  ]);
  const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
  store.initialize();
  const lark = makeLarkStub();
  const config: Record<string, unknown> = {
    knowledgeBaseRoot: path.join(dataRoot, 'raw'),
    standardKb: { outputRoot },
    feishuWrite: { enabled: true },
    feishuPublish: { enabled: true, target: TARGET },
    watchedRoots: [],
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
    outputRoot, dataRoot, store, lark, service,
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
// F06：overwrite 写后未知分类 + 同批第二遍零重发
// ===========================================================================

describe('T4b-F06 overwrite 写后未知分类（批C）', () => {
  it('overwrite 已发出后响应 parse 不可判定 → unknown；普通重发被 state_unknown 阻断（attempts=1）', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\nChanged body\n' },
      ]);
      // 替身模拟「云端已受理写入，但命令响应 JSON 不可解析」：
      // 先真实写入 createdDocs 再抛 parse（与 t4b-replay-review 反例一致）。
      let attempts = 0;
      const rawOverwrite = fx.lark.overwriteDocument.bind(fx.lark);
      (fx.lark as unknown as Record<string, unknown>).overwriteDocument =
        async (token: string, markdown: string, revisionId: number) => {
          attempts += 1;
          await rawOverwrite(token, markdown, revisionId);
          throw new LarkCliError('accepted then bad JSON', 'parse', false);
        };
      const first = await fx.service.execute({ releaseId: 'rel-002', kbPaths: ['b/b.md'], confirm: 'PUBLISH' });
      expect(first.items[0].outcome).toBe('unknown');
      const row = fx.store.getKbPublication('b/b.md')!;
      expect(row.state).toBe('unknown');
      // 写前锚点行如实记 unknown（不是 failed）
      expect(fx.store.listSourcePushLogs(row.cloudToken!)[0].outcome).toBe('unknown');
      // 不带 force 的普通重发：计划层 state_unknown 阻断，不再 overwrite
      const second = await fx.service.execute({ releaseId: 'rel-002', kbPaths: ['b/b.md'], confirm: 'PUBLISH' });
      expect(second.items[0].outcome).toBe('blocked');
      expect(second.items[0].error).toContain('state_unknown');
      expect(attempts).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it('overwrite timeout → unknown 且同批第二遍互链回写零重发（每文档单次尝试）', async () => {
    const fx = makeFixture();
    try {
      // 第一步：仅发布 A（对 B 的链接降级为文字）
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['dirA/a.md'] });
      const oldA = fx.store.getKbPublication('dirA/a.md')!;
      expect(oldA.state).toBe('published');
      // 第二步：rel-002 同时改 A 正文并新增 B；A 的 overwrite 超时（写后未知）
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A + '\nchanged\n' },
        { path: 'b/b.md', markdown: DOC_B },
      ]);
      let attempts = 0;
      (fx.lark as unknown as Record<string, unknown>).overwriteDocument =
        async (token: string) => {
          if (token === oldA.cloudToken) {
            attempts += 1;
            throw new LarkCliError('accepted then timeout', 'timeout', false);
          }
          return { revisionId: 12 };
        };
      const result = await fx.service.execute({ releaseId: 'rel-002', confirm: 'PUBLISH' });
      // B 创建成功（互链回填需要第二遍重渲染 A），但 A 第一遍已 unknown：
      // 第二遍准入排除本轮未确认成功的文档，不再对 A 重发。
      expect(result.counts.created).toBe(1);
      expect(result.counts.secondPass).toBe(0);
      expect(attempts).toBe(1);
      const aItems = result.items.filter((i) => i.kbPath === 'dirA/a.md');
      expect(aItems.map((i) => i.outcome)).toEqual(['unknown']);
      expect(fx.store.getKbPublication('dirA/a.md')!.state).toBe('unknown');
    } finally {
      fx.cleanup();
    }
  });

  it('写前只读失败（fetchRevision 抛 parse）仍 failed，不被笼统改成 unknown', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      writeRelease(fx.outputRoot, 'rel-002', [
        { path: 'dirA/a.md', markdown: DOC_A },
        { path: 'b/b.md', markdown: '# 标题B\n\n写前失败场景正文。\n' },
      ]);
      (fx.lark as unknown as Record<string, unknown>).fetchDocumentRevision =
        async () => { throw new LarkCliError('bad JSON from revision fetch', 'parse', false); };
      const result = await fx.service.execute({ releaseId: 'rel-002', kbPaths: ['b/b.md'], confirm: 'PUBLISH' });
      expect(result.items[0].outcome).toBe('failed');
      const row = fx.store.getKbPublication('b/b.md')!;
      expect(row.state).toBe('failed');
      expect(fx.store.listSourcePushLogs(row.cloudToken!)[0].outcome).toBe('failed');
      // 云端零写入（覆盖命令从未发出）
      expect(overwriteCalls(fx)).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// F07：空 current token 不丢既有谱系
// ===========================================================================

describe('T4b-F07 force 重建失败→再次重建的谱系持久化（批C）', () => {
  it('A→force B 失败（行已清 token）→再 force 成功：A 仍在 listPublishedCloudTokens', async () => {
    const fx = makeFixture();
    try {
      // 初始发布：旧 token A
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'] });
      const old = fx.store.getKbPublication('b/b.md')!;
      fx.store.upsertKbPublication({ ...old, state: 'unknown' });
      // 第一次 force：create 已发出但响应 parse 不可判定 → 行 unknown 且
      // cloud_token 已清空（空 current token 分支）
      const rawCreate = fx.lark.createDocumentMarkdown.bind(fx.lark);
      (fx.lark as unknown as Record<string, unknown>).createDocumentMarkdown =
        async () => { throw new LarkCliError('accepted but bad JSON', 'parse', false); };
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'], force: true });
      const afterFail = fx.store.getKbPublication('b/b.md')!;
      expect(afterFail.state).toBe('unknown');
      expect(afterFail.cloudToken).toBeNull();
      // 谱系在第一次 force 失败后仍保留（fixA 已覆盖，此处作为链路前置锚定）
      expect(fx.store.listPublishedCloudTokens()).toContain(old.cloudToken);
      // 第二次 force：创建成功——空 current token 不得丢弃既有谱系
      (fx.lark as unknown as Record<string, unknown>).createDocumentMarkdown = rawCreate;
      await fx.service.execute({ confirm: 'PUBLISH', kbPaths: ['b/b.md'], force: true });
      const row = fx.store.getKbPublication('b/b.md')!;
      expect(row.cloudToken).not.toBe(old.cloudToken);
      const tokens = fx.store.listPublishedCloudTokens();
      expect(tokens).toContain(old.cloudToken);
      expect(tokens).toContain(row.cloudToken);
      const warnings = JSON.parse(row.warningsJson!) as { previousCloudTokens?: string[] };
      expect(warnings.previousCloudTokens).toContain(old.cloudToken);
    } finally {
      fx.cleanup();
    }
  });
});
