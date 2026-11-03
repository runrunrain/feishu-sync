import type { CoverageItem } from './knowledge-schema.js';

/** Carry declarations already committed to CURRENT and replace only the
 * sources whose reviewed documents enter this stage. */
export function selectProgressiveCoverage(
  published: readonly CoverageItem[], pending: readonly CoverageItem[], promotedSources: ReadonlySet<string>,
): CoverageItem[] {
  return [
    ...published.filter((item) => !promotedSources.has(item.sourceRef.sourceId)),
    ...pending.filter((item) => promotedSources.has(item.sourceRef.sourceId)),
  ];
}
