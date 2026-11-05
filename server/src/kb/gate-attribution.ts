import { validateKnowledgeGraph, type KnowledgeManifest, type ValidationIssue } from './knowledge-schema.js';

/** Returns true when the issue is current-scope or its attribution is uncertain.
 * Historical exceptions require an identical structural defect in CURRENT and
 * complete ownership of all its endpoints outside the draft scope. */
export function gateAttribution(input: {
  current: KnowledgeManifest;
  previous: KnowledgeManifest | null;
  draftPaths: ReadonlySet<string> | undefined;
  sourcePaths: ReadonlyMap<string, ReadonlySet<string>>;
  changedSources?: ReadonlySet<string>;
}): (issue: ValidationIssue) => boolean {
  const { current, previous, draftPaths, sourcePaths } = input;
  if (!previous || !draftPaths) return () => true;
  const key = (issue: ValidationIssue) => issue.code === 'kb_restatement_stale' && issue.objectId && issue.edgeId
    ? JSON.stringify([issue.code, issue.objectId, issue.edgeId])
    : JSON.stringify([issue.code, issue.rule, issue.field, issue.objectId, issue.edgeId, issue.message]);
  const oldIssues = new Set(validateKnowledgeGraph(previous).map(key));
  const currentObjects = new Map(current.objects.map(object => [object.objectId, object]));
  const oldObjects = new Map(previous.objects.map(object => [object.objectId, object]));
  const carried = (id: string): boolean => {
    const now = currentObjects.get(id)?.canonical?.path;
    const before = oldObjects.get(id)?.canonical?.path;
    if (!now || !before || now !== before || draftPaths.has(now) || !input.changedSources) return false;
    let located = false;
    for (const [source, paths] of sourcePaths) {
      if (!paths.has(now)) continue;
      located = true;
      if (input.changedSources.has(source)) return false;
    }
    return located;
  };
  return issue => {
    if (!oldIssues.has(key(issue))) return true;
    if (issue.rule === 'coverage_target_missing' && issue.edgeId) {
      // A missing target has no current canonical path. Without an independently
      // verifiable historical owner it remains blocking, never inferred from text.
      const item = current.coverage.find(value => value.itemId === issue.edgeId);
      const old = previous.coverage.find(value => value.itemId === issue.edgeId);
      if (!item || !old || JSON.stringify(item) !== JSON.stringify(old)) return true;
      const paths = sourcePaths.get(item.sourceRef.sourceId);
      if (!input.changedSources || input.changedSources.has(item.sourceRef.sourceId)
        || !paths?.size || [...paths].some(path => draftPaths.has(path))) return true;
      return !item.targetObjectIds.length || item.targetObjectIds.some(id => !carried(id));
    }
    if (issue.code === 'kb_restatement_stale' && issue.objectId) {
      // Compiler expansion failure leaves an unresolved include in output.
      // Until immutable CURRENT bytes can be carried verbatim, this is a
      // structural release failure even when its graph identity is historical.
      if (issue.field === 'targetObjectId') return true;
      const presentation = current.presentations.find(p => p.presentationId === issue.edgeId && p.ownerObjectId === issue.objectId);
      const old = previous.presentations.find(p => p.presentationId === issue.edgeId);
      if (!presentation?.targetObjectId || !old || !carried(issue.objectId) || !carried(presentation.targetObjectId)) return true;
      // Compiled exact bodyRange is generated from expanded bytes and can
      // differ from the authored include range; compare the bound identity.
      return presentation.kind !== old.kind || presentation.ownerObjectId !== old.ownerObjectId
        || presentation.targetObjectId !== old.targetObjectId || presentation.targetRevision !== old.targetRevision
        || presentation.fragmentKey !== old.fragmentKey || presentation.summaryBasis !== old.summaryBasis
        || currentObjects.get(presentation.targetObjectId)?.revision !== oldObjects.get(presentation.targetObjectId)?.revision;
    }
    return true;
  };
}
