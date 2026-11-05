import type { KnowledgeDraftFile, OrganizationPlanFile } from '../agent/agent-tool-service.js';
import type { KnowledgeManifest, KnowledgeObject, ObjectMigration } from './knowledge-schema.js';

type EvidenceOwner = Pick<KnowledgeManifest, 'evidence'> | Pick<KnowledgeDraftFile, 'evidence'>;

function evidenceSources(owner: EvidenceOwner, objectId: string): Set<string> {
  return new Set(owner.evidence.filter((item) => item.objectId === objectId).map((item) => item.sourceRef.sourceId));
}

function priorSources(prior: KnowledgeManifest, objectId: string, docSources?: ReadonlyMap<string, string[]>): Set<string> {
  const evidence = evidenceSources(prior, objectId);
  if (evidence.size > 0) return evidence;
  // Legacy formal objects may predate claim-level evidence registration. Their
  // immutable document's declared sources remain provenance, not read receipts.
  const docPath = prior.objects.find((object) => object.objectId === objectId)?.canonical?.path;
  return new Set(docPath ? docSources?.get(docPath) ?? [] : []);
}

function sharedSources(prior: KnowledgeManifest, oldId: string, draft: EvidenceOwner, newId: string,
  docSources?: ReadonlyMap<string, string[]>, currentDocSources?: ReadonlyMap<string, string[]>): string[] {
  const before = priorSources(prior, oldId, docSources);
  const after = evidenceSources(draft, newId);
  const direct = [...after].filter((source) => before.has(source)).sort();
  if (direct.length || evidenceSources(prior, oldId).size > 0 || after.size === 0 || !('objects' in draft)) return direct;
  // Legacy provenance was only recorded per document. Do not pretend that its
  // header was an exact old claim source. For a same-document semantic split,
  // its continuing document sources may link the old record to a newly precise
  // successor source. Specific old evidence and source-free successors never
  // use this compatibility path.
  const oldPath = prior.objects.find(object => object.objectId === oldId)?.canonical?.path;
  const newPath = (draft as KnowledgeDraftFile).objects.find(object => object.objectId === newId)?.canonical?.path;
  if (!oldPath || oldPath !== newPath) return direct;
  const currentSources = new Set(currentDocSources?.get(newPath) ?? []);
  if ([...after].some(source => !currentSources.has(source))) return direct;
  return [...currentSources].filter(source => before.has(source)).sort();
}

function normalizedTitle(title: string): string {
  return title.replace(/[\s\p{P}\p{S}]+/gu, '').replace(/机制$|行为$|规则$/u, '');
}

function bodyMentionsTitle(title: string, body: string): boolean {
  if (body.includes(title)) return true;
  const normalized = normalizedTitle(title);
  if (normalized.length < 3) return false;
  for (let width = normalized.length; width >= 3; width -= 1) {
    for (let start = 0; start + width <= normalized.length; start += 1) {
      if (body.includes(normalized.slice(start, start + width))) return true;
    }
  }
  return false;
}

/** Compact, deterministic publication feedback; suggestions never become migrations automatically. */
export function objectMigrationGaps(input: {
  previous: KnowledgeManifest | null;
  draft: KnowledgeDraftFile | null;
  plan: Pick<OrganizationPlanFile, 'migrations'> | null;
  previousDocSources?: ReadonlyMap<string, string[]>;
  currentDocSources?: ReadonlyMap<string, string[]>;
  docBody?: (path: string) => string;
  previousDocBody?: (path: string) => string;
}): Array<{
  objectId: string; title: string; priorPath: string | null;
  priorDocumentSources?: string[];
  priorClaimCount: number;
  priorClaims: Array<{ claimKey: string; text?: string }>;
  candidates: Array<{ objectId: string; title: string; path: string; sharedSources: string[] }>;
}> {
  const { previous, draft, plan } = input;
  if (!previous || !draft) return [];
  const currentIds = new Set(draft.objects.filter((object) => !object.tombstone).map((object) => object.objectId));
  const mappedIds = new Set(plan?.migrations.map((migration) => migration.objectId) ?? []);
  const missing = previous.objects.filter((old) => !old.tombstone && !currentIds.has(old.objectId) && !mappedIds.has(old.objectId));
  if (missing.length === 0) return [];
  const candidates = draft.objects.filter((object): object is KnowledgeObject & { canonical: NonNullable<KnowledgeObject['canonical']> } =>
    !object.tombstone && !!object.canonical);
  const candidateFacts = candidates.map((candidate) => {
    const fullBody = input.docBody?.(candidate.canonical.path) ?? '';
    const range = candidate.canonical.bodyRange;
    const offset = draft.docs[candidate.canonical.path]?.bodyLineOffset ?? 0;
    return { candidate, title: normalizedTitle(candidate.title),
      body: range ? fullBody.split('\n').slice(range.startLine + offset - 1, range.endLine + offset).join('\n') : fullBody,
    };
  });
  return missing.map((old) => {
      const oldTitle = normalizedTitle(old.title);
      const oldEvidenceSources = evidenceSources(previous, old.objectId);
      const oldSources = priorSources(previous, old.objectId, input.previousDocSources);
      const ranked = candidateFacts.map(({ candidate, title, body }) => {
        const common = sharedSources(previous, old.objectId, draft, candidate.objectId,
          input.previousDocSources, input.currentDocSources);
        const titleMatch = oldTitle === title ? 100 : oldTitle.includes(title) || title.includes(oldTitle) ? 50 : 0;
        const bodyMatch = bodyMentionsTitle(old.title, body) ? 25 : 0;
        const score = titleMatch + bodyMatch + (common.length > 0 ? 20 : 0)
          + (old.familyKey === candidate.familyKey ? 10 : 0);
        return { objectId: candidate.objectId, title: candidate.title, path: candidate.canonical.path,
          sharedSources: common, score };
      }).filter((candidate) => candidate.sharedSources.length > 0 && candidate.score > 20)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.objectId.localeCompare(b.objectId))
        .slice(0, 5).map(({ score: _score, ...candidate }) => candidate);
      return { objectId: old.objectId, title: old.title, priorPath: old.canonical?.path ?? null,
        priorClaimCount: old.claims?.length ?? 0,
        priorClaims: (old.claims ?? []).slice(0, 12).map(claim => {
          const body = old.canonical?.path && input.previousDocBody?.(old.canonical.path);
          const range = claim.bodyRange;
          const text = body && range ? body.split('\n').slice(range.startLine - 1, range.endLine).join('\n').slice(0, 800) : undefined;
          return { claimKey: claim.claimKey, ...(text ? { text } : {}) };
        }),
        ...(oldEvidenceSources.size === 0 && oldSources.size > 0 ? { priorDocumentSources: [...oldSources].sort() } : {}),
        candidates: ranked };
    });
}

/** Validate a Leader's semantic decision against immutable old and current evidence. */
export function validateObjectMigrationRegistration(input: {
  previous: KnowledgeManifest;
  draft: KnowledgeDraftFile;
  existing: readonly ObjectMigration[];
  proposed: readonly ObjectMigration[];
  previousDocSources?: ReadonlyMap<string, string[]>;
  currentDocSources?: ReadonlyMap<string, string[]>;
}): string[] {
  const errors: string[] = [];
  const previousById = new Map(input.previous.objects.map((object) => [object.objectId, object] as const));
  const currentById = new Map(input.draft.objects.filter((object) => !object.tombstone)
    .map((object) => [object.objectId, object] as const));
  const existing = new Map(input.existing.map((migration) => [migration.objectId, migration] as const));
  const seen = new Set<string>();
  for (const migration of input.proposed) {
    const { objectId, kind, successorObjectIds, reason } = migration;
    if (seen.has(objectId)) { errors.push(`${objectId}: 本批重复`); continue; }
    seen.add(objectId);
    if (!previousById.has(objectId) || currentById.has(objectId)) errors.push(`${objectId}: 必须是上一正式版存在、当前草稿已移出的对象`);
    if (existing.has(objectId)) errors.push(`${objectId}: 已登记迁移，禁止覆盖旧去向`);
    if (!reason.trim() || reason.trim().length < 4) errors.push(`${objectId}: 需要具体迁移原因`);
    if (kind === 'merge' ? successorObjectIds.length !== 1 : kind === 'split' ? successorObjectIds.length < 2
      : kind === 'remove' ? successorObjectIds.length !== 0 : true) {
      errors.push(`${objectId}: merge 必须一个后继，split 至少两个后继，remove 后继必须为空`);
    }
    if (new Set(successorObjectIds).size !== successorObjectIds.length) errors.push(`${objectId}: 后继重复`);
    for (const successor of successorObjectIds) {
      if (successor === objectId || !currentById.has(successor)) {
        errors.push(`${objectId}: 后继 ${successor} 不在当前草稿`);
      } else if (sharedSources(input.previous, objectId, input.draft, successor, input.previousDocSources, input.currentDocSources).length === 0) {
        errors.push(`${objectId}: 后继 ${successor} 与旧对象缺少共同来源证据`);
      }
    }
    if (input.draft.coverage.some((item) => item.targetObjectIds.includes(objectId))
      || input.draft.relations.some((item) => item.fromObjectId === objectId || item.toObjectId === objectId)
      || input.draft.presentations.some((item) => item.ownerObjectId === objectId || item.targetObjectId === objectId)
      || input.draft.evidence.some((item) => item.objectId === objectId)) {
      errors.push(`${objectId}: 草稿仍有引用，先由写作任务处理引用与覆盖归属`);
    }
  }
  return errors;
}
