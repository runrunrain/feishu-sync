/**
 * KB Publications Routes — 反向发布 API（P1-S8，设计 P1 §4.6）。
 *
 *   POST /api/kb/publish/preview       body { releaseId?, kbPaths?, force? }
 *                                      → PublishPlanDto（只读：动作/警告/阻断/
 *                                        gates/planKey/确认值派生）
 *   POST /api/kb/publish               body 同上 + confirm (+planKey?, actor?)
 *                                      → PublishRunResultDto（确认门：
 *                                        PUBLISH；force 解除冲突 →
 *                                        OVERWRITE_PUBLISHED）
 *   GET  /api/kb/publications          → { publications: 行 DTO }
 *   GET  /api/kb/publications/:kbPath  → 行 DTO（无行 404）
 *   PUT  /api/kb/publish/target        body { url } | { kind, token, label?,
 *                                        spaceId? } | { target: null }
 *                                      → { target }（仅 desktop token；粘贴
 *                                        Drive 文件夹 / wiki 节点 URL 即时
 *                                        双向校验，失败拒绝）
 *
 * 门控（§4.6）：feishuWrite.enabled ∧ 写 scope ∧ feishuPublish.enabled ∧
 * target 已校验——由 KbPublishService.requireGates 在执行路径强制；preview
 * 只读不强制（gates 状态随计划返回）。CLI 主体经 config.set 禁改
 * feishuPublish；PUT /api/config 对 CLI 丢弃该段；target 路由拒绝 CLI 主体。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  KbPublishService,
  PublicationError,
  parsePublishTargetUrl,
  validatePublishTargetAgainstWatchedRoots,
  type PublishActor,
  type PublishTargetConfig,
} from '../kb/publication-service.js';

export interface KbPublicationsRoutesDeps {
  configManager: any;
  localMapStore: any;
  larkCliClient: any;
  dataRoot: string;
}

export function kbPublicationsRoutes(deps: KbPublicationsRoutesDeps) {
  const routes = new Hono();
  const service = new KbPublishService({
    configManager: deps.configManager,
    localMapStore: deps.localMapStore,
    larkCliClient: deps.larkCliClient,
    dataRoot: deps.dataRoot,
  });

  function errorResponse(c: Context, error: unknown): Response {
    if (error instanceof PublicationError) {
      return c.json(
        { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        error.status as 200 | 400 | 403 | 404 | 409 | 412 | 500,
      ) as unknown as Response;
    }
    console.error('[kb-publications] unexpected error:', error);
    return c.json(
      { error: 'publish_failed', message: error instanceof Error ? error.message : String(error) },
      500,
    ) as unknown as Response;
  }

  function parseActor(value: unknown): PublishActor {
    return value === 'cli' || value === 'agent' ? value : 'ui';
  }

  function parsePlanBody(body: Record<string, unknown>): { releaseId?: string; kbPaths?: string[]; force?: boolean } {
    const result: { releaseId?: string; kbPaths?: string[]; force?: boolean } = {};
    if (body.releaseId !== undefined) {
      if (typeof body.releaseId !== 'string' || body.releaseId.length === 0) {
        throw new PublicationError('invalid_request', 'releaseId 必须是非空字符串', 400);
      }
      result.releaseId = body.releaseId;
    }
    if (body.kbPaths !== undefined) {
      if (!Array.isArray(body.kbPaths) || !body.kbPaths.every((p) => typeof p === 'string')) {
        throw new PublicationError('invalid_request', 'kbPaths 必须是字符串数组（缺省=整个 release）', 400);
      }
      result.kbPaths = body.kbPaths as string[];
    }
    if (body.force !== undefined) {
      if (typeof body.force !== 'boolean') {
        throw new PublicationError('invalid_request', 'force 必须是 boolean', 400);
      }
      result.force = body.force;
    }
    return result;
  }

  // POST /api/kb/publish/preview — 只读计划（批准卡数据面）。
  routes.post('/api/kb/publish/preview', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const plan = await service.plan(parsePlanBody(body ?? {}));
      return c.json(plan);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // POST /api/kb/publish — 执行（confirm 门 + 可选 planKey 复核）。
  routes.post('/api/kb/publish', async (c) => {
    try {
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body.confirm !== 'string' || body.confirm.length === 0) {
        throw new PublicationError('confirmation_required', '发布到飞书需要 confirm（PUBLISH；force 解除冲突时为 OVERWRITE_PUBLISHED）', 400);
      }
      const planBody = parsePlanBody(body);
      const result = await service.execute({
        ...planBody,
        confirm: body.confirm,
        ...(body.planKey !== undefined && typeof body.planKey === 'string' ? { planKey: body.planKey } : {}),
        actor: parseActor(body.actor),
      });
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // GET /api/kb/publications — 全部发布行。
  routes.get('/api/kb/publications', (c) => {
    return c.json({ publications: service.listPublications() });
  });

  // GET /api/kb/publications/:kbPath — 单行详情（路径段 URL 编码）。
  routes.get('/api/kb/publications/:kbPath', (c) => {
    const kbPath = c.req.param('kbPath');
    const row = service.getPublication(kbPath);
    if (!row) {
      return c.json({ error: 'publication_not_found', message: `该标准库路径没有发布记录：${kbPath}` }, 404);
    }
    return c.json(row);
  });

  // PUT /api/kb/publish/target — 设置/清除发布根（仅 desktop token 链路）。
  routes.put('/api/kb/publish/target', async (c) => {
    try {
      if ((c as any).cliActor === true || c.req.header('X-Feishu-Sync-Actor') === 'cli') {
        return c.json(
          { error: 'forbidden', message: '发布根只接受应用内（desktop token）修改：CLI/命令通道不可变更云端写入目标' },
          403,
        );
      }
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) {
        return c.json({ error: 'invalid_request', message: '请求体必须是 JSON' }, 400);
      }
      const configManager = deps.configManager;

      // 清除发布根：{ target: null }
      if (body.target === null) {
        const current = await configManager.load();
        await configManager.updateConfig({
          feishuPublish: { ...(current.feishuPublish ?? { enabled: false }), target: null },
        });
        return c.json({ target: null });
      }

      // 两种输入面：粘贴 URL（P1-S9 UI）或结构化 { kind, token, label? }。
      let target: PublishTargetConfig;
      if (typeof body.url === 'string') {
        const parsed = parsePublishTargetUrl(body.url);
        if (!parsed) {
          return c.json(
            { error: 'invalid_request', message: '无法识别发布根 URL：请粘贴 Drive 文件夹（/drive/folder/<token>）或 wiki 节点（/wiki/<token>）链接' },
            400,
          );
        }
        const label = typeof body.label === 'string' && body.label.trim().length > 0
          ? body.label.trim().slice(0, 200)
          : body.url.slice(0, 200);
        target = {
          kind: parsed.kind,
          token: parsed.token,
          ...(typeof body.spaceId === 'string' && body.spaceId.length > 0 ? { spaceId: body.spaceId } : {}),
          label,
        };
      } else if (
        body.kind !== undefined || body.token !== undefined
      ) {
        if (body.kind !== 'drive_folder' && body.kind !== 'wiki_node') {
          return c.json({ error: 'invalid_request', message: 'kind 必须是 drive_folder 或 wiki_node' }, 400);
        }
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(body.token)) {
          return c.json({ error: 'invalid_request', message: 'token 形态无效' }, 400);
        }
        const label = typeof body.label === 'string' && body.label.trim().length > 0
          ? body.label.trim().slice(0, 200)
          : body.token;
        target = {
          kind: body.kind,
          token: body.token,
          ...(typeof body.spaceId === 'string' && /^[A-Za-z0-9]{8,64}$/.test(body.spaceId) ? { spaceId: body.spaceId } : {}),
          label,
        };
      } else {
        return c.json({ error: 'invalid_request', message: '提供 url（粘贴链接）或 {kind, token, label?}（结构化），或 {target: null} 清除发布根' }, 400);
      }

      // 双向校验（§4.1 防线 1）：wiki 节点走云端祖先链（fail-closed）；
      // Drive 文件夹与 wiki 子树不同命名空间，天然不重叠。
      const current = await configManager.load();
      const watchedRoots = (current.watchedRoots ?? []).map((root: { id: string; url: string }) => ({
        id: root.id,
        url: root.url,
      }));
      const overlap = await validatePublishTargetAgainstWatchedRoots(
        target,
        watchedRoots,
        (token: string) => deps.larkCliClient.getNode(token),
      );
      if (!overlap.ok) {
        return c.json(
          {
            error: overlap.code,
            message: overlap.message,
            details: { code: overlap.code, ...(overlap.rootId ? { rootId: overlap.rootId } : {}) },
          },
          overlap.code === 'publish_target_unverifiable' ? 502 : 409,
        );
      }

      await configManager.updateConfig({
        feishuPublish: { ...(current.feishuPublish ?? { enabled: false }), target },
      });
      return c.json({ target, overlapChecked: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}
