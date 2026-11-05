import crypto from 'node:crypto';
import type { ImageDescription } from '../agent/vision/vision-describer.js';
import type { KbManifest, KbManifestDoc, RawSourceSnapshotEntry } from '../types/agent-knowledge.js';

export interface VisionDescriptionVersion { hash: string; describedCount: number; newlyDescribedCount: number }

/** Cache state (newly described vs reused) is not part of the evidence version. */
export function visionDescriptionVersion(descriptions: ReadonlyMap<string, ImageDescription> | undefined): VisionDescriptionVersion | null {
  if (!descriptions?.size) return null;
  const rows = [...descriptions].map(([src, description]) => [
    src,
    description.imageHash,
    description.state === 'unavailable' ? null : description.text ?? null,
  ] as const).sort((a, b) => a[0].localeCompare(b[0]));
  return {
    hash: `sha256:${crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`,
    describedCount: rows.filter((row) => row[2] !== null).length,
    newlyDescribedCount: [...descriptions.values()].filter((description) => description.state === 'described').length,
  };
}

/** A lost cache or unavailable vision service must not force a quality downgrade. */
export function visionDescriptionImproved(previous: RawSourceSnapshotEntry | undefined,
  current: VisionDescriptionVersion | null): boolean {
  return !!previous && !!current && current.describedCount > 0
    // A legacy manifest without a stamp proves no change. Reusing an existing
    // cache must not turn an ordinary incremental build into a library rewrite.
    && (!!previous.visionDescriptionHash || current.newlyDescribedCount > 0)
    && current.describedCount >= (previous.visionDescribedCount ?? 0)
    && previous.visionDescriptionHash !== current.hash;
}

/** Only stamp new evidence when every formal document using that source was rewritten.
 * Progressive releases retain the previous stamp until the last dependent doc lands. */
export function versionedPublishedSources(input: {
  entries: RawSourceSnapshotEntry[];
  baseManifest: KbManifest | null;
  docs: KbManifestDoc[];
  committedPaths: ReadonlySet<string>;
  descriptions?: Map<string, Map<string, ImageDescription>>;
}): RawSourceSnapshotEntry[] {
  const previous = new Map(input.baseManifest?.sourceSnapshot.map((entry) => [entry.objToken, entry]) ?? []);
  const basePaths = new Map<string, string[]>();
  for (const doc of input.baseManifest?.docs ?? []) {
    for (const token of doc.sources) basePaths.set(token, [...(basePaths.get(token) ?? []), doc.path]);
  }
  const publishedTokens = new Set(input.docs.flatMap((doc) => doc.sources));
  return input.entries.map((entry) => {
    const prior = previous.get(entry.objToken);
    const version = visionDescriptionVersion(input.descriptions?.get(entry.objToken));
    const allRewritten = (basePaths.get(entry.objToken) ?? []).every((docPath) => input.committedPaths.has(docPath));
    if (version && allRewritten && publishedTokens.has(entry.objToken)) {
      return { ...entry, visionDescriptionHash: version.hash, visionDescribedCount: version.describedCount };
    }
    if (prior?.visionDescriptionHash && prior.contentHash === entry.contentHash
      && (prior.mediaHash ?? '') === (entry.mediaHash ?? '')
      && (prior.whiteboardTextHash ?? '') === (entry.whiteboardTextHash ?? '')) {
      return { ...entry, visionDescriptionHash: prior.visionDescriptionHash,
        visionDescribedCount: prior.visionDescribedCount ?? 0 };
    }
    const { visionDescriptionHash: _hash, visionDescribedCount: _count, ...withoutVersion } = entry;
    return withoutVersion;
  });
}
