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
 *
 * F01（P2 §2.3，仅标准门禁 gatePolicy.strict=false）：回执另记
 * `subject:<path>` = 审查主体摘要（规范化正文 + 头部来源 + 该路径对象/
 * 断言结构 + 触及关系/呈现）。证据 selector/坐标、覆盖去向/目标、docs
 * 元数据与 workflow 规则不入摘要——它们由写时机械校验与发布结构门禁
 * 保证。携带完整 subject 键的回执在标准模式下按主体比较（另核报告文件
 * 绑定与来源快照）；严格模式与无 subject 键的旧回执完全走上述精确规则。
 *
 * WP-B1（kb-build-speedup R3.2）：主体绑定的 needs_revision 回执在
 * selector/声明-only 修订后被 F01 保留，其 blocking 问题（closureBasis 在
 * v2 流程无人写入）会永久拦截发布。关闭判定改为回执驱动：问题存在
 * 「精确绑定当前候选（doc:<path> 正文哈希 + knowledge-declaration 同范围
 * 声明哈希）且 uncheckedScope 为空的完整独立 pass 复核回执」时，旧阻断
 * 报告不再入选当前候选的有效报告（canPublish 的 blocking_issue_open 随之
 * 消除）。作者自述、needs_revision 复核、以及未构成完整复核的 pass（复审
 * R1-B：uncheckedScope 去除空白/零宽后非空，或 checkedDimensions 为空）、
 * 候选再变化后的旧 pass 均不构成关闭；每次发布重新判定，不持久化关闭状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BuildActorStore, ReviewReceipt } from './build-actors.js';
import type { KnowledgeDraftFile } from '../agent/agent-tool-service.js';
import type { RawSourceSnapshot } from './raw-source-snapshot.js';
import { computeSnapshotHash } from './build-orchestration.js';
import { isIssueClosed, type ReviewReport, type ReviewIssue } from './orchestration-contracts.js';
import { contentResourceHash } from './evidence-locator.js';
import type { GatePolicy } from './gate-policy.js';

/** dependencyHashes 保留键（doc:<path> 前缀键之外的三类聚合依赖）。 */
export const REVIEW_DEP_DECLARATION = 'knowledge-declaration';
export const REVIEW_DEP_DECLARATION_SCOPE = 'declaration-scope';
export const DOCUMENT_DECLARATION_SCOPE = 'document-v2';
export const REVIEW_DEP_SOURCE_SNAPSHOT = 'source-snapshot';
export const REVIEW_DEP_WORKFLOW_RULES = 'workflow-rules';
/** F01（P2 §2.3）：审查主体依赖键前缀（`subject:<path>`）。additive：
 * 回执照写旧四类键；仅标准门禁（gatePolicy.strict=false）读取本键。 */
export const REVIEW_DEP_SUBJECT_PREFIX = 'subject:';

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
export function scopedKnowledgeDeclarationHash(draft: KnowledgeDraftFile, paths: readonly string[], sourceIds: readonly string[], legacy = false): string {
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
    // An unassigned source item has no document owner yet. Its later assignment
    // elsewhere must not invalidate every review sharing that source. Global
    // unresolved coverage remains checked by submission/publication gates.
    // Multi-document mappings belong to every document they actually touch.
    coverage: draft.coverage.filter((item) => sources.has(item.sourceRef.sourceId)
      && (legacy ? item.targetObjectIds.every((id) => ids.has(id))
        : item.targetObjectIds.some((id) => ids.has(id)))),
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

/** Upgrade legacy receipt bindings only from an exact old declaration digest.
 * The compact proof survives checkpoint retention; it does not create a review
 * or change its verdict, body/source/rule bindings, or reviewed declarations. */
function legacyScopedDeclarationMatches(input: {
  stagingRoot: string; receipt: ReviewReceipt; sourceIds: string[]; draft: KnowledgeDraftFile;
}): boolean {
  const { receipt, draft, sourceIds, stagingRoot } = input;
  if (!receipt.scopePaths?.length || !/^[A-Za-z0-9_-]{1,100}$/.test(receipt.reviewId)) return false;
  const expected = receipt.dependencyHashes[REVIEW_DEP_DECLARATION];
  const local = scopedKnowledgeDeclarationHash(draft, receipt.scopePaths, sourceIds);
  const proofFile = path.join(stagingRoot, 'reviews', `declaration-binding-${receipt.reviewId}.json`);
  try {
    const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
    if (proof.version === 1 && proof.reviewId === receipt.reviewId && proof.boundReportId === receipt.reportId
      && proof.legacyHash === expected && proof.localHash === local) return true;
  } catch { /* No verified compatibility binding yet. */ }
  const bind = (previous: KnowledgeDraftFile): boolean => {
    if (previous.buildId !== receipt.buildId
      || scopedKnowledgeDeclarationHash(previous, receipt.scopePaths!, sourceIds, true) !== expected
      || scopedKnowledgeDeclarationHash(previous, receipt.scopePaths!, sourceIds) !== local) return false;
    try {
      fs.mkdirSync(path.dirname(proofFile), { recursive: true });
      const temporary = `${proofFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, reviewId: receipt.reviewId,
        boundReportId: receipt.reportId, legacyHash: expected, localHash: local }) + '\n');
      fs.renameSync(temporary, proofFile);
    } catch { /* The exact digest proof still holds for this invocation. */ }
    return true;
  };
  if (bind(draft)) return true;
  // Older releases did not save document-local declaration bindings. Use only
  // this build's persisted checkpoints, never a model-supplied replacement.
  if (path.basename(path.dirname(stagingRoot)) !== '.staging'
    || path.basename(stagingRoot) !== receipt.buildId) return false;
  const checkpoints = path.join(path.dirname(path.dirname(stagingRoot)), '.builds', receipt.buildId, 'checkpoints');
  try {
    for (const name of fs.readdirSync(checkpoints).filter(name => /^cp_[A-Za-z0-9_-]+$/.test(name)).slice(0, 8)) {
      try {
        const file = path.join(checkpoints, name, 'knowledge-draft.json');
        if (fs.statSync(file).size > 16 * 1024 * 1024) continue;
        const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as KnowledgeDraftFile;
        if (previous.schemaVersion === 1 && bind(previous)) return true;
      } catch { /* Missing or invalid historical declaration cannot prove reuse. */ }
    }
  } catch { /* No checkpoint evidence: keep the old receipt stale. */ }
  return false;
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

const STD_HEADER_BLOCK = /^<!--\s*\nfeishu_sync_kb:\n([\s\S]*?)\n-->[ \t]*(?:\n|$)/;

/** 审查主体正文规范化（P2 §2.3）：CRLF→LF；去 std 文件头（头部来源单列）；
 * 每行去行尾空白；去首部空行；连续 3 个以上空行压成 2 个；去末尾换行。 */
export function normalizeReviewSubjectContent(content: string): { body: string; sources: string[] } {
  const text = content.replace(/\r\n?/g, '\n');
  const header = STD_HEADER_BLOCK.exec(text);
  const sources: string[] = [];
  if (header) {
    let inSources = false;
    for (const line of header[1]!.split('\n')) {
      if (/^\s{2}sources:\s*$/.test(line)) { inSources = true; continue; }
      const item = inSources ? /^\s{4}-\s*(\S+)\s*$/.exec(line) : null;
      if (item) sources.push(item[1]!);
      else inSources = false;
    }
  }
  const body = (header ? text.slice(header[0].length) : text)
    .split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/\n+$/, '');
  return { body, sources: [...new Set(sources)].sort() };
}

/** 审查主体摘要（P2 §2.3）。纳入：规范化正文、头部来源、本路径非 tombstone
 * 对象的语义字段与断言结构（claimKey/riskCategory）、触及这些对象的关系
 * 与呈现的语义字段。不纳入：evidence（selector/回执/哈希）、coverage、
 * docs 元数据、clientKeys/evidenceKeys、payloadHash/reviewSubjectHash、
 * canonical/claim bodyRange、revision/locationRevision、审查凭据、workflow
 * 规则——这些由写时机械校验或发布结构门禁保证。 */
export function reviewSubjectDigest(draft: KnowledgeDraftFile | null, docPath: string, content: string): string {
  const { body, sources } = normalizeReviewSubjectContent(content);
  const objects = (draft?.objects ?? [])
    .filter((object) => !object.tombstone && object.canonical?.path === docPath)
    .sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
  const ids = new Set(objects.map((object) => object.objectId));
  const sortedStrings = (values: unknown[]): string[] => values.map(stableStringify).sort();
  const subject = {
    version: 1,
    path: docPath,
    body,
    sources,
    objects: objects.map((object) => ({
      objectId: object.objectId,
      type: object.type,
      title: object.title,
      aliases: object.aliases,
      domainIds: object.domainIds,
      familyKey: object.familyKey,
      variantKey: object.variantKey,
      scopeKey: object.scopeKey,
      scopeText: object.scopeText,
      businessStatus: object.businessStatus,
      claims: sortedStrings((object.claims ?? []).map((claim) => ({
        claimKey: claim.claimKey, riskCategory: claim.riskCategory,
      }))),
    })),
    relations: sortedStrings((draft?.relations ?? [])
      .filter((relation) => ids.has(relation.fromObjectId) || ids.has(relation.toObjectId))
      .map((relation) => ({
        type: relation.type, fromObjectId: relation.fromObjectId, toObjectId: relation.toObjectId,
        scopeKey: relation.scopeKey, decisionRef: relation.decisionRef,
        validFrom: relation.validFrom, validUntil: relation.validUntil,
      }))),
    presentations: sortedStrings((draft?.presentations ?? [])
      .filter((item) => ids.has(item.ownerObjectId)
        || (item.targetObjectId !== undefined && ids.has(item.targetObjectId)))
      .map((item) => ({
        kind: item.kind, ownerObjectId: item.ownerObjectId, targetObjectId: item.targetObjectId,
        fragmentKey: item.fragmentKey, summaryBasis: item.summaryBasis,
      }))),
  };
  return crypto.createHash('sha256').update(stableStringify(subject), 'utf8').digest('hex');
}

/** 当前 staging 的主体摘要解析器（按路径记忆；每次核验新建）。草稿不存在 →
 * null；声明文件存在但不可解析 → 一律 null（缺证明即不按主体放行）。 */
export function createReviewSubjectResolver(stagingRoot: string): (docPath: string) => string | null {
  const docsDir = path.resolve(stagingRoot, 'docs');
  const draftFile = path.join(stagingRoot, 'knowledge-draft.json');
  let draft: KnowledgeDraftFile | null | undefined;
  let draftBroken = false;
  const cache = new Map<string, string | null>();
  const loadDraft = (): void => {
    if (draft !== undefined || draftBroken) return;
    if (!fs.existsSync(draftFile)) { draft = null; return; }
    try {
      const parsed = JSON.parse(fs.readFileSync(draftFile, 'utf8')) as KnowledgeDraftFile;
      if (parsed?.schemaVersion !== 1) throw new Error('schema');
      draft = parsed;
    } catch { draftBroken = true; }
  };
  return (docPath: string): string | null => {
    if (cache.has(docPath)) return cache.get(docPath)!;
    let digest: string | null = null;
    const file = path.resolve(docsDir, docPath);
    if (file.startsWith(`${docsDir}${path.sep}`)) {
      loadDraft();
      if (!draftBroken) {
        try { digest = reviewSubjectDigest(draft ?? null, docPath, fs.readFileSync(file, 'utf8')); }
        catch { digest = null; }
      }
    }
    cache.set(docPath, digest);
    return digest;
  };
}

/** 标准门禁才返回主体解析器；严格模式或旧检查点（无策略）返回 undefined，
 * 调用方据此完全走精确规则。 */
export function standardReviewSubjectResolver(stagingRoot: string, policy: GatePolicy | null | undefined):
  ((docPath: string) => string | null) | undefined {
  return policy?.strict === false ? createReviewSubjectResolver(stagingRoot) : undefined;
}

/** 回执是否为每个 scopePath 都记录了主体摘要（部分缺失按旧回执处理）。 */
export function receiptHasSubjectBinding(receipt: ReviewReceipt): boolean {
  const deps = receipt.dependencyHashes ?? {};
  return !!receipt.scopePaths?.length
    && receipt.scopePaths.every((docPath) => typeof deps[`${REVIEW_DEP_SUBJECT_PREFIX}${docPath}`] === 'string');
}

/** 标准模式：回执在给定路径上的主体摘要仍等于当前值。 */
export function receiptSubjectMatches(receipt: ReviewReceipt, paths: readonly string[],
  subjectOf: (docPath: string) => string | null): boolean {
  if (!receiptHasSubjectBinding(receipt)) return false;
  return paths.every((docPath) => {
    const digest = subjectOf(docPath);
    return digest !== null && receipt.dependencyHashes[`${REVIEW_DEP_SUBJECT_PREFIX}${docPath}`] === digest;
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

// ============================================================================
// WP-B1（kb-build-speedup R3.2）：selector/声明-only 修订后的阻断问题关闭
// ============================================================================

/** 读取 staging 的审查报告文件（回执报告绑定/关闭证据判定共用）。 */
function readReviewReportFile(reviewsDir: string, unitId: string): ReviewReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${unitId}.json`), 'utf8')) as ReviewReport;
    return parsed && typeof parsed.reportId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** 未关闭 blocking 问题 → 归属路径：draftLocation 内含唯一 scopePath 时归属
 * 该路径；单路径回执直接归属；无法唯一归属返回 null（fail-closed，不关闭）
 * ——多路径范围且问题定位不含路径信息时，宁可继续拦截也不模糊放行。 */
export function blockingIssueTargetPath(
  issue: Pick<ReviewIssue, 'draftLocation'>, scopePaths: readonly string[] | undefined,
): string | null {
  if (!scopePaths || scopePaths.length === 0) return null;
  const location = issue.draftLocation.trim();
  if (!location) return scopePaths.length === 1 ? scopePaths[0]! : null;
  const mentioned = scopePaths.filter((docPath) => location.includes(docPath));
  if (mentioned.length === 1) return mentioned[0]!;
  return scopePaths.length === 1 ? scopePaths[0]! : null;
}

/** 回执的声明依赖是否仍与当前 staging 同范围声明一致（document-v2 记当前
 * 形态；无范围标记的旧回执兼容旧/新两种哈希形态，任一匹配即视为未漂移）。
 * 声明不可读/哈希缺失一律 false（缺证明不视为绑定当前候选）。 */
function receiptDeclarationMatchesCurrentDraft(input: {
  draft: KnowledgeDraftFile | null;
  receipt: ReviewReceipt;
  sourceRefs: readonly string[];
}): boolean {
  const expected = input.receipt.dependencyHashes?.[REVIEW_DEP_DECLARATION];
  const scope = input.receipt.scopePaths;
  if (typeof expected !== 'string' || !expected || !Array.isArray(scope) || scope.length === 0) return false;
  const draft = input.draft && input.draft.schemaVersion === 1 ? input.draft : null;
  if (!draft) return false;
  const sourceIds = [...input.sourceRefs];
  if (input.receipt.dependencyHashes?.[REVIEW_DEP_DECLARATION_SCOPE] === DOCUMENT_DECLARATION_SCOPE) {
    return scopedKnowledgeDeclarationHash(draft, scope, sourceIds) === expected;
  }
  return scopedKnowledgeDeclarationHash(draft, scope, sourceIds) === expected
    || scopedKnowledgeDeclarationHash(draft, scope, sourceIds, true) === expected;
}

/** 读取当前 staging 的 knowledge-draft（schemaVersion=1；不可读/形状不对 → null）。 */
function readCurrentKnowledgeDraft(stagingRoot: string): KnowledgeDraftFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stagingRoot, 'knowledge-draft.json'), 'utf8')) as KnowledgeDraftFile;
    return parsed?.schemaVersion === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** 当前路径的候选绑定（正文哈希 + 该文档范围声明哈希，声明范围 = 文档头部
 * 声明的来源）。不可读/声明缺失 → null（fail-closed，不构成可比较的候选）。 */
export function currentPathCandidateBinding(stagingRoot: string, docPath: string):
  { docHash: string; declarationHash: string } | null {
  try {
    const docsDir = path.resolve(stagingRoot, 'docs');
    const file = path.resolve(docsDir, docPath);
    if (!file.startsWith(`${docsDir}${path.sep}`)) return null;
    const content = fs.readFileSync(file, 'utf8');
    const draft = readCurrentKnowledgeDraft(stagingRoot);
    if (!draft) return null;
    const sourceIds = normalizeReviewSubjectContent(content).sources;
    return {
      docHash: contentResourceHash(content),
      declarationHash: scopedKnowledgeDeclarationHash(draft, [docPath], sourceIds),
    };
  } catch {
    return null;
  }
}

/** 回执是否可证明已相对指定路径漂移（WP-B1复审 R2 旧清单 fromReviewId 判定）：
 * doc:<path> 依赖或同范围声明依赖与当前值可对照且不一致 → true；任一侧
 * 无法计算/不可证明 → false（fail-closed，不据此允许关闭）。 */
export function reviewReceiptPathOriginDrifted(input: {
  stagingRoot: string;
  receipt: ReviewReceipt;
  docPath: string;
}): boolean {
  const current = currentPathCandidateBinding(input.stagingRoot, input.docPath);
  if (!current) return false;
  const deps = input.receipt.dependencyHashes ?? {};
  const docDep = deps[`doc:${input.docPath}`];
  if (typeof docDep !== 'string') return false;
  if (docDep !== current.docHash) return true;
  const report = input.receipt.reportUnitId
    ? readReviewReportFile(path.join(input.stagingRoot, 'reviews'), input.receipt.reportUnitId) : null;
  if (!report || report.reportId !== input.receipt.reportId) return false;
  const draft = readCurrentKnowledgeDraft(input.stagingRoot);
  if (!draft) return false;
  return !receiptDeclarationMatchesCurrentDraft({ draft, receipt: input.receipt,
    sourceRefs: report.coverage?.sourceRefs ?? [] });
}

/** 待关闭问题引用（kri 报告问题与 kil 清单问题共用）。 */
export interface ClosureIssueRef {
  targetPath: string;
  draftLocation: string | null;
}

/** 空白与零宽字符（含 BOM/NBSP）：uncheckedScope 判空前先剔除。 */
const BLANK_AND_INVISIBLE = /[\s\u00a0\u200b-\u200d\u2060\ufeff]/g;

/** pass 复核报告是否可作为关闭证据（WP-B1复审 R1/R1-A/R1-B）：自然语言的
 * 未核范围声明无法用有限关键词证明「不涉及本问题」——同义表达
 * （Everything besides…/Nothing but… 等）总能绕过枚举。因此采用完全
 * fail-closed 的结构口径：uncheckedScope 去除空白与零宽字符后只要仍有
 * 任一非空条目，就视为可能涉及本问题，不构成关闭证据；checkedDimensions
 * 为空（什么都没核）同样不构成。关闭需要 uncheckedScope 为空的完整复核
 * （reviewer-protocol 已同步提示：泛述未核范围会阻断自动关闭）。 */
function passReportExcludesIssue(report: ReviewReport): boolean {
  if (!Array.isArray(report.checkedDimensions) || report.checkedDimensions.length === 0) return true;
  const unchecked = Array.isArray(report.uncheckedScope) ? report.uncheckedScope : [];
  return unchecked.some((entry) => typeof entry === 'string'
    && entry.replace(BLANK_AND_INVISIBLE, '').length > 0);
}

/** 当前候选（正文+声明哈希精确匹配）的独立 pass 复核对逐个问题的关闭判定。
 *
 * 用作阻断问题关闭证据（WP-B1 + 复审 R1/R1-A/R1-B）：作者 selector/覆盖/
 * 对象声明-only 修订不改正文，主体摘要不变的旧 pass 回执（F01 保留）不代表
 * 「对推进后候选的复核」；只有 doc:<path> 与 knowledge-declaration 都精确
 * 匹配当前 staging 的 pass 回执才构成候选绑定，且其报告必须是**完整复核**
 * ——uncheckedScope 为空或全空白（R1-B：非空一律可能涉及本问题，
 * 不再尝试自然语言排除判定）且 checkedDimensions 非空。候选再变化即失去
 * 关闭效力；每次调用重新判定。 */
export function passReviewClosureForIssues(input: {
  stagingRoot: string;
  receipts: readonly ReviewReceipt[];
  issues: readonly ClosureIssueRef[];
}): boolean[] {
  const closed = input.issues.map(() => false);
  if (input.issues.length === 0) return closed;
  const draft = readCurrentKnowledgeDraft(input.stagingRoot);
  if (!draft) return closed;
  const reviewsDir = path.join(input.stagingRoot, 'reviews');
  const docsDir = path.resolve(input.stagingRoot, 'docs');
  const currentDocHash = (docPath: string): string | null => {
    const file = path.resolve(docsDir, docPath);
    if (!file.startsWith(`${docsDir}${path.sep}`)) return null;
    try {
      return contentResourceHash(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  for (const receipt of input.receipts) {
    if (receipt.status !== 'valid' || receipt.verdict !== 'pass' || !receipt.reportId || !receipt.reportUnitId) continue;
    const report = readReviewReportFile(reviewsDir, receipt.reportUnitId);
    if (!report || report.reportId !== receipt.reportId || report.draftHash !== receipt.draftHash
      || report.conclusion !== receipt.verdict) continue;
    if (!receiptDeclarationMatchesCurrentDraft({ draft, receipt,
      sourceRefs: report.coverage?.sourceRefs ?? [] })) continue;
    const deps = receipt.dependencyHashes ?? {};
    // R1-B：未核范围判定与具体问题无关（任一非空条目都可能涉及），回执级一次判定
    if (passReportExcludesIssue(report)) continue;
    for (const [index, issue] of input.issues.entries()) {
      if (closed[index] || !receipt.scopePaths?.includes(issue.targetPath)) continue;
      const expectedBody = deps[`doc:${issue.targetPath}`];
      if (typeof expectedBody !== 'string' || currentDocHash(issue.targetPath) !== expectedBody) continue;
      closed[index] = true;
    }
  }
  return closed;
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
 * 标准门禁（input.subjectOf）下携带完整 subject 键的回执以 1、2、来源快照
 * 与 subject:* 主体摘要替代 3/4 的声明、规则与正文字节比对（F01）。
 * 多审查者各自入选；报告文件被新审查覆盖时旧回执因 reportId 不匹配自然出局。
 */
export function collectAuthorityValidatedReports(input: {
  stagingRoot: string;
  store: BuildActorStore;
  current: ReviewDependencyValues;
  /** 正文逐路径哈希（path → contentHash；发布侧由 stagingDocsEntriesOf 提供）。 */
  documentHashes: Map<string, string>;
  /** F01：仅标准门禁提供（standardReviewSubjectResolver）。携带完整 subject
   * 键的回执改按主体摘要 + 来源快照核验；缺省 = 严格模式精确规则。 */
  subjectOf?: (docPath: string) => string | null;
}): AuthorityReviewSelection {
  const reviewsDir = path.join(input.stagingRoot, 'reviews');
  const skipped: AuthorityReviewSelection['skipped'] = [];
  interface SelectedReview {
    receipt: ReviewReceipt;
    report: ReviewReport;
    subjectBound: boolean;
    /** WP-B1：未关闭 blocking 问题已被当前候选 pass 复核取代 → 不入选 */
    superseded: boolean;
    closureIssues: ClosureIssueRef[] | null;
  }
  const selected: SelectedReview[] = [];
  let draft: KnowledgeDraftFile | null = null;
  try { draft = JSON.parse(fs.readFileSync(path.join(input.stagingRoot, 'knowledge-draft.json'), 'utf8')); } catch { /* checked below */ }
  for (const receipt of input.store.listReviews()) {
    if (receipt.status !== 'valid') {
      skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: `receipt_status_${receipt.status}` });
      continue;
    }
    if (!receipt.reportUnitId || !receipt.reportId) {
      skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: 'receipt_missing_report_binding' });
      continue;
    }
    const report = readReviewReportFile(reviewsDir, receipt.reportUnitId);
    if (!report || report.reportId !== receipt.reportId || report.draftHash !== receipt.draftHash
      || report.conclusion !== receipt.verdict) {
      skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: 'report_file_binding_mismatch' });
      continue;
    }
    if (input.subjectOf && receiptHasSubjectBinding(receipt)) {
      // 标准模式主体绑定：declaration/doc:*/workflow-rules 三项不比对；
      // 正文、对象/断言结构或关系变化都会改变主体摘要而失效。
      if (receipt.dependencyHashes[REVIEW_DEP_SOURCE_SNAPSHOT] !== input.current.sourceSnapshotHash
        || !receiptSubjectMatches(receipt, receipt.scopePaths!, input.subjectOf)) {
        skipped.push({ reviewId: receipt.reviewId, reviewerTaskId: receipt.reviewerTaskId, reason: 'subject_stale' });
        continue;
      }
      selected.push({ receipt, report, subjectBound: true, superseded: false, closureIssues: null });
      continue;
    }
    const scoped = Array.isArray(receipt.scopePaths) && receipt.scopePaths.length > 0;
    const declarationHash = scoped
      ? scopedReviewDeclarationHash(input.stagingRoot, receipt.scopePaths!, report.coverage.sourceRefs)
      : input.current.declarationHash;
    const deps = receipt.dependencyHashes ?? {};
    const declarationMatches = scoped && deps[REVIEW_DEP_DECLARATION_SCOPE] === undefined
      ? !!draft && legacyScopedDeclarationMatches({ stagingRoot: input.stagingRoot, receipt,
        sourceIds: report.coverage.sourceRefs, draft })
      : (!scoped || deps[REVIEW_DEP_DECLARATION_SCOPE] === DOCUMENT_DECLARATION_SCOPE)
        && !!declarationHash && deps[REVIEW_DEP_DECLARATION] === declarationHash;
    if (!declarationMatches
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
    selected.push({ receipt, report, subjectBound: false, superseded: false, closureIssues: null });
  }
  // WP-B1（kb-build-speedup R3.2）：标准模式下主体绑定的 needs_revision 回执在
  // selector/覆盖/对象声明-only 修订后仍被 F01 保留为有效，但其 blocking 问题
  // 指向修订前候选（正文未变 → 主体摘要不变 → 旧报告永远「有效」，且
  // closureBasis 在 v2 流程无人写入 → blocking_issue_open 永不消除，只能靠
  // 伪造正文改动推进候选哈希——2026-11-06 实测 37 分钟空转的根因）。修复：
  // 回执声明依赖已漂移（问题指向旧候选）且每个问题都有「精确绑定当前候选
  // （正文+声明）且为完整复核（uncheckedScope 为空）的独立 pass 复核」时，
  // 该报告不再作为当前候选的阻断来源。声明未漂移（问题就在当前候选上）、
  // 无 pass 证据、路径无法归属、或 pass 报告未构成完整复核（复审 R1-B：
  // uncheckedScope 去除空白/零宽后非空，或 checkedDimensions 为空）时照旧
  // 拦截——作者自述修复不构成关闭，同候选的 pass 分歧也不能盖掉 blocking
  // 问题；候选再变化即失去关闭效力（每次发布重新判定，不持久化关闭状态）。
  interface PendingClosure { entry: SelectedReview; issueRefs: ClosureIssueRef[] }
  const pending: PendingClosure[] = [];
  for (const entry of selected) {
    if (!entry.subjectBound || entry.superseded) continue;
    const open = entry.report.issues.filter((issue) => issue.severity === 'blocking' && !isIssueClosed(issue));
    if (open.length === 0) continue;
    if (receiptDeclarationMatchesCurrentDraft({ draft, receipt: entry.receipt,
      sourceRefs: entry.report.coverage?.sourceRefs ?? [] })) continue;
    const issueRefs: ClosureIssueRef[] = [];
    let attributable = true;
    for (const issue of open) {
      const target = blockingIssueTargetPath(issue, entry.receipt.scopePaths);
      if (!target) { attributable = false; break; }
      issueRefs.push({ targetPath: target, draftLocation: issue.draftLocation });
    }
    if (!attributable || issueRefs.length === 0) continue;
    entry.closureIssues = issueRefs;
    pending.push({ entry, issueRefs });
  }
  if (pending.length > 0) {
    const allIssueRefs = pending.flatMap((item) => item.issueRefs);
    const closedFlags = passReviewClosureForIssues({ stagingRoot: input.stagingRoot,
      receipts: selected.filter((item) => !item.superseded).map((item) => item.receipt),
      issues: allIssueRefs });
    let cursor = 0;
    for (const item of pending) {
      const flags = closedFlags.slice(cursor, cursor + item.issueRefs.length);
      cursor += item.issueRefs.length;
      if (flags.every((closed) => closed)) {
        item.entry.superseded = true;
        skipped.push({ reviewId: item.entry.receipt.reviewId, reviewerTaskId: item.entry.receipt.reviewerTaskId,
          reason: 'blocking_issues_closed_by_current_pass' });
      }
    }
  }
  const validReportIds: string[] = [];
  const seenReports = new Set<string>();
  for (const entry of selected) {
    if (entry.superseded) continue;
    if (!seenReports.has(entry.report.reportId)) {
      seenReports.add(entry.report.reportId);
      validReportIds.push(entry.report.reportId);
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
  /** F01：仅标准门禁提供；带 subject 键的回执按主体摘要判定覆盖。 */
  subjectOf?: (docPath: string) => string | null;
}): string[] {
  const covered = new Set<string>();
  for (const receipt of input.receipts) {
    if (receipt.status !== 'valid' || receipt.verdict !== 'pass' || !receipt.reportId
      || !input.validReportIds.has(receipt.reportId)) continue;
    const bySubject = !!input.subjectOf && receiptHasSubjectBinding(receipt);
    for (const docPath of receipt.scopePaths ?? []) {
      if (bySubject
        ? input.documentHashes.has(docPath) && receiptSubjectMatches(receipt, [docPath], input.subjectOf!)
        : input.documentHashes.get(docPath) === receipt.dependencyHashes?.[`doc:${docPath}`]) covered.add(docPath);
    }
  }
  return [...input.writtenPaths].filter((docPath) => {
    const hash = input.documentHashes.get(docPath);
    return hash !== undefined && !covered.has(docPath) && input.basePromotionHashes[docPath] !== hash;
  });
}
