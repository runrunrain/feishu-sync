/**
 * 知识对象模型与纯函数校验（知识标准库组织方案 A 案 §2–§7.4 契约层）
 *
 * 本文件只承载类型、枚举、hash 规范与图校验的**纯函数**：
 * - 不做 IO、不依赖 SQLite（A 案 §6.2：knowledge.json 是发布态组织真相，
 *   SQLite 仅摘要缓存，可删除重建）；
 * - 错误码与 A 案 §7.4 门禁共用同一枚举，提示词/工具 schema/运行期校验
 *   均引用此处定义，不各写一套；
 * - 构建/发布执行逻辑不在本文件（kb-build-service 后续任务接入）。
 *
 * 条文出处以「A 案 §x.x」标注；与 B 案（多模型构建编排）的接点在
 * orchestration-contracts.ts。
 */

import { createHash } from 'node:crypto';

// ============================================================================
// §2.1 对象类型与 §4.1 状态枚举
// ============================================================================

/** A 案 §2.1 六类型：检索维度，目录仍按领域组织 */
export type KnowledgeObjectType =
  | 'overview'
  | 'concept'
  | 'rule'
  | 'procedure'
  | 'data_structure'
  | 'decision';

export const KNOWLEDGE_OBJECT_TYPES: ReadonlySet<KnowledgeObjectType> = new Set([
  'overview', 'concept', 'rule', 'procedure', 'data_structure', 'decision',
]);

/** A 案 §4.1 业务状态：unknown 为缺省；approved 必须绑定有效业务决定 */
export type BusinessStatus = 'unknown' | 'candidate' | 'approved' | 'disputed' | 'deprecated';

export const BUSINESS_STATUSES: ReadonlySet<BusinessStatus> = new Set([
  'unknown', 'candidate', 'approved', 'disputed', 'deprecated',
]);

/** A 案 §4.1 审查状态：reviewSubjectHash 改变自动 stale，不能继承旧通过 */
export type ReviewStatus = 'pending' | 'passed' | 'rejected' | 'stale';

export const REVIEW_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'pending', 'passed', 'rejected', 'stale',
]);

/** A 案 §4.2 审查强度：程序验证不自动称作 human-reviewed */
export type ReviewActorKind = 'machine' | 'human';

/** A 案 §5.5 覆盖去向 */
export type CoverageDisposition = 'mapped' | 'excluded_template' | 'excluded_nonknowledge' | 'unresolved';

export const COVERAGE_DISPOSITIONS: ReadonlySet<CoverageDisposition> = new Set([
  'mapped', 'excluded_template', 'excluded_nonknowledge', 'unresolved',
]);

// ============================================================================
// §2.2/§2.3 身份、位置与正文范围
// ============================================================================

/** 行区间（1 起始，闭区间）。发布范围由 server 插入锚点并展开片段后重算，
 * 模型提供的行号不直接作为发布位置（A 案 §7.1）。 */
export interface BodyRange {
  startLine: number;
  endLine: number;
}

/** A 案 §2.3：一个活跃 objectId 恰有一个 canonical 位置；主定义搬迁保留
 * objectId，仅改 canonical.docId。 */
export interface CanonicalLocation {
  docId: string;
  path: string;
  /** 服务端生成的受限锚点（`ko_` 前缀）；模型不能注入任意 HTML ID */
  anchor: string;
  bodyRange: BodyRange;
}

/** A 案 §5.2：claim 记录正文精确范围、风险类别和证据集合。
 * claimKey 是对象内稳定断言键；claim 自身（键/范围/风险）入 payloadHash，
 * 证据集合（evidenceIds）只入 reviewSubjectHash。 */
export type ClaimRiskCategory = 'high' | 'normal';

export interface Claim {
  claimKey: string;
  bodyRange: BodyRange;
  riskCategory: ClaimRiskCategory;
  evidenceIds: string[];
}

/** A 案 §2.4：移除/被合并对象保留 tombstone；拆分可返回多个 successor，
 * 由调用方选择，不静默跳第一个。 */
export interface ObjectTombstone {
  reason: string;
  successorObjectIds: string[];
  removedAtReleaseId?: string;
}

/** A 案 §2.3 知识对象。objectId = `ko_` + UUID（server 分配），不含标题、
 * 目录编号、源身份或内容哈希。 */
export interface KnowledgeObject {
  objectId: string;
  type: KnowledgeObjectType;
  /** 展示名：不作身份、不入 payloadHash */
  title: string;
  /** 受控别名：只帮助查找，不自动合并同名对象；跨对象歧义由校验器报告 */
  aliases: string[];
  domainIds: string[];
  /** 同一业务问题的聚合键；同 familyKey+variantKey+scopeKey 不得重复登记 */
  familyKey: string;
  variantKey: string;
  /** 每对象必填；unknown 范围不得用于 operational 答案（A 案 §2.1） */
  scopeKey: string;
  scopeText: string;
  /** 活跃对象必填；仅 tombstone 对象可为 null */
  canonical: CanonicalLocation | null;
  /** 服务端依对象载荷变化递增；不凭模型自报 */
  revision: number;
  /** 标题/路径等展示变化另记；纯搬家/改名不改变 payloadHash（A 案 §4.3） */
  locationRevision: number;
  payloadHash: string;
  reviewSubjectHash: string;
  businessStatus: BusinessStatus;
  reviewStatus: ReviewStatus;
  reviewActorKind?: ReviewActorKind;
  reviewerId?: string;
  /** ISO UTC */
  reviewedAt?: string;
  /** A 案 §4.4 可选新鲜度：到期只提醒复核，不改业务批准 */
  staleAfter?: string;
  claims: Claim[];
  tombstone?: ObjectTombstone;
}

// ============================================================================
// §3.2 呈现方式
// ============================================================================

export type PresentationKind = 'canonical' | 'link' | 'summary' | 'exact';

export const PRESENTATION_KINDS: ReadonlySet<PresentationKind> = new Set([
  'canonical', 'link', 'summary', 'exact',
]);

/**
 * A 案 §3.2 受控呈现。canonical 的**真相**在 object.canonical；呈现表中
 * 的 canonical 条目是导航登记（≤1 条/对象，且必须与 object.canonical 一致，
 * 校验器核对）。link/summary/exact 必填 targetObjectId：
 * - summary：登记目标 + 目标 revision + 自己的正文范围与摘要依据；主对象
 *   变化即进入补审（kb_restatement_stale），不能仅更新版本号消除 stale。
 * - exact：登记 `{{kb-include:objectId:fragmentKey}}` 片段引用；join 后由
 *   server 从主定义展开，发布正文无占位符；必须直接来自目标 canonical，
 *   第一阶段不允许递归 include。
 */
export interface Presentation {
  presentationId: string;
  /** 呈现宿主对象 */
  ownerObjectId: string;
  kind: PresentationKind;
  /** 呈现自身正文范围（summary 必填） */
  bodyRange?: BodyRange;
  targetObjectId?: string;
  /** summary/exact 必填：绑定目标修订 */
  targetRevision?: number;
  /** summary：摘要依据（补审由复审结果确认） */
  summaryBasis?: string;
  /** exact：片段键（目标 canonical 内的有名片段） */
  fragmentKey?: string;
}

// ============================================================================
// §6.1 关系词表
// ============================================================================

export type KnowledgeRelationType =
  | 'defined_at'
  | 'part_of'
  | 'depends_on'
  | 'applies_to'
  | 'exception_to'
  | 'supersedes'
  | 'conflicts_with'
  | 'restates';

export const KNOWLEDGE_RELATION_TYPES: ReadonlySet<KnowledgeRelationType> = new Set([
  'defined_at', 'part_of', 'depends_on', 'applies_to', 'exception_to',
  'supersedes', 'conflicts_with', 'restates',
]);

/** A 案 §6.1 关系记录：显式端点与依据；不提供 related_to 逃生词。 */
export interface KnowledgeRelation {
  edgeId: string;
  fromObjectId: string;
  toObjectId: string;
  type: KnowledgeRelationType;
  scopeKey: string;
  /** 依据：证据集合与/或人工决定引用（supersedes 必须有 decisionRef） */
  evidenceIds: string[];
  decisionRef?: string;
  /** 仅原文或裁定明确给出时记录；缺省不是“永久有效”（A 案 §6.1） */
  validFrom?: string;
  validUntil?: string;
  reviewSubjectHash?: string;
}

/** conflicts_with 对称边按 ID 排序只存一份（A 案 §6.1）：from < to 为正典
 * 方向；乱序/双向存储都会被校验器拒绝。 */
export function isCanonicalConflictOrientation(fromObjectId: string, toObjectId: string): boolean {
  return fromObjectId < toObjectId;
}

// ============================================================================
// §5.2 证据结构
// ============================================================================

export interface EvidenceSourceRef {
  /** 引用既有快照身份 */
  sourceId: string;
  /** 复用 computeSourceHash 结果 */
  sourceSnapshotHash: string;
  /** 正文、CSV、工作簿或图形旁路资源 */
  resourceId: string;
  /** 该资源字节哈希（证明资源版本；与 quoteHash 用途不同，不相互替代） */
  resourceHash: string;
}

/** TextSpan：原始资源按 LF 归一后的行/列闭区间；不能用展示分页行号定位 */
export interface TextSpanSelector {
  kind: 'text_span';
  lineStart: number;
  lineEnd: number;
  colStart: number;
  colEnd: number;
  headingPath: string[];
  /** 可选前后文 hash（重复片段加位置消歧） */
  contextHashBefore?: string;
  contextHashAfter?: string;
}

/** CsvCells：1 起始的逻辑 record 行及列；CSV 引号内换行不等于新记录 */
export interface CsvCellsSelector {
  kind: 'csv_cells';
  resourcePath: string;
  parserVersion: string;
  recordStart: number;
  recordEnd: number;
  columns: string[];
  /** 有稳定业务键时再记录 */
  businessKeys?: string[];
}

/** WorkbookCells：冻结工作簿名、sheet、A1 区间、合并主格、公式与缓存值性质。
 * 缓存值不代表本轮计算；重建工作簿不自动等同云端原始工作簿。 */
export interface WorkbookCellsSelector {
  kind: 'workbook_cells';
  workbookName: string;
  sheet: string;
  rangeA1: string;
  mergedCellAnchors: string[];
  formulaTexts?: string[];
  valueNature: 'formula_text' | 'cached_value' | 'mixed';
}

/** MediaRegion：模型描述不得标 direct；未实际查看图像不得签人审 */
export interface MediaRegionSelector {
  kind: 'media_region';
  imageHash: string;
  region?: { x: number; y: number; w: number; h: number };
  /** 旁路文字/描述 hash */
  captionHash?: string;
  describerVersion?: string;
}

export type EvidenceSelector =
  | TextSpanSelector
  | CsvCellsSelector
  | WorkbookCellsSelector
  | MediaRegionSelector;

export type EvidenceRole = 'supports' | 'contradicts' | 'context';
export type EvidenceNature = 'direct' | 'derived' | 'machine_description';

/** A 案 §5.2 证据。人工业务决定使用独立 decisionRef（关系记录上），不伪造
 * sourceRef；readReceiptId 仅证明工具返回过对应资源，不能证明支撑。 */
export interface Evidence {
  evidenceId: string;
  objectId: string;
  /** 对象内稳定断言键（对应 Claim.claimKey） */
  claimKey: string;
  sourceRef: EvidenceSourceRef;
  selector: EvidenceSelector;
  /** 被选内容的规范化摘要（复核局部命中） */
  quoteHash: string;
  role: EvidenceRole;
  nature: EvidenceNature;
  readReceiptId?: string;
}

// ============================================================================
// §5.5 覆盖清单 / §2.4 迁移映射
// ============================================================================

/** A 案 §5.5：每个样本源的重要知识清单；分类和重要性由 reviewer 确认。 */
export interface CoverageItem {
  itemId: string;
  sourceRef: EvidenceSourceRef;
  selector?: EvidenceSelector;
  /** 分类（自由字符串，如 formula/exception/conflict） */
  category: string;
  /** 重要性：已确认重要项无去向为 blocker；普通未处理允许 warning */
  importance?: 'important' | 'normal';
  disposition: CoverageDisposition;
  targetObjectIds: string[];
  /** 排除/未处理必须给理由；“难以理解”不能成为静默删除重要内容的理由 */
  reason?: string;
}

/** A 案 §2.4 迁移映射：每个 release 携带累积有效的 ID 去向，不依赖已清理
 * 的父版本。move 不产生映射（保留 ID 改 canonical）；环、重复映射与未解释
 * 丢失均阻止发布。 */
export interface ObjectMigration {
  objectId: string;
  kind: 'merge' | 'split' | 'remove';
  /** remove 为空；split ≥ 2；merge = 1 */
  successorObjectIds: string[];
  reason: string;
  validFromReleaseId?: string;
}

// ============================================================================
// §6.2 knowledge.json 顶层形态
// ============================================================================

/** 轻量文档索引（release manifest docs 的投影）：供 canonical/呈现落点
 * 核对；正文真相在 release 的 docs 目录 Markdown，不在此重复。 */
export interface KnowledgeManifestDocumentEntry {
  docId: string;
  path: string;
}

/** release 的 knowledge.json 顶层形态（A 案 §6.2）。claim 挂在对象上，
 * evidence 为全局索引（按 evidenceId 唯一）。 */
export interface KnowledgeManifest {
  /** knowledge.json 自身结构版本（当前 1；manifest.json 的 v1/v2 见
   * types/agent-knowledge.ts KbManifest.organization） */
  schemaVersion: number;
  releaseId?: string;
  documents: KnowledgeManifestDocumentEntry[];
  objects: KnowledgeObject[];
  presentations: Presentation[];
  relations: KnowledgeRelation[];
  evidence: Evidence[];
  coverage: CoverageItem[];
  migrations: ObjectMigration[];
  /** 上一 release 对象 ID 集合：提供时核对“未解释丢失”；缺省跳过该检查 */
  previousObjectIds?: string[];
}

// ============================================================================
// §2.3 hash 规范（纯函数；同 revision 幂等：同输入必同输出）
// ============================================================================

/**
 * 规范化 JSON：递归键排序（UTF-16 码元序）、剔除 undefined、UTF-8 编码后
 * sha256 hex。这是本文件全部 hash 的确定性基础定义：对象内字段书写顺序、
 * 数组之外的键序差异不产生不同哈希。
 */
export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const SERVER_ANCHOR_RE = /<a id="ko_[A-Za-z0-9_-]+"><\/a>/g;
/** 内部 Markdown 链接 `path.md#ko_<id>` → 归一为目标 objectId */
const INTERNAL_KO_LINK_RE = /\[([^\]]*)\]\(([^)\s]+\.md)#(ko_[A-Za-z0-9_-]+)\)/g;

/**
 * 规范化对象正文（A 案 §2.3）：
 * 1. 剥离首个标题行（展示标题不入哈希；标题改名不断对象身份）；
 * 2. 剥离服务端生成的受限锚点 `<a id="ko_…"></a>`；
 * 3. 内部链接归一为目标 objectId——`[t](a.md#ko_x)` → `[t](ko_x)`；
 *    `legacyLinkTargets`（`path#heading` → objectId，来自应用/MCP alias 表）
 *    提供时旧式 heading 链接同样归一；
 * 4. 去行尾空白、掐首尾空白。
 */
export function normalizeObjectBodyForPayload(
  body: string,
  legacyLinkTargets?: Record<string, string>,
): string {
  const lines = body.split('\n');
  if (lines.length > 0 && /^#{1,6}\s/.test(lines[0]!)) lines.shift();
  let normalized = lines
    .join('\n')
    .replace(SERVER_ANCHOR_RE, '')
    .replace(INTERNAL_KO_LINK_RE, (_match, label: string, _path: string, koId: string) => `[${label}](${koId})`)
    .replace(/[ \t]+$/gm, '');
  if (legacyLinkTargets) {
    for (const [anchor, objectId] of Object.entries(legacyLinkTargets)) {
      normalized = normalized.split(`](${anchor})`).join(`](${objectId})`);
    }
  }
  return normalized.trim();
}

/** computePayloadHash 的可选上下文：旧式 heading 锚归一映射 */
export interface PayloadHashOptions {
  legacyLinkTargets?: Record<string, string>;
}

/**
 * payloadHash（A 案 §2.3）：对规范化对象正文、claim、范围与业务语义计算。
 *
 * 输入面（变化 → hash 变化）：type、aliases、domainIds、familyKey、
 * variantKey、scopeKey、scopeText、规范化正文、claim 的
 * {claimKey, 对象内相对范围, riskCategory}。claim 范围按对象 canonical
 * 起点转为相对坐标参与哈希（diting F08：纯搬家/正文平移不改变 payloadHash，
 * 发布位置只作定位；断言键/风险/正文内容变化仍使 hash 变化）。
 *
 * 排除面（变化 → hash 不变）：title（展示标题）、canonical 路径、
 * payloadHash/reviewSubjectHash（本字段，防循环哈希）、revision/
 * locationRevision、businessStatus/reviewStatus/审查人/审查时间（状态决定
 * 与审查结果）、staleAfter（时间戳）、tombstone、claim 的 evidenceIds
 * （证据绑定走 reviewSubjectHash）。集合字段按稳定序排序后参与哈希。
 */
export function computePayloadHash(
  object: KnowledgeObject,
  body: string,
  options?: PayloadHashOptions,
): string {
  const originLine = object.canonical?.bodyRange.startLine ?? 0;
  const input = {
    type: object.type,
    aliases: [...new Set(object.aliases)].sort(),
    domainIds: [...new Set(object.domainIds)].sort(),
    familyKey: object.familyKey,
    variantKey: object.variantKey,
    scopeKey: object.scopeKey,
    scopeText: object.scopeText,
    body: normalizeObjectBodyForPayload(body, options?.legacyLinkTargets),
    claims: object.claims
      .map((claim) => ({
        claimKey: claim.claimKey,
        // diting F08：绝对行号不出现在载荷哈希——同一对象整体平移（行号同移）
        // 不构成语义修订；相对范围 + riskCategory 仍捕获真实断言变化。
        relRange: {
          startLine: claim.bodyRange.startLine - originLine,
          endLine: claim.bodyRange.endLine - originLine,
        },
        riskCategory: claim.riskCategory,
      }))
      .sort((a, b) => (a.claimKey < b.claimKey ? -1 : a.claimKey > b.claimKey ? 1 : 0)),
  };
  return canonicalJsonSha256(input);
}

/** computeReviewSubjectHash 输入：本对象的审查主体各绑定面 */
export interface ReviewSubjectInput {
  payloadHash: string;
  /** 本对象全部证据绑定（Evidence 语义字段） */
  evidence: Evidence[];
  /** 相关节点为本对象（from 或 to）的语义关系 */
  relations: KnowledgeRelation[];
  /** 以本对象为 target 的 summary/exact 呈现（目标修订绑定） */
  inboundPresentations?: Presentation[];
  /** 决策依据：人工决定引用（decisionRef）集合 */
  decisionRefs?: string[];
}

/**
 * reviewSubjectHash（A 案 §2.3）：payloadHash + 证据绑定 + 相关语义关系/
 * 目标修订 + 决策依据的规范化摘要。任何一项变化使旧审查失效（reviewStatus
 * → stale，不能继承旧通过）。数组按稳定 ID 排序后参与哈希。
 */
export function computeReviewSubjectHash(input: ReviewSubjectInput): string {
  const byId = <T extends { [k: string]: unknown }>(key: string) =>
    (a: T, b: T): number => {
      const av = String(a[key]); const bv = String(b[key]);
      return av < bv ? -1 : av > bv ? 1 : 0;
    };
  return canonicalJsonSha256({
    payloadHash: input.payloadHash,
    evidence: [...input.evidence]
      .map((e) => ({
        evidenceId: e.evidenceId,
        claimKey: e.claimKey,
        sourceRef: e.sourceRef,
        selector: e.selector,
        quoteHash: e.quoteHash,
        role: e.role,
        nature: e.nature,
      }))
      .sort(byId('evidenceId')),
    relations: [...input.relations]
      .map((r) => ({
        edgeId: r.edgeId,
        fromObjectId: r.fromObjectId,
        toObjectId: r.toObjectId,
        type: r.type,
        scopeKey: r.scopeKey,
        evidenceIds: [...r.evidenceIds].sort(),
        decisionRef: r.decisionRef,
        validFrom: r.validFrom,
        validUntil: r.validUntil,
      }))
      .sort(byId('edgeId')),
    inboundPresentations: [...(input.inboundPresentations ?? [])]
      .map((p) => ({
        presentationId: p.presentationId,
        ownerObjectId: p.ownerObjectId,
        kind: p.kind,
        targetRevision: p.targetRevision,
        fragmentKey: p.fragmentKey,
      }))
      .sort(byId('presentationId')),
    decisionRefs: [...new Set(input.decisionRefs ?? [])].sort(),
  });
}

// ============================================================================
// §7.4 全库结构检查（可程序化门禁；纯函数，返回结构化 issue 列表）
// ============================================================================

export type IssueSeverity = 'blocking' | 'warning';

export interface ValidationIssue {
  code: string;
  objectId?: string;
  edgeId?: string;
  field: string;
  message: string;
  severity: IssueSeverity;
}

/** blocking issue 阻止发布（CURRENT 不动）；warning 进入 report.json 但不阻断 */
export function isBlocking(issue: ValidationIssue): boolean {
  return issue.severity === 'blocking';
}

/** 本文件发布的全部错误码（A 案 §7.4 建议错误码 + 迁移/呈现/覆盖补充码）。
 * 提示词、工具 schema 与发布检查共用，不另造吞错降级通道。 */
export const KNOWLEDGE_ISSUE_CODES = [
  'kb_object_duplicate',
  'kb_canonical_missing',
  'kb_scope_unresolved',
  'kb_relation_invalid',
  'kb_evidence_unresolved',
  'kb_restatement_stale',
  'kb_migration_invalid',
  'kb_presentation_invalid',
  'kb_include_invalid',
  'kb_coverage_invalid',
] as const;

export type KnowledgeIssueCode = (typeof KNOWLEDGE_ISSUE_CODES)[number];

function issue(
  code: KnowledgeIssueCode,
  field: string,
  message: string,
  severity: IssueSeverity,
  refs?: { objectId?: string; edgeId?: string },
): ValidationIssue {
  return { code, field, message, severity, ...refs };
}

/** 有向边表找环（DFS 三色）；返回一条环路径（节点序列），无环返回 null */
function findCycle(nodes: string[], edges: Array<[string, string]>): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = outgoing.get(from) ?? [];
    list.push(to);
    outgoing.set(from, list);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'visiting') {
      const start = stack.indexOf(node);
      return [...stack.slice(start === -1 ? 0 : start), node];
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of outgoing.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * validateKnowledgeGraph —— A 案 §7.4「全库结构检查」的可程序化部分。
 *
 * 语义边界（A 案 §7.4 末段）：“支持原意”“两公式等价”“重复对象是否同义”
 * 无法被结构 validator 证明，由内容审查检查；本函数无告警不等于语义正确。
 * 检查项与错误码映射：
 * - kb_object_duplicate：objectId 重复 / 同 familyKey+variantKey+scopeKey
 *   重复登记 / alias 歧义指向多对象。
 * - kb_canonical_missing：活跃对象无 canonical / canonical 指向不存在文档 /
 *   同对象多 canonical（或与 object.canonical 不一致）。
 * - kb_scope_unresolved：缺 scopeKey。
 * - kb_relation_invalid：非法关系词 / 端点不存在 / part_of·supersedes·
 *   迁移映射成环 / conflicts_with 乱序或双份存储 / restates 目标缺失或多
 *   定义 / supersedes 缺人工决定引用 / 依据证据悬空。
 * - kb_evidence_unresolved：高风险 claim 无证据 / evidence 的 objectId
 *   不存在（claimKey 悬空为 warning）。
 * - kb_restatement_stale：summary/exact 呈现的目标 revision 落后于对象
 *   当前 revision。
 * - kb_migration_invalid：迁移映射重复 / 未解释的对象丢失（成环归
 *   kb_relation_invalid，见任务 taxonomy）。
 * - kb_presentation_invalid：link/summary 目标缺失、summary 缺目标修订/
 *   正文范围等结构缺陷。
 * - kb_include_invalid：exact 片段目标缺失 / 递归 include / 非 canonical
 *   来源。
 * - kb_coverage_invalid：已确认重要项无去向、mapped 对象不存在、排除无
 *   理由。
 */
export function validateKnowledgeGraph(km: KnowledgeManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const objects = km.objects ?? [];
  const objectIds = new Set<string>();
  const activeObjects: KnowledgeObject[] = [];
  const seenFamilyScope = new Map<string, KnowledgeObject>();
  const aliasOwners = new Map<string, Set<string>>();

  // ---- 对象表：ID 唯一 / family 三元组唯一 / alias 无歧义（§2.3/§3.1）----
  for (const obj of objects) {
    if (objectIds.has(obj.objectId)) {
      issues.push(issue('kb_object_duplicate', 'objectId',
        `objectId 重复登记：${obj.objectId}`, 'blocking', { objectId: obj.objectId }));
      continue;
    }
    objectIds.add(obj.objectId);
    if (!obj.tombstone) activeObjects.push(obj);
    if (!obj.tombstone) {
      const familyKey = `${obj.familyKey}\u0000${obj.variantKey}\u0000${obj.scopeKey}`;
      const prior = seenFamilyScope.get(familyKey);
      if (prior) {
        issues.push(issue('kb_object_duplicate', 'familyKey',
          `同 familyKey+variantKey+scopeKey 重复登记：${prior.objectId} 与 ${obj.objectId}`, 'blocking', { objectId: obj.objectId }));
      } else {
        seenFamilyScope.set(familyKey, obj);
      }
    }
    for (const alias of obj.aliases ?? []) {
      const owners = aliasOwners.get(alias) ?? new Set<string>();
      owners.add(obj.objectId);
      aliasOwners.set(alias, owners);
    }
  }
  for (const [alias, owners] of aliasOwners) {
    if (owners.size > 1) {
      issues.push(issue('kb_object_duplicate', 'aliases',
        `alias 歧义指向多对象：${alias} → ${[...owners].sort().join(', ')}`, 'blocking'));
    }
  }

  const activeIds = new Set(activeObjects.map((o) => o.objectId));
  const byId = new Map(objects.map((o) => [o.objectId, o] as const));
  const docIds = new Set((km.documents ?? []).map((d) => d.docId));

  // ---- canonical：活跃对象恰一个主位置（§2.3/§3.1）----
  for (const obj of activeObjects) {
    if (!obj.canonical) {
      issues.push(issue('kb_canonical_missing', 'canonical',
        `活跃对象缺 canonical 主位置：${obj.objectId}`, 'blocking', { objectId: obj.objectId }));
    } else if (!docIds.has(obj.canonical.docId)) {
      issues.push(issue('kb_canonical_missing', 'canonical.docId',
        `canonical 指向不存在文档：${obj.canonical.docId}（对象 ${obj.objectId}）`, 'blocking', { objectId: obj.objectId }));
    }
  }

  // ---- scopeKey 必填（§2.1）----
  for (const obj of activeObjects) {
    if (!obj.scopeKey || !obj.scopeKey.trim()) {
      issues.push(issue('kb_scope_unresolved', 'scopeKey',
        `对象缺 scopeKey：${obj.objectId}`, 'blocking', { objectId: obj.objectId }));
    }
  }

  // ---- 呈现表：canonical 条目唯一且一致；link/summary/exact 结构 ----
  const canonicalPresentations = new Map<string, Presentation[]>();
  const exactEdges: Array<[string, string]> = [];
  for (const p of km.presentations ?? []) {
    if (!byId.has(p.ownerObjectId)) {
      issues.push(issue('kb_presentation_invalid', 'ownerObjectId',
        `呈现宿主不存在：${p.presentationId} → ${p.ownerObjectId}`, 'blocking'));
      continue;
    }
    if (p.kind === 'canonical') {
      const list = canonicalPresentations.get(p.ownerObjectId) ?? [];
      list.push(p);
      canonicalPresentations.set(p.ownerObjectId, list);
      if (p.targetObjectId && p.targetObjectId !== p.ownerObjectId) {
        issues.push(issue('kb_canonical_missing', 'targetObjectId',
          `canonical 呈现目标必须是其宿主自身：${p.presentationId}`, 'blocking', { objectId: p.ownerObjectId }));
      }
      continue;
    }
    if (!p.targetObjectId || !byId.has(p.targetObjectId)) {
      issues.push(issue(p.kind === 'exact' ? 'kb_include_invalid' : 'kb_presentation_invalid',
        'targetObjectId',
        `${p.kind} 呈现目标缺失：${p.presentationId}`, 'blocking', { objectId: p.ownerObjectId }));
      continue;
    }
    if (p.kind === 'summary') {
      if (typeof p.targetRevision !== 'number') {
        issues.push(issue('kb_presentation_invalid', 'targetRevision',
          `summary 呈现必须登记目标 revision：${p.presentationId}`, 'blocking', { objectId: p.ownerObjectId }));
      }
      if (!p.bodyRange) {
        issues.push(issue('kb_presentation_invalid', 'bodyRange',
          `summary 呈现必须登记自己的正文范围：${p.presentationId}`, 'blocking', { objectId: p.ownerObjectId }));
      }
    }
    if (p.kind === 'exact') {
      if (!p.fragmentKey) {
        issues.push(issue('kb_include_invalid', 'fragmentKey',
          `exact 片段引用缺 fragmentKey：${p.presentationId}`, 'blocking', { objectId: p.ownerObjectId }));
      }
      // 非 canonical 来源：单个 exact 片段必须直接来自目标 canonical（§3.2）
      const target = byId.get(p.targetObjectId!)!;
      if (target.tombstone || !target.canonical) {
        issues.push(issue('kb_include_invalid', 'targetObjectId',
          `exact 片段来源不是活跃 canonical 主定义：目标 ${p.targetObjectId}`, 'blocking', { objectId: p.ownerObjectId }));
      }
      exactEdges.push([p.ownerObjectId, p.targetObjectId!]);
    }
  }
  for (const [ownerId, list] of canonicalPresentations) {
    if (list.length > 1) {
      issues.push(issue('kb_canonical_missing', 'kind',
        `同对象多 canonical 呈现：${ownerId} 有 ${list.length} 条`, 'blocking', { objectId: ownerId }));
    }
    const owner = byId.get(ownerId);
    const canonicalPresentation = list[0]!;
    if (owner?.canonical && canonicalPresentation.bodyRange
      && (canonicalPresentation.bodyRange.startLine !== owner.canonical.bodyRange.startLine
        || canonicalPresentation.bodyRange.endLine !== owner.canonical.bodyRange.endLine)) {
      issues.push(issue('kb_canonical_missing', 'bodyRange',
        `canonical 呈现与 object.canonical 不一致：${ownerId}`, 'blocking', { objectId: ownerId }));
    }
  }
  // 递归 include：exact 展开图（宿主 → 目标）成环即递归（§3.2）
  const exactCycle = findCycle([...activeIds], exactEdges);
  if (exactCycle) {
    issues.push(issue('kb_include_invalid', 'targetObjectId',
      `exact 片段递归 include：${exactCycle.join(' → ')}`, 'blocking'));
  }

  // ---- restatement 失效：summary/exact 目标修订落后（§3.2）----
  for (const p of km.presentations ?? []) {
    if ((p.kind === 'summary' || p.kind === 'exact') && p.targetObjectId && typeof p.targetRevision === 'number') {
      const target = byId.get(p.targetObjectId);
      if (target && target.revision > p.targetRevision) {
        issues.push(issue('kb_restatement_stale', 'targetRevision',
          `${p.kind} 呈现绑定的目标 revision(${p.targetRevision}) 落后于当前 revision(${target.revision})：${p.presentationId}`,
          'blocking', { objectId: p.ownerObjectId }));
      }
    }
  }

  // ---- 关系表：词表 / 端点 / 环 / 对称边单份 / 依据（§6.1）----
  const evidenceIds = new Set((km.evidence ?? []).map((e) => e.evidenceId));
  const partOfEdges: Array<[string, string]> = [];
  const supersedesEdges: Array<[string, string]> = [];
  const restatesTargets = new Map<string, Set<string>>();
  for (const edge of km.relations ?? []) {
    const refs = { edgeId: edge.edgeId };
    if (!KNOWLEDGE_RELATION_TYPES.has(edge.type)) {
      issues.push(issue('kb_relation_invalid', 'type',
        `非法关系词：${String(edge.type)}`, 'blocking', refs));
      continue;
    }
    if (!byId.has(edge.fromObjectId) || !byId.has(edge.toObjectId)) {
      issues.push(issue('kb_relation_invalid', 'fromObjectId',
        `关系端点不存在：${edge.fromObjectId} → ${edge.toObjectId}`, 'blocking', refs));
      continue;
    }
    if (edge.type === 'part_of') partOfEdges.push([edge.fromObjectId, edge.toObjectId]);
    if (edge.type === 'supersedes') {
      supersedesEdges.push([edge.fromObjectId, edge.toObjectId]);
      // supersedes 必须有人工业务决定；来源日期不构成决定（§6.1）
      if (!edge.decisionRef) {
        issues.push(issue('kb_relation_invalid', 'decisionRef',
          `supersedes 必须绑定人工业务决定：${edge.edgeId}`, 'blocking', refs));
      }
    }
    if ((edge.type === 'part_of' || edge.type === 'supersedes') && edge.fromObjectId === edge.toObjectId) {
      issues.push(issue('kb_relation_invalid', 'fromObjectId',
        `${edge.type} 禁止自环：${edge.edgeId}`, 'blocking', refs));
    }
    if (edge.type === 'conflicts_with') {
      // 对称边按 ID 排序只存一份；查询反向派生（§6.1）
      if (!isCanonicalConflictOrientation(edge.fromObjectId, edge.toObjectId)) {
        issues.push(issue('kb_relation_invalid', 'fromObjectId',
          `conflicts_with 必须按 ID 排序单份存储（from < to）：${edge.edgeId}`, 'blocking', refs));
      }
    }
    if (edge.type === 'restates') {
      const targets = restatesTargets.get(edge.fromObjectId) ?? new Set<string>();
      targets.add(edge.toObjectId);
      restatesTargets.set(edge.fromObjectId, targets);
    }
    // 依据证据悬空（warning：语义由内容审查确认，结构先报线索）
    const dangling = (edge.evidenceIds ?? []).filter((id) => !evidenceIds.has(id));
    if (dangling.length > 0) {
      issues.push(issue('kb_relation_invalid', 'evidenceIds',
        `关系依据证据不存在：${edge.edgeId} → ${dangling.join(', ')}`, 'warning', refs));
    }
  }
  for (const [ownerId, targets] of restatesTargets) {
    if (targets.size > 1) {
      issues.push(issue('kb_relation_invalid', 'toObjectId',
        `restates 多定义：${ownerId} 重述多个主对象（${[...targets].sort().join(', ')}）`, 'blocking', { objectId: ownerId }));
    }
  }
  const partOfCycle = findCycle([...objectIds], partOfEdges);
  if (partOfCycle) {
    issues.push(issue('kb_relation_invalid', 'fromObjectId',
      `part_of 组成环：${partOfCycle.join(' → ')}`, 'blocking'));
  }
  const supersedesCycle = findCycle([...objectIds], supersedesEdges);
  if (supersedesCycle) {
    issues.push(issue('kb_relation_invalid', 'fromObjectId',
      `supersedes 取代环：${supersedesCycle.join(' → ')}`, 'blocking'));
  }

  // ---- 证据表：高风险 claim 必须有证据；objectId 可解（§5.1/§5.2）----
  const evidenceByClaim = new Map<string, Evidence[]>();
  for (const ev of km.evidence ?? []) {
    if (!byId.has(ev.objectId)) {
      issues.push(issue('kb_evidence_unresolved', 'objectId',
        `evidence 的 objectId 不存在：${ev.evidenceId} → ${ev.objectId}`, 'blocking'));
      continue;
    }
    const key = `${ev.objectId}\u0000${ev.claimKey}`;
    const list = evidenceByClaim.get(key) ?? [];
    list.push(ev);
    evidenceByClaim.set(key, list);
  }
  for (const obj of objects) {
    const knownClaimKeys = new Set(obj.claims?.map((c) => c.claimKey) ?? []);
    for (const claim of obj.claims ?? []) {
      if (claim.riskCategory === 'high') {
        const bound = (evidenceByClaim.get(`${obj.objectId}\u0000${claim.claimKey}`) ?? []).length > 0;
        const declared = (claim.evidenceIds ?? []).filter((id) => evidenceIds.has(id)).length > 0;
        if (!bound && !declared) {
          issues.push(issue('kb_evidence_unresolved', 'claims',
            `高风险 claim 无证据：${obj.objectId}/${claim.claimKey}（§5.1 强制细粒度证据范围）`, 'blocking', { objectId: obj.objectId }));
        }
      }
    }
    // claimKey 悬空（warning：证据登记键与对象断言键脱节的线索）
    for (const [key] of evidenceByClaim) {
      const [ownerId, claimKey] = key.split('\u0000');
      if (ownerId === obj.objectId && !knownClaimKeys.has(claimKey!)) {
        issues.push(issue('kb_evidence_unresolved', 'claimKey',
          `证据 claimKey 未在对象断言中登记：${obj.objectId}/${claimKey}`, 'warning', { objectId: obj.objectId }));
      }
    }
  }

  // ---- 迁移映射：环 / 重复映射 / 未解释丢失（§2.4）----
  const migrations = km.migrations ?? [];
  const migrationTargets = new Map<string, string[]>();
  const seenMigrationIds = new Set<string>();
  for (const migration of migrations) {
    if (seenMigrationIds.has(migration.objectId)) {
      issues.push(issue('kb_migration_invalid', 'objectId',
        `迁移映射重复登记：${migration.objectId}`, 'blocking', { objectId: migration.objectId }));
    }
    seenMigrationIds.add(migration.objectId);
    if (!migration.reason || !migration.reason.trim()) {
      issues.push(issue('kb_migration_invalid', 'reason',
        `迁移映射缺原因：${migration.objectId}`, 'blocking', { objectId: migration.objectId }));
    }
    if (migration.kind === 'remove' && migration.successorObjectIds.length > 0) {
      issues.push(issue('kb_migration_invalid', 'successorObjectIds',
        `remove 迁移不应有后继：${migration.objectId}`, 'blocking', { objectId: migration.objectId }));
    }
    if (migration.kind === 'merge' && migration.successorObjectIds.length !== 1) {
      issues.push(issue('kb_migration_invalid', 'successorObjectIds',
        `merge 迁移必须有且仅有一个存续后继：${migration.objectId}`, 'blocking', { objectId: migration.objectId }));
    }
    migrationTargets.set(migration.objectId, migration.successorObjectIds);
  }
  const migrationEdges: Array<[string, string]> = [];
  for (const [from, successors] of migrationTargets) {
    for (const successor of successors) {
      migrationEdges.push([from, successor]);
      // 后继未出现在对象表且自身无迁移记录 → 悬空映射线索（warning；
      // 语义由内容审查确认）
      if (!byId.has(successor) && !migrationTargets.has(successor)) {
        issues.push(issue('kb_migration_invalid', 'successorObjectIds',
          `迁移后继既不在对象表也无自身迁移记录：${from} → ${successor}`, 'warning', { objectId: from }));
      }
    }
  }
  const migrationCycle = findCycle([...migrationTargets.keys()], migrationEdges);
  if (migrationCycle) {
    issues.push(issue('kb_relation_invalid', 'successorObjectIds',
      `迁移映射成环：${migrationCycle.join(' → ')}`, 'blocking'));
  }
  if (km.previousObjectIds) {
    for (const previousId of km.previousObjectIds) {
      if (!objectIds.has(previousId) && !migrationTargets.has(previousId)) {
        issues.push(issue('kb_migration_invalid', 'objectId',
          `未解释的对象丢失：${previousId} 不在本 release 且无迁移映射`, 'blocking', { objectId: previousId }));
      }
    }
  }

  // ---- 覆盖清单：重要项有去向 / mapped 对象存在 / 排除有理由（§5.5）----
  for (const item of km.coverage ?? []) {
    const refs = { objectId: item.targetObjectIds[0] };
    if (!COVERAGE_DISPOSITIONS.has(item.disposition)) {
      issues.push(issue('kb_coverage_invalid', 'disposition',
        `覆盖项 disposition 非法：${item.itemId} → ${String(item.disposition)}`, 'blocking', refs));
      continue;
    }
    if (item.disposition === 'mapped') {
      if (item.targetObjectIds.length === 0) {
        issues.push(issue('kb_coverage_invalid', 'targetObjectIds',
          `已确认重要项无去向（mapped 但无目标对象）：${item.itemId}`, 'blocking', refs));
      }
      for (const targetId of item.targetObjectIds) {
        if (!byId.has(targetId)) {
          issues.push(issue('kb_coverage_invalid', 'targetObjectIds',
            `mapped 目标对象不存在：${item.itemId} → ${targetId}`, 'blocking', refs));
        }
      }
    } else if (item.disposition === 'unresolved') {
      if (item.importance === 'important') {
        issues.push(issue('kb_coverage_invalid', 'disposition',
          `高风险 unresolved 阻止发布：${item.itemId}（category=${item.category}）`, 'blocking', refs));
      } else {
        issues.push(issue('kb_coverage_invalid', 'disposition',
          `普通未处理项（warning，进覆盖元数据）：${item.itemId}`, 'warning', refs));
      }
    } else if (!item.reason || !item.reason.trim()) {
      issues.push(issue('kb_coverage_invalid', 'reason',
        `排除必须给理由：${item.itemId}（disposition=${item.disposition}）`, 'warning', refs));
    }
  }

  return issues;
}
