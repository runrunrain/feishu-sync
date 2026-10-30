/**
 * P1-S4 引用风险与预览出边测试（设计 §2.4 消费面）：
 *  - planSourceBatch 预览的 referenceLossRisk（选集外引用方悬空提示）：
 *    obj/wiki 双键反查、选集内引用不计、屏蔽不计算、revision 一致可执行
 *  - GET /api/mapping/content 的 references（出边解析到本地行，预览面板
 *    「引用」区数据源）
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { contentRoutes } from '../src/routes/content.js';
import { parseSourceBatchRequest, planSourceBatch, executeSourceBatch } from '../src/modules/source-batch.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { SourceReferenceInsert } from '../src/modules/local-map-store.js';

const tmpDirs: string[] = [];
const stores: LocalMapStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s4-risk-')); tmpDirs.push(root);
  const raw = path.join(root, 'raw'); fs.mkdirSync(raw, { recursive: true });
  const store = new LocalMapStore(path.join(root, 'db.sqlite')); stores.push(store); store.initialize();
  const config = new ConfigManager(path.join(root, 'config.json')); await config.load();
  await config.updateConfig({ knowledgeBaseRoot: raw, standardKb: { outputRoot: path.join(root, 'standard') } } as never);
  const docs: DocumentRecord[] = (['a', 'b', 'c'] as const).map((token) => ({
    objToken: token, title: `文档${token}`, wikiNodeToken: `wiki-${token}`, parentNodeToken: null, objType: 'docx',
    localRelPath: `${token}.md`, localMdPath: path.join(raw, `${token}.md`),
    lastSyncedAt: '2026-10-01T00:00:00Z', lastSyncedModifyTime: '100', status: 'synced',
  } as DocumentRecord));
  for (const doc of docs) fs.writeFileSync(doc.localMdPath!, `<!--\nfeishu_sync:\n  obj_token: ${doc.objToken}\n  obj_type: docx\n-->\n# ${doc.title}\n正文。`);
  for (const doc of docs) store.upsertDocument(doc);
  return { root, raw, store, config, docs };
}

const edge = (targetToken: string, extra: Partial<SourceReferenceInsert> = {}): SourceReferenceInsert => ({
  targetToken, targetType: 'docx', title: null, origin: 'body', kind: 'link', occurrences: 1, ...extra,
});

describe('planSourceBatch referenceLossRisk（§2.4 删除确认风险）', () => {
  it('待删文档被选集外文档引用（obj 键与 wiki 键双路）→ 列出悬空风险', async () => {
    const f = await fixture();
    store_addEdges(f.store, 'b', [edge('a')]);        // b → a（obj 键）
    store_addEdges(f.store, 'c', [edge('wiki-a')]);   // c → a（wiki 键）
    const request = parseSourceBatchRequest({ root: f.raw, tokens: ['a'], action: 'delete', includeDescendants: false, deleteFiles: true, block: false });
    const { preview } = planSourceBatch(f.store, f.config.getConfig()!, request);
    expect(preview.referenceLossRisk).toEqual([
      { objToken: 'a', title: '文档a', referencedByCount: 2, sources: [
        { objToken: 'b', title: '文档b', localRelPath: 'b.md' },
        { objToken: 'c', title: '文档c', localRelPath: 'c.md' },
      ] },
    ]);
  });

  it('引用方同在删除集内不悬空（同生共死不计）；同源多边只计一篇', async () => {
    const f = await fixture();
    store_addEdges(f.store, 'b', [edge('a'), edge('a', { kind: 'cite', origin: 'refmap' })]); // 同源两行边
    store_addEdges(f.store, 'c', [edge('wiki-a')]);
    const request = parseSourceBatchRequest({ root: f.raw, tokens: ['a', 'b'], action: 'delete', includeDescendants: false, deleteFiles: true, block: false });
    const { preview } = planSourceBatch(f.store, f.config.getConfig()!, request);
    expect(preview.referenceLossRisk).toEqual([
      { objToken: 'a', title: '文档a', referencedByCount: 1, sources: [{ objToken: 'c', title: '文档c', localRelPath: 'c.md' }] },
    ]);
    // b 无入边 → 不出现在风险清单
    expect(preview.referenceLossRisk!.some((item) => item.objToken === 'b')).toBe(false);
  });

  it('无外部引用 → 空清单；屏蔽动作不计算', async () => {
    const f = await fixture();
    store_addEdges(f.store, 'b', [edge('a')]);
    const none = planSourceBatch(f.store, f.config.getConfig()!, parseSourceBatchRequest({ root: f.raw, tokens: ['b'], action: 'delete', includeDescendants: false, deleteFiles: true, block: false }));
    expect(none.preview.referenceLossRisk).toEqual([]);
    const block = planSourceBatch(f.store, f.config.getConfig()!, parseSourceBatchRequest({ root: f.raw, tokens: ['a'], action: 'block', includeDescendants: false, deleteFiles: false, block: true }));
    expect(block.preview.referenceLossRisk).toBeUndefined();
  });

  it('新字段不破坏 revision 门：preview → apply 同 revision 可执行', async () => {
    const f = await fixture();
    store_addEdges(f.store, 'b', [edge('a')]);
    const body = { root: f.raw, tokens: ['a'], action: 'delete', includeDescendants: false, deleteFiles: false, block: false };
    const { preview } = planSourceBatch(f.store, f.config.getConfig()!, parseSourceBatchRequest(body));
    const result = executeSourceBatch(f.store, f.config.getConfig()!, parseSourceBatchRequest(body), preview.revision);
    expect(result.processed).toBe(1);
    // 入边保留（指向已删文档是真实信息）；出边随删除清理
    expect(f.store.listSourceReferencesByTarget(['a', 'wiki-a']).map((row) => row.srcObjToken)).toEqual(['b']);
    expect(f.store.listSourceReferencesBySrc('a')).toEqual([]);
  });
});

describe('GET /api/mapping/content references（§2.4 预览面板出边）', () => {
  it('出边解析到本地行：标题/路径/同步态；未入本库目标保留原 token', async () => {
    const f = await fixture();
    store_addEdges(f.store, 'a', [
      edge('wiki-b', { title: '文档b（链接文字）', occurrences: 2 }),
      edge('ext-not-in-lib-000000', { title: '外部文档', targetType: 'docx' }),
    ]);
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).localMapStore = f.store;
      (c as any).configManager = f.config;
      await next();
    });
    app.route('/', contentRoutes);
    const response = await app.request('/api/mapping/content/a');
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.references).toEqual([
      { direction: 'out', token: 'wiki-b', targetType: 'docx', origin: 'body', kind: 'link',
        title: '文档b', occurrences: 2, objToken: 'b', localRelPath: 'b.md', synced: true },
      { direction: 'out', token: 'ext-not-in-lib-000000', targetType: 'docx', origin: 'body', kind: 'link',
        title: '外部文档', occurrences: 1, objToken: null, localRelPath: null, synced: false },
    ]);
    // referencedBy（P1-S3）仍在，供「被引用」区共用
    expect(Array.isArray(data.referencedBy)).toBe(true);
  });
});

function store_addEdges(store: LocalMapStore, src: string, edges: SourceReferenceInsert[]): void {
  store.replaceSourceReferences(src, edges);
}
