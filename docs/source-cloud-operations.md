# 源文档云端操作

原始源文档（同步库内的 docx）除「云端 → 本地」的常规同步外，提供一组受控的本地编辑与云端操作：本地编辑写回飞书、云端历史查询与回滚、在飞书重命名、引用边重建，以及历史移出记录查询。全部操作逐次确认、带乐观锁与互斥门，失败如实暴露为冲突/未知状态，不自动重试掩盖问题。

命令入口是 `feishu-sync` CLI（见 [CLI 命令参考](cli-reference.md)），`objToken` 一律为首个位置参数；HTTP API 与内部 Agent 工具 `app_command` 走同一批路由（`server/src/routes/sources.ts`、`server/src/routes/feishu.ts`）。标准库反向发布是另一条独立链路，见[反向发布说明](feishu-publish.md)。

写云端的操作（写回、回滚、改名）共用同一组前置条件：

| 前置 | 说明 |
|---|---|
| `feishuWrite.enabled` | 「飞书写入」开关，默认关 |
| 写权限 | `docx:document:write_only`（飞书认证设置发起 `scopeSet=write` 增量授权） |
| 标准库构建不活跃 | 构建进行中拒绝（409 `kb_build_active`） |

## 本地编辑（source edit）

- `feishu-sync source edit-status <objToken>`：读取编辑状态与当前正文 sha256（`bodyHash`）——编辑的乐观锁基线。
- `feishu-sync source edit <objToken> --base-hash <hash> (--new-text <全文> | --op '<编辑操作 JSON>') --yes`：编辑本地正文。`op` 支持 `{"mode":"replace_body","body":"…"}`、`{"mode":"str_replace","old":"…","new":"…"}` 等形态；HTTP 面还接受 `ops` 数组。确认值 `EDIT`。
- `feishu-sync source revert <objToken> --yes`：放弃本地修改，恢复上次同步正文并清除脏状态。确认值 `REVERT`。

机制要点：

- 编辑只作用于 `feishu_sync` 头注释块之后的正文区，原 header 字节原样保全；写回后逐字段复核元数据一致，不一致立即恢复并报错。
- 乐观锁：`baseHash` 必须等于编辑前正文哈希，否则 409 `source_edit_conflict`（编辑面过期，重新取 `edit-status`）。
- 首次编辑把同步版正文备份到 `<数据根>/source-edits/<objToken>/base.md`，此后每次编辑前留 `<序号>.md`（最近 20 份）；备份是写回与放弃修改的基线。
- 编辑落账 `source_edits` 行（状态 `dirty` → `pushing` → `pushed` / `conflict`）；全程与同步引擎共用同一把 per-token 写锁。
- **`local_edit_pending` 保护**：存在 dirty/pushing/conflict 行时，常规同步、回收站、源清理、孤立清理对该文档一律产出 `local_edit_pending` blocker 拒绝处理，绝不覆盖本地修改或推进基线。先把修改写回或放弃，链路才恢复。

## 写回飞书（source push）

- `feishu-sync source push-preview <objToken>`：只读预览，返回计划形态（`append` 追加差异 / `overwrite` 整体覆盖 / `blocked`）、字节数、云端状态、回退锚点与警告。
- `feishu-sync source push <objToken> [--allow-overwrite] [--force] --yes`：执行写回。确认值按计划派生——追加 `PUSH`；覆盖或强制 `OVERWRITE_CLOUD`。

安全协议：

- **覆盖采用三段式**：取云端最新 revision → 同一流程内立即覆盖（revision 仅防未来值）→ 回读云端正文做转义归一化比对；失配即置 `conflict` 停止，绝不重试旧 revision（旧 revision 会被静默接受并造成正文损坏）。
- **竞态防线**：写前比对云端 `obj_edit_time` 与本地基线，云端已前进 → 409 `source_push_conflict`，先回拉核对或以 `--force`（`OVERWRITE_CLOUD`）显式覆盖；任一侧时间不可读 → fail-closed 拒绝（`cloud_time_unreadable`），`force` 可越过此门但警告会保留。
- **回退锚点**：覆盖前取云端最新历史版本作回退点并先落 `source_push_log` 行；覆盖取不到锚点或锚点行落库失败 → 拒绝执行（`rollback_anchor_unavailable`，force 也不可越过——force 的语义是接受覆盖云端新改动，不是放弃回退点）。追加无锚点仅降级为警告照常推送。
- **结果未知不重发**：追加与覆盖均非幂等。命令发出后超时/响应不可读 → `push_outcome_unknown`（conflict 态），须到飞书核对；再次推送需确认上次操作已结束（HTTP 面 `acknowledgedUnknownUpdatedAt`，CLI 面按提示重试核对后操作）。
- **标题不同步**：推送正文不会同步标题；本地编辑把正文首个 H1 改得与标题分叉时，预览给出 `title_change_not_pushed` 警告，推送完成后用「在飞书重命名」对齐。
- **写回不推进任何同步基线**：成功后服务端立即对该文档做一次单文档回拉（走常规同步链、不叠加 LLM 整理），由同步链按既有不变量推进基线并清理编辑行与备份；回拉失败不回滚云端写入，编辑行保留待收敛。
- 正文经 lark-cli 内部临时目录传给子进程，不落命令行参数与日志。

## 云端历史与回滚（cloud revert）

- `feishu-sync cloud history_list <objToken>`：云端历史版本列表。缺省聚合前 3 页（约 60 条），返回 `truncated` 与 `nextPageToken` 续翻；显式 `--page-token` 单页透传。回滚操作产生的快照 type=3，与编辑历史可区分。
- HTTP 面另有只读正文端点：`GET /api/sources/{objToken}/history-content?revisionId=<n>`（缺省读云端当前正文，供对比）与 `GET /api/sources/{objToken}/push-log`（本机写回/回滚记录，含锚点与回滚状态）。
- `feishu-sync cloud revert <objToken> <historyVersionId> --yes`：回滚云端文档到指定历史版本（destructive）。确认值必须含目标版本 id（`REVERT_CLOUD:<historyVersionId>`，CLI 自动构造）；最新历史条目不可作目标（服务端预校验直接拒绝）。

回滚机制：

- 先预览（HTTP `POST …/history-revert/preview`，body `{pushLogId}` 或 `{historyVersionId}` 二选一）：返回目标版本、警告（锚点不精确 / 推送后云端又有修改 / 时间不可读）与阻断原因。app_command 通道由服务端按预览派生确认值并锁定计划指纹。
- 执行可能异步起步（返回 202 `running` + taskId），由服务端轮询收敛（5 秒节奏、单任务 10 分钟上限），完成后自动单文档回拉收敛本地。
- 回滚是纯云端动作：不推进任何本地 synced 基线，本地收敛只经回拉走常规同步流程。
- 结果未知（超时/不可解析）置 `unknown`，绝不自动重发；`POST /api/sources/{objToken}/reverts/{pushLogId}/reconcile` 查询任务终态，无可靠状态时要求人工确认已结束。
- 互斥：同一文档回滚进行中，写回与改名一律拒绝（409 `cloud_revert_running`）；存在未写回的本地修改时回滚拒绝（409 `local_edit_pending`）——先写回或放弃修改。

## 在飞书重命名（cloud rename_title）

- `feishu-sync cloud rename_title <objToken> <title> --yes`：在飞书改文档标题（remote_write，确认值 `RENAME`）。知识库（wiki）成员用节点身份改名（节点与文档标题双向同步），普通云文档用 objToken；先经 `POST …/title/preview` 预览（阻断原因与目标），批准期间换标题或换目标会使计划指纹失效、要求重新确认。
- 本地文件名与路径不变：改名后的回拉走既有路径映射，不产生移动；需要文件名跟随时另行使用「按飞书结构重排路径」。改名不写本地任何状态、不推进基线，成功后触发单文档回拉同步头部与树展示。
- 类型不匹配（如用错 token 身份）返回 `type_mismatch`，不自动换另一种身份重试——先重新检测同步。改名受与回滚同组的互斥门（回滚进行中、本地脏修改、构建进行中均拒绝）。

## 引用边重建（sources references-rebuild)

`feishu-sync sources references-rebuild --yes`：全量重建源文档引用边索引（mutate，确认值 `REBUILD`）。只读本地 Markdown 重算正文引用边、零云端调用；云端引用（refmap）边随下次同步补齐，有本地脏修改的文档跳过。属显式维护动作，不进入 Agent 工具面。

## 移出记录查询（cloud moves）

移出到云空间（wiki → Drive）的执行入口已下线：相关写入端点返回 410 `feature_removed`。保留的能力：

- `feishu-sync cloud moves [--obj-token <objToken>] [--limit N]`：历史移出记录列表（创建时间倒序，缺省 50 条）。objToken 与条数上限都是旗标参数，不接受位置参数。
- `feishu-sync cloud move_status --move-id <moveId>`：单条移出记录状态（pending / moving / moved / failed / unknown），不触发远端调用；moveId 只能用 `--move-id` 传入。
- `POST /api/sources/moves/{moveId}/reconcile`：unknown 记录的权威核对——查询任务终态；无可靠状态时要求人工确认任务已结束及文档去向，确认未移出时还会核对节点身份。不发起任何云端写入。

历史遗留语义仍然生效：状态 `moved` 的文档不再受知识库管理，本地编辑与写回一律拒绝（409 `source_moved_out`，本地文件保留）；`pending`/`moving`/`unknown` 期间的写回与编辑拒绝（409 `cloud_move_running`），unknown 须先经权威核对证明未移出。

## 命令与确认值速查

| 命令 | 风险级 | 确认值 |
|---|---|---|
| `source edit-status <objToken>` | read | — |
| `source edit <objToken> …` | mutate | `EDIT` |
| `source revert <objToken>` | mutate | `REVERT` |
| `source push-preview <objToken>` | read | — |
| `source push <objToken> …` | remote_write | `PUSH`（覆盖/强制 → `OVERWRITE_CLOUD`） |
| `cloud history_list <objToken>` | read | — |
| `cloud revert <objToken> <版本id>` | destructive | `REVERT_CLOUD:<版本id>` |
| `cloud rename_title <objToken> <标题>` | remote_write | `RENAME` |
| `sources references-rebuild` | mutate | `REBUILD` |
| `cloud moves` / `cloud move_status --move-id <moveId>` | read | — |

互斥与保护门汇总：

| 门 | 触发条件 | 影响的操作 |
|---|---|---|
| `kb_build_active` | 标准库构建进行中 | 编辑、写回、回滚、改名 |
| `local_edit_pending` | 存在未写回的本地修改 | 常规同步/清理（blocker）；回滚、改名 |
| `source_push_in_progress` | 该文档正在写回 | 再次写回、编辑 |
| `cloud_revert_running` | 该文档回滚进行中或结果未知 | 写回、改名 |
| `cloud_move_running` / `source_moved_out` | 移出进行中/未知；或已移出 | 写回、编辑 |
| `source_push_unknown_unconfirmed` | 上次写回结果未知未核对 | 再次写回 |

审计：编辑操作记 `<数据根>/agent/audit/source-edits.jsonl`；写回、回滚、改名与移出记 `<数据根>/agent/audit/source-pushes.jsonl`（均不记正文）。CLI 通道另有 `agent/audit/cli.jsonl`（见 [CLI 命令参考](cli-reference.md)）。
