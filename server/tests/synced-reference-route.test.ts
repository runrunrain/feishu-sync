import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { mappingRoutes } from '../src/routes/mapping.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-reference-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'source', 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'source', 'doc.md'), '');
  fs.writeFileSync(path.join(root, 'source', 'images', '03-BoardToken.jpg'), 'fixture');
  const fetchSyncedReference = vi.fn(async () => ({ data: { document: { content: '<fragment mode="range"><synced-source id="Block"><whiteboard token="BoardToken"></whiteboard></synced-source></fragment>' } } }));
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).larkCliClient = { fetchSyncedReference };
    (c as any).localMapStore = { getDocumentByObjToken: () => ({ localRelPath: 'source/doc.md' }) };
    (c as any).configManager = { getConfig: () => ({ knowledgeBaseRoot: root }) };
    await next();
  });
  app.route('/', mappingRoutes);
  return { app, root, fetchSyncedReference };
}

it('reads only the matching local block and skips the cloud', async () => {
  const { app, root, fetchSyncedReference } = setup();
  fs.writeFileSync(path.join(root, 'source', 'doc.md'), '<synced-source id="Other">其他块</synced-source>\n<synced-source id="Block1">![白板](images/03-BoardToken.jpg)</synced-source>');
  const res = await app.request('/api/mapping/synced-reference?token=Source1&block=Block1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ source: 'local-block', baseDir: 'source', content: '![白板](images/03-BoardToken.jpg)' });
  expect(fetchSyncedReference).not.toHaveBeenCalled();
});

it('ignores example tags and keeps nested content inside the matching block', async () => {
  const { app, root, fetchSyncedReference } = setup();
  const body = '正文\n<synced-source>内层</synced-source>\n结尾';
  fs.writeFileSync(path.join(root, 'source', 'doc.md'),
    ['~~~xml', '<synced-source id="Block1">示例</synced-source>', '~~~', '<!-- <synced-source id="Block1">注释</synced-source> -->',
      `<synced-source id="Block1">${body}</synced-source>`].join('\n'));
  const response = await app.request('/api/mapping/synced-reference?token=Source1&block=Block1');
  expect(await response.json()).toEqual({ source: 'local-block', baseDir: 'source', content: body });
  expect(fetchSyncedReference).not.toHaveBeenCalled();
});

it('finds the moved source by identity when its indexed path has been reused', async () => {
  const { app, root, fetchSyncedReference } = setup();
  const withIdentity = (token: string, text: string) => `<!--\nfeishu_sync:\n  obj_token: "${token}"\n-->\n${text}`;
  fs.writeFileSync(path.join(root, 'source', 'doc.md'), withIdentity('Other', '其他文档'));
  fs.writeFileSync(path.join(root, 'moved.md'), withIdentity('Source1', '<synced-source id="Block1">原文</synced-source>'));
  const response = await app.request('/api/mapping/synced-reference?token=Source1&block=Block1');
  expect(await response.json()).toEqual({ source: 'local-block', baseDir: '', content: '原文' });
  expect(fetchSyncedReference).not.toHaveBeenCalled();
});

it('provides the local document without guessing a block when the export omits IDs', async () => {
  const { app, root, fetchSyncedReference } = setup();
  const content = '# 本地原文\n<synced-source>第一个块</synced-source>\n<synced-source>第二个块</synced-source>';
  fs.writeFileSync(path.join(root, 'source', 'doc.md'), content);
  const res = await app.request('/api/mapping/synced-reference?token=Source1&block=Block1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ source: 'local-document', baseDir: 'source', content, truncated: false });
  expect(fetchSyncedReference).not.toHaveBeenCalled();
});

it('reads the exact referenced block and maps a uniquely matching local whiteboard', async () => {
  const { app, fetchSyncedReference } = setup();
  const res = await app.request('/api/mapping/synced-reference?token=Source1&block=Block1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ baseDir: 'source', content: '<fragment mode="range"><synced-source id="Block">![飞书白板](images/03-BoardToken.jpg)</synced-source></fragment>' });
  expect(fetchSyncedReference).toHaveBeenCalledWith('Source1', 'Block1');
});

it('does not guess when media matches are ambiguous and rejects invalid identifiers', async () => {
  const { app, root, fetchSyncedReference } = setup();
  fs.writeFileSync(path.join(root, 'source', 'images', '04-BoardToken.png'), 'another');
  const res = await app.request('/api/mapping/synced-reference?token=Source1&block=Block1');
  expect((await res.json()).content).toContain('<whiteboard');
  const bad = await app.request('/api/mapping/synced-reference?token=..%2Fsecret&block=Block1');
  expect(bad.status).toBe(400); expect(fetchSyncedReference).toHaveBeenCalledTimes(1);
});

it('reports unavailable references and limits oversized responses', async () => {
  const { app, fetchSyncedReference } = setup();
  fetchSyncedReference.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 'permission' }));
  expect((await app.request('/api/mapping/synced-reference?token=Source1&block=Block1')).status).toBe(403);
  fetchSyncedReference.mockResolvedValueOnce({ data: { document: { content: 'x'.repeat(512 * 1024 + 1) } } });
  expect((await app.request('/api/mapping/synced-reference?token=Source1&block=Block1')).status).toBe(413);
});

it('asks lark-cli for only the requested block', async () => {
  const client = new LarkCliClient({ requiredScopes: [] });
  const execute = vi.spyOn(client, 'execute').mockResolvedValue({});
  await client.fetchSyncedReference('Source1', 'Block1');
  expect(execute).toHaveBeenCalledWith(['docs', '+fetch', '--doc', 'Source1', '--scope', 'range', '--start-block-id', 'Block1', '--end-block-id', 'Block1', '--doc-format', 'markdown', '--detail', 'simple', '--as', 'user', '--format', 'json'], 'docx');
});
