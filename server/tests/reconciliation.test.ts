/**
 * Reconciliation dry-run tests against the desensitized corpus fixture.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReconciliationReport,
  formatReconciliationMarkdown,
} from '../src/modules/reconciliation.js';
import type { WatchedRootConfig } from '../src/types/index.js';

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/corpus-contract',
);

const roots: WatchedRootConfig[] = [
  {
    id: 'dev',
    url: 'https://example.feishu.cn/wiki/dev',
    localDir: 'directory-readme/技术 - Dev',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
  {
    id: 'designer',
    url: 'https://example.feishu.cn/wiki/designer',
    localDir: 'mirror-title-file/策划 - Designer',
    layoutProfile: 'mirror-title-file',
    enabled: true,
  },
];

describe('buildReconciliationReport', () => {
  it('classifies fixture markdown without writing files', () => {
    const report = buildReconciliationReport({
      knowledgeBaseRoot: fixtureRoot,
      watchedRoots: roots,
    });

    expect(report.mode).toBe('dry-run');
    expect(report.summary.markdownTotal).toBeGreaterThanOrEqual(7);
    expect(report.summary.byClass.pre_migrate ?? 0).toBeGreaterThanOrEqual(1);

    const indexed = report.items.filter(
      (item) =>
        item.classification === 'indexed_unique' ||
        item.classification === 'indexed_readme_title_fixed' ||
        item.classification === 'profile_path_mismatch',
    );
    expect(indexed.length).toBeGreaterThanOrEqual(6);

    // Fixture README titles come from H1, not literal "README".
    const readmeItems = report.items.filter((item) =>
      item.relativePath.endsWith('/README.md') || item.relativePath === 'README.md',
    );
    for (const item of readmeItems) {
      if (item.objToken) {
        expect(item.title).not.toBe('README');
      }
    }

    const md = formatReconciliationMarkdown(report);
    expect(md).toContain('知识库对账报告');
    expect(md).toContain('分类汇总');
  });
});
