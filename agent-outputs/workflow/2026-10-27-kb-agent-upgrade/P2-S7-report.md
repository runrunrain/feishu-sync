# P2-S7 报告：移出 UI（右键入口 + 输入确认弹窗 + 状态文案）

任务书：文档树/详情既有 UI 追加，沿用现有组件模式（参考 P0-S5 回滚弹窗两段流）；消费 P2-S6 四端点。
代码基线 `feat/agent-knowledge-workbench` 工作区（共享树并行任务在途，本切片改动面见下）。

## 产物清单（验收 → 位置）

| 验收 | 位置 |
|---|---|
| 类型镜像（MoveOutPreview / MoveOutExecutionResult / CloudMoveRecord / CloudMoveBlockedReason） | `src/types/index.ts`（P2-S7 段） |
| API 四函数（previewMoveToDrive / executeMoveToDrive / getCloudMove / listCloudMoves） | `src/api/client.ts`（P2-S7 段） |
| 纯函数与文案（确认值派生 / 八分支 blocked 文案 / 状态徽标 / cloudMoveFace 展示层 join / isMoveOutEligible 菜单层资格） | `src/components/move-out/labels.ts`（新） |
| 两段确认弹窗（preview → 确认值精确匹配门控 → 执行 → 202 moving 轮询收敛；哑面板导出供 SSR） | `src/components/move-out/MoveOutModal.tsx`（新） |
| 移出记录列表（时间/状态/失败原因/unknown 引导） | `src/components/move-out/CloudMovesSection.tsx`（新） |
| 右键菜单「移出到云空间…」项（仅 target.moveOutEligible 显示） | `src/components/SourceNodeMenu.tsx` |
| 树徽标展示层覆盖（moved 覆盖「已删除」→「已移出」；moving →「移出中」） | `src/components/TreeNode.tsx`（cloudMoveFace prop） |
| 右键入口本地资格判断 + latestMoveByToken 接线 + custom docs 显式非资格 | `src/components/NodeTreeView.tsx`（openNodeMenu / renderNode / SourceNodeMenu 挂载） |
| 详情卡状态徽标「已移出到云空间」+ 移出记录区 | `src/components/NodeDetailCard.tsx`（cloudMoves prop） |
| 数据接线（cloudMoves 拉取 / movesByToken / moveOutTarget / onMoved 收敛刷新；旧 server 404 静默兼容） | `src/views/Dashboard.tsx` |
| 验收工具（fixture mock server，含异步收敛状态机） | `amagi-task/p2-s7/mock-server.mjs`（临时，非正式产物） |
| 测试（32 用例：labels 21 + Modal 哑面板 8 + 树/列表呈现 8，SSR+纯函数） | `src/components/move-out/labels.test.ts` / `MoveOutModal.test.tsx` / `move-out-present.test.tsx`（新） |
| 真机浏览器截图证据（17 张） | `amagi-task/p2-s7/shots/` |

## API 消费映射（P2-S6 四端点 → UI）

| 端点 | 消费方 | 用途 |
|---|---|---|
| `POST /api/sources/:objToken/move-to-drive/preview` | MoveOutModal.loadPlan | 权威 wikiNodeToken（确认值派生源）+ 门控面 + consequences 固定文案原样展示 |
| `POST /api/sources/:objToken/move-to-drive` | MoveOutModal.doExecute | confirm=`MOVE_OUT:<nodeToken>` 精确匹配门控（本地 disabled + 服务端 400 双层）；202 → moving 态 |
| `GET /api/sources/moves/:moveId` | MoveOutModal.pollMoveState | 202 异步收敛轮询（5s 同拍，10 分钟上限；pending/moving 续轮，moved/failed/unknown 终态呈现） |
| `GET /api/sources/moves?limit=` | Dashboard.loadCloudMoves | 展示层 join 数据源：latestMoveByToken（树徽标）/ movesByToken（详情列表）；onMoved 后刷新 |

- 状态机映射（S6 命名）：pending/moving →「移出中·loading」徽标；moved →「已移出·success」（树内紧凑「已移出」，详情「已移出到云空间」）；failed →「移出失败·error」+ error 文案；unknown →「移出未知·neutral」+ 引导「到飞书知识库核对…核对后只读刷新」（MOVE_OUT_UNKNOWN_GUIDE，P2-S6 语义：不自动重试）。
- 八分支 blockedReason 可读文案（MOVE_OUT_BLOCKED_TEXT）：not_watched_root / has_children / node_not_found / local_edit_pending / cloud_revert_running / cloud_move_running / kb_build_active / source_not_found（查询期 404）；文案与 server CloudMoveError message 同义，未知分支回落原码不吞语义。
- 入口可见性本地判断（isMoveOutEligible）：wiki_node_token 非空 ∧ has_child≠true ∧ 本地子行数 0（菜单层先判，服务端八分支兜底）；归档文档 custom docs 右键 target 显式 moveOutEligible=false。

## 真机浏览器验收证据（agent-browser + mock server，vite :5199 → mock :3011）

| 验收点 | 截图 | 证据摘要 |
|---|---|---|
| 入口可见性·叶子 | `01-leaf-context-menu.png` | 右键「需求文档A」菜单三项：删除/屏蔽/**移出到云空间…**（视觉核验✓） |
| 入口可见性·非叶子 | `02-parent-context-menu.png` | 右键父节点菜单仅删除/屏蔽，无移出项（DOM grep=0） |
| 入口可见性·归档文档 | `03-archive-context-menu.png` | 右键归档散文档 J 菜单无移出项（DOM grep=0） |
| 两段流·preview | `04-preview-modal.png` | 文档名/所属知识库/目标=个人空间根/节点 token/不可逆徽标 + consequences 5 条（4 条 server 固定文案 + UI 补充「移出后不再同步，本地文件与标准库保留不动」）；预填 `MOVE_OUT:wikinfChildA11`（视觉核验✓逐字一致） |
| 确认值门控·不匹配 | `05-confirm-gate-mismatch.png` | 改为 `MOVE_OUT:wrong` → 按钮 disabled=true + 「需要精确匹配：MOVE_OUT:wikinfChildA11」（视觉核验✓置灰态确认） |
| 确认值门控·匹配 | `06-confirm-gate-match.png` | 恢复预填值 → disabled=false 可执行 |
| 202 异步态 | `07-executing-moving.png` | 「移出执行中」loading 徽标 + 已轮询 0 次（每 5 秒）· 任务 task-live-1 + mv_live1 说明 + Toast（视觉核验✓） |
| 轮询收敛·moved | `08-converged-moved.png` | mock 第 3 次查询收敛 → 「已移出到云空间」+ 完成时间 + 本地保留说明（视觉核验✓） |
| moved 后·树徽标 | `09-tree-moved-badge.png` | 关弹窗触发 onMoved → 刷新树，「需求文档A」行徽标「已移出」（区分于「已删除」） |
| moved 后·详情呈现 | `10-detail-moved-status.png` | 旧文档 I：详情徽标「已移出到云空间」+ 移出记录（1）行：已移出/时间/界面→个人空间根（视觉核验✓逐字） |
| 八分支 blocked | `11-blocked-*.png`×7 | has_children/local_edit_pending/kb_build_active/not_watched_root 视觉核验逐字✓；cloud_revert_running/cloud_move_running/node_not_found 走查过（wait「暂不能移出」）+ 文案由单测锚定；blocked 面板无确认输入/无执行按钮（视觉核验✓） |
| 树内多状态徽标同屏 | `12-tree-badges.png` | 移出中/移出未知/移出失败/已移出 四态 DOM 证据：`doxcnBlkMoving→移出中 ; doxcnBlkNotFound→移出未知 ; doxcnBlkEdit→移出失败 ; doxcnMovedOld→已移出` |

视觉核验方法：amagi-media-understanding（8 张关键截图逐字转写，含 disabled 置灰态）；其余以 agent-browser snapshot/DOM 断言 + SSR 单测锚定。

## 验证记录

- `npm test`（根 vitest 全量）：**345/345 通过**（含本切片新增 32 用例：八分支文案八键断言、确认值派生、cloudMoveFace 五分支、isMoveOutEligible 叶子/非叶子/归档、哑面板 blocked/门控/四终态、TreeNode moved 覆盖「已删除」回归、CloudMovesSection 时间/状态/失败原因/unknown 引导）。
- `npm run typecheck`（根三段 tsc --noEmit）：退出 0。
- `npx eslint`（改动面 8 文件）：退出 0（1 warning 为 NodeTreeView.tsx:317 既有 exhaustive-deps，本切片 diff 未触碰该 effect，git hunk 核对）。
- 修复记录：MoveOutModal mountedRef 在 StrictMode 双挂载（dev）下首次 cleanup 置 false 后不恢复 → loadPlan 的 then 守卫永久吞掉 setPlan 卡 loading；修为 effect 重跑时恢复 true（真机浏览器实测复现→修复→复验通过）。

## 待真机清单（Electron + 真实飞书，超出本切片 mock 验收面）

1. 真实 preview 的 consequences 文案来自 server `moveOutConsequences()`（mock 为同义副本）；真实 watchedRootLabel 取 config localDir。
2. 真实 202 异步链：lark-cli 任务号 + server 轮询器落库节奏（C-1/C-2 校正点依赖 P2-S5 实测）；UI 轮询只读收敛，不依赖具体 task 形态。
3. moved 后检测链收敛：下一次检测将 cloud_deleted=1，树徽标从 moves join 切换为「已删除→已移出」覆盖路径（mock 下以 moves join 验证；真实链路含 ChangeDetector 时序）。
4. Electron 生产窗口（desktop token 注入路径）——本验收为浏览器 dev（vite proxy），token 面未覆盖。
5. 移出后编辑/写回入口拒绝 `source_moved_out`/`cloud_move_running` 的 UI 呈现（SourceEditControls 面，P2-S6 服务端已挂门，前端提示文案消费未在本切片范围）。

## 未覆盖项 / 风险

- HistoryRevertModal（P0-S5 参考组件）存在同构 StrictMode mountedRef 缺陷（dev 双挂载卡 loading；生产不受影响）——本切片未顺手改（改动面最小），建议后续切片统一修复。
- moves 列表拉取上限 200 条（listCloudMoves limit）——超出规模的用户需按文档过滤（详情列表按 objToken 精确过滤，树徽标取每文档最新一条，规模风险低）。
- mock server（amagi-task/p2-s7/）为临时验收工具，未纳入正式 scripts；复跑方式见 mock-server.mjs 头注释（`node amagi-task/p2-s7/mock-server.mjs 3011` + `BACKEND_PORT=3011 npx vite --port 5199`）。
- 回滚方式：本切片全部为前端增量（1 个新目录 + 7 个文件追加式改动 + Dashboard 接线），`git checkout -- <文件>` / 删除 `src/components/move-out/` 即回滚；无数据迁移。
