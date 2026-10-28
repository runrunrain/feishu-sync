# P0-S9 报告：标题同步——「在飞书重命名」闭环 + title_change_not_pushed 警告 + SourceEditService 互斥门补挂

- **日期**：2026-10-29 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P0.md` §6（U31）/§4.4（互斥）、`P0-S2-report.md`（`updateDocumentTitle` + `--type wiki` 语义 + 981003 分类）、`P0-S4-report.md`（`cloud_revert_running` 共享状态源 `getRunningRevertPushLog`；§八遗留 SourceEditService 补挂）
- **下游消费者**：P0-S5 UI（warning 面板与「在飞书重命名」弹窗——本文 §三/§四 即消费契约）

## 一、改名服务（`server/src/sources/source-title-service.ts`，新文件）

- `renameCloudTitle(objToken, title, {confirmValue, actor?, approvalId?})`：**只改云端标题**——`drive +update-title` 单次调用，本地零写入（无 source_edits 行、不动 header、documents.title 不直写），成功后锁外单文档回拉（best-effort，失败只记 `pull` 字段交检测链收敛）；本地文件路径不变（回拉走 existing-mapping 分支）。
- **type 派生（§6.2/P0-S2 契约）**：有 `wiki_node_token` → node token + `--type wiki`；否则 objToken + 实际 objType（仅 docx/sheet/slides/bitable；unknown → `unsupported_type`）。
- **定级裁定（任务书问询项）**：设计 §6.3 定级 **remote_write**（非 destructive）→ 确认值 `RENAME` **不含新标题**；新标题改由 confirmPlan 的 `planKey = ${target.type}|${to}` 约束（批准期间换标题/换目标 → 计划过期重新批准）。
- **门控顺序**（preview 与执行锁内复核同判定）：not_found(404) → title_invalid(422) → write_disabled/scope_missing(403) → kb_build_active/local_edit_pending/cloud_revert_running(409) → unsupported_type(422) → title_unchanged(422)。
- **错误映射**：981003 → `type_mismatch` 422 透传（**不自动换 type 重试**，U31）；981004 → `no_edit_permission` 403（S2 未入 classifyError 码表，按 `upstreamCode` 服务层映射）；其余 LarkCliError → `feishu_rename_failed` 502（改名幂等可重试，无 outcome-unknown 态）。
- 标题合法性（§3）：非空（trim）、无 `\n`/`\r`/NUL、≤800 字节 UTF-8（`isInvalidRenameTitle` 纯函数，路由/命令/服务同源）。
- 审计：`source-pushes.jsonl` 事件 `source_rename`（objToken/from/to/target/actor/approvalId?/url?，不记正文）。

## 二、title_change_not_pushed 警告（§6.1，`feishu-write-service.ts` 追加）

- 判定 `computeTitleChangeNotPushed({syncedTitle, currentBody, baseBody})`：本地正文**首个 H1** 与标题（documents 行 = 最近同步的云端标题）不同 **且基线中二者相同**（分叉由本次本地编辑引入；基线本就分叉的同步态不警告）。
- `push/preview` 新增结构化字段 **`titleChangeNotPushed: {localTitle, syncedTitle} | null`**（SourcePushPlanDto 同步登记，additive）；`warnings[]` 追加机器可匹配文案（码前缀）。
- **消除路径**：改名成功 → 回拉更新 documents.title → H1 与标题一致 → 下次 preview 警告自然消失（测试覆盖）。
- **文案常量**（前端 warning 面板消费锚点）：`TITLE_CHANGE_NOT_PUSHED_CODE = 'title_change_not_pushed'` + `titleChangeNotPushedMessage(local, synced)`——「推送正文不会同步标题；推送完成后可在文档预览『在飞书重命名』同步标题」（与 local_edit_pending 门序一致：脏文档不能改名，先推送）。

## 三、API（routes/feishu.ts 追加；服务每请求构造，无轮询器不进 index.ts）

| 路由 | 风险 | 语义 |
|---|---|---|
| `POST /api/sources/:objToken/title/preview` body `{title}` | read | `TitleRenamePlan {objToken, target\|null, from, to, blockedReason\|null, warnings:[]}`；不调用远端 |
| `POST /api/sources/:objToken/title` body `{title, confirm:'RENAME', actor?}` | remote_write | `TitleRenameResult {objToken, target, from, to, updatedTitle, url, pull}`；confirm 错误 → 400 `confirmation_required` |

错误体 `{error, message, details?}` 沿用 pushErrorResponse（并入 SourceTitleError）。`blockedReason` 值域与 HTTP 映射见 §一。

## 四、命令表（ops/command-table.ts +37 条）与 CLI

| 命令 | 风险 | confirm | 说明 |
|---|---|---|---|
| `cloud.rename_title`（任务书命名，对应设计 §6.3 source.rename 面） | remote_write | `{field:'confirm', value:'RENAME'}` | agentExposed=true；confirmPlan：previewSpecs→title/preview，blocked → `OpsArgumentError('rename_blocked')`，否则派生 `RENAME`；planKey=`${target.type}\|${to}`；CLI 位置参数 `<objToken> <title>`（POSITIONALS 登记） |

app_command 端到端实测：Work 会话 + 逐次批准（remote_write）；模型传入 `confirm` 被剔除；批准卡 confirmValue=`RENAME`；blocked preview → 400 `rename_blocked` 零批准零远端调用。命令计数断言 36→37（cli-args.test.ts）。

## 五、SourceEditService 互斥门补挂（S4 遗留）

`edit`/`revert` 锁内遇 `getRunningRevertPushLog(objToken)` 非 null → **409 `cloud_revert_running`**（S4 同源共享状态；访问器缺失按无回滚容错）。edit 拒绝时不落 source_edits 行/备份目录；revert 拒绝时保留 dirty 行；`read` 只读不受门影响。至此 §4.4「回滚期间 edit/revert/push/新回滚/改名」五个互斥分支全部闭合。

## 六、产物清单

| 文件 | 改动 |
|---|---|
| `server/src/sources/source-title-service.ts` | **新文件**（447 行）：SourceTitleService + 纯函数 + 错误类 |
| `server/src/sources/feishu-write-service.ts` | preview 增 title_change_not_pushed 判定/警告/字段 + 4 个导出（常量/纯函数/文案） |
| `server/src/sources/source-edit-service.ts` | +`hasRunningCloudRevert`/`rejectWhenCloudRevertRunning`；editLocked/revertLocked 各一行门调用 |
| `server/src/routes/feishu.ts` | +2 路由 + `createSourceTitleService`（每请求构造）+ pushErrorResponse 并入 SourceTitleError |
| `server/src/ops/command-table.ts` | +1 命令 `cloud.rename_title`（confirmPlan + planKey） |
| `server/src/cli/args.ts` | POSITIONALS +1 行 |
| `server/src/types/index.ts` | SourcePushPlanDto + `titleChangeNotPushed?`（additive） |
| `server/tests/source-title.test.ts` | **新文件**，33 用例（合法性/判定 5 · 门控矩阵 7 · 执行 8 · 路由 3 · 警告 3 · app_command 2 · 命令表+CLI 5） |
| `server/tests/source-edit.test.ts` | +互斥门 describe（3 用例：edit 409 零写入 / revert 409+read 不受影响 / 无回滚行行为不变） |
| `server/tests/cli-args.test.ts` | 计数 36→37 + rename 位置参数断言 |

## 七、验证证据（cwd=server）

| 项 | 命令 | 结果 |
|---|---|---|
| 新套件 | `npx vitest run tests/source-title.test.ts` | exit 0，33/33 |
| 门+命令契约 | `npx vitest run tests/source-edit.test.ts tests/cli-args.test.ts tests/ops-command-table.test.ts` | exit 0，69/69 |
| 兄弟面回归 | `npx vitest run tests/cloud-history.test.ts tests/source-push.test.ts tests/lark-cli-client.test.ts tests/app-command-family.test.ts tests/cli-source-commands.test.ts tests/local-map-store.test.ts` | exit 0，217/217 |
| CLI e2e | `npx vitest run tests/cli-client.test.ts` | exit 0，17/17（含 index.ts 接线冒烟） |
| 类型 | `npx tsc --noEmit` | exit 0（全局零错误） |
| Lint | `npx eslint <9 个改动文件>` | exit 0 |

## 八、未覆盖 / 风险

- **wiki 成员改名未真机实测**（`--type wiki` argv/help 已实核，P0-S1 HP-7/S2 报告同款遗留）——验收行「wiki 成员改名后飞书树与文档标题均变」的端到端属 Electron 真机链路（P0-S5 范围）；本切片以单测锁定 target 派生与调用参数。
- UI 面板（右键「在飞书重命名」弹窗、warning 面板渲染）按任务书不在本切片——§二/§三 字段与文案常量即 P0-S5 消费契约。
- `981004` 未并入 `classifyError` 码表（S2 报告建议的增量未做，服务层 upstreamCode 映射已覆盖语义；如后续其他消费方需要可另提）。
- 路由级 execute 的 `pull` 在 stub 环境走真实 SyncEngine 会失败——已按 best-effort 契约断言（改名 200 + pull 字段存在）；pull 成功路径由服务级测试（stub pullSync）覆盖。

## 九、撞写记录

- 落笔时 ops/command-table.ts / cli/args.ts / cli-args.test.ts 均为 P0-S4/P0-S8 合入后的最新态（37 条命令含 S8/S4/兄弟登记）；本任务纯追加零重叠。未发现 S8 后续改写。

## 回滚方式

改动集中：新文件×2（service+test）+ 7 文件纯增量块（write-service 警告块、edit-service 两行门、feishu 路由段、命令表一条、POSITIONALS 一行、DTO 一字段、cli-args 计数与断言）。按共享树纪律以精确 diff 反向恢复；`git checkout` 须经 Leader 授权。
