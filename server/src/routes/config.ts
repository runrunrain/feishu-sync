/**
 * Config Routes - Configuration management endpoints
 *
 * GET /api/config - Get current configuration
 * PUT /api/config - Update configuration
 */

import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { Config, WatchedRootConfig } from '../types/index.js';
import { sanitizeLocalDirName, suggestKnowledgeRoot } from '../modules/config-manager.js';
import { collectResolvedRuntimeProtectedRoots } from '../agent/protected-roots.js';
import { checkRootOverlap } from '../agent/path-guard.js';
import { PublicationError } from '../kb/publication-service.js';

const configRoutes = new Hono();

/**
 * GET /api/config/knowledge-root-suggestion - 知识库根目录缺省建议（只算不建）。
 * → { root }。首次配置引导弹窗展示用；采用需走 adopt 端点。
 */
configRoutes.get('/api/config/knowledge-root-suggestion', (c) => {
  return c.json({ root: suggestKnowledgeRoot() });
});

/**
 * POST /api/config/knowledge-root-suggestion/adopt - 采用缺省路径：
 * mkdir(recursive) + 保存 knowledgeBaseRoot → { root }。
 *
 * 2026-10 首次配置引导：此前未设置路径直接同步会在写盘层炸出 ENOENT /
 * 路径校验错误且无引导。前端同步入口弹窗「使用默认路径并继续」直接调
 * 本端点：建目录 + 落盘一次完成，随后继续原同步动作。
 *
 * 目录创建失败（如 D 盘只读/被策略拦截）不吞错：返回 500 带原始信息，
 * 前端弹窗展示并引导改用手动设置。
 */
configRoutes.post('/api/config/knowledge-root-suggestion/adopt', async (c) => {
  const configManager = (c as any).configManager;
  // body.root 可选：显式覆盖建议值（测试注入临时目录；也方便未来自定义
  // 入口复用同一建目录+保存链路）。缺省走 suggestKnowledgeRoot()。
  let requestedRoot: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.root === 'string' && body.root.trim()) {
      requestedRoot = body.root.trim();
    }
  } catch {
    /* 空 body 合法：缺省建议值 */
  }
  const root = requestedRoot ?? suggestKnowledgeRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    return c.json({
      error: 'knowledge_root_create_failed',
      message: `无法创建默认知识库目录 ${root}：${error instanceof Error ? error.message : String(error)}`,
    }, 500);
  }
  try {
    await configManager.updateConfig({ knowledgeBaseRoot: root } as Partial<Config>);
    return c.json({ root });
  } catch (error) {
    return c.json({
      error: 'knowledge_root_save_failed',
      message: `目录已创建但保存配置失败：${error instanceof Error ? error.message : String(error)}`,
    }, 500);
  }
});

function sanitizeConfig(config: Config): Config {
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: config.llm.apiKey ? '***' : '',
      // Provider profiles can carry independent keys. Redact every non-empty
      // one while preserving the profile/model structure needed by Settings.
      providers: config.llm.providers?.map((provider) => ({
        ...provider,
        apiKey: provider.apiKey ? '***' : '',
      })),
    },
  };
}

// Make configManager available via middleware
configRoutes.use('*', async (c, next) => {
  const configManager = (c as any).configManager;
  if (!configManager) {
    return c.json({ error: 'ConfigManager not initialized' }, 500);
  }
  await next();
});

/**
 * GET /api/config - Get current configuration
 */
configRoutes.get('/api/config', async (c) => {
  const configManager = (c as any).configManager;
  const config = await configManager.load();

  // Don't expose sensitive fields like apiKey in production
  return c.json(sanitizeConfig(config));
});

/**
 * Reveal one provider key only after an explicit user interaction in the
 * authenticated desktop UI. GET /api/config remains redacted so ordinary
 * page loads, logs, and background refreshes never receive credentials.
 *
 * This endpoint intentionally accepts only a stable provider id — callers
 * cannot ask it to read arbitrary config fields. The response is marked
 * no-store and is never written to application logs.
 */
configRoutes.post('/api/config/reveal-provider-key', async (c) => {
  let body: { providerId?: unknown };
  try {
    body = await c.req.json() as { providerId?: unknown };
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : '';
  if (!providerId || providerId.length > 256) {
    return c.json({ error: 'invalid_provider_id' }, 400);
  }

  const configManager = (c as any).configManager;
  const config = await configManager.load();
  const provider = config.llm.providers?.find(
    (item: { id: string; apiKey: string }) => item.id === providerId,
  );
  if (!provider) {
    return c.json({ error: 'provider_not_found' }, 404);
  }
  if (!provider.apiKey) {
    return c.json({ error: 'api_key_not_configured' }, 404);
  }

  return c.json(
    { apiKey: provider.apiKey },
    200,
    { 'Cache-Control': 'no-store, max-age=0' },
  );
});

/**
 * PUT /api/config - Update configuration
 */
configRoutes.put('/api/config', async (c) => {
  const configManager = (c as any).configManager;
  let partialConfig: Partial<Config>;
  try {
    partialConfig = await c.req.json() as Partial<Config>;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    // F1：PUT /api/config 剔除 agent.workspaces（Workspace 增删只走专用
    // 路由 POST/DELETE /api/agent/workspaces，防 UI 全量回传绕过路径校验）。
    if (partialConfig.agent && typeof partialConfig.agent === 'object') {
      delete (partialConfig.agent as { workspaces?: unknown }).workspaces;
    }
    // T3b-02（设计 §7.6）：feishuWrite 只接受 desktop token 链路修改。
    // CLI 主体（带 CLI 令牌直连，或经 /api/cli/:command 内部转发携带的
    // actor 标记头）的请求丢弃该字段——命令表层 CONFIG_SET_FORBIDDEN
    // 已前置拒绝 config.set feishuWrite，此处是消费者侧兑底（丢弃语义，
    // 同一 patch 其余字段仍可生效）。
    if (
      (partialConfig.feishuWrite !== undefined || partialConfig.feishuPublish !== undefined)
      && ((c as any).cliActor === true || c.req.header('X-Feishu-Sync-Actor') === 'cli')
    ) {
      // P1-S8（设计 §4.6）：feishuPublish 与 feishuWrite 同属只接受 desktop
      // 修改的段（发布根与发布开关都是云端写入权限门）。
      delete partialConfig.feishuWrite;
      delete partialConfig.feishuPublish;
    }
    // 2026-09-04 watchedRoot 删除级联清理：对比保存前后 watchedRoots，
    // 被移除的根在保存成功后自动 purge 其 DB 数据（documents/sheets/
    // pending/localDirs）——否则树面板残留「未分类」组且无法清理。
    // 本地文件不动，由「孤立文件清理」手动处理。
    const configBefore: Config = await configManager.load();
    const removedRoots = Array.isArray(partialConfig.watchedRoots)
      ? (configBefore.watchedRoots ?? []).filter(
          (oldRoot) =>
            !(partialConfig.watchedRoots ?? []).some((r) => r.url === oldRoot.url),
        )
      : [];

    // 2026-09-04 自动 localDir：watchedRoots 保存时 localDir 留空 → 按根节点
    // 标题自动命名（lark-cli getNode），拉取失败回退 wiki-<token前8>；
    // 与本次提交内其他 localDir 冲突时加 -2/-3 后缀。用户无需手填相对目录。
    // 注意：只补全空值；非空但非法的 localDir 仍交给 normalizeWatchedRootConfig
    // 报错，不吞用户显式输入的问题。
    const autoNamedRoots: WatchedRootConfig[] = [];
    if (Array.isArray(partialConfig.watchedRoots)) {
      const larkCliClient = (c as any).larkCliClient;
      const taken = new Set<string>(
        partialConfig.watchedRoots
          .filter((r): r is WatchedRootConfig =>
            !!r && typeof r === 'object' && typeof r.localDir === 'string' && r.localDir.trim().length > 0)
          .map((r) => (r.localDir as string).trim()),
      );
      for (const root of partialConfig.watchedRoots) {
        if (!root || typeof root !== 'object') continue;
        const localDir = typeof root.localDir === 'string' ? root.localDir.trim() : '';
        if (localDir) continue;
        const rootId = typeof root.id === 'string' && root.id ? root.id : 'root';
        let name = `wiki-${rootId.slice(0, 8)}`;
        try {
          const nodeInfo = await larkCliClient?.getNode?.(root.url);
          if (nodeInfo?.title) {
            name = sanitizeLocalDirName(nodeInfo.title, name);
          }
        } catch {
          // 标题拉取失败（未授权/网络/权限）→ 保留 token fallback，不阻断保存
        }
        let unique = name;
        let suffix = 2;
        while (taken.has(unique)) unique = `${name}-${suffix++}`;
        taken.add(unique);
        root.localDir = unique;
        autoNamedRoots.push(root as WatchedRootConfig);
      }
    }

    // F3-R02：agent.runtime 变更（nodePath/piCliPath 指向新的 pi 安装根）
    // 时，已有 Workspace 不得覆盖/位于新安装根——否则下次 spawn 就是用
    // 被改写过的 pi 执行。ConfigManager 只做同步静态保护根交叉校验，
    // 运行时发现根在此处（有 resolver）补充。发现失败不阻断保存：
    // resolver 自身会在 spawn 前给出明确错误。
    const runtimeChange = partialConfig.agent?.runtime;
    if (runtimeChange && typeof runtimeChange === 'object'
      && ('nodePath' in runtimeChange || 'piCliPath' in runtimeChange || 'claudeCliPath' in runtimeChange || 'backend' in runtimeChange)) {
      const resolver = (c as any).agentRuntimeResolver;
      const currentConfig: Config = configBefore;
      const candidateAgent = { ...currentConfig.agent, ...partialConfig.agent };
      try {
        await resolver.resolveRuntime(candidateAgent);
      } catch {
        /* 非法 runtime 由后续 spawn 时报错；这里不重复拦截 */
      }
      const runtimeRoots = collectResolvedRuntimeProtectedRoots(resolver);
      if (runtimeRoots.length > 0) {
        for (const workspace of currentConfig.agent.workspaces) {
          // 本处只补运行时安装根交叉校验；knowledgeBaseRoot/outputRoot/
          // dataRoot/静态保护根由 ConfigManager.updateConfig 同步校验（传空跳过）。
          const verdict = checkRootOverlap(workspace.path, {
            knowledgeBaseRoot: '',
            outputRoot: '',
            dataRoot: '',
            protectedRoots: runtimeRoots,
          });
          if (!verdict.ok) {
            return c.json({
              error: 'config_validation_failed',
              message: `保存被拒绝：Workspace「${workspace.name}」与新运行时安装根冲突：${verdict.message}`,
            }, 400);
          }
        }
      }
    }

    const updatedConfig = await configManager.updateConfig(partialConfig);

    // 自动命名的目录立即落盘（否则用户要等首次同步才看得到）；失败不阻断
    // ——同步链路 atomic-commit 写盘时会 recursive mkdir 兑底。
    if (autoNamedRoots.length > 0 && typeof updatedConfig.knowledgeBaseRoot === 'string' && updatedConfig.knowledgeBaseRoot) {
      for (const root of autoNamedRoots) {
        try {
          fs.mkdirSync(path.join(updatedConfig.knowledgeBaseRoot, root.localDir), { recursive: true });
        } catch (err) {
          console.warn(`[config] auto mkdir failed for ${root.localDir}:`, err);
        }
      }
    }

    // Keep the long-lived LarkCliClient in sync with Settings changes. In
    // particular, a user who pastes an absolute lark-cli path should be able
    // to press "重新检测" immediately instead of restarting the desktop app.
    const larkCliClient = (c as any).larkCliClient;
    if (typeof larkCliClient?.updateConfig === 'function') {
      larkCliClient.updateConfig({
        requiredScopes: updatedConfig.requiredScopes,
      });
    }

    // 2026-09-04 watchedRoot 删除后的 DB 级联清理（见上方 removedRoots 注释）。
    const localMapStore = (c as any).localMapStore;
    const purgedWatchedRoots: Array<{
      url: string;
      documents: number;
      sheets: number;
      pendingItems: number;
      localDirs: number;
    }> = [];
    for (const removed of removedRoots) {
      if (typeof localMapStore?.purgeWatchedRootData === 'function') {
        const purged = localMapStore.purgeWatchedRootData(removed.url, removed.id);
        purgedWatchedRoots.push({ url: removed.url, ...purged });
      }
    }

    return c.json({
      success: true,
      config: sanitizeConfig(updatedConfig),
      ...(purgedWatchedRoots.length > 0 ? { purgedWatchedRoots } : {}),
    });
  } catch (error) {
    // T4b-03：发布根联合校验（ConfigManager 钩子）以 PublicationError 语义
    // 上抛（409 重叠 / 502 祖先链不可读），不落入 400 config_validation_failed。
    if (error instanceof PublicationError) {
      return c.json(
        { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        error.status as 200 | 400 | 403 | 404 | 409 | 412 | 500,
      ) as unknown as Response;
    }
    return c.json(
      {
        error: 'config_validation_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      400,
    );
  }
});

export { configRoutes };
