/**
 * v2 审查权威绑定（重构 v2 §4.3/§8；审核修复 F07/F08）。
 *
 * F07：v2（pi-amagi）构建的发布候选验收记录（acceptance.validReportIds）
 * 由 BuildActorStore 的权威审查回执（ReviewReceipt）驱动，不再依赖 legacy
 * 的 reviews/all.json 文件约定；多审查者与版本绑定保留。
 *
 * F08：独立当前审查与对象级机器审查凭据共享同一权威源——回执的
 * dependencyHashes 精确绑定「正文（doc:*）+ 对象/证据声明 + 来源快照 +
 * 冻结 workflow 规则」四类依赖。发布（auto/manual）在候选组装时按当前
 * 值重新核验：任一依赖漂移（含 metadata-only 的对象声明变化）→ 回执不
 * 再覆盖当前候选 → review_missing 阻断。对象回写侧（kb_submit_review
 * pass 分支）在声明锁内以同一组值核验后才 mark passed（不无条件放行）。
 *
 * 声明语义哈希剔除对象上的审查凭据字段（reviewStatus/reviewActorKind/
 * reviewerId/reviewedAt）与 calls 幂等账本：回写凭据本身不得改变声明
 * 哈希（自失效），幂等重放也不得使既有有效审查失效。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BuildActorStore, ReviewReceipt } from './build-actors.js';
import type { KnowledgeDraftFile } from '../agent/agent-tool-service.js';
import type { RawSourceSnapshot } from './raw-source-snapshot.js';
import { computeSnapshotHash } from './build-orchestration.js';
import type { ReviewReport } from './orchestration-contracts.js';

/** dependencyHashes 保留键（doc:<path> 前缀键之外的三类聚合依赖）。 */
export const REVIEW_DEP_DECLARATION = 'knowledge-declaration';
export const REVIEW_DEP_SOURCE_SNAPSHOT = 'source-snapshot';
export const REVIEW_DEP_WORKFLOW_RULES = 'workflow-rules';

/** 当前依赖值（候选组装/对象回写核验用；与回执 dependencyHashes 比对）。 */
export interface ReviewDependencyValues {
  declarationHash: string;
  sourceSnapshotHash: string;
  workflowRulesHash: string | null;
}

/** 稳定序列化（键排序；与 orchestration-contracts 同语义，本模块自带避免
 * 引入对私有函数的依赖）。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 剔除对象审查凭据字段（避免回写凭据造成声明哈希自失效）。 */
function stripObjectReviewCredential(object: KnowledgeDraftFile['objects'][number]):
  Record<string, unknown> {
  const clone: Record<string, unknown> = { ...object };
  delete clone.reviewStatus;
  delete clone.reviewActorKind;
  delete clone.reviewerId;
  delete clone.reviewedAt;
  return clone;
}

/** 声明语义哈希：docs/clientKeys/evidenceKeys/objects/presentations/
 * relations/evidence/coverage 全量参与（审查凭据字段与 calls 账本剔除）。 */
export function knowledgeDeclarationHash(draft: KnowledgeDraftFile): string {
  const semantic = {
    schemaVersion: draft.schemaVersion,
    docs: draft.docs,
    clientKeys: draft.clientKeys,
    evidenceKeys: draft.evidenceKeys,
    objects: draft.objects.map(stripObjectReviewCredential),
    presentations: draft.presentations,
    relations: draft.relations,
    evidence: draft.evidence,
    coverage: draft.coverage,
  };
  return crypto.createHash('sha256').update(stableStringify(semantic), 'utf8').digest('hex');
}

/** Bind a unit review to the declarations that can affect its documents. A
 * concurrent writer changing another document must not invalidate this unit. */
export function scopedKnowledgeDeclarationHash(draft: KnowledgeDraftFile, paths: readonly string[], sourceIds: readonly string[]): string {
  const scope = new Set(paths);
  const sources = new Set(sourceIds);
  const objects = draft.objects.filter((object) => object.canonical && scope.has(object.canonical.path));
  const ids = new Set(objects.map((object) => object.objectId));
  const relations = draft.relations.filter((relation) => ids.has(relation.fromObjectId) || ids.has(relation.toObjectId));
  const evidence = draft.evidence.filter((item) => ids.has(item.objectId));
  const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
  const semantic = {
    schemaVersion: draft.schemaVersion,
    docs: Object.fromEntries(Object.entries(draft.docs).filter(([docPath]) => scope.has(docPath))),
    clientKeys: Object.fromEntries(Object.entries(draft.clientKeys).filter(([, id]) => ids.has(id))),
    evidenceKeys: Object.fromEntries(Object.entries(draft.evidenceKeys).filter(([, id]) => evidenceIds.has(id))),
    objects: objects.map(stripObjectReviewCredential),
    presentations: draft.presentations.filter((item) => ids.has(item.ownerObjectId)
      || (item.targetObjectId !== undefined && ids.has(item.targetObjectId))),
    relations,
    evidence,
    coverage: draft.coverage.filter((item) => sources.has(item.sourceRef.sourceId)
      && item.targetObjectIds.every((id) => ids.has(id))),
  };
  return crypto.createHash('sha256').update(stableStringify(semantic), 'utf8').digest('hex');
}

export function scopedReviewDeclarationHash(stagingRoot: string, paths: readonly string[], sourceIds: readonly string[]): string | null {
  try {
    const file = path.join(stagingRoot, 'knowledge-draft.json');
    if (!fs.existsSync(file)) return emptyKnowledgeDeclarationHash();
    const draft = JSON.parse(fs.readFileSync(file, 'utf8')) as KnowledgeDraftFile;
    if (draft.schemaVersion !== 1) return null;
    return scopedKnowledgeDeclarationHash(draft, paths, sourceIds);
  } catch { return null; }
}

/** 无声明文件时的空声明哈希（形状与 loadKnowledgeDraft 新建空 draft 一致）。 */
export function emptyKnowledgeDeclarationHash(): string {
  return knowledgeDeclarationHash({
    schemaVersion: 1,
    buildId: '',
    docs: {},
    clientKeys: {},
    evidenceKeys: {},
    objects: [],
    presentations: [],
    relations: [],
    evidence: [],
    coverage: [],
    calls: {},
  });
}

/** 从 staging 当前状态解析依赖值（发布侧权威：直读文件，不走内存镜像）。 */
export function resolveCurrentReviewDependencies(input: {
  stagingRoot: string;
  snapshot: RawSourceSnapshot;
  workflowRulesHash: string | null;
}): ReviewDependencyValues {
  const draftFile = path.join(input.stagingRoot, 'knowledge-draft.json');
  let declarationHash: string;
  try {
    const parsed = JSON.parse(fs.readFileSync(draftFile, 'utf8')) as KnowledgeDraftFile;
    if (!parsed || parsed.schemaVersion !== 1) throw new Error('schema');
    declarationHash = knowledgeDeclarationHash(parsed);
  } catch {
    declarationHash = emptyKnowledgeDeclarationHash();
  }
  return {
    declarationHash,
    sourceSnapshotHash: computeSnapshotHash(input.snapshot.entries),
    workflowRulesHash: input.workflowRulesHash,
  };
}

/** 回执依赖与当前值匹配（doc:* 逐路径不在本函数——见 collect 中的正文核验）。
 *
 * F08 补强：v2 权威规则哈希缺失（null）时 fail-closed——回执必须携带
 * workflow-rules 键且与当前冻结值精确匹配；不因集成者未提供而默许。 */
export function reviewDependenciesMatch(receipt: ReviewReceipt, current: ReviewDependencyValues): boolean {
  const deps = receipt.dependencyHashes ?? {};
  if (deps[REVIEW_DEP_DECLARATION] !== current.declarationHash) return false;
  if (deps[REVIEW_DEP_SOURCE_SNAPSHOT] !== current.sourceSnapshotHash) return false;
  if (typeof current.workflowRulesHash !== 'string' || !current.workflowRulesHash
    || deps[REVIEW_DEP_WORKFLOW_RULES] !== current.workflowRulesHash) {
    return false;
  }
  return true;
}

export interface AuthorityReviewSelection {
  /** 依赖全匹配且报告文件绑定一致的有效报告（F07 validReportIds 驱动源）。 */
  validReportIds: string[];
  /** 未入选原因（进日志/诊断，不阻断发布判定本身）。 */
  skipped: Array<{ reviewId: string; reviewerTaskId: string; reason: string }>;
}

/**
 * v2 权威回执 → 有效报告选取（F07 核心）：
 * 1. 回执 status='valid'（作者修订/对象变化主动失效或代次旋转后为 stale）；
 * 2. 回执携带 reportUnitId/reportId，且 staging reviews/<reportUnitId>.json
 *    当前内容与回执一致（reportId + draftHash 双绑定；报告被覆盖/删除不入选）；
 * 3. 聚合依赖（声明/来源快照/规则）与当前值精确匹配；
 * 4. doc:* 逐路径与 staging 当前正文一致。
 * 多审查者各自入选；报告文件被新审查覆盖时旧回执因 reportId 不匹配自然出局。
 */
export function collectAuthorityValidatedReports(input: {
  stagingRoot: string;
  store: BuildActorStore;
  current: ReviewDependencyValues;
  /** 正文逐路径哈希（path → contentHash；发布侧由 stagingDocsEntriesOf 提供）。 */
  documentHashes: Map<string, string>;
}): AuthorityReviewSelection {
  const reviewsDir = path.join(input.stagingRoot, 'reviews');
  const readReport = (unitId: string): ReviewReport | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${unitId}.json`), 'utf8')) as ReviewReport;
      return parsed && typeof parsed.reportId === 'string' ? parsed : null;
    } catch {
      return null;
    }
  };
  const skipped: AuthorityReviewSelection['skipped'] = [];
  const validReportIds: string[] = [];
  const seenReports = new Set<string>();
  for (const receipt of input.store.listReviews()) {
    if (receipt.status !== 'valid') {
      skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: `receipt_status_${receipt.status}` });
      continue;
    }
    if (!receipt.reportUnitId || !receipt.reportId) {
      skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: 'receipt_missing_report_binding' });
      continue;
    }
    const report = readReport(receipt.reportUnitId);
    if (!report || report.reportId !== receipt.reportId || report.draftHash !== receipt.draftHash
      || report.conclusion !== receipt.verdict) {
      skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: 'report_file_binding_mismatch' });
      continue;
    }
    const scoped = Array.isArray(receipt.scopePaths) && receipt.scopePaths.length > 0;
    const declarationHash = scoped
      ? scopedReviewDeclarationHash(input.stagingRoot, receipt.scopePaths!, report.coverage.sourceRefs)
      : input.current.declarationHash;
    const deps = receipt.dependencyHashes ?? {};
    if (!declarationHash || deps[REVIEW_DEP_DECLARATION] !== declarationHash
      || deps[REVIEW_DEP_SOURCE_SNAPSHOT] !== input.current.sourceSnapshotHash
      || !input.current.workflowRulesHash || deps[REVIEW_DEP_WORKFLOW_RULES] !== input.current.workflowRulesHash) {
      skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: 'dependency_stale' });
      continue;
    }
    const docDeps = Object.entries(receipt.dependencyHashes ?? {})
      .filter(([key]) => key.startsWith('doc:'));
    const docsMatch = docDeps.length > 0 && docDeps.every(([key, hash]) => input.documentHashes.get(key.slice('doc:'.length)) === hash);
    if (!docsMatch) {
      skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: 'doc_dependency_stale' });
      continue;
    }
    if (!seenReports.has(report.reportId)) {
      seenReports.add(report.reportId);
      validReportIds.push(report.reportId);
    }
  }
  return { validReportIds, skipped };
}

/** Final v2 publication accepts independently reviewed documents. A document
 * already committed by this build's progressive release can be carried when
 * its staging hash still matches the committed promotion hash. */
export function missingScopedPassReviewPaths(input: {
  writtenPaths: Iterable<string>;
  documentHashes: ReadonlyMap<string, string>;
  basePromotionHashes: Readonly<Record<string, string>>;
  validReportIds: ReadonlySet<string>;
  receipts: readonly ReviewReceipt[];
}): string[] {
  const covered = new Set<string>();
  for (const receipt of input.receipts) {
    if (receipt.status !== 'valid' || receipt.verdict !== 'pass' || !receipt.reportId
      || !input.validReportIds.has(receipt.reportId)) continue;
    for (const docPath of receipt.scopePaths ?? []) {
      if (input.documentHashes.get(docPath) === receipt.dependencyHashes?.[`doc:${docPath}`]) covered.add(docPath);
    }
  }
  return [...input.writtenPaths].filter((docPath) => {
    const hash = input.documentHashes.get(docPath);
    return hash !== undefined && !covered.has(docPath) && input.basePromotionHashes[docPath] !== hash;
  });
}
