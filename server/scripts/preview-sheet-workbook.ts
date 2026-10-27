/** Local UI verification using the shipped component and content routes.
 * No production configuration, database, cloud writes or source edits. */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// Use the frontend's Vite version, rather than the server test runner's copy.
import { createServer } from '../../node_modules/vite/dist/node/index.js';
import { Hono } from 'hono';
import { contentRoutes } from '../src/routes/content.js';

const source = path.resolve(process.argv[2] ?? '');
if (!/\.xlsx$/i.test(source) || !fs.statSync(source).isFile()) throw new Error('Usage: tsx server/scripts/preview-sheet-workbook.ts <existing.xlsx>');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = new Hono();
app.use('*', async (c, next) => {
  (c as any).configManager = { getConfig: () => ({ knowledgeBaseRoot: path.dirname(source) }) };
  (c as any).localMapStore = { getDocumentByObjToken: (token: string) => token === 'verification' ? {
    objToken: token, objType: 'sheet', title: path.basename(source), localMdPath: source.replace(/\.xlsx$/i, '.md'),
  } : null };
  await next();
});
app.route('/', contentRoutes);
const server = await createServer({
  root: projectRoot,
  configFile: path.join(projectRoot, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'workbook-verification', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      try {
        const url = request.url ?? '/';
        if (url.startsWith('/api/mapping/')) {
          const result = await app.fetch(new Request(`http://127.0.0.1${url}`));
          response.statusCode = result.status;
          result.headers.forEach((value, key) => response.setHeader(key, value));
          response.end(Buffer.from(await result.arrayBuffer()));
        } else if (url === '/__workbook-verification') {
          const html = await vite.transformIndexHtml(url, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Excel 画板预览验证</title></head><body style="margin:0"><div id="root"></div><script type="module">
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { WorkbookView } from '/src/components/preview/WorkbookView.tsx';
            import { getDocumentContent } from '/src/api/client.ts';
            import '/src/styles/index.css';
            const content = await getDocumentContent('verification');
            createRoot(document.getElementById('root')).render(React.createElement('main', {style:{height:'100vh',display:'flex',flexDirection:'column'}},React.createElement(WorkbookView,{objToken:'verification',fileName:content.workbook?.path ?? 'workbook.xlsx',mode:content.workbook?.mode})));
          </script></body></html>`);
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } else next();
      } catch (error) { next(error); }
    });
  } }],
});
await server.listen();
console.info(JSON.stringify({ url: `${server.resolvedUrls?.local[0]}__workbook-verification`, pid: process.pid }));
process.once('SIGINT', () => { void server.close().then(() => process.exit()); });
