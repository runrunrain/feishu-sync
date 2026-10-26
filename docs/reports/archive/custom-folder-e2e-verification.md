# 自定义归档文档同步状态跟踪 — 真实端到端实测报告

日期：2026-08-12 ｜ 执行：洛神（designer）｜ 环境：server src 直跑 127.0.0.1:3002（desktopMode=false, corsDevMode=true）+ vite 5174（BACKEND_PORT=3002 代理）+ 真实 ~/.feishu-sync 库 + 真实 lark-cli 1.0.72（user 已认证）

## 测试数据

- 归档文件夹：`E2E-CustomSync-Test`（id `adab1319-f8f7-4e78-a349-57ba8d4e2c36`，已清理）
- 文档A：wiki `AuFIwS3hVixPLAkCuhlc6JL2ndc` / obj `LCdgdFVgEo58srx61KWcrFvyngb`（API 路径实测）
- 文档B：wiki `OxeHwehHJioMeDkSLtZcJVdinKb` / obj `U7L7dXnR9oTiJkx48I5cHi3Rnch`（UI 路径实测）
- 对照：文档B 在 step3 检测时未修改，确认不误报
- 干扰项：demo需求 文件夹下 `NHp4dZWgjom0iOxP15ycqjREngh` 本身有真实云端变更（30+ 分钟前），全程作为既有变更存在，不影响断言

## 逐项结果

| # | 步骤 | 结果 | 证据 |
|---|------|------|------|
| 1 | 添加真实 docx 到自定义归档文件夹 | PASS（wiki 链接）；纯云文档 /docx/ 链接 FAIL（见问题1） | POST /api/custom-folders/:id/docs 两个 wiki 链接均 ok；落盘 `_custom/E2E-CustomSync-Test/*.md`；DB custom_folder_id 正确、observed=synced=1786530658/663 |
| 2 | 真实修改云端内容 | PASS | lark-cli docs +update overwrite 成功（revision 4），wiki +node-get obj_edit_time 1786530658→1786530692 |
| 3 | POST /api/detect/changes-all (fast) | PASS | changedDocuments 含文档A，changeType=modified，observedObjEditTime=1786530692，syncState=pending_modified，customFolderId 正确；文档B（未改）不出现（/tmp/e2e-detect1.json） |
| 4 | GET /api/mapping/diff（cached=1 + 实时） | PASS | 两种模式 modified 列表均含文档A、不含文档B（/tmp/e2e-diff-cached.json、/tmp/e2e-diff-live.json） |
| 5 | POST /api/sync（apply+APPLY） | PASS | 本地 md 含 v2 新段落；last_synced_modify_time 头更新；synced_obj_edit_time 推进到 1786530692；status/sync_state=synced；custom_folder_id 保留；feishu_pending_items 0 行；plannedDocuments action=replace（/tmp/e2e-sync-resp.json） |
| 6 | 同步后再次检测 | PASS | 文档A/B 均不再出现；仅剩既有 demo需求 变更 |
| 7 | 前端浏览器走查 | PASS（修复一个去重 bug 后，见问题2） | 总览归档分组正常展示 3 个文件夹及文档（/tmp/e2e-overview-archive.png）；UI 点「立即检测」→ 变更列表出现文档B → 勾选 → 开始同步 → 确认对话框 → 「同步完成 1 成功 / 0 失败 · 688 ms」（/tmp/e2e-changelist-after-sync.png）；文档B 落盘含 v2 内容、DB synced 推进 |
| 8 | 清理测试数据 | PASS | DELETE /api/custom-folders/:id ok；本地目录已删；documents 2 行已删；云端 wiki 节点 A/B 已 +node-delete；step1 产生的 2 个游离 docx 已 drive +delete；最终检测无测试文档残留 |

## 发现的问题

### 问题1（后端，真实链路 bug，未改代码）：纯云文档 /docx/ 链接归档的 131005 回退失效

`POST /api/custom-folders/:id/docs` 对不在任何 wiki 空间的纯云文档链接（`feishu.cn/docx/<token>`）返回 `fetch_failed`。

- 设计意图：`custom-folders.ts` processOneLink 捕获 getNode 的 131005（not-in-wiki）后走 parseCloudDocUrl 回退。
- 实际失效原因：`lark-cli-client.ts execLarkCli` 中 lark-cli 进程**非零退出**时走 catch 分支，`classifyError(rawMessage)` 不带 upstreamCode（131005 只存在于 stdout 的错误 JSON 里，未被解析），因此路由侧 `error.upstreamCode === '131005'` 永远为 false，回退分支不可达。单测应该是 mock 了带 upstreamCode 的 LarkCliError，没覆盖真实进程退出路径。
- 建议：非零退出时先对 error.stdout 尝试 parseJsonOutput/normalizeJsonResult 提取 code，再 fallback classifyError。
- 实测证据：step1 两个 /docx/ 链接均报 `fetch_failed: lark-cli 执行失败：... "code": 131005, "message": "not found: document is not in wiki"`。

### 问题2（前端，已直改）：多 watchedRoot 下归档文档在变更列表/待同步计数重复 N 倍

后端把 custom modified 并入**每个** root 的 stored diff（4 个 root → 同一文档返回 4 份），前端两处按 root fan-out 后只做 concat/sum：

- `src/components/ChangeListPanel.tsx` fetchMultiRootDiff：变更列表出现 4 条相同文档（截图修复前 "共 8 项变更" = 2 文档 × 4 root）。
- `src/hooks/useSyncStatus.ts`：状态栏「待同步 8」同因。

修复：两处均按 objToken 去重（fallback key `title:localMdPath`）。修复后变更列表 "共 2 项变更"、状态栏「待同步 2」，与 detect 实际结果一致。typecheck 通过（仅存 2 个历史遗留报错，与本次无关）。

### 观察项（非 bug）

- 同步完成后 GlobalStatusBar「待同步 2」短暂滞后于变更列表（1 项），下一次 refreshTick/轮询后自愈；最终态一致（待同步 1）。
- 归档的 wiki 文档 `watched_root_url`/wikiNodeToken 正确置空，飞书视图结构树不重复出现，归档分组单独展示。

## 环境备注

- 3002 dev server 与 vite 5174 仍在后台运行（日志 /tmp/feishu-server-3002.log、/tmp/vite-5174.log）；3001 是用户正在运行的 Electron 应用，未触碰。
- 用户 Electron 应用与本测试共用同一 ~/.feishu-sync 库，测试期间未观察到锁冲突。
