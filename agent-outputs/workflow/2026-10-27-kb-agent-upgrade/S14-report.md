# S14 文档合并报告：基线设计修订 + 使用说明更新

- 分支：feat/agent-knowledge-workbench（共享树）；仅改动三份文档，零代码改动。
- 修订依据：`docs/design/kb-agent-upgrade-design.md` §9 修订指令（增量事实源），并与已合入实现（S0–S13 代码）交叉核对后落笔。
- 上游输入：`docs/design/kb-agent-upgrade-design.md`、`docs/design/agent-knowledge-design.md`、`docs/agent-knowledge.md`；T2a 预览修复依据 `T2a-r-render-fixes.md`。

## 一、`docs/design/agent-knowledge-design.md`（基线设计）修订点

| # | 位置 | 修订内容 | 来源 |
|---|---|---|---|
| 1 | §5.2 配置段 | `AgentConfig` 增 `vision: AgentVisionConfig`（完整签名：enabled/providerId/modelId/concurrency/maxImageBytes/maxImagesPerBuild/timeoutMs）；新增 `AgentVisionConfig` 接口；`StandardKbConfig` 增 `buildParallelism`（1..6 默认 2）；Config 注释增 `cli?: { enabled }` 与 `feishuWrite?: { enabled }`；`LlmModelPreset.supportsImages?` 注释 | 升级 §3.1/§4.6/§6.2/§7.6 |
| 2 | §5.2 配置段（顺带修订） | `maxConcurrentProcesses` 注释 2/1..4 → 3/1..6 + 后台配额 M−1 说明；`buildBatchSize` 注释改为「单元内每批源数」 | 升级 §9.2/§4.6（§9 修订指令的显式处置项；与代码 `buildDefaultAgentConfig` 一致） |
| 3 | §7.1 运行类型表 | Discuss/Work 行追加 `raw_read_image`、`app_command`（Discuss 仅 read 级）、`task_*`（编排启用时）；Build 行追加 `kb_unit_done`；新增 Task（子任务）行（角色 ∩ 父模式工具集，永不含 task_*/app_command） | 升级 §9.2 行 3；与代码 `DISCUSS_TOOLS/WORK_TOOLS/BUILD_TOOLS/toolsForRunKind` 一致 |
| 4 | §7.1 工具语义表 | 追加 7 行：`raw_read_image`、`kb_unit_done`、`task_submit`、`task_query`、`task_resume`、`task_cancel`、`app_command`（参数面按升级 §3.5/§4.4/§5.2/§6.5 抄录精简） | 升级同节 |
| 5 | §8 错误码表 | 追加升级 §8 全部新码：401 cli_token_invalid；403 cli_forbidden_route、feishu_write_*；404 task/approval/source_edit_not_found；409 task_* 与 source_* 组；422 source_* 组；500 source_header_roundtrip_failed；502 feishu_write_failed；工具错误组（kb_path_owned_by_other_unit 等 7 码）；kb_unit_failed；local_edit_pending（blocker）；app_not_running/app_not_reachable（CLI 退出码 3） | 升级 §8 |
| 6 | §13 不变量 | 按升级 §9.1 重排为 7 条连续编号：1=受控写者措辞替换（原文「只被 SyncEngine 写」废止）；2/3=新增（未写回修改不被覆盖 / synced 基线只由 SyncEngine 推进）；4=原 2+并行校验补充；5=原 3+子任务与批准补充；6=原 4+vision 降级补充；7=原 5+CLI 令牌/key stdin/临时文件扩展 | 升级 §9.1 全表 |
| 7 | 文末 | 新增「§18 升级增补（2026-10）」：一段式摘要 + `./kb-agent-upgrade-design.md` 链接；增量细节留在升级文档，仅声明基线四处修订已并入 | 任务书要求 |

注：`agent.orchestration` 配置（maxActiveTasksPerSession/taskTimeoutMinutes）未并入 §5.2——任务书清单未列，且基线新工具行未引用该参数，无悬空引用；细节保留在升级文档 §5.2（§18 总述覆盖）。

## 二、`docs/agent-knowledge.md`（使用说明）修订点

按用户视角追加，文风对齐既有文档（简洁中文、面向使用者、无实现细节）；入口名称与命令名均对照实现文案核实：

| # | 小节 | 位置 | 内容 |
|---|---|---|---|
| 1 | 「图片理解模型」 | 「准备运行时与模型」章末 | 开关入口（设置 → Agent 标准库 → 图片理解）、双模型边界、缓存复用、未理解如实标注、测试按钮、隐私提示 |
| 2 | 并行构建段 | 「构建、阅读与来源」章内 | 「构建并行数」（1–6 默认 2）语义、单元划分、进程名额约束、面板进度 |
| 3 | 预览渲染修复段 | 「阅读布局」章末 | 折叠区块/提示卡/嵌套表格/勾选框/上下标等块型修复、附件链接、旧导出免重同步受益（依据 T2a-r） |
| 4 | 「任务编排」 | 「Discuss 与 Work」章后 | 任务区开关（下一轮生效）、三角色、自包含描述、作答/取消、子任务无 app_command |
| 5 | 「命令行访问」 | MCP 章后 | 开启入口（设置 → 应用 → 命令行访问）、安装命令行工具、6 条常用命令表、--json/--home/--yes、退出码 0–4 |
| 6 | 「源文档编辑与写回飞书」 | 命令行访问后 | 编辑（头部保全/备份）、本地已修改状态与同步 blocker、写回预览→追加/覆盖确认→冲突→回拉清态、放弃修改、飞书写入开关与写权限授权 |

## 三、`docs/design/kb-agent-upgrade-design.md` 修订点

文首 blockquote 增状态行：「已实施（S0–S14 合入），基线修订见 `agent-knowledge-design.md` §18。本文保留为实施依据，不删内容」。内容零删改。
过程偏差：插入状态行时一次 edit 误吞了「> 输入证据：」行前缀，随即发现并修复，终态 `sed -n 1,6p` 验证原文完整。

## 四、引用一致性检查结果（grep 实测）

| 检查项 | 方法 | 结果 |
|---|---|---|
| 新工具名 7 个（raw_read_image/kb_unit_done/task_*/app_command） | grep `server/src/agent/tool-specs.ts` vs 基线 §7.1 | 7/7 两端都存在 |
| 使用说明 CLI 命令 7 条（status/kb build/kb builds/source edit/source push/clean orphans/auth status） | grep `server/src/ops/command-table.ts`（点号名映射空格名） | 7/7 在命令表登记；**未写** `kb events`（升级 §6.3 列有但实现未登记）与 `auth login`（实为 start/complete 两段，避免误导） |
| 新错误码 31 个 | grep 升级设计 §8 vs 基线 §8 | 31/31 已并入且来源存在 |
| 基线章节锚点（§5.2/§7.1/§8/§13/§18） | grep 标题行 | 全部存在；§18 链接目标 `./kb-agent-upgrade-design.md` 存在 |
| §13 编号连续性 | 计数 | 7 条连续（1–7），文档内无其他「不变量 N」编号引用，重排无悬空 |
| UI 入口文案 | grep 组件源码 | 「图片理解」「构建并行数」「任务」「命令行访问」「设置 → 飞书认证 → 飞书写入」均与实现文案逐字一致 |
| markdown 表格完整性 | awk 提取 §7.1 新行 | 7 个新工具行格式完好 |

## 五、未覆盖项与风险

- 使用说明小节为文字交付，未做真机 UI 截图审阅（S14 范围仅文档；各功能的交互验证证据在 S5/S7/S9/S13 报告）。
- `kb events --follow` 等升级 §6.3 设计中但实现未登记的命令未写入使用说明——若后续切片补登记，命令表需同步；本报告已如实记录差异。
- 三份文档未 commit（未授权 git 操作）。

## 回滚方式

`git checkout -- docs/design/agent-knowledge-design.md docs/agent-knowledge.md`；`docs/design/kb-agent-upgrade-design.md` 为未跟踪新文件，回滚本次状态行用 `git diff` 不可见，可手动删除文首第二行 blockquote（状态行）。
