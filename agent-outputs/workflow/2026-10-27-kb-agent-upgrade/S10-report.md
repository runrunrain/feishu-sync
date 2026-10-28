# S10 报告：app_command 工具 + 会话内批准流

上游输入：`docs/design/kb-agent-upgrade-design.md` §6.5/§6.3/U14/U15（权威定义）、`agent-outputs/workflow/2026-10-27-kb-agent-upgrade/S8-report.md`（命令表/CLI 执行器形态）、`server/src/ops/command-table.ts`（25 条命令数据面）、S1-report（工具族注册模型）。

## 一、产物清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `server/src/agent/approvals/approval-service.ts` | 新增 | ApprovalService：批准请求产生（SSE approval_request）、decide、超时（默认 10 分钟）、cancelForSession/close、审计行 |
| `server/src/agent/tools/app-command-family.ts` | 新增 | ops 工具族 `createOpsToolFamily(deps)`：裁决链（agentExposed → Discuss 只读 → Schema 校验 → confirm 剔除 → read 直通/非 read 批准）、进程内执行（app.request + desktopToken，与 S8 CLI 同构）、结果截断 ≤20000、确认值批准后注入 |
| `server/src/agent/tool-specs.ts` | 追加 | `APP_COMMAND_SPEC`（描述由 OPS_COMMANDS 生成，单一真相源；S13 加命令自动进描述）；补 S3/S4 兄弟切片漏加 ALL_SPECS 的 `RAW_READ_IMAGE_SPEC`/`KB_UNIT_DONE_SPEC` 两行 |
| `server/src/types/agent-knowledge.ts` | 追加 | `app_command` 进 DISCUSS_TOOLS/WORK_TOOLS（pi `--tools` 参数面；Build/Task 不下发） |
| `server/src/agent/agent-tool-service.ts` | 追加 | `summarizeArgs` 增 `app_command` 分支（SSE tool 事件摘要显示命令名） |
| `server/src/routes/agent.ts` | 追加 | `GET /api/agent/sessions/:id/approvals`、`POST …/approvals/:approvalId/decide`；`AgentRouteDeps.approvalService?` |
| `server/src/index.ts` | 追加 | ApprovalService 构造（emit → SessionService.emitSse 并入会话 SSE 流）、ops 族注册、`run_end → cancelForSession` 接线、close() 收尾、`__approvalService`/`__agentSessionService` 测试出口 |
| `src/types/agent.ts` | 追加 | `AgentApprovalDto`/`AgentApprovalRisk`/`AgentApprovalOutcome`；AgentSessionEvent 联合增 approval_request/approval_resolved |
| `src/api/client.ts` | 追加 | `listAgentApprovals` / `decideAgentApproval` |
| `src/hooks/useAgentSessions.ts` | 追加 | approvals 状态、SSE approval_request/resolved 处理、会话切换恢复 pending 列表、`decideApproval`（busy 防双击、失败进 streamErrors） |
| `src/components/agent/ApprovalCard.tsx` | 新增 | 批准卡片：命令名/风险级徽标/参数摘要/超时倒计时（秒级刷新）/批准/拒绝（超时与裁决中禁用） |
| `src/components/agent/MessageStream.tsx` | 追加 | 可选 props `approvals`/`onApprovalDecision`/`approvalBusyId`；消息流内渲染批准卡片（tool 行由既有 draft.tools 呈现执行结果） |
| `src/views/AgentView.tsx` | 2 行 | MessageStream 调用点传入批准 props（见 §五偏差 4） |
| `server/tests/approval-service.test.ts` | 新增 | 9 用例：DTO 形状/SSE/审计、approve/reject、重复裁决 409、跨会话 404、非法 decision 400、超时、cancelForSession、close |
| `server/tests/app-command-family.test.ts` | 新增 | 20 用例：read 直通（discuss/work）、上游错误透传、挂起→拒绝→零执行、批准→执行→confirm 注入、超时不执行、模型 confirm 剔除、Discuss 不见 mutate/destructive、agentExposed=false 403、mock 命令表接线（S6 形态）、白名单、参数校验、截断、SSE tool 事件、纯函数 |
| `server/tests/agent-approvals-routes.test.ts` | 新增 | 5 用例（buildServer 集成）：approvals 列表/decide/SSE 缓冲事件序列/审计行/run_end 取消接线 |
| `src/components/agent/ApprovalCard.test.tsx` | 新增 | 7 用例：命令/风险/摘要/倒计时/按钮、destructive 徽标、超时禁用、busy 禁用、formatCountdown |
| `server/tests/agent-tool-families.test.ts` | 同步 | 白名单断言由冻结字面量改为「pi 参数面派生 + S1 基线子集保留」（S3/S4/S6/S10 并行加工具使字面量快照失效） |
| `server/tests/agent-internal-auth.test.ts` | 同步 | discuss 规格下发断言由冻结 4 工具改为「基线 4 只读 + app_command 在场，ws_/构建写工具绝不下发」（同一原因） |

## 二、批准流时序

```
模型(pi 会话进程)
  │ tool_call: app_command { command:'kb.build', args:{mode:'full', confirm:'BUILD'} }
  ▼
转发扩展 POST /api/agent-internal/tools/app_command（run token）
  ▼ AgentToolService.executeTool（白名单 403 / SSE tool start 事件）
  ▼ ops 族 execute
  ├─ findCommand → agentExposed? → runKind!=='work' && risk!=='read' → 403 command_not_allowed
  ├─ stripConfirmArgs（confirm/confirmation 一律剔除；确认只能来自人类点击）
  ├─ validateOpsArgs（命令表 JSON Schema：required + 声明类型）
  ├─ fillDefaults → def.request(args) → OpsRequestSpec[]
  ├─ risk==='read' ──────────────────────────────→ 直接执行
  ├─ risk!=read：ApprovalService.begin
  │    ├─ SSE approval_request(DTO) → 前端 MessageStream 批准卡片（倒计时）
  │    ├─ 审计 approval_requested → <dataRoot>/agent/audit/<sessionId>.jsonl
  │    └─ 挂起等待（≤10 分钟）
  │         ├─ POST /api/agent/sessions/:id/approvals/:approvalId/decide {decision}
  │         │    ├─ approve → SSE approval_resolved → 注入 confirm 值 → 执行 → SSE tool end
  │         │    └─ reject  → SSE approval_resolved → ToolError approval_rejected(403)
  │         ├─ 10 分钟无人处理 → approval_timeout(408)
  │         └─ run_end（用户中止/会话结束；index.ts 监听）→ approval_cancelled(409)
  ▼
执行 = app.request() 携 desktop token 穿透目标路由（不走网络），
       复用既有路由校验/错误语义；结果 JSON 截断 ≤20000 字符；
       多步命令逐步执行按 key 聚合（status 命令），单步失败透传目标错误码。
```

## 三、工具参数面

```jsonc
// APP_COMMAND_SPEC（tool-specs.ts，描述由 OPS_COMMANDS 生成）
{
  name: 'app_command',
  parameters: {
    command: { type: 'string' },   // 命令名；未知 → 404 unknown_command
    args: { type: 'object' },      // 命令参数；按命令表 params 校验（invalid_args 400）
  },                               // confirm/confirmation 传入即剔除（工具描述内明示）
  required: ['command'], additionalProperties: false
}
```

- 可见面：Discuss+Work（族 runKinds）；执行面门控：Discuss 仅 read（403 先于批准请求）；Build/Task 不注册（S6 的子任务白名单另显式剔除 app_command，见其 `computeAllowedTools`）。
- agentExposed=false（含秘密命令，如设计的 llm.set-key）→ 403 command_not_allowed，不产生批准请求。
- 风险级与确认值取自命令表（S8）；批准后 server 注入 `body[confirm.field]=confirm.value`（表内已烘入的幂等覆盖，漏烘条目兜底）。

## 四、S7/UI 集成点

- SSE：`approval_request`（负载即 ApprovalRequestDto）与 `approval_resolved`（`{id, decision: approve|reject|timeout|cancelled}`）并入既有会话流（`GET /api/agent/sessions/:id/events`），走同一 1000 条环形缓冲与 Last-Event-ID 续传。
- `useAgentSessions`：事件驱动增删 `approvals`；会话切换时 `GET /approvals` 恢复断线期间的挂起卡片；`decideApproval` 提交裁决（busy 防双击、失败呈现错误行）。
- `MessageStream`：批准卡片渲染在流式草稿之后（`data-testid="approval-list"`）；执行结果由既有 tool 行（draft.tools / 历史 tool 消息）呈现，`app_command` 的 argsSummary 为命令名+参数摘要。
- `AgentView` 传参（2 行）；未动设置页（S9 写面）。

## 五、偏差与决策

1. **decide 路由**：任务书 `POST …/approvals/:approvalId/decide`（正文冻结）；设计 §6.5 原文为 `POST …/approvals/:approvalId`（body 带 decision）。按任务书实现。
2. **会话中止错误码**：设计只给了 approval_timeout/approval_rejected 两个码；会话结束/中止取消映射为 `approval_cancelled`(409)（超时才是 approval_timeout(408)，拒绝是 approval_rejected(403)），SSE approval_resolved 的 decision 同步扩展 4 值。
3. **Discuss「不见」mutate 的语义**：S1 族模型中工具 spec 是跨 runKind 静态常量，无法按 runKind 下发不同描述清单；实现为——工具描述内分组标注（read 全模式 / mutate+ 仅 Work 需批准）+ 执行层 403 门控（不产生批准请求）。规格面的按模式动态清单需要族模型扩展，未在本切片越界实现。
4. **AgentView.tsx 2 行改动**：任务书写面是 `src/components/agent/`；MessageStream 新 props 需在调用点接线才有真实链路，属会话页最小接线（未触设置页）。
5. **审计行格式**：沿用基线 §9.6 会话审计文件 `<dataRoot>/agent/audit/<sessionId>.jsonl`，行格式与 auditWork 同构（at/sessionId/tool/path/bytes/result）外加 risk/argsSummary；批准生命周期（requested/approved/rejected/timeout/cancelled）与执行结果（executed + httpStatus）各一行。
6. **重复裁决**：decide 后记录保留（decided 标记），二次裁决 → 409 approval_already_decided（区别于 404 不存在）。
7. **共享树撞写处理**（详见 §七）：
   - 兄弟切片在块注释里写 `task_*/app_command`——`*/` 提前闭合注释产生语法错误，阻塞全 server 编译；做了 3 处纯注释修复（`task_* 与 app_command`）：agent-tool-service.ts 1 处、task-service.ts 2 处（sed）。
   - S3/S4 的 `RAW_READ_IMAGE_SPEC`/`KB_UNIT_DONE_SPEC` 已定义并注册但漏加 tool-specs.ts 的 ALL_SPECS（共享 spec 测试失败）；各补 1 行登记。
   - S6 曾把 task-tools.ts 写坏（字面 `\n` 转义），未代为修复——其自行在 17:16 修复。
   - agent-tool-families.test.ts 的冻结字面量快照在 S3/S4/S6/S10 四个切片同时追加工具后失效；改为「pi 参数面派生 + S1 基线子集保留」断言（不再需要每个切片改字面量）。

## 六、验证证据（共享树，兄弟切片在途）

| 验证 | 命令 | 结果 |
|---|---|---|
| ApprovalService 单元 | `cd server && npx vitest run tests/approval-service.test.ts` | 9/9 ✅ |
| app_command 族 | `npx vitest run tests/app-command-family.test.ts` | 20/20 ✅ |
| 批准 API+SSE 集成 | `npx vitest run tests/agent-approvals-routes.test.ts` | 5/5 ✅（buildServer 真实入口：列表/decide/SSE 事件序列/审计/run_end 取消） |
| 共享白名单测试 | `npx vitest run tests/agent-tool-families.test.ts` | 15/15 ✅ |
| Agent 回归面 | `npx vitest run tests/agent-internal-auth.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/kb-build.test.ts` | 70/70 ✅ |
| server 全量 | `cd server && npm test` | 1092/1111 ✅；19 失败全部在 kb-version(16)+provider-protocol-live(3)，均为 S4 在途 kb-build-service.ts 重写（+934 行，git 归因）所致：旧 fixture stub `spawnBuildProcess` 不再被新 worker 路径调用 → agent_not_ready；新 kb_unit_done 协议与旧 fixture 不匹配 → kb_unit_failed。与本切片写面零交集 |
| server typecheck | `cd server && npx tsc --noEmit` | exit 0（全项目，含兄弟当前态） |
| 前端全量 | 根 `npm test` | 173/173 ✅（含 ApprovalCard 7） |
| 根 typecheck | `npm run typecheck` | 失败项全部在 S4 kb-build-service.ts（在途 TS6133/TS2741）；本切片前端写面 0 error |
| eslint | 19 个涉改文件 | 0 error 0 warning ✅ |

任务书验收行逐条对照：read 直通✅（app-command-family 2 用例）；mutate 未批准不执行（挂起→拒绝→错误、目标路由零命中）✅；批准→执行→结果返回✅；模型 confirm 剔除✅（stripConfirmArgs 纯函数 + 注入测试）；超时✅（approval_timeout，短超时用例）；Discuss 不见 mutate 命令✅（403 且无批准请求，discuss/destructive 双用例）；SSE 事件序列✅（approval_request→approval_resolved 在会话流缓冲断言）；审计行✅（生命周期 + executed 两类行落盘断言）；含秘密命令不暴露✅（agentExposed=false mock 403）。

未验证项：真机 Electron 浏览器交互（批准卡片点击链路）——静态渲染 + hook 事件流已锚定，UI 点击实测待合并后真机验证（共享树无法单独打包）；pi 进程内真实 app_command 调用需 Node/pi 运行时完整环境，以进程内 app.request 同构的 S8 CLI 执行器实测路径为准。

## 七、共享树撞写与回滚

- 撞写时间线：17:12 agent-tool-service.ts（S6 注释语法）、17:14 task-service.ts（同型 2 处）、17:15 tool-specs.ts ALL_SPECS（S3/S4 漏登记）、17:16 task-tools.ts（S6 自修复）。本切片修复均为单行、无语义变化、带本报告记录。
- 回滚：删除 `approvals/`、`tools/app-command-family.ts`、三个 server 测试文件、`ApprovalCard.tsx`+测试；反向摘除 tool-specs.ts（APP_COMMAND_SPEC 块 + ALL_SPECS 一行）、types/agent-knowledge.ts（TOOLS 常量 app_command）、agent-tool-service.ts（summarizeArgs 分支）、routes/agent.ts（批准路由块）、index.ts（S10 标注区段）、src 侧五文件追加段。均为追加式，无交织改写。
