/**
 * Disposable-KB canary for P3 atomic commit + rollback (no live Feishu required).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { rollbackAtomicPlan } from '../src/modules/atomic-commit.js';
import { commitDocumentContent } from '../src/modules/content-commit.js';

const scratch =
  process.env.SCRATCH ||
  '/var/folders/81/zk31vz7j4bgb0k41z2g_hfgr0000gn/T/grok-goal-d74db4dec1c8/implementer';
const kb = path.join(scratch, 'canary', 'kb');
const ops = path.join(scratch, 'canary', 'ops');
fs.rmSync(path.dirname(kb), { recursive: true, force: true });
fs.mkdirSync(kb, { recursive: true });
fs.mkdirSync(ops, { recursive: true });

function sha(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const docxPath = path.join(kb, '技术 - Dev', 'canary-docx', 'README.md');
fs.mkdirSync(path.dirname(docxPath), { recursive: true });
fs.writeFileSync(docxPath, '# prior docx\n');
const priorHash = sha(docxPath);

const docx = commitDocumentContent({
  operationId: 'canary-docx-1',
  knowledgeBaseRoot: kb,
  operationDirectory: ops,
  localMdPath: docxPath,
  ir: {
    objToken: 'canary-docx-token',
    wikiNodeToken: 'canary-docx-node',
    spaceId: null,
    objType: 'docx',
    title: 'canary-docx',
    originalLink: 'https://example.feishu.cn/wiki/canary-docx-node',
    observedObjEditTime: Date.now(),
    bodyMarkdown: 'canary body after apply\n',
    images: [],
    attachments: [],
    sheets: [],
  },
});
const afterHash = sha(docxPath);
const rolled = rollbackAtomicPlan(docx.plan);
const restoredHash = sha(docxPath);

const sheetPath = path.join(kb, '策划 - Designer', 'canary-sheet.md');
const sheet = commitDocumentContent({
  operationId: 'canary-sheet-1',
  knowledgeBaseRoot: kb,
  operationDirectory: ops,
  localMdPath: sheetPath,
  ir: {
    objToken: 'canary-sheet-token',
    wikiNodeToken: 'canary-sheet-node',
    spaceId: null,
    objType: 'sheet',
    title: 'canary-sheet',
    originalLink: null,
    observedObjEditTime: null,
    bodyMarkdown: '',
    images: [],
    attachments: [],
    sheets: [
      {
        sheetId: 's1',
        title: '主表',
        csvRelativePath: 'canary-sheet.csv-data/主表.csv',
        csvContent: 'a,b\n1,2\n',
      },
      {
        sheetId: 's2',
        title: '附表',
        csvRelativePath: 'canary-sheet.csv-data/附表.csv',
        csvContent: 'x\n9\n',
      },
    ],
  },
});

const evidence = {
  docxOk: docx.ok,
  docxOp: docx.operationId,
  priorHash,
  afterHash,
  restoredHash,
  rollbackOk: rolled.ok,
  rollbackRestored: restoredHash === priorHash,
  sheetOk: sheet.ok,
  sheetOp: sheet.operationId,
  sheetCsvs: [
    fs.existsSync(path.join(kb, '策划 - Designer', 'canary-sheet.csv-data', '主表.csv')),
    fs.existsSync(path.join(kb, '策划 - Designer', 'canary-sheet.csv-data', '附表.csv')),
  ],
  note: 'Live Feishu user auth expired; canary uses shipped atomic commit path without CLI fetch.',
};

fs.writeFileSync(
  path.join(scratch, 'canary', 'evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.docxOk || !evidence.sheetOk || !evidence.rollbackRestored) {
  process.exit(2);
}
