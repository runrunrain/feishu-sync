import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitAtomicPlan,
  createAtomicCommitWorkspace,
  emptyCommitPlan,
  rollbackAtomicPlan,
  stageFileContent,
} from '../src/modules/atomic-commit.js';
import {
  renderDocumentMarkdown,
  validateRenderedResources,
  type DocumentIR,
} from '../src/modules/document-ir.js';

describe('atomic-commit + document-ir', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
    temps.length = 0;
  });

  it('commits staged markdown+csv and rolls back on explicit restore', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-kb-'));
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-ops-'));
    temps.push(kb, ops);

    const targetMd = path.join(kb, '策划 - Designer', '表格.md');
    fs.mkdirSync(path.dirname(targetMd), { recursive: true });
    fs.writeFileSync(targetMd, '# old\n');

    const { stagingRoot, rollbackRoot } = createAtomicCommitWorkspace({
      operationId: 'op-atomic-1',
      knowledgeBaseRoot: kb,
      operationDirectory: ops,
    });
    const plan = emptyCommitPlan({
      operationId: 'op-atomic-1',
      knowledgeBaseRoot: kb,
      stagingRoot,
      rollbackRoot,
    });

    stageFileContent(plan, '策划 - Designer/表格.md', '# new body\n');
    stageFileContent(plan, '策划 - Designer/表格.csv-data/主表.csv', 'a,b\n1,2\n');

    const result = commitAtomicPlan(plan);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(targetMd, 'utf-8')).toContain('new body');
    expect(
      fs.readFileSync(path.join(kb, '策划 - Designer', '表格.csv-data', '主表.csv'), 'utf-8'),
    ).toContain('1,2');

    const rolled = rollbackAtomicPlan(plan);
    expect(rolled.ok).toBe(true);
    expect(fs.readFileSync(targetMd, 'utf-8')).toBe('# old\n');
  });

  it('restores prior files when a mid-commit failure is simulated', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-kb-fail-'));
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-ops-fail-'));
    temps.push(kb, ops);

    const first = path.join(kb, 'a.md');
    fs.writeFileSync(first, 'v1\n');

    const { stagingRoot, rollbackRoot } = createAtomicCommitWorkspace({
      operationId: 'op-fail',
      knowledgeBaseRoot: kb,
      operationDirectory: ops,
    });
    const plan = emptyCommitPlan({
      operationId: 'op-fail',
      knowledgeBaseRoot: kb,
      stagingRoot,
      rollbackRoot,
    });
    stageFileContent(plan, 'a.md', 'v2\n');
    // Second entry points at a missing staging file to force failure after first commit.
    plan.files.push({
      relativePath: 'b.md',
      action: 'create',
      stagingAbsolutePath: path.join(stagingRoot, 'missing-b.md'),
      targetAbsolutePath: path.join(kb, 'b.md'),
      previousSha256: null,
      newSha256: null,
    });

    const result = commitAtomicPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.restored).toContain('a.md');
    expect(fs.readFileSync(first, 'utf-8')).toBe('v1\n');
    expect(fs.existsSync(path.join(kb, 'b.md'))).toBe(false);
  });

  it('renders sheet IR with 子表 sections and validates resources', () => {
    const ir: DocumentIR = {
      objToken: 'tok',
      wikiNodeToken: 'node',
      spaceId: null,
      objType: 'sheet',
      title: '表格配置',
      originalLink: 'https://example.feishu.cn/wiki/node',
      observedObjEditTime: null,
      bodyMarkdown: '',
      images: [],
      attachments: [],
      sheets: [
        {
          sheetId: 's1',
          title: '主表',
          csvRelativePath: '表格配置.csv-data/主表.csv',
          csvContent: 'x\n1\n',
        },
      ],
    };
    const rendered = renderDocumentMarkdown(ir);
    expect(rendered.markdown).toContain('## 子表: 主表');
    expect(rendered.markdown).toContain('表格配置.csv-data/主表.csv');
    expect(rendered.requiredRelativePaths).toEqual(['表格配置.csv-data/主表.csv']);

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-val-'));
    temps.push(base);
    const errorsMissing = validateRenderedResources(
      base,
      rendered.requiredRelativePaths,
      (p) => fs.existsSync(p),
      (p) => fs.statSync(p).size,
    );
    expect(errorsMissing.some((e) => e.includes('缺失'))).toBe(true);

    const csvPath = path.join(base, '表格配置.csv-data', '主表.csv');
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, 'x\n1\n');
    const ok = validateRenderedResources(
      base,
      rendered.requiredRelativePaths,
      (p) => fs.existsSync(p),
      (p) => fs.statSync(p).size,
    );
    expect(ok).toEqual([]);
  });
});
