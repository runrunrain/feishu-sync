# T4b 修复批 A 报告（发布链 5 项 Major：01/02/03/04/06create/07）

按 `T4b-diting-final-review.md` §复验归因与 §修复清单第 1/2/3 组（批 A 范围）修复。供 diting 按原编号复审；05/06（revert/move 部分）/08/09/10 属批 B，不在本报告。

## 逐项修复

### T4b-01 发布互斥异步准入窗口 → 已闭合

- **修复位置**：`server/src/kb/publication-service.ts` `execute()`（:842-846 检查+置位，:846-985 整体 try/finally，:984-985 持有者释放）。
- **做法**：`publishRunning` 检查与置位之间移除全部 await（检查→置位为相邻同步语句，JS 单线程下无交错窗口）；门控/`buildPlan`/planKey/confirm 校验全部移入 try，任何失败路径 finally 释放准入；`markReleaseInUse` 在计划确认后由实际持有者标记（`inUseReleaseId`），finally 按持有者释放，消除并发任务互删标记。
- **测试锚点**：`tests/kb-publication-fixA.test.ts`「T4b-01」×2。
- **反例闭合证据**：原反例（barrier 放大 buildPlan 异步窗口）下双请求双 create；现同 kbPath 并发双请求 → 单 fulfilled + 第二请求 409 `publish_in_progress`（且在第一请求计划仍进行中被拒，`secondSettledDuringPlan=true`），create 恰 1 次。确认/计划校验失败后准入释放，后续发布不卡死。

### T4b-02 第二遍互链回写绕过冲突门 → 已闭合

- **修复位置**：`publication-service.ts` `runUpdate()` 执行期时间门（每次实际 overwrite 前重新取云端时间，force 才越过）；`execute()` 第一遍/第二遍两处调用点传入同一 `force`，共用同一门；阻断落账复用 `recordBlocked`（行置 conflict，token 取实际值，防止抹掉本批新建 token）。
- **做法**：计划阶段批量取值仅用于计划决策；每次实际 overwrite（含首遍 update、首遍 skip_unchanged→第二遍 update 转换、第二遍互链回写）重新 `fetchCloudEditTimes` 与行基线 `publishedObjEditTime` 比对，前进或不可读 → 该文档 blocked + 行 conflict，**不覆盖**；重新派生批准：行 conflict 后下次计划无 force 仍 blocked，force 才升级确认值 `OVERWRITE_PUBLISHED`（run 内不沿用 PUBLISH 越过新冲突）。force（已持 OVERWRITE_PUBLISHED）越过时间门，锚点门不豁免。
- **测试锚点**：`tests/kb-publication-fixA.test.ts`「T4b-02」×3（第二遍他人修改、第一遍计划后被改、时间不可读）。
- **反例闭合证据**：原反例（A skip_unchanged + B 创建期间他人改 A → 第二遍静默覆盖）现：B created=1、A 第二遍 blocked=1（secondPass=1），零 overwrite(A)，他人正文 `OTHER USER CLOUD EDIT` 保留，A 行 conflict；`plan({force:true}).confirmRequired === 'OVERWRITE_PUBLISHED'`，无 force 仍 `publish_cloud_edited`。

### T4b-03 发布根双向校验可被通用配置绕过 → 已闭合

- **修复位置**：
  - `server/src/modules/config-manager.ts`：`ConfigManager.publishOverlapHook` + `setPublishOverlapHook()`；`updateConfig()` 在候选态组装完成、save 之前，`partial.feishuPublish` 或 `watchedRoots`/`watchedRootUrls` 变化时调用钩子（两方向两入口收敛点，所有 updateConfig 调用方统一生效）。
  - `server/src/kb/publication-service.ts`：新增 `createPublishOverlapConfigHook(getNode)`（复用 `validatePublishTargetAgainstWatchedRoots` 完整祖先链交叉验证；身份指纹未变时跳过云端解析，无关保存不触发；不可读 → `publish_target_unverifiable` 502 fail-closed）。
  - `server/src/index.ts`：注入钩子（larkCliClient.getNode）。
  - `server/src/routes/config.ts`：catch 透传 `PublicationError`（409/502），不再落入 400 config_validation_failed。专用 target 路由自身校验保留，updateConfig 钩子二次收敛。
- **测试锚点**：`tests/kb-publication-fixA.test.ts`「T4b-03」×5（真实 ConfigManager + 临时 config.json + 真实 PUT /api/config 路由）。
- **反例闭合证据**：原反例两条绕过路径均拒：①专用路由已设 T 后通用 PUT 新增 T 祖先 watchedRoot → 409 `publish_target_invalid`/`publish_target_inside_watched_root` 且不落盘（watchedRoots 仍空）；②通用 PUT 直接提交 watchedRoot 内 target → 409 且 target 不落盘。祖先链不可读 → 502 `publish_target_unverifiable`。身份未变重放 → getNode 零调用，保存成功。绕过路由直连 `updateConfig` 同样拒（收敛点在 manager 层）。

### T4b-04 发布 overwrite 未接写前历史锚点 → 已闭合

- **修复位置**：`publication-service.ts` 新增 `fetchRollbackAnchor`/`computeAnchorExact`/`safeUpdatePushLog`（与 `FeishuWriteService` P0-S3 同一原语语义：`listDocumentHistory(objToken,{pageSize:5})` 第 1 页最新条目）；`runUpdate()` 顺序为 时间门 → 取锚 → `insertSourcePushLog`（mode=overwrite、actor=`publish:<actor>`、pre_obj_edit_time、anchor 字段）→ fetchRevision → overwrite → 回读 → `outcome=pushed`。不套 source_edits 状态机。
- **做法**：无锚（history-list 空/失败）→ `refuseUpdate`：行 failed、基线保留（可重试）、云端零写入；push_log 落库失败 → 同样拒绝覆盖。force 不豁免锚点门。
- **测试锚点**：`tests/kb-publication-fixA.test.ts`「T4b-04」×3；既有 `tests/kb-publication.test.ts` stub 增补默认 `listDocumentHistory`。
- **反例闭合证据**：原反例（history-list 空替身：history 读取 0 次、overwrite 1 次、push-log 0 行）现：空 history → 0 overwrite、行 failed（lastError 含「回退锚点」）、0 push_log 行、`publishedContentHash` 保留；正常路径 → overwrite 前 `historyList` 调用先于 `overwrite`，锚点行字段（anchorHistoryId/preObjEditTime/postObjEditTime/outcome=pushed）齐备；注入 insertSourcePushLog 异常 → 0 overwrite、行 failed。

### T4b-06（create 部分）写后响应缺必要字段误判 failed → 已闭合

- **修复位置**：`server/src/modules/lark-cli-client.ts` `createDocumentMarkdown`：命令发出后缺 `document_id` → `LarkCliError(code='incomplete_response')`（retryable=false；批 B 同步加入该码，本批消费）。`publication-service.ts` 新增 `classifyCreateError`（仅 runCreate 使用）：`timeout`/`parse`/`incomplete_response` → unknown；写前校验（客户端普通 Error）→ failed；权威业务拒绝 → failed/cloud_missing（不变）。
- **效果**：unknown 后行状态 unknown，普通重发在计划层被 `blocked(state_unknown)` 拒绝（attempts 不增）；人工核对后 force 重新发布为新文档是唯一恢复通道。
- **测试锚点**：`tests/kb-publication-fixA.test.ts`「T4b-06」×3。
- **反例闭合证据**：原反例（parse → failed，普通重发 attempts=2）现：parse → unknown，普通重发 blocked（attempts=1），force 才再 create（attempts=2）；客户端缺 document_id → `incomplete_response`（非普通 Error）；`incomplete_response` → unknown，写前校验普通 Error → failed（区分成立）。

### T4b-07 旧云 token 退出快照排除集合 → 已闭合

- **修复位置**：`server/src/modules/local-map-store.ts` `listPublishedCloudTokens()`：排除全集 = 全表 `cloud_token` ∪ `warnings_json.previousCloudTokens`（TS 侧 JSON 解析，损坏 warnings_json 不影响当前 token 排除）。`publication-service.ts` 新增 `mergeWarningsJson`：`runUpdate` 成功与 `runCreate` 失败路径写 warningsJson 时并入既有谱系；`recordBlocked`/`refuseUpdate`/`runUpdate` 失败路径原样保留整串 JSON。
- **测试锚点**：`tests/kb-publication-fixA.test.ts`「T4b-07」×2。
- **反例闭合证据**：原反例（A→unknown→force 重发 B：previousCloudTokens 含 A，provider 仅含 B）现：`listPublishedCloudTokens()` 同时含旧 A 与新 B；后续 update 后 `warningsJson.previousCloudTokens` 仍含 A、排除全集仍含 A（谱系不被状态/警告更新擦除）。

## 验证

| 入口 | 结果 |
|---|---|
| `cd server && npx vitest run tests/kb-publication.test.ts tests/kb-publication-fixA.test.ts` | **2 files / 58 passed**（既有 40 零回归 + 新增 18） |
| `npx vitest run tests/config-manager.test.ts tests/config-routes.test.ts tests/local-map-store.test.ts` | 4 files / 109 passed（含上两项合计口径） |
| `npx vitest run tests/kb-build.test.ts tests/kb-build-parallel.test.ts tests/kb-build-units.test.ts tests/source-push.test.ts tests/lark-cli-client.test.ts tests/ops-command-table.test.ts` | 6 files / 199 passed |
| 根目录 `npm run typecheck`（root src + 配置 + server 三段） | 通过（exit 0） |

- 全部为真实源码 + 临时 SQLite/临时 config.json，lark 为注明 stub，零云端写入。
- 新增测试即审核附录反例 runner 的正式固化（断言安全行为，而非反例行为）。

## 变更文件与回滚

- `server/src/kb/publication-service.ts`（01/02/04/06/07 + 03 钩子工厂 + 模块头不变量更新）
- `server/src/modules/local-map-store.ts`（07 排除全集）
- `server/src/modules/lark-cli-client.ts`（06 缺 id 分类——与批 B 的 `incomplete_response` 码合流，未重复改）
- `server/src/modules/config-manager.ts`（03 钩子 + updateConfig 收敛点）
- `server/src/routes/config.ts`（03 状态码透传）
- `server/src/index.ts`（03 钩子接线）
- `server/tests/kb-publication.test.ts`（stub 增补 listDocumentHistory）
- `server/tests/kb-publication-fixA.test.ts`（新增，18 用例）
- 回滚：按上述文件清单 `git checkout -- <file>` 并删除新增测试文件即可（共享树上另有批 B 并行改动，回滚前先核对各文件归属）。

## 未覆盖与边界

- 06 的 revert/move 部分（cloud-history/cloud-move）与 05/08/09/10 属修复批 B；本批未触碰其行为。
- runUpdate 的 overwrite 写后 parse 失败仍按既有 classifyError 落 failed（06 范围限定 create；如需扩至 overwrite 写后未知，建议随批 B 复审裁定）。
- 未跑全量 server 1659 用例与前端套件（共享树有批 B 并行写入，以定向回归 + typecheck 为准；结算由 harness 隔离快照验证 npm test）。
