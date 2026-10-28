# S7 报告：任务编排 UI（对话页「任务」区 + 作答 + 编排开关）

上游输入：`docs/design/kb-agent-upgrade-design.md` §5.4/§11.3（右栏「任务」区：状态、作答、结果展开、取消）、`S6-report.md`（§四 API/SSE 契约）、`S10-report.md`（右栏布局与批准卡片）、`src/components/agent/MessageStream.tsx`。

## 一、改动清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/types/agent.ts` | 追加 | `AgentTaskStatus`/`AgentTaskDto`（逐字段对齐 S6 server DTO）/`AgentTaskNotice`；`AgentSessionEvent` 联合 +`task_update` |
| `src/api/client.ts` | 追加 | `listAgentTasks`/`getAgentTask`/`cancelAgentTask`/`resumeAgentTask`/`getAgentTaskMessages`（S6 路由契约）；编排开关复用既有 `getAgentPlugins`/`updateAgentPlugin`（PUT /api/agent/plugin-contexts/orchestration + expectedRevision，未新增路由） |
| `src/hooks/useAgentSessions.ts` | 追加 | `tasks`/`taskNotices`/`taskBusyId` 状态；会话切换拉取任务列表；SSE `task_update`（`isAgentTaskDto` 判别 + `mergeTaskIntoList` 合并 + `describeTaskNotice` 提示行，均纯函数导出）；`cancelTask`/`resumeTask`（API 返回 DTO 即时合入，SSE 幂等兜底；失败进 streamErrors） |
| `src/hooks/useAgentOrchestration.ts` | 新增 | 编排开关 hook：GET plugin-contexts 读 enabled+revision；PUT 乐观锁切换；`extractOrchestrationEnabled` 纯函数 |
| `src/components/agent/TaskPanel.tsx` | 新增 | 右栏「任务」区：开关 + 任务列表（状态徽标/角色 label（三张内置角色卡）/标题/轮次/排队序/outputDir）；`TaskCard` 展开详情；`TaskCardBody`（错误行、BLOCKED 提问+作答表单、结果 details+截断标记、执行记录懒加载按钮）；`TaskMessagesView` 子任务消息只读视图。编排停用→任务区不渲染，仅启用入口 |
| `src/components/agent/MessageStream.tsx` | 追加 | `taskNotices` prop（居中弱化提示行，进 contentKey/hasContent）；`ToolRow` 对 `task_*` 工具用 ListTodo 图标（折叠行形态复用 ToolRow） |
| `src/views/AgentView.tsx` | 追加 | `useAgentOrchestration` 接线；右栏改纵向 flex：TaskPanel（shrink-0, max-h 60%）+ AgentModePanel（flex-1）；MessageStream 传 taskNotices |
| `src/components/agent/TaskPanel.test.tsx` | 新增 | 15 用例（见 §三） |
| `src/hooks/useAgentSessions.tasks.test.ts` | 新增 | 10 用例：DTO 判别/合并语义/提示行推导/编排开关提取 |

未动 `AgentSettingsCard`（S5 写面）与 `BuiltinContextsEditor`（设置页已有 orchestration 条目的编辑面，天然成为设置侧入口）。

## 二、真机浏览器验证（agent-browser，dev:all 形态）

环境：`FEISHU_SYNC_HOME=/tmp/feishu-sync-s7`（隔离临时目录，已清理）、server tsx @127.0.0.1:3171（`FEISHU_SYNC_PORT` 避让被占用的 3001）+ vite @:5273（`BACKEND_PORT` 代理注入 `FEISHU_SYNC_DEV_TOKEN`）。任务数据经 API 建会话（`s_mvrenn9g_fd495b86`）+ better-sqlite3 直插 6 条 agent_tasks（六状态各一）+ blocked 任务配 pi JSONL（`parseSessionJsonl` 真实解析路径）。截图：`assets/s7-01..06-*.png`（本目录下）。

| # | 操作序列 | 结果（a11y 树 + API 双侧证据） |
|---|---|---|
| 1 | 进入「肆 对话」选会话 | TaskPanel 渲染于右栏 TaskPanel+AgentModePanel 之上；编排默认停用：checkbox unchecked、停用提示文案、`agent-task-list` 不存在（eval false）【s7-01/06】 |
| 2 | 点击「编排」开关 | 即刻切换 PUT 成功；6 任务渲染，取消按钮仅 running/queued/blocked 三张在場（终态无）【s7-02】 |
| 3 | 展开 blocked「审校标准库首篇」 | 提问文案 + 作答 textarea + 提交按钮（空输入 disabled）+「查看执行记录」【s7-03】 |
| 4 | 点击「查看执行记录」 | GET /tasks/:id/messages 渲染 4 行：任务(user)/子Agent(assistant+toolCalls)/raw_search 工具行/`<!--FS:BLOCKED-->` 回复 |
| 5 | 填入作答→提交 | POST /resume → blocked→queued→派发（临时环境无模型）→failed(agent_not_ready, rounds=2)；卡片经 SSE task_update 实时变「失败」，**消息流出现提示行「任务『审校标准库首篇』失败（agent_not_ready）」**【s7-04】 |
| 6 | curl 取消 running 任务（无浏览器操作） | SSE `task_update` 实时刷新：卡片→「已取消」+ 消息流提示行「任务『转换协议设计文档』已取消」 |
| 7 | 点击 UI「取消」（queued 任务） | POST /cancel 成功，卡片变已取消 + 提示行「任务『统计表格分型分布』已取消」 |
| 8 | 展开 done/failed 任务 | done：`<details>`「执行结果（已截断）」+ 正文（eval 读 DOM 确认）；failed：`task_contract_missing：两轮回复均缺少 DONE 标记` 错误行【s7-05】 |
| 9 | 再次关闭编排 | `agent-task-list` 消失（eval false），仅留开关+提示【s7-06】 |

## 三、S6 契约对照

| S6 §四 | 本切片实现 | 状态 |
|---|---|---|
| GET `/api/agent/tasks?sessionId=` → `{tasks}` | `listAgentTasks`，会话切换加载 | ✅ 浏览器实测 |
| GET `/api/agent/tasks/:id` | `getAgentTask`（client 导出备用） | ✅（列表/卡片走 list+task_update，单查暂无 UI 调用点） |
| POST `/:id/cancel` → AgentTaskDto | `cancelTask` + UI 取消按钮 | ✅ 浏览器实测（UI 与 API 双路径） |
| POST `/:id/resume` `{message}` | `resumeTask` + blocked 作答表单 | ✅ 浏览器实测（→queued→派发） |
| GET `/:id/messages` → `{messages}` | 「查看执行记录」懒加载 + TaskMessagesView | ✅ 浏览器实测 |
| SSE `task_update`（data=AgentTaskDto） | handleSseEvent 新 case + mergeTaskIntoList | ✅ 浏览器实测（API 侧取消→UI 实时刷新） |
| 编排开关（PUT plugin-contexts/orchestration） | useAgentOrchestration + TaskPanel 开关；设置页 BuiltinContextsEditor 既有条目为设置侧入口 | ✅ 浏览器实测（开/关两向） |
| 角色卡清单 | 前端 `TASK_ROLE_LABEL` 常量（analyst/converter/reviewer frontmatter label），未知角色回退原 id；S6 未提供 roles 列表 API，v1 三张内置卡走常量 | ✅（渲染验证） |

组件测试（25 用例全绿）：六状态徽标/角色标签/进度行（排队 #N、N 轮、outputDir）；取消仅非终态；blocked 提问+表单+空作答禁用+busy 防双击；done 结果+截断标记；failed 错误码；执行记录入口与列表；编排停用任务区不渲染；加载中整块不渲染；`mergeTaskIntoList` 原位替换/尾插/不改入参；`describeTaskNotice` 各迁移文案与静默规则；`extractOrchestrationEnabled`。

## 四、验证证据（共享树；兄弟切片 luban/244b46e4、luban/7b9f5cfe 在途）

| 项 | 命令 | 结果 |
|---|---|---|
| 新增前端测试 | `npx vitest run src/components/agent/TaskPanel.test.tsx src/hooks/useAgentSessions.tasks.test.ts` | 25/25 ✅ |
| 根 `npm test` | 23 文件 223 用例 | 222 ✅ + 1 失败 = `client.test.ts` device auth 断言：兄弟在 client.ts 加了 `scopeSet`（git diff 归因，非本切片写面），测试未同步 |
| 根 typecheck | `npx tsc -p tsconfig.json` | 本切片 9 文件 0 error；余 3 error 全在 `SourceEditControls.tsx`（兄弟未跟踪新文件，StatusBadge title prop） |
| server typecheck | `cd server && npx tsc --noEmit` | exit 0 |
| eslint | 涉改 9 文件 | 0 error 0 warning ✅ |
| 真机交互 | 见 §二 | 9 项操作序列 + 6 截图 ✅ |

## 五、未覆盖项与偏差

1. **task_* 工具折叠行图标**：MessageStream 的 ToolRow 对 `task_*` 前缀换 ListTodo 图标已实现并有静态渲染覆盖，但**真机未见真实 task_* 工具事件**（临时环境无模型，父会话无法发起 run）——该路径经既有 tool 事件管线（S1/F2 已回归），标注为代码级验证。
2. **queuePosition 并发递减**：仅静态断言「排队 #N」渲染；多任务出队时序属 S6 后端语义（其测试已覆盖），UI 只消费 DTO。
3. **作答表单提交成功后的清空**依赖任务离开 blocked 态使表单卸载；若后端 resume 返回仍 blocked（不应发生，S6 契约 queued）则草稿保留供重试——按失败路径保守处理。
4. **单任务详情轮询**：无 `getAgentTask` 的 UI 调用点（列表 + task_update 已覆盖刷新面）；client 导出为后续扩展预留，未删。
5. SSE 断线期间的任务列表恢复：会话切换时整表重拉兜底，断线中新增任务靠重连后 task_update/切换补齐（与 approvals 面同策略）。

## 六、回滚

- 删除新增文件：`TaskPanel.tsx`/`TaskPanel.test.tsx`/`useAgentOrchestration.ts`/`useAgentSessions.tasks.test.ts`。
- 追加段反向摘除：`useAgentSessions.ts`（task 状态/纯函数/SSE case/cancel+resume/返回项，均 S7 注释锚）、`MessageStream.tsx`（taskNotices prop+渲染、ToolRow 图标分支）、`AgentView.tsx`（右栏容器与 TaskPanel/props、orchestration hook 行）、`types/agent.ts`（任务段+事件联合行）、`client.ts`（任务 API 块+import 行）。
- 共享文件（client.ts/useAgentSessions.ts/MessageStream.tsx/AgentView.tsx）同时含 S10 等兄弟改动，整文件回滚需合并窗口协调，逐段摘除以本报告 §一 为锚。
- 无 DB/配置面改动；验证用的临时 FEISHU_SYNC_HOME 已按文件逐一清理。
