/**
 * Sources Routes — 源库受控编辑 API（S11，设计 §7.4）。
 *
 *   GET  /api/sources/edits                  → { edits: SourceEditStateDto[] }
 *   GET  /api/sources/edits/:objToken        → SourceEditStateDto & { body }（无行 404）
 *   GET  /api/sources/:objToken/edit-status  → { objToken, relPath, title, bodyHash, editState }
 *   POST /api/sources/:objToken/edit         → { bodyHash, state }
 *   POST /api/sources/:objToken/revert       → { ok: true }
 *
 * 写回飞书（push/preview）属 S12，不在本文件；引用边全量重建（P1-S3，
 * 设计 P1 §2.2）在本文件（sources/references-rebuild）。
 * 错误体沿用既有 { error, message, details? } 约定；错误码对齐设计 §8。
 *
 * edit 请求体（兼容两种契约面）：
 *   { op: SourceEditOp; baseHash; confirm: 'EDIT'; actor? }   — 设计 §7.4 原生形态
 *   { newText: string; baseHash; confirm: 'EDIT' }            — 整体替换别名
 *   { ops: SourceEditOp[]; baseHash; confirm: 'EDIT' }        — 顺序应用数组
 * confirm 必须为 'EDIT'（与同步链 confirmation:'APPLY' 同款的显式确认门）。
 */

import { Hono } from 'hono';
import {
  SourceEditService,
  SourceEditError,
} from '../sources/source-edit-service.js';
import { sharedSourceWriteLock, type SourceWriteLock } from '../sources/source-write-lock.js';
import type { SourceEditActor, SourceEditOp, SourceEditStateDto } from '../types/index.js';
import { PathGuardError } from '../agent/path-guard.js';
import { rebuildSourceReferences } from '../sources/reference-rebuild.js';

export interface SourcesRoutesDeps {
  configManager: any;
  localMapStore: any;
  /** 构建活跃探针；接线：() => kbBuildService.activeBuild(localMapStore) != null。 */
  kbBuild: { isActive(): boolean };
  dataRoot: string;
  /** 缺省与 SyncEngine 共享进程级实例。 */
  locks?: SourceWriteLock;
}

const EDIT_CONFIRM = 'EDIT';
const REVERT_CONFIRM = 'REVERT';
const REBUILD_CONFIRM = 'REBUILD';

export function sourcesRoutes(deps: SourcesRoutesDeps) {
  const routes = new Hono();
  const service = new SourceEditService({
    config: deps.configManager,
    store: deps.localMapStore,
    locks: deps.locks ?? sharedSourceWriteLock,
    kbBuild: deps.kbBuild,
    dataRoot: deps.dataRoot,
  });

  /** 统一错误映射：SourceEditError → 声明码；PathGuardError 兜底；其余 500。 */
  function errorResponse(c: any, error: unknown) {
    if (error instanceof SourceEditError) {
      return c.json(
        { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        error.status as 400 | 404 | 409 | 422 | 500,
      );
    }
    if (error instanceof PathGuardError) {
      const status = error.code === 'not_found' ? 404 : 400;
      return c.json({ error: error.code, message: error.message }, status);
    }
    console.error('[sources] unexpected error:', error);
    return c.json(
      { error: 'source_edit_failed', message: error instanceof Error ? error.message : String(error) },
      500,
    );
  }

  function parseActor(value: unknown): SourceEditActor {
    return value === 'cli' || value === 'agent' ? value : 'ui';
  }

  /** 校验编辑操作对象（替换 service 侧校验前的 400 快速失败）。 */
  function parseEditBody(body: Record<string, unknown>): {
    ops: SourceEditOp[];
    baseHash: string;
    actor: SourceEditActor;
  } {
    if (body.confirm !== EDIT_CONFIRM) {
      throw new SourceEditError(
        'confirmation_required',
        `编辑源文档需要 confirm: "${EDIT_CONFIRM}"`,
        400,
      );
    }
    if (typeof body.baseHash !== 'string' || body.baseHash.length === 0) {
      throw new SourceEditError('invalid_body', 'baseHash 必须是非空字符串（正文 sha256，取自 edit-status）', 400);
    }
    const ops: SourceEditOp[] = [];
    if (body.op && typeof body.op === 'object') {
      ops.push(body.op as SourceEditOp);
    } else if (Array.isArray(body.ops)) {
      if (body.ops.length === 0) throw new SourceEditError('invalid_body', 'ops 必须非空', 400);
      ops.push(...(body.ops as SourceEditOp[]));
    } else if (typeof body.newText === 'string') {
      ops.push({ mode: 'replace_body', body: body.newText });
    } else {
      throw new SourceEditError(
        'invalid_body',
        "缺少编辑操作：提供 op（设计 §7.4）/ ops（数组）/ newText（整体替换别名）之一",
        400,
      );
    }
    return { ops, baseHash: body.baseHash, actor: parseActor(body.actor) };
  }

  // GET /api/sources/edits — 全部编辑行（含 pushed）。
  routes.get('/api/sources/edits', async (c) => {
    try {
      const edits = await service.listEdits();
      return c.json({ edits });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // GET /api/sources/edits/:objToken — 状态 + 当前正文（设计 §7.4 原生路径）。
  routes.get('/api/sources/edits/:objToken', async (c) => {
    try {
      const objToken = c.req.param('objToken');
      const view = await service.read(objToken);
      if (!view.state) {
        return c.json({ error: 'source_edit_not_found', message: '该文档没有编辑记录' }, 404);
      }
      return c.json({ ...view.state, body: view.body });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // GET /api/sources/:objToken/edit-status — 状态探针（预览面板取 baseHash）。
  routes.get('/api/sources/:objToken/edit-status', async (c) => {
    try {
      const status = await service.editStatus(c.req.param('objToken'));
      return c.json(status);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // POST /api/sources/:objToken/edit
  routes.post('/api/sources/:objToken/edit', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_json', message: '编辑请求必须是 JSON 对象' }, 400);
    }
    try {
      const objToken = c.req.param('objToken');
      const { ops, baseHash, actor } = parseEditBody(body);
      const result = await service.edit(objToken, ops, { baseHash, actor });
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // POST /api/sources/:objToken/revert — 放弃修改（恢复 base.md 正文并清 dirty）。
  routes.post('/api/sources/:objToken/revert', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_json', message: '放弃修改请求必须是 JSON 对象' }, 400);
    }
    try {
      if (body.confirm !== REVERT_CONFIRM) {
        return c.json(
          { error: 'confirmation_required', message: `放弃修改需要 confirm: "${REVERT_CONFIRM}"（将恢复为上次同步版本并丢弃本地修改）` },
          400,
        );
      }
      const objToken = c.req.param('objToken');
      await service.revert(objToken, parseActor(body.actor));
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // POST /api/sources/references-rebuild — P1-S3 引用边全量重建（设计 §2.2）。
  // 只读本地 md 纯重算 body 边（零云端调用）；整表替换引用边属维护动作，
  // 需显式 REBUILD 确认（命令表 sources.references-rebuild 同 confirm）。
  routes.post('/api/sources/references-rebuild', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_json', message: '重建请求必须是 JSON 对象' }, 400);
    }
    if (body.confirm !== REBUILD_CONFIRM) {
      return c.json(
        { error: 'confirmation_required', message: `重建引用边需要 confirm: "${REBUILD_CONFIRM}"（将按本地正文全量替换引用边索引）` },
        400,
      );
    }
    try {
      const config = await deps.configManager.load();
      if (!config?.knowledgeBaseRoot) {
        return c.json({ error: 'knowledge_base_root_not_configured', message: '请先配置本地知识库目录' }, 400);
      }
      const result = rebuildSourceReferences(deps.localMapStore, config.knowledgeBaseRoot);
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}

/** 供 index.ts 构造服务实例（S12 写回链与 S13 UI 复用同一实例/锁）。 */
export function createSourceEditService(deps: SourcesRoutesDeps): SourceEditService {
  return new SourceEditService({
    config: deps.configManager,
    store: deps.localMapStore,
    locks: deps.locks ?? sharedSourceWriteLock,
    kbBuild: deps.kbBuild,
    dataRoot: deps.dataRoot,
  });
}

export type { SourceEditStateDto };
