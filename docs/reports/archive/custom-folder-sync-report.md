# 自定义归档文档同步状态跟踪 — 实现报告

## 概述

将快捷添加的自定义归档文档（custom_folder_id 非空、watched_root_url 为 NULL）纳入同步状态跟踪体系：云端内容变更可检测、可出现在变更列表、可同步更新本地文件。

## 四块改动

### 块 1：检测 — `detectCustomFolderChanges()`

**文件**: `server/src/modules/change-detector.ts`

新增 `detectCustomFolderChanges()` 公开方法（行 ~393-519）：
- 从 `localMapStore.listAllCustomFolderDocs()` 读取所有 custom_folder_id 非空且 watched_root_url NULL 的行
- 对每行用 `getNode(originalLink || wikiNodeToken)` 取云端 obj_edit_time
- 构造 `CloudNodeObservation` 并调用 `recordCloudObservation`，复用既有 `nextStateForObservation` 状态机（NaN 安全、不推进 synced 基线）
- 仅当结果 syncState = `pending_modified` 时加入 changedDocuments
- getNode 失败 → 不判 deleted（可能权限问题），计 error 并跳过
- 返回 `{ checked, changed, errors, changedDocuments }`

同时更新 `toChangedDocument()` 传播 `customFolderId` 字段。

**LocalMapStore** 新增 `listAllCustomFolderDocs()` 方法（`server/src/modules/local-map-store.ts`）：返回 full DocumentRecord 行，与已有的 `listCustomFolderDocs(folderId)` 区分。

### 块 2：检测入口接入

**文件**: `server/src/routes/detect.ts`
- `POST /api/detect/changes-all`：在 per-root 循环前先跑 `detectCustomFolderChanges()`
- 修正早期返回：仅当 watchedRootUrls 为空 **且** customResult.checked 为 0 时才 400
- per-root 循环后合并 custom 变更到 `aggregatedChangedDocuments` 和 `aggregatedTotalNodes`

**文件**: `server/src/modules/polling-scheduler.ts`
- `executeDetection()` 在 per-root 循环后追加 `detectCustomFolderChanges()`
- 合并所有变更（watched-root + custom）后统一调用 `onChange` 回调

### 块 3：diff 并入

**文件**: `server/src/modules/mapping-service.ts`
- 新增 `getCustomFolderModifiedDocs()` — 纯本地读 `listAllCustomFolderDocs()` 并过滤 syncState='pending_modified'
- 新增 `toCustomChangedDocument()` — 投影为 ChangedDocument（changeType='modified'，watchedRootId=null，customFolderId 来自 DB）
- `computeDiff()`：modified 列表追加 custom modified，totalCloud/unchanged 计数对应调整
- `getStoredDiff()`：同上，纯本地读不触发云检测
- `toStoredChangedDocument()` 传播 `customFolderId`

### 块 4：同步适配

**文件**: `server/src/modules/operation-manifest.ts`（关键修复）
- `planDocument()`：新增 `isCustomFolderDoc = !!document.customFolderId`
- custom 文档跳过 `unknown_watched_root` 拦截和 watchedRoot 路径解析
- 落入 fallback 路径：`candidate = document.localMdPath ? resolveDocumentPath(root, localMdPath) : fallback`，复用 _custom/ 已有路径

**文件**: `server/src/modules/sync-engine.ts`
- 同步成功路径：`upsertDocument` 的 ON CONFLICT SET 不含 `custom_folder_id` 列 → 保留；`watched_root_url` 用 COALESCE(NULL, existing) 保留 NULL
- `markDocumentSynced` 不触碰 custom_folder_id/watched_root_url → 保留
- 同步失败路径：custom 文档（doc.customFolderId 非空）不进 `queueFeishuSideFailure`（feishu_pending 队列按 watched_root_id 过滤，NULL 行不可见）

## 类型变更

**文件**: `server/src/types/index.ts`
- `ChangedDocument` 新增 `customFolderId?: string | null`

## 测试

**新文件**: `server/tests/custom-folder-detect-sync.test.ts`（12 用例）
- detectCustomFolderChanges：modified 检测 / 未变不标 / NaN 防御 / getNode 失败不误删 / 无 identity 跳过 / 空集 / 多文档混合
- mapping-service diff：getStoredDiff 含 custom modified / 不含 synced / computeDiff 含 custom modified
- operation-manifest：custom 文档绕过 watchedRoot 校验 / 非 custom 文档仍被拦截

**修改**: `server/tests/detect-routes.test.ts` — stub detector 添加 `detectCustomFolderChanges` 空返回
**修改**: `server/tests/mapping-service.test.ts` — MockLocalMapStore 添加 `listAllCustomFolderDocs`

## 验证结果

| 验收项 | 证据 | 状态 |
|--------|------|------|
| 全量测试 | 408 passed (396 原有 + 12 新增), 0 failed | ✅ |
| server tsc --noEmit | 无错误 | ✅ |
| 前端 npm run build | vite build 成功 (343KB bundle) | ✅ |
| detectCustomFolderChanges 单测 | 7 用例全过：modified/未变/NaN/失败/无identity/空集/混合 | ✅ |
| diff 并入单测 | 3 用例全过：getStoredDiff/computeDiff/synced不含 | ✅ |
| manifest bypass 单测 | 2 用例全过：custom绕过/非custom仍拦截 | ✅ |
| custom_folder_id 保留验证 | 分析确认：upsertDocument ON CONFLICT SET 不含该列；markDocumentSynced 不触碰 | ✅ |
| watched_root_url 保留验证 | 分析确认：COALESCE(NULL, existing) 保留 NULL（`|| null` 绑定） | ✅ |

## 语义决策说明

1. **deleted 不做**：getNode 失败（131005 权限、限流等）不计为删除。custom 文档的删除检测需要独立确认流程，v1 只做 modified。

2. **feishu_pending 不进**：`feishu_pending_items` 队列在 UI 端按 `watched_root_id IN (...)` 过滤。custom 文档 watched_root_id 为 NULL，进入队列后不可见。改为普通失败提示（sync result 的 failedDocuments），不入 feishu_pending。

3. **computeDiff 不触发云检测**：custom 文档的云检测由 detect-changes-all / polling 负责。computeDiff/getStoredDiff 只从 DB 读已存储的 pending_modified 状态，避免重复请求。

4. **parentChainTitles 为 null**：custom 文档是扁平结构，不在 wiki 树中。PathResolver 的 parent chain 仅对结构树文档有意义。
