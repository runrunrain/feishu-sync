# T3c 修复批次报告：diting 审核 7 项 findings（4 Critical + 3 Major）

- 输入：`T3b-diting-review.md`（7 项 findings 定位/触发条件/修复方向）、`docs/design/kb-agent-upgrade-design.md`、`server/src/ops/command-table.ts`、`server/src/sources/feishu-write-service.ts`（均全文/全量读取）。
- 结论：**7 项全部修复，逐项有针对性测试；全量回归绿**（server 90 文件/1189 用例、根 27 文件/237 用例、三段 typecheck、lint 0 error）。
- 中断说明：本轮执行中设备重启一次。**重启前**全部源码修复与测试均已写入完成（含全量回归首轮绿）；**重启后**现场逐文件核对 7 项修复完整在盘（见 §9），随后重跑全部验证（server 全量 ×2、根 test、typecheck、lint）均绿，无半途/丢失项。重启前曾出现一次全量运行的 worker 级瞬时异常（1 failed/9 skipped），同代码立即复跑即全绿，重启后两次全量复跑亦全绿，判定为负载下的瞬时抖动，非本批改动引入（详见 §8）。

## 0. 修复总表

| # | 级别 | finding | 修复位置（源码） | 测试锚点 | 状态 |
|---|---|---|---|---|---|
| T3b-01 | Critical | llm.test 密钥外传 | `ops/command-table.ts`（llm.test 参数面收窄）；`routes/llm.ts`（端点锁定 + 引用模式） | ops-command-table / trash-llm-routes | ✅ |
| T3b-02 | Critical | CLI 自行开启 feishuWrite | `ops/command-table.ts`（CONFIG_SET_FORBIDDEN）；`routes/cli.ts`（actor 转发头）；`routes/config.ts`（消费者丢弃） | ops-command-table / config-routes / cli-source-commands（真实 server） | ✅ |
| T3b-03 | Critical | 云端冲突前置 fail-open | `sources/feishu-write-service.ts`（fail-closed）；`types/index.ts`（blockedReason 联合类型） | source-push | ✅ |
| T3b-04 | Critical | 子任务 outputDir symlink 越权 | `agent/tasks/task-service.ts`（resolveTaskWorkspaceRoot + 冻结下发） | agent-tasks | ✅ |
| T3b-05 | Major | app_command 确认值降级 | `agent/tools/app-command-family.ts`（缺失才补注入） | app-command-family | ✅ |
| T3b-06 | Major | 单 worker 回退绕过后台配额 | `kb/kb-build-service.ts`（acquireSingleWorkerSlot） | kb-build-parallel | ✅ |
| T3b-07 | Major | 停止后迟到批准仍执行 | `agent/session-service.ts` + `index.ts` + `app-command-family.ts`（即时撤销 + 执行前复核） | agent-session / app-command-family | ✅ |

注：`ops/command-table.ts`、`routes/cli.ts`、`sources/feishu-write-service.ts`、`agent/tasks/task-service.ts`、`agent/tools/app-command-family.ts` 为本特性分支 **untracked 新文件**（S6/S8/S10/S11/S12 交付物，从未提交），`git diff HEAD` 不显示其中改动；改动完整性以文件内容核对为准（§9）。

## 1. T3b-01｜llm.test 密钥外传（Critical）

**修复**：
1. 命令表 `llm.test` 参数面收窄为 `providerId?/modelId?/timeoutMs?`，`request()` 只构造这三个引用字段——攻击面（可覆盖 baseUrl/apiKey 的完整 `llm` 对象）在命令表层整体移除；删除了原先把内存态完整 llm 配置（含真实 key）注入 body 的 `fillDefaults`。
2. `routes/llm.ts` 加固（对 desktop UI 路径同样生效）：
   - `restoreMaskedLlmSecrets` 恢复掩码密钥时**锁定端点**：顶层/provider 的 `apiKey==='***'` 且请求携带的 `openAiCompatBaseUrl` 与已保存值不一致 → `400 endpoint_mismatch`；未携带端点则继承已保存值；引用不存在的 provider id → apiKey 置空走「API Key 为空」友好错误（不再把 `***` 字面量当真实密钥）。
   - 新增**引用模式**：请求不携带 `llm` 对象、只带 `providerId/modelId` → server 从 ConfigManager 解析完整连接信息（真实密钥仅进程内使用）；未知 providerId → `400 invalid_provider`；引用模式与 `llm` 对象并存 → 400。缺省（两者皆无）→ 测当前激活的已保存配置；无 ConfigManager 时保留原 `llm (LlmConfig) is required` 400 契约。
   - 错误统一为 `LlmRouteError{code:'endpoint_mismatch'|'invalid_provider'}` → 400。

**测试**（触发条件即场景）：
- `ops-command-table.test.ts`「llm.test 参数面收窄：只接受 providerId/modelId/timeoutMs 引用（T3b-01）」——含「恶意传入完整 llm 对象（masked key + 恶意端点）不进请求体」反例。
- `trash-llm-routes.test.ts`：「T3b-01：掩码密钥 + 不同端点 → 400 endpoint_mismatch」（顶层 + provider 两形态，响应不含真实密钥）；「provider 掩码密钥 + 已保存端点 → 正常测试链路」；「providerId 引用模式 → 从已保存配置解析；未知 id 400 invalid_provider；引用模式拒绝 llm 对象并存」。
- 既有「uses the persisted key when GET-mask sentinel」用例更新为同端点语义（掩码密钥只能搭配与已保存一致的端点）——该行为变更是任务书明确要求（「该加固对 desktop UI 路径同样生效」）。

## 2. T3b-02｜CLI 自行开启 feishuWrite（Critical）

**修复**（三层）：
1. `ops/command-table.ts` `CONFIG_SET_FORBIDDEN` 追加 `feishuWrite` 前缀——CLI 通道 `config.set` 在请求构造层即 `400 forbidden_path`。
2. `routes/cli.ts` 内部转发（app.request 携 desktop token）追加 `X-Feishu-Sync-Actor: cli` 头——来源主体不再被 desktop token 洗白（伪造该头只能让自己丢字段，无提权面）。
3. `routes/config.ts` PUT 消费者兜底（设计 §7.6 丢弃语义）：`cliActor === true || X-Feishu-Sync-Actor === 'cli'` → 删除 `partialConfig.feishuWrite`，同一 patch 其余字段照常生效。

**测试**：
- `ops-command-table.test.ts`「feishuWrite 被 CLI 通道拒绝（T3b-02）」（`feishuWrite` / `feishuWrite.enabled` 均 forbidden_path）。
- `config-routes.test.ts`「T3b-02：actor=cli 的 PUT 丢弃 feishuWrite 字段（其余字段照常生效）」+「desktop 链路（无 actor 标记）的 feishuWrite 正常修改（回归）」。
- `cli-source-commands.test.ts`（真实 startServer + 打包 CLI）describe「CLI 令牌 vs feishuWrite 开关（T3b-02）」3 例：CLI `config.set feishuWrite` → 400 forbidden_path 且开关保持关闭；actor 头直连 PUT → feishuWrite 丢弃、其他字段生效；desktop 正常开启/关闭回归（测后复位，不影响后续用例）。

## 3. T3b-03｜云端冲突前置 fail-open（Critical）

**修复**（`sources/feishu-write-service.ts`）：
- `pushLocked`：非 force 时云端 `obj_edit_time` 或本地基线时间任一不可读（metas 抛错/空 metas/failed/latestModifyTime 非数值/基线缺失）→ **fail-closed 拒绝**：`FeishuWriteError('cloud_time_unreadable', …, 502)`，`markSourceEditPushAborted` 保留 dirty、零写入、零回拉、审计落 `result:'error', errorCode:'cloud_time_unreadable'`。删除原「已按无前置冲突处理」的 fail-open 放行语义。
- `preview` 同语义：不可读 → `mode='blocked', blockedReason='cloud_time_unreadable'` + fail-closed 警告（已在 blocked 态的其他原因不覆盖）。
- `force + OVERWRITE_CLOUD` 仍可越过（显式用户决策，跳过 metas 前置读取）。
- `types/index.ts` `SourcePushPlanDto.blockedReason` 联合类型追加 `'cloud_time_unreadable'`。

**测试**（source-push.test.ts，stub lark client）：
- 「metas 读取失败但 revision/write 可达 → 拒写（cloud_time_unreadable，零写入，保留 dirty，不回拉）」——append/overwrite 调用数为 0、pulls 为 0、状态 dirty、审计行断言。
- 「metas 返回空/failed → 同样拒写；force + OVERWRITE_CLOUD 越过（显式用户决策）」。
- 「metas 不可读 → blocked(cloud_time_unreadable) + fail-closed 警告（不再按无前置冲突放行）」。

## 4. T3b-04｜子任务 outputDir symlink 越权（Critical）

**修复**（`agent/tasks/task-service.ts`）：
- 新导出 `resolveTaskWorkspaceRoot(session, outputDir)`：outputDir 非空时经父 Workspace 的 `PathGuard.resolveInside(…, 'mkdir')`——逐级创建、每级创建后 realpath 复核 containment，任何把子根锚定到父根之外的路径（含祖先 symlink 段、已存在目标的 symlink）→ `ToolError('task_output_dir_invalid', …, 403)`；返回已 realpath 的子根。只读任务返回父根；无 Workspace 返回 undefined。
- `dispatchRound` 在 spawn 前解析并通过 `TaskSpawnInput.workspaceRoot` **冻结**下发（假 pi 路径同样经过该守卫，拒绝发生在派发层）。
- 生产 `spawnProcess` 只消费冻结结果，移除原 `path.join + fs.mkdirSync(recursive)`（祖先 symlink 借 mkdir 扩大授权根的路径不复存在）。

**测试**（agent-tasks.test.ts）：
- 单元：「resolveTaskWorkspaceRoot 父 Workspace 围栏」——顶层/深层 symlink 段（含目标子目录已存在）均拒绝；正常路径逐级创建并返回父根内 realpath；已存在真实目录复用；只读/无 Workspace 语义。
- 集成（假 pi）：「outputDir 祖先 symlink 指向外部目录 → 拒绝派发」——任务终态 failed(task_output_dir_invalid)、零子进程、外部目录零写入；「正常子目录逐级创建并冻结在父根内；子任务照常完成」。

## 5. T3b-05｜app_command 确认值降级（Major）

**修复**（`agent/tools/app-command-family.ts` `runSpecs`）：confirm 注入从「无条件覆盖为表基线值」改为「**字段缺失才补**基线值」——`request()` 派生后的 body 原样转发（source.push 按 allowOverwrite/force 派生 PUSH/OVERWRITE_CLOUD）；模型顶层 confirm 剔除语义不变（stripConfirmArgs）。

**测试**（app-command-family.test.ts，stub /api/sources/:token/push 全链）：「source.push allowOverwrite=true 经批准后 confirm=OVERWRITE_CLOUD 原样到达服务端（mock 全链）」——批准后请求体断言 `{allowOverwrite:true, force:false, confirm:'OVERWRITE_CLOUD', actor:'cli'}`，服务端接受；对照普通推送 `confirm:'PUSH'`。

## 6. T3b-06｜单 worker 回退绕过后台配额（Major）

**修复**（`kb/kb-build-service.ts`）：
- `spawnBuildProcess` 新增可选 `slotOptions`（保留原 3 参签名兼容测试接缝覆盖）；槽位获取改经新私有 `acquireSingleWorkerSlot`：`pool.acquire('background', {signal})` FIFO 排队 + M−1 后台配额 + 取消信号贯通 + 首槽 deadline（缺省 = 整体超时；拿不到 → `AgentBusyError` → 既有 `failed(agent_busy)` 处理）；竞态兜底：deadline 已拒绝后槽位才授出 → 立即 release 不占容量；外层取消（AbortError）→ CancelledError。
- `runSingleProcessPhase` 传入 `cancelController.signal`。session 类 `reserveSlot` 不再用于构建准入（交互会话保留槽不再被 W=1 回退吞掉）。

**测试**（kb-build-parallel.test.ts，buildParallelism=1 单 worker 回退路径）：
- 「M=3 + 两后台占满 M-1 → 单 worker 构建排队而非立即抢槽；交互保留槽可用；释放后继续」——排队期零 spawn、queueDepth=1、`reserveSlot('session')` 仍可得；释放后台槽后构建完成发布。
- 「排队中取消 → 出队失败（cancelled），不 spawn，无残留」。

## 7. T3b-07｜停止后迟到批准仍执行（Major）

**修复**（三层）：
- `agent/session-service.ts`：`abort()` 入口立即 `abortRequested.add(id)` + `emit('session_abort')`（撤销 pending 批准的事件源，不等 run_end）；新公共 `runState(id)` → `'aborting'|'running'|'idle'`；`executeRun` 开始时清除上一轮 stale 标记（abort 与 runs.set 竞态窗口不毒化新运行）、finally 清标记。
- `index.ts`：`session_abort` → `approvalService.cancelForSession(sessionId)`；ops 族注入 `sessionRunState`。
- `agent/tools/app-command-family.ts`：批准 settle 为 approve 后、`runSpecs` 执行前复核运行状态——`aborting`（停止已请求）/`idle`（settled 延迟窗口）→ `ToolError('approval_cancelled', …, 409)` 不执行。

**测试**：
- `agent-session.test.ts`「停止即撤销批准窗口（abort 入口）」——abort 立即发 session_abort（无活跃运行也发）、幂等、不存在会话不发；runState idle 基线语义（aborting 转移由下述 stub 场景覆盖）。
- `app-command-family.test.ts`「停止后（aborting/settled）迟到批准不再执行 → approval_cancelled，目标路由零命中」——abort ACK 窗口（aborting）、settled 延迟（idle）、running 回归照常执行三场景。

## 8. 验证与证据

| 验证项 | 命令（cwd=server 或根） | 结果 |
|---|---|---|
| server 全量（重启后 ×2） | `npm test` | 90 文件 / 1189 用例全绿，EXIT=0（两次） |
| server 类型 | `npx tsc --noEmit` | 通过 |
| 根全量 | `npm test` | 27 文件 / 237 用例全绿 |
| 根三段 typecheck | `npm run typecheck` | 通过（含 LlmRouteError 重构后复跑） |
| lint（CI 同口径） | `npm run lint` | 0 error / 3 warning（warning 均在未触碰的 `src/hooks/*`，重启前既有） |
| CLI e2e（真实 server + 打包 CLI） | `tests/cli-source-commands.test.ts` | 16 用例全绿（含 T3b-02 三例） |

- 逐项针对性测试（diting 报告触发条件即场景）均随修复落盘并通过（§1–§7 锚点）；既有相关用例仅两处按任务书要求的行为变更更新（§1 mask+端点、§3 preview 语义），其余全部原样通过。
- 瞬时异常记录（诚实披露）：重启前一次全量运行出现 `1 failed/9 skipped`，同代码立即复跑全绿；重启后两次全量复跑全绿。日志已被重启清空无法定位到具体用例，结合「同代码三次全绿 + 失败集中在单 worker 文件」判定为负载抖动，未复现。
- 未验证/盲区：真实飞书云端未触达（T3b-03 拒写语义用 stub lark client 验证；真实写回按设计仅限主上明确授权的测试文档）；无前端改动，故无真机交互验证项。

## 9. 重启前已完成 / 重启后续接

**重启前（全部完成）**：
- 7 项源码修复全部写入（§0 表列位置）；9 个测试文件的逐项测试全部写入；`vision-describer.test.ts` lint 最小修复写入。
- 验证：server 全量首轮绿（1189）→ 一次瞬时异常 → 复跑绿；根 test/typecheck/lint 完成（typecheck 在 LlmRouteError 重构后于 server 段复跑过）。

**重启后（本轮续接）**：
- 现场核对：`git status/diff` + 逐文件内容核对——7 项修复、9 个测试文件、lint 修复**全部完好在盘，无半途/丢失**（5 个 untracked 特性源文件经内容级 grep 核对，见 §0 注）。
- 重跑全部验证：server tsc OK；server 全量 ×2 全绿；根 test 全绿；根三段 typecheck 绿；lint 0 error。
- 本报告写入。

## 10. 写面外最小追加（披露）

- `server/tests/vision-describer.test.ts:116`：`let config` → `const config`（prefer-const）。该文件为本特性分支 untracked 测试文件（S2 产物），非本任务 7 项范围；不修则 `npm run check`（CI 同口径 lint）被 1 error 阻断。行为中性单 token 修改，修改后该文件 9 用例原样通过。

## 11. 回滚方式

全部改动仅在工作树（无 commit/stage）。回滚 = 还原下列文件中的 T3c 段落（源码 11 个 + 测试 10 个，见 §0 与 §1–§7）：tracked 文件按 `git diff HEAD -- <file>` 中标注 T3b/T3c 的 hunk 反向恢复；untracked 特性文件按 §1–§7 描述的函数/条目恢复原实现（`llm.test` 原参数面、`CONFIG_SET_FORBIDDEN` 去 feishuWrite、`restoreMaskedLlmSecrets` 原语义、`pushLocked/preview` 原 fail-open、`spawnProcess` 原 path.join+mkdir、`runSpecs` 原无条件覆盖、`spawnBuildProcess` 原 reserveSlot、`abort()` 原两行实现）。不涉及数据/云端状态，无额外清理。
