import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { contentRoutes } from '../src/routes/content.js';
import { recoverLocalDocument } from '../src/modules/recover-local-document.js';
import { IndexScanner } from '../src/modules/index-scanner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const header = (token: string, wiki = 'wiki-a') => `<!--\r\nfeishu_sync:\r\n  obj_token: "${token}"\r\n  wiki_node_token: "${wiki}"\r\n  obj_type: "slides"\r\n-->\r\n# 本地内容\r\n`;
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-doc-')); roots.push(root); return root; }
const doc = { objToken: 'object-a', wikiNodeToken: 'wiki-a', localMdPath: '', lastSyncErrorCode: 'permission_denied' };

it('以 CRLF 元数据恢复受限文档，同时排除回收站且不更改文件或同步状态', async () => {
  const root = fixture(); const file = path.join(root, '历史名称.md'); const content = header(doc.objToken);
  fs.writeFileSync(file, content); fs.mkdirSync(path.join(root, '.trash-bin')); fs.writeFileSync(path.join(root, '.trash-bin', 'copy.md'), content);
  expect(new IndexScanner({ localMapStore: null, larkCliClient: null, config: null }).parseMetadata(content)).toMatchObject({ obj_token: doc.objToken, wiki_node_token: doc.wikiNodeToken });
  expect(recoverLocalDocument(root, doc)).toBe(file);
  const app = new Hono(); app.use('*', async (c, next) => { (c as any).localMapStore = { getDocumentByObjToken: () => ({ ...doc, objType: 'slides', title: '云文档' }) }; (c as any).configManager = { getConfig: () => ({ knowledgeBaseRoot: root }) }; await next(); }); app.route('/', contentRoutes);
  const response = await app.request('/api/mapping/content/object-a');
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ mdPath: '历史名称.md', mdContent: content });
  expect(fs.readFileSync(file, 'utf8')).toBe(content); expect(doc.localMdPath).toBe('');
});

it('拒绝重复身份、不同 wiki 身份以及非权限受限记录', () => {
  const duplicateRoot = fixture(); fs.writeFileSync(path.join(duplicateRoot, 'a.md'), header(doc.objToken)); fs.writeFileSync(path.join(duplicateRoot, 'b.md'), header(doc.objToken));
  expect(recoverLocalDocument(duplicateRoot, doc)).toBeNull();
  const mismatchRoot = fixture(); fs.writeFileSync(path.join(mismatchRoot, 'a.md'), header(doc.objToken, 'other'));
  expect(recoverLocalDocument(mismatchRoot, doc)).toBeNull();
  expect(recoverLocalDocument(mismatchRoot, { ...doc, lastSyncErrorCode: null })).toBeNull();
});
