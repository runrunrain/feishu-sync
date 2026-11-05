import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import ExcelJS from 'exceljs';

it('real Electron utility backend isolates workbook CPU, preserves image tiling and shuts down a blocked tool', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const executable = process.platform === 'darwin' ? path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(repo, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(executable)) throw Error('Electron runtime is required for desktop performance acceptance');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-tool-performance-'));
  try {
    const compile = (entry: string, name: string) => build({ entryPoints: [path.join(repo, entry)], bundle: true, platform: 'node',
      format: 'cjs', external: ['electron'], outfile: path.join(root, name), logLevel: 'silent' });
    await Promise.all([compile('electron/server-process.ts', 'controller.cjs'), compile('electron/server-process-entry.ts', 'entry.cjs'),
      compile('server/src/kb/raw-workbook.ts', 'workbook.cjs'), compile('server/src/agent/vision/vision-image-tiles.ts', 'vision.cjs')]);
    const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet('pressure');
    for (let row = 1; row <= 6000; row++) sheet.addRow(Array.from({ length: 24 }, (_, col) => `value ${row}:${col} ${'data '.repeat(8)}`));
    await wb.xlsx.writeFile(path.join(root, 'bench.xlsx')); fs.writeFileSync(path.join(root, 'bench.md'), '---\nsource:\n  source_workbook: "bench.xlsx"\n---\n');
    const catalog = { root, updatedAt: '', entries: [] }; const entry = { objToken: 'bench', title: 'bench', relPath: 'bench.md', attachments: [] };
    fs.writeFileSync(path.join(root, 'fixture.mjs'), `
import http from 'node:http';import fs from 'node:fs';import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
const {loadRawWorkbook}=require('./workbook.cjs');const {createVisionImageTiles}=require('./vision.cjs');
export async function startServer(){const server=http.createServer(async(req,res)=>{
 if(req.url==='/hang'){for(;;){} }
 if(req.url==='/image'){const tiles=await createVisionImageTiles({bytes:fs.readFileSync(${JSON.stringify(path.join(root, 'test.png'))}),mime:'image/png'});res.end(JSON.stringify({tiles:tiles.length}));return;}
 const {workbook,contentHash}=await loadRawWorkbook(${JSON.stringify(catalog)},${JSON.stringify(entry)});res.end(JSON.stringify({pid:process.pid,rows:workbook.worksheets[0].rowCount,contentHash}));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;return{url:'http://127.0.0.1:'+port,port,close:()=>new Promise(r=>server.close(r))};}
`);
    fs.writeFileSync(path.join(root, 'main.cjs'), `
const {app,nativeImage}=require('electron');const fs=require('node:fs');const {performance}=require('node:perf_hooks');
const {startServerProcess}=require('./controller.cjs');const {loadRawWorkbook}=require('./workbook.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function measure(work){let last=performance.now(),maxGap=0;const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now},16);await sleep(30);const at=performance.now();const value=await work();const duration=performance.now()-at;await sleep(30);clearInterval(timer);return{duration,maxGap,value};}
app.whenReady().then(async()=>{let server;try{
 const bitmap=Buffer.alloc(400*400*4,255);for(let y=150;y<250;y++)for(let x=150;x<250;x++){const i=(y*400+x)*4;bitmap[i]=0;bitmap[i+1]=0;bitmap[i+2]=0;}
 fs.writeFileSync(${JSON.stringify(path.join(root, 'test.png'))},nativeImage.createFromBitmap(bitmap,{width:400,height:400}).toPNG());
 const baseline=await measure(async()=>{const r=await loadRawWorkbook(${JSON.stringify(catalog)},${JSON.stringify(entry)});return r.contentHash});
 server=await startServerProcess({entryPath:${JSON.stringify(path.join(root, 'entry.cjs'))},serverPath:${JSON.stringify(path.join(root, 'fixture.mjs'))},desktopToken:'synthetic',corsDevMode:false,shutdownTimeoutMs:250});
 const isolated=await measure(async()=>await(await fetch(server.url+'/workbook')).json());
 const image=await(await fetch(server.url+'/image')).json();
 void fetch(server.url+'/hang').catch(()=>{});await sleep(80);const start=performance.now();await Promise.all([server.close(),server.close()]);const closeMs=performance.now()-start;
 console.log('DESKTOP_PERF='+JSON.stringify({baseline,isolated,image,closeMs,mainPid:process.pid,backendPid:server.pid}));app.exit(0);
}catch(e){console.error(e.stack);if(server)await server.close();app.exit(1)}});
`);
    const env = { ...process.env, FEISHU_SYNC_HOME: path.join(root, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
    const args = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];
    const { stdout } = await promisify(execFile)(executable, [...args, path.join(root, 'main.cjs')], { env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(stdout.split('\n').find((line) => line.startsWith('DESKTOP_PERF='))!.slice('DESKTOP_PERF='.length));
    console.info('Desktop workbook performance:', JSON.stringify(result));
    expect(result.backendPid).not.toBe(result.mainPid);
    expect(result.isolated.value.rows).toBe(6000);
    expect(result.isolated.value.contentHash).toBe(result.baseline.value);
    expect(result.image.tiles).toBeGreaterThan(0);
    expect(result.isolated.maxGap).toBeLessThan(Math.max(180, result.baseline.maxGap * 0.5));
    expect(result.closeMs).toBeLessThan(2000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);
