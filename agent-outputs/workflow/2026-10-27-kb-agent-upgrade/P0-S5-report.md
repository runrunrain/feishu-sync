# P0-S5 报告：回滚 UI —— 写回记录 / 云端历史 / 回滚弹窗 / 冲突对比

- **日期**：2026-10-29 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P0.md` §4.5（UI）；`P0-S4-report.md` §一/§二（push-log / history / history-revert preview+execute 两段流，**execute confirm = `REVERT_CLOUD:<historyVersionId>`**，202 异步起步）；`P0-S3-report.md` §四（preview `rollbackAnchor` / `anchorBlockedReason`）
- **下游消费者**：无（UI 终端切片）；Electron 真机链验收项移交主上（§五）
- **截图证据**：`agent-outputs/workflow/2026-10-27-kb-agent-upgrade/p0s5-screens/`（15 张，视觉模型逐张核验记录见 §三注）

## 一、产物清单

| 文件 | 改动 |
|---|---|
| `src/components/source-history/SourcePushLogDrawer.tsx` | **新**：写回记录抽屉——行=时间/模式（追加·覆盖·回滚）/执行者（界面·命令行·Agent）/锚点（精确·近似·无，含原因 title）/结果四态徽标（pushed 已写回·failed 失败·unknown 状态未知·conflict 冲突，另 started 过渡态）；行操作「回滚到写回前」（`rollbackRowGate` 纯函数门控：无锚/非成功写回/回滚 running 禁用并给原因；revert 成功行给「回滚到此行之前」，HP-2）；conflict/unknown 行「对比云端」入口；存在 running 行时 5s 轮询收敛（上限 10 分钟，与 server 轮询器同拍） |
| `src/components/source-history/CloudHistoryDrawer.tsx` | **新**：云端历史抽屉——条目=序号/类型徽标（1 建档·2 编辑·3 回滚快照）/时间/revision/短 id/编辑者数；**全局最新条目（第 1 页首行）「回滚到此版」禁用**（3380002 语义，title 提示）；缺省聚合 3 页，`truncated` 时「继续加载」按 nextPageToken 续翻（单页透传） |
| `src/components/source-history/HistoryRevertModal.tsx` | **新**：两段流——preview（目标版本信息 + `anchorExact` 精确性 + 警告原文 + blockedReason 阻断面全套文案）→ **confirm 输入框预填 `REVERT_CLOUD:<id>`，输入与派生值精确匹配才可执行**（改错即禁用+提示需匹配值）→ execute：202 异步态（running 徽标 + 「已轮询 N 次（每 5 秒）· 任务 id」+ 轮询 push-log 行 revertState 至终态，10 分钟上限）→ done/failed/unknown 终态面板（unknown 明示不自动重试、到飞书核对） |
| `src/components/source-history/CloudDiffModal.tsx` | **新**：冲突对比弹窗——双侧可读时行级 diff（`+` 绿/`−` 红/上下文灰、双行号列、±3 行上下文、统计徽标 +N/−M、maxRows 截断保护、两侧一致态）；**云端侧 body=null 时呈诚实不可读态**（原因原文 + 本地正文预览，见 §四契约缺口） |
| `src/components/source-history/labels.ts` | **新**：纯函数（`deriveRevertConfirmValue`/`rollbackRowGate`/`anchorFace`/`pushOutcomeBadge`/`historyTypeFace`/`canRevertHistoryEntry`/警告与阻断文案表） |
| `src/utils/lineDiff.ts` | **新**：有界行级 diff（与 server `kb/line-diff.ts` 同源算法：前后缀修剪 + LCS ≤1e6 格 + 超限整块退化 + ±3 上下文；返回带行号结构化行） |
| `src/components/SourceEditControls.tsx` | 集成：工具栏 +「写回记录」「云端历史」入口（与编辑同门槛，DocPreviewPanel/RawSourceDrawer 双宿主即得）；push 弹窗增 **rollbackAnchor 展示**（精确绿/近似红含 U23 警示原文；append 无锚降级说明行）+ `PUSH_BLOCKED_TEXT` 增 `rollback_anchor_unavailable`/`cloud_revert_running`；conflict 与 anchor-blocked 面板增「对比云端与本地」；**回滚收敛后正文重载推迟到弹窗关闭**（防 host 重载置空 content 连锁卸载弹窗——真机实测缺陷修复） |
| `src/components/common/Modal.tsx` | additive：可选 `zIndexClass`（缺省 z-50 不变）；回滚/对比弹窗传 `z-[400]` 浮于 Drawer(z-[350]) 之上（真机实测：z-50 弹窗被抽屉遮挡、按钮无法点击） |
| `src/api/client.ts` | +4 函数：`getSourcePushLog` / `getCloudHistory`（pageToken/pageSize）/ `previewHistoryRevert`（pushLogId\|historyVersionId）/ `executeHistoryRevert`（confirm 注入，202 响应体直读） |
| `src/types/index.ts` | additive：`SourcePushLogRecord`/`CloudHistoryEntry`/`CloudHistoryListResult`/`HistoryRevertPlan`(+blocked/warning union)/`HistoryRevertExecutionResult`；`SourcePushPlan` 增 `rollbackAnchor`/`anchorBlockedReason` + blockedReason union 扩 2 值（镜像 server DTO；同文件含兄弟 P1-S5/P0-S9 additive 改动，互不重叠） |
| 测试 | **新**：`lineDiff.test.ts`（10 用例）、`labels.test.ts`（11）、`CloudDiffModal.test.tsx`（3，SSR 双态）；`SourceEditControls.test.tsx` +1（入口渲染锚定） |

## 二、API 消费映射（前端 → P0-S3/S4 路由）

| UI 位置 | API | 消费字段 |
|---|---|---|
| 写回记录抽屉 | `GET /api/sources/:t/push-log` | 全行（mode/actor/anchor_*/outcome/revert_*/postRevisionId） |
| 云端历史抽屉 | `GET /api/sources/:t/history`（缺省聚合 3 页；续翻传 pageToken） | entries[].{historyVersionId,revisionId,editTime,editorIds,type} + truncated/nextPageToken |
| 回滚弹窗·preview | `POST …/history-revert/preview` body `{pushLogId}` \| `{historyVersionId}` | target.{historyVersionId,createdAt,editorIds} + source + anchorExact + warnings + blockedReason |
| 回滚弹窗·execute | `POST …/history-revert` confirm=`REVERT_CLOUD:<historyVersionId>` | 202 `{state:'running',taskId,pushLogId}` → 轮询 push-log 行 `revertState` 收敛；200 done 直读 `pull` |
| push 预览面板 | `POST …/push/preview`（既有） | 新增 `rollbackAnchor.{historyVersionId,historyTime,exact}` + `anchorBlockedReason` |

## 三、验证证据（截图 + 视觉核验）

真机浏览器（Chromium/CDP）× 前端生产构建（`vite build` 冻结码，规避兄弟任务 HMR 干扰）× 沙盒后端：`FEISHU_SYNC_HOME=/tmp/p0s5-home` 隔离 SQLite（3 文档行 + 5 行 source_push_log fixture + 2 行 source_edits）+ `LARK_CLI_PATH` 指向 fixture lark-cli（auth/metas/history 分页/revert running→done 状态机）+ 静态服务器注入 `X-Desktop-Token` 反代 3311（等价 vite dev proxy 契约）。**回滚链路全部走真实 server 代码（CloudHistoryService/轮询器/路由），仅云端子进程为 fixture**。

| # | 截图 | 内容 → 核验结论 |
|---|---|---|
| 01 | `01-docA-drawer-entries.png` | 原始文档抽屉头部 编辑/写回记录/云端历史 三入口 ✓ |
| 02 | `02-push-log-drawer.png` | 5 行：覆盖/界面/精确锚点/已写回+回滚可用；追加/cli/近似锚点/冲突+对比云端+回滚禁用；追加/Agent/无锚点(99991400)/失败+禁用；覆盖/界面/精确/状态未知+红字对账提示+对比云端；回滚行/已回滚时间+「回滚到此行之前」✓ |
| 03 | `03-push-log-after-revert.png` | 真实回滚后新增行收敛（revert 行 anchor=回滚前最新 hvA17408、revertState=done、已回滚时间戳）✓ |
| 04 | `04-cloud-diff-unavailable.png` | 对比弹窗（conflict 行入口）：云端暂不可读警示+原因原文+本地正文 9 行预览+关闭按钮 ✓ |
| 05 | `05-revert-modal-preview.png` | 回滚弹窗 preview：入口标签/目标版本 id·时间·编辑者/锚点精确性「精确」/预填 `REVERT_CLOUD:hvA14336`/确认按钮可用 ✓ |
| 06 | `06-revert-confirm-wrong-disabled.png` | 输入 `REVERT_CLOUD:wrong-id` → aria-invalid 红框 +「需要精确匹配」提示 + 按钮禁用（eval 复核 disabled=true）✓ |
| 07 | `07-revert-running.png` | execute → 202：running 徽标 +「已轮询 0 次（每 5 秒）· 任务 task-p0s5-1」+ 异步说明 ✓ |
| 08 | `08-revert-done.png` | 轮询收敛：✔ 回滚完成 + Toast「云端回滚完成」，面板驻留可读（延迟重载修复后）✓ |
| 09 | `09-cloud-history.png` | 云端历史 15 条（聚合 3 页）：首行「· 最新」回滚禁用、其余可用、05 行「回滚快照」徽标；「继续加载」在折叠线下方（DOM 存在且实测点击 15→17 条）✓ |
| 10/11 | `10/11-revert-from-history-*.png` | history 源两段流：preview「指定历史版本」徽标 → execute → done ✓（与 push_log 源路径各自走通） |
| 12 | `12-push-preview-anchor.png` | 文档 B push 预览：追加+冲突警示 + ⚓「写回锚点 hvB3072（…）：近似，回滚点早于写前状态，回滚会一并撤销此期间的云端修改」✓ |
| 13 | `13-push-blocked-anchor.png` | 文档 C：暂不能写回 + rollback_anchor_unavailable 文案 +「对比云端与本地」按钮 ✓ |
| 14 | `14-cloud-diff-from-blocked.png` | anchor-blocked 入口的对比弹窗（不可读态）✓ |
| 15 | `15-cloud-diff-both-readable-ssr.png` | 组件 SSR（真实编译 CSS）：+2/−2 行绿红高亮、双行号、±符号列，逐字转写与 fixture 一致（`v1 起自定义归档参与变更检测…` 等）✓ |

**视觉模型核验**（amagi-media-understanding，glm-5.3-flash）：15 张逐张核验两轮——首轮发现 04/05/06 弹窗被抽屉遮挡（修复前构建的截图，即 §一 zIndexClass 缺陷），修复重截后二轮**全部通过**：弹窗居中顶层、遮罩正确覆盖抽屉、无重叠/截断/乱码。遗留观感建议（非缺陷）：历史行禁用按钮对比度可再强化（与全站禁用样式一致，未单独改）。

**自动化**：`npm test` 313/313 全绿（37 文件；含兄弟 KbPublishModal 中间态已被其自愈）；`npx tsc --noEmit -p tsconfig.json` exit 0；server 段 `tsc --noEmit` exit 0；eslint（全部触面）exit 0。

## 四、契约缺口（如实上报，未在呈现端补假数据）

- **「对比云端当前」的云端正文通道未交付**：设计 §4.5 指定服务端只读 fetch 正文（`fetchDocumentMarkdown`）+ line-diff；P0-S4 未暴露对应 HTTP 路由（全 routes 面检索确认）。前端已就位：diff 引擎（真实算法+单测）+ 弹窗双态渲染 + 全部触发点接线；当前真实数据下弹窗呈「云端正文暂不可读」诚实态（截图 04/14），双侧 diff 形态以 SSR 截图 15 + 单测为证。**建议**：后端补 `GET /api/sources/:objToken/cloud-body`（复用 fetchDocumentMarkdown + ContentAdapter 转换，只读），前端仅需把 `openCloudDiff` 的 `cloud.body` 从 null 换为该 API 结果，弹窗即刻产出真实差异。
- CloudDiffModal SSR 快照生成于补「关闭」按钮前；关闭按钮已由真机截图 04 二轮核验覆盖。

## 五、待真机清单（依赖主上环境，按任务书标注）

1. **Electron 真机链**：真实测试文档「写回 → 写回记录出现锚点行 → 回滚 → 本文档回拉正文恢复」端到端（本轮以真实 server 代码 + fixture 云端验证至 UI 收敛；真实 lark-cli 云端行为未覆盖）。
2. **真实 lark-cli history 分页形态**（fixture 按探测报告形态模拟；HP-1 字段名双读已由 S2 覆盖，UI 不再解析原始输出，风险低）。
3. **overwrite 无锚 blocked / 冲突 409 的真实云端时序**（本轮由 fixture metas 时间驱动，语义同 S3/S4 服务端单测）。
4. 窄视口（<620px 抽屉 94vw）与超长正文（>40 行预览截断）仅覆盖组件内建截断逻辑，未做窄屏真机截图。

## 六、撞写记录 / 共享树备注

- **并行 HMR 干扰**：验收中途兄弟任务热更新 `KbPublishModal.tsx`/`index.css` 导致 dev 页面重置——改为生产构建 + 自建静态代理（注入 X-Desktop-Token，等价 vite dev proxy）冻结验证面；不影响代码改动。
- `src/types/index.ts` 与兄弟（SyncConfig/optionalScopes 等）同文件 additive 并存，tsc 通过；`KbPublishModal.test.tsx` 中间态红已由兄弟自愈（终跑 313/313 绿）。
- `Modal.tsx`/`api/client.ts`/`SourceEditControls.*` 会话起点无未提交改动，diff 为本任务独立写入。

## 回滚方式

改动集中：新文件×8（source-history/ 6 + lineDiff 2）+ 4 文件纯增量块（SourceEditControls 集成段、Modal zIndexClass、client 4 函数、types P0-S5 段）+ 测试×2 新×1 增。按共享树纪律以精确 diff 反向恢复即可；无后端/表结构/配置变更；`zIndexClass` 缺省值保持全站既有 z-50 行为不变。
