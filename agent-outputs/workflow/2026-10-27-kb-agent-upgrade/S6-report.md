# S6 报告：任务编排后端（Leader 工具 + agent_tasks + 角色卡）

任务：设计 §5.1–5.5 的 v1 最小闭环（U11）——`agent_tasks` 表 + TaskService 状态机、RoleRegistry + 内置角色卡、`task_*` 工具族、子任务进程（池后台配额）、任务 API + `task_update` SSE、插件配置项「任务编排」、build-agent-assets roles 复制；构建触发留 `app_command kb.build` 调用点。

上游输入：`docs/design/kb-agent-upgrade-design.md` §5/§8/§10/§13、`S1-report.md`（工具族注册 + `acquire('background')` 接口）、`server/src/agent/app-plugin-store.ts`。

## 一、改动清单

| 文件 | 改动 | 性质 |
|---|---|---|
| `server/src/agent/roles/kb-analyst.md` / `kb-converter.md` / `kb-reviewer.md`（新） | 三张内置角色卡（frontmatter + 子任务系统提示正文） | 新增 |
| `server/src/agent/tasks/role-registry.ts`（新） | 角色卡装载：dist→src 候选目录、frontmatter 解析（简单 YAML 子集）、符号链接拒绝、非法卡跳过+告警 | 新增 |
| `server/src/agent/tasks/task-service.ts`（新） | TaskService：状态机/调度/marker 协议/nudge/取消/作答/重启对账/生产 spawn | 新增 |
| `server/src/agent/tasks/task-tools.ts`（新） | `task_*` 工具族（经 S1 `registerToolFamily`）+ `LEADER_ORCHESTRATION_PROMPT` | 新增 |
| `server/src/agent/tool-specs.ts` | 追加 4 个 TASK_*_SPEC + `TASK_TOOL_FAMILY_NAME`/`TASK_TOOL_NAMES` | 追加 |
| `server/src/agent/agent-tool-service.ts` | `RunContextOptions.allowedToolsOverride`（子任务冻结集，剔除 task_*/app_command/未知工具）+ `disableToolFamilies`（编排关闭会话按族剔除）+ `registeredToolNames()`；`createRunContext` 白名单推导扩展，默认路径逐字不变 | 追加 |
| `server/src/agent/app-plugin-store.ts` | defaults 追加「任务编排」条目（scopes discuss/work，**默认停用**，content=Leader 编排提示，可 overrides 覆盖）；overrides id 白名单 +`orchestration`；新增 `frozenSnapshot(scope, revision)` 按不可变快照文件复用 | 追加 |
| `server/src/agent/session-service.ts` | deps +`taskTools`（spawn 时求值：编排开启→`--tools` 追加 task_*；关闭→`disableToolFamilies:['task']`）+`onSessionDeleted`（会话删除→取消其非终态任务） | 追加 |
| `server/src/modules/local-map-store.ts` | `agent_tasks` 表 DDL **双登记**（`getCreateTablesDDL` + `applyAdditiveMigrations` 末尾幂等段）+ 6 个访问器（create/get/update/listBySession/listByIds/markInterrupted） | 追加 |
| `server/src/types/agent-knowledge.ts` | `AgentTaskStatus`/`AGENT_TASK_TERMINAL_STATUSES`/`AgentTaskDto`/`AgentOrchestrationConfig`+默认构造、`AgentRunKind`+`'task'`（`toolsForRunKind('task')=[]`）、`AgentConfig.orchestration` | 追加 |
| `server/src/modules/config-manager.ts` | `normalizeOrchestrationConfigLoose`（宽容）+ `validateAgentAndKbConfig` orchestration 段（严格） | 追加 |
| `server/src/routes/agent.ts` | 任务路由段（见 §四）+ deps `taskService?` | 追加 |
| `server/src/index.ts` | RoleRegistry/TaskService 构造、task_* 族注册、启动对账、sessionService 挂 taskTools/onSessionDeleted、agentRoutes 注入 | 追加 |
| `server/scripts/build-agent-assets.mjs` | roles 目录复制条目（实测 copied 3 role card(s)） | 追加 |
| `server/tests/agent-tasks.test.ts`（新） | 17 用例（§五验收行全覆盖） | 新增 |
| `server/tests/app-plugins.test.ts` | 插件计数 4→5（2 处，S6 新增 orchestration 条目） | 随基线同步 |

## 二、状态机（server 权威，落 `agent_tasks.status`）

```
                ┌──────────── cancel（任意非终态）─────────────┐
                ▼                                              ▼
queued ─acquire('background')→ running ─DONE marker─→ done   cancelled
  ▲                              │
  │                              ├─BLOCKED marker─→ blocked ─task_resume / API resume（用户作答）→ queued
  │                              └─错误 / 两轮缺 marker → failed（task_contract_missing 等）
  │
  └ server 启动对账：queued/running → interrupted（blocked 保留可作答）
```

- 终态 = `done|failed|cancelled|interrupted`；`blocked` 非终态（可作答）。
- 每轮（初始轮/resume 轮/nudge 纠正轮各计 1）结束即回收子任务进程、槽位还给后台配额；resume 用同 `--session-id` 重建进程（pi JSONL 上下文延续），且 resume prompt 自包含（任务原文 + 作答）防恢复失败。
- 排队等待槽位时取消 → AbortController 出队，不占位；运行中取消 → `rpc.abort()`，终态守卫防覆盖已落 cancelled。
- 单轮超时 `agent.orchestration.taskTimeoutMinutes`（默认 30，1..1440）→ `failed(model_timeout)`；池关闭等启动前异常 → `interrupted(agent_pool_closed)`。
- 每会话非终态 ≤ `maxActiveTasksPerSession`（默认 8，1..32）→ `task_queue_full`。

## 三、工具参数面（§5.2；S1 族注册，白名单/规格/403 消息自动一致）

| 工具 | 参数 | 返回 |
|---|---|---|
| `task_submit` | `{ role: 'kb-analyst'\|'kb-converter'\|'kb-reviewer'; title: 1..80; task: 1..20000; outputDir?: string }` | `{ taskId, status: 'queued'\|'running', queuePosition }` |
| `task_query` | `{ taskIds?: string[](≤32，缺省=本会话全部); wait?: { mode:'any'\|'all'; timeoutSeconds:1..600 } }` | `{ tasks: AgentTaskDto[]; timedOut }` |
| `task_resume` | `{ taskId; message: 1..20000 }` | `AgentTaskDto`（仅 blocked，否则 409 `task_not_blocked`） |
| `task_cancel` | `{ taskId }` | `AgentTaskDto`（终态再取消 409 `task_not_active`） |

- 下发条件：**仅编排启用**（插件条目 orchestration enabled）的 Discuss/Work 会话；SessionService spawn 时求值——开启→`--tools` 追加 4 个 task_*；关闭→`createRunContext({disableToolFamilies:['task']})` 整族剔除。插件开关变更 → 快照 revision 变化 → 下一 run 自动换进程/换令牌。
- **子任务无 task_***：族 runKinds 只含 discuss/work；且子任务上下文走 `allowedToolsOverride`，即使冻结集混入 task_*/`app_command` 也会被显式剔除（depth=1 防递归 + 防自我提权，T0c #2/#3）。
- 授予工具 = 角色请求 ∩ `toolsForRunKind(父模式)` ∩ `registeredToolNames()`（如 raw_read_image 未注册则自然缺位）；空集 → `task_role_not_allowed_in_mode`。授予含 ws_write/ws_edit/ws_mkdir → outputDir 必填；该任务 ws 写入根收窄为 `<workspace>/<outputDir>`（PathGuard 以其为根）。
- `wait` 工具内轮询阻塞（200ms），落定 = 状态 ∉ {queued,running}（blocked 视为落定，Leader 应把 questions 转呈用户）。
- marker 协议：末行 `<!--FS:DONE-->`→done（result 剥离 marker）；首行 `<!--FS:BLOCKED-->`+`QUESTIONS:`→blocked；缺 marker→一次 nudge→仍缺 `failed(task_contract_missing)`。
- 新错误码：404 `task_not_found`/`task_role_not_found`、403 `task_role_not_allowed_in_mode`/`orchestration_disabled`、409 `task_queue_full`/`task_not_blocked`/`task_output_dir_overlap`/`task_not_active`、400 `task_output_dir_required`/`task_output_dir_invalid`、（终态内）`task_contract_missing`/`agent_pool_closed`。

## 四、S7 UI 契约（API + SSE）

**API**（desktop auth 后；`routes/agent.ts` 追加段）：

| 方法 | 路径 | 请求 → 响应 |
|---|---|---|
| GET | `/api/agent/tasks?sessionId=` | → `{ tasks: AgentTaskDto[] }`（sessionId 必填） |
| GET | `/api/agent/tasks/:id` | → `AgentTaskDto`（404 task_not_found） |
| POST | `/api/agent/tasks/:id/cancel` | → `AgentTaskDto`（终态 409 task_not_active） |
| POST | `/api/agent/tasks/:id/resume` | `{ message }` → `AgentTaskDto`（非 blocked 409 task_not_blocked） |
| GET | `/api/agent/tasks/:id/messages` | → `{ messages: AgentMessageDto[] }`（解析子任务 JSONL，同会话历史格式） |

**SSE**：父会话事件流新增 `task_update`，data=`AgentTaskDto`（每次状态迁移、rounds 变化、截断结果更新都会推；沿用既有 Last-Event-ID 续传/溢出 resync 语义）。

**AgentTaskDto**：`{ id, sessionId, role, title, status, queuePosition(queued 时会话内 1 起排队序,否则 null), rounds, outputDir, questions, result, resultTruncated, error:{code,message}|null, createdAt, startedAt, finishedAt }`。result 库内 ≤64KB（超限截断并置 resultTruncated）；`task_query`/`waitFor` 工具投影截断 20000 字符。

**编排开关**：插件面板「任务编排」条目（PUT `/api/agent-plugins/orchestration`，enabled/content 可调，沿用 expectedRevision 乐观锁）——S7 直接复用现有插件管理 UI 面，不需要新设置项。

## 五、验证证据（共享树；兄弟切片 S2/S4/S8/S9/S10 在途）

| 项 | 命令（cwd=server） | 结果 |
|---|---|---|
| 新增假 pi 回归 | `npx vitest run tests/agent-tasks.test.ts` | **17/17 ✅**（DONE→done、BLOCKED→resume→done、缺 marker→nudge→failed、运行中取消、排队中取消+queuePosition、重启→interrupted（blocked 保留）、outputDir 必填/互前缀拒绝/终态释放、converter 模式检查、编排关闭 403+族剔除、子任务 override 剔除 task_*/app_command+执行面 403、task_query 截断投影、waitFor any/all、task_queue_full、角色卡装载/符号链接/frontmatter、AppPluginStore 开关+frozenSnapshot） |
| 共享文件回归 | `npx vitest run tests/local-map-store.test.ts tests/config-manager.test.ts tests/agent-internal-auth.test.ts tests/app-plugins.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/agent-tool-families.test.ts tests/agent-config.test.ts tests/agent-process-pool.test.ts` | 全绿 ✅（含 S1 白名单逐字基线与 buildServer 路由级测试） |
| 全量 `npm test` | 1111+ 用例 | 本切片写面内全绿；失败项 4 个文件（kb-version/kb-build-units/provider-protocol-live/cli-args）全部为 S4/S9 在途未完成代码（`kb_unit_failed` 出自 S4 未跟踪的 build-units.ts/path-claims.ts 新流水线；git status 归因），非 S6 回归 |
| `npx tsc --noEmit` | server 全量 | **0 error** ✅ |
| eslint（涉改 12 个 TS 文件） | `npx eslint …` | 0 error 0 warning ✅ |
| 资产构建 | `node scripts/build-agent-assets.mjs` | `copied 3 role card(s)` ✅ |

## 六、偏差与说明

1. **`agent_tasks` additive 列**：设计 §5.4 DDL 之外新增 `pi_session_file`（子任务 JSONL 定位，同 agent_sessions 模式）、`resume_answers_json`（作答持久化——blocked 跨重启可作答，resume prompt 自包含）、`result_truncated`（64KB 截断标记）。均为新表内 additive，旧版本忽略。
2. **系统提示传递**：pi RPC 无独立 system prompt 通道（与构建流水线一致），角色正文+公共子任务契约作为首轮 prompt 前缀下发；isolated 上下文（T0c #4），Leader 负责把上下文写进 task 文本。
3. **queuePosition 口径**：设计未定义；取「会话内 queued 排队序（created_at,id 字典序，1 起）」，仅 queued 态非空。
4. **插件快照冻结**：submit 时取父会话 scope 快照 revision 存 `plugin_revision`；spawn 经 `AppPluginStore.frozenSnapshot` 复用不可变快照文件（快照目录被清理时降级为不注入并继续）。
5. **触发构建接线（任务书第 7 项）**：TaskService 不提供任何构建入口；`app_command kb.build` 已由 S10 的 ops 族注册（index.ts 中 `createOpsToolFamily`），Leader 提示词明文约束「构建只能经 app_command kb.build」。S10 完成后本切片无需改动即生效。
6. **子任务工具事件不进父 SSE**：v1 只推 `task_update`；子任务过程可经 `GET /tasks/:id/messages` 查看。范围外发现，未处理。

## 七、回滚

- 删除新目录 `server/src/agent/tasks/`、`server/src/agent/roles/`、`server/tests/agent-tasks.test.ts`。
- `agent_tasks` 表可直接 DROP（无既有消费方）；或保留（旧版本忽略）。
- 共享文件按 §一表格反向摘除 S6 标注段（index.ts 的 tasks 容器/族注册/对账、session-service 两 deps、routes 任务段、local-map-store DDL×2+访问器、config-manager orchestration 两段、types orchestration/task 段、tool-specs 4 SPEC、app-plugin-store orchestration 条目+frozenSnapshot、build-agent-assets roles 段、app-plugins.test 计数还原 5→4）。
- 注意共享文件同时含 S2/S4/S8/S9/S10 在途改动，整文件回滚需在合并窗口协调；逐段摘除以 S6 注释为锚。
