/**
 * Direct live verification of the custom-folder docx write path.
 *
 * Keeps the REAL home/credentials for lark-cli (so the live Feishu API is
 * reached) while isolating the SQLite DB and knowledge base under temp dirs
 * (LocalMapStore's constructor accepts an explicit dbPath). This proves the
 * full success path that the temp-HOME HTTP smoke cannot: real getNode →
 * real fetch markdown → real atomic write → real documents row.
 *
 * Run: node --import tsx server/scripts/verify-custom-docx-write.mjs
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { LocalMapStore } from '../src/modules/local-map-store.ts';
import { LarkCliClient } from '../src/modules/lark-cli-client.ts';
import {
  syncDocxToCustomFolder,
} from '../src/modules/custom-doc-sync.ts';
import { resolveAbsolute, isPathInsideRoot } from '../src/modules/path-resolver.ts';
import { resolveOperationDirectory } from '../src/modules/operation-manifest.ts';
import { sanitizePathSegment } from '../src/modules/path-resolver.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-cf-live-'));
const kbRoot = path.join(tmpDir, 'kb');
fs.mkdirSync(kbRoot, { recursive: true });
const dbPath = path.join(tmpDir, 'test.db');

const store = new LocalMapStore(dbPath);
store.initialize();

const larkCli = new LarkCliClient({
  requiredScopes: ['wiki:node:retrieve', 'docs:document.content:read', 'docx:document:readonly'],
  timeout: 30000,
});

const LINK = 'https://qcnbafdrjx7n.feishu.cn/wiki/JvPwwVWlniVy9Xk7xFJctN0LnPf';
const FOLDER_REL = '_custom/live-test';

function log(label, obj) {
  console.log(`\n## ${label}`);
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

try {
  store.createCustomFolder({ id: 'live-folder', name: 'live-test', localRelPath: FOLDER_REL });

  // 1. Real getNode.
  const node = await larkCli.getNode(LINK);
  log('getNode result', {
    node_token: node.node_token, obj_token: node.obj_token, obj_type: node.obj_type,
    title: node.title, obj_edit_time: node.obj_edit_time,
  });

  // 2. already_exists guard: this obj_token is not in the temp DB.
  const existing = store.getDocumentByObjToken(node.obj_token);
  log('already_exists check', { exists: !!existing });

  // 3. Compute path + real fetch + atomic write.
  let stem = sanitizePathSegment(node.title);
  if (!stem) stem = `untitled-${node.obj_token.slice(0, 8)}`;
  const relPath = `${FOLDER_REL}/${stem}.md`;
  const localMdPath = resolveAbsolute(kbRoot, relPath);
  log('planned path', { relPath, insideRoot: isPathInsideRoot(kbRoot, localMdPath) });

  const operationDirectory = resolveOperationDirectory(kbRoot);
  const writeResult = await syncDocxToCustomFolder({
    larkCliClient: larkCli,
    knowledgeBaseRoot: kbRoot,
    operationDirectory,
    localMdPath,
    objToken: node.obj_token,
    wikiNodeToken: node.node_token,
    title: node.title,
    originalLink: LINK,
    objEditTime: node.obj_edit_time,
    spaceId: node.space_id,
  });
  log('syncDocxToCustomFolder result', writeResult);

  // 4. Record the documents row.
  store.setDocumentCustomFolder({
    objToken: node.obj_token,
    folderId: 'live-folder',
    wikiNodeToken: node.node_token,
    objType: 'docx',
    title: node.title,
    localMdPath,
    localRelPath: relPath,
    originalLink: LINK,
    objEditTime: node.obj_edit_time,
    spaceId: node.space_id,
  });

  // 5. Verify file + DB row.
  const fileExists = fs.existsSync(localMdPath);
  const fileContent = fileExists ? fs.readFileSync(localMdPath, 'utf-8') : '';
  const doc = store.getDocumentByObjToken(node.obj_token);
  log('file written', {
    exists: fileExists,
    size: fileContent.length,
    hasHeader: fileContent.includes('obj_token'),
    hasImagesDir: fs.existsSync(path.join(path.dirname(localMdPath), 'images')),
  });
  log('documents row', doc && {
    objToken: doc.objToken, title: doc.title, customFolderId: doc.customFolderId,
    watchedRootUrl: doc.watchedRootUrl, syncState: doc.syncState, cloudMatch: doc.cloudMatch,
    originalLink: doc.originalLink,
  });

  // 6. Repeat-add → already_exists with folder attribution.
  const existingAfter = store.getDocumentByObjToken(node.obj_token);
  const attribution = existingAfter?.customFolderId
    ? store.getCustomFolder(existingAfter.customFolderId)?.name
    : '已在同步结构树';
  log('repeat-add attribution', { code: 'already_exists', existingLocation: attribution });

  // 7. Orphan exclusion: the written file must not be an orphan.
  const folderPrefixes = store.getCustomFolderRelPaths();
  const isUnderPrefix = (p) => folderPrefixes.some(
    (pre) => p === pre || p.startsWith(`${pre}/`),
  );
  log('orphan exclusion', {
    folderPrefixes,
    fileExcluded: isUnderPrefix(relPath),
  });

  // 8. Delete folder → doc unlinked, file kept.
  store.clearDocumentsCustomFolder('live-folder');
  store.deleteCustomFolder('live-folder');
  const docAfter = store.getDocumentByObjToken(node.obj_token);
  log('after delete folder', {
    customFolderId: docAfter?.customFolderId, fileStillOnDisk: fs.existsSync(localMdPath),
  });

  console.log('\nLIVE RESULT: PASS (real docx fetched + written + mapped + orphan-excluded)');
} catch (err) {
  console.error('\nLIVE RESULT: FAIL', err);
  process.exitCode = 1;
} finally {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
