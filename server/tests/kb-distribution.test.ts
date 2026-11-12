import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import { exportDocuments, readImage, relativeTarget, renderDocument } from '../src/kb/document-distribution.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { LocalMcpService } from '../src/kb/local-mcp-service.js';
import { WebShareService } from '../src/kb/web-share.js';
import { kbDistributionRoutes } from '../src/routes/kb-distribution.js';
import type { ConfigManager } from '../src/modules/config-manager.js';

const roots: string[] = [];
const services: WebShareService[] = [];
it('uses a separate default port from the existing local MCP listener', () => {
  const f = fixture();
  const service = new WebShareService(f.directory);
  const mcp = new LocalMcpService(f.root, () => 'unused');
  expect(service.status().port).not.toBe(Number(new URL(mcp.info().url).port));
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-distribution-')); roots.push(root);
  writeSearchRelease(root, 'r_share', [
    { docId: 'base', title: '基准 <文档>', path: '目录/入口.md', body: '# 入口\n\n[下一篇](../规则%20说明.md#规则)\n\n[未分享](secret.md)\n\n![示意](../images/a.svg)\n\n[危险](javascript:alert)\n\n<script>alert(1)</script>\n\n| 项 | 值 |\n| --- | --- |\n| 甲 | 乙 |' },
    { docId: 'second', path: '规则 说明.md', body: '# 规则\n\n[返回](目录/入口.md)\n\n<a href="目录/入口.md">HTML 返回</a>' },
    { docId: 'secret', path: '目录/secret.md', body: 'SECRET NOT SHARED' },
  ]);
  const images = path.join(root, 'releases/r_share/docs/images'); fs.mkdirSync(images);
  fs.writeFileSync(path.join(images, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="green"/></svg>');
  const directory = path.join(root, 'shares');
  const service = new WebShareService(directory, 0, '127.0.0.1'); services.push(service);
  return { root, service, directory, input: { releaseId: 'r_share', docIds: ['base', 'second'], baseDocId: 'base' } };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Markdown export', () => {
  it('exports only the requested body with a Unicode filename, without internal headers', async () => {
    const f = fixture();
    const result = await exportDocuments(f.root, { ...f.input, docIds: ['base'], format: 'md' });
    expect(result.name).toBe('入口.md');
    expect(result.bytes.toString()).toContain('# 入口');
    expect(result.bytes.toString()).not.toContain('feishu_sync_kb');
    expect(result.bytes.toString()).not.toContain('SECRET NOT SHARED');
  });
  it('preserves relative links and includes only referenced images in the ZIP', async () => {
    const f = fixture();
    const result = await exportDocuments(f.root, { ...f.input, format: 'zip' });
    const zip = await JSZip.loadAsync(result.bytes);
    expect(zip.file('docs/目录/入口.md')).not.toBeNull();
    expect(zip.file('docs/规则 说明.md')).not.toBeNull();
    expect(zip.file('docs/images/a.svg')).not.toBeNull();
    expect(zip.file('docs/目录/secret.md')).toBeNull();
    expect(await zip.file('docs/目录/入口.md')!.async('string')).toContain('../规则%20说明.md#规则');
  });
  it('rejects stale versions, missing docs, empty selection and ambiguous single-file exports', async () => {
    const f = fixture();
    for (const input of [
      { ...f.input, releaseId: 'r_old', format: 'zip' as const },
      { ...f.input, docIds: ['missing'], format: 'zip' as const },
      { ...f.input, docIds: [], format: 'zip' as const },
      { ...f.input, format: 'md' as const },
    ]) await expect(exportDocuments(f.root, input)).rejects.toThrow();
  });
});

describe('read-only web sharing', () => {
  it('serves rendered pages with local navigation, anchors, images and a permanent base link', async () => {
    const f = fixture(); const status = await f.service.create(f.root, f.input);
    const id = status.shares[0].id, base = `http://127.0.0.1:${status.port}/s/${id}/`;
    const response = await fetch(base + '0.html'); const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`<a href="/s/${id}/0.html">← 返回基准文档</a>`);
    expect(html).toContain(`href="/s/${id}/1.html#规则"`);
    expect(html).toContain('<table');
    expect(html).toContain('基准 &lt;文档&gt;');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="secret.md"');
    expect(html).not.toContain('图片加载中');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await (await fetch(base + 'image-0.svg')).text()).toContain('<svg');
    const second = await (await fetch(base + '1.html')).text();
    expect(second).toContain('id="规则"');
    expect(second.match(new RegExp(`href="/s/${id}/0.html"`, 'g'))).toHaveLength(3);
    expect(await (await fetch(base)).text()).toContain('分享目录');
  });
  it('exposes neither unselected docs, metadata, arbitrary paths nor desktop APIs', async () => {
    const f = fixture(); const status = await f.service.create(f.root, f.input);
    const origin = `http://127.0.0.1:${status.port}`, prefix = `/s/${status.shares[0].id}/`;
    for (const url of ['2.html', 'share.json', '%2e%2e%2fCURRENT.json', 'image-100.svg']) {
      expect((await fetch(origin + prefix + url)).status).toBe(404);
    }
    expect((await fetch(origin + '/api/config')).status).toBe(404);
    expect((await fetch(origin + prefix, { method: 'POST' })).status).toBe(405);
    expect((await fetch(origin + prefix, { method: 'HEAD' })).status).toBe(200);
  });
  it('keeps snapshot bytes after publication changes and resumes them after restart', async () => {
    const f = fixture(); const before = await f.service.create(f.root, f.input); const id = before.shares[0].id;
    await f.service.close();
    writeSearchRelease(f.root, 'r_next', [{ path: 'a.md', body: 'NEW VERSION' }]);
    const restored = new WebShareService(f.directory, 0, '127.0.0.1'); services.push(restored); await restored.resume();
    const url = `http://127.0.0.1:${restored.status().port}/s/${id}/0.html`;
    expect(await (await fetch(url)).text()).toContain('下一篇');
    expect(await (await fetch(url)).text()).not.toContain('NEW VERSION');
    await restored.revoke(id);
    expect(restored.status().running).toBe(false);
    const reopened = new WebShareService(f.directory, 0, '127.0.0.1'); services.push(reopened);
    expect(reopened.status().shares).toEqual([]);
  });
  it('revokes one link while other shares remain available', async () => {
    const f = fixture(); const first = await f.service.create(f.root, f.input); const id = first.shares[0].id;
    await f.service.create(f.root, { ...f.input, baseDocId: 'second' });
    await f.service.revoke(id);
    const status = f.service.status();
    expect(status.shares).toHaveLength(1);
    expect((await fetch(`http://127.0.0.1:${status.port}/s/${id}/`)).status).toBe(404);
  });
  it('rejects an unshared base document', async () => {
    const f = fixture(); await expect(f.service.create(f.root, { ...f.input, baseDocId: 'secret' })).rejects.toThrow('基准文档');
    expect(f.service.status().running).toBe(false);
  });
});

it('rejects filesystem and encoded traversal targets while resolving nested Chinese paths', () => {
  for (const href of ['../../secret', '%2fetc/passwd', '%5csecret', 'file:///secret', '//host/a', '%2e%2e/%2e%2e/secret']) expect(relativeTarget('dir/a.md', href)).toBeNull();
  expect(relativeTarget('dir/a.md', '../规则%20说明.md#规则')).toEqual({ path: '规则 说明.md', hash: '#规则' });
});

it('returns actionable API errors and attachment headers', async () => {
  const f = fixture(); const app = kbDistributionRoutes({ getConfig: () => ({ standardKb: { outputRoot: f.root } }) } as ConfigManager, f.service);
  const post = (body: unknown) => app.request('/api/kb/distribution/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post(null)).status).toBe(400);
  expect((await post({ ...f.input, releaseId: 'r_stale', format: 'zip' })).status).toBe(409);
  const response = await post({ ...f.input, docIds: ['base'], format: 'md' });
  expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toContain('filename*=UTF-8');
});

it('renders every table row without dead pagination controls and generates unique heading anchors', () => {
  const markdown = '# 标题\n\n# 标题\n\n| 内容 |\n| --- |\n' + Array.from({ length: 120 }, (_, i) => `| row-${i} |`).join('\n');
  const html = renderDocument(markdown, () => null, () => null);
  expect(html).toContain('row-119'); expect(html).not.toContain('表格分页');
  expect(html).toContain('id="标题"'); expect(html).toContain('id="标题-1"');
});

it('uses verified frozen image evidence when the original image path is unavailable', () => {
  const f = fixture();
  const release = path.join(f.root, 'releases/r_share');
  const manifest = JSON.parse(fs.readFileSync(path.join(release, 'manifest.json'), 'utf8'));
  const imageBytes = fs.readFileSync(path.join(release, 'docs/images/a.svg'));
  const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  fs.mkdirSync(path.join(release, 'evidence'));
  fs.writeFileSync(path.join(release, 'evidence/image.bin'), imageBytes);
  fs.unlinkSync(path.join(release, 'docs/images/a.svg'));
  const index = Buffer.from(JSON.stringify({ evidenceFiles: [{ kind: 'image', resourceId: 'fixture#image:../images/a.svg',
    image: { src: '../images/a.svg' }, path: 'evidence/image.bin', hash: hash(imageBytes) }] }));
  fs.writeFileSync(path.join(release, 'evidence.json'), index);
  manifest.evidence = { resourcesPath: 'evidence.json', hash: hash(index) };
  fs.writeFileSync(path.join(release, 'manifest.json'), JSON.stringify(manifest));
  const store = new StandardKbStore(f.root);
  expect(readImage(store, 'r_share', manifest.docs[0], '../images/a.svg')?.bytes).toEqual(imageBytes);
  expect(readImage(store, 'r_share', { ...manifest.docs[0], sources: ['other'] }, '../images/a.svg')).toBeNull();
  fs.writeFileSync(path.join(release, 'evidence/image.bin'), 'tampered');
  expect(readImage(store, 'r_share', manifest.docs[0], '../images/a.svg')).toBeNull();
});

it('does not copy image symlinks escaping the fixed release', async () => {
  const f = fixture();
  const original = path.join(f.root, 'releases/r_share/docs/images/a.svg');
  fs.unlinkSync(original);
  const outside = path.join(f.root, 'private.svg'); fs.writeFileSync(outside, 'PRIVATE IMAGE');
  fs.symlinkSync(outside, original);
  const result = await exportDocuments(f.root, { ...f.input, format: 'zip' });
  const zip = await JSZip.loadAsync(result.bytes);
  expect(zip.file('docs/images/a.svg')).toBeNull();
});
