import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { allowedSource, privateInterfaces } from '../kb-lan/network.js';
import { resolveInside } from '../agent/path-guard.js';
import { DistributionError, readImage, relativeTarget, renderDocument, selectDocuments, type DocumentSelection } from './document-distribution.js';

export interface WebShare {
  id: string; title: string; releaseId: string; createdAt: string; baseDocId: string;
  docs: Array<{ docId: string; title: string; file: string }>;
  images: Record<string, string>;
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const CSS = `:root{color-scheme:light;--ink:#252c28;--font-sans:system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#f7f6f2;color:var(--ink);font:16px/1.8 system-ui,sans-serif}header{position:sticky;top:0;background:#fffefbf2;border-bottom:1px solid #ddd;padding:12px 24px;z-index:2}header a{margin-right:24px}main{max-width:1100px;margin:24px auto;padding:28px clamp(18px,4vw,64px);background:#fff;border:1px solid #e5e4de;border-radius:12px}a{color:#286e5b}h1,h2,h3,h4,h5,h6{line-height:1.4;scroll-margin-top:100px}h1{font-size:2em}h2{margin-top:1.8em;border-bottom:1px solid #ddd;padding-bottom:8px}p{margin:0 0 1em}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%;font-size:.94em}td,th{border:1px solid #ddd;padding:8px 12px;vertical-align:top}th{background:#f0f4f1}pre{overflow:auto;background:#f4f5f3;padding:16px;border-radius:6px}code{font-family:ui-monospace,monospace}blockquote{border-left:3px solid #609a84;margin-left:0;padding-left:18px;color:#53635b}.markdown-body{overflow-wrap:anywhere}.markdown-body>div{overflow-x:auto}small{color:#65716a}details{margin:16px 0}summary{cursor:pointer}nav{display:flex;gap:8px 18px;flex-wrap:wrap}h1{overflow-wrap:anywhere}@media(max-width:600px){main{margin:0;border:0;border-radius:0}header{padding:10px 16px}}`;
function page(title: string, body: string, share: WebShare, showTitle = true): string {
  const base = share.docs.find(doc => doc.docId === share.baseDocId)!;
  const prefix = `/s/${share.id}/`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${CSS}</style></head><body><header><a href="${prefix}${base.file}">← 返回基准文档</a><a href="${prefix}">分享目录（${share.docs.length} 篇）</a></header><main><small>标准库分享 · ${escape(share.createdAt.slice(0, 10))}</small>${showTitle ? `<h1>${escape(title)}</h1>` : ''}${body}<hr><small>仅提供分享时保存的文档。未分享的本地链接不可访问。</small></main></body></html>`;
}

/** A separate read-only HTTP listener. Never routes requests to the desktop API. */
export class WebShareService {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private mutation: Promise<unknown> | null = null;
  private shares = new Map<string, WebShare>();
  private port: number;
  constructor(private directory: string, port = 47393, private bindAddress = '0.0.0.0') {
    this.port = port;
    if (fs.existsSync(directory)) for (const id of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{48}$/.test(id)) continue;
      try {
        const share = JSON.parse(fs.readFileSync(resolveInside(directory, `${id}/share.json`, 'read'), 'utf8')) as WebShare;
        if (share.id === id && typeof share.title === 'string' && typeof share.createdAt === 'string'
          && Array.isArray(share.docs) && share.docs.every(d => d && typeof d.docId === 'string' && typeof d.title === 'string' && /^\d+\.html$/.test(d.file))
          && share.docs.some(d => d.docId === share.baseDocId)
          && share.images && typeof share.images === 'object' && !Array.isArray(share.images)
          && Object.entries(share.images).every(([file, mime]) => /^image-\d+\.[a-z]+$/.test(file) && /^image\/[a-z0-9.+-]+$/.test(mime))) this.shares.set(id, share);
      } catch { /* Incomplete staging is never exposed. */ }
    }
  }
  status() {
    const addresses = privateInterfaces().filter(i => !i.address.includes(':')).map(i => i.address);
    const hosts = [...new Set(addresses.length ? addresses : ['127.0.0.1'])];
    return { running: !!this.server?.listening, port: this.port, shares: [...this.shares.values()].map(s => ({
      id: s.id, title: s.title, releaseId: s.releaseId, createdAt: s.createdAt, baseDocId: s.baseDocId, docCount: s.docs.length,
      urls: hosts.map(host => `http://${host}:${this.port}/s/${s.id}/${s.docs.find(d => d.docId === s.baseDocId)!.file}`),
    })) };
  }
  async start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      server.on('error', () => { /* listen errors also reject below; no unhandled EventEmitter error */ });
      server.once('error', reject);
      server.listen(this.port, this.bindAddress, () => {
        server.removeListener('error', reject);
        this.server = server;
        const address = server.address();
        if (address && typeof address !== 'string') this.port = address.port;
        resolve();
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async resume() { if (this.shares.size) await this.start(); }
  async close() {
    await this.mutation?.catch(() => undefined);
    await this.stopListener();
  }
  private async stopListener() {
    if (this.starting) await this.starting.catch(() => undefined);
    const server = this.server; this.server = null;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  async create(root: string, input: DocumentSelection & { baseDocId: string }) {
    return this.mutate(() => this.createSnapshot(root, input));
  }
  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.mutation) throw new DistributionError('分享操作进行中，请稍后重试', 409);
    const pending = action(); this.mutation = pending;
    try { return await pending; } finally { this.mutation = null; }
  }
  private async createSnapshot(root: string, input: DocumentSelection & { baseDocId: string }) {
    if (this.shares.size >= 100) throw new DistributionError('分享数量已达 100，请先停止旧分享', 413);
    const { store, docs } = selectDocuments(root, input);
    const base = docs.find(d => d.doc.docId === input.baseDocId);
    if (!base) throw new DistributionError('基准文档必须在分享范围内');
    const id = randomBytes(24).toString('hex');
    const share: WebShare = { id, title: base.doc.title, releaseId: input.releaseId, createdAt: new Date().toISOString(), baseDocId: input.baseDocId,
      docs: docs.map(({ doc }, index) => ({ docId: doc.docId, title: doc.title, file: `${index}.html` })), images: {} };
    const destination = path.join(this.directory, id);
    const staging = path.join(this.directory, `${id}.tmp`);
    fs.mkdirSync(staging, { recursive: true });
    const media = new Map<string, string>();
    let totalBytes = 0;
    try {
      for (const [index, { doc, markdown }] of docs.entries()) {
        const rendered = renderDocument(markdown, href => {
          if (/^https?:|^mailto:/i.test(href)) return href;
          const target = relativeTarget(doc.path, href);
          const at = target ? docs.findIndex(d => d.doc.path === target.path) : -1;
          return at < 0 ? null : `/s/${id}/${at}.html${target!.hash}`;
        }, src => {
          const image = readImage(store, input.releaseId, doc, src);
          if (!image) return null;
          let file = media.get(image.path);
          if (!file) {
            totalBytes += image.bytes.length;
            if (totalBytes > 128 * 1024 ** 2) throw new DistributionError('分享图片超过 128 MB，请缩小分享范围', 413);
            file = `image-${media.size}${path.extname(image.path).toLowerCase()}`;
            media.set(image.path, file); share.images[file] = image.type;
            fs.writeFileSync(path.join(staging, file), image.bytes);
          }
          return `/s/${id}/${file}`;
        });
        fs.writeFileSync(path.join(staging, `${index}.html`), page(doc.title, rendered, share, !/^#\s/.test(markdown.trimStart())));
      }
      const links = share.docs.map(d => `<li><a href="/s/${id}/${d.file}">${escape(d.title)}${d.docId === input.baseDocId ? '（基准文档）' : ''}</a></li>`).join('');
      fs.writeFileSync(path.join(staging, 'index.html'), page(share.title, `<h2>分享目录</h2><ul>${links}</ul>`, share));
      fs.writeFileSync(path.join(staging, 'share.json'), JSON.stringify(share));
      await this.start();
      fs.renameSync(staging, destination);
      this.shares.set(id, share);
      return this.status();
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new DistributionError(`分享端口 ${this.port} 已被占用`, 503);
      throw error;
    }
  }
  async revoke(id: string) {
    return this.mutate(() => this.removeSnapshot(id));
  }
  private async removeSnapshot(id: string) {
    if (!this.shares.has(id) || !/^[a-f0-9]{48}$/.test(id)) throw new DistributionError('分享不存在', 404);
    // Remove durable metadata first; a failed delete must not silently re-enable on restart.
    fs.unlinkSync(resolveInside(this.directory, `${id}/share.json`, 'read'));
    this.shares.delete(id);
    const target = resolveInside(this.directory, id, 'read');
    fs.rmSync(target, { recursive: true, force: true });
    if (!this.shares.size) await this.stopListener();
    return this.status();
  }
  private handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    const fail = (status: number, text: string) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };
    if (!allowedSource(req.socket.remoteAddress ?? '')) return fail(403, '仅允许内网访问');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, '只读分享');
    const match = /^\/s\/([a-f0-9]{48})\/(\d+\.html|index\.html|image-\d+\.[a-z]+)?$/.exec((req.url ?? '').split('?')[0]);
    const share = match ? this.shares.get(match[1]) : null;
    if (!share || !match) return fail(404, '分享不存在或已停止');
    const file = match[2] || 'index.html';
    if (file !== 'index.html' && !share.docs.some(d => d.file === file) && !Object.hasOwn(share.images, file)) return fail(404, '文档不在分享范围内');
    try {
      const bytes = fs.readFileSync(resolveInside(this.directory, `${share.id}/${file}`, 'read'));
      res.writeHead(200, { 'Content-Type': share.images[file] ?? 'text/html; charset=utf-8', 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { fail(404, '分享文件不可用'); }
  }
}
