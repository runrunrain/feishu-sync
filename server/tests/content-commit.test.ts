/**
 * P3 content commit: atomic file commit + failure injection against shipped path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitDocumentContent } from '../src/modules/content-commit.js';
import {
  renderDocumentMarkdown,
  type DocumentIR,
} from '../src/modules/document-ir.js';
import Database from 'better-sqlite3';

function makeIr(overrides: Partial<DocumentIR> = {}): DocumentIR {
  return {
    objToken: 'tok-doc',
    wikiNodeToken: 'node-doc',
    spaceId: null,
    objType: 'docx',
    title: '示例文档',
    originalLink: 'https://example.feishu.cn/wiki/node-doc',
    observedObjEditTime: 1_700_000_000_000,
    bodyMarkdown: '正文段落。\n',
    images: [],
    attachments: [],
    sheets: [],
    ...overrides,
  };
}

describe('commitDocumentContent', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
    temps.length = 0;
  });

  it('successfully commits docx markdown and leaves second content hash stable', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kb-'));
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ops-'));
    temps.push(kb, ops);
    const localMdPath = path.join(kb, '技术 - Dev', '示例文档', 'README.md');

    const result = commitDocumentContent({
      operationId: 'op-success',
      knowledgeBaseRoot: kb,
      operationDirectory: ops,
      localMdPath,
      ir: makeIr(),
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(localMdPath)).toBe(true);
    const body = fs.readFileSync(localMdPath, 'utf-8');
    expect(body).toContain('obj_token: "tok-doc"');
    expect(body).toContain('# 示例文档');
    expect(body).toContain('正文段落');
  });

  it('renders live Feishu Unix-second edit times as a real ISO timestamp', () => {
    const rendered = renderDocumentMarkdown(
      makeIr({ observedObjEditTime: 1_783_589_445 }),
      { fetchDate: '2026-07-17' },
    );

    expect(rendered.markdown).toContain(
      'last_synced_modify_time: "2026-07-09T09:30:45.000Z"',
    );
    expect(rendered.markdown).not.toContain('1970-01-21');
  });

  it('sheet all-or-nothing: empty CSV aborts and does not replace prior body', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sheet-'));
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ops-s-'));
    temps.push(kb, ops);
    const localMdPath = path.join(kb, '策划 - Designer', '表格.md');
    fs.mkdirSync(path.dirname(localMdPath), { recursive: true });
    fs.writeFileSync(localMdPath, '# prior sheet body\n');

    const result = commitDocumentContent({
      operationId: 'op-empty-csv',
      knowledgeBaseRoot: kb,
      operationDirectory: ops,
      localMdPath,
      ir: makeIr({
        objType: 'sheet',
        title: '表格',
        sheets: [
          {
            sheetId: 's1',
            title: '主表',
            csvRelativePath: '表格.csv-data/主表.csv',
            csvContent: '   ',
          },
        ],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/CSV 为空/);
    expect(fs.readFileSync(localMdPath, 'utf-8')).toBe('# prior sheet body\n');
  });

  it('failBeforeCommit leaves prior file unchanged and does not advance DB synced', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fail1-'));
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ops-f1-'));
    temps.push(kb, ops);
    const localMdPath = path.join(kb, 'a.md');
    fs.writeFileSync(localMdPath, 'old\n');
    const dbPath = path.join(ops, 'map.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE documents (obj_token TEXT PRIMARY KEY, synced_obj_edit_time INTEGER, title TEXT);`);
    db.prepare(`INSERT INTO documents VALUES ('tok-doc', 100, 'old')`).run();
    db.close();

    const result = commitDocumentContent({
      operationId: 'op-fail-before',
      knowledgeBaseRoot: kb,
      operationDirectory: ops,
      localMdPath,
      ir: makeIr({ bodyMarkdown: 'new\n' }),
      failBeforeCommit: true,
    });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(localMdPath, 'utf-8')).toBe('old\n');

    // Simulate caller rule: only mark synced on ok
    if (result.ok) {
      const w = new Database(dbPath);
      w.prepare(`UPDATE documents SET synced_obj_edit_time=999 WHERE obj_token='tok-doc'`).run();
      w.close();
    }
    const r = new Database(dbPath, { readonly: true });
    const row = r.prepare(`SELECT synced_obj_edit_time FROM documents WHERE obj_token='tok-doc'`).get() as any;
    expect(row.synced_obj_edit_time).toBe(100);
    r.close();
  });

  it('failAfterFileCommit restores prior file so synced baseline can stay put', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fail2-'));
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ops-f2-'));
    temps.push(kb, ops);
    const localMdPath = path.join(kb, 'b.md');
    fs.writeFileSync(localMdPath, 'baseline\n');

    const result = commitDocumentContent({
      operationId: 'op-fail-after',
      knowledgeBaseRoot: kb,
      operationDirectory: ops,
      localMdPath,
      ir: makeIr({ bodyMarkdown: 'should rollback\n' }),
      failAfterFileCommit: true,
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(fs.readFileSync(localMdPath, 'utf-8')).toBe('baseline\n');
  });

  it('successful multi-sheet commit writes CSV links that exist on disk', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-multi-'));
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ops-m-'));
    temps.push(kb, ops);
    const localMdPath = path.join(kb, '策划 - Designer', '多表.md');

    const result = commitDocumentContent({
      operationId: 'op-multi',
      knowledgeBaseRoot: kb,
      operationDirectory: ops,
      localMdPath,
      ir: makeIr({
        objType: 'sheet',
        title: '多表',
        bodyMarkdown: '',
        sheets: [
          {
            sheetId: 's1',
            title: 'A',
            csvRelativePath: '多表.csv-data/A.csv',
            csvContent: 'c1\n1\n',
          },
          {
            sheetId: 's2',
            title: 'B',
            csvRelativePath: '多表.csv-data/B.csv',
            csvContent: 'c2\n2\n',
          },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    const md = fs.readFileSync(localMdPath, 'utf-8');
    expect(md).toContain('## 子表: A');
    expect(md).toContain('## 子表: B');
    expect(fs.existsSync(path.join(kb, '策划 - Designer', '多表.csv-data', 'A.csv'))).toBe(true);
    expect(fs.existsSync(path.join(kb, '策划 - Designer', '多表.csv-data', 'B.csv'))).toBe(true);
  });
});
