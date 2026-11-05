import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { LocalMapStore } from '../../server/src/modules/local-map-store.ts';
import { projectKnowledgeDocuments, recoveredSourceCsvPaths } from '../../server/src/kb/local-source-projection.ts';
import { filterDeletedLocalDocuments } from '../../server/src/modules/local-index-reconcile.ts';
import { RawSourceSnapshot } from '../../server/src/kb/raw-source-snapshot.ts';
import { enrichEntriesWithMedia } from '../../server/src/kb/source-images.ts';
const home = path.join(os.homedir(), '.feishu-sync');
const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
const cpRoot = path.join(config.standardKb.outputRoot, '.builds/b_20261104133247_9481ce/checkpoints');
const pointer = JSON.parse(fs.readFileSync(path.join(cpRoot, 'CURRENT.json'), 'utf8'));
const cp = JSON.parse(fs.readFileSync(path.join(cpRoot, pointer.generation, 'state.json'), 'utf8'));
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const store = Object.create(LocalMapStore.prototype);
store.db = new Database(path.join(home, 'feishu-sync.db'), { readonly: true }); store.statements = new Map();
const docs = projectKnowledgeDocuments(config.knowledgeBaseRoot,
  filterDeletedLocalDocuments(store, config.knowledgeBaseRoot, store.getAllDocuments()));
const byToken = new Map(docs.map((doc) => [doc.objToken, doc]));
const csv = (token) => recoveredSourceCsvPaths(config.knowledgeBaseRoot, byToken.get(token),
  store.getSheetSheets(token).map((sheet) => sheet.local_csv_path).filter(Boolean));
const excluded = new Set([...store.listKbExplicitlyExcludedSources(config.knowledgeBaseRoot), ...store.listPublishedCloudTokens()]);
const live = RawSourceSnapshot.scan(config.knowledgeBaseRoot, docs.filter((doc) => !excluded.has(doc.objToken)), csv).entries;
enrichEntriesWithMedia(config.knowledgeBaseRoot, live);
const old = new Map(cp.snapshot.map((entry) => [entry.objToken, entry]));
const current = new Map(live.map((entry) => [entry.objToken, entry]));
const changed = [];
for (const [token, before] of old) {
  const after = current.get(token);
  if (!after) changed.push({ token, title: before.title, removed: true });
  else {
    const fields = ['relPath', 'contentHash', 'mediaHash', 'whiteboardTextHash'].filter((key) => (before[key] ?? '') !== (after[key] ?? ''));
    if (fields.length) changed.push({ token, title: before.title, fields });
  }
}
console.log(JSON.stringify({ oldCount: old.size, currentCount: current.size, changed,
  added: live.filter((entry) => !old.has(entry.objToken)).map((entry) => ({ token: entry.objToken, title: entry.title })) }));
store.db.close();
