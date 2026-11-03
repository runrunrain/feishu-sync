import type { KnowledgeDraftFile } from '../agent/agent-tool-service.js';
import type { KbManifest } from '../types/agent-knowledge.js';
import type { KnowledgeDeclarationSet } from './knowledge-compiler.js';
import type { KnowledgeManifest } from './knowledge-schema.js';

/** A progressive release reads pending edits only for the paths being promoted.
 * Every other path is taken from the immutable current release, so an
 * unrelated draft rewrite cannot hold up publication or leak unreviewed data. */
export function selectProgressiveKnowledgeDraft(input: {
  buildId: string;
  liveDraft: KnowledgeDraftFile;
  baselineKnowledge: KnowledgeManifest | null;
  baselineDocs: KbManifest['docs'];
  allPaths: ReadonlySet<string>;
  newPaths: ReadonlySet<string>;
  coverage: KnowledgeDraftFile['coverage'];
}): KnowledgeDraftFile {
  const { liveDraft, baselineKnowledge, allPaths, newPaths } = input;
  const baselinePaths = new Set([...allPaths].filter((docPath) => !newPaths.has(docPath)));
  const liveObjects = liveDraft.objects.filter((object) => !object.tombstone && object.canonical && newPaths.has(object.canonical.path));
  const baselineObjects = baselineKnowledge
    ? baselineKnowledge.objects.filter((object) => !object.tombstone && object.canonical && baselinePaths.has(object.canonical.path))
    : liveDraft.objects.filter((object) => !object.tombstone && object.canonical && baselinePaths.has(object.canonical.path));
  const liveIds = new Set(liveObjects.map((object) => object.objectId));
  const baselineIds = new Set(baselineObjects.map((object) => object.objectId));
  for (const id of liveIds) {
    if (baselineIds.has(id)) throw new Error(`阶段发布对象跨未审文档迁移：${id}`);
  }
  const objects = [...baselineObjects, ...liveObjects];
  const pick = <T extends { ownerObjectId?: string; fromObjectId?: string; objectId?: string }>(
    live: T[], baseline: T[], key: 'ownerObjectId' | 'fromObjectId' | 'objectId',
  ): T[] => [
    ...baseline.filter((item) => baselineIds.has(item[key] ?? '')),
    ...live.filter((item) => liveIds.has(item[key] ?? '')),
  ];
  const presentations = pick(liveDraft.presentations,
    baselineKnowledge?.presentations.filter((item) => item.kind !== 'canonical') ?? liveDraft.presentations,
    'ownerObjectId');
  const relations = pick(liveDraft.relations, baselineKnowledge?.relations ?? liveDraft.relations, 'fromObjectId');
  const evidence = pick(liveDraft.evidence, baselineKnowledge?.evidence ?? liveDraft.evidence, 'objectId');
  const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
  const docs: KnowledgeDraftFile['docs'] = {};
  const baseByPath = new Map(input.baselineDocs.map((doc) => [doc.path, doc] as const));
  for (const docPath of allPaths) {
    if (newPaths.has(docPath)) {
      const doc = liveDraft.docs[docPath];
      if (!doc) throw new Error(`阶段发布缺少新草稿登记：${docPath}`);
      docs[docPath] = doc;
    } else if (baselineKnowledge) {
      const doc = baseByPath.get(docPath);
      if (!doc) throw new Error(`阶段发布缺少基准文档：${docPath}`);
      docs[docPath] = { docId: doc.docId, revision: 0, basis: 'published', bodyLineOffset: 0, carriedHash: doc.contentHash };
    } else if (liveDraft.docs[docPath]) {
      docs[docPath] = liveDraft.docs[docPath];
    }
  }
  return {
    ...liveDraft,
    buildId: input.buildId,
    docs,
    clientKeys: Object.fromEntries(Object.entries(liveDraft.clientKeys).filter(([, id]) => liveIds.has(id))),
    evidenceKeys: Object.fromEntries(Object.entries(liveDraft.evidenceKeys).filter(([, id]) => evidenceIds.has(id))),
    objects,
    presentations,
    relations,
    evidence,
    coverage: input.coverage,
    calls: {},
  };
}

/** At final publication, a document already promoted by this build is carried
 * from that reviewed release unless its draft body or knowledge declarations
 * have changed since promotion. The new-evidence gate applies only to the
 * remaining drafts. */
export function finalDraftEvidenceScopePaths(input: {
  buildId: string;
  liveDraft: Pick<KnowledgeDeclarationSet, 'docs' | 'objects'>;
  candidateDocs: ReadonlyArray<{ path: string; contentHash: string }>;
  baselineManifest: KbManifest | null;
  baselineKnowledge: KnowledgeManifest | null;
}): string[] | undefined {
  const { baselineManifest, baselineKnowledge, liveDraft } = input;
  if (baselineManifest?.buildId !== input.buildId || baselineManifest.publicationStage !== 'progressive'
    || !baselineKnowledge) return undefined;
  const promotedHashes = baselineManifest.promotionHashes ?? {};
  const subjects = (objects: KnowledgeDeclarationSet['objects'] | KnowledgeManifest['objects'], docPath: string) =>
    objects.filter((object) => !object.tombstone && object.canonical?.path === docPath)
      .map((object) => `${object.objectId}:${object.reviewSubjectHash}`).sort().join('|');
  return input.candidateDocs.filter((doc) => {
    const entry = liveDraft.docs[doc.path];
    if (entry?.basis === 'published') return false;
    return promotedHashes[doc.path] !== doc.contentHash
      || subjects(liveDraft.objects, doc.path) !== subjects(baselineKnowledge.objects, doc.path);
  }).map((doc) => doc.path);
}
