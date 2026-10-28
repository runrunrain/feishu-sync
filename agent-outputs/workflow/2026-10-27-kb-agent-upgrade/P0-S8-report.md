# P0-S8 报告：存量补齐——白板旁路文件回填（不改 md 与 DB 基线）

- **日期**：2026-10-28 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P0.md` §5.8（存量补齐）+ §5.1–§5.3 + §10 裁定 1、`P0-S6-report.md`（svg 主 + raw 降级导出链 / 配置契约 / §五遗留）
- **产物**：`server/src/modules/whiteboard-bypass.ts`（新增共享导出模块）+ `sync-engine.ts`（backfillWhiteboardBypass 追加 + S6 方法委托共享函数）+ `custom-doc-sync.ts` + `routes/custom-folders.ts` + `routes/sync.ts`（新路由）+ `ops/command-table.ts` + `cli/args.ts` + `server/tests/whiteboard-backfill.test.ts`（新增 20 用例）

## 一、命令契约（CLI 与 app_command 双通道）

| 项 | 值 |
|---|---|
| 命令名 | `sync.whiteboard_backfill`（任务书命名；设计 §5.8 原名 `sync.whiteboard-svg-backfill` 仅含 svg，S6 后产物为 svg 主 + raw 降级，命令名与路由随任务书不带 `svg` 段） |
| 路由 | `POST /api/sync/whiteboard-backfill`，body `{ docTokens?: string[], confirm: 'BACKFILL' }` |
| 风险级 | `mutate`（按设计 §5.8 定级：写本地旁路文件、不写云端）+ `confirm:{field:'confirm', value:'BACKFILL'}` |
| agentExposed | `true`（任务书「CLI+app_command 双通道」；**偏差**：设计 §5.8 登记 agentExposed=false，按任务书覆盖，已在此记偏差） |
| CLI 用法 | `feishu-sync sync whiteboard-backfill --yes`（全量 synced 文档）；`feishu-sync sync whiteboard-backfill <tok1> <tok2> --yes` 或 `--doc-tokens '["tok1"]'`（选择性）；缺 `--yes` → 退出码 4 |
| 响应 | `{ scanned, exported, skipped:[{objToken, reason}], committedFiles }`（committedFiles 为本次 atomic-commit 入库的旁路相对路径，POSIX 形态） |

路由门控（全部有测试锚定）：缺 `confirm='BACKFILL'` → 422 `confirmation_required`；`docTokens` 非 1–200 非空字符串数组 → 400 `invalid_doc_tokens`；知识库根未配置 → 400 `knowledge_base_root_not_configured`；`sync.whiteboardExport.enabled=false` → 400 `whiteboard_export_disabled`；标准库构建活跃（`localMapStore.getActiveKbBuild()`）→ 409 `kb_build_active`（§5.8「构建活跃 → 整个命令 409」）。

## 二、SyncEngine.backfillWhiteboardBypass 契约

- **入口**：`backfillWhiteboardBypass({ docTokens? })`。缺省扫全量 synced 行（判定与 getSyncStats 同款：`status='synced' ∨ sync_state='synced' ∨ synced_obj_edit_time≠null`，含归档文档行）；显式 docTokens（去重）逐个解析，`not_found`/`not_synced` 计入 skipped。
- **白板引用解析**：`extractLocalWhiteboardRefs`（sync-engine 导出）识别本地 md 两种白板标签——`![飞书白板](…)`（docx/custom 链 renderLocalizedMediaReferences）与 `![白板预览](…)`（slides 媒体附录 appendSlidesMediaReferences），去重保序。白板 token 按设计 §5.8 从 PNG 主干的 `NN-<token>` 段恢复；解析不出 → `token_unresolvable:<stem>` 跳过并计入报告。
- **跳过值域**：`local_edit_pending`（source_edits 非 pushed 行，S11 同款判定，§5.8 硬要求）/ `not_found` / `not_synced` / `local_md_missing`（兼容旧行：仅 localRelPath 也可解析）/ `token_unresolvable` / `already_present`（同主干 `.wb.svg` 或 `.wb.raw.json` 任一已存在）/ `png_missing` / `ref_outside_root`（防御） / `export_failed`（svg+raw 双失败，降级链内已 console.warn）。
- **写盘路径**：逐文档串行；导出物先落 staging 镜像路径（镜像只用于命名派生与 lark-cli 子进程 cwd，PNG 本体从不被读取/复制），全部处理完**一次 atomic-commit 入位**（`createAtomicCommitWorkspace → stageFileContent → commitAtomicPlan`，失败整体回滚不留残留）；同一相对路径只入 plan 一次（共享 images 目录下多文档引用同一白板不重复导出/计数）。导出链与 S6 完全同一函数（见 §四）。
- **防重入细节**：重复 docTokens 引擎内去重（路由层亦去重）。

## 三、基线不变证据（硬验收）

测试 `whiteboard-backfill.test.ts`「补齐 .wb.svg」用例逐项断言（真实入口 = 引擎方法 + 路由 + CLI 转发三处同验）：

1. **md 字节不变**：前后 buffer `equals` + sha256 相等（md 是 contentHash 的推导源 → contentHash 不变）；
2. **DB 行逐字段不变**：前后 `JSON.stringify` 全行 deep-equal（含 `synced_obj_edit_time` / `status='synced'` / `sync_state` / `last_synced_at` / `local_rel_path`）；store 替身的 `upsertDocument`/`markDocumentSynced` 写面零调用；
3. **只新增旁路文件**：`committedFiles === ['架构图/images/01-<token>.wb.svg']`，同目录 PNG 字节不变，目录内无其他新文件。

## 四、S6 导出函数复用与 custom-doc 接入

- **共享化**：S6 落在 `sync-engine.ts` 方法体的导出链提炼为 `server/src/modules/whiteboard-bypass.ts` 纯函数（`exportWhiteboardBypassFile(client, pngPath, token, options)` + `resolveWhiteboardExportOptionsFromConfig` + 8 MiB 上限常量；客户端 `exportWhiteboard` 为可选方法，缺失 → 跳过不告警，与 S6 容错语义一致）。`SyncEngine.exportWhiteboardBypassFile`/`resolveWhiteboardExportOptions` 保留原签名，方法体改为委托（行为字节等价，S6 全部 8 用例零回归）。**这是对「sync-engine 只追加方法」的唯一例外**：两处私有方法体由实现改为委托（签名/行为不变），不提炼则 custom-doc 与 backfill 只能复制 70 行导出链、违背「同一导出函数复用」的任务要求。
- **custom-doc-sync 接入**（P0-S6 报告 §五遗留）：`downloadMediaReferences` 在白板 PNG `assertDownloaded` 后追加旁路导出（永不阻断归档，双失败仅告警）；`DownloadedMedia.whiteboardBypass` 随 extraFiles 与 PNG 同批原子提交，计入 `committedFiles`（DB 失败回滚面覆盖）。输入新增可选 `whiteboardExport`（宽容形态），`routes/custom-folders.ts` 的 LinkContext 透传 `config.sync.whiteboardExport`——**关闭开关对结构树链与归档链行为一致**（测试双断言：开 → `.wb.svg` 入库且 md 只引用 PNG；关 → 零 +export 调用、committedFiles 无旁路）。
- **不动 S7 消费面**：`kb/` 零改动；S7 按命名约定探测旁路文件，回填产物与其约定同构。

## 五、验证证据（cwd=server，2026-10-28）

| 项 | 命令 | 结果 |
|---|---|---|
| 新测试 20 用例（基线不变硬验收 / raw 降级 / 脏跳过 / 选择性 / already_present / token_unresolvable / png_missing / 配置关闭 / 旧行 localRelPath / docTokens 去重 / custom-doc 双向 / 命令表 / CLI 位置参数 / 路由 5 门控 / **CLI 执行域端到端 `/api/cli/sync.whiteboard_backfill`**） | `npx vitest run tests/whiteboard-backfill.test.ts` | exit 0，20/20 passed |
| S6 零回归（共享化重构后）+ 同步引擎 | `npx vitest run tests/whiteboard-bypass.test.ts tests/sync-engine.test.ts` | exit 0（随全批 214/214） |
| custom 链 / 命令表 / CLI args / 路由安全 / CLI 执行层 / app_command | `npx vitest run tests/custom-folders.test.ts tests/custom-folder-detect-sync.test.ts tests/ops-command-table.test.ts tests/cli-args.test.ts tests/sync-route-safety.test.ts tests/cli-endpoint.test.ts tests/app-command-family.test.ts` | exit 0 |
| 汇总批 | 上述 9 文件一次跑 | **9 files / 214 tests 全绿**，exit 0 |
| 类型 | `npx tsc --noEmit`（server）+ 根 `npm run typecheck`（三段） | 均 exit 0 |
| Lint | 根 `npm run lint` | exit 0（仅存量 src/hooks 警告 3 条，与本切片无关） |

未跑项：全量 `npm run check` / 真实飞书端到端（共享树并行任务中间态，harness 结算以隔离快照为准；真实 `whiteboard +export` 行为已由 P0-S1 实测、S2 单测、S6 全链测试锁定，本切片 mock 驱动同链）。app_command 批准流执行路径由 `app-command-family.test.ts` 泛层回归覆盖（新命令经同一执行层，mutate 级走会话内批准）。

## 六、未覆盖 / 风险 / 偏差

- **命令名与路由名与设计原文不一致**（`sync.whiteboard_backfill` vs 设计 `sync.whiteboard-svg-backfill`；`/api/sync/whiteboard-backfill` vs `/api/sync/whiteboard-svg-backfill`）：按任务书命名优先。Leader 若要回到设计原名，改 `command-table.ts`（name/path）与 `routes/sync.ts`（path）两处即可，测试同名断言随改。
- **agentExposed=true** 超出设计 §5.8 的 false 登记：按任务书「CLI+app_command 双通道」覆盖；mutate 级在 app_command 通道仍逐次经用户批准（既有批准流），风险面收敛。
- 极大量白板文档的一次性回填会逐文档串行发起 svg/raw 导出（受既有 docx QPS 桶 3 QPS 约束），大库全量补齐耗时与 `svgHash 触发重建风暴`（设计 §8）同量级——建议先选择性 `docTokens` 补齐关键架构图文档，再全量。
- 回填不处理 `.wb.svg` 存在但 `.wb.raw.json` 缺失（或反之）的混合态：`already_present` 以任一存在即判，不补另一种形态（旁路是可选资源，S7 消费侧按存在者优先）。
- 警告通道沿 S6 现状 console.warn（SyncResult 无 warnings 字段）；回填的可执行反馈在 `skipped` 报告中，不在 SyncResult。

## 七、撞写记录

- 共享树并行未提交改动多（P0-S3/S4、P1 系列等）；本任务写面为纯增量块 + sync-engine 两方法体委托改写（§四），与兄弟任务零重叠。`cli/args.ts` POSITIONALS 曾与兄弟任务（cloud.* 登记）并发撞出一次重复尾段，当场甄别后修复（重复 3 行删除，兄弟内容保留）；修复后 `cli-args.test.ts` 全绿。

## 回滚方式

- 删 `server/src/modules/whiteboard-bypass.ts`、`server/tests/whiteboard-backfill.test.ts`、本报告。
- `sync-engine.ts`：删 backfillWhiteboardBypass 方法块、模块级 `extractLocalWhiteboardRefs`、结果接口、共享模块 import；`exportWhiteboardBypassFile`/`resolveWhiteboardExportOptions` 委托体还原为 S6 内联实现（`git diff server/src/modules/sync-engine.ts` 中本切片 hunk 的反向）。
- `custom-doc-sync.ts`：删 import / 输入字段 / DownloadedMedia 字段 / downloadMediaReferences 旁路段 / extraFiles 旁路 push；`routes/custom-folders.ts`：删 LinkContext.whiteboardExport 及两处透传。
- `routes/sync.ts`：删 `/api/sync/whiteboard-backfill` 路由块；`ops/command-table.ts`：删命令条目；`cli/args.ts`：删 POSITIONALS 一行。
- 已入库的 `.wb.svg`/`.wb.raw.json` 留存无害（S7 前后均按可选资源处理；手动删除亦可）。
