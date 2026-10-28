# P2-S6 报告：安全移出服务（wiki move-to-drive，人工限定）

任务书：CLI 方法 + `cloud_moves` 表（LMS additive 双登记）+ `cloud-move-service.ts`（门控/流程/轮询/对账）+ 路由与三条命令（`cloud.move_to_drive` / `cloud.move_status` / `cloud.moves`，全部 `agentExposed=false`）+ 测试。mock 驱动先行——真实 CLI 输出形态待 P2-S5 实测后校正。

## 产物清单（验收 → 位置）

| 验收 | 位置 |
|---|---|
| CLI 方法 `moveWikiNodeToDrive(nodeToken, {folderToken?})` | `server/src/modules/lark-cli-client.ts`（类尾追加，含 `WikiMoveToDriveResult`） |
| CLI 轮询方法 `getDriveTaskResult(taskId)`（probe §9：`drive +task_result` 覆盖 wiki move 任务） | 同上（含 `DriveTaskResult`） |
| 表 `cloud_moves`（双登记：`initialize()` 建表段 + `getCreateTablesDDL()`；索引 `idx_cloud_moves_token`） | `server/src/modules/local-map-store.ts` |
| 访问器（insert/get/update/list + 互斥门源 `getActiveCloudMove`/`getLatestCloudMove` + 对账 `listMovingCloudMoves`/`listPendingCloudMoves`） | 同上（source_push_log 访问器区后） |
| 行类型 `CloudMoveRecord`（LMS 模块级导出，P1-S3 `SourceReferenceRow` 先例；types/index.ts 未动） | 同上 |
| 服务 `CloudMoveService`（门控/preview/执行/轮询器/重启对账/审计/检测收尾） | `server/src/sources/cloud-move-service.ts`（新文件） |
| 互斥门消费方（cloud_move_running / source_moved_out） | `source-edit-service.ts`（edit/revert 各一门）、`feishu-write-service.ts`（push 409 + preview blocked）、`cloud-history-service.ts`（回滚发起门 `cloud_move_running`） |
| 路由四端点 | `routes/feishu.ts`（P2-S6 段：preview / 执行 200·202 / moves/:moveId / moves 列表） |
| 单例接线（构造 + 启动对账 + 轮询器 + DI 注入 + close 停轮询 + moved 收尾接 `changeDetector.detectChanges(root.url, {forceFresh:true})`） | `server/src/index.ts` |
| 命令表三条（`cloud.move_to_drive` destructive+confirm+confirmPlan；后两条 read；三条 agentExposed=false） | `server/src/ops/command-table.ts` |
| 测试（33 用例） | `server/tests/cloud-move.test.ts`（新文件） |

## 设计要点与裁定

- **状态机命名**：任务书 `pending→moving→moved/failed/unknown`（与设计 §3.3/§3.6 的映射：pending=started / moving=running / moved=done），CHECK 约束封闭集合。注释与测试双处标注映射。
- **门控**（§3.1/§3.4）：`not_watched_root`（归档/无 wiki 身份，422）→ `kb_build_active` → `local_edit_pending`（dirty/pushing/conflict）→ `cloud_revert_running` → `cloud_move_running` → 实时 `getNode`（`node_not_found`/`has_children`）。**未挂 feishuWrite.enabled/写 scope 门**（见待校正点 C-3）。
- **confirm 值含 node token**：完整值 `MOVE_OUT:<wikiNodeToken>`（服务端按 documents 行权威派生）；CLI 内部转发（actor=cli）接受基值 `MOVE_OUT`——CLI 已过本地 --yes 门（退出码 4）+ `/api/cli/:command` 422 门双重显式确认，服务端升级不降低强度；UI 直调必须传完整值（`cloud.revert` 先例同构）。
- **流程**：锁外快检 → `SourceWriteLock` 内全量复核 → INSERT `pending` → `moveWikiNodeToDrive` → done→`moved`（锁外 best-effort 触发该 watchedRoot 一次变更检测）/ running→`moving`+task_id（交轮询器，202）/ 业务错→`failed`（502）/ 子进程超时→`unknown`（绝不重试）。
- **轮询器**：tick 5s、单行 `poll_after_ms` 优先（缺省 5s）、单行总上限 10 分钟→`unknown`；状态查询失败不判终态。重启对账三情形：pending→unknown；moving+task_id 续查（10 分钟窗口自续查起算）；moving 无 task_id→unknown。
- **本地语义（§3.5）**：moved 后 documents 行与本地文件字节不动、synced 基线不推进；moved 后编辑/写回拒 `source_moved_out`（文档已离开受管树，写回回拉收敛不成立）；进行中拒 `cloud_move_running`（与 `cloud_revert_running` 同风格共享状态源互斥，编辑/写回/回滚三方入口都挂）。
- **审计**：`<dataRoot>/agent/audit/source-pushes.jsonl` 事件 `move_to_drive_started|moving|moved|failed|unknown`（与写回/回滚同文件）。
- **app_command 不可达**：三条命令 `agentExposed=false`——app_command 执行器判定源（`findOpsCommand(...).agentExposed`）锁定；表内仍登记 `confirmPlan`（preview 派生 `MOVE_OUT:<nodeToken>`），防后续误开放时绕过 node token 确认。

## 待 S5 实测校正点清单

| # | 点 | 当前实现（按 probe help 契约/mock） | 校正位置 |
|---|---|---|---|
| C-1 | `wiki +move-to-drive` 输出字段：state 键名（state/status/task_status）、task_id 形态、是否有 `poll_after_ms`/`next_command` 续查建议 | 通用异步模式双读（P0-S1 history-revert 同款）；`next_command` 未解析（服务层用 `getDriveTaskResult` 通用口续查） | `lark-cli-client.ts` 两方法 + `cloud-move.test.ts` A 段 |
| C-2 | `drive +task_result` 参数名（`--task-id`）与输出（state 归一集合、失败描述键 message/error） | probe §9 help 契约；`success`→done、`failed/error`→failed 归一 | 同上 |
| C-3 | 移出操作的 scope 面（是否需 `wiki` 命名空间写授权；feishuWrite.enabled/写 scope 门是否挂载——设计 §3.4 U46 含此门，任务书门控清单未列，本切片未挂） | 未挂 feishuWrite 门（移出是 wiki 结构操作，非 docx write 面） | `cloud-move-service.ts` 门控段（若 S5 实测需要，追加 `write_disabled`/`scope_missing` 两分支即可） |
| C-4 | 起步命令是否支持 `--wait-timeout-ms` 类等待参数（影响同步 done 分支的真实出现率） | 未传等待参数（一步起步，CLI 返回任务态即收敛解析） | `moveWikiNodeToDrive` |
| C-5 | 状态机状态名与设计 §3.3（started/running/done）的最终对齐（任务书命名优先已实现；若 S5 后统一需改，仅 LMS CHECK + 服务枚举 + 测试锚三处） | pending/moving/moved | LMS 建表段注释 |

## 验证证据

- `cd server && npx vitest run tests/cloud-move.test.ts`：**33/33 通过**（门控八分支、状态机四分支、轮询超时→unknown、查询失败续查、重启对账三情形、moved 后本地不动断言（行+文件字节+synced 基线）、双登记+CHECK、mock 输出解析、路由四端点、命令表三条、CLI 域 422/401/全链 200）。
- 定向回归：`tests/cloud-history.test.ts tests/source-edit.test.ts tests/source-push.test.ts tests/cli-args.test.ts tests/local-map-store.test.ts tests/lark-cli-client.test.ts`（220/220）+ `tests/app-command-family.test.ts tests/agent-tool-families.test.ts tests/cli-source-commands.test.ts`（54/54）。
- `npm run typecheck`（根三段）退出 0；改动面 `eslint` 退出 0。
- `tests/cli-args.test.ts` 命令表总数锚定 38→41（随三条新命令同步）。

## 未覆盖项 / 风险

- 真实 lark-cli 端到端（S5 实测切片覆盖）：本切片全部 mock 驱动，`getNode`/`move-to-drive`/`task_result` 真实输出未触达。
- UI 预览/确认弹窗（设计 §3.4 的「输入文档标题确认」交互）不在本切片；preview API 与后果文案已就绪。
- `unknown` 展示层语义（§3.6「可能已移出/移出未生效」文案 join）与检测链对 moved 行的展示层接线未做（任务书未列，属 UI 切片）。
- 共享树并行任务（luoshen×2）在写：以上验证均在本切片改动面内执行，未观察到兄弟中间态干扰；结算基线以隔离快照为准。
