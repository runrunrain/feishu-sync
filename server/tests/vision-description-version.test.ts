import { describe, expect, it } from 'vitest';
import { versionedPublishedSources, visionDescriptionImproved, visionDescriptionVersion } from '../src/kb/vision-description-version.js';
import type { ImageDescription } from '../src/agent/vision/vision-describer.js';
import type { KbManifest, KbManifestDoc, RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

const source: RawSourceSnapshotEntry = { objToken: 'source', objType: 'docx', title: '图文来源',
  relPath: '图文来源.md', contentHash: 'sha256:source', mediaHash: 'sha256:image', objEditTime: null, imageCount: 2 };
const doc = (path: string) => ({ path, sources: ['source'] }) as KbManifestDoc;
const descriptions = new Map<string, ImageDescription>([
  ['a.png', { src: 'a.png', imageHash: 'hash-a', state: 'cached', text: '图 A 的规则' }],
  ['b.png', { src: 'b.png', imageHash: 'hash-b', state: 'unavailable', reason: 'too_large' }],
]);

describe('published vision evidence version', () => {
  it('ignores cache-hit state but detects a newly available description', () => {
    const version = visionDescriptionVersion(descriptions)!;
    expect(version.describedCount).toBe(1);
    expect(version.hash).toBe(visionDescriptionVersion(new Map([
      ['b.png', descriptions.get('b.png')!],
      ['a.png', { ...descriptions.get('a.png')!, state: 'described' }],
    ]))!.hash);
    expect(visionDescriptionImproved(source, version)).toBe(false); // missing legacy stamp is not a cache change
    const fresh = visionDescriptionVersion(new Map([
      ['a.png', { ...descriptions.get('a.png')!, state: 'described' }],
      ['b.png', descriptions.get('b.png')!],
    ]))!;
    expect(visionDescriptionImproved(source, fresh)).toBe(true);
    expect(visionDescriptionImproved({ ...source, visionDescriptionHash: version.hash, visionDescribedCount: 1 }, version)).toBe(false);
    expect(visionDescriptionImproved({ ...source, visionDescriptionHash: 'old', visionDescribedCount: 2 }, version)).toBe(false);
  });

  it('still detects changed cached evidence when a published version is known', () => {
    const old = { ...source, visionDescriptionHash: 'sha256:old', visionDescribedCount: 1 };
    expect(visionDescriptionImproved(old, visionDescriptionVersion(descriptions))).toBe(true);
  });

  it('keeps the old stamp through partial stage publication, then advances after every dependent doc lands', () => {
    const old = { ...source, visionDescriptionHash: 'sha256:old', visionDescribedCount: 1 };
    const base = { sourceSnapshot: [old], docs: [doc('first.md'), doc('second.md')] } as KbManifest;
    const args = { entries: [source], baseManifest: base, docs: base.docs,
      descriptions: new Map([['source', descriptions]]) };
    const partial = versionedPublishedSources({ ...args, committedPaths: new Set(['first.md']) });
    expect(partial[0]?.visionDescriptionHash).toBe(old.visionDescriptionHash);
    const complete = versionedPublishedSources({ ...args, committedPaths: new Set(['first.md', 'second.md']) });
    expect(complete[0]?.visionDescriptionHash).toBe(visionDescriptionVersion(descriptions)?.hash);
    expect(complete[0]?.visionDescribedCount).toBe(1);
  });
});
