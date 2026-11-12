/** Run with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.
 * Uses temporary synthetic documents, loopback sockets, and no user settings. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function main() {
  assert(process.versions.electron, 'Use the packaged Electron executable');
  const resources = path.resolve(process.argv[2]);
  const serverRoot = path.join(resources, 'app.asar.unpacked/server');
  assert(fs.existsSync(path.join(serverRoot, 'dist/share-render.cjs')), 'Packaged Markdown renderer is missing');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-packaged-sharing-'));
  process.env.FEISHU_SYNC_HOME = root;
  let server;
  try {
    const standard = path.join(root, 'standard');
    const release = path.join(standard, 'releases/r_smoke');
    fs.mkdirSync(path.join(release, 'docs'), { recursive: true });
    const texts = ['# 入口\n\n[阅读规则](规则.md#结算)\n\n![图片](image.svg)\n', '# 规则\n\n## 结算\n\n已渲染的标准库正文。\n'];
    const docs = ['入口.md', '规则.md'].map((name, index) => {
      fs.writeFileSync(path.join(release, 'docs', name), texts[index]);
      return { docId: `doc-${index}`, path: name, title: name, summary: '', headings: [], tags: [], sources: [],
        contentHash: `sha256:${createHash('sha256').update(texts[index]).digest('hex')}`, updatedInBuild: 'smoke' };
    });
    const publishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(release, 'docs/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>');
    fs.writeFileSync(path.join(release, 'manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'r_smoke', buildId: 'smoke', mode: 'full', baseReleaseId: null, publishedAt, model: null, sourceSnapshot: [], skippedSources: [], docs }));
    fs.writeFileSync(path.join(standard, 'CURRENT.json'), JSON.stringify({ releaseId: 'r_smoke', publishedAt }));
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ knowledgeBaseRoot: path.join(root, 'raw'), standardKb: { outputRoot: standard }, cli: { enabled: false }, allowStandaloneKbMcp: false }));
    const { startServer } = await import(pathToFileURL(path.join(serverRoot, 'dist/index.js')).href);
    const localMcpPort = await freePort();
    server = await startServer({ configPath, desktopMode: true, desktopToken: 'packaged-smoke', hostname: '127.0.0.1', port: 0,
      localMcpPort, webShare: { hostname: '127.0.0.1', port: 0 } });
    const api = (route, method = 'GET', body) => fetch(server.url + route, { method,
      headers: { 'X-Desktop-Token': 'packaged-smoke', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await fetch(server.url + '/api/kb/distribution/shares')).status, 401);
    const md = await api('/api/kb/distribution/export', 'POST', { releaseId: 'r_smoke', docIds: ['doc-0'], format: 'md' });
    assert.equal(md.status, 200); assert.equal(await md.text(), texts[0]);
    const zip = await api('/api/kb/distribution/export', 'POST', { releaseId: 'r_smoke', docIds: ['doc-0', 'doc-1'], format: 'zip' });
    assert.equal(zip.status, 200);
    const JSZip = require(path.join(serverRoot, 'node_modules/jszip'));
    const archive = await JSZip.loadAsync(Buffer.from(await zip.arrayBuffer()));
    assert.equal(await archive.file('docs/入口.md').async('string'), texts[0]);
    assert(archive.file('docs/image.svg'));
    const created = await api('/api/kb/distribution/shares', 'POST', { releaseId: 'r_smoke', docIds: ['doc-0', 'doc-1'], baseDocId: 'doc-0' });
    assert.equal(created.status, 201);
    const status = await created.json(); const id = status.shares[0].id;
    assert.notEqual(status.port, localMcpPort);
    const origin = `http://127.0.0.1:${status.port}`;
    const first = await (await fetch(`${origin}/s/${id}/0.html`)).text();
    const second = await (await fetch(`${origin}/s/${id}/1.html`)).text();
    assert(first.includes(`/s/${id}/1.html#结算`));
    assert(first.includes(`/s/${id}/image-0.svg`));
    assert.equal((await fetch(`${origin}/s/${id}/image-0.svg`)).status, 200);
    assert(second.includes('id="结算"')); assert(second.includes(`/s/${id}/0.html`));
    assert.equal((await fetch(origin + '/api/config')).status, 404);
    const otherCreated = await api('/api/kb/distribution/shares', 'POST', { releaseId: 'r_smoke', docIds: ['doc-0'], baseDocId: 'doc-0' });
    assert.equal(otherCreated.status, 201);
    const otherId = (await otherCreated.json()).shares.find(share => share.id !== id).id;
    assert.equal((await api(`/api/kb/distribution/shares/${id}`, 'DELETE')).status, 200);
    assert.equal((await fetch(`${origin}/s/${id}/0.html`)).status, 404);
    assert.equal((await fetch(`${origin}/s/${otherId}/0.html`)).status, 200);
    assert.equal((await api(`/api/kb/distribution/shares/${otherId}`, 'DELETE')).status, 200);
    // The final revocation also closes the listener.
    await assert.rejects(fetch(`${origin}/s/${otherId}/0.html`), error => error.cause?.code === 'ECONNREFUSED');
    await server.close(); server = undefined;
    console.log('PACKAGED_SHARING_SMOKE_OK ' + JSON.stringify({ electron: process.versions.electron, abi: process.versions.modules,
      markdown: true, zip: true, renderedPages: true, documentLinks: true, baseReturn: true, revocation: true, desktopAuth: true }));
  } finally {
    await server?.close();
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
