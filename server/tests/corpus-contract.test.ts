import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexScanner } from '../src/modules/index-scanner.js';
import { createKnowledgeBaseAudit } from '../src/modules/operation-manifest.js';

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
});
