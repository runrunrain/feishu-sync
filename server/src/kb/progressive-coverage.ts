import type { CoverageItem } from './knowledge-schema.js';

/** Select coverage for the exact documents in a progressive release. One
 * source may feed many documents; selecting by source alone leaks coverage
 * pointing at unpublished objects and silently prevents per-document stages. */
export function selectProgressiveCoverage(
  published: readonly CoverageItem[], pending: readonly CoverageItem[], input: {
    promotedSources: ReadonlySet<string>;
    includedObjectIds: ReadonlySet<string>;
    promotedObjectIds: ReadonlySet<string>;
    retainedSources: ReadonlySet<string>;
  },
): CoverageItem[] {
  const { promotedSources, includedObjectIds, promotedObjectIds, retainedSources } = input;
  const included = (item: CoverageItem): boolean => item.targetObjectIds.every((id) => includedObjectIds.has(id));
  const fresh = pending.filter((item) => promotedSources.has(item.sourceRef.sourceId)
    && item.targetObjectIds.length > 0 && included(item)
    && item.targetObjectIds.some((id) => promotedObjectIds.has(id)));
  const freshIds = new Set(fresh.map((item) => item.itemId));
  return [
    ...published.filter((item) => !freshIds.has(item.itemId) && included(item)
      && (item.targetObjectIds.length > 0
        ? item.targetObjectIds.every((id) => !promotedObjectIds.has(id))
        : retainedSources.has(item.sourceRef.sourceId))),
    ...fresh,
  ];
}
