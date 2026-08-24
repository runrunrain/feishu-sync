/**
 * Reconciliation dry-run tests against the desensitized corpus fixture.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReconciliationReport,
  formatReconciliationMarkdown,
} from '../src/modules/reconciliation.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
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

// ---------------------------------------------------------------------------
// Custom-folder prefix auto-load from SQLite (diting review Major #6).
// ---------------------------------------------------------------------------

describe('buildReconciliationReport custom-folder exclusion', () => {
  it('auto-loads custom-folder prefixes from dbPath so _custom is not outside_watched_roots', () => {
    // A throwaway KB with one watched-root doc and one _custom file.
    const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-recon-cf-'));
    try {
      const watchedDir = path.join(kbRoot, '技术 - Dev');
      fs.mkdirSync(watchedDir, { recursive: true });
      fs.writeFileSync(
        path.join(watchedDir, 'README.md'),
        '<!--\nfeishu_sync:\n  obj_token: "objDev"\n  wiki_node_token: "nDev"\n-->\n# Dev',
      );
      const customDir = path.join(kbRoot, '_custom', 'my-folder');
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(
        path.join(customDir, 'note.md'),
        '<!--\nfeishu_sync:\n  obj_token: "objCustom"\n-->\n# Note',
      );

      // A SQLite DB whose custom_folders row declares _custom/my-folder.
      const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-recon-db-'));
      const dbPath = path.join(dbDir, 'test.db');
      const store = new LocalMapStore(dbPath);
      store.initialize();
      store.createCustomFolder({
        id: 'f1', name: 'my-folder', localRelPath: '_custom/my-folder',
      });
      store.close();

      const roots: WatchedRootConfig[] = [
        {
          id: 'dev', url: 'https://example.feishu.cn/wiki/dev',
          localDir: '技术 - Dev', layoutProfile: 'directory-readme', enabled: true,
        },
      ];

      // Without dbPath AND without customFolderRelPaths: _custom is misclassified.
      const naive = buildReconciliationReport({
        knowledgeBaseRoot: kbRoot, watchedRoots: roots,
      });
      const naiveCustom = naive.items.find((i) => i.relativePath.startsWith('_custom/'));
      expect(naiveCustom?.classification).toBe('outside_watched_roots');

      // With dbPath: prefixes are auto-loaded, _custom is excluded from the report.
      const smart = buildReconciliationReport({
        knowledgeBaseRoot: kbRoot, watchedRoots: roots, dbPath,
      });
      expect(smart.items.find((i) => i.relativePath.startsWith('_custom/'))).toBeUndefined();
      // The watched-root doc is still classified normally.
      expect(smart.items.some((i) => i.relativePath.endsWith('README.md'))).toBe(true);

      fs.rmSync(dbDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(kbRoot, { recursive: true, force: true });
    }
  });
});
