/**
 * knowledge-validator — 发布门禁编排（A 案 §7.4 新增门禁）
 *
 * 串接三类检查（纯函数 + 由调用方装配的资源/报告输入；本文件不读盘）：
 * 1. T1 validateKnowledgeGraph：全库结构检查（ID/alias/tombstone 无歧义、
 *    主定义唯一、关系端点有效、关键证据齐备、覆盖项有去向、迁移映射）。
 * 2. 发布期专项（A 案 §7.4「全库结构检查 + 内容审查凭据 + 发布前复核」）：
 *    - 编译器 issue 透传（join 编译门禁，A 案 §3.2）；
 *    - 内部链接有效（发布正文内相对 .md 链接与 ko_ 锚点可解析）；
 *    - 内容审查凭据：candidate.acceptance.validReportIds 可解析、对象无
 *      rejected/stale、summary/exact 已绑定当前目标修订（kb_restatement_stale
 *      由结构校验覆盖）；
 *    - manifest 哈希与 sidecar 一致性（organization/evidence/governance
 *      描述的 path+hash 与将写盘字节一致）；
 *    - 证据服务端重新解引用（快照资源 + 读取回执 + quoteHash 复核）。
 *
 * 输出进现有 report.json 语义：blocking 阻止发布（CURRENT 不动）、warnings
 * 附带（不阻断）。错误码复用/延续 kb_* 系列；本文件补充 T1 枚举未含的
 * A 案 §7.4 建议码（kb_review_stale 等）与 sidecar/链接门禁码。
 *
 * 语义边界（A 案 §7.4 末段）：「支持原意」「无遗漏」无法被结构 validator
 * 证明，由内容审查承担；本文件无告警不等于语义正确。
 *
 * diting F03 缩范围 → D1 补齐（A 案 §4.2/§5.1/§7.4）：对象级审查凭据与
 * pending 门禁已接通（流水审查通过回写 machine 审查凭据；发布范围内
 * pending 对象 blocking）。D1 起人工业务决定服务（KnowledgeGovernance-
 * Service）与 desktop 人工复核入口已实现：调用方传入治理快照
 *（GovernanceSnapshotForBuild——构建期由调用方传入冻结快照，缺省读当
 * 前；D5 接线 kb-build-service 传冻结值，单测传当前值）时：
 * - approved/disputed/deprecated 对象必须有绑定当前 payloadHash+scopeKey
 *   的有效决定（kb_decision_invalid/kb_decision_stale blocking，防模型/
 *   旧决定冒充）；
 * - 高风险 claim 无绑定当前 reviewSubjectHash 的人工复核凭据 →
 *   kb_review_human_missing 从 warning 升级为 blocking（A 案 §5.1）；
 * - supersedes 关系边的 decisionRef 必须解析到有效人工决定（边级校验）。
 * 快照缺省（未传）时保留旧披露行为：高风险人审仅 warning——D5 接线构建
 * 调用点后该路径退役。operational 查询的 approved 过滤（T4b）不变。
 */

import { createHash } from 'node:crypto';
import { validateKnowledgeGraph, type ValidationIssue } from './knowledge-schema.js';
import type { KnowledgeCompileResult } from './knowledge-compiler.js';
import { FenceTracker } from './knowledge-compiler.js';
import type { EvidenceResource, EvidenceReadReceipt } from './evidence-locator.js';
import { verifyEvidence } from './evidence-locator.js';
import type { CandidateRelease, ReviewReport } from './orchestration-contracts.js';
import type { RawSourceSnapshot } from './raw-source-snapshot.js';
import type { GovernanceSnapshotForBuild } from './knowledge-governance-service.js';
import { effectiveHumanReviewOf } from './knowledge-governance-service.js';

// ============================================================================
// 门禁码（延续 kb_* 系列；A 案 §7.4 建议 + sidecar/链接补充）
// ============================================================================

/** A 案 §7.4 建议错误码（T1 KNOWLEDGE_ISSUE_CODES 未含的门禁段）与本文件
 * 补充码。与 knowledge-schema 的码共用 report.json 通道，不新增吞错降级。
 * kb_review_pending（diting F03）：发布范围内对象审查未齐（pending）
 * → blocking（A 案 §4.2「未齐则 pending」聚合规则）；
 * kb_review_human_missing（A 案 §5.1，D1 升级）：高风险 claim 无人工
 * 复核凭据——治理快照传入时 blocking；快照缺省（D5 接线前）保留 warning
 * 披露通道；kb_review_human_rejected（diting S-F03）：同（objectId,
 * reviewSubjectHash）最新有效人审为拒绝——历史任意一次通过不能覆盖最新
 * 拒绝（A 案 §4.2「任一 rejected 则 rejected」，blocking，不接受 actor
 * 种类豁免）；
 * kb_decision_invalid（A 案 §4.2/§7.4，D1）：approved/disputed/deprecated
 * 无绑定当前载荷与范围的有效决定，或 supersedes 边 decisionRef 不解析；
 * kb_decision_stale（A 案 §4.3，D1）：决定绑定 payloadHash 与当前对象不
 * 一致（批准不自动继承新载荷）。
 */
export const KNOWLEDGE_GATE_ISSUE_CODES = [
  'kb_review_stale',
  'kb_review_credential_missing',
  'kb_review_pending',
  'kb_review_human_missing',
  'kb_review_human_rejected',
  'kb_object_registry_stale',
  'kb_decision_invalid',
  'kb_decision_stale',
  'kb_sidecar_invalid',
  'kb_link_invalid',
] as const;

// ============================================================================
// 输入/输出契约
// ============================================================================

/** sidecar 一致性输入：将写盘的字节 + manifest 段描述（发布前复核）。 */
export interface GateSidecarInput {
  organization: { path: string; hash: string; bytes: string };
  evidence: { resourcesPath: string; hash: string; bytes: string };
  governance: { path: string; hash: string; bytes: string };
}

export interface KnowledgeGateInput {
  compiled: KnowledgeCompileResult;
  /** candidate.json 反序列化结果；无知识声明验收记录时为 null（→ blocking） */
  candidate: CandidateRelease | null;
  /** 全量报告池（canPublish 同源） */
  reviews: ReviewReport[];
  /** 源快照（证据重解引用） */
  snapshot: RawSourceSnapshot;
  knowledgeBaseRoot: string;
  /** 读取回执（read-receipts.jsonl；文本/CSV 证据复核） */
  receipts?: EvidenceReadReceipt[];
  sidecars?: GateSidecarInput;
  /** D3（A 案 §5.2/§5.4）：预装配资源包（sourceId → 含工作簿/图片的资源
   * 表）。工作簿 ExcelJS 解析是异步的，由调用方（kb-build-service 发布段）
   * 预先装配后传入；未提供时回落本文件内同步 text/csv 装配。 */
  resourcePacks?: Map<string, EvidenceResource[]>;
  /** 治理快照（A 案 §4.2/§7.4，D1）：构建期由调用方传入冻结快照，缺省读
   * 当前（D5 接线 kb-build-service 传冻结值，单测传当前值）。传入后启用
   * 决定门禁（kb_decision_invalid/kb_decision_stale）、supersedes 边决定
   * 解引用与高风险人审 blocking；缺省保留旧 warning 披露行为。 */
  governance?: GovernanceSnapshotForBuild;
}

export interface KnowledgeGateResult {
  blocking: ValidationIssue[];
  warnings: ValidationIssue[];
}

function sha256Of(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

// ============================================================================
// 内部链接检查（A 案 §7.4 全库结构检查：所有内部链接有效）
// ============================================================================

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

function checkInternalLinks(compiled: KnowledgeCompileResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const docPaths = new Set(compiled.compiledDocs.map((doc) => doc.path));
  // 锚点登记：docPath → 该文档内 canonical 锚点集合（编译期已注入）
  const anchorsByDoc = new Map<string, Set<string>>();
  for (const object of compiled.knowledge.objects) {
    if (object.tombstone || !object.canonical) continue;
    const set = anchorsByDoc.get(object.canonical.path) ?? new Set<string>();
    set.add(object.objectId);
    anchorsByDoc.set(object.canonical.path, set);
  }
  for (const doc of compiled.compiledDocs) {
    const lines = doc.content.split('\n');
    // diting F07：与编译器同一围栏状态机（开栏字符+长度；四反引号内的
    // 三反引号不关栏），代码块内不检查链接。
    const fence = new FenceTracker();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (FenceTracker.fenceRunOf(line)) {
        fence.visit(line);
        continue;
      }
      if (fence.inside) continue;
      for (const match of line.matchAll(LINK_RE)) {
        const dest = match[2]!;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest) || dest.startsWith('/') || !/\.md($|#)/i.test(dest)) continue;
        const anchorIndex = dest.indexOf('#');
        const targetPath = (anchorIndex === -1 ? dest : dest.slice(0, anchorIndex));
        const anchor = anchorIndex === -1 ? '' : dest.slice(anchorIndex + 1);
        const dirIndex = doc.path.lastIndexOf('/');
        const resolved = resolveRelative(dirIndex === -1 ? '' : doc.path.slice(0, dirIndex), targetPath);
        if (!docPaths.has(resolved)) {
          issues.push({
            code: 'kb_link_invalid', field: 'body',
            message: `内部链接目标文档不存在：${doc.path} → ${dest}（解析为 ${resolved}）`,
            severity: 'blocking',
          });
          continue;
        }
        if (anchor && !anchorsByDoc.get(resolved)?.has(anchor)) {
          issues.push({
            code: 'kb_link_invalid', field: 'body',
            message: `内部链接锚点未登记：${doc.path} → ${dest}（文档 ${resolved} 无对象锚点 ${anchor}）`,
            severity: 'blocking',
          });
        }
      }
    }
  }
  return issues;
}

function resolveRelative(dir: string, rel: string): string {
  const parts: string[] = [];
  for (const segment of `${dir}/${rel}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

// ============================================================================
// 内容审查凭据（A 案 §7.4：无 rejected/stale；凭据可解析）
// ============================================================================

function checkReviewCredentials(
  candidate: CandidateRelease | null,
  reviews: ReviewReport[],
  knowledge: KnowledgeCompileResult['knowledge'],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!candidate) {
    issues.push({
      code: 'kb_review_credential_missing', field: 'acceptance',
      message: '知识化发布缺少验收记录（candidate.json）：内容审查凭据不齐，阻止发布（A 案 §7.4）',
      severity: 'blocking',
    });
  } else {
    const reportIds = new Set(reviews.map((report) => report.reportId));
    for (const reportId of candidate.acceptance.validReportIds) {
      if (!reportIds.has(reportId)) {
        issues.push({
          code: 'kb_review_credential_missing', field: 'acceptance.validReportIds',
          message: `验收记录引用的审查报告不存在：${reportId}（报告池 ${reviews.length} 份）`,
          severity: 'blocking',
        });
      }
    }
  }
  for (const object of knowledge.objects) {
    if (object.tombstone) continue;
    if (object.reviewStatus === 'rejected' || object.reviewStatus === 'stale') {
      issues.push({
        code: 'kb_review_stale', field: 'reviewStatus',
        message: `对象审查状态为 ${object.reviewStatus}，不能随本 release 发布：${object.objectId}`,
        severity: 'blocking', objectId: object.objectId,
      });
      continue;
    }
    // diting F03（A 案 §4.2/§7.4「未齐则 pending」）：发布范围内对象审查
    // 未齐 → blocking。流水审查通过时由服务端回写 machine 凭据；未走审
    // 查流水的声明发布在此显式失败，不静默放行 pending。
    if (object.reviewStatus === 'pending') {
      issues.push({
        code: 'kb_review_pending', field: 'reviewStatus',
        message: `对象审查未齐（pending），不能随本 release 发布：${object.objectId}（需流水审查通过回写机器审查凭据，A 案 §7.4）`,
        severity: 'blocking', objectId: object.objectId,
      });
    }
  }
  return issues;
}

/**
 * A 案 §5.1（D1 升级）：高风险 claim 的人工复核强制点。治理快照传入时
 * blocking——高风险断言、业务裁定映射和冲突处置至少一次人工内容复核；
 * diting S-F03：凭据 = 同（objectId, reviewSubjectHash）日志序最新一条
 * 有效人审的结论（effectiveHumanReviewOf 聚合）——最新为拒绝 →
 * kb_review_human_rejected blocking（历史通过不覆盖最新拒绝；对象自报
 * reviewActorKind 亦不得豁免拒绝）；最新为通过 → 凭据成立；无匹配记录
 * 时回退对象自身携带的服务端回写凭据（reviewActorKind='human'，S-F06
 * 发布投影或声明期继承；模型不能自行声明，声明通道由 server 独占）。
 * 快照缺省（D5 接线前）保留 warning 披露。
 */
function checkHighRiskHumanReview(
  knowledge: KnowledgeCompileResult['knowledge'],
  governance?: GovernanceSnapshotForBuild,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const severity = governance ? 'blocking' : 'warning';
  for (const object of knowledge.objects) {
    if (object.tombstone) continue;
    const hasHighRiskClaim = (object.claims ?? []).some((claim) => claim.riskCategory === 'high');
    if (!hasHighRiskClaim) continue;
    // diting S-F03：最新有效记录裁决（拒绝 > 通过 > 对象自持凭据）
    const latest = governance
      ? effectiveHumanReviewOf(governance.humanReviews, object.objectId, object.reviewSubjectHash)
      : null;
    if (latest && !latest.passed) {
      issues.push({
        code: 'kb_review_human_rejected', field: 'claims.riskCategory',
        message: `对象最新人工复核为拒绝，不能随本 release 发布：${object.objectId}（复核 ${latest.reviewId}；历史通过不覆盖最新拒绝，A 案 §4.2「任一 rejected 则 rejected」）`,
        severity: 'blocking', objectId: object.objectId,
      });
      continue;
    }
    if (latest?.passed) continue;
    if (object.reviewActorKind === 'human') continue;
    issues.push({
      code: 'kb_review_human_missing', field: 'claims.riskCategory',
      message: governance
        ? `对象含高风险 claim 但无绑定当前载荷的人工复核凭据：${object.objectId}（A 案 §5.1：高风险断言至少一次人工内容复核）`
        : `对象含高风险 claim 但无人工复核凭据（当前最高机器审）：${object.objectId}——治理快照未传入，D5 接线前仅披露不阻断（A 案 §5.1）`,
      severity, objectId: object.objectId,
    });
  }
  return issues;
}

// ============================================================================
// 人工业务决定门禁（A 案 §4.2/§4.3/§7.4；D1；治理快照传入时生效）
// ============================================================================

/**
 * 决定消费（A 案 §4.2「手工决定作为独立依据随 release 冻结，不能假装来自
 * 飞书源」；§4.3「approved 必须绑定有效业务决定」）：
 * - businessStatus ∈ {approved, disputed, deprecated} 的对象必须有当前有效
 *   决定（快照 effectiveDecisions 按 objectId 解析），否则 kb_decision_invalid
 *   blocking——防模型/旧决定冒充（对象状态不由声明产生，由决定产生）；
 * - 决定绑定的 payloadHash 与对象当前 payloadHash 不一致 → kb_decision_stale
 *   blocking（批准不自动继承新载荷，A 案 §4.3）；
 * - 决定绑定的 scopeKey/businessStatus 必须与对象一致（换范围/换状态的旧
 *   决定对当前对象无效）。
 */
function checkBusinessDecisions(
  knowledge: KnowledgeCompileResult['knowledge'],
  governance: GovernanceSnapshotForBuild,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const effective = new Map(governance.effectiveDecisions.map((decision) => [decision.objectId, decision] as const));
  for (const object of knowledge.objects) {
    if (object.tombstone) continue;
    if (object.businessStatus !== 'approved' && object.businessStatus !== 'disputed' && object.businessStatus !== 'deprecated') continue;
    const decision = effective.get(object.objectId);
    if (!decision) {
      issues.push({
        code: 'kb_decision_invalid', field: 'businessStatus',
        message: `对象 businessStatus=${object.businessStatus} 但无绑定当前载荷的有效人工决定：${object.objectId}（A 案 §4.2：状态由 desktop 人工决定通道产生，不能由声明冒充）`,
        severity: 'blocking', objectId: object.objectId,
      });
      continue;
    }
    if (decision.payloadHash !== object.payloadHash) {
      issues.push({
        code: 'kb_decision_stale', field: 'payloadHash',
        message: `决定 ${decision.decisionId} 绑定的载荷已过期（决定 ${decision.payloadHash.slice(0, 16)}… ≠ 对象 ${object.payloadHash.slice(0, 16)}…）：${object.objectId} 需在新载荷上重新决定（A 案 §4.3）`,
        severity: 'blocking', objectId: object.objectId,
      });
      continue;
    }
    if (decision.scopeKey !== object.scopeKey || decision.businessStatus !== object.businessStatus) {
      issues.push({
        code: 'kb_decision_invalid', field: 'scopeKey',
        message: `决定 ${decision.decisionId} 绑定范围/状态与对象不一致（决定 ${decision.scopeKey}/${decision.businessStatus} ≠ 对象 ${object.scopeKey}/${object.businessStatus}）：${object.objectId}`,
        severity: 'blocking', objectId: object.objectId,
      });
    }
  }
  return issues;
}

/**
 * supersedes 边级校验（A 案 §6.1「supersedes 必须有人工业务决定」）：
 * T1 结构检查只核对 decisionRef 非空；本检查（治理快照传入时）进一步要求
 * decisionRef 解析到**当前有效**决定（被取代的决定不能再支撑取代边），
 * 且决定对象即取代方（fromObjectId）——支撑的是本次取代业务，不是无关决定。
 */
function checkSupersedesDecisions(
  knowledge: KnowledgeCompileResult['knowledge'],
  governance: GovernanceSnapshotForBuild,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(governance.decisionRecords.map((decision) => [decision.decisionId, decision] as const));
  const effective = new Map(governance.effectiveDecisions.map((decision) => [decision.objectId, decision] as const));
  for (const edge of knowledge.relations) {
    if (edge.type !== 'supersedes') continue;
    const decision = edge.decisionRef ? byId.get(edge.decisionRef) : undefined;
    if (!decision) {
      issues.push({
        code: 'kb_decision_invalid', field: 'decisionRef',
        message: `supersedes 边的 decisionRef 不在治理决定集中：${edge.edgeId} → ${String(edge.decisionRef)}（A 案 §6.1）`,
        severity: 'blocking', edgeId: edge.edgeId,
      });
      continue;
    }
    const current = effective.get(edge.fromObjectId);
    if (!current || current.decisionId !== decision.decisionId) {
      issues.push({
        code: 'kb_decision_invalid', field: 'decisionRef',
        message: `supersedes 边引用的决定不是取代方当前有效决定：${edge.edgeId} → ${decision.decisionId}（当前有效：${current ? current.decisionId : '无'}）`,
        severity: 'blocking', edgeId: edge.edgeId,
      });
      continue;
    }
    if (decision.objectId !== edge.fromObjectId) {
      issues.push({
        code: 'kb_decision_invalid', field: 'decisionRef',
        message: `supersedes 边引用的决定不属于取代方对象（决定 ${decision.objectId} ≠ 边 from ${edge.fromObjectId}）：${edge.edgeId}`,
        severity: 'blocking', edgeId: edge.edgeId,
      });
    }
  }
  return issues;
}

// ============================================================================
// manifest 哈希与 sidecar 一致性（A 案 §7.4 发布前复核）
// ============================================================================

function checkSidecars(sidecars: GateSidecarInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = (label: string, declared: { path: string; hash: string }, bytes: string): void => {
    const actual = sha256Of(bytes);
    if (declared.hash !== actual) {
      issues.push({
        code: 'kb_sidecar_invalid', field: 'hash',
        message: `${label} 哈希与将写盘字节不一致：manifest ${declared.hash} ≠ 实际 ${actual}`,
        severity: 'blocking',
      });
    }
    if (declared.path.includes('..') || declared.path.startsWith('/') || declared.path.includes('\\')) {
      issues.push({
        code: 'kb_sidecar_invalid', field: 'path',
        message: `${label} 路径必须为 release 内相对路径：${declared.path}`,
        severity: 'blocking',
      });
    }
  };
  check('organization(knowledge.json)', sidecars.organization, sidecars.organization.bytes);
  check('evidence(evidence-resources.json)', { path: sidecars.evidence.resourcesPath, hash: sidecars.evidence.hash }, sidecars.evidence.bytes);
  check('governance(governance.json)', sidecars.governance, sidecars.governance.bytes);
  return issues;
}

// ============================================================================
// 证据服务端重新解引用（A 案 §5.3/§7.4：发布前复核，不信任声明期结果）
// ============================================================================

function checkEvidence(input: KnowledgeGateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.compiled.knowledge.evidence.length === 0) return issues;
  const resourcePacks = new Map<string, EvidenceResource[]>();
  const receipts = input.receipts ?? [];
  for (const evidence of input.compiled.knowledge.evidence) {
    let pack = input.resourcePacks?.get(evidence.sourceRef.sourceId) ?? resourcePacks.get(evidence.sourceRef.sourceId);
    if (!pack) {
      const entry = input.snapshot.get(evidence.sourceRef.sourceId);
      if (!entry) {
        issues.push({
          code: 'kb_evidence_unresolved', field: 'sourceRef.sourceId',
          message: `证据来源不在本构建快照内：${evidence.evidenceId} → ${evidence.sourceRef.sourceId}`,
          severity: 'blocking', objectId: evidence.objectId,
        });
        continue;
      }
      let verified: { content: string; attachments: Array<{ path: string; content: string }> };
      try {
        verified = input.snapshot.readVerified(input.knowledgeBaseRoot, evidence.sourceRef.sourceId);
      } catch (error) {
        issues.push({
          code: 'kb_evidence_unresolved', field: 'sourceRef',
          message: `证据来源读取失败（源已变化或越界）：${evidence.evidenceId} → ${error instanceof Error ? error.message : String(error)}`,
          severity: 'blocking', objectId: evidence.objectId,
        });
        continue;
      }
      pack = [{
        resourceId: evidence.sourceRef.sourceId,
        kind: 'text',
        content: verified.content,
        sourceId: evidence.sourceRef.sourceId,
        sourceSnapshotHash: entry.contentHash,
        resourceHash: contentHashOf(verified.content),
      }];
      for (const attachment of verified.attachments) {
        const base = attachment.path.split(/[\\/]/).pop() ?? '';
        pack.push({
          resourceId: `${evidence.sourceRef.sourceId}#csv:${base}`,
          kind: 'csv',
          content: attachment.content,
          path: base,
          sourceId: evidence.sourceRef.sourceId,
          sourceSnapshotHash: entry.contentHash,
          resourceHash: contentHashOf(attachment.content),
        });
      }
      resourcePacks.set(evidence.sourceRef.sourceId, pack);
    }
    const verification = verifyEvidence({
      evidence: {
        evidenceId: evidence.evidenceId,
        sourceRef: evidence.sourceRef,
        selector: evidence.selector,
        quoteHash: evidence.quoteHash,
        ...(evidence.readReceiptId ? { readReceiptId: evidence.readReceiptId } : {}),
      },
      resources: pack,
      receipts,
    });
    if (!verification.ok) {
      issues.push({
        code: verification.code, field: 'selector',
        message: `证据重新解引用失败：${evidence.evidenceId}（${evidence.objectId}/${evidence.claimKey}）— ${verification.message}`,
        severity: 'blocking', objectId: evidence.objectId,
      });
    }
  }
  return issues;
}

function contentHashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

// ============================================================================
// runKnowledgeGates 主流程
// ============================================================================

/**
 * 发布门禁编排（A 案 §7.4）。调用时机：canPublish（B 案 §7 既有条件）之后、
 * CURRENT 原子切换之前。blocking → 发布失败保留 staging、CURRENT 不动；
 * warnings 附带进 report 语义（由 kb-build-service 写入/记日志）。
 */
export function runKnowledgeGates(input: KnowledgeGateInput): KnowledgeGateResult {
  const blocking: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const collect = (issues: ValidationIssue[]): void => {
    for (const item of issues) (item.severity === 'blocking' ? blocking : warnings).push(item);
  };

  // 1. join 编译 issue 透传（A 案 §3.2：目标缺失/递归/跨范围/修订不匹配）
  collect(input.compiled.issues);
  // 2. 全库结构检查（T1；A 案 §7.4）
  collect(validateKnowledgeGraph(input.compiled.knowledge));
  // 3. 内部链接有效
  collect(checkInternalLinks(input.compiled));
  // 4. 内容审查凭据（diting F03：pending 收紧为 blocking）
  collect(checkReviewCredentials(input.candidate, input.reviews, input.compiled.knowledge));
  // 4b. 高风险人审强制点（A 案 §5.1；治理快照传入时 blocking，D1）
  collect(checkHighRiskHumanReview(input.compiled.knowledge, input.governance));
  // 4c. 人工业务决定门禁 + supersedes 边决定解引用（A 案 §4.2/§6.1；治理
  // 快照传入时生效——D5 接线构建冻结，单测传当前快照）
  if (input.governance) {
    collect(checkBusinessDecisions(input.compiled.knowledge, input.governance));
    collect(checkSupersedesDecisions(input.compiled.knowledge, input.governance));
  }
  // 5. manifest 哈希与 sidecar 一致性（发布前复核）
  if (input.sidecars) collect(checkSidecars(input.sidecars));
  // 6. 证据服务端重新解引用
  collect(checkEvidence(input));

  return { blocking, warnings };
}
