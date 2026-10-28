# T4b 修复批 B 报告（05 / 06(revert,move) / 08 / 09 / 10）

修复来源：`T4b-diting-final-review.md` §复验归因（T4b-05/06/08/09/10）与 §修复清单第 4/5/6 组（lark-cli-client 部分）。批 A（01/02/03/04/06-publication/07）不在本批；共享文件 LMS/lark-cli-client 编辑前均重读（批 A 区域为 kb_publications 访问器 3486+，本批区域为 cloud_moves 访问器与 insertSourcePushLog，无交叠）。

## 逐项修复

### T4b-05 移出 unknown 即释放围栏 → unknown 持续围栏 + 权威核对解除

- **修复位置**
  - `server/src/modules/local-map-store.ts` `getActiveCloudMove`：状态集 `('pending','moving')` → `('pending','moving','unknown')`——四方（source-edit / feishu-write / cloud-history / cloud-move 自身）共用同一围栏解释，不各自猜测。
  - `server/src/sources/cloud-move-service.ts` 新增 `reconcileUnknownMove(moveId)`（唯一解除入口）：有 task_id → `getDriveTaskResult`（done→moved；failed→failed 释放；running/查询失败→保持 unknown）；无 task_id → `getNode` 查节点归属（仍在树且 obj_token 一致→failed 释放=权威证明未移出；查不到/归属不一致→保持 unknown，不猜）。状态写走 criticalUpdate（写失败行保持 unknown 围栏）。
  - 消息面（`source-edit-service.ts` / `feishu-write-service.ts` / `cloud-history-service.ts` / `cloud-move-service.ts`）：cloud_move_running 文案改为「进行中或结果未知…请先权威核对」；`src/components/move-out/labels.ts` 同步（cloud_revert_running 文案不变——revert unknown 释放互斥是既有设计语义）。
  - 路由：`server/src/routes/feishu.ts` 新增 `POST /api/sources/moves/:moveId/reconcile`（解除 200 / 无法证明 202）。
- **测试锚点**（`server/tests/cloud-move.test.ts` §G）
  - 「unknown（timeout 反例）：二次移出拒 409（单次 fulfilled）」——审核 E05 反例闭合：原实现 move 2 次，现 `move 调用数=1` + 409 + preview blocked。
  - 「unknown 期间三消费方 409」——编辑/放弃修改/写回/回滚预览与执行全部 `cloud_move_running`。
  - 权威核对四分支（done→moved+检测、failed→释放+可重新移出、running→保持、无 taskId 节点仍在→释放 / 查不到→保持）+ 路由 200/202。
- **未覆盖**：真实飞书 getNode/task_result 的核对形态（S5 实测窗口，与 C-1~C-5 同批待校正）。

### T4b-06（revert/move 部分）写后解析失败误判 failed → 未知信号

- **修复位置**
  - `server/src/modules/lark-cli-client.ts`：`LarkCliErrorCode` 尾部追加 `'incomplete_response'`（未知类，retryable=false）。`revertDocumentHistory` / `moveWikiNodeToDrive`：命令已发出后**缺 status/state 键、或异步形态缺 task_id**（无法轮询收敛）→ 抛 `incomplete_response`（非「明确失败」）；`createDocumentMarkdown` 缺 `document_id` 由普通 Error 改抛 `incomplete_response`（审核定位 :900-908；上层 publication 分类由批 A 消费）。
  - `cloud-history-service.ts` revertLocked catch：unknown 判定 `timeout → timeout|parse|incomplete_response`；`cloud-move-service.ts` moveToDriveLocked catch 同。
  - 与写前校验/权威业务拒绝的区分：本地预校验在 CLI 调用前抛（CloudHistory/CloudMoveError）；3380002/10020/permission 等权威拒绝仍 failed（可重新发起）。
- **测试锚点**
  - `cloud-history.test.ts` §H：revert parse → 行 unknown + 502 revert_outcome_unknown + 单次执行 revert 调用=1（不重发；revert unknown 后用户核对再手动重试是 §4.4 既有语义，与 move unknown 围栏不同，测试注释已锚定）；3380002 → failed。
  - `cloud-move.test.ts` §G：move parse → unknown + 二次移出 409（move 调用=1）；permission → failed + 环境恢复后可重新发起。
  - `lark-cli-client.test.ts` 新 describe：revert/move 缺 status/异步缺 task_id、create 缺 document_id → `incomplete_response` retryable=false；合法形态（done / running+task_id）不受影响。
- **既有测试同步**：`cloud-move.test.ts` 原「双读解析」用例断言异步缺 task_id → running/null（旧契约），改为断言 incomplete_response。

### T4b-08 对比云端当前正文消费链未闭合 → 真实接入

- **修复位置**
  - `server/src/routes/feishu.ts`：`GET history-content` 的 `revisionId` 改为**可选**——缺省=云端当前正文（不带 `--revision-id` 的最新版）；显式 revisionId 行为不变。
  - `server/src/sources/cloud-history-service.ts` `fetchCloudRevision(objToken, revisionId: number | null)`：null → 当前正文，响应 `{revisionId: null, content}`。
  - `src/api/client.ts` 新增 `fetchCloudContent(objToken, {revisionId?})`。
  - `src/components/SourceEditControls.tsx`：`openCloudDiff` 由固定 `cloud.body=null` 改为真实拉取——导出 `buildCloudDiffContext`（先开弹窗呈读取中态，拉取完成回填两侧行级 diff；**只有真实失败才降级**为不可读态并如实展示错误码与消息）。
  - `src/components/source-history/CloudDiffModal.tsx`：`CloudDiffSide` 增 `loading`，读取中态与不可读态分离。
- **测试锚点（消费者级，宿主发起请求断言）**
  - `src/components/SourceEditControls.test.tsx`：stub `globalThis.fetch` 走**真实 client.request 请求路径**，断言发出的 URL 精确为 `/api/sources/doxcnT1/history-content`（**不含 revisionId**=当前正文）+ 两侧真实正文回填；502 → 降级含服务端错误码/消息、本地侧保留；fetchImpl 注入面。
  - `CloudDiffModal.test.tsx`：loading 态 SSR（不误报不可读、不渲染假 diff）。
  - `cloud-history.test.ts` §H：service null→opts 无 revisionId；路由缺省→200 `{revisionId:null}` / 显式→透传 / 非数值→400。
- **未覆盖**：真机浏览器/Electron 点击交互与视觉（仓库红线要求真机验证，本轮以宿主级 fetch 断言替代手工喂串，真机留待收口轮）。

### T4b-09 anchorExact 云端时间误除以 1000 → 统一秒级口径

- **修复位置**：`feishu-write-service.ts` 导出纯函数 `computeAnchorExactSeconds`（ISO 毫秒 ≥ 秒值 latestModifyTime；早 1 秒=false、相等=true、任一侧不可读/非有限=false），私有 `computeAnchorExact` 委托（写回链两处调用点行为不变）；`cloud-history-service.ts` revertLocked 改用该函数（原 `Math.floor(preCloudTime / 1000)` 秒值再除 1000 的误判删除）。
- **测试锚点**：`cloud-history.test.ts` §H——审核反例锚点 02:00:00Z：cloudTime=锚点+1 秒 → `anchorExact=false`（原实现 true）；相等 → true；cloudTime 不可读 → false。写回链 source-push 既有用例零回归。

### T4b-10 互斥状态更新被吞错 → fail-closed + 可靠对账

- **修复位置**
  - `local-map-store.ts` `insertSourcePushLog` 增可选 `revertState:'running'`：revert **起步即落围栏**（命令发出前落盘；insert 抛错→零云端调用=「写不进 running 就不放行执行」）；其余调用方缺省 NULL 行为不变。
  - `cloud-history-service.ts`：新增 `criticalUpdate`（异常与 false 返回都不按成功处理，审计 `history_revert_state_persist_failed`）；taskId/终态写失败→行保持 running 围栏 + 进程内轮询照常 + 响应携带 `persistWarning`；轮询 finalize（done/failed/unknown）写失败→**不删 tracked，下轮重试**，且终态写回填 `revertTaskId`；resumeRunningReverts 的 unknown 标记写失败→不计入已收敛（行保持 running，fail-closed）。
  - `cloud-move-service.ts`：pending 起步行本就是命令前围栏；moving/taskId 与终态写全部 critical 化（写失败行保持 pending/moving 围栏 + persistWarning + 审计 `move_to_drive_state_persist_failed`）；finalize 回填 taskId（重启后 reconcile 仍可查=「不丢 taskId」）；resumeRunningMoves 同口径。`safeUpdate` 已删除（cloud_moves 无 best-effort 状态写）。
- **测试锚点**
  - `cloud-history.test.ts` §H：running/taskId 写入注入异常 → 结果 running + persistWarning + **getRunningRevertPushLog ≠ null（围栏不丢，审核 E10 反例闭合）** + 新回滚 409 + 写回 409；恢复后轮询收敛 done + task_id 回填 + 回拉。轮询终态落盘失败 → 行保持 running，恢复后收敛 failed。
  - `cloud-move.test.ts` §G：moving/taskId 写入注入异常 → 行保持 pending 围栏、二次移出 409、persistWarning 含「task_id 落盘失败」；恢复后轮询收敛 moved（taskId 回填）+ 检测触发。轮询终态写失败 → tracked 保留重试收敛。
- **既有测试同步**：两处轮询审计序列断言补入新事件 `history_revert_moving`（T4b-10 显式上报的一部分）。

## 验证

| 入口 | 结果 |
|---|---|
| `server` vitest：cloud-history / cloud-move / source-edit / source-push / lark-cli-client / local-map-store | **6 files / 260 passed**（审核基线 229 + 新增 31） |
| `server` vitest：kb-publication / cli-client / cli-args / ops-command-table / sync-safety / custom-folders | **6 files / 163 passed**（createDocumentMarkdown 错误类型变更零回归） |
| 根 `npx vitest run src/components` | **25 files / 241 passed** |
| 根 `npm test`（harness 结算基线） | **349 passed** |
| `npm run typecheck`（根 src+配置+server 三段） | EXIT=0 |
| `npx eslint`（全部触碰文件） | EXIT=0 |

任务指定既有 cloud-history/cloud-move/source-push/source-edit 测试零回归 ✓（source-edit/source-push 未改断言全绿；改动断言仅上文明示的三处，均为新契约的必要同步）。

## 边界与未覆盖

- 未做真机浏览器/Electron 交互与视觉验证（T4b-08 前端面以宿主级 fetch 断言闭合功能链；视觉/交互留收口轮）。
- reconcile 的真实云端核对形态（getNode/`drive +task_result`）沿用【待 S5 实测校正】的 client 契约，与 C-1~C-5 同批。
- 全量 server 套件未跑（共享树批 A 并行写 publication-service，避免误报其中间态；定向+相邻面已覆盖本批写面）。
- 回滚：本批改动均为工作区未提交修改，`git checkout -- <上述文件>` 可逐文件回退（共享树纪律：不执行，交 Leader）；新增测试/报告文件直接删除即可。
