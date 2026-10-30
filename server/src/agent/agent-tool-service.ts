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
  KB_GREP_SPEC,
  KB_READ_SPEC,
  KB_SEARCH_SPEC,
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
  phase: 'unit' | 'final';
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
        { spec: RAW_READ_SPEC, runKinds: ['build', 'work', 'discuss'], execute: (context, args) => this.toolRawRead(context, args) },
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
        { spec: KB_WRITE_DOC_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbWriteDoc(context, args) },
        { spec: KB_DELETE_DOC_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbDeleteDoc(context, args) },
        // S4（§4.4）：逐单元上报；kb_finish 保持单值、只在收尾轮可用
        { spec: KB_UNIT_DONE_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbUnitDone(context, args) },
        { spec: KB_FINISH_SPEC, runKinds: ['build'], execute: (context, args) => this.toolKbFinish(context, args) },
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

  private async toolRawRead(context: InternalRunContext, args: Record<string, unknown>): Promise<ToolResult> {
    const objToken = requireString(args, 'objToken', 1, 256);
    const offset = optionalInt(args, 'offset', 0, 0, 10_000_000);
    const limit = optionalInt(args, 'limit', 800, 1, 2000);
    const entry = context.options.buildState
      ? context.options.buildState.snapshot.get(objToken)
      : this.rawEntriesForDiscuss(context).find((candidate) => candidate.objToken === objToken) ?? null;
    if (!entry) {
      throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    }
    let content = this.readRawContent(context, objToken);
    // S3（§3.4/§3.5）：图片引用处内联描述——build 用 preflight 预描述结果；
    // 会话只内联已缓存描述（未缓存标 not_described）；描述同属不可信数据。
    content = context.options.buildState
      ? this.inlineBuildImageDescriptions(context.options.buildState, entry, content)
      : await this.inlineSessionImageDescriptions(context, entry, content);
    const lines = content.split('\n');
    const slice = lines.slice(offset, offset + limit);
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
        ...(sourceLinks ? { sourceLinks: sourceLinks.summary } : {}),
      },
    };
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

  /** S3（§3.4）：build 态内联——预描述命中给文本，否则 unavailable 标记。
   *  P0-S7：白板旁路文字命中 → 先内联 <whiteboard_text>，且不再插识图
   *  描述（旁路文字优先，跳过该图 vision 结果）。 */
  private inlineBuildImageDescriptions(
    state: BuildRunState,
    entry: RawSourceSnapshotEntry,
    content: string,
  ): string {
    const images = resolveSourceImages(state.knowledgeBaseRoot, entry.relPath, content);
    if (images.length === 0) return content;
    const whiteboard = state.whiteboardTexts?.get(entry.objToken);
    const described = state.imageDescriptions?.get(entry.objToken);
    const fallbackReason = state.visionReady ? 'not_described' : 'vision_unconfigured';
    return inlineImageBlocks(
      content,
      images,
      (src) => {
        if (whiteboard?.has(src)) return undefined;
        return described?.get(src) ?? { src, state: 'unavailable', reason: fallbackReason };
      },
      (src) => whiteboard?.get(src),
    );
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

  private toolKbWriteDoc(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
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

    // docId 继承：按 path 沿用当前 release 的 docId（server 分配）
    const docId = this.inheritDocId(state, docPath) ?? `kd_${crypto.randomBytes(6).toString('hex')}`;
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
    atomicWriteFile(target, full);
    state.writtenPaths?.add(docPath);
    state.docMeta?.set(docPath, { title, summary, tags, sources: sources as string[] });
    return {
      content: [{ type: 'text', text: `已写入草稿 ${docPath}（docId=${docId}，${full.length} 字节）` }],
      details: { path: docPath, docId, bytes: Buffer.byteLength(full, 'utf-8') },
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

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'kb_write_doc':
      return `path=${String(args.path ?? '')} sources=${Array.isArray(args.sources) ? args.sources.length : 0}`;
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
