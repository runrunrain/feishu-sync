import type { KnowledgeDraftFile, OrganizationPlanFile } from '../agent/agent-tool-service.js';
import type { KnowledgeManifest, KnowledgeObject, ObjectMigration } from './knowledge-schema.js';

type EvidenceOwner = Pick<KnowledgeManifest, 'evidence'> | Pick<KnowledgeDraftFile, 'evidence'>;

function evidenceSources(owner: EvidenceOwner, objectId: string): Set<string> {
  return new Set(owner.evidence.filter((item) => item.objectId === objectId).map((item) => item.sourceRef.sourceId));
}

function sharedSources(prior: EvidenceOwner, oldId: string, draft: EvidenceOwner, newId: string): string[] {
  const before = evidenceSources(prior, oldId);
  return [...evidenceSources(draft, newId)].filter((source) => before.has(source)).sort();
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
  docBody?: (path: string) => string;
}): Array<{
  objectId: string; title: string; priorPath: string | null;
  candidates: Array<{ objectId: string; title: string; path: string; sharedSources: string[] }>;
}> {
  const { previous, draft, plan } = input;
  if (!previous || !draft) return [];
  const currentIds = new Set(draft.objects.filter((object) => !object.tombstone).map((object) => object.objectId));
  const mappedIds = new Set(plan?.migrations.map((migration) => migration.objectId) ?? []);
  const candidates = draft.objects.filter((object): object is KnowledgeObject & { canonical: NonNullable<KnowledgeObject['canonical']> } =>
    !object.tombstone && !!object.canonical);
  return previous.objects.filter((old) => !old.tombstone && !currentIds.has(old.objectId) && !mappedIds.has(old.objectId))
    .map((old) => {
      const oldTitle = normalizedTitle(old.title);
      const ranked = candidates.map((candidate) => {
        const common = sharedSources(previous, old.objectId, draft, candidate.objectId);
        const title = normalizedTitle(candidate.title);
        const fullBody = input.docBody?.(candidate.canonical.path) ?? '';
        const range = candidate.canonical.bodyRange;
        const offset = draft.docs[candidate.canonical.path]?.bodyLineOffset ?? 0;
        const body = range ? fullBody.split('\n').slice(range.startLine + offset - 1, range.endLine + offset).join('\n') : fullBody;
        const titleMatch = oldTitle === title ? 100 : oldTitle.includes(title) || title.includes(oldTitle) ? 50 : 0;
        const bodyMatch = bodyMentionsTitle(old.title, body) ? 25 : 0;
        const score = titleMatch + bodyMatch + (common.length > 0 ? 20 : 0)
          + (old.familyKey === candidate.familyKey ? 10 : 0);
        return { objectId: candidate.objectId, title: candidate.title, path: candidate.canonical.path,
          sharedSources: common, score };
      }).filter((candidate) => candidate.sharedSources.length > 0 && candidate.score > 20)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.objectId.localeCompare(b.objectId))
        .slice(0, 5).map(({ score: _score, ...candidate }) => candidate);
      return { objectId: old.objectId, title: old.title, priorPath: old.canonical?.path ?? null, candidates: ranked };
    });
}

/** Validate a Leader's semantic decision against immutable old and current evidence. */
export function validateObjectMigrationRegistration(input: {
  previous: KnowledgeManifest;
  draft: KnowledgeDraftFile;
  existing: readonly ObjectMigration[];
  proposed: readonly ObjectMigration[];
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
    if (kind === 'merge' ? successorObjectIds.length !== 1 : kind === 'split' ? successorObjectIds.length < 2 : true) {
      errors.push(`${objectId}: merge 必须一个后继，split 至少两个后继`);
    }
    if (new Set(successorObjectIds).size !== successorObjectIds.length) errors.push(`${objectId}: 后继重复`);
    for (const successor of successorObjectIds) {
      if (successor === objectId || !currentById.has(successor)) {
        errors.push(`${objectId}: 后继 ${successor} 不在当前草稿`);
      } else if (sharedSources(input.previous, objectId, input.draft, successor).length === 0) {
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
