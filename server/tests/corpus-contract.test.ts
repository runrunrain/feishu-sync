import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexScanner, resolveDocumentTitle } from '../src/modules/index-scanner.js';
import { createKnowledgeBaseAudit } from '../src/modules/operation-manifest.js';
import { deriveProfileRelativePath } from '../src/modules/path-resolver.js';
import { buildReconciliationReport } from '../src/modules/reconciliation.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(testDirectory, 'fixtures', 'corpus-contract');

describe('desensitized corpus contract fixture', () => {
  it('contains both supported layout profiles, a sheet resource and intentional operational artefacts', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixtureRoot, 'fixture-manifest.json'), 'utf-8'),
    ) as {
      profiles: Array<{ name: string; root: string; markdownPaths: string[] }>;
      requiredAssets: string[];
      requiredOperationalArtifacts: string[];
    };

    expect(manifest.profiles.map((profile) => profile.name)).toEqual([
      'directory-readme',
      'mirror-title-file',
    ]);
    for (const profile of manifest.profiles) {
      for (const markdownPath of profile.markdownPaths) {
        expect(fs.existsSync(path.join(fixtureRoot, profile.root, markdownPath))).toBe(true);
      }
    }
    for (const relativePath of [
      ...manifest.requiredAssets,
      ...manifest.requiredOperationalArtifacts,
    ]) {
      expect(fs.existsSync(path.join(fixtureRoot, relativePath))).toBe(true);
    }
  });

  it('indexes only the seven desensitized Feishu documents and excludes operational artefacts', async () => {
    const upserts: Array<{ objToken: string; objType: string }> = [];
    const scanner = new IndexScanner({
      localMapStore: {
        upsertDocument(record: { objToken: string; objType: string }) {
          upserts.push(record);
        },
      },
      larkCliClient: {},
      config: { watchedRootUrls: [] },
    } as any);

    const result = await scanner.scanKnowledgeBase(fixtureRoot);

    expect(result).toMatchObject({ scanned: 9, indexed: 7, skipped: 2, failed: 0 });
    expect(upserts.map((record) => record.objToken).sort()).toEqual([
      'fixture-directory-child',
      'fixture-directory-root',
      'fixture-mirror-branch',
      'fixture-mirror-leaf',
      'fixture-mirror-root',
      'fixture-restricted',
      'fixture-sheet',
    ]);
    expect(upserts.find((record) => record.objToken === 'fixture-sheet')?.objType).toBe('sheet');

    const audit = createKnowledgeBaseAudit(fixtureRoot);
    expect(audit.skippedPaths).toEqual(expect.arrayContaining([
      'directory-readme/技术 - Dev/legacy.md.pre-migrate',
      'mirror-title-file/策划 - Designer/.staging/',
    ]));
  });

  it('resolves README titles from H1 and matches both layout profiles', () => {
    const devRoot = path.join(fixtureRoot, 'directory-readme', '技术 - Dev', 'README.md');
    const devContent = fs.readFileSync(devRoot, 'utf-8');
    expect(resolveDocumentTitle(devRoot, devContent)).toBe('技术根目录');

    const childReadme = path.join(
      fixtureRoot,
      'directory-readme',
      '技术 - Dev',
      '服务器架构',
      'README.md',
    );
    expect(resolveDocumentTitle(childReadme, fs.readFileSync(childReadme, 'utf-8'))).not.toBe(
      'README',
    );

    expect(
      deriveProfileRelativePath({
        localDir: '技术 - Dev',
        layoutProfile: 'directory-readme',
        title: '服务器架构',
        hasChild: false,
        isWatchedRootNode: false,
      }).relativePath,
    ).toBe('技术 - Dev/服务器架构/README.md');

    expect(
      deriveProfileRelativePath({
        localDir: '策划 - Designer',
        layoutProfile: 'mirror-title-file',
        title: '战斗设计',
        hasChild: true,
        isWatchedRootNode: false,
      }).relativePath,
    ).toBe('策划 - Designer/战斗设计/战斗设计.md');

    expect(
      deriveProfileRelativePath({
        localDir: '策划 - Designer',
        layoutProfile: 'mirror-title-file',
        title: '数值设计',
        hasChild: false,
        parentChainTitles: ['战斗设计'],
      }).relativePath,
    ).toBe('策划 - Designer/战斗设计/数值设计.md');
  });

  it('reconciliation dry-run classifies the fixture without ambiguous unique tokens', () => {
    const report = buildReconciliationReport({
      knowledgeBaseRoot: fixtureRoot,
      watchedRoots: [
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
      ],
    });

    expect(report.summary.markdownTotal).toBeGreaterThanOrEqual(8);
    expect(report.summary.byClass.pre_migrate ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.summary.byClass.indexed_unique ?? 0).toBeGreaterThanOrEqual(6);
    // Fixture tokens are unique; no false ambiguous from .pre-migrate.
    expect(report.summary.byClass.cloud_match_ambiguous ?? 0).toBe(0);
  });
});
