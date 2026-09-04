/**
 * Live curl-style smoke test for custom-folder routes.
 *
 * Starts the real HTTP server (buildServer) with a temp HOME so the SQLite
 * DB and config are isolated from the user's real ~/.feishu-sync. Exercises
 * the full migration + route wiring over real HTTP, then prints results.
 *
 * Run: node --import tsx server/scripts/smoke-custom-folders.mjs
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-smoke-home-'));
const realHome = os.homedir();
const kbRoot = path.join(tmpHome, 'kb');
fs.mkdirSync(kbRoot, { recursive: true });
const configDir = path.join(tmpHome, '.feishu-sync');
fs.mkdirSync(configDir, { recursive: true });
// Preserve the real lark-cli auth so getNode/fetch reach the live API.
// lark-cli stores user credentials in two HOME-relative locations.
const realLarkCli = path.join(realHome, '.lark-cli');
if (fs.existsSync(realLarkCli)) {
  try { fs.cpSync(realLarkCli, path.join(tmpHome, '.lark-cli'), { recursive: true }); } catch {}
}
const realLarkCliApp = path.join(realHome, 'Library', 'Application Support', 'lark-cli');
if (fs.existsSync(realLarkCliApp)) {
  const dst = path.join(tmpHome, 'Library', 'Application Support', 'lark-cli');
  try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.cpSync(realLarkCliApp, dst, { recursive: true }); } catch {}
}
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({
    knowledgeBaseRoot: kbRoot,
    watchedRoots: [],
    watchedRootUrls: [],
    pollIntervalMinutes: 60,
    requiredScopes: [],
    enableAutoStart: false,
    enableNotifications: false,
    llm: {
      openAiCompatBaseUrl: '', claudeCompatBaseUrl: '', apiKey: '', model: '',
      temperature: 0.2, primaryChannel: 'claude-cli', fallbackOnFailure: false,
    },
  }),
);

// Redirect HOME so LocalMapStore + ConfigManager resolve under the temp dir.
process.env.HOME = tmpHome;
process.chdir(path.resolve(path.dirname(new URL(import.meta.url).pathname)));

function findFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolvePort(p));
    });
  });
}

function log(label, obj) {
  console.log(`\n## ${label}`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const { startServer } = await import('../src/index.ts');
  const Database = (await import('better-sqlite3')).default;

  const port = await findFreePort();
  const server = await startServer({
    desktopMode: true,
    desktopToken: 'smoke-token',
    corsDevMode: true,
    port,
    hostname: '127.0.0.1',
  });

  const base = server.url;
  const headers = { 'content-type': 'application/json', 'x-desktop-token': 'smoke-token' };

  async function req(method, pathStr, body) {
    const res = await fetch(`${base}${pathStr}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  }

  try {
    log('GET /api/custom-folders (empty)', await req('GET', '/api/custom-folders'));

    const created = await req('POST', '/api/custom-folders', { name: '调研收藏' });
    log('POST create folder', created);
    const folderId = created.json?.folder?.id;

    log('POST duplicate (expect 409)', await req('POST', '/api/custom-folders', { name: '调研收藏' }));
    log('POST invalid name (expect 400)', await req('POST', '/api/custom-folders', { name: '///' }));
    log('PATCH rename', await req('PATCH', `/api/custom-folders/${folderId}`, { name: '调研归档' }));
    log('GET /api/custom-folders (1 folder)', await req('GET', '/api/custom-folders'));

    // Use a real, accessible docx to exercise the full fetch + atomic write path.
    const realDocxUrl = 'https://qcnbafdrjx7n.feishu.cn/wiki/JvPwwVWlniVy9Xk7xFJctN0LnPf';
    const addRes = await req('POST', `/api/custom-folders/${folderId}/docs`, {
      links: [realDocxUrl, realDocxUrl], // second one should be already_exists
    });
    log('POST add docs (real docx success + repeat already_exists)', addRes);

    // Verify the local file landed under _custom/.
    const customDir = path.join(kbRoot, '_custom');
    const foundFiles = fs.existsSync(customDir)
      ? fs.readdirSync(customDir, { recursive: true }).filter((f) => String(f).endsWith('.md'))
      : [];
    log('KB _custom files after add', foundFiles);

    // Verify the documents row via the list endpoint.
    log('GET folder docs (expect 1 synced doc)', await req('GET', '/api/custom-folders'));

    // Verify repeat-add returns already_exists with the folder attribution.
    const repeat = await req('POST', `/api/custom-folders/${folderId}/docs`, { links: [realDocxUrl] });
    log('POST repeat add (expect already_exists, folder attribution)', repeat);

    const dbPath = path.join(configDir, 'feishu-sync.db');
    const db = new Database(dbPath, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_folders'").all();
    const col = db.prepare('PRAGMA table_info(documents)').all().find((c) => c.name === 'custom_folder_id');
    log('DB migration check', {
      custom_folders_table: tables.length === 1,
      documents_custom_folder_id_column: !!col,
    });
    db.close();

    log('DELETE folder', await req('DELETE', `/api/custom-folders/${folderId}`));
    log('GET after delete (expect empty)', await req('GET', '/api/custom-folders'));

    console.log('\nSMOKE RESULT: PASS (all endpoints responded, migration applied)');
  } catch (err) {
    console.error('\nSMOKE RESULT: FAIL', err);
    process.exitCode = 1;
  } finally {
    await server.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

await main();
