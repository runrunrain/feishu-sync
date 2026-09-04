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
import { sanitizeLocalDirName } from '../modules/config-manager.js';

const configRoutes = new Hono();

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
        larkCliPath: updatedConfig.larkCliPath,
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
