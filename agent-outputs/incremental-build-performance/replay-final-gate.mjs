import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { KbBuildService } from '../../server/src/kb/kb-build-service.ts';
import { RawSourceSnapshot } from '../../server/src/kb/raw-source-snapshot.ts';
import { recoveredSourceCsvPaths } from '../../server/src/kb/local-source-projection.ts';

const home = path.join(os.homedir(), '.feishu-sync');
const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
const buildId = 'b_20261104133247_9481ce';
const root = config.standardKb.outputRoot;
const checkpoints = path.join(root, '.builds', buildId, 'checkpoints');
const pointer = JSON.parse(fs.readFileSync(path.join(checkpoints, 'CURRENT.json'), 'utf8'));
const checkpoint = JSON.parse(fs.readFileSync(path.join(checkpoints, pointer.generation, 'state.json'), 'utf8'));
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const db = new Database(path.join(home, 'feishu-sync.db'), { readonly: true });
const csvPaths = new Map(checkpoint.snapshot.map((entry) => [entry.objToken,
  recoveredSourceCsvPaths(checkpoint.knowledgeBaseRoot, { objToken: entry.objToken, objType: entry.objType, localRelPath: entry.relPath },
    db.prepare('SELECT local_csv_path FROM sheet_sheets WHERE sheet_obj_token = ? ORDER BY sheet_id').all(entry.objToken)
      .map((item) => item.local_csv_path).filter(Boolean))]));
db.close();
const snapshot = RawSourceSnapshot.fromEntries(checkpoint.snapshot, { sheetCsvPaths: (id) => csvPaths.get(id) ?? [] });
const writeLiveReport = process.argv.includes('--write-live-report');
if (writeLiveReport) {
  const endpointPath = path.join(home, 'run/endpoint.json');
  if (fs.existsSync(endpointPath)) {
    const endpoint = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
    try { process.kill(endpoint.pid, 0); throw new Error('Application is still running; refusing live report rewrite'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
const temp = writeLiveReport ? root : fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-final-gate-replay-'));
const stage = path.join(temp, '.staging', buildId);
if (!writeLiveReport) {
fs.cpSync(path.join(root, '.staging', buildId), stage, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
fs.cpSync(path.join(root, 'releases', checkpoint.baseReleaseId), path.join(temp, 'releases', checkpoint.baseReleaseId),
  { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
}
const service = Object.create(KbBuildService.prototype);
service.deps = { configProvider: () => config };
service.emitLog = () => {};
const started = Date.now();
try {
  const result = await service.prepareKnowledgePublish({ buildId, releaseId: 'replay', mode: checkpoint.mode,
    stagingRoot: stage, outputRoot: temp, snapshot, knowledgeBaseRoot: checkpoint.knowledgeBaseRoot,
    baseReleaseId: checkpoint.baseReleaseId, publicationStage: 'final',
    imageDescriptions: new Map(checkpoint.imageDescriptions.map(([id, values]) => [id, new Map(values)])) });
  console.log(JSON.stringify({ passed: true, evidenceFiles: result.evidenceFileWrites.length, elapsedMs: Date.now() - started, temp }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, code: error.code, message: error.message,
    details: error.details, elapsedMs: Date.now() - started, temp }));
}
