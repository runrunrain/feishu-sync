/**
 * AgentToolService — 工具规格下发与执行（设计 §7 / §9.6）
 *
 * server 层权威：/api/agent-internal/* 校验 X-Agent-Run-Token → 取运行
 * 上下文 → 工具名必须在 allowedTools → 所有路径经 PathGuard。模式切换
 * 会使旧令牌立即失效（进程重启并换发新令牌）。
 *
 * Work 写操作审计：<dataRoot>/agent/audit/<sessionId>.jsonl（时间、工具、
 * 路径、字节数、结果——不记录正文与凭据）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isBlankWorkbookPlaceholder, reconcileBlankCsvCoverage } from '../kb/blank-csv-coverage.js';
import { renderCsvTableImport } from '../kb/csv-table-import.js';
import { MAX_STANDARD_DOC_BYTES } from '../kb/standard-doc-limits.js';
import { annotateRawReadPage, skipBlankCsvContinuation, type BlankCsvSkip } from '../kb/csv-read-compact.js';
import { isPermissionDeniedSourcePlaceholder } from '../kb/source-availability.js';
import {
  atomicWriteFile,
  listDirInside,
  PathGuardError,
  removeFileInside,
  resolveInside,
} from './path-guard.js';
import {
  KB_DELETE_DOC_SPEC,
  KB_FINISH_SPEC,
  KB_GET_PLAN_SPEC,
  KB_GREP_SPEC,
  KB_READ_SPEC,
  KB_SEARCH_SPEC,
  KB_SUBMIT_PLAN_SPEC,
  KB_SUBMIT_REVIEW_SPEC,
  KB_UNIT_DONE_SPEC,
  KB_WRITE_DOC_SPEC,
  KB_EDIT_DOC_SPEC,
  KB_TOOL_SCHEMA_SPEC,
  KB_READ_BATCH_SPEC,
  BUILD_MANIFEST_SPEC,
  BUILD_ASSIGN_OUTPUT_SPEC,
  BUILD_REVOKE_OUTPUT_SPEC,
  BUILD_HANDOFF_SUBMIT_SPEC,
  BUILD_HANDOFF_LIST_SPEC,
  BUILD_ISSUES_SUBMIT_SPEC,
  BUILD_ISSUES_LIST_SPEC,
  BUILD_CHECKPOINT_SPEC,
  BUILD_REQUEST_PUBLISH_SPEC,
  V2_LEADER_TOOLS,
  DRAFT_LIST_SPEC,
  DRAFT_READ_SPEC,
  DRAFT_SEARCH_SPEC,
  RAW_LIST_SPEC,
  RAW_LINKS_SPEC,
  RAW_COMMENTS_SPEC,
  RAW_READ_IMAGE_SPEC,
  RAW_READ_SPEC,
  RAW_CSV_CELLS_SPEC,
  RAW_CSV_FIND_SPEC,
  RAW_SEARCH_SPEC,
  WS_EDIT_SPEC,
  WS_LS_SPEC,
  WS_MKDIR_SPEC,
  WS_READ_SPEC,
  WS_SEARCH_SPEC,
  WS_WRITE_SPEC,
} from './tool-specs.js';
import { TASK_TOOL_FAMILY_NAME } from './tool-specs.js';
import { RawSourceSnapshot, collectSourceCandidates } from '../kb/raw-source-snapshot.js';
import { StandardKbStore, parseStdHeader, stripStdHeader } from '../kb/standard-kb-store.js';
import { KbVersionStore } from '../kb/kb-version-store.js';
import { finalDraftEvidenceScopePaths } from '../kb/progressive-knowledge-draft.js';
import {
  computePayloadHash,
  computeReviewSubjectHash,
  coverageReasonImpliesKnowledgeTransfer,
  KNOWLEDGE_OBJECT_TYPES,
  KNOWLEDGE_RELATION_TYPES,
  type BodyRange,
  type BusinessStatus,
  type Claim,
  type CoverageItem,
  type Evidence,
  type EvidenceSelector,
  type KnowledgeObject,
  type KnowledgeObjectType,
  type KnowledgeRelation,
  type KnowledgeRelationType,
  type Presentation,
  type ReviewStatus,
} from '../kb/knowledge-schema.js';
import {
  contentResourceHash,
  parseCsvRecords,
  resolveSelector,
  verifyEvidence,
  type EvidenceReadReceipt,
  type EvidenceResource,
} from '../kb/evidence-locator.js';
import {
  IMAGE_RESOURCE_PREFIX,
  WORKBOOK_RESOURCE_PREFIX,
  collectImageEvidenceResources,
  loadWorkbookEvidenceResource,
} from '../kb/evidence-resources.js';
import { computeCandidateHash, type ReviewIssue, type ReviewReport } from '../kb/orchestration-contracts.js';
import {
  REVIEW_DEP_DECLARATION,
  REVIEW_DEP_SOURCE_SNAPSHOT,
  REVIEW_DEP_WORKFLOW_RULES,
  resolveCurrentReviewDependencies,
  scopedReviewDeclarationHash,
  type ReviewDependencyValues,
} from '../kb/review-authority.js';
import { getKbQueryService, QueryError } from '../kb/search/kb-query-service.js';
import { splitAnchor } from '../kb/search/outline.js';
import { hashImageFile, inlineImageBlocks, resolveSourceImages, extractWhiteboardBypassTexts, type ImageDescriptionLike, type WhiteboardTextMap } from '../kb/source-images.js';
import type { PathClaims } from '../kb/path-claims.js';
import {
  BuildActorError,
  BuildActorStore,
  deriveIdempotencyKey,
  V2_CHILD_READ_TOOLS,
  type CredentialKind,
} from '../kb/build-actors.js';
import type { BuildUnit } from '../kb/build-units.js';
import type { ImageDescription } from './vision/vision-describer.js';
import { matchGlob, parseSearchQuery } from '../kb/kb-search.js';
import { scoreRawText } from '../kb/raw-search-score.js';
import {
  renderSourceLinksBlock,
  resolveSourceLinks,
  SOURCE_LINKS_PAGE_LIMIT,
  type IncomingLinkEdgeRow,
  type ResolvedSourceLink,
  type SourceLinkEdgeRow,
} from '../kb/source-links.js';
import { hasEditorialHistory, hasSourceMetadata } from '../kb/body-policy.js';
import type {
  AgentRunContext,
  AgentRunKind,
  AgentToolSpec,
  RawSourceSnapshotEntry,
} from '../types/agent-knowledge.js';
import { toolsForRunKind } from '../types/agent-knowledge.js';
import type { DocumentRecord } from '../types/index.js';
import type { SourceCommentMetaRow, SourceCommentRow } from '../modules/local-map-store.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: Record<string, unknown>;
}

export class ToolError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** P1-S4（§2.4）：raw_links 双向各方向返回上限。 */
const RAW_LINKS_LIMIT = 200;

export interface BuildRunState {
  knowledgeBaseRoot: string;
  snapshot: RawSourceSnapshot;
  /** F3-R07：工作集语义（objToken → 变更类型；full = 全量重建） */
  mode: 'full' | 'incremental';
  /** 工作集（objToken → 变更类型；full 时含快照全部源，changeType='rebuild'） */
  workset: Map<string, 'added' | 'changed' | 'rebuild'>;
  stagingRoot: string;
  /** kb_write_doc 写入时同步更新（标题/摘要/标签，manifest 生成用） */
  docMeta?: Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>;
  finishInfo: { summary: string; skipped: Array<{ objToken: string; reason: string }>; docMerges?: Array<{ path: string; mergedInto: string[] }> } | null;
  /** 受旧源变动影响的现存草稿必须显式重写，不能借旧sources声明冒充更新。 */
  requiredRewrites?: Set<string>;
  /** 继续构建时，未受影响的旧文档须保留，或经显式合并继承全部来源。 */
  preservedDocs?: Map<string, string[]>;
  /** 完整写入/删除草稿或提交进度后原子保存检查点。 */
  onCheckpoint?: () => void;
  writtenPaths?: Set<string>;
  /** Pinned previous release, used to reject invented merge origins before kb_finish commits. */
  baseDocPaths?: Set<string>;
  /**
   * F3-R08：不可恢复毒化标记。raw_read/raw_search 命中
   * source_changed_during_build 后置位；后续每个 batch 结束与发布前都
   * 检查——模型不得用 skip/finish 绕过，构建必须以同码失败终止。
   */
  poisoned?: { code: string; message: string };
  /**
   * S4（§4.4）：并行构建共享状态。所有 worker 共享同一 BuildRunState；
   * units/unitDone/claims 由 KbBuildService 在 running 前初始化。
   */
  units?: BuildUnit[];
  /** 逐单元完成上报（kb_unit_done；重复调用以最后一次为准） */
  unitDone?: Map<string, { summary: string; skipped: Array<{ objToken: string; reason: string }> }>;
  /** 构建内路径认领：worker 上下文写工具先 claim，收尾轮不受限 */
  claims?: PathClaims;
  /** S3：preflight 图片描述（objToken → src → 描述/不可用标记） */
  imageDescriptions?: Map<string, Map<string, ImageDescription>>;
  /** S3：本次构建 vision 是否就绪（未就绪且未命中的图片插 unavailable 标记，U5） */
  visionReady?: boolean;
  /**
   * P0-S7（设计 §5.6 + 任务 4）：preflight 白板旁路文字（objToken → src →
   * 抽取结果，仅非空文字）。raw_read 内联 <whiteboard_text>；命中者跳过
   * vision 识图（省额度，svg/raw 同规则）。
   */
  whiteboardTexts?: Map<string, WhiteboardTextMap>;
  /** T3（A 案 §6.2）：knowledge-draft.json 内存缓存（真相在文件；首次访问加载） */
  knowledgeDraft?: KnowledgeDraftFile;
  /** diting S-F01：构建级知识声明互斥队列尾（同 build 的「读取声明→
   * 复核→提交」临界区排队串行；跨 build 不互斥——worker 共享同一
   * BuildRunState，锁住在 state 上即构建级）。 */
  knowledgeDeclarationQueue?: Promise<unknown>;
  /** T3（A 案 §7.2）：organization-plan.json 内存缓存 */
  organizationPlan?: OrganizationPlanFile;
  /** T3（A 案 §5.3）：read-receipts.jsonl 内存镜像（真相在文件；首次访问加载） */
  readReceipts?: ReadReceiptRecord[];
  /**
   * v2 编排（设计 v2 §4/§8/§11）：成果权限账本与发布管线。集成者在
   * runPipeline 的 pi-amagi 分支 running 前初始化；旧模式（legacy）
   * 不设置，行为不变。token 级 credential 在 RunContextOptions.orchestration。
   */
  v2?: {
    actorStore: BuildActorStore;
    generation: number;
    /** 发布校验管线（§5.4）；未接线时 build_request_publish 返回 build_publish_not_wired */
    publishHandler?: V2PublishHandler;
  };
  /** v2 冻结 workflow 规则哈希（F08：materializeWorkflowSkill 的 sha256，
  * 即 leaderRun.spec.workflowRevision）。集成者在 runLeaderSupervisedPhase
  * 设置；审查回执依赖绑定与发布核验共用（null = 未提供，见 review-authority）。 */
  v2WorkflowRulesHash?: string | null;
}

/** v2 发布校验管线（§5.4）：锁定候选后由集成者执行全量检查（对象身份/来源
 * 覆盖/引用目标/审查绑定/阻断问题）；返回 accepted 与结果详情。
 *
 * F11 补强：authorityLease = 本次工具调用的 Leader ctx 租约闭包（服务端
 * 内部构造，不经模型 JSON；不携带 token/secret，不落盘不进 checkpoint）。
 * 发布管线在真正指针提交点调用 validate()——token 被撤（取消/换代/收尾
 * 的 revokeToken/revokeSessionTokens）或 ctx 被标记 revoked 后拒绝提交。 */
export interface V2PublishHandler {
  (input: {
    buildId: string;
    generation: number;
    candidateHash: string;
    requestedRevision: string | null;
    summary: string | null;
    /** F11 补强：ctx 租约闭包（服务端构造；缺省视为无证明，提交点拒绝） */
    authorityLease?: { validate: () => void };
  }): Promise<{ accepted: boolean; result: Record<string, unknown> }>;
}

/** v2 编排运行参数（设计 v2 §3.4/§4）：出现即新模式分支——按任务身份、
 * 输出分配与成果状态判定权限，不借用旧 unit/phase 字段（不伪装 final）。 */
export interface OrchestrationV2Options {
  mode: 'pi-amagi';
  buildId: string;
  generation: number;
  credential: CredentialKind;
  actorStore: BuildActorStore;
  publishHandler?: V2PublishHandler;
}

export interface RunContextOptions {
  runKind: AgentRunContext['runKind'];
  sessionId?: string;
  buildId?: string;
  workspaceRoot?: string;
  /** discuss/work 会话可用的标准库根 */
  outputRoot: string;
  /** discuss/work 会话的原始库根 */
  knowledgeBaseRoot: string;
  buildState?: BuildRunState;
  onEvent?: (event: { phase: 'start' | 'end'; toolName: string; toolCallId?: string; argsSummary: string; resultSummary?: string; isError?: boolean }) => void;
  /**
   * S6：显式覆盖白名单（子任务冻结工具集 = 角色请求 ∩ 父会话模式工具集
   * ∩ 已知工具，由 TaskService 冻结后传入）。仅保留已知工具，并剔除
   * task_* 与 app_command（depth=1 子任务防递归/防自我提权）。
   */
  allowedToolsOverride?: readonly string[];
  /** S6：按族名从 runKind 派生白名单中剔除（编排关闭的会话不下发 task_*）。 */
  disableToolFamilies?: readonly string[];
  /**
   * v2 编排（设计 v2 §3.4/§4）：存在即构建新模式。leader 凭据只有
   * V2_LEADER_TOOLS；child 凭据按 AMAGI 身份逐次校验角色/分配/幂等。
   */
  orchestration?: OrchestrationV2Options;
  /**
   * S4（§4.4）：构建 worker 运行上下文。unit 轮受路径认领与 kb_finish 禁用
   * 约束；final 轮（收尾）不受认领限制、调用 kb_finish。
   */
  worker?: BuildWorkerInfo;
}

/** S4：构建进程的 worker 身份（runKind=build 时存在）。 */
export interface BuildWorkerInfo {
  workerId: string;
  unitId: string | null;
  /** 审查后的定向修订轮；禁止通过删除已登记对象文档绕过重申门禁。 */
  revision?: boolean;
  /** T3（A 案 §7.1/§7.2）：plan=规划轮（可 kb_submit_plan）；review=审查轮
   * （可 kb_submit_review，无草稿写入口）；final=收尾轮。 */
  phase: 'unit' | 'final' | 'plan' | 'review';
}

/** T3（A 案 §5.3）：读取回执记录（staging/<buildId>/read-receipts.jsonl 行）。
 * 模型只能引用回执中的范围；证据声明的 readReceiptId 以此登记为准。 */
export interface ReadReceiptRecord {
  readReceiptId: string;
  buildId: string;
  unitId: string | null;
  toolCallId: string;
  /** computeSourceHash 结果（源包一致性） */
  sourceSnapshotHash: string;
  /** 主文档=objToken；CSV 附件=<objToken>#csv:<文件名> */
  resourceId: string;
  /** 资源本地 1 起始闭区间（本次返回窗口交叠部分） */
  selector: { kind: 'read_range'; lineStart: number; lineEnd: number };
  returnedHash: string;
  truncated: boolean;
}

/** T3（A 案 §6.2）：staging/<buildId>/knowledge-draft.json —— server 维护的
 * 对象/呈现/关系/证据/覆盖声明累积文件。正文真相在 docs/*.md，本文件是
 * 声明真相；同 clientKey 重复提交=更新同一身份（跨路径迁移保留 objectId）。 */
export interface KnowledgeDraftFile {
  schemaVersion: number;
  buildId: string;
  /** diting F02/F06：docs[path].basis 声明坐标基准——'draft' = kb_write_doc
   * markdown 参数坐标（bodyLineOffset = 去头后正文行号 − 参数行号）；
   * 'published' = 从基线 release 复制的托管文档（发布坐标直通，编译器
   * 不重注入锚点）。carriedHash = 复制时的 staging 内容哈希（发布前复核
   * 托管文档未被旧式重写，diting F06）。 */
  docs: Record<string, {
    docId: string;
    revision: number;
    bodyLineOffset?: number;
    basis?: 'draft' | 'published';
    carriedHash?: string;
  }>;
  /** clientKey → objectId（构建内稳定；含已提交声明的全部对象） */
  clientKeys: Record<string, string>;
  /** 证据 clientKey → evidenceId */
  evidenceKeys: Record<string, string>;
  objects: KnowledgeObject[];
  presentations: Presentation[];
  relations: KnowledgeRelation[];
  evidence: Evidence[];
  coverage: CoverageItem[];
  /** toolCallId 幂等账本（进程重启后由文件恢复；A 案 §7.1）。payloadHash
   * （F06）：v2 写入链在原子落盘时记录的稳定语义载荷哈希——崩溃重放
   * 命中同键时必须比较（同载荷才重放；旧账本缺哈希不可盲重放）。 */
  calls: Record<string, {
    path: string;
    at: string;
    draftRevision: number;
    docId: string;
    bytes: number;
    objectIdMap: Record<string, string>;
    evidenceIdMap: Record<string, string>;
    payloadHash?: string;
  }>;
}

/** T3（A 案 §7.2）：staging/<buildId>/organization-plan.json —— 组织计划。
 * planId 构建内稳定，planRevision 随每次接受递增；计划改变后旧 planRevision
 * 的写入拒绝（深度调度校验 T2b 接手）。 */
export interface OrganizationPlanFile {
  schemaVersion: number;
  buildId: string;
  planId: string;
  planRevision: number;
  docs: Array<{ path: string; title: string; summary?: string; docId: string }>;
  objects: Array<{
    clientKey: string;
    objectId: string;
    type: string;
    title: string;
    familyKey: string;
    variantKey: string;
    scopeKey: string;
    scopeText: string;
    canonicalPath: string;
  }>;
  dependencies: Array<{ fromObjectId: string; toObjectId: string; reason?: string }>;
  migrations: Array<{ objectId: string; kind: 'merge' | 'split' | 'remove'; successorObjectIds: string[]; reason: string }>;
  updatedAt: string;
}

export interface InternalRunContext extends AgentRunContext {
  options: RunContextOptions;
  /** F01（撤销租约）：revokeToken/revokeBySession/revokeByBuild 置位。
   * contexts 表删除只能拦后续 executeTool，拦不住已持 ctx 引用的在途
   * 调用（声明锁排队/异步证据装配中的写入）——在途链在最终落盘与回执
   * 前检查本租约（assertRunLeaseActive）。null = 未撤销。 */
  revokedAt?: number | null;
  revokedScope?: string | null;
}

/** 单次工具请求的调用侧元数据（内部 API 透传；不进模型可见面）。 */
export interface ToolRequestMeta {
  /** T3b-07R：pi 分配的 toolCallId（轮次归属绑定的权威键）。 */
  toolCallId?: string;
  /** v2（设计 v2 §4.1）：桥接从 env 读到的 AMAGI_TASK_ID（受信身份，
   * 经 X-Amagi-Task-Id 头透传；不采信模型参数）。 */
  amagiTaskId?: string;
  /** v2（§4.1）：AMAGI_AGENT（角色一致性校验）。 */
  amagiAgent?: string;
}

/** F03-R1：单次知识声明的授权影响面——装配期（buildKnowledgeDeclaration
 * 对象段）记录，最终同步提交段重核。声明装配含真实 await 让出（工作簿/
 * 图片证据、资源解引用），期间 Leader 可经 assignOutputs/revokeOutputs
 * 转移族归属或撤回旧主路径授权；装配期快照不足以代表提交时点。 */
export interface DeclarationAuthImpact {
  /** 本次声明涉及的全部对象族——新对象入族、既有对象重申（含编辑继承
   * 重申），以及被本次改写移出旧族/未重申删除对象登记的旧族（R2-F03-01：
   * 移出与删除同样改写该族对象面，装配期已过同一族排他检查）；提交期
   * 要求活动持有人仍为空或本人。 */
  familyKeys: string[];
  /** 跨路径重申/迁移：clientKey/三元组命中的既有对象的主定义登记
   * （装配期已过旧主路径/族授权检查）；提交期要求授权仍有效。 */
  crossPathMigrations: Array<{
    clientKey: string;
    objectId: string;
    priorPath: string;
    familyKey: string;
  }>;
}

/** 工具族内单个工具的注册项（S1 工具族注册模型）。 */
export interface AgentToolFamilyTool {
  /** 工具规格。tool-specs.ts 仍是唯一定义源：族只引用 SPEC 常量，不复制。 */
  spec: AgentToolSpec;
  /** 哪些 runKind 可见本工具（决定 createRunContext 白名单成员）。 */
  runKinds: ReadonlyArray<AgentRunKind>;
  /** 执行器：与重构前 dispatch 分支同一实现，同一错误码与错误消息；meta
   * 为内部 API 透传的调用侧元数据（toolCallId 等，可缺省）。 */
  execute: (
    context: InternalRunContext,
    args: Record<string, unknown>,
    meta?: ToolRequestMeta,
  ) => Promise<ToolResult> | ToolResult;
}
/**
 * 工具族：一族相关工具的注册单元。S1 把散置的白名单/dispatch/规格收敛
 * 为族注册；后续切片（S3 raw_read_image、S6 task_*、S10 app_command）
 * 只 registerToolFamily() 追加新族（或新增族文件后一行登记），不再改
 * executeTool 主体。
 */
export interface AgentToolFamily {
  name: string;
  tools: AgentToolFamilyTool[];
}

export interface SheetCsvPathResolver {
  (objToken: string): string[];
}

/**
 * P1-S4（设计 §2.3/§2.4）：引用图查询面——按 objToken 取出边与入边
 * （LocalMapStore source_references 查询；入边含双键并集）。未注入时
 * raw_read 不追加 <source_links>，raw_links 报 references_unavailable。
 */
export interface SourceLinksProvider {
  (objToken: string): { out: SourceLinkEdgeRow[]; in: IncomingLinkEdgeRow[] };
}

/**
 * P2-S4（设计 §5.1）：raw_comments 只读工具的数据源（index.ts 注入
 * LocalMapStore 的按源查询）。meta 为 null = 从未采集（非 docx 或未同步）。
 */
export interface SourceCommentsProvider {
  (objToken: string): { meta: SourceCommentMetaRow | null; comments: SourceCommentRow[] };
}

/**
 * S3：会话侧图片理解支持（结构化接口，VisionDescriber 天然满足）。
 * raw_read 内联已缓存描述；raw_read_image 按需描述。未注入时会话侧
 * 不做内联、raw_read_image 报 vision_unconfigured。S4 构建侧另需
 * describeMany（preflight 预描述）。
 */
export interface VisionDescriberLike {
  status(): Promise<{ state: 'disabled' | 'ready' | 'invalid'; model: string | null; message: string }>;
  lookup(imageHash: string): Promise<string | null>;
  describeOne(file: string, src: string, signal?: AbortSignal): Promise<ImageDescription>;
  describeMany(items: Array<{ file: string; src: string }>, opts: { signal: AbortSignal; onProgress: (p: { done: number; total: number; described?: number; cached?: number; unavailable?: number }) => void; refreshCached?: boolean }): Promise<Map<string, ImageDescription>>;
}

function publishValidationIssues(result: Record<string, unknown> | null): Array<{ path: string; code: string; message: string }> {
  const details = result?.details;
  const raw = details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>).issues : null;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).filter((item): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item)).map((item) => ({
      path: typeof item.path === 'string' ? item.path : '',
      code: typeof item.code === 'string' ? item.code : 'unknown',
      message: typeof item.message === 'string' ? item.message : '',
    }));
}

export class AgentToolService {
  private readonly contexts = new Map<string, InternalRunContext>();
  private readonly stores = new Map<string, StandardKbStore>();
  private readonly sheetCsvPaths: SheetCsvPathResolver;
  private readonly documentsProvider: () => DocumentRecord[];
  private readonly dataRoot: string;
  /** F3-R02：Workspace 动态守卫（当前配置快照）；未注入时不做动态复核 */
  private readonly workspaceGuard?: (workspaceRoot: string) => { ok: true } | { ok: false; code: string; message: string };
  /** S3：会话侧图片理解（raw_read 内联已缓存描述 + raw_read_image 按需描述） */
  private readonly visionDescriber?: VisionDescriberLike;
  /** P1-S4：引用图查询（raw_read 末页追加 + raw_links 工具） */
  private readonly sourceLinksProvider?: SourceLinksProvider;
  /** P2-S4：评论溯源查询（raw_comments 工具，仅 Discuss/Work） */
  private readonly commentsProvider?: SourceCommentsProvider;
  /** S1 工具族注册表：族名 → 族定义；工具名 → 族内工具项（注册序）。 */
  private readonly toolFamilies = new Map<string, AgentToolFamily>();
  private readonly familyTools = new Map<string, AgentToolFamilyTool>();

  constructor(input: {
    dataRoot: string;
    documentsProvider: () => DocumentRecord[];
    sheetCsvPaths?: SheetCsvPathResolver;
    workspaceGuard?: (workspaceRoot: string) => { ok: true } | { ok: false; code: string; message: string };
    visionDescriber?: VisionDescriberLike;
    sourceLinks?: SourceLinksProvider;
    comments?: SourceCommentsProvider;
  }) {
    this.dataRoot = input.dataRoot;
    this.documentsProvider = input.documentsProvider;
    this.sheetCsvPaths = input.sheetCsvPaths ?? (() => []);
    this.workspaceGuard = input.workspaceGuard;
    this.visionDescriber = input.visionDescriber;
    this.sourceLinksProvider = input.sourceLinks;
    this.commentsProvider = input.comments;
    this.registerBuiltinFamilies();
  }

  /**
   * S1 工具族注册：登记一族工具的「规格 + runKind 白名单成员 + 执行器」。
   * 白名单成员与 dispatch 全部由此派生；重复族名/重复工具名直接抛错
   * （注册期错误 fail fast）。
   */
  registerToolFamily(family: AgentToolFamily): void {
    if (this.toolFamilies.has(family.name)) {
      throw new Error(`工具族已注册: ${family.name}`);
    }
    const duplicate = family.tools.find((tool) => this.familyTools.has(tool.spec.name));
    if (duplicate) {
      throw new Error(`工具已注册于其他工具族: ${duplicate.spec.name}`);
    }
    this.toolFamilies.set(family.name, family);
    for (const tool of family.tools) {
      this.familyTools.set(tool.spec.name, tool);
    }
  }

  /** 已注册工具族名（注册序；供诊断与测试）。 */
  registeredFamilies(): string[] {
    return [...this.toolFamilies.keys()];
  }

  /**
   * 从工具族注册表推导 runKind 白名单：成员 = 各族工具 runKinds 命中集；
   * 顺序 = 基线 toolsForRunKind 冻结顺序在前（既有行为逐字不变），新增
   * 族工具按注册顺序追加其后。
   */
  private allowedToolsForRunKind(runKind: AgentRunKind): string[] {
    const members = new Set<string>();
    for (const tool of this.familyTools.values()) {
      if (tool.runKinds.includes(runKind)) members.add(tool.spec.name);
    }
    const ordered: string[] = [];
    for (const name of toolsForRunKind(runKind)) {
      if (members.delete(name)) ordered.push(name);
    }
    for (const name of members) ordered.push(name);
    return ordered;
  }

  /**
   * 内置四族（raw/kb/draft/ws）——执行器与重构前 dispatch 分支一一对应
   * （同一方法、同一错误码与消息），仅搬运注册位置，不改语义。
   * 后续切片新增族：新建 tools/<name>-family.ts 导出 AgentToolFamily，
   * 再在本方法末尾追加一行 registerToolFamily。
   */
  private registerBuiltinFamilies(): void {
    // raw_*：原始库（build 态走快照校验；discuss/work 态直读）
    this.registerToolFamily({
      name: 'raw',
      tools: [
        { spec: RAW_LIST_SPEC, runKinds: ['build'], execute: (context, args) => this.toolRawList(context, args) },
        // T3（A 案 §5.3）：raw_read build 态返回 segmentMap/资源表并登记读取回执
        { spec: RAW_READ_SPEC, runKinds: ['build', 'work', 'discuss'], execute: (context, args, meta) => this.toolRawRead(context, args, meta) },
        { spec: RAW_CSV_CELLS_SPEC, runKinds: ['build'], execute: (context, args, meta) => this.toolRawCsvCells(context, args, meta) },
        { spec: RAW_CSV_FIND_SPEC, runKinds: ['build'], execute: (context, args, meta) => this.toolRawCsvFind(context, args, meta) },
        { spec: RAW_SEARCH_SPEC, runKinds: ['build', 'work', 'discuss'], execute: (context, args) => this.toolRawSearch(context, args) },
        // P1-S4（§2.4）：引用关系查询（只读），Discuss/Work/构建均可用
        { spec: RAW_LINKS_SPEC, runKinds: ['build', 'work', 'discuss'], execute: (context, args) => this.toolRawLinks(context, args) },
        // S3（§3.5）：会话侧按需识图（build 不下发——构建链在 preflight 预描述）
        { spec: RAW_READ_IMAGE_SPEC, runKinds: ['work', 'discuss'], execute: (context, args) => this.toolRawReadImage(context, args) },
        // P2-S4（§5.1）：评论溯源只读查询——只进 Discuss/Work，不进构建
        // 工具集（不变量 1：评论不在文件哈希围栏内，不进构建输入）。
        { spec: RAW_COMMENTS_SPEC, runKinds: ['work', 'discuss'], execute: (_context, args) => this.toolRawComments(args) },
      ],
    });
    // kb_*：标准库读（work/discuss）+ 构建草稿写（build）
    this.registerToolFamily({
      name: 'kb',
      tools: [
        { spec: KB_SEARCH_SPEC, runKinds: ['work', 'discuss'], execute: (context, args) => this.toolKbSearch(context, args) },
        { spec: KB_READ_SPEC, runKinds: ['work', 'discuss'], execute: (context, args) => this.toolKbRead(context, args) },
        { spec: KB_GREP_SPEC, runKinds: ['work', 'discuss'], execute: (context, args) => this.toolKbGrep(context, args) },
        { spec: KB_WRITE_DOC_SPEC, runKinds: ['build'], execute: (context, args, meta) => this.toolKbWriteDoc(context, args, meta) },
        { spec: KB_DELETE_DOC_SPEC, runKinds: ['build'], execute: (context, args, meta) => this.toolKbDeleteDoc(context, args, meta) },
        // S4（§4.4）：逐单元上报；kb_finish 保持单值、只在收尾轮可用
        { spec: KB_UNIT_DONE_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbUnitDone(context, args) },
        { spec: KB_FINISH_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbFinish(context, args) },
        // T3（A 案 §7.1/§7.2）：知识协议工具——计划提交（phase 门禁在执行器内）、
        // 计划只读、审查提交（审查轮；写入者无审查入口，审查者无草稿写入口）
        { spec: KB_SUBMIT_PLAN_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbSubmitPlan(context, args) },
        { spec: KB_GET_PLAN_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbGetPlan(context, args) },
        { spec: KB_SUBMIT_REVIEW_SPEC, runKinds: ['build'], execute: (context, args, meta) => this.toolKbSubmitReview(context, args, meta) },
      ],
    });
    // draft_*：构建 staging 读
    this.registerToolFamily({
      name: 'draft',
      tools: [
        { spec: DRAFT_LIST_SPEC, runKinds: ['build'], execute: (context) => this.toolDraftList(context) },
        { spec: DRAFT_READ_SPEC, runKinds: ['build'], execute: (context, args) => this.toolDraftRead(context, args) },
        { spec: DRAFT_SEARCH_SPEC, runKinds: ['build'], execute: (context, args) => this.toolDraftSearch(context, args) },
      ],
    });
    // ws_*：Workspace 文件工具（work）
    this.registerToolFamily({
      name: 'ws',
      tools: [
        { spec: WS_LS_SPEC, runKinds: ['work'], execute: (context, args) => this.toolWsLs(context, args) },
        { spec: WS_READ_SPEC, runKinds: ['work'], execute: (context, args) => this.toolWsRead(context, args) },
        { spec: WS_SEARCH_SPEC, runKinds: ['work'], execute: (context, args) => this.toolWsSearch(context, args) },
        { spec: WS_WRITE_SPEC, runKinds: ['work'], execute: (context, args) => this.toolWsWrite(context, args) },
        { spec: WS_EDIT_SPEC, runKinds: ['work'], execute: (context, args) => this.toolWsEdit(context, args) },
        { spec: WS_MKDIR_SPEC, runKinds: ['work'], execute: (context, args) => this.toolWsMkdir(context, args) },
      ],
    });
    // build-runtime：v2 编排工具（设计 v2 §3.4/§4/§5/§7）。不进任何旧
    // runKind 基线面（runKinds 空数组）——仅经 allowedToolsOverride/leader
    // 白名单显式下发；旧模式行为不变。
    this.registerToolFamily({
      name: 'build-runtime',
      tools: [
        { spec: KB_READ_BATCH_SPEC, runKinds: ['build'], execute: (context, args, meta) => this.toolKbReadBatch(context, args, meta) },
        { spec: KB_EDIT_DOC_SPEC, runKinds: [], execute: (context, args, meta) => this.toolKbEditDoc(context, args, meta) },
        { spec: KB_TOOL_SCHEMA_SPEC, runKinds: [], execute: (context, args, meta) => this.toolKbToolSchema(context, args, meta) },
        { spec: BUILD_MANIFEST_SPEC, runKinds: [], execute: (context, args) => this.toolBuildManifest(context, args) },
        { spec: BUILD_ASSIGN_OUTPUT_SPEC, runKinds: [], execute: (context, args) => this.toolBuildAssignOutput(context, args) },
        { spec: BUILD_REVOKE_OUTPUT_SPEC, runKinds: [], execute: (context, args) => this.toolBuildRevokeOutput(context, args) },
        { spec: BUILD_HANDOFF_SUBMIT_SPEC, runKinds: [], execute: (context, args, meta) => this.toolBuildHandoffSubmit(context, args, meta) },
        { spec: BUILD_HANDOFF_LIST_SPEC, runKinds: [], execute: (context, args) => this.toolBuildHandoffList(context, args) },
        { spec: BUILD_ISSUES_SUBMIT_SPEC, runKinds: [], execute: (context, args) => this.toolBuildIssuesSubmit(context, args) },
        { spec: BUILD_ISSUES_LIST_SPEC, runKinds: [], execute: (context, args) => this.toolBuildIssuesList(context, args) },
        { spec: BUILD_CHECKPOINT_SPEC, runKinds: [], execute: (context, args) => this.toolBuildCheckpoint(context, args) },
        { spec: BUILD_REQUEST_PUBLISH_SPEC, runKinds: [], execute: (context, args) => this.toolBuildRequestPublish(context, args) },
      ],
    });
  }

  private storeFor(outputRoot: string): StandardKbStore {
    let store = this.stores.get(outputRoot);
    if (!store) {
      store = new StandardKbStore(outputRoot);
      this.stores.set(outputRoot, store);
    }
    return store;
  }

  /** 已注册工具名（注册序；S6 工具交集计算的「已知工具」面）。 */
  registeredToolNames(): string[] {
    return [...this.familyTools.keys()];
  }

  /**
   * 白名单推导（S6 扩展）：基线 = 族注册表按 runKind 派生；
   * disableToolFamilies → 按族剔除；allowedToolsOverride → 显式覆盖
   * （仅已知工具，且永不含 task_* 与 app_command——子任务 depth=1 防御）。
   */
  private computeAllowedTools(options: RunContextOptions): string[] {
    let allowed = this.allowedToolsForRunKind(options.runKind);
    if (options.disableToolFamilies && options.disableToolFamilies.length > 0) {
      const excluded = new Set<string>();
      for (const familyName of options.disableToolFamilies) {
        for (const tool of this.toolFamilies.get(familyName)?.tools ?? []) excluded.add(tool.spec.name);
      }
      allowed = allowed.filter((name) => !excluded.has(name));
    }
    if (options.allowedToolsOverride) {
      const childBanned = new Set<string>(['app_command']);
      for (const tool of this.toolFamilies.get(TASK_TOOL_FAMILY_NAME)?.tools ?? []) childBanned.add(tool.spec.name);
      const known = new Set(this.familyTools.keys());
      allowed = [...new Set(options.allowedToolsOverride)].filter((name) => known.has(name) && !childBanned.has(name));
    }
    return allowed;
  }

  /** 创建运行上下文（发新令牌）。进程每次启动调用一次。 */
  createRunContext(options: RunContextOptions): { token: string; context: AgentRunContext } {
    const token = crypto.randomBytes(32).toString('base64url');
    const allowedTools = this.computeAllowedTools(options);
    const context: InternalRunContext = {
      runKind: options.runKind,
      sessionId: options.sessionId,
      buildId: options.buildId,
      workspaceRoot: options.workspaceRoot,
      allowedTools,
      createdAt: Date.now(),
      revokedAt: null,
      revokedScope: null,
      options,
    };
    this.contexts.set(token, context);
    return { token, context };
  }

  /** 撤销令牌（模式切换 / 进程退出 / 取消）。
   * F01：除从 contexts 表删除（拦新调用）外，同步标记撤销租约——已持
   * ctx 的在途写入（锁排队/异步准备中）在最终落盘前被拒，不能落盘或
   * 登记新回执。 */
  revokeToken(token: string): void {
    const context = this.contexts.get(token);
    if (context && context.revokedAt == null) {
      context.revokedAt = Date.now();
      context.revokedScope = 'token';
    }
    this.contexts.delete(token);
  }

  /** 按会话撤销（模式切换 / 会话删除时）。F01：同 revokeToken 标记租约。 */
  revokeBySession(sessionId: string): void {
    for (const [token, context] of this.contexts) {
      if (context.sessionId === sessionId) {
        if (context.revokedAt == null) {
          context.revokedAt = Date.now();
          context.revokedScope = 'session';
        }
        this.contexts.delete(token);
      }
    }
  }

  /** 按构建撤销（构建取消/收尾）。F01：同 revokeToken 标记租约。 */
  revokeByBuild(buildId: string): void {
    for (const [token, context] of this.contexts) {
      if (context.buildId === buildId) {
        if (context.revokedAt == null) {
          context.revokedAt = Date.now();
          context.revokedScope = 'build';
        }
        this.contexts.delete(token);
      }
    }
  }

  getContext(token: string): AgentRunContext | null {
    return this.contexts.get(token) ?? null;
  }

  /** F01：在途调用撤销租约终检——声明锁排队/异步证据装配窗口内令牌被
   * 撤销（生产 requestCancel → revokeSessionTokens 等）时，最终落盘与
   * 回执登记前拒绝；文件、revision 与回执账本保持不变。 */
  private assertRunLeaseActive(context: InternalRunContext): void {
    if (context.revokedAt != null) {
      throw new ToolError(
        'run_token_revoked',
        `运行令牌已撤销（scope=${context.revokedScope ?? 'token'}，撤销于 ${new Date(context.revokedAt).toISOString()}），在途写入终止`,
        401,
      );
    }
  }

  /** F06：calls 幂等账本崩溃重放核验——稳定键命中后必须比较语义载荷哈希：
   * 异载荷报幂等冲突（同键不可假成功）；本修复前写入的旧账本缺哈希，
   * 无法核验同载荷 → 明确拒绝并指引修复路径（原操作已落盘，结果以
   * knowledge-draft/docs 为准；换新 operationId 重提）。payloadHash
   * 未提供（非 v2 调用侧键重试）时保持旧语义直接重放。 */
  private verifyCallsLedgerPayload(entry: { payloadHash?: string; at: string }, operationLabel: string, payloadHash: string | undefined): void {
    if (payloadHash === undefined) return;
    if (entry.payloadHash === undefined) {
      throw new ToolError(
        'kb_idempotency_unverifiable',
        `操作 ${operationLabel} 的旧幂等账本缺少载荷哈希（旧代次写入），无法核验同载荷重放；请更换 operationId 重提（原操作已落盘，结果以 knowledge-draft/docs 为准）`,
        409,
      );
    }
    if (entry.payloadHash !== payloadHash) {
      throw new ToolError(
        'kb_idempotency_conflict',
        `operationId 已用于不同载荷（calls 账本核验，首次提交 ${entry.at}）；换一个 operationId`,
        409,
      );
    }
  }

  /** F11 补强：run context 是否仍有效（引用比对 + revokedAt 标记双检；
   * revokeToken 从 Map 删除即失效；若撤租改为标记 revokedAt（27/b18 方向），
   * 同样拒绝。不暴露 token，不落盘。） */
  private isContextLive(context: InternalRunContext): boolean {
    if (context.revokedAt != null) return false;
    for (const live of this.contexts.values()) {
      if (live === context) return true;
    }
    return false;
  }

  /**
   * v2（设计 v2 §4.1/§3.4）：只读工具名单（MCP readOnlyHint 与 pending
   * 只读面共用）。旧读取类工具按工具名判定，不含任何正文/对象写工具。
   */
  isReadOnlyTool(toolName: string): boolean {
    return READONLY_TOOL_NAMES.has(toolName);
  }

  /**
   * v2（§4.1）：按调用身份解析子任务工具面。无 orchestration 时行为不变。
   * identity 来自内部 API 身份头（受信 env）；pending/未知 → 只读子集。
   */
  private v2ToolNamesFor(context: InternalRunContext, identity?: { amagiTaskId?: string; amagiAgent?: string }): string[] {
    const v2 = context.options.orchestration!;
    if (v2.credential === 'leader') {
      return context.allowedTools.filter((name) => (V2_LEADER_TOOLS as readonly string[]).includes(name));
    }
    if (identity?.amagiTaskId) {
      const actor = v2.actorStore.lookupActor(identity.amagiTaskId)
        ?? v2.actorStore.ensurePendingIdentity(identity.amagiTaskId, identity.amagiAgent);
      if (actor.status === 'revoked') return V2_CHILD_READ_TOOLS.filter((name) => context.allowedTools.includes(name));
      const toolset = actor.status === 'confirmed'
        ? v2.actorStore.roleToolset(actor.role)
        : null;
      const names = toolset ? toolset.tools : V2_CHILD_READ_TOOLS;
      return names.filter((name) => context.allowedTools.includes(name));
    }
    // 无身份头：v2 子任务凭据必须有受信身份——清单不下发任何工具面
    // （与 executeTool 的 amagi_task_missing 拒绝语义一致，防误配泄露）。
    return [];
  }

  /** GET /tools：返回本运行允许的工具规格（族注册表派生，顺序同白名单）。
   * v2：按身份头解析角色后下发子集（§4.1 桥接调用先于创建事件 → 只读）。 */
  getToolSpecsForToken(token: string, identity?: { amagiTaskId?: string; amagiAgent?: string }): AgentToolSpec[] | null {
    const context = this.contexts.get(token);
    if (!context) return null;
    const names = context.options.orchestration
      ? this.v2ToolNamesFor(context, identity)
      : context.allowedTools;
    return names
      .map((name) => this.familyTools.get(name)?.spec)
      .filter((spec): spec is AgentToolSpec => Boolean(spec));
  }

  private toolKbToolSchema(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): ToolResult {
    const name = typeof args.name === 'string' ? args.name : '';
    const allowed = context.options.orchestration
      ? this.v2ToolNamesFor(context, { amagiTaskId: meta?.amagiTaskId, amagiAgent: meta?.amagiAgent })
      : context.allowedTools;
    if (!allowed.includes(name)) throw new ToolError('tool_not_allowed', `工具 ${name} 不在当前角色工具面`, 403);
    const spec = this.familyTools.get(name)?.spec;
    if (!spec) throw new ToolError('tool_not_allowed', `未知工具: ${name}`, 403);
    return { content: [{ type: 'text', text: JSON.stringify(spec) }] };
  }

  /** POST /tools/:name 执行入口（meta：内部 API 透传的调用侧元数据）。 */
  async executeTool(
    token: string,
    toolName: string,
    args: Record<string, unknown>,
    meta?: ToolRequestMeta,
  ): Promise<ToolResult> {
    const context = this.contexts.get(token);
    if (!context) {
      throw new ToolError('run_token_invalid', '运行令牌无效或已过期', 401);
    }
    if (!context.allowedTools.includes(toolName)) {
      throw new ToolError('tool_not_allowed', `工具 ${toolName} 不在本运行的工具白名单内（runKind=${context.runKind}）`, 403);
    }
    const tool = this.familyTools.get(toolName);
    if (!tool || typeof tool.execute !== 'function') {
      throw new ToolError('tool_not_allowed', `未知工具: ${toolName}`, 403);
    }
    // v2（设计 v2 §4）：凭据代次→身份→角色→读写级的统一前置门；
    // 写入工具的分配/幂等在各自执行器内完成（§4.4 受控写入链）。
    if (context.options.orchestration) {
      this.assertV2Access(context, toolName, meta);
    }
    const argsSummary = summarizeArgs(toolName, args);
    context.options.onEvent?.({ phase: 'start', toolName, ...(meta?.toolCallId ? { toolCallId: meta.toolCallId } : {}), argsSummary });
    try {
      const result = await tool.execute(context, args, meta);
      if (['kb_write_doc', 'kb_delete_doc', 'kb_unit_done', 'kb_finish', 'kb_submit_plan', 'kb_submit_review'].includes(toolName)) context.options.buildState?.onCheckpoint?.();
      const resultSummary = summarizeResult(result);
      context.options.onEvent?.({ phase: 'end', toolName, ...(meta?.toolCallId ? { toolCallId: meta.toolCallId } : {}), argsSummary, resultSummary, isError: false });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.options.onEvent?.({
        phase: 'end',
        toolName,
        ...(meta?.toolCallId ? { toolCallId: meta.toolCallId } : {}),
        argsSummary,
        resultSummary: message.slice(0, 300),
        isError: true,
      });
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // kb_*（读已发布标准库）
  // ------------------------------------------------------------------

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof QueryError)) throw error;
      const status = ['kb_not_published', 'kb_not_found', 'kb_release_unavailable', 'kb_section_not_found'].includes(error.code) ? 404
        : ['kb_index_failed', 'kb_integrity_error'].includes(error.code) ? 500 : 400;
      throw new ToolError(error.code, error.message, status);
    }
  }

  private async toolKbSearch(context: InternalRunContext, args: Record<string, unknown>): Promise<ToolResult> {
    const query = requireString(args, 'query', 1, 200);
    const limit = optionalInt(args, 'limit', 20, 1, 30);
    const cursor = args.cursor === undefined ? undefined : requireString(args, 'cursor', 1, 2048);
    const store = this.storeFor(context.options.outputRoot);
    const manifest = store.readManifest();
    if (!manifest && !cursor) {
      throw new ToolError('kb_not_published', '标准知识库尚未发布，无法搜索', 404);
    }
    const page = await this.query(() => getKbQueryService(context.options.outputRoot).search({
      query, limit, cursor, releaseId: cursor ? undefined : manifest!.releaseId,
      ...(args.pathPrefix !== undefined ? { pathPrefix: requireString(args, 'pathPrefix', 0, 4096) } : {}),
      // A案 §8.1：对象感知参数透传共用查询层校验/过滤，不在此另写过滤器
      ...(args.usage !== undefined ? { usage: requireString(args, 'usage', 1, 20) as 'browse' | 'operational' } : {}),
      ...(args.types !== undefined ? { types: args.types as unknown as KnowledgeObjectType[] } : {}),
      ...(args.domainIds !== undefined ? { domainIds: args.domainIds as string[] } : {}),
      ...(args.businessStatuses !== undefined ? { businessStatuses: args.businessStatuses as unknown as BusinessStatus[] } : {}),
      ...(args.reviewStatuses !== undefined ? { reviewStatuses: args.reviewStatuses as unknown as ReviewStatus[] } : {}),
      // D5（A案 §6.1）：asOf 透传共用查询层校验/判定（对象感知模式下生效，
      // 关系 validFrom/validUntil 与 timeUnknown 标注）；不传时行为不变
      ...(args.asOf !== undefined ? { asOf: requireString(args, 'asOf', 1, 40) } : {}),
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify(page) }],
    };
  }

  private async toolKbGrep(context: InternalRunContext, args: Record<string, unknown>): Promise<ToolResult> {
    // This handler shares Electron's event loop; JS regex has no interruptible timeout.
    // Only isolated MCP processes may execute regex (LAN adds the parent watchdog).
    if (args.mode !== undefined && args.mode !== 'literal') {
      throw new ToolError('invalid_request', '应用内 kb_grep 仅支持 literal；正则请使用独立只读 MCP');
    }
    const page = await this.query(() => getKbQueryService(context.options.outputRoot).grep({
      pattern: requireString(args, 'pattern', 1, 200),
      ...(args.pathPrefix !== undefined ? { pathPrefix: requireString(args, 'pathPrefix', 0, 4096) } : {}),
      ...(args.cursor !== undefined ? { cursor: requireString(args, 'cursor', 1, 2048) } : {}),
      mode: 'literal',
      ...(args.caseSensitive !== undefined ? { caseSensitive: args.caseSensitive as boolean } : {}),
      context: optionalInt(args, 'context', 0, 0, 3), maxMatches: optionalInt(args, 'maxMatches', 100, 1, 500),
    }));
    return { content: [{ type: 'text', text: JSON.stringify(page) }] };
  }

  private async toolKbRead(context: InternalRunContext, args: Record<string, unknown>): Promise<ToolResult> {
    const docId = typeof args.docId === 'string' && args.docId ? args.docId : undefined;
    const docPath = typeof args.path === 'string' && args.path ? args.path : undefined;
    if (Number(Boolean(docId)) + Number(Boolean(docPath)) !== 1) {
      throw new ToolError('invalid_request', 'docId 与 path 必须二选一');
    }
    const offset = optionalInt(args, 'offset', 0, 0, 10_000_000);
    const limit = optionalInt(args, 'limit', 800, 1, 2000);
    const store = this.storeFor(context.options.outputRoot);
    const manifest = store.readManifest();
    if (!manifest) {
      throw new ToolError('kb_not_published', '标准知识库尚未发布', 404);
    }
    const doc = store.findDoc(manifest, { docId, path: docPath === undefined ? undefined : splitAnchor(docPath, manifest.docs.map((entry) => entry.path)).path });
    if (!doc) {
      throw new ToolError('kb_doc_not_found', `标准文档不存在: ${docId ?? docPath}`, 404);
    }
    const page = await this.query(() => getKbQueryService(context.options.outputRoot).read({
      docId, path: docPath, releaseId: manifest.releaseId, startLine: offset + 1, maxLines: limit, includeSources: false,
      ...(args.section !== undefined ? { section: requireString(args, 'section', 1, 4096) } : {}),
    }));
    const totalLines = Number(/lines="\d+-\d+\/(\d+)"/.exec(page.text)?.[1] ?? 0);
    return {
      content: [{
        type: 'text',
        text: page.text,
      }],
      details: {
        docId: doc.docId,
        path: doc.path,
        title: doc.title,
        summary: doc.summary,
        tags: doc.tags,
        sources: doc.sources,
        releaseId: page.releaseId,
        offset,
        returnedLines: page.endLine - page.startLine + 1,
        totalLines,
        nextOffset: page.next === null ? null : page.next - 1,
      },
    };
  }

  // ------------------------------------------------------------------
  // raw_*（读原始库；build 态走快照校验，discuss/work 态直读）
  // ------------------------------------------------------------------

  private rawEntriesForDiscuss(context: InternalRunContext): RawSourceSnapshotEntry[] {
    const documents = this.documentsProvider();
    const root = context.options.knowledgeBaseRoot;
    if (!root) return [];
    const result: RawSourceSnapshotEntry[] = [];
    for (const record of collectSourceCandidates(documents)) {
      const target = path.join(root, record.localRelPath!);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      result.push({
        objToken: record.objToken,
        objType: record.objType,
        title: record.title || record.localRelPath!,
        relPath: record.localRelPath!,
        contentHash: '',
        objEditTime: record.observedObjEditTime != null ? String(record.observedObjEditTime) : null,
      });
    }
    return result;
  }

  private toolRawSearch(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const query = requireString(args, 'query', 1, 200);
    const limit = optionalInt(args, 'limit', 20, 1, 20);
    const units = parseSearchQuery(query);
    if (!units.length) return { content: [{ type: 'text', text: JSON.stringify({ results: [] }, null, 2) }] };
    const entries = context.options.buildState
      ? context.options.buildState.snapshot.entries
      : this.rawEntriesForDiscuss(context);
    const hits: Array<{ result: Record<string, unknown>; score: number; relPath: string }> = [];
    for (const entry of entries) {
      let content = '';
      try {
        content = this.readRawContent(context, entry.objToken);
      } catch {
        /* 读取失败只降权；readRawContent 仍负责构建快照毒化标记。 */
      }
      const { score, snippet } = scoreRawText(entry.title, entry.relPath, content, units);
      if (score > 0) {
        hits.push({
          score,
          relPath: entry.relPath,
          result: {
            objToken: entry.objToken,
            title: entry.title,
            relPath: entry.relPath,
            ...(snippet ? { snippet } : {}),
          },
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    const results = hits.slice(0, limit).map((hit) => hit.result);
    return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
  }

  private readRawContent(context: InternalRunContext, objToken: string): string {
    if (context.options.buildState) {
      const state = context.options.buildState;
      let verified;
      try {
        verified = state.snapshot.readVerified(state.knowledgeBaseRoot, objToken);
      } catch (error) {
        // F3-R08：源在构建期间被改是不可恢复失败——毒化整个构建，模型
        // 不得用 skip/finish 绕过；batch 循环与发布前都会检查此标记。
        if (error instanceof PathGuardError && error.code === 'source_changed_during_build') {
          state.poisoned = { code: error.code, message: error.message };
        }
        throw error;
      }
      let content = verified.content;
      for (const attachment of verified.attachments) {
        content += `\n\n<!-- 附件 ${path.basename(attachment.path)} -->\n${attachment.content}`;
      }
      return content;
    }
    // discuss/work：直读（无快照），仍走围栏
    const documents = this.documentsProvider();
    const record = documents.find((doc) => doc.objToken === objToken);
    if (!record || !record.localRelPath || !collectSourceCandidates([record]).length) {
      throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    }
    const root = context.options.knowledgeBaseRoot;
    const target = resolveInside(root, record.localRelPath, 'read');
    let content = fs.readFileSync(target, 'utf-8');
    for (const csv of this.sheetCsvPaths(objToken)) {
      try {
        content += `\n\n<!-- 附件 ${path.basename(csv)} -->\n${fs.readFileSync(csv, 'utf-8')}`;
      } catch {
        /* 缺失跳过 */
      }
    }
    return content;
  }

  private async toolRawRead(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): Promise<ToolResult> {
    const objToken = requireString(args, 'objToken', 1, 256);
    const offset = optionalInt(args, 'offset', 0, 0, 10_000_000);
    const limit = optionalInt(args, 'limit', 800, 1, 2000);
    if (args.includeBlankCsvRows !== undefined && typeof args.includeBlankCsvRows !== 'boolean') {
      throw new ToolError('invalid_request', 'includeBlankCsvRows 必须是布尔值');
    }
    const entry = context.options.buildState
      ? context.options.buildState.snapshot.get(objToken)
      : this.rawEntriesForDiscuss(context).find((candidate) => candidate.objToken === objToken) ?? null;
    if (!entry) {
      throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    }
    let lines: string[];
    let readTrail: {
      receipts: Array<{ readReceiptId: string; resourceId: string; lineStart: number; lineEnd: number }>;
      resources: Array<{ resourceId: string; kind: 'text' | 'csv'; label: string; resourceHash: string; totalLines: number; nonEmptyCells?: number }>;
      imageResources: Array<{ resourceId: string; imageHash: string; derivedFrom: string }>;
      segmentMap: Array<Record<string, unknown>>;
    } | null = null;
    if (context.options.buildState) {
      // T3（A 案 §5.3）：build 态逐资源装配 + segmentMap/读取回执。
      // 会话态（discuss/work）保持原行为，不产生回执。
      const assembled = this.assembleBuildRead(context.options.buildState, entry);
      lines = assembled.lines;
      const slice = lines.slice(offset, offset + limit);
      const winStart = offset + 1;
      const winEnd = offset + slice.length;
      const truncated = winEnd < lines.length;
      const segmentMap: Array<Record<string, unknown>> = [];
      const receipts: ReadReceiptRecord[] = [];
      const resourceById = new Map(assembled.resources.map((resource) => [resource.resourceId, resource]));
      for (const segment of assembled.segments) {
        if (segment.outEnd < winStart || segment.outStart > winEnd) continue;
        const clippedStart = Math.max(segment.outStart, winStart);
        const clippedEnd = Math.min(segment.outEnd, winEnd);
        if (segment.resourceId) {
          const resource = resourceById.get(segment.resourceId)!;
          const resStart = segment.resStart! + (clippedStart - segment.outStart);
          const resEnd = segment.resStart! + (clippedEnd - segment.outStart);
          const returnedText = resource.lines.slice(resStart - 1, resEnd).join('\n');
          const readReceiptId = `rr_${crypto.randomBytes(9).toString('hex')}`;
          receipts.push({
            readReceiptId,
            buildId: context.buildId ?? 'unknown',
            unitId: context.options.worker?.unitId ?? null,
            toolCallId: meta?.toolCallId ?? 'unknown',
            sourceSnapshotHash: entry.contentHash,
            resourceId: segment.resourceId,
            selector: { kind: 'read_range', lineStart: resStart, lineEnd: resEnd },
            returnedHash: contentResourceHash(returnedText),
            truncated,
          });
          segmentMap.push({
            resourceId: segment.resourceId,
            outStart: clippedStart,
            outEnd: clippedEnd,
            resStart,
            resEnd,
          });
        } else {
          segmentMap.push({
            derived: segment.derived ?? 'derived',
            outStart: clippedStart,
            outEnd: clippedEnd,
          });
        }
      }
      this.appendReadReceipts(context.options.buildState, receipts);
      readTrail = {
        receipts: receipts.map((receipt) => ({
          readReceiptId: receipt.readReceiptId,
          resourceId: receipt.resourceId,
          lineStart: receipt.selector.lineStart,
          lineEnd: receipt.selector.lineEnd,
        })),
        resources: assembled.resources.map(({ resourceId, kind, label, resourceHash, lines: resourceLines, nonEmptyCells }) => ({
          resourceId, kind, label, resourceHash, totalLines: resourceLines.length,
          ...(nonEmptyCells !== undefined ? { nonEmptyCells } : {}),
        })),
        imageResources: assembled.imageResources
          .filter((resource) => slice.some((line) => line.includes(resource.src)))
          .map(({ resourceId, imageHash, derivedFrom }) => ({ resourceId, imageHash, derivedFrom })),
        segmentMap,
      };
      const displayLines = annotateRawReadPage(
        slice, offset, assembled.segments, assembled.resources, args.includeBlankCsvRows === true,
      );
      const continuation = args.includeBlankCsvRows === true
        ? { nextOffset: truncated ? offset + slice.length : null, skipped: null }
        : skipBlankCsvContinuation(offset + slice.length, lines.length, assembled.segments, assembled.resources);
      return this.renderRawReadPage(context, entry, lines, slice, offset, readTrail, truncated, displayLines, continuation);
    }
    // S3（§3.5）：会话态原路径（无回执、无 segmentMap）
    const content = await this.inlineSessionImageDescriptions(
      context,
      entry,
      this.readRawContent(context, objToken),
    );
    lines = content.split('\n');
    const slice = lines.slice(offset, offset + limit);
    return this.renderRawReadPage(context, entry, lines, slice, offset, null, false);
  }

  /** Read exact parsed CSV cells without asking a model to count delimiters.
   * The returned sparse row contains every nonempty field; missing columns are
   * empty, and the receipt covers the complete physical records shown. */
  private toolRawCsvCells(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): ToolResult {
    const state = requireBuildState(context);
    const objToken = requireString(args, 'objToken', 1, 256);
    const resourceId = requireString(args, 'resourceId', 1, 512);
    if (args.recordStart === undefined || args.recordEnd === undefined) {
      throw new ToolError('invalid_request', 'recordStart 和 recordEnd 均为必填');
    }
    const recordStart = optionalInt(args, 'recordStart', 1, 1, 10_000_000);
    const recordEnd = optionalInt(args, 'recordEnd', recordStart, 1, 10_000_000);
    if (recordEnd < recordStart || recordEnd - recordStart >= 20) {
      throw new ToolError('invalid_request', 'recordStart..recordEnd 须为最多 20 条的闭区间');
    }
    const entry = state.snapshot.get(objToken);
    if (!entry) throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    const assembled = this.assembleBuildRead(state, entry);
    const resource = assembled.resources.find((item) => item.resourceId === resourceId && item.kind === 'csv');
    if (!resource) throw new ToolError('not_found', `冻结源没有该 CSV 资源: ${resourceId}`, 404);
    const parsed = parseCsvRecords(resource.lines.join('\n'));
    if (recordEnd > parsed.records.length) {
      throw new ToolError('invalid_request', `CSV 共 ${parsed.records.length} 条逻辑 record，结束位置 ${recordEnd} 越界`);
    }
    const columnName = (index: number): string => {
      let n = index + 1;
      let name = '';
      while (n > 0) { n -= 1; name = String.fromCharCode(65 + n % 26) + name; n = Math.floor(n / 26); }
      return `@${name}`;
    };
    const records = parsed.records.slice(recordStart - 1, recordEnd).map((fields, index) => {
      const recordNumber = recordStart + index;
      const span = parsed.recordSpans[recordNumber - 1]!;
      return {
        recordNumber,
        physicalLineStart: span.startLine,
        physicalLineEnd: span.startLine + span.lineCount - 1,
        width: fields.length,
        cells: fields.flatMap((value, column) => value === '' ? [] : [{ column: columnName(column), value }]),
      };
    });
    const payload = { objToken, resourceId, resourceHash: resource.resourceHash,
      totalRecords: parsed.records.length, recordStart, recordEnd, records };
    const serialized = JSON.stringify(payload);
    if (serialized.length > 16_000) {
      throw new ToolError('raw_csv_cells_too_large', '目标记录超过 16000 字符；请缩小 record 区间后重读', 409);
    }
    const lineStart = records[0]!.physicalLineStart;
    const lineEnd = records[records.length - 1]!.physicalLineEnd;
    const readReceiptId = `rr_${crypto.randomBytes(9).toString('hex')}`;
    this.appendReadReceipts(state, [{
      readReceiptId,
      buildId: context.buildId ?? 'unknown',
      unitId: context.options.worker?.unitId ?? null,
      toolCallId: meta?.toolCallId ?? 'unknown',
      sourceSnapshotHash: entry.contentHash,
      resourceId,
      selector: { kind: 'read_range', lineStart, lineEnd },
      returnedHash: contentResourceHash(resource.lines.slice(lineStart - 1, lineEnd).join('\n')),
      truncated: recordEnd < parsed.records.length,
    }]);
    return {
      content: [{ type: 'text', text: `<read_receipt id="${readReceiptId}" resource_id="${resourceId}" lines="${lineStart}-${lineEnd}" />\n<untrusted_source>\n${serialized}\n</untrusted_source>` }],
      details: { readReceiptId, resourceId, lineStart, lineEnd, recordStart, recordEnd, totalRecords: parsed.records.length },
    };
  }

  /** Batch phrase lookup over parsed cells. It gives the model an exact selector
   * and read receipt, leaving semantic relevance to the writer or reviewer. */
  private toolRawCsvFind(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): ToolResult {
    const state = requireBuildState(context);
    const objToken = requireString(args, 'objToken', 1, 256);
    const resourceId = requireString(args, 'resourceId', 1, 512);
    const queries = requireArray(args, 'queries');
    if (queries.length < 1 || queries.length > 8 || queries.some((value) => typeof value !== 'string' || value.trim().length < 3 || value.length > 200)) {
      throw new ToolError('invalid_request', 'queries 须为 1–8 个长度 3–200 的非空短语');
    }
    const entry = state.snapshot.get(objToken);
    if (!entry) throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    const assembled = this.assembleBuildRead(state, entry);
    const resource = assembled.resources.find((item) => item.resourceId === resourceId && item.kind === 'csv');
    if (!resource) throw new ToolError('not_found', `冻结源没有该 CSV 资源: ${resourceId}`, 404);
    const parsed = parseCsvRecords(resource.lines.join('\n'));
    const columnName = (index: number): string => {
      let n = index + 1;
      let name = '';
      while (n > 0) { n -= 1; name = String.fromCharCode(65 + n % 26) + name; n = Math.floor(n / 26); }
      return `@${name}`;
    };
    const receiptByRecord = new Map<number, string>();
    const results = (queries as string[]).map((rawQuery) => {
      const query = rawQuery.trim();
      const matches: Array<Record<string, unknown>> = [];
      let totalMatches = 0;
      for (let recordIndex = 0; recordIndex < parsed.records.length; recordIndex += 1) {
        const fields = parsed.records[recordIndex]!;
        for (let column = 0; column < fields.length; column += 1) {
          const value = fields[column]!;
          const foundAt = value.indexOf(query);
          if (foundAt < 0) continue;
          totalMatches += 1;
          if (matches.length >= 5) continue;
          const recordNumber = recordIndex + 1;
          const span = parsed.recordSpans[recordIndex]!;
          const lineStart = span.startLine;
          const lineEnd = span.startLine + span.lineCount - 1;
          let readReceiptId = receiptByRecord.get(recordNumber);
          if (!readReceiptId) {
            readReceiptId = `rr_${crypto.randomBytes(9).toString('hex')}`;
            receiptByRecord.set(recordNumber, readReceiptId);
            this.appendReadReceipts(state, [{
              readReceiptId,
              buildId: context.buildId ?? 'unknown',
              unitId: context.options.worker?.unitId ?? null,
              toolCallId: meta?.toolCallId ?? 'unknown',
              sourceSnapshotHash: entry.contentHash,
              resourceId,
              selector: { kind: 'read_range', lineStart, lineEnd },
              returnedHash: contentResourceHash(resource.lines.slice(lineStart - 1, lineEnd).join('\n')),
              truncated: false,
            }]);
          }
          matches.push({
            recordNumber, column: columnName(column), physicalLineStart: lineStart, physicalLineEnd: lineEnd,
            readReceiptId,
            selector: { kind: 'csv_cells', resourcePath: resource.label, parserVersion: 'rfc4180-v1',
              recordStart: recordNumber, recordEnd: recordNumber, columns: [columnName(column)] },
            valuePreview: value.length <= 300 ? value : `${value.slice(Math.max(0, foundAt - 80), foundAt + query.length + 120)}…`,
          });
        }
      }
      return { query, totalMatches, matches };
    });
    const payload = { objToken, resourceId, resourceHash: resource.resourceHash,
      totalRecords: parsed.records.length, results };
    return { content: [{ type: 'text', text: `<untrusted_source>\n${JSON.stringify(payload)}\n</untrusted_source>` }], details: payload };
  }

  /** raw_read 输出渲染（build 态附 segmentMap/资源表/回执；末页引用块共用）。 */
  private renderRawReadPage(
    context: InternalRunContext,
    entry: RawSourceSnapshotEntry,
    lines: string[],
    slice: string[],
    offset: number,
    readTrail: {
      receipts: Array<{ readReceiptId: string; resourceId: string; lineStart: number; lineEnd: number }>;
      resources: Array<{ resourceId: string; kind: 'text' | 'csv'; label: string; resourceHash: string; totalLines: number; nonEmptyCells?: number }>;
      imageResources: Array<{ resourceId: string; imageHash: string; derivedFrom: string }>;
      segmentMap: Array<Record<string, unknown>>;
    } | null,
    truncated: boolean,
    displayLines: string[] = slice,
    continuation?: BlankCsvSkip,
  ): ToolResult {
    // P1-S4（§2.4）：末页追加 <source_links>（非末页不追加，避免翻页重复）；
    // 无引用边或未注入引用图时不追加，输出与旧版逐字一致。
    const nextOffset = continuation ? continuation.nextOffset
      : offset + slice.length >= lines.length ? null : offset + slice.length;
    const isLastPage = nextOffset === null;
    const sourceLinks = isLastPage ? this.buildSourceLinksBlock(context, entry.objToken) : null;
    // Pi MCP only exposes content blocks to the model. A receipt kept solely in
    // ToolResult.details is invisible to writers, so evidence declarations cannot
    // cite it. Put the compact trusted receipt header first, ahead of long source
    // text that may be truncated by the task tool output budget.
    const receiptHeader = readTrail
      ? `<read_receipts source_id="${entry.objToken}">${JSON.stringify(readTrail.receipts)}</read_receipts>\n`
      : '';
    const imageHeader = readTrail?.imageResources.length
      ? `<image_resources>${JSON.stringify(readTrail.imageResources)}</image_resources>\n`
      : '';
    const blankCsv = readTrail?.resources.filter((resource) => resource.kind === 'csv' && resource.nonEmptyCells === 0)
      .map(({ resourceId, label, totalLines }) => ({ resourceId, label, totalLines })) ?? [];
    const blankCsvHeader = blankCsv.length ? `<blank_csv_resources>${JSON.stringify(blankCsv)}</blank_csv_resources>\n` : '';
    // MCP exposes content, not ToolResult.details. Give the writer an exact
    // continuation offset so large sheets do not trigger guessed/repeated reads.
    const pageHeader = `<raw_page offset="${offset}" returned="${slice.length}" total="${lines.length}" next_offset="${nextOffset ?? 'end'}" />\n`
      + (readTrail ? '<raw_coordinates O="output-line" R="resource-line" C="csv-record" />\n' : '');
    const skippedHeader = continuation?.skipped
      ? `<skipped_blank_csv_rows resource_id="${escapeXml(continuation.skipped.resourceId)}" output_lines="${continuation.skipped.outputStart}-${continuation.skipped.outputEnd}" resource_lines="${continuation.skipped.resourceStart}-${continuation.skipped.resourceEnd}" count="${continuation.skipped.outputEnd - continuation.skipped.outputStart + 1}" />\n`
      : '';
    const wrapped = `${receiptHeader}${imageHeader}${blankCsvHeader}${pageHeader}${skippedHeader}<untrusted_source obj_token="${entry.objToken}" title="${escapeXml(entry.title)}">\n${displayLines.join('\n')}\n</untrusted_source>`
      + (sourceLinks ? `\n${sourceLinks.text}` : '');
    return {
      content: [{ type: 'text', text: wrapped }],
      details: {
        objToken: entry.objToken,
        title: entry.title,
        relPath: entry.relPath,
        offset,
        returnedLines: slice.length,
        totalLines: lines.length,
        nextOffset,
        ...(readTrail
          ? {
            // T3（A 案 §5.3）：模型只能引用回执中的范围；quoteHash 复核在
            // kb_write_doc 证据声明校验时由服务端重新解引用完成。
            readReceiptId: readTrail.receipts[0]?.readReceiptId ?? null,
            readReceipts: readTrail.receipts,
            resources: readTrail.resources,
            imageResources: readTrail.imageResources,
            segmentMap: readTrail.segmentMap,
            truncated,
          }
          : {}),
        ...(sourceLinks ? { sourceLinks: sourceLinks.summary } : {}),
      },
    };
  }

  /**
   * T3（A 案 §5.3）：build 态逐资源装配。主文档逐行内联图片描述（与
   * inlineBuildImageDescriptions 同语义），派生行（image_description/
   * whiteboard_text）不占主资源行坐标；CSV 附件按旧拼接格式（'\n\n<!--
   * 附件 x -->\n'）追加。返回值描述每段输出来自哪份资源哪段行列，或属于
   * 应用派生内容。源变更毒化语义与 readRawContent 一致。
   */
  private assembleBuildRead(state: BuildRunState, entry: RawSourceSnapshotEntry): {
    lines: string[];
    segments: Array<{ resourceId?: string; derived?: string; outStart: number; outEnd: number; resStart?: number; resEnd?: number }>;
    resources: Array<{
      resourceId: string;
      kind: 'text' | 'csv';
      label: string;
      resourceHash: string;
      sourceId: string;
      sourceSnapshotHash: string;
      lines: string[];
      nonEmptyCells?: number;
    }>;
    imageResources: Array<{ resourceId: string; imageHash: string; derivedFrom: string; src: string }>;
  } {
    let verified;
    try {
      verified = state.snapshot.readVerified(state.knowledgeBaseRoot, entry.objToken);
    } catch (error) {
      // F3-R08：与 readRawContent 同语义——构建期间源变更毒化整个构建
      if (error instanceof PathGuardError && error.code === 'source_changed_during_build') {
        state.poisoned = { code: error.code, message: error.message };
      }
      throw error;
    }
    const images = resolveSourceImages(state.knowledgeBaseRoot, entry.relPath, verified.content);
    const whiteboard = state.whiteboardTexts?.get(entry.objToken);
    const described = state.imageDescriptions?.get(entry.objToken);
    const fallbackReason = state.visionReady ? 'not_described' : 'vision_unconfigured';
    const resolve = (src: string): ImageDescriptionLike | undefined => {
      if (whiteboard?.has(src)) return undefined;
      return described?.get(src) ?? { src, state: 'unavailable', reason: fallbackReason };
    };
    const wbText = (src: string) => whiteboard?.get(src);
    // MediaRegion 不要求文本读取回执，但模型需要看见图片资源 ID。
    // 使用与写入/发布相同的装配器，避免只展示旁路文字却遗漏图片本体。
    const imageResources = collectImageEvidenceResources(
      state.knowledgeBaseRoot, entry, verified.content, described, whiteboard,
    ).map((payload) => ({
      resourceId: payload.resource.resourceId,
      imageHash: payload.resource.imageHash,
      derivedFrom: payload.resource.describerVersion?.startsWith('whiteboard_text:') ? 'whiteboard_text' : 'image_description',
      src: payload.src,
    }));

    const lines: string[] = [];
    const labels: Array<{ resourceId?: string; derived?: string }> = [];
    const mainLines = verified.content.split('\n');
    let remaining = images.slice();
    for (const line of mainLines) {
      lines.push(line);
      labels.push({ resourceId: entry.objToken });
      if (remaining.length === 0) continue;
      // 与 inlineImageBlocks 的 inserted 集合同语义：行内命中即消费（无论
      // 是否真的插出了块），后续行不再重复插入。
      const hit = remaining.filter((image) => line.includes(image.src));
      if (hit.length === 0) continue;
      remaining = remaining.filter((image) => !hit.includes(image));
      const single = inlineImageBlocks(line, hit, resolve, wbText);
      if (single !== line) {
        const extra = single.split('\n');
        extra.shift();
        const derived = extra[0]?.startsWith('<whiteboard_text') ? 'whiteboard_text'
          : extra[0]?.startsWith('<image_description') ? 'image_description'
            : 'image_inline';
        lines.push(...extra);
        for (let i = 0; i < extra.length; i += 1) labels.push({ derived });
      }
    }
    const resources: Array<{
      resourceId: string;
      kind: 'text' | 'csv';
      label: string;
      resourceHash: string;
      sourceId: string;
      sourceSnapshotHash: string;
      lines: string[];
      nonEmptyCells?: number;
    }> = [{
      resourceId: entry.objToken,
      kind: 'text',
      label: entry.title,
      resourceHash: contentResourceHash(verified.content),
      sourceId: entry.objToken,
      sourceSnapshotHash: entry.contentHash,
      lines: mainLines,
    }];
    for (const attachment of verified.attachments) {
      const base = path.basename(attachment.path);
      const resourceId = `${entry.objToken}#csv:${base}`;
      const csvLines = attachment.content.split('\n');
      const nonEmptyCells = parseCsvRecords(attachment.content).records.reduce((count, record) =>
        count + record.filter((cell) => cell.trim().length > 0).length, 0);
      // Empty sheets are common workbook placeholders (often hundreds of
      // comma-only rows). Keep their verified resource metadata while omitting
      // the empty rows from model context and page budgets.
      lines.push('', nonEmptyCells === 0 ? `<!-- 空白 CSV 附件 ${base}：0 个有效单元格 -->` : `<!-- 附件 ${base} -->`);
      labels.push({ derived: 'attachment_header' }, { derived: 'attachment_header' });
      if (nonEmptyCells > 0) {
        lines.push(...csvLines);
        for (let i = 0; i < csvLines.length; i += 1) labels.push({ resourceId });
      }
      resources.push({
        resourceId,
        kind: 'csv',
        label: base,
        resourceHash: contentResourceHash(attachment.content),
        sourceId: entry.objToken,
        sourceSnapshotHash: entry.contentHash,
        lines: csvLines,
        nonEmptyCells,
      });
    }
    // 相邻同标签行合并为段（segmentMap 输出形）；资源行号按资源内计数
    // （派生行不占资源本地行坐标，A 案 §5.3）
    const segments: Array<{ resourceId?: string; derived?: string; outStart: number; outEnd: number; resStart?: number; resEnd?: number }> = [];
    const resourceCounters = new Map<string, number>();
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i]!;
      if (label.resourceId) {
        resourceCounters.set(label.resourceId, (resourceCounters.get(label.resourceId) ?? 0) + 1);
      }
      const last = segments[segments.length - 1];
      const sameAsLast = last !== undefined
        && ((label.resourceId !== undefined && last.resourceId === label.resourceId)
          || (label.derived !== undefined && last.derived === label.derived));
      if (sameAsLast) {
        last.outEnd = i + 1;
        if (label.resourceId) last.resEnd = resourceCounters.get(label.resourceId)!;
        continue;
      }
      segments.push({
        ...label,
        outStart: i + 1,
        outEnd: i + 1,
        ...(label.resourceId
          ? { resStart: resourceCounters.get(label.resourceId)!, resEnd: resourceCounters.get(label.resourceId)! }
          : {}),
      });
    }
    return { lines, segments, resources, imageResources };
  }

  /** 追加读取回执到 staging/<buildId>/read-receipts.jsonl 与内存镜像。 */
  private appendReadReceipts(state: BuildRunState, receipts: ReadReceiptRecord[]): void {
    if (receipts.length === 0) return;
    if (!state.readReceipts) {
      state.readReceipts = [];
      const file = path.join(state.stagingRoot, 'read-receipts.jsonl');
      try {
        if (fs.existsSync(file)) {
          for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            state.readReceipts.push(JSON.parse(line) as ReadReceiptRecord);
          }
        }
      } catch {
        /* 既有文件损坏时从当前继续追加（文件真相仍以写入行为准） */
      }
    }
    state.readReceipts.push(...receipts);
    try {
      fs.mkdirSync(state.stagingRoot, { recursive: true });
      fs.appendFileSync(
        path.join(state.stagingRoot, 'read-receipts.jsonl'),
        `${receipts.map((receipt) => JSON.stringify(receipt)).join('\n')}\n`,
        'utf-8',
      );
    } catch (error) {
      throw new ToolError('read_receipt_write_failed', `读取回执落盘失败: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  }

  /** 读取本构建全部回执（文件真相 + 内存镜像同步）。 */
  private loadReadReceipts(state: BuildRunState): ReadReceiptRecord[] {
    if (!state.readReceipts) {
      state.readReceipts = [];
      const file = path.join(state.stagingRoot, 'read-receipts.jsonl');
      try {
        if (fs.existsSync(file)) {
          for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            state.readReceipts.push(JSON.parse(line) as ReadReceiptRecord);
          }
        }
      } catch {
        /* 同 appendReadReceipts */
      }
    }
    return state.readReceipts;
  }

  /**
   * P1-S4（§2.4）：raw_read 末页引用块。出入链各取前 30 条（§2.4 上限），
   * 超出方向标 truncated；无任何边时返回 null（不追加）。
   */
  private buildSourceLinksBlock(
    context: InternalRunContext,
    objToken: string,
  ): { text: string; summary: { out: number; in: number; outTruncated: boolean; inTruncated: boolean } } | null {
    const links = this.resolvedSourceLinks(context, objToken);
    if (!links) return null;
    const text = renderSourceLinksBlock({ objToken, out: links.out, in: links.in });
    if (!text) return null;
    return {
      text,
      summary: {
        out: Math.min(links.out.length, SOURCE_LINKS_PAGE_LIMIT),
        in: Math.min(links.in.length, SOURCE_LINKS_PAGE_LIMIT),
        outTruncated: links.out.length > SOURCE_LINKS_PAGE_LIMIT,
        inTruncated: links.in.length > SOURCE_LINKS_PAGE_LIMIT,
      },
    };
  }

  /**
   * P1-S4：解析引用边到本地文档行。出边附 kbDocs（CURRENT manifest 中
   * sources 含该 objToken 的标准库文档路径）与 in_raw（build 态按快照、
   * 会话态按成功本地版本）；入边同样附 kbDocs（其 objToken=引用方）。
   */
  private resolvedSourceLinks(context: InternalRunContext, objToken: string): {
    out: Array<ResolvedSourceLink & { kbDocs: string[]; inRaw: boolean }>;
    in: Array<ResolvedSourceLink & { kbDocs: string[] }>;
  } | null {
    if (!this.sourceLinksProvider) return null;
    const edges = this.sourceLinksProvider(objToken);
    const documents = this.documentsProvider();
    const byObjToken = new Map(documents.map((doc) => [doc.objToken, doc]));
    const byWikiToken = new Map<string, DocumentRecord>();
    for (const doc of documents) {
      if (doc.wikiNodeToken) byWikiToken.set(doc.wikiNodeToken, doc);
    }
    const lookup = (token: string) => byObjToken.get(token) ?? byWikiToken.get(token) ?? null;
    const resolved = resolveSourceLinks({ outEdges: edges.out, inEdges: edges.in, lookup });
    const manifest = this.storeFor(context.options.outputRoot).readManifest();
    const kbDocsFor = (token: string | null): string[] => {
      if (!token || !manifest) return [];
      return manifest.docs.filter((doc) => doc.sources.includes(token)).map((doc) => doc.path);
    };
    const snapshot = context.options.buildState?.snapshot;
    return {
      out: resolved.out.map((link) => ({
        ...link,
        kbDocs: kbDocsFor(link.objToken),
        inRaw: snapshot ? snapshot.has(link.objToken ?? '') : link.synced,
      })),
      in: resolved.in.map((link) => ({ ...link, kbDocs: kbDocsFor(link.objToken) })),
    };
  }

  /** P1-S4（§2.4）：raw_links 只读工具——双向引用查询（各方向上限 200）。 */
  private toolRawLinks(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const objToken = requireString(args, 'objToken', 1, 256);
    const direction = args.direction === 'out' || args.direction === 'in' || args.direction === 'both'
      ? args.direction
      : 'both';
    if (!this.sourceLinksProvider) {
      throw new ToolError('references_unavailable', '引用图未接入本运行（缺少引用数据源）', 500);
    }
    const links = this.resolvedSourceLinks(context, objToken)!;
    const out = direction === 'in' ? [] : links.out.slice(0, RAW_LINKS_LIMIT);
    const inLinks = direction === 'out' ? [] : links.in.slice(0, RAW_LINKS_LIMIT);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          objToken,
          direction,
          out,
          in: inLinks,
          outTruncated: direction !== 'in' && links.out.length > RAW_LINKS_LIMIT,
          inTruncated: direction !== 'out' && links.in.length > RAW_LINKS_LIMIT,
        }, null, 2),
      }],
      details: { objToken, direction, outCount: out.length, inCount: inLinks.length },
    };
  }

  /**
   * P2-S4（设计 §5.1）：raw_comments 只读工具——按源查同步时采集的飞书
   * 评论。输出以 <untrusted_comments> 包裹（total=本次入库条数，
   * truncated=comments.tips 截断标记；solved 三态 true/false/省略）。
   * 文档不存在 → 404；meta 无行（从未采集）→ 包裹内说明行，不报错。
   */
  private toolRawComments(args: Record<string, unknown>): ToolResult {
    const objToken = requireString(args, 'objToken', 1, 256);
    if (!this.commentsProvider) {
      throw new ToolError('comments_unavailable', '评论采集未接入本运行（缺少评论数据源）', 500);
    }
    // 文档必须存在（与 raw_read 会话态同款存在性判定）。
    const record = this.documentsProvider().find((doc) => doc.objToken === objToken);
    if (!record) {
      throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    }
    const { meta, comments } = this.commentsProvider(objToken);
    const lines: string[] = [];
    let total = 0;
    let truncated = false;
    if (meta) {
      total = meta.total;
      truncated = meta.truncated;
      for (const comment of comments) {
        const attrs = [
          `ref="${escapeXml(comment.commentRef)}"`,
          comment.author != null ? `author="${escapeXml(comment.author)}"` : '',
          comment.createdAtCloud != null ? `at="${escapeXml(comment.createdAtCloud)}"` : '',
          comment.solved === true ? 'solved="true"' : comment.solved === false ? 'solved="false"' : '',
        ].filter(Boolean).join(' ');
        lines.push(`  <comment ${attrs}>`);
        if (comment.quote) lines.push(`    <quote>${escapeXml(comment.quote)}</quote>`);
        lines.push(`    ${escapeXml(comment.text)}`);
        lines.push('  </comment>');
      }
      if (comments.length === 0) {
        lines.push('  （无评论）');
      }
    } else {
      lines.push('  该文档没有采集过评论（评论仅在 docx 同步成功时采集）。');
    }
    const text = [
      `<untrusted_comments obj_token="${escapeXml(objToken)}" total="${total}" truncated="${truncated}">`,
      ...lines,
      '</untrusted_comments>',
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      details: { objToken, total, truncated, collected: meta !== null },
    };
  }

  /** S3（§3.5）+ P0-S7：会话态内联——白板旁路文字不依赖 vision（本地
   *  抽取，零额度成本），任何 vision 状态都先内联；识图描述仍只内联已
   *  缓存命中，旁路命中者跳过（与构建链同语义）。 */
  private async inlineSessionImageDescriptions(
    context: InternalRunContext,
    entry: RawSourceSnapshotEntry,
    content: string,
  ): Promise<string> {
    if (!context.options.knowledgeBaseRoot) return content;
    const root = context.options.knowledgeBaseRoot;
    const images = resolveSourceImages(root, entry.relPath, content);
    if (images.length === 0) return content;
    const whiteboardBySrc: WhiteboardTextMap = new Map(
      extractWhiteboardBypassTexts(root, entry.relPath, content).map((item) => [
        item.src,
        { origin: item.origin, text: item.text, truncated: item.truncated },
      ] as const),
    );
    const whiteboardText = (src: string) => whiteboardBySrc.get(src);
    if (!this.visionDescriber) {
      return inlineImageBlocks(content, images, () => undefined, whiteboardText);
    }
    const status = await this.visionDescriber.status();
    if (status.state !== 'ready') {
      return inlineImageBlocks(content, images, () => undefined, whiteboardText);
    }
    const bySrc = new Map<string, ImageDescriptionLike>();
    for (const image of images) {
      if (whiteboardBySrc.has(image.src)) continue; // 旁路文字命中：跳过该图描述
      const hash = hashImageFile(image.file);
      if (!hash) {
        bySrc.set(image.src, { src: image.src, state: 'unavailable', reason: 'missing_file' });
        continue;
      }
      const text = await this.visionDescriber.lookup(hash);
      bySrc.set(image.src, text != null
        ? { src: image.src, state: 'cached', text }
        : { src: image.src, state: 'unavailable', reason: 'not_described' });
    }
    return inlineImageBlocks(content, images, (src) => bySrc.get(src), whiteboardText);
  }

  /** S3（§3.5）：会话侧按需识图。src 必须属于该源的本地图片引用。 */
  private async toolRawReadImage(context: InternalRunContext, args: Record<string, unknown>): Promise<ToolResult> {
    const objToken = requireString(args, 'objToken', 1, 256);
    const src = requireString(args, 'src', 1, 400);
    if (!this.visionDescriber) {
      throw new ToolError('vision_unconfigured', '图片理解未启用（请在设置中配置图片理解模型）', 400);
    }
    const status = await this.visionDescriber.status();
    if (status.state !== 'ready') {
      throw new ToolError('vision_unconfigured', `图片理解未就绪：${status.message || status.state}`, 400);
    }
    const entry = context.options.buildState
      ? context.options.buildState.snapshot.get(objToken)
      : this.rawEntriesForDiscuss(context).find((candidate) => candidate.objToken === objToken) ?? null;
    if (!entry || !context.options.knowledgeBaseRoot) {
      throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    }
    const content = this.readRawContent(context, objToken);
    const images = resolveSourceImages(context.options.knowledgeBaseRoot, entry.relPath, content);
    const image = images.find((candidate) => candidate.src === src);
    if (!image) {
      throw new ToolError('invalid_request', `src 不属于该源文档的本地图片引用: ${src}`, 400);
    }
    const description = await this.visionDescriber.describeOne(image.file, image.src);
    if (description.state === 'unavailable') {
      throw new ToolError(description.reason ?? 'vision_failed', `图片描述不可用：${description.message ?? description.reason ?? ''}`.trim(), 502);
    }
    return {
      content: [{
        type: 'text',
        text: `<untrusted_image_description obj_token="${escapeXml(objToken)}" src="${escapeXml(src)}">\n${description.text ?? ''}\n</untrusted_image_description>`,
      }],
      details: { objToken, src, state: description.state },
    };
  }

  private toolRawList(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    if (!context.options.buildState) {
      throw new ToolError('tool_not_allowed', 'raw_list 仅构建运行可用', 403);
    }
    const filter = args.filter === 'all' ? 'all' : 'workset';
    const cursor = typeof args.cursor === 'string' && args.cursor ? args.cursor : null;
    const state = context.options.buildState;
    let entries = state.snapshot.entries;
    if (filter === 'workset') {
      // S4（§4.4）：worker 上下文只列本单元源（跨单元源由其他 worker 处理）
      const workerUnitId = context.options.worker?.phase === 'unit' ? context.options.worker.unitId : null;
      const unitSources = workerUnitId
        ? new Set(state.units?.find((unit) => unit.id === workerUnitId)?.sources ?? [])
        : null;
      entries = entries.filter((entry) =>
        unitSources ? unitSources.has(entry.objToken) : state.workset.has(entry.objToken));
    }
    entries = entries.slice().sort((a, b) => a.relPath.localeCompare(b.relPath));
    let startIndex = 0;
    if (cursor) {
      const cursorIndex = entries.findIndex((entry) => entry.objToken === cursor);
      if (cursorIndex < 0) {
        throw new ToolError('invalid_request', `游标无效: ${cursor}`);
      }
      startIndex = cursorIndex + 1;
    }
    const pageSize = 50;
    const page = entries.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < entries.length
      ? entries[startIndex + pageSize].objToken
      : null;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          entries: page.map((entry) => ({
            ...entry,
            changeType: state.workset.get(entry.objToken) ?? 'unchanged',
          })),
          nextCursor,
        }, null, 2),
      }],
      details: { filter, total: entries.length },
    };
  }

  // ------------------------------------------------------------------
  // draft_*（构建 staging 读）
  // ------------------------------------------------------------------

  private toolDraftList(context: InternalRunContext): ToolResult {
    const stagingRoot = requireBuildState(context).stagingRoot;
    const docsDir = path.join(stagingRoot, 'docs');
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const child = path.join(dir, name);
        const lstat = fs.lstatSync(child);
        if (lstat.isDirectory()) walk(child, `${prefix}${name}/`);
        else if (name.endsWith('.md')) files.push(`${prefix}${name}`);
      }
    };
    walk(docsDir, '');
    files.sort();
    return { content: [{ type: 'text', text: JSON.stringify({ docs: files }, null, 2) }] };
  }

  private toolDraftRead(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const docPath = requireString(args, 'path', 1, 600);
    const metadataOnly = args.metadataOnly === true;
    const offset = optionalInt(args, 'offset', 0, 0, 10_000_000);
    const limit = optionalInt(args, 'limit', 800, 1, 2000);
    const declarationClaimKey = args.declarationClaimKey === undefined ? null : requireString(args, 'declarationClaimKey', 1, 200);
    const declarationObjectKey = args.declarationObjectKey === undefined ? null : requireString(args, 'declarationObjectKey', 1, 200);
    const includeDeclarations = args.includeDeclarations === true || Boolean(declarationClaimKey || declarationObjectKey);
    if (metadataOnly && includeDeclarations) {
      throw new ToolError('invalid_request', 'metadataOnly 与声明筛选不能同时使用');
    }
    const stagingRoot = requireBuildState(context).stagingRoot;
    validateStdDocPath(docPath);
    const docsRoot = path.join(stagingRoot, 'docs');
    // 读取尚未创建的目标时，父目录也可能不存在。write 意图要求父目录
    // 已存在，会把普通的「尚无草稿」误报为 path_escape。
    let target: string | null = null;
    try {
      target = resolveInside(docsRoot, docPath, 'read');
    } catch (error) {
      if (!(error instanceof PathGuardError) || error.code !== 'not_found') throw error;
    }
    const missing = target === null;
    if (missing && !includeDeclarations) throw new ToolError('not_found', `草稿不存在: ${docPath}`, 404);
    const fileText = target === null ? '' : fs.readFileSync(target, 'utf-8');
    const body = stripStdHeader(fileText);
    const lines = missing ? [] : body.split('\n');
    const slice = metadataOnly ? [] : lines.slice(offset, offset + limit);
    let declarationText = '';
    if (includeDeclarations) {
      const state = requireBuildState(context);
      const declarations = this.renderDraftDeclarations(state, docPath, declarationClaimKey, declarationObjectKey);
      if (declarations) {
        declarationText = `\n\n<existing_knowledge_declarations>\n${JSON.stringify(declarations, null, 2)}\n</existing_knowledge_declarations>`;
      }
    }
    if (missing && !declarationText) throw new ToolError('not_found', `草稿及知识声明均不存在: ${docPath}`, 404);
    // v2（§7）：局部编辑坐标口径的内容哈希与行数（kb_edit_doc 的
    // expectedContentHash 同源；参数坐标 = 去 server 头与 # 标题行）。
    let editCoordinates: { contentHash: string; paramTotalLines: number } | null = null;
    try {
      // 哈希必须与本次返回的正文来自同一字节快照，不能二次读盘混入并发更新。
      const coordinates = draftEditCoordinates(body);
      editCoordinates = { contentHash: contentResourceHash(coordinates.paramLines.join('\n')), paramTotalLines: coordinates.paramLines.length };
    } catch {
      editCoordinates = null;
    }
    let metadataText = '';
    if (metadataOnly) {
      const header = target ? parseStdHeader(fileText) : null;
      const state = requireBuildState(context);
      const draftFile = path.join(stagingRoot, 'knowledge-draft.json');
      const draft = state.knowledgeDraft ?? (fs.existsSync(draftFile) ? this.loadKnowledgeDraft(state) : null);
      const sources = header?.sources ?? [];
      const metadata = {
        path: docPath,
        sources,
        editContentHash: editCoordinates?.contentHash ?? null,
        draftRevision: draft?.docs[docPath]?.revision ?? 0,
        coverageItems: (draft?.coverage ?? []).filter((item) => sources.includes(item.sourceRef.sourceId))
          .slice(0, 100).map((item) => ({ itemId: item.itemId, sourceId: item.sourceRef.sourceId, disposition: item.disposition })),
      };
      metadataText = `<draft_metadata>${JSON.stringify(metadata)}</draft_metadata>`;
    }
    return {
      content: [{ type: 'text', text: metadataOnly ? metadataText : (missing ? `<missing_draft path="${docPath}">正文缺失；请根据原始来源重建并重申下方对象声明。</missing_draft>` : slice.join('\n')) + declarationText }],
      details: {
        path: docPath,
        offset,
        returnedLines: slice.length,
        totalLines: lines.length,
        missing,
        ...(editCoordinates ? { editContentHash: editCoordinates.contentHash, editParamTotalLines: editCoordinates.paramTotalLines } : {}),
      },
    };
  }

  private toolDraftSearch(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const query = requireString(args, 'query', 1, 200);
    const limit = optionalInt(args, 'limit', 20, 1, 20);
    const stagingRoot = requireBuildState(context).stagingRoot;
    const docsDir = path.join(stagingRoot, 'docs');
    const lowerQuery = query.toLowerCase();
    const results: Array<Record<string, unknown>> = [];
    const walk = (dir: string, prefix: string) => {
      if (results.length >= limit) return;
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (results.length >= limit) return;
        const child = path.join(dir, name);
        const lstat = fs.lstatSync(child);
        if (lstat.isDirectory()) {
          walk(child, `${prefix}${name}/`);
        } else if (name.endsWith('.md')) {
          const relPath = `${prefix}${name}`;
          try {
            const content = fs.readFileSync(child, 'utf-8');
            const index = content.toLowerCase().indexOf(lowerQuery);
            if (index >= 0) {
              const start = Math.max(0, index - 60);
              results.push({
                path: relPath,
                snippet: `${content.slice(start, index + query.length + 100).replace(/\n+/g, ' ')}…`,
              });
            }
          } catch {
            /* 跳过不可读文件 */
          }
        }
      }
    };
    walk(docsDir, '');
    return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
  }

  // ------------------------------------------------------------------
  // kb_write_doc / kb_delete_doc / kb_finish（构建 staging 写）
  // ------------------------------------------------------------------

  private async toolKbWriteDoc(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): Promise<ToolResult> {
    // 机械字段由服务端从已给的语义输入确定。规范化必须在幂等哈希前完成，
    // 同载荷重放与首次提交看到同一份业务参数；显式字段始终优先。
    args = normalizeKbWriteDocArgs(args);
    // v2（设计 v2 §4.4 + Leader steer 硬验收）：凭据代次/身份/角色/发布窗口
    // （前置门）→ 分配 → 幂等 → 原校验链 → 成果回执，**整体置于同一受控
    // 锁链**（与声明临界区同一把锁）：幂等预检、最终提交与回执记账之间
    // 不存在并发窗口；锁内异步证据装配后、最终落盘前重检身份/代次/分配/
    // 发布窗口——取消或转移后绝不写成功。Leader 凭据到不了这里（工具面
    // 不含正文写工具）；旧模式（无 orchestration）直走原链。
    const v2 = context.options.orchestration ?? null;
    if (v2 && v2.credential === 'child') {
      const state = requireBuildState(context);
      const { actor } = this.requireV2Actor(context, meta);
      const docPath = requireString(args, 'path', 1, 600);
      const operationId = requireString(args, 'operationId', 1, 200);
      const payloadHash = canonicalPayloadHash(args, ['operationId', 'expectedDraftRevision']);
      // 声明幂等键稳定化：回执丢失（崩溃）后重放命中 knowledge-draft 的
      // calls 账本，不重复推进 draftRevision（meta.toolCallId 每次不同，
      // 不能作 v2 幂等键）。
      const stableMeta: ToolRequestMeta = { ...(meta ?? {}), toolCallId: stableV2CallKey(actor.nativeTaskId, operationId) };
      return this.withKnowledgeDeclarationLock(state, async (): Promise<ToolResult> => {
        const replay = this.v2Replay(v2, actor.nativeTaskId, operationId, payloadHash);
        if (replay) return replay;
        // 锁内预检：先身份后分配（取消同时撤销两者时，报告更根本原因）
        try {
          v2.actorStore.requireConfirmedActor(actor.nativeTaskId, meta?.amagiAgent);
        } catch (error) {
          throw wrapActorError(error);
        }
        this.assertV2OutputAssignment(v2, actor.nativeTaskId, docPath);
        const result = await this.writeDocCore(context, args, stableMeta, {
          lockHeld: true,
          recheck: () => this.assertV2WriteWindow(v2, actor.nativeTaskId, meta, docPath),
          idempotency: { payloadHash },
        });
        this.v2RecordReceipt({ v2, nativeTaskId: actor.nativeTaskId, kind: 'write_doc', operationId, payloadHash, paths: [docPath], result, invalidateReviews: true });
        return result;
      });
    }
    return this.writeDocCore(context, args, meta);
  }

  /** v2（§4.4 硬验收）：锁内、最终落盘前的写入窗口重检——排队期间的
   * 取消/换代/分配转移/发布窗口开启都使本次写入拒绝，文件不被触碰。 */
  private assertV2WriteWindow(v2: OrchestrationV2Options, nativeTaskId: string, meta: ToolRequestMeta | undefined, docPath: string): void {
    v2.actorStore.assertGeneration(v2.generation);
    const actor = v2.actorStore.lookupActor(nativeTaskId);
    if (!actor || actor.status !== 'confirmed') {
      throw new ToolError('actor_revoked', `任务 ${nativeTaskId} 写入资格已在提交前被撤销，拒绝落盘`, 401);
    }
    if (meta?.amagiAgent !== undefined && actor.role !== meta.amagiAgent) {
      throw new ToolError('actor_role_mismatch', `任务 ${nativeTaskId} 角色已变化（${actor.role}），拒绝落盘`, 403);
    }
    this.assertV2OutputAssignment(v2, nativeTaskId, docPath);
    const window = v2.actorStore.publishing;
    if (window) {
      throw new ToolError('build_publishing', `发布校验进行中（requestId=${window.requestId}），拒绝落盘`, 409);
    }
  }

  /** kb_write_doc / kb_edit_doc 共用校验与落盘链（v2 记账在包装层）。
   * options.lockHeld：调用方已持有声明锁（v2 写入链）时不重复加锁；
   * options.recheck：锁内异步准备后、最终落盘前的重检钩子（v2）；
   * options.idempotency.payloadHash（F06）：v2 调用方语义载荷哈希——
   * calls 账本命中同键时必须比较（同载荷才重放），并在原子落盘时随
   * calls 条目记录，供回执丢失后的崩溃重放核验。 */
  private materializeCsvTableImports(
    context: InternalRunContext,
    state: BuildRunState,
    args: Record<string, unknown>,
    meta?: ToolRequestMeta,
  ): Record<string, unknown> {
    if (args.csvTableImports === undefined) return args;
    const imports = args.csvTableImports;
    if (!Array.isArray(imports) || imports.length === 0 || imports.length > 10) {
      throw new ToolError('invalid_request', 'csvTableImports 必须包含 1 至 10 个表格导入');
    }
    const sources = new Set(Array.isArray(args.sources) ? args.sources : []);
    let markdown = requireString(args, 'markdown', 1, 2_000_000);
    const receipts: ReadReceiptRecord[] = [];
    const assembledBySource = new Map<string, ReturnType<AgentToolService['assembleBuildRead']>>();
    const usedKeys = new Set<string>();
    for (const raw of imports) {
      const item = asRecord(raw);
      if (!item) throw new ToolError('invalid_request', 'csvTableImports 项目必须为对象');
      const key = requireString(item, 'key', 1, 40);
      if (!/^[A-Za-z0-9_-]+$/.test(key) || usedKeys.has(key)) {
        throw new ToolError('invalid_request', 'CSV 表格占位键格式无效或重复');
      }
      usedKeys.add(key);
      const sourceId = requireString(item, 'sourceId', 1, 256);
      const csvName = requireString(item, 'csvName', 1, 255);
      if (path.basename(csvName) !== csvName || !/\.csv$/i.test(csvName) || !sources.has(sourceId)) {
        throw new ToolError('invalid_request', 'CSV 附件名称无效，或来源未列入 sources');
      }
      const entry = state.snapshot.get(sourceId);
      if (!entry) throw new ToolError('invalid_request', `CSV 来源不在快照内：${sourceId}`);
      let assembled = assembledBySource.get(sourceId);
      if (!assembled) {
        assembled = this.assembleBuildRead(state, entry);
        assembledBySource.set(sourceId, assembled);
      }
      const resourceId = `${sourceId}#csv:${csvName}`;
      const resource = assembled.resources.find((candidate) => candidate.resourceId === resourceId && candidate.kind === 'csv');
      if (!resource) throw new ToolError('invalid_request', `CSV 附件不在冻结来源中：${resourceId}`);
      if (!Array.isArray(item.columns) || item.columns.length === 0 || item.columns.length > 20
        || item.columns.some((column) => !Number.isSafeInteger(column))) {
        throw new ToolError('invalid_request', 'CSV 导入列坐标无效');
      }
      const headerRecord = item.headerRecord === undefined ? 1 : item.headerRecord;
      const firstRecord = item.firstRecord === undefined ? (headerRecord as number) + 1 : item.firstRecord;
      const lastRecord = item.lastRecord;
      if (!Number.isSafeInteger(headerRecord) || !Number.isSafeInteger(firstRecord)
        || (lastRecord !== undefined && !Number.isSafeInteger(lastRecord))) {
        throw new ToolError('invalid_request', 'CSV 导入记录范围无效');
      }
      let rendered;
      try {
        rendered = renderCsvTableImport(resource.lines.join('\n'), {
          columns: item.columns as number[],
          headerRecord: headerRecord as number,
          firstRecord: firstRecord as number,
          ...(lastRecord === undefined ? {} : { lastRecord: lastRecord as number }),
        });
      } catch (error) {
        throw new ToolError('invalid_request', error instanceof Error ? error.message : 'CSV 表格导入失败');
      }
      const marker = `{{kb-csv-table:${key}}}`;
      if (markdown.split(marker).length !== 2) {
        throw new ToolError('invalid_request', `正文须恰好包含一次 ${marker}`);
      }
      markdown = markdown.replace(marker, rendered.markdown);
      if (Buffer.byteLength(markdown, 'utf-8') > MAX_STANDARD_DOC_BYTES) {
        throw new ToolError('kb_doc_too_large', `脚本导入后文档超过 ${MAX_STANDARD_DOC_BYTES} 字节；请按主题或 CSV 记录范围拆成多篇独立标准文档`, 400);
      }
      const returnedText = resource.lines.slice(rendered.lineStart - 1, rendered.lineEnd).join('\n');
      receipts.push({
        readReceiptId: `rr_${crypto.randomBytes(9).toString('hex')}`,
        buildId: context.buildId ?? 'unknown',
        unitId: context.options.worker?.unitId ?? null,
        toolCallId: meta?.toolCallId ?? 'csv-table-import',
        sourceSnapshotHash: entry.contentHash,
        resourceId,
        selector: { kind: 'read_range', lineStart: rendered.lineStart, lineEnd: rendered.lineEnd },
        returnedHash: contentResourceHash(returnedText),
        truncated: false,
      });
    }
    this.appendReadReceipts(state, receipts);
    return { ...args, markdown };
  }

  private async writeDocCore(
    context: InternalRunContext,
    args: Record<string, unknown>,
    meta?: ToolRequestMeta,
    options?: { lockHeld?: boolean; recheck?: () => void; idempotency?: { payloadHash: string };
      objectMerges?: Array<{ fromObjectId: string; toObjectId: string }> },
  ): Promise<ToolResult> {
    const state = requireBuildState(context);
    // T3（A 案 §7.1）：审查者没有任何草稿写入口
    this.assertNotReviewPhase(context);
    args = this.materializeCsvTableImports(context, state, args, meta);
    const docPath = requireString(args, 'path', 1, 600);
    const title = requireString(args, 'title', 1, 300);
    // csvTableImports expands short model-authored text into verified CSV rows.
    // Edits must also be able to resubmit a previously imported long document.
    const markdown = requireString(args, 'markdown', 1, MAX_STANDARD_DOC_BYTES);
    const summary = requireString(args, 'summary', 1, 400);
    if (hasEditorialHistory(markdown) || hasEditorialHistory(summary)) {
      throw new ToolError('body_contains_change_history', '正文与文档摘要必须为当前规则的一次成型表述；移除版本头、修订记录和本版/上版对比。变更说明仅放在kb_finish.summary。');
    }
    const suppliedSources = args.sources;
    if (!Array.isArray(suppliedSources) || suppliedSources.length === 0 || !suppliedSources.every((source) => typeof source === 'string')) {
      throw new ToolError('invalid_request', 'sources 必须是非空字符串数组');
    }
    for (const source of suppliedSources) {
      if (!state.snapshot.has(source)) {
        throw new ToolError('invalid_request', `来源不在快照内: ${source}`);
      }
    }
    // Source metadata must not claim an empty workbook or a Feishu permission
    // placeholder as evidence. Remove these deterministic placeholders before
    // generating the header; the final validator records their skip reasons.
    const sources = suppliedSources.filter((source): source is string => {
      const entry = state.snapshot.get(source);
      const verified = state.snapshot.readVerified(state.knowledgeBaseRoot, source);
      return !isPermissionDeniedSourcePlaceholder(verified.content)
        && !(entry?.objType === 'sheet' && isBlankWorkbookPlaceholder(verified));
    });
    if (sources.length === 0) {
      throw new ToolError('kb_source_empty_placeholder', 'sources 仅包含权限占位或全空工作簿；本次没有可写的知识，发布校验会自动登记跳过', 400);
    }
    const sourceIdentifiers = state.snapshot.entries.flatMap((entry) => [entry.objToken, entry.relPath]);
    if ([title, markdown, summary].some((text) => hasSourceMetadata(text, sourceIdentifiers))) {
      throw new ToolError('body_contains_source_metadata', '正文、标题与摘要只写自然完整的知识内容。移除来源段落、来源标识、原始文件路径和构建信息；来源仅通过sources字段声明，由来源侧栏展示。冲突内容直接说明未统一的规则，不在正文标注来源。');
    }
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
      : [];
    validateStdDocPath(docPath);
    // S4（§4.3）：worker 上下文先认领路径——同一路径只允许一个单元写
    this.assertPathClaim(context, state, docPath);

    // ---- T3（A 案 §7.1）：知识声明（全部可选；旧式调用不带新参数完全兼容）----
    const declarationKeys = ['planId', 'expectedDraftRevision', 'objects', 'presentations', 'relations', 'evidenceClaims', 'coverageUpdates'] as const;
    const hasDeclaration = declarationKeys.some((key) => args[key] !== undefined);
    // diting S-F01：bodyRange 计算与声明保存必须在同一构建级互斥区内——
    // buildKnowledgeDeclaration 内的工作簿/图片证据装配会 await 让出执行；
    // 无互斥时，先读取共享 knowledgeDraft 深拷贝的一方会在返回后把旧副本
    // 整包保存，覆盖并发方的 docs/objects/evidence/clientKeys/calls 登记
    //（文件级 PathClaims 不保护 knowledge-draft.json）。锁住共享
    // BuildRunState：同 build 的声明写者串行，跨 build 不相互阻塞。
    // v2（§4.4 硬验收）：包装层已持锁时直入临界区（lockHeld），
    // recheck 在异步准备后、最终落盘前重检写入窗口。
    const coreOperation = async (): Promise<ToolResult> => {
      const baseDraft = hasDeclaration ? this.loadKnowledgeDraft(state) : null;
      if (baseDraft && meta?.toolCallId && baseDraft.calls[meta.toolCallId]) {
        // 同 toolCallId 重复提交幂等返回（A 案 §7.1）；不重复写入、不推进修订。
        // F06：v2 调用（idempotency 在场）命中同键必须先核验载荷——异载荷
        // 报幂等冲突，旧账本缺哈希明确拒绝（不可盲重放）；非 v2 旧语义不变。
        const call = baseDraft.calls[meta.toolCallId]!;
        this.verifyCallsLedgerPayload(call, meta.toolCallId, options?.idempotency?.payloadHash);
        return {
          content: [{ type: 'text', text: `已写入草稿 ${call.path}（幂等重放，docId=${call.docId}，draftRevision=${call.draftRevision}）` }],
          details: {
            path: call.path, docId: call.docId, bytes: call.bytes, idempotentReplay: true,
            draftRevision: call.draftRevision, objectMap: call.objectIdMap, evidenceMap: call.evidenceIdMap,
          },
        };
      }

      // docId 继承：按 path 沿用当前 release 的 docId（server 分配）；同构建
      // 内已声明过该路径则沿用 knowledge-draft 登记的 docId（身份稳定）
      const docId = this.inheritDocId(state, docPath)
        ?? baseDraft?.docs[docPath]?.docId
        ?? `kd_${crypto.randomBytes(6).toString('hex')}`;
      // diting F02：声明坐标基准 = markdown 参数。工具在正文前生成 `# title`
      // 并剥离首部空行，发布正文行号 = 参数行号 + bodyLineOffset（= 1 − 剥离
      // 行数）；编译器按该偏移重映射 canonical/claims/presentations，工具侧
      // 生成标题前后声明坐标一致转换。
      const stripMatch = /^\s*\n/.exec(markdown);
      const strippedLines = stripMatch ? stripMatch[0].split('\n').length - 1 : 0;
      const bodyLineOffset = 1 - strippedLines;
      // diting F06：托管文档（基线登记对象）不允许旧式参数重写——那会静默
      // 丢失组织/审查登记并降级 v1；必须携带声明重申，或显式 kb_delete_doc
      // （对象丢失由发布门禁 kb_migration_invalid 拦截）。
      if (!baseDraft) {
        const existing = this.loadKnowledgeDraft(state);
        const managed = existing.objects.some((object) => !object.tombstone && object.canonical?.path === docPath);
        if (managed) {
          throw new ToolError(
            'kb_object_registry_stale',
            `文档 ${docPath} 已登记知识对象，旧式参数重写会静默丢失组织/审查登记（不允许静默降 v1，diting F06）。请携带 objects/evidenceClaims 等声明重申对象，或先 kb_delete_doc 删除该文档并声明对象迁移`,
            409,
          );
        }
      }
      // 声明解析与校验（写入即拒；正文尚未落盘，任何拒绝都不产生部分写入）
      const declaration = baseDraft
        ? await this.buildKnowledgeDeclaration(context, state, baseDraft, docPath, docId, args, markdown, meta, options?.objectMerges ?? [])
        : null;

      const buildId = context.buildId ?? 'unknown';
      const header = [
        '<!--',
        'feishu_sync_kb:',
        `  doc_id: ${docId}`,
        '  sources:',
        ...(sources as string[]).map((source) => `    - ${source}`),
        `  build_id: ${buildId}`,
        '-->',
      ].join('\n');
      const body = markdown.replace(/^\s*\n/, '');
      const full = `${header}\n# ${title}\n${body}\n`;
      const fullBytes = Buffer.byteLength(full, 'utf-8');
      if (fullBytes > MAX_STANDARD_DOC_BYTES) {
        throw new ToolError('kb_doc_too_large', `文档 ${docPath} 为 ${fullBytes} 字节，超过 ${MAX_STANDARD_DOC_BYTES} 字节上限；请按主题或 CSV 记录范围拆成多篇独立标准文档`, 400);
      }
      // 深路径父目录（mkdir intent 逐级复核）。
      const parentRel = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : null;
      // v2（§4.4 硬验收）：异步证据装配后、最终提交前的重检——排队期间的
      // 取消/换代/分配转移/发布窗口使本次写入拒绝，文件与 revision 不变。
      // F01：撤销租约终检在前（生产取消链 revokeToken 不动 actor/generation，
      // 仅靠 v2 重检拦不住被撤销令牌的在途写入；v2 与旧模式共用本检查点）。
      // 此后的 mkdir/目标解析/写入/记账均为同步段，无再让出窗口；目录
      // 创建也统一在租约终检之后（提前建目录同样是共享 staging 变更）。
      this.assertRunLeaseActive(context);
      options?.recheck?.();
      // Leader steer（Advisor 不变量补强·基线漂移守卫）：冻结集合重核之外，
      // 还须证明旧声明/索引基线未在装配 await 期间漂移——声明锁串行本构建
      // 的全部声明写者（kb_write_doc/kb_edit_doc/审查回写），合法路径不会
      // 漂移；但任何绕锁写者造成的漂移若被放行，本次整包保存会覆盖其登记
      // 变更（丢失更新），冻结影响面也建立在旧基线上（不能重核旧集合却
      // 漏掉基线已变的新旧族）。提交段重读当前登记与装配起点基线逐字比对，
      // 漂移即拒绝（不静默合并/覆盖；调用方重读草稿后重提）。
      if (declaration?.baselineSignature) {
        const currentDraft = this.loadKnowledgeDraft(state);
        if (JSON.stringify(currentDraft) !== declaration.baselineSignature) {
          throw new ToolError(
            'kb_declaration_baseline_drifted',
            `文档 ${docPath} 的声明基线在装配期间已被其他写者修改（knowledge-draft 登记/索引漂移）；请重读草稿后基于最新基线重提，本次不覆盖他人登记`,
            409,
          );
        }
      }
      // F03-R1：声明影响面授权提交期重核——recheck 只重检 ctx 与目标文档
      // 分配，但本次声明的完整影响面（族排他 + 跨路径迁移旧主路径授权）
      // 可能在上方 await 让出窗口内被 Leader 转移/撤回；装配期检查不足以
      // 代表提交时点。本检查与后续写入同为同步段（见方法注释），与分配
      // 变更不再交错形成窗口。kb_write_doc / kb_edit_doc（含继承声明重申）
      // 全部经本段，单一收口。旧模式无 v2 凭据时内部不设防（行为不变）。
      if (declaration?.authImpact) {
        this.assertDeclarationImpactAuthorized(context, meta, declaration.authImpact);
      }
      if (parentRel) {
        resolveInside(path.join(state.stagingRoot, 'docs'), parentRel, 'mkdir');
      }
      const target = resolveInside(path.join(state.stagingRoot, 'docs'), docPath, 'write');
      // T3（A 案 §7.1）：草稿与知识声明同代写入——正文成功而声明持久化失败
      // 时整体失败（毒化构建，不部分写入），先留旧字节快照供回滚。
      const previousBytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
      atomicWriteFile(target, full);
      if (declaration) {
        declaration.draft.docs[docPath] = { docId, revision: declaration.draftRevision, bodyLineOffset, basis: 'draft' };
        const bytes = Buffer.byteLength(full, 'utf-8');
        if (meta?.toolCallId) {
          declaration.draft.calls[meta.toolCallId] = {
            path: docPath,
            at: new Date().toISOString(),
            draftRevision: declaration.draftRevision,
            docId,
            bytes,
            objectIdMap: declaration.objectIdMap,
            evidenceIdMap: declaration.evidenceIdMap,
            // F06：原子落盘时记录稳定语义载荷哈希（同 v2 回执同口径），
            // 供回执丢失后的崩溃重放核验；非 v2 调用不记录（旧语义不变）。
            ...(options?.idempotency ? { payloadHash: options.idempotency.payloadHash } : {}),
          };
        }
        try {
          this.saveKnowledgeDraft(state, declaration.draft);
        } catch (error) {
          // 回滚正文，不部分写入；回滚本身失败则保持毒化由批循环终止
          try {
            if (previousBytes === null) removeFileInside(path.join(state.stagingRoot, 'docs'), docPath);
            else atomicWriteFile(target, previousBytes);
          } catch { /* 已尽力回滚 */ }
          const message = `知识声明持久化失败（构建已毒化）: ${error instanceof Error ? error.message : String(error)}`;
          state.poisoned = { code: 'kb_declaration_write_failed', message };
          throw new ToolError('kb_declaration_write_failed', message, 500);
        }
      }
      state.writtenPaths?.add(docPath);
      state.docMeta?.set(docPath, { title, summary, tags, sources: sources as string[] });
      return {
        content: [{
          type: 'text',
          text: `已写入草稿 ${docPath}（docId=${docId}，${full.length} 字节）`
            + (declaration ? `；知识声明：对象 ${Object.keys(declaration.objectIdMap).length}、证据 ${Object.keys(declaration.evidenceIdMap).length}、draftRevision=${declaration.draftRevision}` : ''),
        }],
        details: {
          path: docPath,
          docId,
          bytes: Buffer.byteLength(full, 'utf-8'),
          ...(declaration
            ? {
              draftRevision: declaration.draftRevision,
              objectMap: declaration.objectIdMap,
              evidenceMap: declaration.evidenceIdMap,
            }
            : {}),
        },
      };
    };
    return options?.lockHeld ? coreOperation() : this.withKnowledgeDeclarationLock(state, coreOperation);
  }

  private inheritDocId(state: BuildRunState, docPath: string): string | null {
    void state;
    // 增量继承由 KbBuildService 在构造 workset 时把旧 docId 写入
    // staging/.docid-map.json；此处读取。
    try {
      const mapPath = path.join(state.stagingRoot, '.docid-map.json');
      if (fs.existsSync(mapPath)) {
        const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, string>;
        return map[docPath] ?? null;
      }
    } catch {
      /* 解析失败视为无继承 */
    }
    return null;
  }

  private toolKbDeleteDoc(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): ToolResult {
    const state = requireBuildState(context);
    // T3（A 案 §7.1）：审查者没有任何草稿写入口
    this.assertNotReviewPhase(context);
    const docPath = requireString(args, 'path', 1, 600);
    // v2（设计 v2 §4.4）：删除同走受控写入链（幂等/分配）；旧模式不变
    const v2 = context.options.orchestration ?? null;
    let v2Info: { actor: NonNullable<ReturnType<BuildActorStore["lookupActor"]>>; operationId: string; payloadHash: string } | null = null;
    if (v2 && v2.credential === 'child') {
      const { actor } = this.requireV2Actor(context, meta);
      const operationId = requireString(args, 'operationId', 1, 200);
      const payloadHash = canonicalPayloadHash(args, ['operationId']);
      const replay = this.v2Replay(v2, actor.nativeTaskId, operationId, payloadHash);
      if (replay) return replay;
      this.assertV2OutputAssignment(v2, actor.nativeTaskId, docPath);
      v2Info = { actor, operationId, payloadHash };
    }
    // R2-04：与 kb_write_doc 同一合法规范路径门——`./`/反斜杠等别名在
    // 认领与触盘之前拒绝，防止用另一字符串认领却删除同一实际文件。
    validateStdDocPath(docPath);
    if (context.options.worker?.revision) {
      const draftFile = path.join(state.stagingRoot, 'knowledge-draft.json');
      if (state.knowledgeDraft || fs.existsSync(draftFile)) {
        const draft = this.loadKnowledgeDraft(state);
        if (draft.objects.some((object) => !object.tombstone && object.canonical?.path === docPath)) {
          throw new ToolError('kb_revision_delete_forbidden',
            `修订轮不能删除已登记知识对象的文档 ${docPath} 来绕过重申门禁；请用 draft_read(includeDeclarations=true) 读取原声明，再用 kb_write_doc 定向改写并重申全部对象`, 409);
        }
      }
    }
    // R2-F03-01（kb_delete_doc 授权影响面）：删除文档即移除该路径登记对象
    // 的规范主位——对象定义丢失虽由发布门禁 kb_migration_invalid 兜底，
    // 授权面在删除时点就须核：文档登记的对象族被其他活动任务独占分配时，
    // Doc 写权不覆盖 Family 排他（与 kb_write_doc 移出/删除旧族同判）。
    // 本工具无 await，核权与 removeFileInside 同处同步段（核权→落盘无
    // 窗口）；旧模式不设防（与写路径一致）。
    if (v2 && v2Info?.actor) {
      const deleterTaskId = v2Info.actor.nativeTaskId;
      const draftFile = path.join(state.stagingRoot, 'knowledge-draft.json');
      if (state.knowledgeDraft || fs.existsSync(draftFile)) {
        const draft = this.loadKnowledgeDraft(state);
        const familyObjectIds = new Map<string, string[]>();
        for (const object of draft.objects) {
          if (object.tombstone || object.canonical?.path !== docPath) continue;
          const list = familyObjectIds.get(object.familyKey) ?? [];
          list.push(object.objectId);
          familyObjectIds.set(object.familyKey, list);
        }
        for (const [familyKey, objectIds] of familyObjectIds) {
          const holder = v2.actorStore.activeFamilyAssignmentFor(familyKey);
          if (holder && holder.ownerTaskId !== deleterTaskId) {
            throw new ToolError(
              'kb_object_not_authorized',
              `文档 ${docPath} 登记了对象族 family:${familyKey} 的对象（${objectIds.join('、')}），该族已由任务 ${holder.ownerTaskId} 持有写入分配；任务 ${deleterTaskId} 不能以删除文档移除其对象，如需调整请 Leader 先收回/转移分配`,
              403,
            );
          }
        }
      }
    }
    // S4（§4.3）：删除同样受路径认领约束；收尾轮不受限
    this.assertPathClaim(context, state, docPath);
    removeFileInside(path.join(state.stagingRoot, 'docs'), docPath);
    if (v2 && v2Info?.actor) {
      this.v2RecordReceipt({ v2, nativeTaskId: v2Info.actor!.nativeTaskId, kind: 'delete_doc', operationId: v2Info.operationId, payloadHash: v2Info.payloadHash, paths: [docPath], result: { content: [{ type: 'text', text: `已删除草稿 ${docPath}` }] }, invalidateReviews: true });
    }
    return { content: [{ type: 'text', text: `已删除草稿 ${docPath}` }] };
  }

  /**
   * S4（§4.3）：单元轮的写路径必须先认领；他单元已持有 → 工具错误
   * kb_path_owned_by_other_unit（消息含所属文档标题，提示换路径）。
   * 收尾轮（phase='final'）与无 worker 上下文（非并行构建/单测直连）不受限。
   */
  private assertPathClaim(context: InternalRunContext, state: BuildRunState, docPath: string): void {
    const worker = context.options.worker;
    if (!state.claims || !worker || worker.phase !== 'unit' || !worker.unitId) return;
    const verdict = state.claims.claim(docPath, worker.unitId);
    if (verdict.ok) return;
    const title = state.docMeta?.get(docPath)?.title ?? docPath;
    const ownerUnit = state.units?.find((unit) => unit.id === verdict.owner);
    const ownerHint = ownerUnit
      ? `${verdict.owner}（源：${ownerUnit.sources.slice(0, 3).join('、')}${ownerUnit.sources.length > 3 ? '…' : ''}）`
      : verdict.owner;
    throw new ToolError(
      'kb_path_owned_by_other_unit',
      `路径 ${docPath}（文档「${title}」）由单元 ${ownerHint} 处理；请换一个路径，或留给该单元/收尾轮改写`,
      409,
    );
  }

  // ------------------------------------------------------------------
  // v2 编排（设计 v2 §4）：凭据代次 → 身份 → 角色 → 读写级的写入链
  // ------------------------------------------------------------------

  /** v2 统一前置门（executeTool 派发前）：代次/身份/角色/读写级。 */
  private assertV2Access(context: InternalRunContext, toolName: string, meta?: ToolRequestMeta): void {
    const v2 = context.options.orchestration!;
    // 1) 凭据代次（§4.1：取消或换代立即失效）
    try {
      v2.actorStore.assertGeneration(v2.generation);
    } catch (error) {
      throw wrapActorError(error);
    }
    if (v2.credential === 'leader') {
      // Leader 工具面：仅清单/分配/交接/问题/检查点/申请发布（§3.4）——
      // 不含正文与对象写工具，也不含应用 task 族（白名单本身不含）。
      if (!(V2_LEADER_TOOLS as readonly string[]).includes(toolName)) {
        throw new ToolError('tool_not_allowed', `v2 Leader 工具面不含 ${toolName}（Leader 无正文写工具与 task 族）`, 403);
      }
      return;
    }
    // 2) child：身份头必须存在（受信 env，§4.1 不采信模型参数）
    if (!meta?.amagiTaskId) {
      throw new ToolError('amagi_task_missing', '子任务凭据必须携带任务身份头（X-Amagi-Task-Id，来自 AMAGI_TASK_ID）', 401);
    }
    // 3) 身份状态：桥接先于创建事件 → pending 只读
    const actor = v2.actorStore.lookupActor(meta.amagiTaskId)
      ?? v2.actorStore.ensurePendingIdentity(meta.amagiTaskId, meta.amagiAgent);
    if (actor.status === 'revoked') {
      throw new ToolError('actor_revoked', `任务 ${meta.amagiTaskId} 写入资格已撤销（${actor.revokedReason ?? 'revoked'}）`, 401);
    }
    if (actor.status === 'pending') {
      if (!(V2_CHILD_READ_TOOLS as readonly string[]).includes(toolName)) {
        throw new ToolError('actor_pending', `任务 ${meta.amagiTaskId} 身份待确认（创建事件未到达）：当前只能使用只读工具`, 403);
      }
      return;
    }
    // 4) confirmed：角色一致（AMAGI_AGENT vs 登记角色）与角色工具面
    if (meta.amagiAgent !== undefined && actor.role !== meta.amagiAgent) {
      throw new ToolError('actor_role_mismatch', `桥接角色 ${meta.amagiAgent} 与登记角色 ${actor.role} 不一致，拒绝调用`, 403);
    }
    const toolset = v2.actorStore.roleToolset(actor.role);
    if (!toolset) {
      throw new ToolError('actor_role_unknown', `角色不在构建角色表内: ${actor.role}`, 403);
    }
    if (!toolset.tools.includes(toolName)) {
      throw new ToolError('tool_not_allowed', `角色 ${actor.role} 工具面不含 ${toolName}`, 403);
    }
    // 5) 写入类工具：发布校验窗口内拒绝新写入（§5.4）
    if (toolset.writeTools.includes(toolName)) {
      const window = v2.actorStore.publishing;
      if (window) {
        throw new ToolError('build_publishing', `发布校验进行中（requestId=${window.requestId}），新写入被拒；稍后重试`, 409);
      }
    }
  }

  /** v2 写工具身份（前置门已过；返回已确认 actor 供写入链使用）。 */
  private requireV2Actor(context: InternalRunContext, meta: ToolRequestMeta | undefined): { v2: OrchestrationV2Options; actor: NonNullable<ReturnType<BuildActorStore["lookupActor"]>> } {
    const v2 = context.options.orchestration!;
    if (v2.credential !== 'child' || !meta?.amagiTaskId) {
      throw new ToolError('amagi_task_missing', 'v2 写入需要子任务身份头（X-Amagi-Task-Id）', 401);
    }
    try {
      const actor = v2.actorStore.requireConfirmedActor(meta.amagiTaskId, meta.amagiAgent);
      return { v2, actor };
    } catch (error) {
      throw wrapActorError(error);
    }
  }

  /** v2 输出分配校验（§4.2：写入前检查分配；未分配可重试 409）。 */
  private assertV2OutputAssignment(v2: OrchestrationV2Options, nativeTaskId: string, docPath: string): void {
    try {
      v2.actorStore.assertOutputAssignment(nativeTaskId, docPath);
    } catch (error) {
      throw wrapActorError(error);
    }
  }

  /** F03：对象声明影响面授权守卫。v2 child 凭据 + 受信身份头时返回
   * 检查器；旧模式/无身份 → null（不设防，既有迁移行为不变）。上游
   * requireV2Actor 已确认身份；此处只取授权面，不重复身份校验。 */
  private v2DeclarationAuth(context: InternalRunContext, meta: ToolRequestMeta | undefined): { store: BuildActorStore; nativeTaskId: string } | null {
    const v2 = context.options.orchestration;
    if (!v2 || v2.credential !== 'child' || !meta?.amagiTaskId) return null;
    return { store: v2.actorStore, nativeTaskId: meta.amagiTaskId };
  }

  /** F03-R1（对象影响面授权提交期重核）：装配期（buildKnowledgeDeclaration
   * 对象段的族排他与跨路径迁移检查）与最终落盘之间存在异步声明准备窗口
   * （工作簿/图片证据装配 await 让出）；Leader 可在窗口内经 assignOutputs/
   * revokeOutputs 把族转移给他人或撤回旧主路径授权，在途声明若按装配期
   * 快照放行即越权落盘。本方法在同步提交段对装配期记录的完整影响面
   * （DeclarationAuthImpact）重新核权，判据与装配期完全一致：
   * - 族排他：family 活动持有人不得已变为他人（覆盖新族与被移出/
   *   删除对象的旧族，同一完整冻结集合）；
   * - 跨路径迁移：旧主定义文档或对象族的授权必须仍有效。
   * 合法显式授权迁移保留（窗口内把族转给写者本人 → 持有人=本人，放行）；
   * 旧模式（无 v2 child 凭据）不设防，既有迁移行为不变。本检查之后的
   * mkdir/原子写入/声明持久化均为同步段，与 Leader 的分配变更（同步
   * 方法）不再交错——权限转移与提交不形成新窗口。 */
  private assertDeclarationImpactAuthorized(
    context: InternalRunContext,
    meta: ToolRequestMeta | undefined,
    impact: DeclarationAuthImpact,
  ): void {
    if (impact.familyKeys.length === 0 && impact.crossPathMigrations.length === 0) return;
    const auth = this.v2DeclarationAuth(context, meta);
    if (!auth) return; // 旧模式/Leader 凭据：不设防（与装配期一致）
    for (const familyKey of impact.familyKeys) {
      const holder = auth.store.activeFamilyAssignmentFor(familyKey);
      if (holder && holder.ownerTaskId !== auth.nativeTaskId) {
        throw new ToolError(
          'kb_object_not_authorized',
          `对象族 family:${familyKey} 已由任务 ${holder.ownerTaskId} 持有写入分配（声明准备期间归属已变化），任务 ${auth.nativeTaskId} 的本次提交拒绝落盘；如需调整归属请 Leader 先收回/转移分配`,
          403,
        );
      }
    }
    for (const migration of impact.crossPathMigrations) {
      const authorized = auth.store.authorizedForDeclarationTarget(
        auth.nativeTaskId,
        { docPath: migration.priorPath, familyKey: migration.familyKey },
      );
      if (!authorized) {
        throw new ToolError(
          'kb_object_not_authorized',
          `对象 ${migration.clientKey}（${migration.objectId}）主定义登记于 ${migration.priorPath}，任务 ${auth.nativeTaskId} 对该文档或对象族 family:${migration.familyKey} 的写入分配已在声明准备期间失效；跨路径重申/迁移需 Leader 先 build_assign_output 显式授权`,
          403,
        );
      }
    }
  }

  /** v2 幂等预检（§4.4）：同键同载荷重放原回执，同键异载荷拒绝。 */
  private v2Replay(v2: OrchestrationV2Options, nativeTaskId: string, operationId: string, payloadHash: string): ToolResult | null {
    try {
      const prior = v2.actorStore.replayReceipt(
        deriveIdempotencyKey(v2.actorStore.buildId, v2.generation, nativeTaskId, operationId),
        payloadHash,
      );
      return prior ? replayReceiptToolResult(prior) : null;
    } catch (error) {
      throw wrapActorError(error);
    }
  }

  /** v2 写入链后置（§4.4）：成果回执 + 受影响路径审查失效（§4.3）。 */
  private v2RecordReceipt(input: {
    v2: OrchestrationV2Options;
    nativeTaskId: string;
    kind: 'write_doc' | 'edit_doc' | 'delete_doc' | 'handoff' | 'review';
    operationId: string;
    payloadHash: string;
    paths: string[];
    result: ToolResult;
    invalidateReviews?: boolean;
  }): void {
    input.v2.actorStore.recordReceipt({
      authorTaskId: input.nativeTaskId,
      kind: input.kind,
      operationId: input.operationId,
      payloadHash: input.payloadHash,
      paths: input.paths,
      result: { content: input.result.content, ...(input.result.details ? { details: input.result.details } : {}) },
    });
    if (input.invalidateReviews && input.paths.length > 0) {
      input.v2.actorStore.invalidateReviewsForPaths(input.paths, 'content_revised');
    }
  }

  /** S4（§4.4）：逐单元上报；objToken 须属本单元；重复调用以最后一次为准。 */
  private toolKbUnitDone(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    const worker = context.options.worker;
    if (!worker || !worker.unitId || worker.phase !== 'unit') {
      throw new ToolError('invalid_request', 'kb_unit_done 仅在构建单元轮可用（收尾轮请用 kb_finish）', 400);
    }
    const unit = state.units?.find((candidate) => candidate.id === worker.unitId) ?? null;
    const summary = requireString(args, 'summary', 1, 2000);
    const skipped = parseSkippedList(args.skipped);
    for (const item of skipped) {
      if (!unit || !unit.sources.includes(item.objToken)) {
        throw new ToolError('invalid_request', `skipped 来源不在本单元内: ${item.objToken}`);
      }
    }
    state.unitDone ??= new Map();
    state.unitDone.set(worker.unitId, { summary, skipped });
    return {
      content: [{ type: 'text', text: `单元 ${worker.unitId} 标记完成：${summary.slice(0, 100)}（skipped ${skipped.length}）` }],
      details: { unitId: worker.unitId, skipped: skipped.length },
    };
  }

  private toolKbFinish(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    // S4（§4.4/U8）：kb_finish 保持单值，只在唯一收尾轮可用
    const worker = context.options.worker;
    if (worker && worker.phase !== 'final') {
      throw new ToolError(
        'kb_finish_not_allowed_in_unit',
        '当前是单元处理轮：请先调用 kb_unit_done 结束本单元；kb_finish 只在全部单元完成后的收尾轮可用',
        400,
      );
    }
    if (state.finishInfo) {
      throw new ToolError('invalid_request', 'kb_finish 已调用过');
    }
    const summary = requireString(args, 'summary', 1, 4000);
    const skipped = parseSkippedList(args.skipped);
    for (const item of skipped) {
      if (!state.snapshot.has(item.objToken)) {
        throw new ToolError('invalid_request', `skipped 来源不在快照内: ${item.objToken}`);
      }
    }
    const docMerges: Array<{ path: string; mergedInto: string[] }> = [];
    if (args.docMerges !== undefined) {
      if (!Array.isArray(args.docMerges) || args.docMerges.length > 100) throw new ToolError('invalid_request', 'docMerges 必须是至多 100 项的数组');
      const seen = new Set<string>();
      for (const item of args.docMerges) {
        if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !Array.isArray(item.mergedInto)
          || !item.mergedInto.length || item.mergedInto.length > 20 || !item.mergedInto.every((p: unknown) => typeof p === 'string')) {
          throw new ToolError('invalid_request', 'docMerges 每项须提供 path 与非空 mergedInto 路径数组');
        }
        validateStdDocPath(item.path);
        if (state.baseDocPaths && !state.baseDocPaths.has(item.path)) throw new ToolError('invalid_request', '合并的旧路径不在构建基准版本中');
        if (seen.has(item.path)) throw new ToolError('invalid_request', 'docMerges 旧路径不可重复');
        seen.add(item.path);
        if (fs.existsSync(path.join(state.stagingRoot, 'docs', item.path))) throw new ToolError('invalid_request', '合并前的旧路径仍存在，请先删除旧草稿');
        const targets = [...new Set<string>(item.mergedInto)];
        for (const target of targets) {
          validateStdDocPath(target);
          if (target === item.path || !fs.statSync(resolveInside(path.join(state.stagingRoot, 'docs'), target, 'read')).isFile()) throw new ToolError('invalid_request', '合并目标必须是本版存在的文档');
        }
        docMerges.push({ path: item.path, mergedInto: targets });
      }
    }
    state.finishInfo = { summary, skipped, ...(docMerges.length ? { docMerges } : {}) };
    return { content: [{ type: 'text', text: `构建标记完成：${summary.slice(0, 100)}` }] };
  }

  // ------------------------------------------------------------------
  // T3：知识协议（A 案 §7.1/§7.2）——声明解析、组织计划、审查提交
  // ------------------------------------------------------------------

  /** 审查轮没有任何草稿写入口（A 案 §7.1）；规划轮同样无草稿写入口
   *（D5，B 案 §3：规划者只提交计划建议，「规划者不能自行增加并发、
   * 跳过审查或决定发布」，也没有草稿写面）。 */
  private assertNotReviewPhase(context: InternalRunContext): void {
    const phase = context.options.worker?.phase;
    if (phase === 'review') {
      throw new ToolError('kb_review_readonly', '审查者没有任何草稿写入口；草稿修订由撰写/整合轮提交', 403);
    }
    if (phase === 'plan') {
      throw new ToolError('kb_plan_readonly', '规划者没有任何草稿写入口：只读源材料并经 kb_submit_plan 提交计划建议；草稿由撰写单元按冻结计划写入', 403);
    }
  }

  private loadKnowledgeDraft(state: BuildRunState, buildId = 'unknown'): KnowledgeDraftFile {
    if (state.knowledgeDraft) return state.knowledgeDraft;
    const file = path.join(state.stagingRoot, 'knowledge-draft.json');
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as KnowledgeDraftFile;
        if (parsed && parsed.schemaVersion === 1) {
          state.knowledgeDraft = parsed;
          return parsed;
        }
      } catch {
        /* 损坏时重建（staging 内声明产物；正文真相不受影响） */
      }
    }
    const fresh: KnowledgeDraftFile = {
      schemaVersion: 1,
      buildId,
      docs: {},
      clientKeys: {},
      evidenceKeys: {},
      objects: [],
      presentations: [],
      relations: [],
      evidence: [],
      coverage: [],
      calls: {},
    };
    state.knowledgeDraft = fresh;
    return fresh;
  }

  private saveKnowledgeDraft(state: BuildRunState, draft: KnowledgeDraftFile): void {
    fs.mkdirSync(state.stagingRoot, { recursive: true });
    atomicWriteFile(path.join(state.stagingRoot, 'knowledge-draft.json'), `${JSON.stringify(draft, null, 2)}\n`);
    state.knowledgeDraft = draft;
  }

  /**
   * diting S-F01（构建级互斥队列）：同 build 的「读取当前声明→并发/计划
   * 复核→正文与声明提交」临界区串行执行；跨 build 不相互阻塞（锁住在
   * 共享 BuildRunState 上）。必须覆盖 bodyRange 计算与声明保存的全过程
   *（含 buildKnowledgeDeclaration 内工作簿/图片证据装配的 await 让出
   * 窗口）——否则先读取共享 knowledgeDraft 深拷贝的 worker 会在返回后把
   * 旧副本整包覆盖回去，丢失并发 worker 的 docs/objects/evidence/
   * clientKeys/calls 登记与审查凭据回写。所有修改共享登记/审查凭据的
   * 写者（kb_write_doc 声明段、markObjectsMachineReviewed）共用本机制。
   */
  private async withKnowledgeDeclarationLock<T>(state: BuildRunState, operation: () => Promise<T> | T): Promise<T> {
    const prior = state.knowledgeDeclarationQueue ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.knowledgeDeclarationQueue = prior.then(() => gate);
    await prior;
    try {
      return await operation();
    } finally {
      release(); // 前一临界区失败也必然放行后续排队者（不毒化队列）
    }
  }

  private loadOrganizationPlan(state: BuildRunState, buildId = 'unknown'): OrganizationPlanFile {
    if (state.organizationPlan) return state.organizationPlan;
    const file = path.join(state.stagingRoot, 'organization-plan.json');
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as OrganizationPlanFile;
        if (parsed && parsed.schemaVersion === 1) {
          state.organizationPlan = parsed;
          return parsed;
        }
      } catch {
        /* 损坏时重建 */
      }
    }
    const fresh: OrganizationPlanFile = {
      schemaVersion: 1,
      buildId,
      planId: `kplan_${crypto.randomBytes(6).toString('hex')}`,
      planRevision: 0,
      docs: [],
      objects: [],
      dependencies: [],
      migrations: [],
      updatedAt: new Date().toISOString(),
    };
    state.organizationPlan = fresh;
    return fresh;
  }

  private saveOrganizationPlan(state: BuildRunState, plan: OrganizationPlanFile): void {
    fs.mkdirSync(state.stagingRoot, { recursive: true });
    atomicWriteFile(path.join(state.stagingRoot, 'organization-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    state.organizationPlan = plan;
  }

  /**
   * T3（A 案 §7.1/§7.4）：知识声明解析与写入即拒校验。在正文落盘前完成
   * 全部校验，任何拒绝都不产生部分写入。错误码复用 knowledge-schema 的
   * kb_* 系列；ID 全部 server 预分配，模型自报的 approved/passed/reviewer
   * 等字段不在入参面，永远不会被读取。
   */
  private async buildKnowledgeDeclaration(
    context: InternalRunContext,
    state: BuildRunState,
    base: KnowledgeDraftFile,
    docPath: string,
    docId: string,
    args: Record<string, unknown>,
    markdown: string,
    meta?: ToolRequestMeta,
    objectMerges: readonly { fromObjectId: string; toObjectId: string }[] = [],
  ): Promise<{
    draft: KnowledgeDraftFile;
    objectIdMap: Record<string, string>;
    evidenceIdMap: Record<string, string>;
    draftRevision: number;
    /** F03-R1：本次声明的授权影响面（装配期记录，提交期重核）。 */
    authImpact: DeclarationAuthImpact;
    /** Leader steer（Advisor 不变量补强·基线漂移守卫）：装配起点旧声明
     * 基线的规范串——提交段重读当前登记比对，检测装配 await 期间绕过
     * 声明锁的登记/索引漂移（拒绝/重提，不静默覆盖）。 */
    baselineSignature: string;
  }> {
    // F03（对象声明影响面授权）：v2 child + 受信身份时启用守卫；旧模式
    // 不设防（既有迁移机制保留，行为不变）。守卫在 priorId 决策点执行，
    // 与实际写入的对象登记同源（不另建一份解析）。
    const declarationAuth = this.v2DeclarationAuth(context, meta);
    const draft: KnowledgeDraftFile = JSON.parse(JSON.stringify(base)) as KnowledgeDraftFile;
    // Leader steer：装配起点旧声明基线签名（本函数不 mutate base；提交段
    // 与重读的当前登记比对，判据见 writeDocCore 终检段）。基线串只用于
    // 逐字比对，不参与任何授权判定。
    const baselineSignature = JSON.stringify(base);
    const markdownLines = markdown.split('\n');

    // ---- 乐观并发与计划一致性（A 案 §7.1）----
    const currentRevision = draft.docs[docPath]?.revision ?? 0;
    if (args.expectedDraftRevision !== undefined) {
      const expected = optionalInt(args, 'expectedDraftRevision', currentRevision, 0, 1_000_000_000);
      if (expected !== currentRevision) {
        throw new ToolError(
          'kb_draft_revision_conflict',
          `expectedDraftRevision=${expected} 与当前草稿修订 ${currentRevision} 不符（不覆盖并行成果，请重读草稿后基于最新修订重提）`,
          409,
        );
      }
    }
    const draftRevision = currentRevision + 1;
    if (args.planId !== undefined) {
      const planId = requireString(args, 'planId', 1, 128);
      const plan = this.loadOrganizationPlan(state);
      if (plan.planRevision > 0 && plan.planId !== planId) {
        throw new ToolError('kb_plan_revision_conflict', `planId=${planId} 与当前组织计划 ${plan.planId} 不符`, 409);
      }
    }
    draft.docs[docPath] = { docId, revision: draftRevision };

    // ---- 对象声明（A 案 §2）：scopeKey 必填、family 三元组唯一、alias 无歧义 ----
    const objectInputs = args.objects === undefined ? [] : requireArray(args, 'objects');
    const newObjects: KnowledgeObject[] = [];
    const objectIdMap: Record<string, string> = {};
    const submissionClientKeys = new Map<string, string>();
    const existingById = new Map(draft.objects.map((object) => [object.objectId, object] as const));
    // F03-R1：装配期记录本次声明的授权影响面——族排他与跨路径迁移检查在
    // 本段通过后，后续证据装配（工作簿/图片/资源解引用）还会 await 让出；
    // 最终同步提交段对以下记录重核（assertDeclarationImpactAuthorized）。
    const impactFamilyKeys = new Set<string>();
    const impactCrossPath: DeclarationAuthImpact['crossPathMigrations'] = [];
    // R2-F03-01：完整影响面还含旧族——同路径重申把既有对象移出旧族
    // （familyKey 变更）与未重申对象的删除（含 objects:[] 整体删除）都
    // 改写旧族对象面；先按旧族归并受影响对象键，装配期统一核权后并入
    // 冻结集合（与新族同一判据）。
    const impactPriorFamilies = new Map<string, string[]>();
    for (const raw of objectInputs) {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', 'objects 每项必须是对象');
      const clientKey = requireString(input, 'clientKey', 1, 200);
      if (submissionClientKeys.has(clientKey)) throw new ToolError('invalid_request', `objects.clientKey 重复: ${clientKey}`);
      const type = requireString(input, 'type', 1, 40);
      if (!KNOWLEDGE_OBJECT_TYPES.has(type as KnowledgeObjectType)) {
        throw new ToolError('invalid_request', `对象类型非法: ${type}（六类型见 A 案 §2.1）`);
      }
      const title = requireString(input, 'title', 1, 300);
      const familyKey = requireString(input, 'familyKey', 1, 200);
      const variantKey = requireString(input, 'variantKey', 1, 200);
      const scopeKey = typeof input.scopeKey === 'string' && input.scopeKey.trim() ? input.scopeKey : '';
      if (!scopeKey) {
        throw new ToolError('kb_scope_unresolved', `对象 ${clientKey} 缺 scopeKey（每对象必填，unknown 范围不得用于 operational 答案）`);
      }
      const scopeText = requireString(input, 'scopeText', 1, 2000);
      const aliases = optStrArray(input, 'aliases') ?? [];
      const domainIds = optStrArray(input, 'domainIds') ?? [];
      // 主位置：headingPath 唯一解析 / 显式 bodyRange / 全文（A 案 §7.1：以输入
      // Markdown 为坐标；发布 bodyRange 由 server 插入锚点后重算）
      const headingPath = optStrArray(input, 'headingPath');
      let bodyRange: BodyRange;
      if (headingPath && headingPath.length > 0) {
        const occurrence = optionalInt(input, 'occurrence', 1, 1, 1000);
        const resolved = resolveHeadingBodyRange(markdownLines, headingPath, occurrence);
        if (!resolved) {
          throw new ToolError('kb_canonical_missing', `headingPath 未在提交正文中命中: ${headingPath.join(' > ')}#${occurrence}`);
        }
        bodyRange = resolved;
      } else if (asRecord(input.bodyRange)) {
        bodyRange = parseBodyRange(input.bodyRange);
        if (bodyRange.startLine < 1 || bodyRange.endLine > markdownLines.length) {
          throw new ToolError('invalid_request', `对象 ${clientKey} bodyRange 超出正文范围（1..${markdownLines.length}）`);
        }
      } else {
        bodyRange = { startLine: 1, endLine: markdownLines.length };
      }
      // ID：同 clientKey 更新同一身份；另：同 family 三元组命中基线登记
      // 也沿用该 objectId（diting F06：基线对象注册参与增量/full 初始化，
      // 未变对象不重声明、身份不重生成；跨路径迁移保留 objectId，A 案 §2.3）
      const priorId = draft.clientKeys[clientKey]
        ?? draft.objects.find((object) => !object.tombstone
          && object.familyKey === familyKey && object.variantKey === variantKey
          && object.scopeKey === scopeKey)?.objectId
        ?? null;
      const objectId = priorId ?? `ko_${crypto.randomUUID()}`;
      // F03（对象影响面授权·跨路径重申）：clientKey/三元组命中既有对象且
      // 其主定义在他人文档 → 本声明会改写该对象登记（canonical 迁移到
      // 本文档）。要求写者对旧主定义文档或该对象族持有当前分配（Leader
      // 显式授权），否则拒绝——不能仅凭自己文档的分配夺取他人对象身份。
      if (declarationAuth && priorId != null) {
        const priorRegistration = existingById.get(priorId) ?? null;
        if (priorRegistration && !priorRegistration.tombstone && priorRegistration.canonical?.path) {
          if (priorRegistration.canonical.path !== docPath) {
            const authorized = declarationAuth.store.authorizedForDeclarationTarget(
              declarationAuth.nativeTaskId,
              { docPath: priorRegistration.canonical.path, familyKey: priorRegistration.familyKey },
            );
            if (!authorized) {
              throw new ToolError(
                'kb_object_not_authorized',
                `对象 ${clientKey}（${objectId}）主定义登记于 ${priorRegistration.canonical.path}，任务 ${declarationAuth.nativeTaskId} 未持有该文档或对象族 family:${priorRegistration.familyKey} 的写入分配；跨路径重申/迁移需 Leader 先 build_assign_output 显式授权`,
                403,
              );
            }
            impactCrossPath.push({
              clientKey,
              objectId,
              priorPath: priorRegistration.canonical.path,
              familyKey: priorRegistration.familyKey,
            });
          }
          if (priorRegistration.familyKey !== familyKey) {
            // 移出旧族与canonical迁移是正交影响：即使跨path已通过旧Doc授权，
            // 同时改族仍须核旧族；Doc通道不能覆盖旧族被他人独占的排他权。
            // familyKey 改为另一族——对象身份保留、族归属变更，
            // 旧族对象面被改写。旧族入影响面（装配期/提交期均要求其活动
            // 持有人为空或本人；本文档的 Doc 写权不覆盖 Family 排他）。
            const list = impactPriorFamilies.get(priorRegistration.familyKey) ?? [];
            list.push(clientKey);
            impactPriorFamilies.set(priorRegistration.familyKey, list);
          }
        }
      }
      // F03（对象影响面授权·族排他）：声明的 familyKey 已被其他活动任务
      // 独占分配时，本声明（新对象入族或既有对象重申）改写该族对象面，
      // 拒绝；未分配的族不设限（常规新对象声明路径不变）。
      const familyHolder = declarationAuth
        ? declarationAuth.store.activeFamilyAssignmentFor(familyKey)
        : null;
      if (familyHolder && familyHolder.ownerTaskId !== declarationAuth?.nativeTaskId) {
        throw new ToolError(
          'kb_object_not_authorized',
          `对象族 family:${familyKey} 已由任务 ${familyHolder.ownerTaskId} 持有写入分配，任务 ${declarationAuth?.nativeTaskId} 不能在该族内声明对象（${clientKey}）；如需调整归属请 Leader 先收回/转移分配`,
          403,
        );
      }
      impactFamilyKeys.add(familyKey);
      for (const other of [...draft.objects, ...newObjects]) {
        if (other.objectId === objectId) continue;
        if (other.familyKey === familyKey && other.variantKey === variantKey && other.scopeKey === scopeKey) {
          throw new ToolError('kb_object_duplicate',
            `同 familyKey+variantKey+scopeKey 重复登记: ${clientKey} 与 ${other.objectId}（${familyKey}/${variantKey}/${scopeKey}）`);
        }
      }
      for (const alias of aliases) {
        for (const other of [...draft.objects, ...newObjects]) {
          if (other.objectId === objectId) continue;
          if ((other.aliases ?? []).includes(alias)) {
            throw new ToolError('kb_object_duplicate', `alias 歧义指向多对象: ${alias} → ${objectId} 与 ${other.objectId}`);
          }
        }
      }
      const claimInputs = input.claims === undefined ? [] : requireArray(input, 'claims');
      const claims: Claim[] = [];
      const seenClaimKeys = new Set<string>();
      for (const rawClaim of claimInputs) {
        const claimInput = asRecord(rawClaim);
        if (!claimInput) throw new ToolError('invalid_request', 'claims 每项必须是对象');
        const claimKey = requireString(claimInput, 'claimKey', 1, 200);
        if (seenClaimKeys.has(claimKey)) throw new ToolError('invalid_request', `claimKey 重复: ${claimKey}`);
        seenClaimKeys.add(claimKey);
        const riskCategory = claimInput.riskCategory === 'high' ? 'high' : 'normal';
        // claim 记录正文精确范围（A 案 §5.2）；未显式给出时缺省为对象正文范围
        let claimRange: BodyRange = bodyRange;
        if (asRecord(claimInput.bodyRange)) {
          claimRange = parseBodyRange(claimInput.bodyRange);
          if (claimRange.startLine < 1 || claimRange.endLine > markdownLines.length) {
            throw new ToolError('invalid_request', `claim ${claimKey} bodyRange 超出正文范围`);
          }
        }
        claims.push({ claimKey, bodyRange: claimRange, riskCategory, evidenceIds: [] });
      }
      const payloadBody = markdownLines.slice(bodyRange.startLine - 1, bodyRange.endLine).join('\n');
      const prior = existingById.get(objectId) ?? null;
      const draftObject: KnowledgeObject = {
        objectId,
        type: type as KnowledgeObjectType,
        title,
        aliases,
        domainIds,
        familyKey,
        variantKey,
        scopeKey,
        scopeText,
        // 锚点由 server 生成（受限 ko_ 形态）；模型不写 HTML（A 案 §2.4）
        canonical: { docId, path: docPath, anchor: objectId, bodyRange },
        revision: 1,
        locationRevision: 0,
        payloadHash: '',
        reviewSubjectHash: '',
        businessStatus: 'unknown',
        reviewStatus: 'pending',
        claims,
      };
      draftObject.payloadHash = computePayloadHash(draftObject, payloadBody);
      if (prior) {
        draftObject.revision = prior.payloadHash === draftObject.payloadHash ? prior.revision : prior.revision + 1;
        const moved = prior.canonical?.docId !== docId || prior.canonical?.path !== docPath;
        draftObject.locationRevision = moved ? prior.locationRevision + 1 : prior.locationRevision;
      }
      newObjects.push(draftObject);
      objectIdMap[clientKey] = objectId;
      submissionClientKeys.set(clientKey, objectId);
    }
    // 同路径未重新声明的旧对象移除（连同其 clientKey 登记）；重声明对象替换。
    // R2-F03-01（objects:[] 删除）：未重申被移除的对象若登记于某旧族，删除
    // 同样改写该族对象面——旧族并入影响面（整体 objects:[] 与部分遗漏重申
    // 两种形态同判）。
    const touchedIds = new Set(newObjects.map((object) => object.objectId));
    const removedIds = new Set<string>();
    for (const object of draft.objects) {
      if (object.canonical?.path === docPath && !touchedIds.has(object.objectId)) {
        removedIds.add(object.objectId);
        if (!object.tombstone && declarationAuth) {
          const list = impactPriorFamilies.get(object.familyKey) ?? [];
          list.push(object.objectId);
          impactPriorFamilies.set(object.familyKey, list);
        }
      }
    }
    for (const merge of objectMerges) {
      if (!removedIds.has(merge.fromObjectId)) {
        throw new ToolError('kb_object_merge_invalid', `待合并对象未从本篇声明移除: ${merge.fromObjectId}`, 409);
      }
      if (!draft.objects.some((object) => !object.tombstone && object.objectId === merge.toObjectId
        && !removedIds.has(object.objectId))) {
        throw new ToolError('kb_object_merge_invalid', `后继对象不存在或将被移除: ${merge.toObjectId}`, 409);
      }
      for (const item of draft.coverage) {
        if (!item.targetObjectIds.includes(merge.fromObjectId)) continue;
        item.targetObjectIds = [...new Set(item.targetObjectIds.map((id) =>
          id === merge.fromObjectId ? merge.toObjectId : id))];
      }
    }
    // R2-F03-01 装配期旧族排他核权（判据与新族一致，均在任何证据装配
    // await 之前的同步段）：移出/删除的旧族被其他活动任务独占分配 →
    // 拒绝；未分配或本人持有放行（合法移族/删除由 Leader 显式授权或族
    // 未分配时保留，不靠禁用功能解决）。核权通过后旧族并入冻结集合，
    // 提交段（assertDeclarationImpactAuthorized）同判重核。
    if (declarationAuth) {
      for (const [familyKey, affectedKeys] of impactPriorFamilies) {
        const holder = declarationAuth.store.activeFamilyAssignmentFor(familyKey);
        if (holder && holder.ownerTaskId !== declarationAuth.nativeTaskId) {
          throw new ToolError(
            'kb_object_not_authorized',
            `对象族 family:${familyKey} 已由任务 ${holder.ownerTaskId} 持有写入分配，任务 ${declarationAuth.nativeTaskId} 的本次改写将移出/删除该族对象（${affectedKeys.join('、')}）；如需调整归属请 Leader 先收回/转移分配`,
            403,
          );
        }
        impactFamilyKeys.add(familyKey);
      }
    }
    // 覆盖映射在收尾轮已经提交。改写正文时若把原对象换成新 ID，旧映射
    // 会一直悬空，直到发布门禁才报错；在写入点拒绝这种身份漂移。
    const referencedRemovedIds = [...removedIds].filter((id) =>
      draft.coverage.some((item) => item.disposition === 'mapped' && item.targetObjectIds?.includes(id)));
    if (referencedRemovedIds.length > 0) {
      throw new ToolError('kb_coverage_invalid',
        `改写 ${docPath} 会移除仍被覆盖映射引用的对象 ${referencedRemovedIds.join('、')}；请用 draft_read(includeDeclarations=true) 读取原 clientKey 并重申原对象`, 409);
    }
    draft.objects = draft.objects.filter((object) => !touchedIds.has(object.objectId) && !removedIds.has(object.objectId));
    for (const [clientKey, objectId] of Object.entries(draft.clientKeys)) {
      if (removedIds.has(objectId)) delete draft.clientKeys[clientKey];
    }
    draft.objects.push(...newObjects);
    for (const [clientKey, objectId] of submissionClientKeys) draft.clientKeys[clientKey] = objectId;

    // ---- 证据声明（A 案 §5.2/§5.3）：服务端重新解引用校验 ----
    const planForRefs = this.loadOrganizationPlan(state);
    const planObjectIdSet = new Set(planForRefs.objects.map((object) => object.objectId));
    const planClientKeys = new Map(planForRefs.objects.map((object) => [object.clientKey, object.objectId] as const));
    const resolveObjectRef = (key: string): string | null => {
      const mapped = submissionClientKeys.get(key) ?? draft.clientKeys[key] ?? planClientKeys.get(key);
      if (mapped) return mapped;
      if (key.startsWith('ko_') && (existingById.has(key) || touchedIds.has(key) || planObjectIdSet.has(key))) return key;
      return null;
    };
    const receipts: EvidenceReadReceipt[] = this.loadReadReceipts(state).map((receipt) => ({
      readReceiptId: receipt.readReceiptId,
      resourceId: receipt.resourceId,
      lineStart: receipt.selector.lineStart,
      lineEnd: receipt.selector.lineEnd,
    }));
    // D3（A 案 §5.2/§5.4）：工作簿/图片资源按引用懒装配（Promise 缓存防重入
    // ——工作簿解析是异步 ExcelJS 路径）；未被引用的源不额外解析，旧式
    // text/csv 行为字节级不变。
    const resourceCache = new Map<string, Promise<{ resources: EvidenceResource[]; sourceSnapshotHash: string }>>();
    const resourcesFor = (sourceId: string, referenced: ReadonlySet<string>): Promise<{ resources: EvidenceResource[]; sourceSnapshotHash: string }> => {
      const cached = resourceCache.get(sourceId);
      if (cached) return cached;
      const promise = (async (): Promise<{ resources: EvidenceResource[]; sourceSnapshotHash: string }> => {
        const entry = state.snapshot.get(sourceId);
        if (!entry) throw new ToolError('invalid_request', `来源不在快照内: ${sourceId}`);
        let verified;
        try {
          verified = state.snapshot.readVerified(state.knowledgeBaseRoot, sourceId);
        } catch (error) {
          if (error instanceof PathGuardError && error.code === 'source_changed_during_build') {
            state.poisoned = { code: error.code, message: error.message };
          }
          throw error;
        }
        const resources: EvidenceResource[] = [{
          resourceId: sourceId,
          kind: 'text',
          content: verified.content,
          sourceId,
          sourceSnapshotHash: entry.contentHash,
          resourceHash: contentResourceHash(verified.content),
        }];
        for (const attachment of verified.attachments) {
        const base = path.basename(attachment.path);
        resources.push({
          resourceId: `${sourceId}#csv:${base}`,
          kind: 'csv',
          content: attachment.content,
          path: base,
          sourceId,
          sourceSnapshotHash: entry.contentHash,
          resourceHash: contentResourceHash(attachment.content),
        });
      }
      // D3（A 案 §5.2）：声明 XLSX 进入资源表（WorkbookCells selector 可引用）；
      // 解析复用 raw-workbook 既有路径与体量/结构护栏。
      if ([...referenced].some((id) => id.startsWith(`${sourceId}${WORKBOOK_RESOURCE_PREFIX}`))) {
        try {
          const payload = await loadWorkbookEvidenceResource(state.knowledgeBaseRoot, entry, verified.content);
          if (!payload) {
            throw new Error(`源内无 source_workbook 声明（${entry.relPath}）；声明 XLSX 才能作为工作簿证据资源`);
          }
          resources.push(payload.resource);
        } catch (error) {
          if (error instanceof ToolError) throw error;
          throw new ToolError('kb_evidence_unresolved',
            `工作簿证据资源不可用: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // D3（A 案 §5.1/§5.2）：只登记已有识图描述的被引用图片——unavailable
      // 图片不得充当支撑；未描述图片不在资源表，引用即拒。
      if ([...referenced].some((id) => id.startsWith(`${sourceId}${IMAGE_RESOURCE_PREFIX}`))) {
        for (const payload of collectImageEvidenceResources(
          state.knowledgeBaseRoot, entry, verified.content, state.imageDescriptions?.get(sourceId), state.whiteboardTexts?.get(sourceId),
        )) {
          resources.push(payload.resource);
        }
      }
        const pack = { resources, sourceSnapshotHash: entry.contentHash };
        return pack;
      })();
      resourceCache.set(sourceId, promise);
      return promise;
    };
    const evidenceInputs = args.evidenceClaims === undefined ? [] : requireArray(args, 'evidenceClaims');
    // 引用资源 ID 预扫描：按源分组，驱动工作簿/图片资源的懒装配
    const referencedBySource = new Map<string, Set<string>>();
    for (const raw of evidenceInputs) {
      const probe = asRecord(raw);
      const probeRef = asRecord(probe?.sourceRef);
      if (typeof probeRef?.sourceId !== 'string' || typeof probeRef.resourceId !== 'string') continue;
      let set = referencedBySource.get(probeRef.sourceId);
      if (!set) { set = new Set(); referencedBySource.set(probeRef.sourceId, set); }
      set.add(probeRef.resourceId);
    }
    const newEvidence: Evidence[] = [];
    const evidenceIdMap: Record<string, string> = {};
    const submissionEvidenceKeys = new Map<string, string>();
    for (const raw of evidenceInputs) {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', 'evidenceClaims 每项必须是对象');
      const clientKey = requireString(input, 'clientKey', 1, 200);
      if (submissionEvidenceKeys.has(clientKey)) throw new ToolError('invalid_request', `evidenceClaims.clientKey 重复: ${clientKey}`);
      const objectKey = requireString(input, 'objectKey', 1, 200);
      const objectId = resolveObjectRef(objectKey);
      if (!objectId) throw new ToolError('invalid_request', `evidenceClaims.objectKey 无法解析: ${objectKey}`);
      const claimKey = requireString(input, 'claimKey', 1, 200);
      const sourceRefInput = asRecord(input.sourceRef);
      if (!sourceRefInput) throw new ToolError('invalid_request', 'evidenceClaims.sourceRef 必须是对象');
      const sourceId = requireString(sourceRefInput, 'sourceId', 1, 256);
      const resourceId = requireString(sourceRefInput, 'resourceId', 1, 400);
      const pack = await resourcesFor(sourceId, referencedBySource.get(sourceId) ?? new Set());
      const resource = pack.resources.find((candidate) => candidate.resourceId === resourceId);
      if (!resource) {
        throw new ToolError('kb_evidence_unresolved',
          `证据资源不在本构建资源表: ${resourceId}（可用：${pack.resources.map((candidate) => candidate.resourceId).join(', ')}；资源表来自 raw_read 回执，工作簿=<objToken>#workbook:<名>、图片=<objToken>#image:<src>，未描述图片不登记）`);
      }
      let selector = parseSelector(input.selector);
      // D3：media_region 的 imageHash 由服务端按资源钉住——图片字节哈希对
      // 模型不可见，缺省即补齐并随声明冻结（显式提供时必须与资源一致，
      // resolveSelector 会拒绝不符值）。
      if (selector.kind === 'media_region' && !selector.imageHash && resource.kind === 'image') {
        selector = { ...selector, imageHash: resource.imageHash };
      }
      const role = input.role;
      if (role !== 'supports' && role !== 'contradicts' && role !== 'context') {
        throw new ToolError('invalid_request', `evidenceClaims.role 非法: ${String(role)}`);
      }
      const nature = input.nature;
      if (nature !== 'direct' && nature !== 'derived' && nature !== 'machine_description') {
        throw new ToolError('invalid_request', `evidenceClaims.nature 非法: ${String(nature)}`);
      }
      if (selector.kind === 'media_region' && nature !== 'machine_description') {
        throw new ToolError('kb_evidence_unresolved', '图片描述证据必须标 machine_description（A 案 §5.2）');
      }
      if (nature === 'machine_description' && selector.kind !== 'media_region') {
        throw new ToolError('kb_evidence_unresolved', 'machine_description 证据必须使用 media_region 和图片资源 ID；正文 text_span 不会包含 raw_read 临时插入的图片描述');
      }
      let readReceiptId = optStr(input, 'readReceiptId');
      if (!readReceiptId && selector.kind === 'text_span') {
        readReceiptId = receipts.find((receipt) => receipt.resourceId === resourceId
          && receipt.lineStart <= selector.lineStart && receipt.lineEnd >= selector.lineEnd)?.readReceiptId;
      }
      if (!readReceiptId && selector.kind === 'csv_cells' && resource.kind === 'csv') {
        const { recordSpans } = parseCsvRecords(resource.content);
        const first = recordSpans[selector.recordStart - 1];
        const last = recordSpans[selector.recordEnd - 1];
        if (first && last) {
          const endLine = last.startLine + last.lineCount - 1;
          readReceiptId = receipts.find((receipt) => receipt.resourceId === resourceId
            && receipt.lineStart <= first.startLine && receipt.lineEnd >= endLine)?.readReceiptId;
        }
      }
      if ((selector.kind === 'text_span' || selector.kind === 'csv_cells') && !readReceiptId) {
        throw new ToolError('kb_evidence_unresolved', '文本/CSV 证据没有覆盖所选范围的 raw_read 回执；请先读取该资源和行范围，或显式提供有效 readReceiptId（A 案 §5.3）');
      }
      // 服务端重新解引用：selector 解析 → hash 对账 + 回执范围 + quoteHash 复核
      const resolution = resolveSelector(resource, selector);
      if (!resolution.ok) throw new ToolError('kb_evidence_unresolved', resolution.message);
      if (selector.kind === 'csv_cells' && role !== 'context' && resolution.nonEmptyCellCount === 0) {
        throw new ToolError('kb_evidence_unresolved',
          `CSV 证据选中的单元格全为空：逻辑 record ${selector.recordStart}–${selector.recordEnd}，列 ${selector.columns.join(', ')}。raw_read 的 R 是物理行、C 是逻辑 record；请用 raw_csv_cells 核对真实单元格后重选。空白范围只能作为 context，不能直接支撑或反驳断言`);
      }
      const verification = verifyEvidence({
        evidence: {
          sourceRef: { sourceId, sourceSnapshotHash: pack.sourceSnapshotHash, resourceId, resourceHash: resource.resourceHash },
          selector,
          quoteHash: resolution.quoteHash,
          ...(readReceiptId ? { readReceiptId } : {}),
        },
        resources: pack.resources,
        receipts,
      });
      if (!verification.ok) throw new ToolError('kb_evidence_unresolved', verification.message);
      const evidenceId = draft.evidenceKeys[clientKey] ?? `kev_${crypto.randomBytes(8).toString('hex')}`;
      evidenceIdMap[clientKey] = evidenceId;
      submissionEvidenceKeys.set(clientKey, evidenceId);
      newEvidence.push({
        evidenceId,
        objectId,
        claimKey,
        sourceRef: { sourceId, sourceSnapshotHash: pack.sourceSnapshotHash, resourceId, resourceHash: resource.resourceHash },
        selector,
        quoteHash: resolution.quoteHash,
        role,
        nature,
        ...(readReceiptId ? { readReceiptId } : {}),
      });
    }
    // kb_write_doc 是整篇声明替换：被重申对象的证据以本次 evidenceClaims
    // 为准。旧证据即使来源快照未变，也可能指向旧正文的断言或错误坐标；
    // 未重报就必须移除。仅未触及的对象保留原证据。相同 clientKey 的新证据
    // 复用原 evidenceId，保持身份稳定。
    const newEvidenceIds = new Set(newEvidence.map((evidence) => evidence.evidenceId));
    draft.evidence = draft.evidence.filter((evidence) => !touchedIds.has(evidence.objectId)
      && !removedIds.has(evidence.objectId) && !newEvidenceIds.has(evidence.evidenceId));
    draft.evidence.push(...newEvidence);
    for (const [clientKey, evidenceId] of submissionEvidenceKeys) draft.evidenceKeys[clientKey] = evidenceId;
    for (const [clientKey, evidenceId] of Object.entries(draft.evidenceKeys)) {
      if (!draft.evidence.some((evidence) => evidence.evidenceId === evidenceId)) delete draft.evidenceKeys[clientKey];
    }
    // claim 证据绑定回填（evidenceIds 只入 reviewSubjectHash，不入 payloadHash）
    for (const object of newObjects) {
      for (const claim of object.claims) {
        claim.evidenceIds = draft.evidence
          .filter((evidence) => evidence.objectId === object.objectId && evidence.claimKey === claim.claimKey)
          .map((evidence) => evidence.evidenceId);
      }
    }

    // ---- 受控呈现（A 案 §3.2）：exact 目标必须已注册且已生成 ----
    const presentationInputs = args.presentations === undefined ? [] : requireArray(args, 'presentations');
    const newPresentations: Presentation[] = [];
    const revisionOfObject = (objectId: string): number | null => {
      const inNew = newObjects.find((object) => object.objectId === objectId);
      if (inNew) return inNew.revision;
      const inDraft = draft.objects.find((object) => object.objectId === objectId);
      if (inDraft) return inDraft.revision;
      if (planObjectIdSet.has(objectId)) return 0; // 计划预分配、尚未生成
      return null;
    };
    for (const raw of presentationInputs) {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', 'presentations 每项必须是对象');
      const ownerKey = requireString(input, 'ownerKey', 1, 200);
      const ownerObjectId = resolveObjectRef(ownerKey);
      if (!ownerObjectId) throw new ToolError('invalid_request', `presentations.ownerKey 无法解析: ${ownerKey}`);
      const kind = requireString(input, 'kind', 1, 40);
      if (kind === 'canonical') {
        throw new ToolError('invalid_request', 'canonical 呈现由对象登记自动生成，不接受声明（defined_at 同理）');
      }
      if (kind !== 'link' && kind !== 'summary' && kind !== 'exact') {
        throw new ToolError('invalid_request', `呈现方式非法: ${kind}`);
      }
      const targetKey = requireString(input, 'targetKey', 1, 200);
      const targetObjectId = resolveObjectRef(targetKey);
      if (!targetObjectId || revisionOfObject(targetObjectId) === null) {
        throw new ToolError(kind === 'exact' ? 'kb_include_invalid' : 'kb_presentation_invalid',
          `${kind} 呈现目标未注册: ${targetKey}`);
      }
      if (kind === 'exact' && !touchedIds.has(targetObjectId) && !existingById.has(targetObjectId)) {
        // exact 片段必须直接来自已生成的 canonical 主定义（A 案 §3.2）；
        // 仅计划预分配的目标还无正文可展开
        throw new ToolError('kb_include_invalid', `exact 片段目标尚未生成（仅有计划预分配 ID）: ${targetKey}`);
      }
      const inSubmission = newObjects.find((object) => object.objectId === targetObjectId);
      let targetRevision: number | undefined;
      if (kind === 'summary' || kind === 'exact') {
        if (inSubmission) {
          targetRevision = inSubmission.revision; // server 权威修订，不接受自报
        } else if (typeof input.targetRevision === 'number' && Number.isInteger(input.targetRevision) && input.targetRevision >= 0) {
          targetRevision = input.targetRevision;
        } else {
          throw new ToolError('kb_presentation_invalid', `${kind} 呈现引用外部对象必须携带 targetRevision（绑定目标修订）`);
        }
      }
      let bodyRange: BodyRange | undefined;
      if (asRecord(input.bodyRange)) {
        bodyRange = parseBodyRange(input.bodyRange);
        if (bodyRange.startLine < 1 || bodyRange.endLine > markdownLines.length) {
          throw new ToolError('invalid_request', `presentations.bodyRange 超出正文范围`);
        }
      }
      if (kind === 'summary' && !bodyRange) {
        throw new ToolError('kb_presentation_invalid', 'summary 呈现必须登记自己的正文范围（A 案 §3.2）');
      }
      const summaryBasis = optStr(input, 'summaryBasis');
      const fragmentKey = optStr(input, 'fragmentKey');
      if (kind === 'exact' && !fragmentKey) {
        throw new ToolError('kb_include_invalid', `exact 片段引用缺 fragmentKey: ${ownerKey}`);
      }
      newPresentations.push({
        presentationId: `kp_${crypto.randomBytes(8).toString('hex')}`,
        ownerObjectId,
        kind,
        ...(bodyRange ? { bodyRange } : {}),
        targetObjectId,
        ...(targetRevision !== undefined ? { targetRevision } : {}),
        ...(summaryBasis ? { summaryBasis } : {}),
        ...(kind === 'exact' && fragmentKey ? { fragmentKey } : {}),
      });
    }
    draft.presentations = draft.presentations.filter(
      (presentation) => !touchedIds.has(presentation.ownerObjectId) && !removedIds.has(presentation.ownerObjectId));
    draft.presentations.push(...newPresentations);

    // ---- 关系（A 案 §6.1 八词表；无 related_to 逃生词）----
    const relationInputs = args.relations === undefined ? [] : requireArray(args, 'relations');
    const newRelations: KnowledgeRelation[] = [];
    const resolveEvidenceRef = (key: string): string | null => {
      const mapped = submissionEvidenceKeys.get(key) ?? draft.evidenceKeys[key];
      if (mapped) return mapped;
      if (key.startsWith('kev_') && draft.evidence.some((evidence) => evidence.evidenceId === key)) return key;
      return null;
    };
    for (const raw of relationInputs) {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', 'relations 每项必须是对象');
      const fromKey = requireString(input, 'fromKey', 1, 200);
      const toKey = requireString(input, 'toKey', 1, 200);
      const type = requireString(input, 'type', 1, 40);
      if (type === 'defined_at') {
        throw new ToolError('kb_relation_invalid', 'defined_at 由对象登记自动生成，不接受声明');
      }
      if (!KNOWLEDGE_RELATION_TYPES.has(type as KnowledgeRelationType)) {
        throw new ToolError('kb_relation_invalid', `非法关系词: ${type}（A 案 §6.1 八词表；无 related_to）`);
      }
      const fromObjectId = resolveObjectRef(fromKey);
      const toObjectId = resolveObjectRef(toKey);
      if (!fromObjectId || !toObjectId) {
        throw new ToolError('kb_relation_invalid', `关系端点未注册: ${fromKey} → ${toKey}`);
      }
      const scopeKey = typeof input.scopeKey === 'string' && input.scopeKey.trim() ? input.scopeKey : '';
      if (!scopeKey) {
        throw new ToolError('kb_scope_unresolved', `关系 ${fromKey}→${toKey} 缺 scopeKey`);
      }
      if ((type === 'part_of' || type === 'supersedes') && fromObjectId === toObjectId) {
        throw new ToolError('kb_relation_invalid', `${type} 禁止自环: ${fromKey}`);
      }
      if (type === 'conflicts_with' && !(fromObjectId < toObjectId)) {
        throw new ToolError('kb_relation_invalid',
          `conflicts_with 必须按 ID 排序单份存储（from < to）: ${fromKey}(${fromObjectId}) → ${toKey}(${toObjectId})`);
      }
      const decisionRef = optStr(input, 'decisionRef');
      if (type === 'supersedes' && !decisionRef) {
        throw new ToolError('kb_relation_invalid', 'supersedes 必须绑定人工业务决定（decisionRef）；来源日期不构成决定');
      }
      const evidenceKeys = optStrArray(input, 'evidenceKeys') ?? [];
      const evidenceIds: string[] = [];
      for (const key of evidenceKeys) {
        const evidenceId = resolveEvidenceRef(key);
        if (!evidenceId) throw new ToolError('kb_relation_invalid', `关系依据证据未注册: ${key}`);
        evidenceIds.push(evidenceId);
      }
      const validFrom = optStr(input, 'validFrom');
      const validUntil = optStr(input, 'validUntil');
      newRelations.push({
        edgeId: `ke_${crypto.randomBytes(8).toString('hex')}`,
        fromObjectId,
        toObjectId,
        type: type as KnowledgeRelationType,
        scopeKey,
        evidenceIds,
        ...(decisionRef ? { decisionRef } : {}),
        ...(validFrom ? { validFrom } : {}),
        ...(validUntil ? { validUntil } : {}),
      });
    }
    draft.relations = draft.relations.filter(
      (relation) => !touchedIds.has(relation.fromObjectId) && !removedIds.has(relation.fromObjectId));
    draft.relations.push(...newRelations);

    // ---- 覆盖清单（A 案 §5.5）：同 itemId 覆盖旧项 ----
    const coverageInputs = args.coverageUpdates === undefined ? [] : requireArray(args, 'coverageUpdates');
    const newCoverage: CoverageItem[] = [];
    const seenItemIds = new Set<string>();
    for (const raw of coverageInputs) {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', 'coverageUpdates 每项必须是对象');
      const itemId = requireString(input, 'itemId', 1, 200);
      if (seenItemIds.has(itemId)) throw new ToolError('invalid_request', `coverageUpdates.itemId 重复: ${itemId}`);
      seenItemIds.add(itemId);
      const sourceId = requireString(input, 'sourceId', 1, 256);
      const pack = await resourcesFor(sourceId, referencedBySource.get(sourceId) ?? new Set());
      const category = requireString(input, 'category', 1, 200);
      const disposition = input.disposition;
      if (disposition !== 'mapped' && disposition !== 'excluded_template' && disposition !== 'excluded_nonknowledge' && disposition !== 'unresolved') {
        throw new ToolError('kb_coverage_invalid', `覆盖项 disposition 非法: ${String(disposition)}`);
      }
      const importance = input.importance === 'important' ? 'important' as const
        : input.importance === 'normal' ? 'normal' as const : undefined;
      const targetKeys = optStrArray(input, 'targetKeys') ?? [];
      const reason = optStr(input, 'reason');
      const targetObjectIds: string[] = [];
      if (disposition === 'mapped') {
        if (targetKeys.length === 0) {
          throw new ToolError('kb_coverage_invalid', `mapped 覆盖项必须给目标对象: ${itemId}`);
        }
        for (const key of targetKeys) {
          const objectId = resolveObjectRef(key);
          if (!objectId) throw new ToolError('kb_coverage_invalid', `mapped 目标对象未注册: ${key}`);
          targetObjectIds.push(objectId);
        }
      }
      if ((disposition === 'excluded_template' || disposition === 'excluded_nonknowledge') && !reason) {
        throw new ToolError('kb_coverage_invalid', `排除必须给理由: ${itemId}（不能把漏掉的规则统一标成模板）`);
      }
      if (disposition === 'excluded_nonknowledge' && reason && coverageReasonImpliesKnowledgeTransfer(reason)) {
        throw new ToolError('kb_coverage_invalid', `覆盖项 ${itemId} 仍属知识且由其他文档承接；请映射到承接对象，不要标成 excluded_nonknowledge`, 409);
      }
      const mainResource = pack.resources[0]!;
      newCoverage.push({
        itemId,
        sourceRef: {
          sourceId,
          sourceSnapshotHash: pack.sourceSnapshotHash,
          resourceId: mainResource.resourceId,
          resourceHash: mainResource.resourceHash,
        },
        category,
        ...(importance ? { importance } : {}),
        disposition,
        targetObjectIds,
        ...(reason ? { reason } : {}),
      });
    }
    const newItemIds = new Set(newCoverage.map((item) => item.itemId));
    draft.coverage = draft.coverage.filter((item) => !newItemIds.has(item.itemId));
    draft.coverage.push(...newCoverage);
    // Source reconstruction appends CSV attachments after the Markdown body.
    // The model must not guess whether a blank tab is an unread design gap.
    reconcileBlankCsvCoverage(draft.coverage, state.snapshot, state.knowledgeBaseRoot);

    // ---- 审查主体哈希：受影响对象的绑定面变化使旧审查失效（A 案 §2.3）----
    for (const object of newObjects) {
      const evidence = draft.evidence.filter((item) => item.objectId === object.objectId);
      const relations = draft.relations.filter(
        (relation) => relation.fromObjectId === object.objectId || relation.toObjectId === object.objectId);
      const inboundPresentations = draft.presentations.filter(
        (presentation) => presentation.targetObjectId === object.objectId);
      const decisionRefs = [...new Set(
        relations.filter((relation) => relation.decisionRef).map((relation) => relation.decisionRef!))];
      object.reviewSubjectHash = computeReviewSubjectHash({
        payloadHash: object.payloadHash,
        evidence,
        relations,
        inboundPresentations,
        decisionRefs,
      });
      // diting F06：按实际载荷失效审查——载荷与审查主体均未变的重申
      // （含纯搬家）继承既有有效审查，不因本轮改写被迫重回 pending。
      const prior = existingById.get(object.objectId);
      if (prior && prior.reviewStatus === 'passed'
        && prior.payloadHash === object.payloadHash
        && prior.reviewSubjectHash === object.reviewSubjectHash) {
        object.reviewStatus = 'passed';
        object.reviewActorKind = prior.reviewActorKind;
        object.reviewerId = prior.reviewerId;
        object.reviewedAt = prior.reviewedAt;
      }
    }
    return { draft, objectIdMap, evidenceIdMap, draftRevision, authImpact: { familyKeys: [...impactFamilyKeys], crossPathMigrations: impactCrossPath }, baselineSignature };
  }

  /**
   * diting F03（A 案 §4.2/§7.4）：流水审查通过时回写对象级机器审查凭据。
   * 把审查范围（报告覆盖的文档）内对象的 reviewStatus 置 passed：
   * reviewActorKind='machine'，reviewerId 绑定报告 ID，reviewSubjectHash
   * 为声明期按当时对象载荷计算并随草稿留存的值（重申时已按实际载荷
   * 失效/继承）。文档级报告不自动冒充人审（reviewActorKind 恒 machine）。
   * scopePaths=null 表示全库范围（最终复核）。返回本次标记的对象数。
   *
   * diting S-F01：本方法修改共享声明/审查凭据，与 kb_write_doc 声明段
   * 共用同一构建级互斥队列（异步化排队）——否则它会落在并发 kb_write_doc
   * 的「读旧副本→await→整包保存」窗口内被覆盖丢失。
   */
  async markObjectsMachineReviewed(state: BuildRunState, scopePaths: string[] | null, reportId: string): Promise<number> {
    return this.withKnowledgeDeclarationLock(state, () =>
      this.markObjectsMachineReviewedLocked(state, scopePaths, reportId));
  }

  /** markObjectsMachineReviewed 的无锁内核（调用方必须已持声明锁）。 */
  private markObjectsMachineReviewedLocked(state: BuildRunState, scopePaths: string[] | null, reportId: string): number {
    const draft = this.loadKnowledgeDraft(state);
    const scope = scopePaths ? new Set(scopePaths) : null;
    const reviewedAt = new Date().toISOString();
    let marked = 0;
    for (const object of draft.objects) {
      if (object.tombstone || !object.canonical) continue;
      if (scope && !scope.has(object.canonical.path)) continue;
      if (object.reviewStatus === 'passed' && object.reviewerId === reportId) continue; // 幂等
      object.reviewStatus = 'passed';
      object.reviewActorKind = 'machine';
      object.reviewerId = reportId;
      object.reviewedAt = reviewedAt;
      marked += 1;
    }
    if (marked > 0) this.saveKnowledgeDraft(state, draft);
    return marked;
  }

  /**
   * v2 F08：权威回执驱动的对象凭据回写——同一声明锁临界区内重算当前
   * 依赖并与审查提交时值精确核验（正文候选哈希 + 声明语义哈希 + 来源
   * 快照 + 冻结规则）；全部匹配才回写。任何漂移返回 deferredReason，
   * 不标记（对象保持 pending；发布侧 collectAuthorityValidatedReports
   * 以同一组依赖拦截，双保险）。禁止无条件 mark passed。
   */
  private async markObjectsReviewedForAuthorityReceipt(
    context: InternalRunContext,
    expected: ReviewDependencyValues & { draftHash: string; scopePaths: string[]; sourceRefs: string[] },
    reportId: string,
    meta?: ToolRequestMeta,
  ): Promise<{ marked: number; deferredReason: string | null }> {
    const state = requireBuildState(context);
    return this.withKnowledgeDeclarationLock(state, () => {
      // 审查凭据也是受控知识写入：重检ctx、actor、代次及发布窗口。
      this.assertRunLeaseActive(context);
      this.assertV2Access(context, 'kb_submit_review', meta);
      const entriesNow = this.stagingDraftEntries(state).filter((entry) => expected.scopePaths.includes(entry.path));
      if (computeCandidateHash({ documents: entriesNow }) !== expected.draftHash) {
        return { marked: 0, deferredReason: 'draft_changed_since_review' };
      }
      const current = resolveCurrentReviewDependencies({
        stagingRoot: state.stagingRoot,
        snapshot: state.snapshot,
        workflowRulesHash: state.v2WorkflowRulesHash ?? null,
      });
      if (scopedReviewDeclarationHash(state.stagingRoot, expected.scopePaths, expected.sourceRefs) !== expected.declarationHash) {
        return { marked: 0, deferredReason: 'knowledge_declaration_changed_since_review' };
      }
      if (current.sourceSnapshotHash !== expected.sourceSnapshotHash) {
        return { marked: 0, deferredReason: 'source_snapshot_changed_since_review' };
      }
      if (current.workflowRulesHash === null || expected.workflowRulesHash === null
        || current.workflowRulesHash !== expected.workflowRulesHash) {
        // F08 补强：v2 权威规则哈希缺失即 fail-closed（缺证明不回写）
        return { marked: 0, deferredReason: 'workflow_rules_changed_since_review' };
      }
      const marked = this.markObjectsMachineReviewedLocked(state, expected.scopePaths, reportId);
      return { marked, deferredReason: null };
    });
  }


  /** T3（A 案 §7.2）：提交组织计划——结构校验 + ID 预分配 + planRevision 递增；
   * 非法项逐条拒绝（rejected），深度调度校验由 T2b 接手。 */
  private toolKbSubmitPlan(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    const worker = context.options.worker;
    if (worker && worker.phase !== 'plan' && worker.phase !== 'final') {
      throw new ToolError('kb_plan_phase_forbidden', `kb_submit_plan 仅规划轮/收尾轮可用（当前 phase=${worker.phase}）`, 403);
    }
    const plan = this.loadOrganizationPlan(state, context.buildId ?? 'unknown');
    const rejected: Array<{ item: string; reason: string }> = [];

    // ---- 文档分组：路径合规 + 唯一；docId 预分配且路径稳定沿用 ----
    const docInputs = requireArray(args, 'docs');
    if (docInputs.length > 200) throw new ToolError('invalid_request', 'docs 至多 200 项');
    const docsByPath = new Map(plan.docs.map((doc) => [doc.path, doc] as const));
    const docIdMap: Record<string, string> = {};
    const seenPaths = new Set<string>();
    for (const raw of docInputs) {
      const input = asRecord(raw);
      const docPath = typeof input?.path === 'string' ? input.path : '';
      const label = docPath || '(docs)';
      const title = typeof input?.title === 'string' && input.title ? input.title : '';
      if (!input || !docPath || !title) {
        rejected.push({ item: label, reason: '缺 path 或 title' });
        continue;
      }
      if (seenPaths.has(docPath)) {
        rejected.push({ item: docPath, reason: '计划文档 path 重复' });
        continue;
      }
      seenPaths.add(docPath);
      try {
        validateStdDocPath(docPath);
      } catch (error) {
        rejected.push({ item: docPath, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const summary = typeof input.summary === 'string' && input.summary ? input.summary : undefined;
      const docId = docsByPath.get(docPath)?.docId ?? `kd_${crypto.randomBytes(6).toString('hex')}`;
      docIdMap[docPath] = docId;
      docsByPath.set(docPath, { path: docPath, title, ...(summary ? { summary } : {}), docId });
    }

    // ---- 对象候选：类型枚举、范围键必填、family 三元组唯一、主位置在计划内 ----
    const candidateInputs = args.objectCandidates === undefined ? [] : requireArray(args, 'objectCandidates');
    const objectsByClientKey = new Map(plan.objects.map((object) => [object.clientKey, object] as const));
    const objectIdMap: Record<string, string> = {};
    const accepted: OrganizationPlanFile['objects'] = [];
    const familySeen = new Set<string>();
    for (const object of plan.objects) {
      familySeen.add(`${object.familyKey}\u0000${object.variantKey}\u0000${object.scopeKey}`);
    }
    for (const raw of candidateInputs) {
      const input = asRecord(raw);
      if (!input) { rejected.push({ item: '(objectCandidates)', reason: '每项必须是对象' }); continue; }
      const clientKey = typeof input.clientKey === 'string' && input.clientKey ? input.clientKey : '';
      const label = clientKey || '(objectCandidates)';
      const type = typeof input.type === 'string' ? input.type : '';
      const title = typeof input.title === 'string' && input.title ? input.title : '';
      const familyKey = typeof input.familyKey === 'string' && input.familyKey ? input.familyKey : '';
      const variantKey = typeof input.variantKey === 'string' && input.variantKey ? input.variantKey : '';
      const scopeKey = typeof input.scopeKey === 'string' && input.scopeKey.trim() ? input.scopeKey : '';
      const scopeText = typeof input.scopeText === 'string' && input.scopeText ? input.scopeText : '';
      const canonicalPath = typeof input.canonicalPath === 'string' && input.canonicalPath ? input.canonicalPath : '';
      if (!clientKey || !title || !familyKey || !variantKey || !scopeText || !canonicalPath) {
        rejected.push({ item: label, reason: '缺 clientKey/title/familyKey/variantKey/scopeText/canonicalPath' });
        continue;
      }
      if (!scopeKey) {
        rejected.push({ item: label, reason: '缺 scopeKey（每对象必填）' });
        continue;
      }
      if (!KNOWLEDGE_OBJECT_TYPES.has(type as KnowledgeObjectType)) {
        rejected.push({ item: label, reason: `对象类型非法: ${type}` });
        continue;
      }
      if (!docsByPath.has(canonicalPath)) {
        rejected.push({ item: label, reason: `主位置不在计划文档内: ${canonicalPath}` });
        continue;
      }
      const triple = `${familyKey}\u0000${variantKey}\u0000${scopeKey}`;
      const priorObject = objectsByClientKey.get(clientKey);
      if (!priorObject) {
        if (familySeen.has(triple)) {
          rejected.push({ item: label, reason: `同 familyKey+variantKey+scopeKey 重复: ${familyKey}/${variantKey}/${scopeKey}` });
          continue;
        }
        familySeen.add(triple);
      } else {
        const priorTriple = `${priorObject.familyKey}\u0000${priorObject.variantKey}\u0000${priorObject.scopeKey}`;
        if (priorTriple !== triple) {
          if (familySeen.has(triple)) {
            rejected.push({ item: label, reason: `同 familyKey+variantKey+scopeKey 重复: ${familyKey}/${variantKey}/${scopeKey}` });
            continue;
          }
          familySeen.delete(priorTriple);
          familySeen.add(triple);
        }
      }
      const objectId = priorObject?.objectId ?? `ko_${crypto.randomUUID()}`;
      const entry = {
        clientKey, objectId, type, title, familyKey, variantKey, scopeKey, scopeText, canonicalPath,
      };
      accepted.push(entry);
      objectIdMap[clientKey] = objectId;
      objectsByClientKey.set(clientKey, entry);
    }

    // ---- 依赖：端点可解析、无自依赖、不成环（增量 DFS）----
    const planObjectIds = new Set<string>([
      ...plan.objects.map((object) => object.objectId),
      ...accepted.map((object) => object.objectId),
    ]);
    const resolvePlanRef = (key: string): string | null => {
      const object = objectsByClientKey.get(key);
      if (object) return object.objectId;
      if (key.startsWith('ko_') && planObjectIds.has(key)) return key;
      return null;
    };
    const dependencyInputs = args.dependencies === undefined ? [] : requireArray(args, 'dependencies');
    const acceptedDependencies: OrganizationPlanFile['dependencies'] = [];
    const depEdges: Array<[string, string]> = [];
    for (const raw of dependencyInputs) {
      const input = asRecord(raw);
      const label = typeof input?.fromKey === 'string' ? `${input.fromKey}→${String(input?.toKey ?? '')}` : '(dependencies)';
      const fromKey = typeof input?.fromKey === 'string' && input.fromKey ? input.fromKey : '';
      const toKey = typeof input?.toKey === 'string' && input.toKey ? input.toKey : '';
      if (!fromKey || !toKey) {
        rejected.push({ item: label, reason: '缺 fromKey/toKey' });
        continue;
      }
      const fromObjectId = resolvePlanRef(fromKey);
      const toObjectId = resolvePlanRef(toKey);
      if (!fromObjectId || !toObjectId) {
        rejected.push({ item: label, reason: '依赖端点未在计划对象内' });
        continue;
      }
      if (fromObjectId === toObjectId) {
        rejected.push({ item: label, reason: '自依赖' });
        continue;
      }
      const candidateEdges: Array<[string, string]> = [...depEdges, [fromObjectId, toObjectId]];
      const nodes = [...new Set(candidateEdges.flat())];
      if (hasDirectedCycle(nodes, candidateEdges)) {
        rejected.push({ item: label, reason: '依赖成环' });
        continue;
      }
      depEdges.push([fromObjectId, toObjectId]);
      const reason = typeof input?.reason === 'string' && input.reason ? input.reason : undefined;
      acceptedDependencies.push({ fromObjectId, toObjectId, ...(reason ? { reason } : {}) });
    }

    // ---- 迁移：kind 语义、后继可解析、映射无环（A 案 §2.4）----
    const migrationInputs = args.migrations === undefined ? [] : requireArray(args, 'migrations');
    const acceptedMigrations: OrganizationPlanFile['migrations'] = [];
    const migrationEdges: Array<[string, string]> = [];
    for (const raw of migrationInputs) {
      const input = asRecord(raw);
      const label = typeof input?.objectKey === 'string' ? input.objectKey : '(migrations)';
      const objectKey = typeof input?.objectKey === 'string' && input.objectKey ? input.objectKey : '';
      const kind = input?.kind;
      const reason = typeof input?.reason === 'string' && input.reason ? input.reason : '';
      const successorKeys = Array.isArray(input?.successorKeys)
        ? (input.successorKeys as unknown[]).filter((key): key is string => typeof key === 'string')
        : [];
      if (!objectKey || (kind !== 'merge' && kind !== 'split' && kind !== 'remove') || !reason) {
        rejected.push({ item: label, reason: '缺 objectKey/reason 或 kind 非法（merge|split|remove）' });
        continue;
      }
      const objectId = resolvePlanRef(objectKey);
      if (!objectId) {
        rejected.push({ item: label, reason: '迁移对象未在计划内' });
        continue;
      }
      if (kind === 'remove' && successorKeys.length > 0) {
        rejected.push({ item: label, reason: 'remove 迁移不应有后继' });
        continue;
      }
      if (kind === 'merge' && successorKeys.length !== 1) {
        rejected.push({ item: label, reason: 'merge 迁移必须有且仅有一个存续后继' });
        continue;
      }
      if (kind === 'split' && successorKeys.length < 2) {
        rejected.push({ item: label, reason: 'split 迁移至少两个后继' });
        continue;
      }
      const successorObjectIds: string[] = [];
      let successorsOk = true;
      for (const key of successorKeys) {
        const successor = resolvePlanRef(key);
        if (!successor || successor === objectId) { successorsOk = false; break; }
        successorObjectIds.push(successor);
      }
      if (!successorsOk) {
        rejected.push({ item: label, reason: '迁移后继未在计划内或指向自身' });
        continue;
      }
      const candidateEdges: Array<[string, string]> = [
        ...migrationEdges,
        ...successorObjectIds.map((successor) => [objectId, successor] as [string, string]),
      ];
      if (hasDirectedCycle([...new Set(candidateEdges.flat())], candidateEdges)) {
        rejected.push({ item: label, reason: '迁移映射成环' });
        continue;
      }
      migrationEdges.push(...successorObjectIds.map((successor) => [objectId, successor] as [string, string]));
      acceptedMigrations.push({ objectId, kind, successorObjectIds, reason });
    }

    // ---- 落盘：docs/objects 按键合并（未重报旧项保留），依赖/迁移整批替换 ----
    // diting F06：基线迁移登记（seedBaselineKnowledge 预置）随计划提交保留
    // ——仅同 objectId 的新迁移替换旧项，避免累积映射丢失；合并后仍验无环。
    const priorMigrations = plan.migrations.filter((migration) =>
      !acceptedMigrations.some((accepted) => accepted.objectId === migration.objectId));
    const mergedMigrations = [...acceptedMigrations, ...priorMigrations];
    if (mergedMigrations.length > 0) {
      const mergedEdges: Array<[string, string]> = [];
      for (const migration of mergedMigrations) {
        for (const successor of migration.successorObjectIds) mergedEdges.push([migration.objectId, successor]);
      }
      if (hasDirectedCycle([...new Set(mergedEdges.flat())], mergedEdges)) {
        throw new ToolError('kb_relation_invalid', `迁移映射与基线登记合并后成环，拒绝本批迁移`);
      }
    }
    plan.docs = [...docsByPath.values()];
    plan.objects = [...objectsByClientKey.values()];
    plan.dependencies = acceptedDependencies;
    plan.migrations = mergedMigrations;
    plan.planRevision += 1;
    plan.updatedAt = new Date().toISOString();
    this.saveOrganizationPlan(state, plan);
    return {
      content: [{
        type: 'text',
        text: `已接受组织计划 ${plan.planId}（planRevision=${plan.planRevision}；文档 ${plan.docs.length}、对象 ${plan.objects.length}、拒绝 ${rejected.length} 项）`,
      }],
      details: { planId: plan.planId, planRevision: plan.planRevision, docIdMap, objectIdMap, rejected },
    };
  }

  /** T3（A 案 §7.2）：只读返回冻结计划与本单元负责对象（分页）。 */
  private toolKbGetPlan(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    const plan = this.loadOrganizationPlan(state, context.buildId ?? 'unknown');
    const limit = optionalInt(args, 'limit', 50, 1, 200);
    const cursor = typeof args.cursor === 'string' && args.cursor ? args.cursor : null;
    const workerUnitId = context.options.worker?.phase === 'unit' ? context.options.worker.unitId : null;
    const ownedPaths = workerUnitId && state.claims ? new Set(state.claims.ownedBy(workerUnitId)) : null;
    const sorted = [...plan.objects].sort((a, b) => (a.clientKey < b.clientKey ? -1 : a.clientKey > b.clientKey ? 1 : 0));
    let startIndex = 0;
    if (cursor) {
      // nextCursor = 下一页首项；游标指向的项即下一页开始（含）
      const index = sorted.findIndex((object) => object.clientKey === cursor);
      if (index < 0) throw new ToolError('invalid_request', `游标无效: ${cursor}`);
      startIndex = index;
    }
    const page = sorted.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < sorted.length ? sorted[startIndex + limit]!.clientKey : null;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          planId: plan.planId,
          planRevision: plan.planRevision,
          docs: plan.docs,
          dependencies: plan.dependencies,
          migrations: plan.migrations,
          objects: page.map((object) => ({
            ...object,
            ...(ownedPaths ? { owned: ownedPaths.has(object.canonicalPath) } : {}),
          })),
          nextCursor,
        }, null, 2),
      }],
      details: { planId: plan.planId, planRevision: plan.planRevision, objects: page.length, totalObjects: sorted.length },
    };
  }

  /**
   * T3（A 案 §7.1/§7.2）：审查报告提交。报告绑定提交时全部 staging 草稿的
   * 内容哈希（computeCandidateHash 同形：path+contentHash 按路径排序）；草稿
   * 改后旧报告 hash 不匹配（发布门禁比对）。审查者无草稿写入口；
   * revisionResponse/closureBasis 属修订流程字段，提交时一律不读不存。
   */
  private async toolKbSubmitReview(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): Promise<ToolResult> {
    args = withAutoOperationId(args);
    const state = requireBuildState(context);
    const worker = context.options.worker;
    if (worker && worker.phase !== 'review') {
      throw new ToolError('kb_review_phase_forbidden',
        `kb_submit_review 仅审查轮可用（当前 phase=${worker.phase}）；撰写者不能自审`, 403);
    }
    // v2（设计 v2 §4.3）：审查角色 + 幂等；独立性在草稿清单就绪后校验
    const v2 = context.options.orchestration ?? null;
    let v2Info: { v2: OrchestrationV2Options; actor: NonNullable<ReturnType<BuildActorStore["lookupActor"]>>; operationId: string; payloadHash: string } | null = null;
    if (v2 && v2.credential === 'child') {
      const { actor } = this.requireV2Actor(context, meta);
      if (!v2.actorStore.roleToolset(actor.role)?.isReviewer) {
        throw new ToolError('kb_review_role_forbidden', `角色 ${actor.role} 不是审查角色；撰写者不能自审（v2 §4.3）`, 403);
      }
      const operationId = requireString(args, 'operationId', 1, 200);
      const payloadHash = canonicalPayloadHash(args, ['operationId']);
      const replay = this.v2Replay(v2, actor.nativeTaskId, operationId, payloadHash);
      if (replay) return replay;
      v2Info = { v2, actor, operationId, payloadHash };
    }
    const unitId = args.unitId !== undefined
      ? requireString(args, 'unitId', 1, 64)
      : v2Info?.actor?.actorId ?? worker?.unitId ?? 'all';
    if (!/^[A-Za-z0-9_-]+$/.test(unitId)) {
      throw new ToolError('invalid_request', 'unitId 只能包含字母、数字、下划线与连字符');
    }
    const coverageInput = asRecord(args.coverage);
    if (!coverageInput) throw new ToolError('invalid_request', 'coverage 必须是对象');
    const sourceRefs = optStrArray(coverageInput, 'sourceRefs') ?? [];
    const allEntries = this.stagingDraftEntries(state);
    // A source may produce many independently publishable documents. Bind a
    // review to the exact document paths when supplied; derive all documents
    // from sourceRefs only for older callers. The server still computes every
    // content/declaration hash and checks the declared source set.
    const requestedPaths = coverageInput.docPaths === undefined ? null : optStrArray(coverageInput, 'docPaths');
    if (v2Info && coverageInput.docPaths !== undefined && (!requestedPaths || requestedPaths.length === 0)) {
      throw new ToolError('kb_review_scope_missing', 'coverage.docPaths 必须列出至少一篇待审草稿', 400);
    }
    const sourceSet = new Set(sourceRefs);
    const available = new Map(allEntries.map((entry) => [entry.path, entry]));
    if (v2Info && requestedPaths && (new Set(requestedPaths).size !== requestedPaths.length
      || requestedPaths.some((docPath) => !available.has(docPath)))) {
      throw new ToolError('kb_review_scope_missing', 'coverage.docPaths 含重复或不存在的草稿路径', 400);
    }
    const scopePaths = v2Info ? (requestedPaths ?? allEntries.filter((entry) => {
      const content = fs.readFileSync(path.join(state.stagingRoot, 'docs', entry.path), 'utf8');
      const header = parseStdHeader(content);
      return header?.sources.some((source) => sourceSet.has(source)) ?? false;
    }).map((entry) => entry.path)) : [];
    if (v2Info && (sourceRefs.length === 0 || scopePaths.length === 0)) {
      throw new ToolError('kb_review_scope_missing', '审查范围必须包含实际草稿引用的来源；请在 coverage.sourceRefs 填写所审来源', 400);
    }
    if (v2Info && requestedPaths) {
      const actualSources = new Set<string>();
      for (const docPath of scopePaths) {
        const content = fs.readFileSync(path.join(state.stagingRoot, 'docs', docPath), 'utf8');
        const header = parseStdHeader(content);
        if (!header?.sources.length) throw new ToolError('kb_review_scope_missing', `草稿缺少来源声明：${docPath}`, 400);
        header.sources.forEach((source) => actualSources.add(source));
      }
      if (actualSources.size !== sourceSet.size || [...actualSources].some((source) => !sourceSet.has(source))) {
        throw new ToolError('kb_review_scope_missing', 'coverage.sourceRefs 必须恰好包含 coverage.docPaths 中草稿声明的全部来源', 400);
      }
    }
    const entries = v2Info ? allEntries.filter((entry) => scopePaths.includes(entry.path)) : allEntries;
    const draftHash = computeCandidateHash({ documents: entries });
    // v2 F08：审查依赖绑定——对象/证据声明 + 来源快照 + 冻结 workflow 规则
    //（正文经 doc:* 逐路径与 draftHash 双重绑定）；发布侧同一权威核验。
    const reviewDeps = v2Info
      ? resolveCurrentReviewDependencies({
        stagingRoot: state.stagingRoot,
        snapshot: state.snapshot,
        workflowRulesHash: state.v2WorkflowRulesHash ?? null,
      })
      : null;
    if (reviewDeps && v2Info) {
      reviewDeps.declarationHash = scopedReviewDeclarationHash(state.stagingRoot, scopePaths, sourceRefs)
        ?? reviewDeps.declarationHash;
    }
    // v2（§4.3）：审查者既不是作者，也不在作者的续接链上
    if (v2Info) {
      try {
        v2Info.v2.actorStore.assertReviewerIndependent(v2Info.actor!.nativeTaskId, scopePaths);
      } catch (error) {
        throw wrapActorError(error);
      }
    }
    const checkedDimensions = optStrArray(args, 'checkedDimensions') ?? [];
    const issueInputs = requireArray(args, 'issues');
    if (issueInputs.length > 500) throw new ToolError('invalid_request', 'issues 至多 500 项');
    const issues: ReviewIssue[] = [];
    for (const [index, raw] of issueInputs.entries()) {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', 'issues 每项必须是对象');
      const draftLocation = requireString(input, 'draftLocation', 1, 600);
      const sourceLocation = optStr(input, 'sourceLocation');
      const description = requireString(input, 'description', 1, 4000);
      const severity = input.severity;
      if (severity !== 'blocking' && severity !== 'suggestion') {
        throw new ToolError('invalid_request', `severity 必须是 blocking|suggestion（严重度由审查规范定，不能自行降级）: ${String(severity)}`);
      }
      // blocking 必须带源位置：不能只给总分（A 案 §7.1 / B 案 §5）
      if (severity === 'blocking' && !sourceLocation) {
        throw new ToolError('invalid_request', 'blocking 问题必须带源位置（源标题+A1 区间/行区间）');
      }
      issues.push({
        issueId: `kri_${index + 1}_${crypto.randomBytes(4).toString('hex')}`,
        draftLocation,
        ...(sourceLocation ? { sourceLocation } : {}),
        description,
        severity,
      });
    }
    const uncheckedScope = optStrArray(args, 'uncheckedScope') ?? [];
    const conclusion = args.conclusion;
    if (conclusion !== 'pass' && conclusion !== 'needs_revision' && conclusion !== 'insufficient_material' && conclusion !== 'fail') {
      throw new ToolError('invalid_request', `conclusion 非法: ${String(conclusion)}`);
    }
    if (v2Info && conclusion === 'pass') {
      const unresolved = this.loadKnowledgeDraft(state).coverage.filter((item) =>
        sourceRefs.includes(item.sourceRef.sourceId)
        && item.importance === 'important' && item.disposition === 'unresolved');
      if (unresolved.length > 0) {
        throw new ToolError('kb_review_coverage_blocked',
          `本范围仍有重要未解决覆盖项，不能提交 pass：${unresolved.slice(0, 5).map((item) => item.itemId).join('、')}；请提交 needs_revision 并交给作者修订`, 409);
      }
    }
    const report: ReviewReport = {
      reportId: `kr_${crypto.randomBytes(8).toString('hex')}`,
      buildId: context.buildId ?? 'unknown',
      draftHash,
      coverage: { draftHashes: [draftHash], sourceRefs },
      checkedDimensions,
      issues,
      uncheckedScope,
      conclusion,
      serverVersionTag: 'kb-review/1',
    };
    const reviewsDir = path.join(state.stagingRoot, 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    atomicWriteFile(path.join(reviewsDir, `${unitId}.json`), `${JSON.stringify(report, null, 2)}\n`);
    const blocking = issues.filter((issue) => issue.severity === 'blocking').length;
    const result: ToolResult = {
      content: [{
        type: 'text',
        text: `已提交审查报告 ${report.reportId}（unit=${unitId}，draftHash=${draftHash.slice(0, 12)}…，问题 ${issues.length} 项：blocking ${blocking}/suggestion ${issues.length - blocking}）`,
      }],
      details: {
        reportId: report.reportId,
        unitId,
        draftHash,
        issues: issues.length,
        blocking,
        path: `reviews/${unitId}.json`,
      },
    };
    if (v2Info) {
      // v2（§4.3/§8）：ReviewReceipt 哈希绑定（正文/来源逐路径）+ 幂等回执
      // F08：绑定扩展为「正文 + 对象/证据声明 + 来源快照 + 冻结 workflow 规则」
      // 精确哈希；报告文件经 reportUnitId/reportId 双向绑定（F07 回执驱动源）。
      const deps = reviewDeps!;
      v2Info.v2.actorStore.recordReview({
        reviewerTaskId: v2Info.actor!.nativeTaskId,
        draftHash,
        scopePaths,
        dependencyHashes: {
          ...Object.fromEntries(entries.map((entry) => [`doc:${entry.path}`, entry.contentHash])),
          [REVIEW_DEP_DECLARATION]: deps.declarationHash,
          [REVIEW_DEP_SOURCE_SNAPSHOT]: deps.sourceSnapshotHash,
          ...(deps.workflowRulesHash ? { [REVIEW_DEP_WORKFLOW_RULES]: deps.workflowRulesHash } : {}),
        },
        ruleVersion: 'kb-review/1',
        reportUnitId: unitId,
        reportId: report.reportId,
        issues: issues.map((issue) => ({
          issueId: issue.issueId,
          severity: issue.severity,
          draftLocation: issue.draftLocation,
          sourceLocation: issue.sourceLocation ?? null,
          description: issue.description,
        })),
        verdict: conclusion,
      });
      this.v2RecordReceipt({ v2: v2Info.v2, nativeTaskId: v2Info.actor!.nativeTaskId, kind: 'review', operationId: v2Info.operationId, payloadHash: v2Info.payloadHash, paths: [], result });
    }
    // v2 F08：pass 且无未关闭 blocking → 声明锁内按提交时依赖核验当前状态后
    // 原子回写对象级机器审查凭据；任何漂移（正文/声明/来源/规则）都不回写
    //（不无条件 mark passed；对象保持 pending，发布侧同一权威拦截）。
    let credentialMarked = 0;
    let credentialDeferred: string | null = null;
    if (v2Info && conclusion === 'pass' && blocking === 0) {
      const outcome = await this.markObjectsReviewedForAuthorityReceipt(
        context,
        { draftHash, ...reviewDeps!, scopePaths, sourceRefs },
        report.reportId,
        meta,
      );
      credentialMarked = outcome.marked;
      credentialDeferred = outcome.deferredReason;
    }
    if (credentialDeferred) {
      (result.details as Record<string, unknown>).credentialDeferred = credentialDeferred;
    }
    if (credentialMarked > 0) {
      (result.details as Record<string, unknown>).credentialMarked = credentialMarked;
    }
    return result;
  }

  /** staging 草稿清单哈希输入（path + 内容 sha256，按 path 排序；空库哈希稳定）。 */
  private stagingDraftEntries(state: BuildRunState): Array<{ path: string; contentHash: string }> {
    const docsDir = path.join(state.stagingRoot, 'docs');
    const entries: Array<{ path: string; contentHash: string }> = [];
    const walk = (dir: string, prefix: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir).sort()) {
        const child = path.join(dir, name);
        const lstat = fs.lstatSync(child);
        if (lstat.isDirectory()) walk(child, `${prefix}${name}/`);
        else if (name.endsWith('.md')) {
          entries.push({ path: `${prefix}${name}`, contentHash: contentResourceHash(fs.readFileSync(child, 'utf-8')) });
        }
      }
    };
    walk(docsDir, '');
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Show the Leader which documents are already formal in the current release.
   * A restored draft registration or seed review is not a request to re-review
   * every carried document. Use the same body/declaration comparison as final
   * publication so status cannot falsely call changed declarations promoted. */
  private buildDocumentWorkStatus(context: InternalRunContext, state: BuildRunState): {
    carriedPublishedPaths: string[];
    promotedUnchangedPaths: string[];
    unpublishedDraftPaths: string[];
    pendingRequiredRewrites: string[];
  } {
    const entries = this.stagingDraftEntries(state);
    const manifest = this.storeFor(context.options.outputRoot).readManifest();
    let draft: KnowledgeDraftFile | null = null;
    try {
      draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf8')) as KnowledgeDraftFile;
    } catch { /* The candidate may not have any declarations yet. */ }
    const carriedPublishedPaths = entries.filter(({ path: docPath }) => draft?.docs?.[docPath]?.basis === 'published').map(({ path: docPath }) => docPath);
    const ownProgressive = !!manifest && manifest.buildId === (context.buildId ?? state.v2?.actorStore.buildId)
      && manifest.publicationStage === 'progressive';
    const promotedHashes = ownProgressive ? manifest.promotionHashes ?? {} : {};
    const baselineKnowledge = ownProgressive && manifest
      ? new KbVersionStore(context.options.outputRoot).readKnowledgeManifest(manifest.releaseId) : null;
    const changedPaths = draft && baselineKnowledge ? finalDraftEvidenceScopePaths({
      buildId: context.buildId ?? state.v2?.actorStore.buildId ?? '',
      liveDraft: draft,
      candidateDocs: entries,
      baselineManifest: manifest,
      baselineKnowledge,
    }) : undefined;
    const promotedUnchangedPaths = entries.filter(({ path: docPath, contentHash }) =>
      draft?.docs?.[docPath]?.basis !== 'published' && promotedHashes[docPath] === contentHash
      && changedPaths !== undefined && !changedPaths.includes(docPath)).map(({ path: docPath }) => docPath);
    const alreadyFormal = new Set([...carriedPublishedPaths, ...promotedUnchangedPaths]);
    const unpublishedDraftPaths = entries.filter(({ path: docPath }) => !alreadyFormal.has(docPath)).map(({ path: docPath }) => docPath);
    const pendingRequiredRewrites = unpublishedDraftPaths.filter((docPath) => state.requiredRewrites?.has(docPath));
    return { carriedPublishedPaths, promotedUnchangedPaths, unpublishedDraftPaths, pendingRequiredRewrites };
  }

  // ------------------------------------------------------------------
  // v2 build-runtime 工具（设计 v2 §3.4/§4/§5/§7）
  // ------------------------------------------------------------------

  /** build_manifest（Leader）：冻结源材料清单（§5.1），分页。 */
  private toolBuildManifest(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    const scope = args.scope === 'all' ? 'all' : 'workset';
    // Large worksets can return tens of kilobytes of outlines in one model
    // turn. Bound the active page so the Leader can dispatch the first child
    // before reading every source; background lookups keep their wider limit.
    const requestedLimit = optionalInt(args, 'limit', 12, 1, 200);
    const limit = scope === 'workset' ? Math.min(requestedLimit, 12) : requestedLimit;
    const published = this.storeFor(context.options.outputRoot).readManifest();
    const publishedSourceByToken = new Map((published?.sourceSnapshot ?? []).map((source) => [source.objToken, source] as const));
    // 增量重建时把已发布主题的路径交给 Leader，避免仅凭源标题猜新路径，
    // 把同一主题写成第二篇。这里只读取本构建 staging 中的受控文档头。
    const existingDocPathsBySource = new Map<string, string[]>();
    for (const doc of this.stagingDraftEntries(state)) {
      const file = resolveInside(path.join(state.stagingRoot, 'docs'), doc.path, 'read');
      const header = parseStdHeader(fs.readFileSync(file, 'utf-8'));
      if (!header) continue;
      for (const token of header.sources) {
        const paths = existingDocPathsBySource.get(token) ?? [];
        paths.push(doc.path);
        existingDocPathsBySource.set(token, paths);
      }
    }
    // Leader 的默认清单只列本轮工作集。完整冻结快照仍可显式查询，
    // 但不能把未变化的基准来源误当作需要派发的审查/写作任务。
    const sourceEntries = scope === 'all'
      ? state.snapshot.entries
      : state.snapshot.entries.filter((entry) => state.mode === 'full' || state.workset.has(entry.objToken));
    const entries = sourceEntries.map((entry) => {
      const previous = publishedSourceByToken.get(entry.objToken);
      const changeType = state.workset.get(entry.objToken) ?? (state.mode === 'full' ? 'rebuild' : null);
      const assembled = this.assembleBuildRead(state, entry);
      const sourceAvailability = isPermissionDeniedSourcePlaceholder(assembled.resources[0]?.lines.join('\n') ?? '')
        ? 'permission_denied_placeholder' : 'available';
      return {
        objToken: entry.objToken,
        objType: entry.objType,
        title: entry.title,
        relPath: entry.relPath,
        contentHash: entry.contentHash,
        objEditTime: entry.objEditTime,
        changeType,
        sourceAvailability,
        // Mechanical size/outline hints let the Leader split multi-topic sheets
        // before a writer consumes an entire large source in one model turn.
        sourceShape: summarizeRawSourceShape(assembled),
        existingDocPaths: (existingDocPathsBySource.get(entry.objToken) ?? []).sort(),
        // contentHash 不含图片和白板旁路文字；同 hash 仍可能是本轮 changed。
        // 不能让 Leader 据此跳过实际进入工作集的来源。
        unchangedFromPublished: previous
          ? changeType !== 'changed'
            && previous.contentHash === entry.contentHash
            && (!previous.mediaHash || !entry.mediaHash || previous.mediaHash === entry.mediaHash)
            && (previous.whiteboardTextHash ?? '') === (entry.whiteboardTextHash ?? '')
          : null,
      };
    });
    const cursorOffset = typeof args.cursor === 'string' && args.cursor ? Number(Buffer.from(args.cursor, 'base64url').toString('utf-8')) : 0;
    const start = Number.isInteger(cursorOffset) && cursorOffset >= 0 ? cursorOffset : 0;
    const page = entries.slice(start, start + limit);
    const nextCursor = start + limit < entries.length ? Buffer.from(String(start + limit), 'utf-8').toString('base64url') : null;
    return {
      content: [{ type: 'text', text: JSON.stringify({ buildId: context.buildId ?? state.v2?.actorStore.buildId ?? null,
        scope, total: entries.length, requiredRewrites: [...(state.requiredRewrites ?? [])].sort(),
        documentWorkStatus: this.buildDocumentWorkStatus(context, state),
        entries: page, nextCursor }, null, 2) }],
      details: { scope, total: entries.length, returned: page.length, nextCursor },
    };
  }

  /** build_assign_output（Leader，§4.2）：目标写入资格分配。 */
  private toolBuildAssignOutput(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const v2 = requireV2Leader(context);
    const ownerTaskId = requireString(args, 'ownerTaskId', 1, 120);
    const targets = requireArray(args, 'targets');
    if (targets.length === 0 || targets.length > 200 || !targets.every((target): target is string => typeof target === 'string' && target.length > 0)) {
      throw new ToolError('invalid_request', 'targets 必须是 1..200 项的非空字符串数组');
    }
    const targetKind = targets.every((target) => target.startsWith('family:')) ? 'family'
      : targets.every((target) => !target.startsWith('family:')) ? 'doc'
        : (() => { throw new ToolError('invalid_request', 'targets 不能混用文档路径与 family:<familyKey>'); })();
    if (targetKind === 'doc') {
      for (const target of targets) validateStdDocPath(target);
    }
    const normalized = targetKind === 'family' ? targets.map((target) => target.slice('family:'.length)) : targets;
    try {
      const assignment = v2.actorStore.assignOutputs({
        targets: normalized,
        targetKind,
        ownerTaskId,
        ...(args.supersedes === true ? { supersedes: true } : {}),
      });
      return {
        content: [{ type: 'text', text: `已分配 ${normalized.length} 个目标给任务 ${ownerTaskId}（assignmentId=${assignment.assignmentId}${assignment.supersedes ? `，接替 ${assignment.supersedes}` : ''}）` }],
        details: { assignmentId: assignment.assignmentId, ownerTaskId, targetKind, targets: normalized },
      };
    } catch (error) {
      throw wrapActorError(error);
    }
  }

  /** build_revoke_output（Leader，§4.2）：收回分配。 */
  private toolBuildRevokeOutput(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const v2 = requireV2Leader(context);
    const assignmentId = typeof args.assignmentId === 'string' && args.assignmentId ? args.assignmentId : null;
    const ownerTaskId = typeof args.ownerTaskId === 'string' && args.ownerTaskId ? args.ownerTaskId : null;
    if (Number(Boolean(assignmentId)) + Number(Boolean(ownerTaskId)) !== 1) {
      throw new ToolError('invalid_request', 'assignmentId 与 ownerTaskId 必须二选一');
    }
    try {
      const count = v2.actorStore.revokeOutputs({ ...(assignmentId ? { assignmentId } : { ownerTaskId: ownerTaskId! }) });
      return { content: [{ type: 'text', text: `已收回 ${count} 个分配` }], details: { revoked: count } };
    } catch (error) {
      throw wrapActorError(error);
    }
  }

  /** build_handoff_submit（子任务，§5.2）：交接记录（幂等）。 */
  private toolBuildHandoffSubmit(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): ToolResult {
    // A single next step is common in child handoffs; normalize the short form
    // before deriving the operation ID so replays have one canonical payload.
    if (typeof args.nextInfo === 'string') args = { ...args, nextInfo: [args.nextInfo] };
    args = withAutoOperationId(args);
    const state = requireBuildState(context);
    const { v2, actor } = this.requireV2Actor(context, meta);
    const operationId = requireString(args, 'operationId', 1, 200);
    const payloadHash = canonicalPayloadHash(args, ['operationId']);
    const replay = this.v2Replay(v2, actor.nativeTaskId, operationId, payloadHash);
    if (replay) return replay;
    const summary = requireString(args, 'summary', 1, 2000);
    const strList = (key: string): string[] => {
      const values = args[key] === undefined ? [] : requireArray(args, key);
      if (values.length > 200 || !values.every((value): value is string => typeof value === 'string' && value.length > 0)) {
        throw new ToolError('invalid_request', `${key} 必须是至多 200 项的非空字符串数组`);
      }
      return values;
    };
    const record = v2.actorStore.recordHandoff({
      taskId: actor.nativeTaskId,
      role: actor.role,
      summary,
      artifactRefs: strList('artifactRefs'),
      sourceScope: strList('sourceScope'),
      openIssues: strList('openIssues'),
      nextInfo: strList('nextInfo'),
    });
    const result: ToolResult = {
      content: [{ type: 'text', text: `已提交交接记录 ${record.handoffId}（成果引用 ${record.artifactRefs.length}，未解决问题 ${record.openIssues.length}）；最终回复只需引用交接编号与结论` }],
      details: { handoffId: record.handoffId, taskId: record.taskId },
    };
    this.v2RecordReceipt({ v2, nativeTaskId: actor.nativeTaskId, kind: 'handoff', operationId, payloadHash, paths: [], result });
    void state;
    return result;
  }

  /** build_handoff_list（Leader/子任务，只读）。 */
  private toolBuildHandoffList(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const v2 = requireV2Orchestration(context);
    const taskId = typeof args.taskId === 'string' && args.taskId ? args.taskId : undefined;
    const records = v2.actorStore.listHandoffs({ ...(taskId ? { taskId } : {}) });
    // 恢复时先读目录级摘要。完整交接可能含 2k 摘要和大量来源坐标，整批
    // 返回会让 Leader 在一次 high 思考里反复消化历史文本；按 taskId 精读。
    const offset = args.offset === undefined ? 0 : Number(args.offset);
    const limit = args.limit === undefined ? 8 : Number(args.limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ToolError('invalid_request', 'offset 须为非负整数，limit 须为 1–100 的整数');
    }
    // Recovery usually needs the latest author/reviewer handoffs. Returning the
    // oldest 25 records made one read tens of kilobytes and delayed first dispatch.
    const ordered = taskId ? records : [...records].reverse();
    const page = ordered.slice(offset, offset + limit);
    const handoffs = taskId ? page : page.map((record) => ({
      handoffId: record.handoffId,
      taskId: record.taskId,
      role: record.role,
      summary: record.summary.slice(0, 160),
      summaryTruncated: record.summary.length > 160,
      artifactRefs: record.artifactRefs.slice(0, 3),
      artifactRefCount: record.artifactRefs.length,
      sourceScope: record.sourceScope.slice(0, 2),
      sourceScopeCount: record.sourceScope.length,
      openIssues: record.openIssues.slice(0, 1).map((item) => item.slice(0, 120)),
      openIssueCount: record.openIssues.length,
      nextInfoCount: record.nextInfo.length,
      createdAt: record.createdAt,
    }));
    const nextOffset = offset + page.length < records.length ? offset + page.length : null;
    return {
      content: [{ type: 'text', text: JSON.stringify({ handoffs, total: records.length, nextOffset,
        ...(taskId ? {} : { summaryOnly: true, detailHint: '按 taskId 再调用 build_handoff_list 读取完整交接' }) }) }],
      details: { count: page.length, total: records.length, nextOffset },
    };
  }

  /** build_issues_submit（Leader，§5.3）：聚合问题清单。 */
  private toolBuildIssuesSubmit(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const v2 = requireV2Leader(context);
    const summary = typeof args.summary === 'string' ? requireString(args, 'summary', 1, 2000) : null;
    const issueInputs = requireArray(args, 'issues');
    if (issueInputs.length > 500) throw new ToolError('invalid_request', 'issues 至多 500 项');
    const issues = issueInputs.map((raw) => {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', 'issues 每项必须是对象');
      const issueKey = requireString(input, 'issueKey', 1, 200);
      const severity = input.severity;
      if (severity !== 'blocking' && severity !== 'suggestion') {
        throw new ToolError('invalid_request', `severity 必须是 blocking|suggestion: ${String(severity)}`);
      }
      const targetPath = optStr(input, 'targetPath');
      if (severity === 'blocking' && !targetPath) {
        throw new ToolError('invalid_request', 'blocking 问题必须带 targetPath（修订任务需定位范围）');
      }
      return {
        issueKey,
        severity: severity as 'blocking' | 'suggestion',
        targetPath: targetPath ?? null,
        draftLocation: optStr(input, 'draftLocation') ?? null,
        sourceLocation: optStr(input, 'sourceLocation') ?? null,
        description: requireString(input, 'description', 1, 4000),
        fromReviewId: optStr(input, 'fromReviewId') ?? null,
      };
    });
    const record = v2.actorStore.recordIssueList({ summary, issues });
    return {
      content: [{ type: 'text', text: `已提交问题清单 ${record.issueListId}（revision=${record.revision}，问题 ${issues.length} 项：blocking ${issues.filter((issue) => issue.severity === 'blocking').length}）` }],
      details: { issueListId: record.issueListId, revision: record.revision, issues: issues.length },
    };
  }

  /** build_issues_list（Leader/修订子任务，只读；最新 revision）。 */
  private toolBuildIssuesList(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const v2 = requireV2Orchestration(context);
    const lists = v2.actorStore.listIssueLists();
    const latest = lists[lists.length - 1] ?? null;
    if (!latest) {
      return { content: [{ type: 'text', text: JSON.stringify({ issueList: null, note: '尚无问题清单' }) }], details: { count: 0 } };
    }
    const targetPath = typeof args.targetPath === 'string' && args.targetPath ? args.targetPath : null;
    const issues = targetPath ? latest.issues.filter((issue) => issue.targetPath === targetPath) : latest.issues;
    return {
      content: [{ type: 'text', text: JSON.stringify({ issueListId: latest.issueListId, revision: latest.revision, summary: latest.summary, issues }, null, 2) }],
      details: { revision: latest.revision, issues: issues.length },
    };
  }

  /** build_checkpoint（Leader）：保存检查点（成果账本+候选区）或查状态。 */
  private toolBuildCheckpoint(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    const v2 = requireV2Leader(context);
    const action = args.action;
    const store = v2.actorStore;
    const statusSummary = () => ({
      buildId: store.buildId,
      generation: store.activeGeneration,
      actors: store.listActors().length,
      assignments: store.listAssignments().filter((item) => item.status === 'active').length,
      receipts: store.listReceipts().length,
      reviews: store.listReviews().filter((review) => review.status === 'valid').length,
      openBlockingIssues: store.openBlockingIssues(),
      documentWorkStatus: this.buildDocumentWorkStatus(context, state),
      publishing: store.publishing?.requestId ?? null,
      lastPublishRejection: (() => {
        const request = store.latestPublishRequest();
        if (request?.status !== 'rejected' || request.generation !== store.activeGeneration) return null;
        // A progressive publication can resolve a prior rejection without
        // changing the candidate draft. Do not send that obsolete failure back
        // to the Leader as actionable work after CURRENT has advanced.
        const current = this.storeFor(context.options.outputRoot).readManifest();
        if (current?.buildId === store.buildId && request.settledAt
          && Date.parse(current.publishedAt) > Date.parse(request.settledAt)) return null;
        return { requestId: request.requestId, reason: request.result?.reason ?? 'unknown',
          message: typeof request.result?.message === 'string' ? request.result.message : null,
          issues: publishValidationIssues(request.result) };
      })(),
    });
    if (action === 'status') {
      return { content: [{ type: 'text', text: JSON.stringify(statusSummary(), null, 2) }], details: statusSummary() };
    }
    if (action !== 'save') {
      throw new ToolError('invalid_request', `action 必须是 save|status: ${String(action)}`);
    }
    store.persist();
    state.onCheckpoint?.();
    store.appendEvent({ source: 'tool-service', type: 'checkpoint_saved', payload: {} });
    const summary = statusSummary();
    return {
      content: [{ type: 'text', text: `检查点已保存（generation=${summary.generation}，回执 ${summary.receipts}，有效审查 ${summary.reviews}）` }],
      details: summary,
    };
  }

  /** build_request_publish（Leader，§5.4）：候选锁定 + 阻断检查 + 校验管线。 */
  private async toolBuildRequestPublish(context: InternalRunContext, args: Record<string, unknown>): Promise<ToolResult> {
    const state = requireBuildState(context);
    const v2 = requireV2Leader(context);
    const requestedRevision = typeof args.requestedRevision === 'string' && args.requestedRevision ? args.requestedRevision : null;
    const summary = typeof args.summary === 'string' ? requireString(args, 'summary', 1, 4000) : null;
    const entries = this.stagingDraftEntries(state);
    const candidateHash = computeCandidateHash({ documents: entries });
    // 申请的具体候选标识与当前候选不一致 → 版本冲突（仅同形 64 位哈希
    // 比对；非哈希标识交给发布管线解释，§5.4 锁定当前候选）。
    if (requestedRevision && /^[a-f0-9]{64}$/.test(requestedRevision) && requestedRevision !== candidateHash) {
      throw new ToolError('kb_publish_candidate_conflict', `申请的候选 ${requestedRevision.slice(0, 12)}… 与当前候选 ${candidateHash.slice(0, 12)}… 不一致（校验锁定当前候选；请重新申请或检查是否有并行写入）`, 409);
    }
    let request;
    try {
      request = v2.actorStore.beginPublishWindow(candidateHash, requestedRevision);
    } catch (error) {
      throw wrapActorError(error);
    }
    const blocking = v2.actorStore.openBlockingIssues();
    if (blocking > 0) {
      v2.actorStore.settlePublishRequest(request.requestId, 'rejected', { reason: 'blocking_issues', blocking });
      throw new ToolError('build_blocking_issues', `存在 ${blocking} 个未解决 blocking 问题，不能申请发布（先修订并重新聚合问题清单）`, 409);
    }
    const handler = v2.publishHandler ?? state.v2?.publishHandler;
    if (!handler) {
      v2.actorStore.settlePublishRequest(request.requestId, 'not_wired', { reason: 'publish_handler_missing' });
      throw new ToolError('build_publish_not_wired', '发布校验管线未接线（publishHandler 未注入）；候选已锁定在本窗口，请集成者接线后重试', 501);
    }
    try {
      // F11 补强：把本次工具调用的 Leader ctx 租约闭包随请求传递（服务端
      // 内部引用比对，不经模型 JSON；wrapPublishExecutor 原样透传）。
      const authorityLease = {
        validate: () => {
          if (!this.isContextLive(context)) {
            throw new ToolError('run_token_invalid', '发布提交点：Leader 运行上下文已撤销（取消/换代/收尾），发布中止（CURRENT 未切换）', 401);
          }
        },
      };
      const outcome = await handler({ buildId: v2.actorStore.buildId, generation: v2.actorStore.activeGeneration, candidateHash, requestedRevision, summary, authorityLease });
      v2.actorStore.settlePublishRequest(request.requestId, outcome.accepted ? 'accepted' : 'rejected', outcome.result);
      const reasons = Array.isArray(outcome.result.reasons) ? outcome.result.reasons.map(String) : [];
      const details = Array.isArray(outcome.result.details) ? outcome.result.details.map(String) : [];
      const issues = publishValidationIssues(outcome.result).map((item) =>
        `${item.code}${item.path ? ` [${item.path}]` : ''}${item.message ? `：${item.message}` : ''}`);
      const message = typeof outcome.result.message === 'string' ? outcome.result.message : '';
      const rejection = outcome.accepted ? '' : `；原因：${[String(outcome.result.reason ?? 'unknown'), ...reasons, ...details.slice(0, 8), ...issues, ...(message ? [message] : [])].join('；')}`;
      return {
        content: [{ type: 'text', text: `发布申请 ${request.requestId} 已结算：${outcome.accepted ? 'accepted' : 'rejected'}（候选 ${candidateHash.slice(0, 12)}…）${rejection}` }],
        details: { requestId: request.requestId, accepted: outcome.accepted, candidateHash, result: outcome.result },
      };
    } catch (error) {
      v2.actorStore.settlePublishRequest(request.requestId, 'rejected', { reason: 'handler_error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** kb_read_batch（§7）：多资源批量读取——预算/游标/截断；raw 登记
   * 读取回执（与 raw_read 同语义），draft 返回参数坐标正文与可选声明。 */
  private toolKbReadBatch(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): ToolResult {
    const state = requireBuildState(context);
    if (!context.options.buildState) {
      throw new ToolError('invalid_request', 'kb_read_batch 仅在构建态可用（会话态请用 raw_read / kb_read）');
    }
    const maxLines = optionalInt(args, 'maxLines', 1200, 1, 4000);
    type BatchRequest = { kind: 'raw' | 'draft'; objToken?: string; path?: string; offset: number; limit?: number; includeDeclarations?: boolean; declarationClaimKey?: string; declarationObjectKey?: string };
    const normalizeRequest = (raw: unknown, label: string): BatchRequest => {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', `${label} 每项必须是对象`);
      if (input.kind !== 'raw' && input.kind !== 'draft') throw new ToolError('invalid_request', `${label}.kind 非法: ${String(input.kind)}`);
      if (input.kind === 'raw' && typeof input.objToken !== 'string') throw new ToolError('invalid_request', 'raw 请求必须带 objToken');
      if (input.kind === 'draft' && typeof input.path !== 'string') throw new ToolError('invalid_request', 'draft 请求必须带 path');
      return {
        kind: input.kind,
        ...(input.kind === 'raw' ? { objToken: requireString(input, 'objToken', 1, 256) } : { path: requireString(input, 'path', 1, 600) }),
        offset: optionalInt(input, 'offset', 0, 0, 10_000_000),
        ...(input.limit !== undefined ? { limit: optionalInt(input, 'limit', 800, 1, 2000) } : {}),
        ...(input.includeDeclarations === true ? { includeDeclarations: true } : {}),
        ...(input.declarationClaimKey !== undefined ? { declarationClaimKey: requireString(input, 'declarationClaimKey', 1, 200) } : {}),
        ...(input.declarationObjectKey !== undefined ? { declarationObjectKey: requireString(input, 'declarationObjectKey', 1, 200) } : {}),
      };
    };
    let queue: BatchRequest[];
    // F05：每请求预算重置——cursor 只携带剩余队列与位置，不携带跨请求
    // linesUsed（此前原样恢复导致续页 while(linesUsed<maxLines) 恒假，返回
    // 空结果与相同 cursor，游标永久死锁）；携带旧版 linesUsed 字段时忽略。
    let linesUsed = 0;
    if (typeof args.cursor === 'string' && args.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf-8')) as { queue?: unknown };
        if (!Array.isArray(decoded.queue) || decoded.queue.length === 0 || decoded.queue.length > 50) throw new Error('shape');
        queue = decoded.queue.map((raw) => normalizeRequest(raw, 'cursor.queue'));
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError('invalid_request', 'cursor 无效（请原样回传 nextCursor）');
      }
    } else {
      const inputs = requireArray(args, 'requests');
      if (inputs.length === 0 || inputs.length > 50) throw new ToolError('invalid_request', 'requests 必须是 1..50 项');
      queue = inputs.map((raw) => normalizeRequest(raw, 'requests'));
    }
    const results: Array<Record<string, unknown>> = [];
    const receipts: ReadReceiptRecord[] = [];
    // 每个原始请求在本次调用中最多返回一页。续页放入 nextCursor，不能
    // 在同一调用中反复执行 limit=1 的请求（尤其 includeDeclarations=true
    // 会把整份声明重复序列化数百次，放大为数百万 token）。
    const pageRequests = queue.length;
    for (let requestIndex = 0; requestIndex < pageRequests && queue.length > 0 && linesUsed < maxLines; requestIndex += 1) {
      const request = queue.shift()!;
      const budgetLeft = maxLines - linesUsed;
      const effLimit = Math.min(request.limit ?? 800, budgetLeft, 2000);
      if (request.kind === 'raw') {
        const entry = state.snapshot.get(request.objToken!);
        if (!entry) {
          results.push({ kind: 'raw', objToken: request.objToken, error: `原始文档不存在或无成功本地版本: ${request.objToken}` });
          continue;
        }
        const assembled = this.assembleBuildRead(state, entry);
        const slice = assembled.lines.slice(request.offset, request.offset + effLimit);
        const winStart = request.offset + 1;
        const winEnd = request.offset + slice.length;
        const truncated = winEnd < assembled.lines.length;
        const segmentMap: Array<Record<string, unknown>> = [];
        const resourceById = new Map(assembled.resources.map((resource) => [resource.resourceId, resource]));
        for (const segment of assembled.segments) {
          if (segment.outEnd < winStart || segment.outStart > winEnd) continue;
          const clippedStart = Math.max(segment.outStart, winStart);
          const clippedEnd = Math.min(segment.outEnd, winEnd);
          if (segment.resourceId) {
            const resource = resourceById.get(segment.resourceId)!;
            const resStart = segment.resStart! + (clippedStart - segment.outStart);
            const resEnd = segment.resStart! + (clippedEnd - segment.outStart);
            const returnedText = resource.lines.slice(resStart - 1, resEnd).join('\n');
            const readReceiptId = `rr_${crypto.randomBytes(9).toString('hex')}`;
            receipts.push({
              readReceiptId,
              buildId: context.buildId ?? 'unknown',
              unitId: context.options.worker?.unitId ?? null,
              toolCallId: meta?.toolCallId ?? 'unknown',
              sourceSnapshotHash: entry.contentHash,
              resourceId: segment.resourceId,
              selector: { kind: 'read_range', lineStart: resStart, lineEnd: resEnd },
              returnedHash: contentResourceHash(returnedText),
              truncated,
            });
            segmentMap.push({ resourceId: segment.resourceId, outStart: clippedStart, outEnd: clippedEnd, resStart, resEnd, readReceiptId });
          } else {
            segmentMap.push({ derived: segment.derived ?? 'derived', outStart: clippedStart, outEnd: clippedEnd });
          }
        }
        linesUsed += slice.length;
        results.push({
          kind: 'raw',
          objToken: entry.objToken,
          title: entry.title,
          relPath: entry.relPath,
          offset: request.offset,
          returnedLines: slice.length,
          totalLines: assembled.lines.length,
          truncated,
          text: `<untrusted_source obj_token="${entry.objToken}" title="${escapeXml(entry.title)}">\n${slice.join('\n')}\n</untrusted_source>`,
          segmentMap,
        });
        if (truncated) {
          queue.push({ ...request, offset: request.offset + slice.length });
        }
      } else {
        const docPath = request.path!;
        try {
          validateStdDocPath(docPath);
        } catch (error) {
          results.push({ kind: 'draft', path: docPath, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        const target = path.join(state.stagingRoot, 'docs', docPath);
        if (!fs.existsSync(target)) {
          results.push({ kind: 'draft', path: docPath, error: `草稿不存在: ${docPath}` });
          continue;
        }
        const coordinates = draftEditCoordinates(fs.readFileSync(target, 'utf-8'));
        const slice = coordinates.paramLines.slice(request.offset, request.offset + effLimit);
        const truncated = request.offset + slice.length < coordinates.paramLines.length;
        linesUsed += slice.length;
        results.push({
          kind: 'draft',
          path: docPath,
          coordinateBasis: 'param',
          offset: request.offset,
          returnedLines: slice.length,
          totalLines: coordinates.paramLines.length,
          truncated,
          contentHash: contentResourceHash(coordinates.paramLines.join('\n')),
          text: slice.join('\n'),
          ...(request.includeDeclarations ? { declarations: this.renderDraftDeclarations(state, docPath, request.declarationClaimKey ?? null, request.declarationObjectKey ?? null) } : {}),
        });
        if (truncated) {
          queue.push({ ...request, offset: request.offset + slice.length, includeDeclarations: false });
        }
      }
    }
    if (receipts.length > 0) this.appendReadReceipts(state, receipts);
    const nextCursor = queue.length > 0
      ? Buffer.from(JSON.stringify({ queue }), 'utf-8').toString('base64url')
      : null;
    return {
      content: [{ type: 'text', text: JSON.stringify({ results, nextCursor, linesUsed, budget: maxLines }, null, 2) }],
      details: { resources: results.length, linesUsed, nextCursor, receipts: receipts.length },
    };
  }

  /** kb_edit_doc（§7）：局部编辑——稳定定位/声明继承/结构化错误/审查失效；
   * 复用 writeDocCore 同一校验链（不绕开）；幂等与分配在 v2 包装层。 */
  private async toolKbEditDoc(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): Promise<ToolResult> {
    args = withAutoOperationId(args);
    const state = requireBuildState(context);
    this.assertNotReviewPhase(context);
    const docPath = requireString(args, 'path', 1, 600);
    validateStdDocPath(docPath);
    const operationId = requireString(args, 'operationId', 1, 200);
    const v2 = context.options.orchestration ?? null;
    let v2Info: { v2: OrchestrationV2Options; actor: NonNullable<ReturnType<BuildActorStore["lookupActor"]>>; operationId: string; payloadHash: string } | null = null;
    if (v2 && v2.credential === 'child') {
      const { actor } = this.requireV2Actor(context, meta);
      const payloadHash = canonicalPayloadHash(args, ['operationId', 'expectedContentHash', 'expectedDraftRevision']);
      // F06：幂等预检移入锁内（editOperation 首步）——锁外预检时并发同键
      // 调用会双双看到无回执，第二个持锁者不再重查、在已变更正文上二次
      // 编辑（重复改/锚点丢失）；与 kb_write_doc 的锁内预检对齐。
      v2Info = { v2, actor, operationId, payloadHash };
    }
    const plainTarget = path.join(state.stagingRoot, 'docs', docPath);
    if (!fs.existsSync(plainTarget) || !fs.statSync(plainTarget).isFile()) {
      throw new ToolError('not_found', `草稿不存在: ${docPath}（局部编辑只能改已有草稿；新建用 kb_write_doc）`, 404);
    }
    // v2（§4.4 硬验收）：从草稿读取到落盘记账整体置于同一受控锁链（与
    // kb_write_doc 同一把声明锁）——expectedContentHash 校验、补丁定位、
    // 最终提交与回执记账之间无并发窗口；锁内最终落盘前重检写入窗口。
    // 非 v2（旧模式未下发本工具；防御路径）保持直调，writeDocCore 自行加锁。
    const editOperation = async (): Promise<ToolResult> => {
    // F06：锁内幂等重查——排队期间同键同载荷已提交 → 重放原回执；
    // 同键异载荷 → kb_idempotency_conflict（v2Replay 语义不变，仅时机后移）。
    if (v2Info?.actor) {
      const replay = this.v2Replay(v2Info.v2, v2Info.actor.nativeTaskId, v2Info.operationId, v2Info.payloadHash);
      if (replay) return replay;
      // F06：崩溃重放第二层——v2 回执丢失（崩溃重启语义，新 store 从盘
      // 恢复而 receipts 未持久）时，声明幂等账本 calls（稳定键
      // v2_<task>_<operationId>，不依赖桥接随机 toolCallId）已登记 = 本
      // 操作正文已落盘。重放前必须核验载荷哈希（原子落盘时随 calls 条目
      // 记录）：同载荷才重放原结果；异载荷报幂等冲突（同键不可假成功）；
      // 旧账本缺哈希明确拒绝。必须在 expectedContentHash 校验之前（重试
      // 携带的是编辑前基准，正文已变，否则误报冲突）。
      const draftFile = path.join(state.stagingRoot, 'knowledge-draft.json');
      if (state.knowledgeDraft || fs.existsSync(draftFile)) {
        const pendingCalls = this.loadKnowledgeDraft(state).calls;
        const priorCall = pendingCalls[stableV2CallKey(v2Info.actor.nativeTaskId, operationId)];
        if (priorCall) {
          this.verifyCallsLedgerPayload(priorCall, operationId, v2Info.payloadHash);
          return {
            content: [{ type: 'text', text: `已重放局部编辑 ${docPath}（幂等重放，docId=${priorCall.docId}，draftRevision=${priorCall.draftRevision}）` }],
            details: {
              path: priorCall.path, docId: priorCall.docId, bytes: priorCall.bytes,
              idempotentReplay: true, draftRevision: priorCall.draftRevision,
              edit: { operationId, patches: [], affectedObjects: Object.keys(priorCall.objectIdMap ?? {}).length, inheritedDeclarations: true, callsLedgerReplay: true },
            },
          };
        }
      }
    }
    // v2（§4.2）：存在性与内容基准确认后再校验分配（未分配写入可重试）
    if (v2Info?.actor) {
      this.assertV2OutputAssignment(v2Info.v2, v2Info.actor.nativeTaskId, docPath);
    }
    const coordinates = draftEditCoordinates(fs.readFileSync(resolveInside(path.join(state.stagingRoot, 'docs'), docPath, 'read'), 'utf-8'));
    if (typeof args.expectedContentHash === 'string' && args.expectedContentHash) {
      if (contentResourceHash(coordinates.paramLines.join('\n')) !== args.expectedContentHash) {
        throw new ToolError('kb_edit_conflict', `expectedContentHash 与当前草稿不一致（草稿已被修改；请 draft_read 重读后重提）`, 409);
      }
    }
    // 顺序应用补丁（后续补丁在前一补丁产生的文本上定位）
    const patchInputs = args.patches === undefined ? [] : requireArray(args, 'patches');
    const evidenceSelectorUpdates = args.evidenceSelectorUpdates === undefined ? [] : requireArray(args, 'evidenceSelectorUpdates');
    const coverageUpdates = args.coverageUpdates === undefined ? [] : requireArray(args, 'coverageUpdates');
    const mergeInputs = args.objectMerges === undefined ? [] : requireArray(args, 'objectMerges');
    if (patchInputs.length > 50 || evidenceSelectorUpdates.length > 20 || coverageUpdates.length > 20 || mergeInputs.length > 20
      || (patchInputs.length === 0 && evidenceSelectorUpdates.length === 0 && coverageUpdates.length === 0 && mergeInputs.length === 0)) {
      throw new ToolError('invalid_request', 'patches、evidenceSelectorUpdates、coverageUpdates 与 objectMerges 至少一项非空，且分别不超过 50/20/20/20 项');
    }
    const objectMerges: Array<{ fromObjectId: string; toObjectId: string; reason: string }> = [];
    if (mergeInputs.length > 0) {
      const draft = this.loadKnowledgeDraft(state);
      const seen = new Set<string>();
      for (const [index, raw] of mergeInputs.entries()) {
        const input = asRecord(raw);
        if (!input) throw new ToolError('invalid_request', `objectMerges[${index}] 必须是对象`);
        const fromObjectId = requireString(input, 'fromObjectId', 1, 200);
        const toObjectId = requireString(input, 'toObjectId', 1, 200);
        const reason = requireString(input, 'reason', 4, 500);
        if (fromObjectId === toObjectId || seen.has(fromObjectId)) {
          throw new ToolError('kb_object_merge_invalid', `objectMerges[${index}] 对象相同或来源重复`, 409);
        }
        seen.add(fromObjectId);
        const from = draft.objects.find((object) => !object.tombstone && object.objectId === fromObjectId
          && object.canonical?.path === docPath);
        const to = draft.objects.find((object) => !object.tombstone && object.objectId === toObjectId);
        if (!from || !to) throw new ToolError('kb_object_merge_invalid', `合并对象必须是本篇现有对象与已登记后继对象: ${fromObjectId} → ${toObjectId}`, 409);
        if (draft.relations.some((relation) => relation.toObjectId === fromObjectId && relation.fromObjectId !== fromObjectId)
          || draft.presentations.some((presentation) => presentation.targetObjectId === fromObjectId && presentation.ownerObjectId !== fromObjectId)) {
          throw new ToolError('kb_object_merge_invalid', `对象 ${fromObjectId} 被其他对象关系或呈现引用；请先处理引用，不能自动合并`, 409);
        }
        const successorSources = new Set(draft.evidence.filter((evidence) => evidence.objectId === toObjectId)
          .map((evidence) => evidence.sourceRef.sourceId));
        if (successorSources.size === 0 || !draft.evidence.some((evidence) => evidence.objectId === fromObjectId
          && successorSources.has(evidence.sourceRef.sourceId))
          || draft.coverage.some((item) => item.targetObjectIds.includes(fromObjectId)
            && !successorSources.has(item.sourceRef.sourceId))) {
          throw new ToolError('kb_object_merge_invalid', `对象 ${fromObjectId} 与后继 ${toObjectId} 缺少共同来源证据，不能自动转移覆盖项`, 409);
        }
        objectMerges.push({ fromObjectId, toObjectId, reason });
      }
    }
    let current = [...coordinates.paramLines];
    const applied: Array<{ startLine: number; endLine: number; newLineCount: number; anchor: string }> = [];
    for (const [index, raw] of patchInputs.entries()) {
      const input = asRecord(raw);
      if (!input) throw new ToolError('invalid_request', `patches[${index}] 必须是对象`);
      const anchor = asRecord(input.anchor);
      if (!anchor) throw new ToolError('invalid_request', `patches[${index}].anchor 必须是对象`);
      const newText = typeof input.newText === 'string' ? input.newText : requireString(input, 'newText', 1, 2_000_000);
      const newLines = newText.split('\n');
      let startLine = 0;
      let endLine = 0;
      const kind = anchor.kind;
      if (kind === 'exact_text') {
        const oldText = requireString(anchor, 'oldText', 1, 200_000);
        const joined = current.join('\n');
        const hits: number[] = [];
        let cursor = 0;
        while (cursor <= joined.length) {
          const at = joined.indexOf(oldText, cursor);
          if (at < 0) break;
          hits.push(at);
          cursor = at + 1;
        }
        if (hits.length === 0) {
          throw new ToolError('kb_edit_anchor_not_found', `patches[${index}] oldText 未命中（正文可能已修改；请 draft_read 重读后重提）`, 409);
        }
        const occurrence = anchor.occurrence === undefined ? 1 : optionalInt(anchor, 'occurrence', 1, 1, 1000);
        if (hits.length > 1 && anchor.occurrence === undefined) {
          throw new ToolError('kb_edit_anchor_ambiguous', `patches[${index}] oldText 命中 ${hits.length} 处（行 ${hits.map((at) => joined.slice(0, at).split('\n').length).join(', ')}）；请扩大上下文使其唯一或用 occurrence 指定`, 409);
        }
        if (occurrence > hits.length) {
          throw new ToolError('kb_edit_anchor_not_found', `patches[${index}] occurrence=${occurrence} 超出命中数 ${hits.length}`, 409);
        }
        const at = hits[occurrence - 1]!;
        // F04：字符区间精确替换——只动 oldText 命中的字符，行内前后缀与
        // 多行边界内容一律保全（此前按起止行整行 splice，会把同行未选中的
        // prefix/suffix 一并删除）。applied 坐标供声明平移（shiftBodyRange）
        // 使用：旧行区间 = 命中首行..末行，新行数 = 前缀+newText+后缀的行数。
        const before = joined.slice(0, at);
        const after = joined.slice(at + oldText.length);
        const hitStartLine = before.split('\n').length;
        const hitEndLine = hitStartLine + oldText.split('\n').length - 1;
        const spanPrefix = before.slice(before.lastIndexOf('\n') + 1);
        const nextBreak = after.indexOf('\n');
        const spanSuffix = after.slice(0, nextBreak < 0 ? after.length : nextBreak);
        const spanLineCount = (spanPrefix + newText + spanSuffix).split('\n').length;
        current = (before + newText + after).split('\n');
        applied.push({ startLine: hitStartLine, endLine: hitEndLine, newLineCount: spanLineCount, anchor: `${kind}` });
        continue;
      } else if (kind === 'heading_body') {
        const headingPath = optStrArray(anchor, 'headingPath');
        if (!headingPath || headingPath.length === 0) throw new ToolError('invalid_request', `patches[${index}].headingPath 必填`);
        const occurrence = anchor.occurrence === undefined ? 1 : optionalInt(anchor, 'occurrence', 1, 1, 1000);
        const resolved = resolveHeadingBodyRange(current, headingPath, occurrence);
        if (!resolved) {
          throw new ToolError('kb_edit_anchor_not_found', `patches[${index}] headingPath 未命中: ${headingPath.join(' > ')}#${occurrence}`, 409);
        }
        startLine = resolved.startLine;
        endLine = resolved.endLine;
      } else if (kind === 'line_range') {
        startLine = optionalInt(anchor, 'startLine', 1, 1, 10_000_000);
        endLine = optionalInt(anchor, 'endLine', startLine, startLine, 10_000_000);
      } else {
        throw new ToolError('invalid_request', `patches[${index}].anchor.kind 非法: ${String(kind)}`);
      }
      if (startLine < 1 || endLine > current.length || startLine > endLine) {
        throw new ToolError('invalid_request', `patches[${index}] 区间越界（1..${current.length}，请求 ${startLine}..${endLine}）`);
      }
      current = [...current.slice(0, startLine - 1), ...newLines, ...current.slice(endLine)];
      applied.push({ startLine, endLine, newLineCount: newLines.length, anchor: `${kind}` });
    }
    // writeDocCore appends one terminal newline. Evidence-only edits must not
    // accumulate an extra blank line on every metadata revision.
    const newMarkdown = patchInputs.length === 0 && current.at(-1) === ''
      ? current.slice(0, -1).join('\n')
      : current.join('\n');
    // 元数据继承（缺省沿用；summary 无源时必须显式提供）
    const summary = args.summaryUpdate !== undefined
      ? requireString(args, 'summaryUpdate', 1, 400)
      : state.docMeta?.get(docPath)?.summary;
    if (!summary) {
      throw new ToolError('kb_edit_metadata_missing', `无法继承 ${docPath} 的摘要（docMeta 缺失，常见于恢复后首编）；请传 summaryUpdate`, 400);
    }
    const tags = args.tagsUpdate !== undefined
      ? requireArray(args, 'tagsUpdate').filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
      : state.docMeta?.get(docPath)?.tags ?? [];
    const sourcesAppend = args.sourcesAppend === undefined ? [] : requireArray(args, 'sourcesAppend');
    if (sourcesAppend.length && !sourcesAppend.every((source): source is string => typeof source === 'string')) {
      throw new ToolError('invalid_request', 'sourcesAppend 必须是字符串数组');
    }
    const sources = [...new Set([...coordinates.sources, ...(sourcesAppend as string[])])];
    const inheritedDeclarations = this.inheritDeclarationsForEdit(state, docPath,
      applied.map(({ startLine, endLine, newLineCount }) => ({ startLine, endLine, newLineCount })),
      new Set(objectMerges.map((merge) => merge.fromObjectId)));
    const inheritedCoverage: Array<Record<string, unknown>> = [];
    if (coverageUpdates.length > 0) {
      const draft = this.loadKnowledgeDraft(state);
      const seen = new Set<string>();
      for (const [index, raw] of coverageUpdates.entries()) {
        const update = asRecord(raw);
        if (!update) throw new ToolError('invalid_request', `coverageUpdates[${index}] 必须是对象`);
        const itemId = requireString(update, 'itemId', 1, 200);
        if (seen.has(itemId)) throw new ToolError('invalid_request', `coverageUpdates.itemId 重复: ${itemId}`);
        seen.add(itemId);
        const old = draft.coverage.find((item) => item.itemId === itemId);
        if (!old) throw new ToolError('kb_coverage_invalid', `覆盖项不存在: ${itemId}`);
        if (!coordinates.sources.includes(old.sourceRef.sourceId))
          throw new ToolError('kb_coverage_invalid', `覆盖项 ${itemId} 不属于草稿 ${docPath} 的来源`);
        if (update.sourceId !== undefined && update.sourceId !== old.sourceRef.sourceId)
          throw new ToolError('kb_coverage_invalid', `覆盖项 ${itemId} 的来源不可变`);
        if (update.category !== undefined && update.category !== old.category)
          throw new ToolError('kb_coverage_invalid', `覆盖项 ${itemId} 的分类不可变`);
        const disposition = requireString(update, 'disposition', 1, 40);
        if (old.importance === 'important' && old.disposition === 'mapped'
          && old.targetObjectIds.length > 0 && disposition === 'excluded_nonknowledge') {
          throw new ToolError('kb_coverage_invalid', `覆盖项 ${itemId} 已映射重要知识，不能用 excluded_nonknowledge 绕过对象归属；重复对象请用 objectMerges 转移映射，真正来源更正须在重新审查中处理`, 409);
        }
        const targetKeys = update.targetKeys === undefined ? old.targetObjectIds : optStrArray(update, 'targetKeys') ?? [];
        for (const key of targetKeys) {
          const id = draft.clientKeys[key] ?? key;
          if (!draft.objects.some((object) => !object.tombstone && object.objectId === id && object.canonical?.path === docPath))
            throw new ToolError('kb_coverage_invalid', `覆盖项 ${itemId} 的目标对象不属于草稿 ${docPath}: ${key}`);
        }
        inheritedCoverage.push({
          itemId, sourceId: old.sourceRef.sourceId, category: old.category,
          importance: update.importance ?? old.importance,
          disposition,
          ...((update.targetKeys !== undefined || disposition === 'mapped')
            ? { targetKeys } : {}),
          ...((update.reason !== undefined || disposition === 'excluded_template' || disposition === 'excluded_nonknowledge' || disposition === 'unresolved')
            ? { reason: update.reason ?? old.reason } : {}),
        });
      }
    }
    if (evidenceSelectorUpdates.length > 0) {
      const evidenceInputs = inheritedDeclarations.evidenceClaims as Array<Record<string, unknown>> | undefined;
      if (!evidenceInputs) throw new ToolError('invalid_request', '草稿没有可更新的证据声明');
      const draft = this.loadKnowledgeDraft(state);
      const keyById = new Map(Object.entries(draft.evidenceKeys).map(([key, id]) => [id, key]));
      const seen = new Set<string>();
      for (const [index, raw] of evidenceSelectorUpdates.entries()) {
        const update = asRecord(raw);
        if (!update) throw new ToolError('invalid_request', `evidenceSelectorUpdates[${index}] 必须是对象`);
        const evidenceId = requireString(update, 'evidenceId', 1, 200);
        if (seen.has(evidenceId)) throw new ToolError('invalid_request', `evidenceSelectorUpdates.evidenceId 重复: ${evidenceId}`);
        seen.add(evidenceId);
        const key = keyById.get(evidenceId) ?? evidenceId;
        const target = evidenceInputs.find((item) => item.clientKey === key);
        if (!target) throw new ToolError('invalid_request', `证据 ${evidenceId} 不属于草稿 ${docPath}`);
        // 只允许替换 selector。来源、对象和断言身份由原声明继承；新的
        // 行列范围仍由 writeDocCore 使用冻结资源与当前读回执重新校验。
        target.selector = parseSelector(update.selector);
        delete target.readReceiptId;
        if (update.readReceiptId !== undefined) {
          target.readReceiptId = requireString(update, 'readReceiptId', 1, 200);
        }
      }
    }
    const writeArgs: Record<string, unknown> = {
      path: docPath,
      title: args.titleUpdate !== undefined ? requireString(args, 'titleUpdate', 1, 300) : coordinates.title,
      markdown: newMarkdown,
      summary,
      sources,
      ...(tags.length ? { tags } : {}),
      // 声明继承：未变声明自动平移；受影响对象重算哈希（payload 变化 → revision+1）
      ...inheritedDeclarations,
      ...(inheritedCoverage.length ? { coverageUpdates: inheritedCoverage } : {}),
      ...(args.expectedDraftRevision !== undefined ? { expectedDraftRevision: optionalInt(args, 'expectedDraftRevision', 0, 0, 1_000_000_000) } : {}),
    };
    // 同一校验链（header/来源/正文策略/声明解引用/原子写），声明的
    // knowledge-draft 幂等用稳定键（v2 任务内 operationId 唯一）：崩溃后
    // 重放两层互补（calls 账本 + v2 回执账本）。
    const editMeta: ToolRequestMeta = {
      ...(meta ?? {}),
      // F06：v2 声明幂等账本（calls）用稳定键 v2_<task>_<operationId>——
      // 桥接每次调用的 toolCallId 是随机 ID，回执丢失后的崩溃重放不能落
      // 在随机键上（与 kb_write_doc 的 stableMeta 同口径）；非 v2 保持原
      // 语义（调用侧 toolCallId 优先，缺省 edit_<operationId>）。
      toolCallId: v2Info?.actor
        ? stableV2CallKey(v2Info.actor.nativeTaskId, operationId)
        : (meta?.toolCallId ?? `edit_${operationId}`),
    };
    const result = await this.writeDocCore(context, writeArgs, editMeta, {
      ...(v2Info?.actor
        ? {
          lockHeld: true,
          recheck: () => this.assertV2WriteWindow(v2Info.v2, v2Info.actor!.nativeTaskId, meta, docPath),
          idempotency: { payloadHash: v2Info.payloadHash },
          objectMerges,
        }
        : { objectMerges }),
    });
    const affectedObjects = (writeArgs.objects as Array<Record<string, unknown>> | undefined)?.length ?? 0;
    const enriched: ToolResult = {
      content: result.content,
      details: {
        ...(result.details ?? {}),
        edit: { operationId, patches: applied, affectedObjects, inheritedDeclarations: affectedObjects > 0,
          objectMerges: objectMerges.map(({ fromObjectId, toObjectId, reason }) => ({ fromObjectId, toObjectId, reason })) },
      },
    };
    if (v2Info?.actor) {
      this.v2RecordReceipt({ v2: v2Info.v2, nativeTaskId: v2Info.actor!.nativeTaskId, kind: 'edit_doc', operationId: v2Info.operationId, payloadHash: v2Info.payloadHash, paths: [docPath], result: enriched, invalidateReviews: true });
    }
    return enriched;
    };
    return v2Info?.actor
      ? this.withKnowledgeDeclarationLock(state, editOperation)
      : editOperation();
  }

  /** draft 声明提取（draft_read 与 kb_read_batch 共用；坐标=参数坐标）。 */
  private renderDraftDeclarations(state: BuildRunState, docPath: string, claimKey: string | null = null, objectKey: string | null = null): Record<string, unknown> | null {
    const draftFile = path.join(state.stagingRoot, 'knowledge-draft.json');
    if (!state.knowledgeDraft && !fs.existsSync(draftFile)) return null;
    const draft = this.loadKnowledgeDraft(state);
    const keysById = new Map(Object.entries(draft.clientKeys).map(([key, id]) => [id, key]));
    const objects = draft.objects.filter((object) => !object.tombstone && object.canonical?.path === docPath
      && (!claimKey || object.claims.some((claim) => claim.claimKey === claimKey))
      && (!objectKey || object.objectId === objectKey || keysById.get(object.objectId) === objectKey));
    const ids = new Set(objects.map((object) => object.objectId));
    const result = {
      draftRevision: draft.docs[docPath]?.revision ?? 0,
      objects: objects.map((object) => ({
        clientKey: keysById.get(object.objectId) ?? object.objectId,
        objectId: object.objectId,
        type: object.type,
        title: object.title,
        aliases: object.aliases,
        domainIds: object.domainIds,
        familyKey: object.familyKey,
        variantKey: object.variantKey,
        scopeKey: object.scopeKey,
        scopeText: object.scopeText,
        bodyRange: object.canonical?.bodyRange,
        claims: object.claims.filter((claim) => !claimKey || claim.claimKey === claimKey)
          .map((claim) => ({ claimKey: claim.claimKey, riskCategory: claim.riskCategory, bodyRange: claim.bodyRange, evidenceIds: claim.evidenceIds })),
      })),
      evidence: draft.evidence.filter((item) => ids.has(item.objectId) && (!claimKey || item.claimKey === claimKey)),
      presentations: claimKey ? [] : draft.presentations.filter((item) => ids.has(item.ownerObjectId)),
      relations: claimKey ? [] : draft.relations.filter((item) => ids.has(item.fromObjectId)),
    };
    if (claimKey || objectKey || JSON.stringify(result).length <= 18_000) return result;
    // Pi may redirect oversized MCP output to a temporary file outside a
    // child's read envelope. Return a bounded index; callers can retrieve one
    // object's full declarations with declarationObjectKey.
    return {
      draftRevision: result.draftRevision,
      summaryOnly: true,
      objectCount: result.objects.length,
      evidenceCount: result.evidence.length,
      presentationCount: result.presentations.length,
      relationCount: result.relations.length,
      objects: result.objects.map((object) => ({
        clientKey: object.clientKey,
        objectId: object.objectId,
        title: object.title,
        claimKeys: object.claims.map((claim) => claim.claimKey),
      })),
      nextAction: '用 includeDeclarations=true + declarationObjectKey=<clientKey 或 objectId> 逐对象读取完整声明；正文用 offset/limit 分页读取',
    };
  }

  /** kb_edit_doc 声明继承（§7）：server 继承未变声明并平移坐标；
   * 受影响对象由 writeDocCore 重算 payloadHash（内容变 → revision+1）。 */
  private inheritDeclarationsForEdit(
    state: BuildRunState,
    docPath: string,
    patches: Array<{ startLine: number; endLine: number; newLineCount: number }>,
    excludedObjectIds: ReadonlySet<string> = new Set(),
  ): Record<string, unknown> {
    const draftFile = path.join(state.stagingRoot, 'knowledge-draft.json');
    if (!state.knowledgeDraft && !fs.existsSync(draftFile)) return {};
    const draft = this.loadKnowledgeDraft(state);
    const objects = draft.objects.filter((object) => !object.tombstone && object.canonical?.path === docPath
      && !excludedObjectIds.has(object.objectId));
    if (objects.length === 0) return {};
    const ids = new Set(objects.map((object) => object.objectId));
    const keysById = new Map<string, string>();
    for (const [key, id] of Object.entries(draft.clientKeys)) {
      if (ids.has(id) && !keysById.has(id)) keysById.set(id, key);
    }
    const evidenceKeyById = new Map<string, string>();
    for (const [key, id] of Object.entries(draft.evidenceKeys)) evidenceKeyById.set(id, key);
    const refOf = (objectId: string): string => keysById.get(objectId) ?? objectId;
    const shift = (range: BodyRange): BodyRange => shiftBodyRange(range, patches);
    const objectInputs = objects.map((object) => ({
      clientKey: keysById.get(object.objectId) ?? object.objectId,
      type: object.type,
      title: object.title,
      ...(object.aliases && object.aliases.length ? { aliases: object.aliases } : {}),
      ...(object.domainIds && object.domainIds.length ? { domainIds: object.domainIds } : {}),
      familyKey: object.familyKey,
      variantKey: object.variantKey,
      scopeKey: object.scopeKey,
      scopeText: object.scopeText,
      bodyRange: shift(object.canonical!.bodyRange),
      claims: object.claims.map((claim) => ({
        claimKey: claim.claimKey,
        ...(claim.riskCategory === 'high' ? { riskCategory: 'high' as const } : {}),
        bodyRange: shift(claim.bodyRange),
      })),
    }));
    const evidence = draft.evidence.filter((item) => ids.has(item.objectId));
    const evidenceInputs = evidence.map((item) => ({
      clientKey: evidenceKeyById.get(item.evidenceId) ?? item.evidenceId,
      objectKey: refOf(item.objectId),
      claimKey: item.claimKey,
      sourceRef: { sourceId: item.sourceRef.sourceId, resourceId: item.sourceRef.resourceId },
      selector: item.selector,
      role: item.role,
      nature: item.nature,
      ...(item.readReceiptId ? { readReceiptId: item.readReceiptId } : {}),
    }));
    const presentationInputs = draft.presentations
      .filter((item) => ids.has(item.ownerObjectId) && item.kind !== 'canonical')
      .map((item) => ({
        ownerKey: refOf(item.ownerObjectId),
        kind: item.kind,
        ...(item.targetObjectId ? { targetKey: refOf(item.targetObjectId) } : {}),
        ...(item.bodyRange ? { bodyRange: shift(item.bodyRange) } : {}),
        ...(item.targetRevision !== undefined ? { targetRevision: item.targetRevision } : {}),
        ...(item.summaryBasis ? { summaryBasis: item.summaryBasis } : {}),
        ...(item.fragmentKey ? { fragmentKey: item.fragmentKey } : {}),
      }));
    const relationInputs = draft.relations
      .filter((item) => ids.has(item.fromObjectId))
      .map((item) => ({
        fromKey: refOf(item.fromObjectId),
        toKey: refOf(item.toObjectId),
        type: item.type,
        scopeKey: item.scopeKey,
        ...(item.evidenceIds.length ? { evidenceKeys: item.evidenceIds.map((id) => evidenceKeyById.get(id) ?? id) } : {}),
        ...(item.decisionRef ? { decisionRef: item.decisionRef } : {}),
        ...(item.validFrom ? { validFrom: item.validFrom } : {}),
        ...(item.validUntil ? { validUntil: item.validUntil } : {}),
      }));
    return {
      objects: objectInputs,
      ...(presentationInputs.length ? { presentations: presentationInputs } : {}),
      ...(relationInputs.length ? { relations: relationInputs } : {}),
      ...(evidenceInputs.length ? { evidenceClaims: evidenceInputs } : {}),
    };
  }

  // ------------------------------------------------------------------
  // ws_*（Workspace 文件工具）
  // ------------------------------------------------------------------

  private requireWorkspace(context: InternalRunContext): string {
    const root = context.options.workspaceRoot;
    if (!root) {
      throw new ToolError('tool_not_allowed', '本运行未绑定 Workspace', 403);
    }
    // F3-R02：能力使用时动态复核——授权后配置可能已变（手工改配置文件
    // /旧版落盘），冲突即拒绝本次工具调用（403），不让旧授权永久生效。
    if (this.workspaceGuard) {
      const verdict = this.workspaceGuard(root);
      if (!verdict.ok) {
        throw new ToolError('workspace_path_forbidden', `Workspace 已与新配置冲突，请重新授权：${verdict.message}`, 403);
      }
    }
    return root;
  }

  private toolWsLs(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const root = this.requireWorkspace(context);
    const rel = args.path == null || args.path === '' ? '' : requireString(args, 'path', 1, 600);
    const entries = listDirInside(root, rel);
    return { content: [{ type: 'text', text: JSON.stringify({ path: rel || '.', entries }, null, 2) }] };
  }

  private toolWsRead(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const root = this.requireWorkspace(context);
    const rel = requireString(args, 'path', 1, 600);
    const offset = optionalInt(args, 'offset', 0, 0, 10_000_000);
    const limit = optionalInt(args, 'limit', 800, 1, 2000);
    const target = resolveInside(root, rel, 'read');
    const buffer = fs.readFileSync(target);
    if (buffer.includes(0)) {
      throw new ToolError('invalid_request', '二进制文件不支持读取');
    }
    const content = buffer.toString('utf-8');
    const lines = content.split('\n');
    const slice = lines.slice(offset, offset + limit);
    return {
      content: [{ type: 'text', text: `<untrusted_workspace path="${escapeXml(rel)}">\n${slice.join('\n')}\n</untrusted_workspace>` }],
      details: { path: rel, offset, returnedLines: slice.length, totalLines: lines.length },
    };
  }

  private toolWsSearch(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const root = this.requireWorkspace(context);
    const query = requireString(args, 'query', 1, 200);
    const glob = typeof args.glob === 'string' && args.glob ? args.glob : null;
    const limit = optionalInt(args, 'limit', 30, 1, 100);
    const lowerQuery = query.toLowerCase();
    const matches: Array<Record<string, unknown>> = [];
    const walk = (dir: string, prefix: string) => {
      if (matches.length >= limit) return;
      for (const name of fs.readdirSync(dir)) {
        if (matches.length >= limit) return;
        const child = path.join(dir, name);
        const lstat = fs.lstatSync(child);
        if (lstat.isSymbolicLink()) continue;
        if (lstat.isDirectory()) {
          walk(child, `${prefix}${name}/`);
          continue;
        }
        if (!lstat.isFile()) continue;
        if (glob && !matchGlob(name, glob)) continue;
        try {
          const buffer = fs.readFileSync(child);
          if (buffer.includes(0)) continue;
          const content = buffer.toString('utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              matches.push({ path: `${prefix}${name}`, line: i + 1, text: lines[i].slice(0, 300) });
            }
          }
        } catch {
          /* 跳过不可读文件 */
        }
      }
    };
    walk(root, '');
    return { content: [{ type: 'text', text: JSON.stringify({ matches }, null, 2) }] };
  }

  private toolWsWrite(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const root = this.requireWorkspace(context);
    const rel = requireString(args, 'path', 1, 600);
    const content = requireString(args, 'content', 0, 2_000_000);
    if (Buffer.byteLength(content, 'utf-8') > 2 * 1024 * 1024) {
      throw new ToolError('invalid_request', '内容超过 2MB 上限');
    }
    // 深路径需要先建父目录（write intent 要求父目录存在）
    const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null;
    if (parentRel) {
      try {
        resolveInside(root, parentRel, 'read');
      } catch {
        resolveInside(root, parentRel, 'mkdir');
      }
    }
    const target = resolveInside(root, rel, 'write');
    atomicWriteFile(target, content);
    this.auditWork(context, 'ws_write', rel, Buffer.byteLength(content, 'utf-8'), 'ok');
    return { content: [{ type: 'text', text: `已写入 ${rel}（${Buffer.byteLength(content, 'utf-8')} 字节）` }] };
  }

  private toolWsEdit(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const root = this.requireWorkspace(context);
    const rel = requireString(args, 'path', 1, 600);
    const oldText = requireString(args, 'oldText', 0, 2_000_000);
    const newText = requireString(args, 'newText', 0, 2_000_000);
    const target = resolveInside(root, rel, 'read');
    const content = fs.readFileSync(target, 'utf-8');
    const firstIndex = content.indexOf(oldText);
    if (firstIndex < 0) {
      throw new ToolError('invalid_request', 'oldText 未在文件中找到');
    }
    if (content.indexOf(oldText, firstIndex + 1) >= 0) {
      throw new ToolError('invalid_request', 'oldText 在文件中出现多次，必须唯一匹配');
    }
    const updated = content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length);
    const writeTarget = resolveInside(root, rel, 'write');
    atomicWriteFile(writeTarget, updated);
    this.auditWork(context, 'ws_edit', rel, Buffer.byteLength(updated, 'utf-8'), 'ok');
    return { content: [{ type: 'text', text: `已编辑 ${rel}（替换 ${oldText.length} → ${newText.length} 字符）` }] };
  }

  private toolWsMkdir(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const root = this.requireWorkspace(context);
    const rel = requireString(args, 'path', 1, 600);
    resolveInside(root, rel, 'mkdir');
    this.auditWork(context, 'ws_mkdir', rel, 0, 'ok');
    return { content: [{ type: 'text', text: `已创建目录 ${rel}` }] };
  }

  private auditWork(context: InternalRunContext, tool: string, relPath: string, bytes: number, result: string): void {
    if (context.runKind !== 'work' || !context.sessionId) return;
    try {
      const auditDir = path.join(this.dataRoot, 'agent', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        sessionId: context.sessionId,
        tool,
        path: relPath,
        bytes,
        result,
      });
      fs.appendFileSync(path.join(auditDir, `${context.sessionId}.jsonl`), `${line}\n`);
    } catch {
      /* 审计失败不阻断工具（记录到 stderr 即可） */
    }
  }
}

// ===========================================================================
// 辅助校验
// ===========================================================================

function requireBuildState(context: InternalRunContext): BuildRunState {
  if (!context.options.buildState) {
    throw new ToolError('tool_not_allowed', '本运行不是构建运行', 403);
  }
  return context.options.buildState;
}

/** kb_unit_done / kb_finish 共用的 skipped 参数解析（非法项丢弃，reason 截断）。 */
function parseSkippedList(value: unknown): Array<{ objToken: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { objToken: string; reason: string } =>
      Boolean(item) && typeof item === 'object'
      && typeof (item as { objToken?: unknown }).objToken === 'string'
      && typeof (item as { reason?: unknown }).reason === 'string')
    .map((item) => ({ objToken: item.objToken, reason: item.reason.slice(0, 300) }));
}

function requireString(args: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new ToolError('invalid_request', `${key} 必须是字符串`);
  }
  if (value.length < min || value.length > max) {
    throw new ToolError('invalid_request', `${key} 长度必须在 ${min}..${max}（当前 ${value.length}）`);
  }
  return value;
}

function optionalInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError('invalid_request', `${key} 必须是整数`);
  }
  if (value < min || value > max) {
    throw new ToolError('invalid_request', `${key} 必须在 ${min}..${max}`);
  }
  return value;
}

/** 标准文档路径合规（§6.2）：POSIX 相对、段 ≤120、深度 ≤6、.md、不以 . 开头。 */
export function validateStdDocPath(docPath: string): void {
  if (docPath.includes('\\') || docPath.startsWith('/') || /^[A-Za-z]:/.test(docPath)) {
    throw new ToolError('invalid_request', `路径必须是 POSIX 相对路径: ${docPath}`);
  }
  const segments = docPath.split('/');
  if (segments.length > 6) {
    throw new ToolError('invalid_request', `路径深度超过 6: ${docPath}`);
  }
  if (!docPath.endsWith('.md')) {
    throw new ToolError('invalid_request', `路径必须以 .md 结尾: ${docPath}`);
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.')) {
      throw new ToolError('invalid_request', `路径段非法: ${segment}`);
    }
    if (segment.length > 120) {
      throw new ToolError('invalid_request', `路径段超过 120 字符: ${segment}`);
    }
    if (/[\u0000<>:"|?*]/.test(segment)) {
      throw new ToolError('invalid_request', `路径段含非法字符: ${segment}`);
    }
  }
}

// ===========================================================================
// T3 知识声明解析辅助（A 案 §7.1：参数防御式解析；错误码复用 kb_* 系列）
// ===========================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optStr(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optStrArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : undefined;
}

function requireArray(args: Record<string, unknown>, key: string): unknown[] {
  const value = args[key];
  if (!Array.isArray(value)) throw new ToolError('invalid_request', `${key} 必须是数组`);
  return value;
}

function requirePositiveInt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolError('invalid_request', `${key} 必须是 ≥1 的整数`);
  }
  return value;
}

function parseBodyRange(value: unknown): BodyRange {
  const input = asRecord(value);
  if (!input) throw new ToolError('invalid_request', 'bodyRange 必须是对象');
  const startLine = requirePositiveInt(input, 'startLine');
  const endLine = requirePositiveInt(input, 'endLine');
  if (endLine < startLine) throw new ToolError('invalid_request', 'bodyRange.endLine 必须 ≥ startLine');
  return { startLine, endLine };
}

/** 四类 selector 解析（A 案 §5.2 定位规范；字段非法直接拒绝）。 */
function parseSelector(value: unknown): EvidenceSelector {
  const input = asRecord(value);
  if (!input) throw new ToolError('invalid_request', 'selector 必须是对象');
  const kind = input.kind;
  if (kind === 'text_span') {
    return {
      kind: 'text_span',
      lineStart: requirePositiveInt(input, 'lineStart'),
      lineEnd: requirePositiveInt(input, 'lineEnd'),
      colStart: typeof input.colStart === 'number' && Number.isInteger(input.colStart) && input.colStart >= 1 ? input.colStart : 1,
      colEnd: typeof input.colEnd === 'number' && Number.isInteger(input.colEnd) && input.colEnd >= 0 ? input.colEnd : 0,
      headingPath: optStrArray(input, 'headingPath') ?? [],
    };
  }
  if (kind === 'csv_cells') {
    return {
      kind: 'csv_cells',
      resourcePath: optStr(input, 'resourcePath') ?? '',
      parserVersion: optStr(input, 'parserVersion') ?? 'rfc4180-v1',
      recordStart: requirePositiveInt(input, 'recordStart'),
      recordEnd: requirePositiveInt(input, 'recordEnd'),
      columns: optStrArray(input, 'columns') ?? (() => { throw new ToolError('invalid_request', 'csv_cells.columns 必填'); })(),
      ...(optStrArray(input, 'businessKeys') ? { businessKeys: optStrArray(input, 'businessKeys')! } : {}),
    };
  }
  if (kind === 'workbook_cells') {
    const valueNature = input.valueNature;
    if (valueNature !== 'formula_text' && valueNature !== 'cached_value' && valueNature !== 'mixed') {
      throw new ToolError('invalid_request', `workbook_cells.valueNature 非法: ${String(valueNature)}`);
    }
    return {
      kind: 'workbook_cells',
      workbookName: optStr(input, 'workbookName') ?? (() => { throw new ToolError('invalid_request', 'workbook_cells.workbookName 必填'); })(),
      sheet: optStr(input, 'sheet') ?? (() => { throw new ToolError('invalid_request', 'workbook_cells.sheet 必填'); })(),
      rangeA1: optStr(input, 'rangeA1') ?? (() => { throw new ToolError('invalid_request', 'workbook_cells.rangeA1 必填'); })(),
      mergedCellAnchors: optStrArray(input, 'mergedCellAnchors') ?? [],
      ...(optStrArray(input, 'formulaTexts') ? { formulaTexts: optStrArray(input, 'formulaTexts')! } : {}),
      valueNature,
    };
  }
  if (kind === 'media_region') {
    // D3（A 案 §5.2）：imageHash 可缺省——图片字节哈希对模型不可见，缺省时
    // 由声明校验按资源钉住并随声明冻结；显式提供且与资源不符会被拒。
    return {
      kind: 'media_region',
      imageHash: optStr(input, 'imageHash') ?? '',
      ...(asRecord(input.region)
        ? {
          region: {
            x: Number((input.region as Record<string, unknown>).x ?? 0),
            y: Number((input.region as Record<string, unknown>).y ?? 0),
            w: Number((input.region as Record<string, unknown>).w ?? 0),
            h: Number((input.region as Record<string, unknown>).h ?? 0),
          },
        }
        : {}),
      ...(optStr(input, 'captionHash') ? { captionHash: optStr(input, 'captionHash')! } : {}),
      ...(optStr(input, 'describerVersion') ? { describerVersion: optStr(input, 'describerVersion')! } : {}),
    };
  }
  throw new ToolError('invalid_request', `selector.kind 非法: ${String(kind)}`);
}

/**
 * A 案 §7.1：对象内正文选择器以输入 Markdown 为坐标。headingPath 逐级
 * 下钻（子标题 level 必须更深），occurrence 消歧最后一个标题；返回该标题
 * 到下一个同级或更高级标题前的闭区间（1 起始）。未命中返回 null。
 */
function resolveHeadingBodyRange(lines: string[], headingPath: string[], occurrence: number): BodyRange | null {
  if (headingPath.length === 0) return null;
  const headings: Array<{ level: number; text: string; line: number }> = [];
  lines.forEach((text, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(text);
    if (match) headings.push({ level: match[1]!.length, text: match[2]!.trim(), line: index + 1 });
  });
  let searchAfterLine = 0;
  let parentLevel = 0;
  let target: { level: number; line: number } | null = null;
  for (let depth = 0; depth < headingPath.length; depth += 1) {
    const matches = headings.filter((heading) =>
      heading.line > searchAfterLine
      && heading.text === headingPath[depth]
      && (parentLevel === 0 || heading.level > parentLevel));
    if (matches.length === 0) return null;
    const pick = depth === headingPath.length - 1 ? matches[occurrence - 1] : matches[0];
    if (!pick) return null;
    searchAfterLine = pick.line;
    parentLevel = pick.level;
    target = pick;
  }
  if (!target) return null;
  const end = headings.find((heading) => heading.line > target!.line && heading.level <= target!.level);
  return { startLine: target.line, endLine: end ? end.line - 1 : lines.length };
}

/** 有向边成环检测（DFS；计划依赖/迁移增量校验用）。 */
function hasDirectedCycle(nodes: string[], edges: Array<[string, string]>): boolean {
  const outgoing = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = outgoing.get(from) ?? [];
    list.push(to);
    outgoing.set(from, list);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (node: string): boolean => {
    if (state.get(node) === 2) return false;
    if (state.get(node) === 1) return true;
    state.set(node, 1);
    for (const next of outgoing.get(node) ?? []) {
      if (visit(next)) return true;
    }
    state.set(node, 2);
    return false;
  };
  for (const node of nodes) {
    if (visit(node)) return true;
  }
  return false;
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'kb_write_doc':
      return `path=${String(args.path ?? '')} sources=${Array.isArray(args.sources) ? args.sources.length : 0}`
        + ` objects=${Array.isArray(args.objects) ? args.objects.length : 0} evidence=${Array.isArray(args.evidenceClaims) ? args.evidenceClaims.length : 0}`;
    case 'kb_delete_doc':
    case 'ws_write':
    case 'ws_edit':
    case 'ws_read':
    case 'ws_mkdir':
      return `path=${String(args.path ?? '')}`;
    case 'raw_read':
      return `objToken=${String(args.objToken ?? '')}`;
    case 'raw_csv_cells':
      return `objToken=${String(args.objToken ?? '')} resourceId=${String(args.resourceId ?? '')} records=${String(args.recordStart ?? '')}..${String(args.recordEnd ?? '')}`;
    case 'raw_csv_find':
      return `objToken=${String(args.objToken ?? '')} resourceId=${String(args.resourceId ?? '')} queries=${Array.isArray(args.queries) ? args.queries.length : 0}`;
    case 'raw_links':
      return `objToken=${String(args.objToken ?? '')} direction=${String(args.direction ?? 'both')}`;
    case 'raw_read_image':
      return `objToken=${String(args.objToken ?? '')} src=${String(args.src ?? '')}`;
    case 'raw_comments':
      return `objToken=${String(args.objToken ?? '')}`;
    case 'kb_unit_done':
      return `summary=${String(args.summary ?? '').slice(0, 60)} skipped=${Array.isArray(args.skipped) ? args.skipped.length : 0}`;
    case 'kb_submit_plan':
      return `docs=${Array.isArray(args.docs) ? args.docs.length : 0} objects=${Array.isArray(args.objectCandidates) ? args.objectCandidates.length : 0}`;
    case 'kb_get_plan':
      return `cursor=${String(args.cursor ?? '')}`;
    case 'kb_submit_review':
      return `unitId=${String(args.unitId ?? '')} issues=${Array.isArray(args.issues) ? args.issues.length : 0} conclusion=${String(args.conclusion ?? '')}`;
    case 'kb_read':
      return `docId=${String(args.docId ?? args.path ?? '')}`;
    case 'kb_search':
    case 'raw_search':
    case 'draft_search':
    case 'ws_search':
      return `query=${String(args.query ?? '').slice(0, 60)}`;
    case 'app_command':
      return `${String(args.command ?? '')}${args.args && typeof args.args === 'object' ? ` ${JSON.stringify(args.args).slice(0, 120)}` : ''}`;
    default:
      return Object.keys(args).slice(0, 3).join(',');
  }
}

function summarizeResult(result: ToolResult): string {
  const text = result.content[0]?.text ?? '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// ===========================================================================
// v2 编排辅助（设计 v2 §4/§7）——工具面只读名单、幂等载荷哈希、
// 回执重放、身份/错误适配、局部编辑坐标。
// ===========================================================================

/** 只读工具名单（MCP readOnlyHint 与 v2 pending 只读面共用；含新旧读取类）。 */
const READONLY_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'kb_search',
  'kb_read',
  'kb_grep',
  'raw_search',
  'raw_read',
  'raw_csv_cells',
  'raw_csv_find',
  'raw_links',
  'raw_list',
  'raw_comments',
  'raw_read_image',
  'draft_list',
  'draft_read',
  'draft_search',
  'kb_read_batch',
  'kb_tool_schema',
  'kb_get_plan',
  'ws_ls',
  'ws_read',
  'ws_search',
  'build_manifest',
  'build_handoff_list',
  'build_issues_list',
]);

/** v2 Leader 凭据校验（Leader 工具执行器入口用）。 */
function requireV2Leader(context: InternalRunContext): OrchestrationV2Options {
  const v2 = context.options.orchestration;
  if (!v2) throw new ToolError('invalid_request', '本工具仅 v2 编排运行可用（orchestration 未配置）', 400);
  if (v2.credential !== 'leader') throw new ToolError('tool_not_allowed', '本工具仅 Leader 凭据可用（设计 v2 §3.4）', 403);
  return v2;
}

/** v2 编排上下文（Leader/child 均可的只读工具用）。 */
function requireV2Orchestration(context: InternalRunContext): OrchestrationV2Options {
  const v2 = context.options.orchestration;
  if (!v2) throw new ToolError('invalid_request', '本工具仅 v2 编排运行可用（orchestration 未配置）', 400);
  return v2;
}

/** BuildActorError → ToolError 适配（保留 code/status）。 */
function wrapActorError(error: unknown): ToolError {
  if (error instanceof BuildActorError) return new ToolError(error.code, error.message, error.status);
  if (error instanceof ToolError) return error;
  return new ToolError('v2_actor_error', error instanceof Error ? error.message : String(error), 500);
}

/** 幂等载荷哈希：键排序的规范化 JSON（剔除并发保护/幂等键字段后的业务载荷）。 */
function canonicalPayloadHash(args: Record<string, unknown>, omitKeys: readonly string[]): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  const filtered = Object.fromEntries(
    Object.entries(args).filter(([key]) => !omitKeys.includes(key)).map(([key, value]) => [key, canonical(value)]),
  );
  return crypto.createHash('sha256').update(JSON.stringify(filtered)).digest('hex');
}

function withAutoOperationId(args: Record<string, unknown>): Record<string, unknown> {
  if (args.operationId !== undefined) return args;
  return {
    ...args,
    operationId: `op_auto_${canonicalPayloadHash(args, ['operationId']).slice(0, 32)}`,
  };
}

/** Small, deterministic outline for build_manifest. It uses the exact
 * assembled raw_read output coordinates, including derived image lines and
 * compacted blank CSV attachments, without sending full source text. */
function summarizeRawSourceShape(input: {
  lines: string[];
  segments: Array<{ resourceId?: string; outStart: number; outEnd: number }>;
  resources: Array<{ resourceId: string; kind: 'text' | 'csv'; label: string; lines: string[]; nonEmptyCells?: number }>;
}): {
  totalLines: number;
  attachmentCount: number;
  sectionCount: number;
  sections: Array<{ line: number; heading: string }>;
  attachments: Array<{ label: string; lines: number; nonEmptyCells: number; outputStart: number | null; outputEnd: number | null }>;
} {
  const sections: Array<{ line: number; heading: string }> = [];
  let sectionCount = 0;
  const primaryResourceId = input.resources[0]?.resourceId;
  let segmentIndex = 0;
  for (let i = 0; i < input.lines.length; i += 1) {
    while (segmentIndex + 1 < input.segments.length && input.segments[segmentIndex]!.outEnd < i + 1) segmentIndex += 1;
    if (input.segments[segmentIndex]?.resourceId !== primaryResourceId) continue;
    const heading = /^#{2,3} (.+)$/.exec(input.lines[i]!)?.[1]?.trim();
    if (!heading) continue;
    sectionCount += 1;
    if (sections.length < 24) sections.push({ line: i + 1, heading: heading.slice(0, 120) });
  }
  const attachments = input.resources.filter((resource) => resource.kind === 'csv').map((resource) => {
    const segment = input.segments.find((item) => item.resourceId === resource.resourceId);
    return {
      label: resource.label,
      lines: resource.lines.length,
      nonEmptyCells: resource.nonEmptyCells ?? 0,
      outputStart: segment?.outStart ?? null,
      outputEnd: segment?.outEnd ?? null,
    };
  });
  return { totalLines: input.lines.length, attachmentCount: attachments.length, sectionCount, sections, attachments };
}

/** kb_write_doc 的机械参数补全。只使用调用已声明的路径、来源、语义键与
 * selector；不推测对象类型、业务族、适用范围、来源事实或覆盖去向。 */
function normalizeKbWriteDocArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...args };
  const docPath = typeof args.path === 'string' ? args.path : '';
  if (normalized.title === undefined && docPath) {
    normalized.title = path.posix.basename(docPath).replace(/\.md$/i, '');
  }
  if (Array.isArray(args.objects)) {
    normalized.objects = args.objects.map((raw) => {
      const object = asRecord(raw);
      if (!object) return raw;
      const copy: Record<string, unknown> = { ...object };
      if (copy.variantKey === undefined) copy.variantKey = 'default';
      if (copy.scopeKey === undefined && typeof copy.scopeText === 'string' && copy.scopeText.trim()) {
        copy.scopeKey = `scope_auto_${canonicalPayloadHash({ path: docPath, scopeText: copy.scopeText }, []).slice(0, 20)}`;
      }
      return copy;
    });
  }
  const sourceIds = Array.isArray(args.sources)
    ? args.sources.filter((source): source is string => typeof source === 'string') : [];
  if (Array.isArray(args.evidenceClaims)) {
    const evidenceOrdinal = new Map<string, number>();
    normalized.evidenceClaims = args.evidenceClaims.map((raw) => {
      const evidence = asRecord(raw);
      if (!evidence) return raw;
      const copy: Record<string, unknown> = { ...evidence };
      const selector = asRecord(copy.selector);
      const ref = asRecord(copy.sourceRef);
      const sourceId = typeof ref?.sourceId === 'string' ? ref.sourceId
        : sourceIds.length === 1 ? sourceIds[0] : undefined;
      if (sourceId && (!ref || ref.sourceId === undefined || ref.resourceId === undefined)) {
        const resourceId = typeof ref?.resourceId === 'string' ? ref.resourceId
          : selector?.kind === 'text_span' ? sourceId
            : selector?.kind === 'csv_cells' && typeof selector.resourcePath === 'string'
              ? `${sourceId}#csv:${path.posix.basename(selector.resourcePath)}`
              : selector?.kind === 'workbook_cells' && typeof selector.workbookName === 'string'
                ? `${sourceId}#workbook:${selector.workbookName}` : undefined;
        copy.sourceRef = { ...ref, sourceId, ...(resourceId ? { resourceId } : {}) };
      }
      if (copy.role === undefined) copy.role = 'supports';
      if (copy.nature === undefined) copy.nature = selector?.kind === 'media_region' ? 'machine_description' : 'direct';
      if (copy.clientKey === undefined) {
        const identity = canonicalPayloadHash({ objectKey: copy.objectKey, claimKey: copy.claimKey, sourceRef: copy.sourceRef }, []);
        const ordinal = (evidenceOrdinal.get(identity) ?? 0) + 1;
        evidenceOrdinal.set(identity, ordinal);
        copy.clientKey = `ev_auto_${canonicalPayloadHash({
          objectKey: copy.objectKey, claimKey: copy.claimKey,
          sourceRef: copy.sourceRef, ordinal,
        }, []).slice(0, 20)}`;
      }
      return copy;
    });
  }
  if (Array.isArray(args.coverageUpdates)) {
    const coverageOrdinal = new Map<string, number>();
    normalized.coverageUpdates = args.coverageUpdates.map((raw) => {
      const coverage = asRecord(raw);
      if (!coverage) return raw;
      const copy: Record<string, unknown> = { ...coverage };
      if (copy.itemId === undefined) {
        const identity = canonicalPayloadHash({ sourceId: copy.sourceId, category: copy.category }, []);
        const ordinal = (coverageOrdinal.get(identity) ?? 0) + 1;
        coverageOrdinal.set(identity, ordinal);
        copy.itemId = `cov_auto_${canonicalPayloadHash({
          sourceId: copy.sourceId, category: copy.category, ordinal,
        }, []).slice(0, 20)}`;
      }
      return copy;
    });
  }
  if (normalized.operationId === undefined) {
    normalized.operationId = `op_auto_${canonicalPayloadHash(normalized, ['operationId', 'expectedDraftRevision']).slice(0, 32)}`;
  }
  return normalized;
}

/** v2 写入链声明幂等账本（calls）的稳定键：任务+operationId，不依赖
 * 桥接每次随机分配的 toolCallId（F06；kb_write_doc/kb_edit_doc 共用）。 */
function stableV2CallKey(nativeTaskId: string, operationId: string): string {
  return `v2_${nativeTaskId}_${operationId}`;
}

/** 回执重放：从 ArtifactReceipt 恢复 ToolResult（带幂等标记）。 */
function replayReceiptToolResult(receipt: { operationId: string; result: Record<string, unknown> }): ToolResult {
  const stored = receipt.result as { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> };
  return {
    content: (Array.isArray(stored.content) ? stored.content : [{ type: 'text', text: JSON.stringify(stored) }]) as Array<{ type: 'text'; text: string }>,
    details: { ...(stored.details ?? {}), idempotentReplay: true, operationId: receipt.operationId },
  };
}

/** 局部编辑坐标（§7）：参数文本 = 去 server 头与 # 标题行的正文
 * （与 kb_write_doc 的 markdown 参数同坐标）；解析 header 来源。 */
export function draftEditCoordinates(fileText: string): { paramLines: string[]; title: string; sources: string[] } {
  const stripped = stripStdHeader(fileText);
  const lines = stripped.split('\n');
  if (!lines[0]?.startsWith('# ')) {
    throw new ToolError('invalid_request', '草稿首行不是 # 标题（可能为旧格式/托管文档）；请用 kb_write_doc 整体重写');
  }
  const title = lines[0]!.slice(2);
  const paramLines = lines.slice(1);
  const sources: string[] = [];
  const headerMatch = /<!--\s*\nfeishu_sync_kb:\n([\s\S]*?)-->/.exec(fileText);
  if (headerMatch) {
    let inSources = false;
    for (const line of headerMatch[1]!.split('\n')) {
      const item = /^\s+-\s+(\S.*)$/.exec(line);
      if (item && inSources) sources.push(item[1]!.trim());
      else if (/^\s+sources:\s*$/.test(line)) inSources = true;
      else if (/^\S/.test(line)) inSources = false;
    }
  }
  return { paramLines, title, sources };
}

/** 补丁序列下的行区间平移：完全在前不变；完全在后随 delta；相交则夹取
 * 到新内容区间（起点仅在被删区间内前移；终点覆盖新内容末行）。 */
function shiftBodyRange(
  range: BodyRange,
  patches: Array<{ startLine: number; endLine: number; newLineCount: number }>,
): BodyRange {
  let start = range.startLine;
  let end = range.endLine;
  for (const patch of patches) {
    const delta = patch.newLineCount - (patch.endLine - patch.startLine + 1);
    if (end < patch.startLine) continue;
    if (start > patch.endLine) {
      start += delta;
      end += delta;
      continue;
    }
    const patchEndAfter = patch.startLine + patch.newLineCount - 1;
    if (start >= patch.startLine) start = patch.startLine;
    end = end <= patch.endLine ? patchEndAfter : Math.max(end + delta, patchEndAfter);
    if (start > end) start = end;
  }
  return { startLine: start, endLine: end };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
