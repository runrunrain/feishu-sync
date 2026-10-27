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
import { getToolSpec, getToolSpecs } from './tool-specs.js';
import { RawSourceSnapshot, collectSourceCandidates } from '../kb/raw-source-snapshot.js';
import { StandardKbStore, stripStdHeader } from '../kb/standard-kb-store.js';
import { matchGlob } from '../kb/kb-search.js';
import { hasEditorialHistory, hasSourceMetadata } from '../kb/body-policy.js';
import type {
  AgentRunContext,
  AgentToolSpec,
  RawSourceSnapshotEntry,
} from '../types/agent-knowledge.js';
import type { DocumentRecord } from '../types/index.js';

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
  finishInfo: { summary: string; skipped: Array<{ objToken: string; reason: string }> } | null;
  /** 受旧源变动影响的现存草稿必须显式重写，不能借旧sources声明冒充更新。 */
  requiredRewrites?: Set<string>;
  writtenPaths?: Set<string>;
  /**
   * F3-R08：不可恢复毒化标记。raw_read/raw_search 命中
   * source_changed_during_build 后置位；后续每个 batch 结束与发布前都
   * 检查——模型不得用 skip/finish 绕过，构建必须以同码失败终止。
   */
  poisoned?: { code: string; message: string };
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
  onEvent?: (event: { phase: 'start' | 'end'; toolName: string; argsSummary: string; resultSummary?: string; isError?: boolean }) => void;
}

interface InternalRunContext extends AgentRunContext {
  options: RunContextOptions;
}

export interface SheetCsvPathResolver {
  (objToken: string): string[];
}

export class AgentToolService {
  private readonly contexts = new Map<string, InternalRunContext>();
  private readonly stores = new Map<string, StandardKbStore>();
  private readonly sheetCsvPaths: SheetCsvPathResolver;
  private readonly documentsProvider: () => DocumentRecord[];
  private readonly dataRoot: string;
  /** F3-R02：Workspace 动态守卫（当前配置快照）；未注入时不做动态复核 */
  private readonly workspaceGuard?: (workspaceRoot: string) => { ok: true } | { ok: false; code: string; message: string };

  constructor(input: {
    dataRoot: string;
    documentsProvider: () => DocumentRecord[];
    sheetCsvPaths?: SheetCsvPathResolver;
    workspaceGuard?: (workspaceRoot: string) => { ok: true } | { ok: false; code: string; message: string };
  }) {
    this.dataRoot = input.dataRoot;
    this.documentsProvider = input.documentsProvider;
    this.sheetCsvPaths = input.sheetCsvPaths ?? (() => []);
    this.workspaceGuard = input.workspaceGuard;
  }

  private storeFor(outputRoot: string): StandardKbStore {
    let store = this.stores.get(outputRoot);
    if (!store) {
      store = new StandardKbStore(outputRoot);
      this.stores.set(outputRoot, store);
    }
    return store;
  }

  /** 创建运行上下文（发新令牌）。进程每次启动调用一次。 */
  createRunContext(options: RunContextOptions): { token: string; context: AgentRunContext } {
    const token = crypto.randomBytes(32).toString('base64url');
    const allowedTools = options.runKind === 'build'
      ? ['raw_list', 'raw_read', 'raw_search', 'draft_list', 'draft_read', 'draft_search', 'kb_write_doc', 'kb_delete_doc', 'kb_finish']
      : options.runKind === 'work'
        ? ['kb_search', 'kb_read', 'raw_search', 'raw_read', 'ws_ls', 'ws_read', 'ws_search', 'ws_write', 'ws_edit', 'ws_mkdir']
        : options.runKind === 'discuss'
          ? ['kb_search', 'kb_read', 'raw_search', 'raw_read']
          : [];
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

  /** GET /tools：返回本运行允许的工具规格。 */
  getToolSpecsForToken(token: string): AgentToolSpec[] | null {
    const context = this.contexts.get(token);
    if (!context) return null;
    return getToolSpecs(context.allowedTools);
  }

  /** POST /tools/:name 执行入口。 */
  async executeTool(token: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const context = this.contexts.get(token);
    if (!context) {
      throw new ToolError('run_token_invalid', '运行令牌无效或已过期', 401);
    }
    if (!context.allowedTools.includes(toolName)) {
      throw new ToolError('tool_not_allowed', `工具 ${toolName} 不在本运行的工具白名单内（runKind=${context.runKind}）`, 403);
    }
    const spec = getToolSpec(toolName);
    if (!spec) {
      throw new ToolError('tool_not_allowed', `未知工具: ${toolName}`, 403);
    }
    const argsSummary = summarizeArgs(toolName, args);
    context.options.onEvent?.({ phase: 'start', toolName, argsSummary });
    try {
      const result = await this.dispatch(context, toolName, args);
      const resultSummary = summarizeResult(result);
      context.options.onEvent?.({ phase: 'end', toolName, argsSummary, resultSummary, isError: false });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.options.onEvent?.({
        phase: 'end',
        toolName,
        argsSummary,
        resultSummary: message.slice(0, 300),
        isError: true,
      });
      throw error;
    }
  }

  private async dispatch(context: InternalRunContext, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case 'kb_search':
        return this.toolKbSearch(context, args);
      case 'kb_read':
        return this.toolKbRead(context, args);
      case 'raw_search':
        return this.toolRawSearch(context, args);
      case 'raw_read':
        return this.toolRawRead(context, args);
      case 'raw_list':
        return this.toolRawList(context, args);
      case 'draft_list':
        return this.toolDraftList(context);
      case 'draft_read':
        return this.toolDraftRead(context, args);
      case 'draft_search':
        return this.toolDraftSearch(context, args);
      case 'kb_write_doc':
        return this.toolKbWriteDoc(context, args);
      case 'kb_delete_doc':
        return this.toolKbDeleteDoc(context, args);
      case 'kb_finish':
        return this.toolKbFinish(context, args);
      case 'ws_ls':
        return this.toolWsLs(context, args);
      case 'ws_read':
        return this.toolWsRead(context, args);
      case 'ws_search':
        return this.toolWsSearch(context, args);
      case 'ws_write':
        return this.toolWsWrite(context, args);
      case 'ws_edit':
        return this.toolWsEdit(context, args);
      case 'ws_mkdir':
        return this.toolWsMkdir(context, args);
      default:
        throw new ToolError('tool_not_allowed', `工具未实现: ${toolName}`, 403);
    }
  }

  // ------------------------------------------------------------------
  // kb_*（读已发布标准库）
  // ------------------------------------------------------------------

  private toolKbSearch(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const query = requireString(args, 'query', 1, 200);
    const limit = optionalInt(args, 'limit', 20, 1, 20);
    const store = this.storeFor(context.options.outputRoot);
    const manifest = store.readManifest();
    if (!manifest) {
      throw new ToolError('kb_not_published', '标准知识库尚未发布，无法搜索', 404);
    }
    const hits = store.search(manifest, query, limit);
    return {
      content: [{ type: 'text', text: JSON.stringify({ releaseId: manifest.releaseId, results: hits }, null, 2) }],
    };
  }

  private toolKbRead(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const docId = typeof args.docId === 'string' && args.docId ? args.docId : undefined;
    const docPath = typeof args.path === 'string' && args.path ? args.path : undefined;
    if (!docId && !docPath) {
      throw new ToolError('invalid_request', 'docId 与 path 必须提供其一');
    }
    const offset = optionalInt(args, 'offset', 0, 0, 10_000_000);
    const limit = optionalInt(args, 'limit', 800, 1, 2000);
    const store = this.storeFor(context.options.outputRoot);
    const manifest = store.readManifest();
    if (!manifest) {
      throw new ToolError('kb_not_published', '标准知识库尚未发布', 404);
    }
    const doc = store.findDoc(manifest, { docId, path: docPath });
    if (!doc) {
      throw new ToolError('kb_doc_not_found', `标准文档不存在: ${docId ?? docPath}`, 404);
    }
    const loaded = store.readReleaseDoc(manifest.releaseId, doc);
    const lines = loaded.markdown.split('\n');
    const slice = lines.slice(offset, offset + limit);
    return {
      content: [{
        type: 'text',
        text: slice.join('\n'),
      }],
      details: {
        docId: doc.docId,
        path: doc.path,
        title: doc.title,
        summary: doc.summary,
        tags: doc.tags,
        sources: doc.sources,
        offset,
        returnedLines: slice.length,
        totalLines: lines.length,
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
    const lowerQuery = query.toLowerCase();
    const entries = context.options.buildState
      ? context.options.buildState.snapshot.entries
      : this.rawEntriesForDiscuss(context);
    const results: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      let snippet = '';
      let score = 0;
      if (entry.title.toLowerCase().includes(lowerQuery)) score += 10;
      if (entry.relPath.toLowerCase().includes(lowerQuery)) score += 5;
      try {
        const content = this.readRawContent(context, entry.objToken);
        const lower = content.toLowerCase();
        const index = lower.indexOf(lowerQuery);
        if (index >= 0) {
          score += 20;
          const start = Math.max(0, index - 60);
          snippet = `${start > 0 ? '…' : ''}${content.slice(start, index + query.length + 100).replace(/\n+/g, ' ')}…`;
        }
      } catch {
        /* 读取失败只降权 */
      }
      if (score > 0) {
        results.push({
          objToken: entry.objToken,
          title: entry.title,
          relPath: entry.relPath,
          ...(snippet ? { snippet } : {}),
        });
      }
      if (results.length >= limit) break;
    }
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

  private toolRawRead(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const objToken = requireString(args, 'objToken', 1, 256);
    const offset = optionalInt(args, 'offset', 0, 0, 10_000_000);
    const limit = optionalInt(args, 'limit', 800, 1, 2000);
    const entry = context.options.buildState
      ? context.options.buildState.snapshot.get(objToken)
      : this.rawEntriesForDiscuss(context).find((candidate) => candidate.objToken === objToken) ?? null;
    if (!entry) {
      throw new ToolError('not_found', `原始文档不存在或无成功本地版本: ${objToken}`, 404);
    }
    const content = this.readRawContent(context, objToken);
    const lines = content.split('\n');
    const slice = lines.slice(offset, offset + limit);
    const wrapped = `<untrusted_source obj_token="${entry.objToken}" title="${escapeXml(entry.title)}">\n${slice.join('\n')}\n</untrusted_source>`;
    return {
      content: [{ type: 'text', text: wrapped }],
      details: {
        objToken: entry.objToken,
        title: entry.title,
        relPath: entry.relPath,
        offset,
        returnedLines: slice.length,
        totalLines: lines.length,
      },
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
      entries = entries.filter((entry) => state.workset.has(entry.objToken));
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
    removeFileInside(path.join(state.stagingRoot, 'docs'), docPath);
    return { content: [{ type: 'text', text: `已删除草稿 ${docPath}` }] };
  }

  private toolKbFinish(context: InternalRunContext, args: Record<string, unknown>): ToolResult {
    const state = requireBuildState(context);
    if (state.finishInfo) {
      throw new ToolError('invalid_request', 'kb_finish 已调用过');
    }
    const summary = requireString(args, 'summary', 1, 4000);
    const skipped = Array.isArray(args.skipped)
      ? args.skipped
          .filter((item): item is { objToken: string; reason: string } =>
            Boolean(item) && typeof item === 'object'
            && typeof (item as { objToken?: unknown }).objToken === 'string'
            && typeof (item as { reason?: unknown }).reason === 'string')
          .map((item) => ({ objToken: item.objToken, reason: item.reason.slice(0, 300) }))
      : [];
    for (const item of skipped) {
      if (!state.snapshot.has(item.objToken)) {
        throw new ToolError('invalid_request', `skipped 来源不在快照内: ${item.objToken}`);
      }
    }
    state.finishInfo = { summary, skipped };
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
    case 'kb_read':
      return `docId=${String(args.docId ?? args.path ?? '')}`;
    case 'kb_search':
    case 'raw_search':
    case 'draft_search':
    case 'ws_search':
      return `query=${String(args.query ?? '').slice(0, 60)}`;
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
