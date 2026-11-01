# child-policy：构建子任务工具面防御扩展（实施报告）

> 任务：补齐真实 probe（b361ce73）暴露的子任务工具面缺口——amagi spawn 交付面无条件含
> `codemode`/`toolcall_continue`（amagi-pi 2.21.31@929000e `task-run.ts:358`
> `resolveSpawnPermissionDelivery`），MCP `autoEnableCodemode:false` 挡不住 `--tools`
> 激活路径，违反设计 v2 §3.3/§13.1「子任务工具面无 codemode/tool_search」。
> 方案为 Leader 已裁定的 Advisor 方案 C（应用自有 child-policy 扩展，packages 仍唯一
> 固定 amagi；不修改 amagi 上游、不新增调度器）。

## 1. 产物清单（规格 → 落点）

| 规格 | 落点 | 状态 |
|---|---|---|
| 应用 child-policy 扩展源码（确定性纯 JS、内容寻址） | 新增 `server/src/agent/build-runtime/child-policy.ts` | ✅ |
| settings.extensions 显式声明 + 物化 + 完整性核对 + 禁改配置/policy | 修改 `server/src/agent/build-runtime/agent-dir-config.ts` | ✅ |
| 新测试（单元/配置/真实链路） | 新增 `server/tests/build-runtime-child-policy.test.ts`（32 用例） | ✅ |
| 既有测试更新 | `server/tests/build-runtime-agent-dir-config.test.ts` | ✅ |
| 实施报告 | 本文件 | ✅ |

未改 adapter/environment/extension/mainhost/工具/前端——无越界接缝。

## 2. 实现要点

### 2.1 child-policy.ts（新模块）

- `renderChildPolicySource()`：确定性渲染纯 JS 扩展源码（零 import、零依赖；
  `node --check` 真校验进测试）。文件按内容 hash 命名物化在构建 home 根：
  **`child-policy-190a7cb2cc00.js`**（sha256
  `190a7cb2cc00…f5ef`，3368 字节；当前渲染纯函数下内容变即名变）。
- 行为：仅 `AMAGI_TASK_ID` 存在的 amagi 子任务进程生效；八锚点 active 面过滤
  （session_start / before_agent_start / turn_start / turn_end / agent_end /
  tool_result / message_end(assistant) / message_start(系统面补丁)）+ tool_call
  阻断（`{block:true, reason}`）。不注册工具、不激活工具、不改 grant、不触网、不读写文件。
- 完整性：`verifyChildPolicyFile` 加载前字节级核验；`materializeChildPolicyFile`
  幂等物化（tmp+rename 0600、同名异客拒绝、写后核验、陈旧 hash 清理）。

### 2.2 agent-dir-config.ts（修改）

- settings.json 新增 `extensions: [childPolicyFileName()]`——相对路径按 agentDir
  解析（已核实 pi `DefaultPackageManager.resolveLocalEntries` 以 `globalBaseDir=agentDir`
  调 `resolvePathFromBase`）；settings 含 hash 文件名 → `agentDirConfigHash` 间接绑定
  policy 内容。
- Leader 以 `--no-extensions` 启动（`PiRpcProcess` 现状），pi `resource-loader` 的
  noExtensions 分支只保留 CLI `-e` 扩展 → Leader 天然不加载 policy；子任务由 amagi
  以 `--mode json -p` spawn（无 --no-extensions），默认发现加载。均已在 pi dist 源码核实。
- **资源注入缺口收口**：`agentDirConfigMatchesSpec` 由「只比 settings.packages」升级为
  字段感知完整比对——冻结键 `$schema/packages/extensions/skills/prompts/themes/defaultTools`
  深度比对（spec 未写的键磁盘不得出现）；唯一容忍键 `retry`，且形状必须精确等于
  `{provider:{timeoutMs:<正有限数>}}`（amagi `terminal-doctor.ts mergeProviderTimeout`
  只补这一条路径，已核实）；其余任何键 → 不匹配。policy 文件本体一并核验（缺失/篡改拒收）。
- **禁区**：`buildForbiddenZones` 精确追加 home 下 `settings.json/amagi.json/models.json/
  mcp.json/<child-policy 文件>`（不整目录禁 home——构建 skill 将迁入 `<home>/skills`，
  子任务须可读冻结正文；steer #2）。homeDir 从 workDir 按 planBuildDirectories 同规则推导，
  adapter 调用面零变更。

## 3. 机制核实（真实源码，非猜测）

| 事实 | 来源 |
|---|---|
| 用户设置 extensions 相对路径按 agentDir 解析 | pi dist `package-manager.js` `resolveLocalEntries(globalEntries, …, globalBaseDir=agentDir)` |
| `--no-extensions` 只保留 CLI `-e` 扩展 | pi dist `resource-loader.js` `noExtensions ? cliEnabledExtensions : mergePaths(…)` |
| `--tools` 点名的已注册可声明工具被激活；未知名忽略 | pi dist `agent-session.js` `_refreshToolRegistry` allowlist 循环 + `_setActiveTools` 注释 |
| 运行中任何工具注册触发注册表重建，把 `--tools` 点名的全部**可声明**工具重新激活 | pi dist `agent-session.js:2925-2936`（"Naming or matching a tool activates it…"） |
| amagi-core 在子任务 session_start 注册**自己的** codemode（`exposure:'model-only'`、`defaultActive:true`）；注册同名 first-wins，晚加载扩展无法覆盖 | amagi `codemode-runtime.ts` `ensure()/registerOwn()` + pi `runner.js getAllRegisteredTools`（first registration per name wins） |
| settings 写 `-builtin:codemode` 会让 amagi-core 装载期注册替身（适得其反） | amagi `codemode-runtime.ts` `builtinCodemodeMayLoad` |
| pi 1.4.0 的 `tool_search` 也是 `model-only`（可声明，同样会被重建循环重激活） | pi dist `tool-search` 工厂（`createToolSearchToolDefinition` `exposure:"model-only"`） |
| 下一请求的面在 `prepareNextTurnWithContext` 从 active 集快照；`turn_start` 在快照**之后**发出 | pi dist `agent-session.js` `_installAgentNextTurnRefresh` + live 事件序列（turn_start 后收到 toolsAdded 补丁仍污染该请求） |
| `toolcall_continue` 只续传「保存时与执行时均 active 且可调用」的原工具，且执行走 `ctx.executeTool` 完整 tool_call 钩子链 | amagi `length-continuation.ts`（`!s.originalActive \|\| !pi.getActiveTools().includes(s.tool) \|\| !ctx.tools.some(…)` → 拒绝） |
| auto-retry 续起新 run 不重发 before_agent_start（turn_start 仍发） | live JSONL 事件流（auto_retry_start ×3、turn_start ×4、before_agent_start ×1） |

**关键时序结论（live 实测）**：重激活触发点有三类——① MCP server 迟到注册（落在工具执行
等待窗口）；② 长度截断恢复（落在 assistant message_end 处理，见 §4 对照）；③ auto-retry
轮（不发 before_agent_start）。因此锚点必须覆盖「上一轮收尾链 → 下一请求快照前」全窗口；
只挂 turn_start 会晚一拍（实测复现：截断后首个请求被污染）。

## 4. 真实链路验证（真实 pi 1.4.0 + 真实 amagi-pi 2.21.31@929000e 源码物化）

复现命令（worktree `server/` 下；环境：`PI_PROBE_PI_CLI`+`PI_PROBE_SOURCE_AMAGI`，临时
HOME/FEISHU_SYNC_HOME，密钥为 fixture 假值，未读生产凭据）：

```bash
REAL_PI=/Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
PI_PROBE_PI_CLI=$REAL_PI PI_PROBE_SOURCE_AMAGI=/Users/run.mao/workpace/amagi-pi \
  npx vitest run tests/build-runtime-child-policy.test.ts -t "真实 pi"
```

子进程按 amagi `task-run` 真实交付面 spawn：`--mode json -p --tools read,write,grep,find,ls,
mcp_call,mcp_list_tools,amagi_resource,codemode,tool_search,toolcall_continue`（含 amagi
无条件追加项 + 敌意加测 tool_search）；fixture OpenAI 兼容模型记录每轮请求的工具声明。
fixture 模型不是 LLM 质量/性能证据，仅驱动真实工具链路。

| 用例 | 结论 | 证据 |
|---|---|---|
| 对照组（还原修复前配置：无 extensions 声明、无 policy 文件） | **缺口复现**：首个请求工具面含 codemode，且强制 codemode 调用真实执行（`CTRL-CODEMODE-EXECUTED` 回到历史） | 请求 tools 快照 + 历史 |
| 实验组（policy 加载） | 全部 ≥6 轮请求面无 codemode/tool_search；面内保留 read/write/mcp_call/mcp_list_tools/amagi_resource/toolcall_continue；强制 codemode/tool_search 调用被拒（理由含 `child-policy` 进工具结果）；read/write 正常；mcp_list_tools 见 `kb_echo` | 请求 tools 快照逐轮断言 + 桥连接记录 + 报告文件落盘 |
| 续传与直连（Leader steer #1） | ①截断 codemode 调用后 `toolcall_continue(token,append,final:true)` **不能**续接被禁工具（amagi 原生拒绝/未见 `pwned` 执行结果）；②直接 `mcp__feishu-kb-bridge__kb_echo` 调用**未触达**桥（bridge log 无 `direct-bypass-attempt`，无 echo 回包）；③授权 `mcp_call` 正常（bridge log `CALL:legit-route` + `echo:legit-route`）；④含续传轮在内全程面无禁用名 | bridge 调用记录文件 + 历史 + 面断言 |

稳定性：live 三用例连跑 4 轮全绿（含一次全文件 32 用例全跑）。

单元/配置层：32 用例（确定性/hash/`node --check`/fake-pi 八锚点行为/物化幂等/篡改
fail-closed/settings 字段感知比对 14 组正反例/禁区精确性）；关联回归
`build-runtime-agent-dir-config / capability-probe / adapter / contracts / package` 共 136 用例
通过；`tsc --noEmit` 与 eslint（改动面）通过。

## 5. 边界与残余风险（如实）

1. **重激活竞态的残余窗口**：若重激活恰好落在「最后一次过滤锚」与「请求快照」之间的微任务
   间隙，该单个请求的工具面可能短暂含禁用名——但任何调用都被 tool_call 阻断（无副作用，
   live 实测强制调用均被拒）。八锚点布局后未再观测到漏网；彻底结构性收口需 amagi 上游停止
   无条件交付 codemode（`resolveSpawnPermissionDelivery`/`legacyDispatchToolsWithoutCodemode`
   两处），建议由 Leader 向 amagi-pi 提上游改动，届时本 policy 退化为纵深防御层。
2. **不走 `-builtin:codemode`/卸载路线**（已核实适得其反：amagi-core 会装载期注册替身）；
   也不 re-register 覆盖（first-wins，晚加载扩展无法胜出）。当前方案是扩展 API 内可达的最强执法。
3. **Leader 不加载 policy**（`--no-extensions`）：Leader 面由既有 `--tools` 白名单 +
   转发扩展收敛（probe 已证）；本增补只针对子任务交付面。
4. **live 验证为子进程直测**（按 amagi 真实 spawn 形态）：完整「Leader→task_submit→真实
   child」链与生产桥、真机 quality skill 由主链（c5936873，build-v2-integration）接线验证；
   本 worktree 未跑主链（不越界）。skill 正文可读性（steer #3 的 child read 全文）属主链
   probe 面——本侧已确保禁区不误伤 `<home>/skills`。
5. **hash 前 12 位碰撞**：同名异客由写后/加载前字节级核验拒绝（`child_policy_tampered`）。

## 6. 回滚

删除新增两文件，还原 `agent-dir-config.ts`/`build-runtime-agent-dir-config.test.ts` 即回到
5f39dd8 基线（git 工作区未提交，Leader 统一汇总）。存量构建 home 中的
`child-policy-*.js` 为未声明文件，不会被加载，无需清理。

## 7. 给 Leader 的接口说明

- `renderAgentDirConfigFiles` 签名未变；settings.json 新增 `extensions` 字段——
  **spec 冻结的 `agentDirConfigHash` 需按新渲染重算**（集成方 c5936873 用同函数重算即可）。
- 旧代次（无 policy）的构建在 resume/probe 时会被 `agentDirConfigMatchesSpec` 判
  extensions 冻结面缺失 → 拒绝原会话续接（fail-closed，走成果级恢复）——符合预期，请知悉。
- probe 主链复跑时，`child-tools-surface` 检查项（probe 脚本 line 709 的 codemode/tool_search
  断言）在本增补落主链后应转绿；live-probe worktree（b361ce73）自身源码未动。
