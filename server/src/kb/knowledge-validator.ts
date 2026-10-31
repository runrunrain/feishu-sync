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
 * diting F03 缩范围披露（Leader 已裁决）：对象级审查凭据与 pending 门禁
 * 已接通（流水审查通过回写 machine 审查凭据；发布范围内 pending 对象
 * blocking）；但**高风险人工复核凭据通道待后续切片**——当前只产
 * warning + workflow 披露，不 blocking。人工业务决定服务
 * （KnowledgeGovernanceService decisions）与 desktop 人工复核入口均未
 * 实现：当前 operational 可达 approved 的路径未开通（无业务决定入口），
 * approved 只能来自后续人工决定服务。诚实状态（diting F03b 披露修正）：
 * 当前所有对象发布后为 unknown+passed（机器审查凭据；工具新建对象业务
 * 状态实为 unknown，未提供 candidate 状态转换入口），未开放人工业务决
 * 定入口，approved 不可达；operational 查询会正确排除它们（T4b 已实
 * 现该过滤），不构成虚假宣传（A 案 §4.2/§7.4「未齐则 pending」）。
 */

import { createHash } from 'node:crypto';
import { validateKnowledgeGraph, type ValidationIssue } from './knowledge-schema.js';
import type { KnowledgeCompileResult } from './knowledge-compiler.js';
import { FenceTracker } from './knowledge-compiler.js';
import type { EvidenceResource, EvidenceReadReceipt } from './evidence-locator.js';
import { verifyEvidence } from './evidence-locator.js';
import type { CandidateRelease, ReviewReport } from './orchestration-contracts.js';
import type { RawSourceSnapshot } from './raw-source-snapshot.js';

// ============================================================================
// 门禁码（延续 kb_* 系列；A 案 §7.4 建议 + sidecar/链接补充）
// ============================================================================

/** A 案 §7.4 建议错误码（T1 KNOWLEDGE_ISSUE_CODES 未含的门禁段）与本文件
 * 补充码。与 knowledge-schema 的码共用 report.json 通道，不新增吞错降级。
 * kb_review_pending（diting F03）：发布范围内对象审查未齐（pending）
 * → blocking（A 案 §4.2「未齐则 pending」聚合规则）；
 * kb_review_human_missing（diting F03 缩范围）：高风险 claim 无人工复核
 * 凭据——当前仅 warning + 披露（人审通道待后续切片）。 */
export const KNOWLEDGE_GATE_ISSUE_CODES = [
  'kb_review_stale',
  'kb_review_credential_missing',
  'kb_review_pending',
  'kb_review_human_missing',
  'kb_object_registry_stale',
  'kb_decision_invalid',
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
 * diting F03（缩范围披露）：高风险 claim 的人工复核强制点。A 案 §4.2 要
 * 求高风险断言至少一次人工内容复核；人工复核入口属后续切片（见文件头
 * 披露），当前以显式 warning 披露而非 blocking——机器审 passed 不冒充
 * human-reviewed，operational 过滤也不会把它们当 approved 放行。
 */
function checkHighRiskHumanReview(knowledge: KnowledgeCompileResult['knowledge']): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const object of knowledge.objects) {
    if (object.tombstone) continue;
    const hasHighRiskClaim = (object.claims ?? []).some((claim) => claim.riskCategory === 'high');
    if (hasHighRiskClaim && object.reviewActorKind !== 'human') {
      issues.push({
        code: 'kb_review_human_missing', field: 'claims.riskCategory',
        message: `对象含高风险 claim 但无人工复核凭据（当前最高机器审）：${object.objectId}——高风险人审凭据通道待后续切片（diting F03 缩范围，A 案 §4.2；当前仅披露不阻断）`,
        severity: 'warning', objectId: object.objectId,
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
    let pack = resourcePacks.get(evidence.sourceRef.sourceId);
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
  // 4b. 高风险人审强制点（缩范围：warning + 披露，diting F03）
  collect(checkHighRiskHumanReview(input.compiled.knowledge));
  // 5. manifest 哈希与 sidecar 一致性（发布前复核）
  if (input.sidecars) collect(checkSidecars(input.sidecars));
  // 6. 证据服务端重新解引用
  collect(checkEvidence(input));

  return { blocking, warnings };
}
