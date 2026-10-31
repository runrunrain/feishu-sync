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
  DRAFT_LIST_SPEC,
  DRAFT_READ_SPEC,
  DRAFT_SEARCH_SPEC,
  RAW_LIST_SPEC,
  RAW_LINKS_SPEC,
  RAW_COMMENTS_SPEC,
  RAW_READ_IMAGE_SPEC,
  RAW_READ_SPEC,
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
import { StandardKbStore, stripStdHeader } from '../kb/standard-kb-store.js';
import {
  computePayloadHash,
  computeReviewSubjectHash,
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
  resolveSelector,
  verifyEvidence,
  type EvidenceReadReceipt,
  type EvidenceResource,
} from '../kb/evidence-locator.js';
import { computeCandidateHash, type ReviewIssue, type ReviewReport } from '../kb/orchestration-contracts.js';
import { getKbQueryService, QueryError } from '../kb/search/kb-query-service.js';
import { splitAnchor } from '../kb/search/outline.js';
import { hashImageFile, inlineImageBlocks, resolveSourceImages, extractWhiteboardBypassTexts, type ImageDescriptionLike, type WhiteboardTextMap } from '../kb/source-images.js';
import type { PathClaims } from '../kb/path-claims.js';
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
  /** T3（A 案 §7.2）：organization-plan.json 内存缓存 */
  organizationPlan?: OrganizationPlanFile;
  /** T3（A 案 §5.3）：read-receipts.jsonl 内存镜像（真相在文件；首次访问加载） */
  readReceipts?: ReadReceiptRecord[];
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
   * S4（§4.4）：构建 worker 运行上下文。unit 轮受路径认领与 kb_finish 禁用
   * 约束；final 轮（收尾）不受认领限制、调用 kb_finish。
   */
  worker?: BuildWorkerInfo;
}

/** S4：构建进程的 worker 身份（runKind=build 时存在）。 */
export interface BuildWorkerInfo {
  workerId: string;
  unitId: string | null;
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
  /** toolCallId 幂等账本（进程重启后由文件恢复；A 案 §7.1） */
  calls: Record<string, {
    path: string;
    at: string;
    draftRevision: number;
    docId: string;
    bytes: number;
    objectIdMap: Record<string, string>;
    evidenceIdMap: Record<string, string>;
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
}

/** 单次工具请求的调用侧元数据（内部 API 透传；不进模型可见面）。 */
export interface ToolRequestMeta {
  /** T3b-07R：pi 分配的 toolCallId（轮次归属绑定的权威键）。 */
  toolCallId?: string;
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
  describeMany(items: Array<{ file: string; src: string }>, opts: { signal: AbortSignal; onProgress: (p: { done: number; total: number }) => void; refreshCached?: boolean }): Promise<Map<string, ImageDescription>>;
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
        { spec: KB_DELETE_DOC_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbDeleteDoc(context, args) },
        // S4（§4.4）：逐单元上报；kb_finish 保持单值、只在收尾轮可用
        { spec: KB_UNIT_DONE_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbUnitDone(context, args) },
        { spec: KB_FINISH_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbFinish(context, args) },
        // T3（A 案 §7.1/§7.2）：知识协议工具——计划提交（phase 门禁在执行器内）、
        // 计划只读、审查提交（审查轮；写入者无审查入口，审查者无草稿写入口）
        { spec: KB_SUBMIT_PLAN_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbSubmitPlan(context, args) },
        { spec: KB_GET_PLAN_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbGetPlan(context, args) },
        { spec: KB_SUBMIT_REVIEW_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbSubmitReview(context, args) },
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
      options,
    };
    this.contexts.set(token, context);
    return { token, context };
  }

  /** 撤销令牌（模式切换 / 进程退出时）。 */
  revokeToken(token: string): void {
    this.contexts.delete(token);
  }

  /** 按会话撤销（模式切换 / 会话删除时）。 */
  revokeBySession(sessionId: string): void {
    for (const [token, context] of this.contexts) {
      if (context.sessionId === sessionId) this.contexts.delete(token);
    }
  }

  revokeByBuild(buildId: string): void {
    for (const [token, context] of this.contexts) {
      if (context.buildId === buildId) this.contexts.delete(token);
    }
  }

  getContext(token: string): AgentRunContext | null {
    return this.contexts.get(token) ?? null;
  }

  /** GET /tools：返回本运行允许的工具规格（族注册表派生，顺序同白名单）。 */
  getToolSpecsForToken(token: string): AgentToolSpec[] | null {
    const context = this.contexts.get(token);
    if (!context) return null;
    return context.allowedTools
      .map((name) => this.familyTools.get(name)?.spec)
      .filter((spec): spec is AgentToolSpec => Boolean(spec));
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
    const entry = context.options.buildState
      ? context.options.buildState.snapshot.get(objToken)
      : this.rawEntriesForDiscuss(context).find((candidate) => candidate.objToken === objToken) ?? null;
    if (!entry) {
      throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    }
    let lines: string[];
    let readTrail: {
      receipts: Array<{ readReceiptId: string; resourceId: string; lineStart: number; lineEnd: number }>;
      resources: Array<{ resourceId: string; kind: 'text' | 'csv'; label: string; resourceHash: string; totalLines: number }>;
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
        resources: assembled.resources.map(({ resourceId, kind, label, resourceHash, lines: resourceLines }) => ({
          resourceId, kind, label, resourceHash, totalLines: resourceLines.length,
        })),
        segmentMap,
      };
      return this.renderRawReadPage(context, entry, lines, slice, offset, readTrail, truncated);
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

  /** raw_read 输出渲染（build 态附 segmentMap/资源表/回执；末页引用块共用）。 */
  private renderRawReadPage(
    context: InternalRunContext,
    entry: RawSourceSnapshotEntry,
    lines: string[],
    slice: string[],
    offset: number,
    readTrail: {
      receipts: Array<{ readReceiptId: string; resourceId: string; lineStart: number; lineEnd: number }>;
      resources: Array<{ resourceId: string; kind: 'text' | 'csv'; label: string; resourceHash: string; totalLines: number }>;
      segmentMap: Array<Record<string, unknown>>;
    } | null,
    truncated: boolean,
  ): ToolResult {
    // P1-S4（§2.4）：末页追加 <source_links>（非末页不追加，避免翻页重复）；
    // 无引用边或未注入引用图时不追加，输出与旧版逐字一致。
    const isLastPage = offset + slice.length >= lines.length;
    const sourceLinks = isLastPage ? this.buildSourceLinksBlock(context, entry.objToken) : null;
    const wrapped = `<untrusted_source obj_token="${entry.objToken}" title="${escapeXml(entry.title)}">\n${slice.join('\n')}\n</untrusted_source>`
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
        ...(readTrail
          ? {
            // T3（A 案 §5.3）：模型只能引用回执中的范围；quoteHash 复核在
            // kb_write_doc 证据声明校验时由服务端重新解引用完成。
            readReceiptId: readTrail.receipts[0]?.readReceiptId ?? null,
            readReceipts: readTrail.receipts,
            resources: readTrail.resources,
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
    }>;
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
      // 与 readRawContent 旧拼接逐字节一致：'' + '<!-- 附件 x -->' + csv 行
      lines.push('', `<!-- 附件 ${base} -->`);
      labels.push({ derived: 'attachment_header' }, { derived: 'attachment_header' });
      const csvLines = attachment.content.split('\n');
      lines.push(...csvLines);
      for (let i = 0; i < csvLines.length; i += 1) labels.push({ resourceId });
      resources.push({
        resourceId,
        kind: 'csv',
        label: base,
        resourceHash: contentResourceHash(attachment.content),
        sourceId: entry.objToken,
        sourceSnapshotHash: entry.contentHash,
        lines: csvLines,
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
    return { lines, segments, resources };
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
    const offset = optionalInt(args, 'offset', 0, 0, 10_000_000);
    const limit = optionalInt(args, 'limit', 800, 1, 2000);
    const stagingRoot = requireBuildState(context).stagingRoot;
    const target = resolveInside(path.join(stagingRoot, 'docs'), docPath, 'read');
    const raw = fs.readFileSync(target, 'utf-8');
    const body = stripStdHeader(raw);
    const lines = body.split('\n');
    const slice = lines.slice(offset, offset + limit);
    return {
      content: [{ type: 'text', text: slice.join('\n') }],
      details: { path: docPath, offset, returnedLines: slice.length, totalLines: lines.length },
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

  private toolKbWriteDoc(context: InternalRunContext, args: Record<string, unknown>, meta?: ToolRequestMeta): ToolResult {
    const state = requireBuildState(context);
    // T3（A 案 §7.1）：审查者没有任何草稿写入口
    this.assertNotReviewPhase(context);
    const docPath = requireString(args, 'path', 1, 600);
    const title = requireString(args, 'title', 1, 300);
    const markdown = requireString(args, 'markdown', 1, 2_000_000);
    const summary = requireString(args, 'summary', 1, 400);
    if (hasEditorialHistory(markdown) || hasEditorialHistory(summary)) {
      throw new ToolError('body_contains_change_history', '正文与文档摘要必须为当前规则的一次成型表述；移除版本头、修订记录和本版/上版对比。变更说明仅放在kb_finish.summary。');
    }
    const sources = args.sources;
    if (!Array.isArray(sources) || sources.length === 0 || !sources.every((source) => typeof source === 'string')) {
      throw new ToolError('invalid_request', 'sources 必须是非空字符串数组');
    }
    for (const source of sources) {
      if (!state.snapshot.has(source as string)) {
        throw new ToolError('invalid_request', `来源不在快照内: ${source}`);
      }
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
    const baseDraft = hasDeclaration ? this.loadKnowledgeDraft(state) : null;
    if (baseDraft && meta?.toolCallId && baseDraft.calls[meta.toolCallId]) {
      // 同 toolCallId 重复提交幂等返回（A 案 §7.1）；不重复写入、不推进修订
      const call = baseDraft.calls[meta.toolCallId]!;
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
      ? this.buildKnowledgeDeclaration(context, state, baseDraft, docPath, docId, args, markdown)
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
    // 深路径先建父目录（mkdir intent 逐级复核），再裁决写入
    const parentRel = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : null;
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

  private toolKbDeleteDoc(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    // T3（A 案 §7.1）：审查者没有任何草稿写入口
    this.assertNotReviewPhase(context);
    const docPath = requireString(args, 'path', 1, 600);
    // R2-04：与 kb_write_doc 同一合法规范路径门——`./`/反斜杠等别名在
    // 认领与触盘之前拒绝，防止用另一字符串认领却删除同一实际文件。
    validateStdDocPath(docPath);
    // S4（§4.3）：删除同样受路径认领约束；收尾轮不受限
    this.assertPathClaim(context, state, docPath);
    removeFileInside(path.join(state.stagingRoot, 'docs'), docPath);
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

  /** 审查轮没有任何草稿写入口（A 案 §7.1）。 */
  private assertNotReviewPhase(context: InternalRunContext): void {
    if (context.options.worker?.phase === 'review') {
      throw new ToolError('kb_review_readonly', '审查者没有任何草稿写入口；草稿修订由撰写/整合轮提交', 403);
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
  private buildKnowledgeDeclaration(
    context: InternalRunContext,
    state: BuildRunState,
    base: KnowledgeDraftFile,
    docPath: string,
    docId: string,
    args: Record<string, unknown>,
    markdown: string,
  ): {
    draft: KnowledgeDraftFile;
    objectIdMap: Record<string, string>;
    evidenceIdMap: Record<string, string>;
    draftRevision: number;
  } {
    void context;
    const draft: KnowledgeDraftFile = JSON.parse(JSON.stringify(base)) as KnowledgeDraftFile;
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
    // 同路径未重新声明的旧对象移除（连同其 clientKey 登记）；重声明对象替换
    const touchedIds = new Set(newObjects.map((object) => object.objectId));
    const removedIds = new Set<string>();
    for (const object of draft.objects) {
      if (object.canonical?.path === docPath && !touchedIds.has(object.objectId)) removedIds.add(object.objectId);
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
    const resourceCache = new Map<string, { resources: EvidenceResource[]; sourceSnapshotHash: string }>();
    const resourcesFor = (sourceId: string): { resources: EvidenceResource[]; sourceSnapshotHash: string } => {
      const cached = resourceCache.get(sourceId);
      if (cached) return cached;
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
      const pack = { resources, sourceSnapshotHash: entry.contentHash };
      resourceCache.set(sourceId, pack);
      return pack;
    };
    const evidenceInputs = args.evidenceClaims === undefined ? [] : requireArray(args, 'evidenceClaims');
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
      const pack = resourcesFor(sourceId);
      const resource = pack.resources.find((candidate) => candidate.resourceId === resourceId);
      if (!resource) {
        throw new ToolError('kb_evidence_unresolved',
          `证据资源不在本构建资源表: ${resourceId}（可用：${pack.resources.map((candidate) => candidate.resourceId).join(', ')}；资源表来自 raw_read 回执）`);
      }
      const selector = parseSelector(input.selector);
      const role = input.role;
      if (role !== 'supports' && role !== 'contradicts' && role !== 'context') {
        throw new ToolError('invalid_request', `evidenceClaims.role 非法: ${String(role)}`);
      }
      const nature = input.nature;
      if (nature !== 'direct' && nature !== 'derived' && nature !== 'machine_description') {
        throw new ToolError('invalid_request', `evidenceClaims.nature 非法: ${String(nature)}`);
      }
      if (selector.kind === 'media_region' && nature === 'direct') {
        throw new ToolError('kb_evidence_unresolved', '图片描述证据不得标 direct（A 案 §5.2）');
      }
      const readReceiptId = optStr(input, 'readReceiptId');
      if ((selector.kind === 'text_span' || selector.kind === 'csv_cells') && !readReceiptId) {
        throw new ToolError('kb_evidence_unresolved', '文本/CSV 证据必须携带 raw_read 返回的 readReceiptId（A 案 §5.3：只能引用回执中的范围）');
      }
      // 服务端重新解引用：selector 解析 → hash 对账 + 回执范围 + quoteHash 复核
      const resolution = resolveSelector(resource, selector);
      if (!resolution.ok) throw new ToolError('kb_evidence_unresolved', resolution.message);
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
    // diting F06：来源快照已变化的旧证据不随重声明存活——它无法通过发布门
    // 禁的重解引用（源已变），留着只会阻断发布；未重报即失效。来源未变且
    // 未重报的旧证据保留（同构建内跨提交沿用同一 evidenceId 替换）。
    const newEvidenceIds = new Set(newEvidence.map((evidence) => evidence.evidenceId));
    const snapshotHashOf = (sourceId: string): string | null => state.snapshot.get(sourceId)?.contentHash ?? null;
    draft.evidence = draft.evidence.filter((evidence) => {
      if (!touchedIds.has(evidence.objectId)) return true;
      if (newEvidenceIds.has(evidence.evidenceId)) return true;
      return snapshotHashOf(evidence.sourceRef.sourceId) === evidence.sourceRef.sourceSnapshotHash;
    });
    draft.evidence = draft.evidence.filter((evidence) => !removedIds.has(evidence.objectId));
    draft.evidence = draft.evidence.filter((evidence) => !newEvidenceIds.has(evidence.evidenceId));
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
      const pack = resourcesFor(sourceId);
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
    return { draft, objectIdMap, evidenceIdMap, draftRevision };
  }

  /**
   * diting F03（A 案 §4.2/§7.4）：流水审查通过时回写对象级机器审查凭据。
   * 把审查范围（报告覆盖的文档）内对象的 reviewStatus 置 passed：
   * reviewActorKind='machine'，reviewerId 绑定报告 ID，reviewSubjectHash
   * 为声明期按当时对象载荷计算并随草稿留存的值（重申时已按实际载荷
   * 失效/继承）。文档级报告不自动冒充人审（reviewActorKind 恒 machine）。
   * scopePaths=null 表示全库范围（最终复核）。返回本次标记的对象数。
   */
  markObjectsMachineReviewed(state: BuildRunState, scopePaths: string[] | null, reportId: string): number {
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
  private toolKbSubmitReview(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    const worker = context.options.worker;
    if (worker && worker.phase !== 'review') {
      throw new ToolError('kb_review_phase_forbidden',
        `kb_submit_review 仅审查轮可用（当前 phase=${worker.phase}）；撰写者不能自审`, 403);
    }
    const unitId = args.unitId !== undefined
      ? requireString(args, 'unitId', 1, 64)
      : worker?.unitId ?? 'all';
    if (!/^[A-Za-z0-9_-]+$/.test(unitId)) {
      throw new ToolError('invalid_request', 'unitId 只能包含字母、数字、下划线与连字符');
    }
    const entries = this.stagingDraftEntries(state);
    const draftHash = computeCandidateHash({ documents: entries });
    const coverageInput = asRecord(args.coverage);
    if (!coverageInput) throw new ToolError('invalid_request', 'coverage 必须是对象');
    const sourceRefs = optStrArray(coverageInput, 'sourceRefs') ?? [];
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
    return {
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
    return {
      kind: 'media_region',
      imageHash: optStr(input, 'imageHash') ?? (() => { throw new ToolError('invalid_request', 'media_region.imageHash 必填'); })(),
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

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
