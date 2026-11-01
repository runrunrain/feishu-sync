# 审核修复批：MCP 发现 / 运行期完整性 / 平台路径（F02 / F12 / F13）

- worktree：`.amagi-worktrees/build-v2-fix-integrity`（分支 `amagi/build-v2-fix-integrity`，base 9765fe4 = dirty-snapshot on 25cc0b4 + 用户原改动；**未提交**，Leader 统一合并）。
- 源码权威：root `25cc0b4` + 用户未提交增强（maxTokens/声明读取保护等全部保留，本批 diff 未触及）。
- 独占方法面遵守：`claude-bridge.cjs`、`pi-extension/feishu-sync-agent.js`（派发前接线）、`dispatch-guard.ts` + 新增 `runtime-integrity.ts`、`agent-dir-config.ts`（冻结验证相关）、`adapter.ts`（**仅** `buildGuardConfigInput`/完整性注入，未触及 start/resume/cancel/launch/epoch）、`routes/kb.ts`（sourcePath 验证）、对应测试。未改 AgentToolService/publish/native 调度器/amagi 上游。

## F02｜pending 只读面被同连接永久缓存 → 关闭（含 Leader steer 迟到确认 liveness）

**修复**（`server/src/agent/claude-bridge.cjs`）：
- `initialize` 声明 `capabilities.tools.listChanged: true`（MCP 标准）。
- 有受信身份（`AMAGI_TASK_ID`，仅构建子任务）时，首次 `tools/list` 响应后启动【两段式】最小 catalog 观测：
  - **快窗**（默认 250ms×30s）覆盖常态 pending→confirmed（<1s）；
  - 快窗到期未变【不自停】→ 转入【自退避低频段】（默认 5s 起、逐次倍增至 8× 上限，钳 120s）继续观测——迟到 confirmed 仍可刷新，不静默停后永久只读（原生客户端无自愈重连，Leader steer 收口点）；
  - 观测生命周期由「stdio 活跃 + token 有效」约束：定时器全 `unref`、单次 HTTP 限时 5s（AbortSignal，不影响 tools/list / tools/call 主路径）、stdin 关闭即停、**401 `run_token_invalid` 即永久终止**；无身份（Claude 会话）不观测；零日志（无密钥/URL 泄漏面）。
  - 面变化（含撤销后的缩面）→ 发送标准 `notifications/tools/list_changed` 并重臂快窗捕捉后续变化；通知由服务端真实变化驱动，非常驻播报。逐次业务授权仍全部由服务端裁决（未把 pending 当 confirmed，未放开任何写权限）。
- 机制核实：pi `dist/extensions/mcp/runtime.js` 注册 `client.onNotification("notifications/tools/list_changed") → refreshTools`（实读源码核实）；桥侧通知 → Pi 重新 `tools/list` → 工具面更新。
- 时序 env（仅时序不改语义）：`FEISHU_SYNC_BRIDGE_SURFACE_WATCH_{INTERVAL,DEADLINE,LOW}_MS`（钳制上限，测试可缩短窗口，不必实际等 30s）。

**证据**：
- 快窗内确认（原反例脚本重跑，真实 Pi `McpServerConnection` + 生产桥）：`/tmp/feishu-build-v2-fix/mcp-cache-probe-fixed.log` —— `CONFIRMED_SAME_CONNECTION ['raw_read','kb_write_doc']`（原 `/tmp/feishu-build-v2-review/mcp-cache-probe.log` 同连接仅 `['raw_read']`）。
- **迟到确认探针**（快窗 240ms 到期、低频段后才 flip）：`/tmp/feishu-build-v2-fix/mcp-cache-probe-late.log` —— `LATE_CONFIRMED_SAME_CONNECTION ['raw_read','kb_write_doc']`，同连接不重开。
- 正式测试（`server/tests/build-runtime-bridge.test.ts`，真实 AgentToolService 全链，11/11）：①快窗内 pending→确认→同连接通知→写工具可见→**真实写入**（staging 落盘）→撤销后同调用被拒（`actor_revoked`）；②**迟到确认回归（Leader 要求）**：快窗 240ms 到期、低频段才 `registerTaskCreation` → 仍收到通知、写工具可见可写、撤销仍拒；③两段生命周期：面不变时快窗到期后【低频继续观测】（增长≥1 且受退避约束 ≤基频上界）、401 即永久停（GET 计数跨窗口零增长）、无身份仅 1 次显式 GET、低频段中 stdin 关闭即退（exit 0，无定时器/轮询残留）；④通知计数恰等于真实面变化次数（扩面+撤销缩面=2，非常驻播报）。

## F12｜派发前不重核冻结面（policy 缺失/settings 注入静默放行）→ 关闭

**修复**：
- 新增 `server/src/agent/build-runtime/runtime-integrity.ts`（单文件、node:crypto/fs/path 零三方依赖）：`RuntimeIntegrityRefs`（homeDir + 四配置渲染期望全文 + child-policy 内容寻址 sha256 + 包全量 contentHash + **workflowSkill {path, sha256=spec.workflowRevision}**；不含任何密钥值）+ `verifyRuntimeIntegrity(refs, {computePackageContentHash})`（settings 字段感知比对【冻结键深比 + retry 容忍 + 未知键拒】、amagi/models/mcp 逐字节、policy 字节级、包全量哈希、**workflow skill 实文件字节哈希——缺失/篡改/符号链接一律拒**（lstat 先验符号链接，与 adapter.verifyWorkflow 同公式；Leader steer 冻结资源接缝：child 经 amagi.json skills 读此文件、F08 回执绑 workflowRevision，运行中改字节会造成「child 读新规则、回执绑旧版本」的错位；新 epoch 引用可指向旧 basehome，本核验只对哈希负责、不做路径世系判断）；实测包走查 ≈150ms/3545 文件/≈82MiB）。`agent-dir-config.agentDirConfigMatchesSpec` 的 settings 比对重构为同一实现（`settingsFrozenSurfaceIssues`），两处不分叉。
- `dispatch-guard.ts`：`DISPATCH_GUARD_SCHEMA_VERSION` 1→2，`FrozenDispatchConfig.integrity` **必填**（缺失/形状非法 → 旧代次信封整体 fail-closed）；保持**零运行时相对 import**（pi/jiti 不解析 .ts 内 `.js` 相对引用——live 排障实测，type-only import 编译期擦除已验证 dist 无残留引用）。
- `adapter.buildGuardConfigInput`：按 dirs（调用方传入，兼容 Runtime 任务的 epoch 路径变化，不假设固定 build/id/home）构造 integrity 引用，与 `writeAgentDirConfig` 同源渲染。
- `feishu-sync-agent.js`：装载面扩展为三模块（dispatch-guard + 推导同目录 `runtime-integrity` + `amagi-package` 注入哈希 walker，不复制实现）；**启动即核验**（引用形状 + agentDir 一致（`PI_CODING_AGENT_DIR` 装载时快照）+ 磁盘全量）；**每次 task_submit/task_resume 调用前重核**（纯参数守卫之前），不 ok → `integrity_blocked` 审计 + block（`runtime_integrity_violation`），阻止 child 模型请求。

**证据**：
- 前提复现（Pi 原生行为未变，修复必要性成立）：`/tmp/feishu-build-v2-fix/missing-policy-probe-replay.log` —— settings 指向不存在扩展仍 `code=0, requests=1, 含 codemode`（静默 skip）。
- **live 关闭**（`server/tests/build-runtime-integrity.test.ts`，真实 pi Leader + 真实安装的版本化 amagi-pi（source 物化+pi install+全量哈希）+ 真实 amagi task_submit + 真实 dispatch-guard/integrity 模块 jiti 链 + fixture 模型）：Leader 启动后【四场景逐一在同一 Leader 运行中验证】——剘 policy（A）/注入 settings 未知字段（B）/【改】workflow skill（C）/【删】workflow skill（D）→ 每次派发均被 `integrity_blocked` 阻断（C 断言「workflow skill 内容与冻结 workflowRevision 不一致」、D 断言「workflow skill 文件缺失」），`amagi/v2-store` 全程无任务落盘，fixture 模型仅收 Leader 自身 8 次请求（**无 child 模型请求**）。不是只测 helper 返回 false。
- 单元（同文件，真实渲染/落盘/包哈希 fixture）：policy 缺失/篡改、settings 未知字段/冻结键移除/retry 容忍与坏形状、四配置逐字节漂移、配置缺失、包漂移/包目录缺失、引用形状非法、**workflow skill 缺失/篡改/符号链接（目标内容合法也不放行）**，10 用例全绿。
- 扩展接线（`build-runtime-extension.test.ts` A2b 8 用例）：磁盘 fixture 基线放行（guard_amended 语义不变）、policy 缺失/settings 注入/包漂移/**workflow skill 篡改**逐项阻断、agentDir 不一致装载即拒、旧代次信封装载即拒。
- 全链正例：e2e 3/3（真实 install + 真实 Leader→amagi 子任务→桥→published，dist 编译模块链与源码链各跑一轮）；B1/B2 真实 pi/amagi-core 用例通过（integrity 通过后守卫改参正常生效）。

## F13｜`startsWith('/')` 硬编码 POSIX 校验拒绝 Windows 合法路径 → 关闭

**修复**：
- `routes/kb.ts` sourceDir：`path.isAbsolute(sourceDir)`（宿主平台一致：win32 接受盘符/UNC/`/`，POSIX 只接受 `/`——Windows 盘符字符串在 POSIX 宿主仍被拒，不当本机合法路径）+ 保留存在性检查；错误消息带平台口径。
- `dispatch-guard.ts` workDir：同上平台一致绝对路径判定；比较用规范化（`normPathForCompare`：`\`→`/`、去尾斜杠，盘符/UNC/POSIX 条目与 workDir 同口径）；`escapesWorkDir` 收紧为**任意位置含 `..` 段即拒**（原实现绝对路径前缀内嵌 `..` 会漏过——本次一并收口，只增不减）。

**证据**：dispatch-guard 测试新增（POSIX 宿主拒 `C:\build\work` 形态、win32 分支静态形状断言【本机未跑】、混合分隔符条目不逃逸同目录 workDir、内嵌 `..` 拒绝），15/15；全量 typecheck/lint 通过。

## 验证汇总（cwd=server / 根，真实执行）

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（根三段 + server） | EXIT=0 |
| `npx eslint`（改动面 11 文件；bridge.cjs 为配置预忽略，`node --check` 语法通过） | EXIT=0 |
| `npx vitest run tests/build-runtime-{integrity,bridge,extension,dispatch-guard,agent-dir-config,child-policy,environment,adapter,contracts,capability-probe}.test.ts` | 全绿（integrity 25【含 contracts 14 复用 + live 四场景】/ bridge 11【含 F02×3】/ extension 19【含 B1/B2 真实 pi + skill 篡改】/ dispatch-guard 15 / 其余 131+25） |
| `npx vitest run tests/build-runtime-{integration,persisted-mode,pi-rpc-process,live-probe}.test.ts` | 30 passed / 1 skipped（预存 skip） |
| `AMAGI_PI_SOURCE_DIR=… npx vitest run tests/build-runtime-e2e.test.ts`（源码链 + dist 链各一轮） | 3/3 published |
| `npm run build`（server） | EXIT=0；dist 三模块独立 node 装载 + 导出面核验通过 |
| 反例探针重跑 | F02 同连接刷新（快窗内 + 迟到确认两份 log）；F12 前提仍成立（见上） |
| steer 轮复验：`npx vitest run tests/build-runtime-bridge.test.ts`（11/11）+ `AMAGI_PI_SOURCE_DIR=… tests/build-runtime-e2e.test.ts`（3/3 published）+ `tsc --noEmit` + eslint 改动面 + `node --check` 桥脚本 | 全绿 EXIT=0 |
| skill 冻结接缝轮复验：dispatch-guard/extension/bridge/agent-dir-config/child-policy/environment/adapter 147 通过 + integration/persisted-mode/pi-rpc-process/live-probe 30 通过 + e2e 3/3 published + `npm run build`（dist 链）+ 全量 typecheck + eslint | 全绿 EXIT=0 |

未跑全量 `npm run check`（任务书「不反复全量」）；前端未触及。所有 HOME/数据/模型均临时 fixture，未读真实凭据、未跑真实模型、未改原始库。

## 接口变更（供 Runtime 4245961b / publish 22c29fc4 兄弟同步）

1. `FrozenDispatchConfig`：+`integrity: RuntimeIntegrityRefs`（必填，含 `workflowSkill: { path: string; sha256: string }`——sha256 = `spec.workflowRevision`，由 `adapter.buildGuardConfigInput` 自动从 spec 取），`DISPATCH_GUARD_SCHEMA_VERSION=2`；旧代次信封（无 integrity / v1 / 无 workflowSkill）装载即拒。**Runtime 合并提示：集成方只需保证 spec.workflowRevision 是 skill 文件字节 sha256（既有 verifyWorkflow 契约），refs 构造零额外参数。**
2. `freezeGuardConfig(input)`：input +`integrity`（必填）。
3. `adapter.buildGuardConfigInput(spec, dirs, roleMcpTools)`：签名不变，返回 +`integrity`（按传入 dirs 绑定实际目录——Runtime 的 epoch 路径改动只需继续传新 dirs，无需改本方法）。
4. 扩展装载面：`FEISHU_SYNC_BUILD_GUARD_MODULE` 同目录需存在 `runtime-integrity.{js,ts}` 与 `amagi-package.{js,ts}`（同 tsc 产物/源码，已验证 dist 与 src 两形态）；dispatch-guard 仍须零运行时相对 import（pi/jiti 约束）。
5. `verifyRuntimeIntegrity(refs, { computePackageContentHash })`：哈希 walker 注入（server 侧传 `amagi-package` 的实现；扩展侧同目录装载后传入）。
6. 桥接：`initialize` 声明 `tools.listChanged`；可能下发 `notifications/tools/list_changed`；观测时序 env 三个（`…_{INTERVAL,DEADLINE,LOW}_MS`，仅时序不改语义；业务接口未扩大）。
7. `routes/kb.ts` sourceDir 与 `dispatch-guard` workDir/路径比较：平台一致绝对路径 + 分隔符规范化 + `..` 段全拒（更严，只增拒绝）。
8. **Runtime 424 epoch 目录兼容**：`buildGuardConfigInput(spec, dirs, roleMcpTools)` 只消费调用方传入的 `dirs`（integrity 引用绑 `dirs.homeDir`），`runtime-integrity`/`dispatch-guard` 校验仅做 `isAbsolute`，无任何 `/agent/builds/<id>/home` 旧路径硬编码——Runtime 侧 `planBuildDirectories(dataRoot, id, epoch)` 落地后本侧无需改动，由 Leader 合并两侧方法即可。
9. `BUILD_SPEC_ENV` 体积 +≈4–5KB（expectedFiles 全文；无密钥）。

## 未覆盖（如实）

- **F13 Windows 真机未测**（无 Windows 环境）：win32 分支仅静态形状断言；UNC/盘符真实安装、打包、Electron 实机仍开放。
- **F12 运行中 child 的已装载面**：派发前重核阻止新派发；已 spawn 的 child 持有装载期已核验的字节，运行中同 uid 改盘不会"卸载"已加载 policy（边界如实；文件围栏/哈希核验不是 OS 沙箱，不宣称同 uid 外部代码被隔离）。
- **F02 长尾窗口（已收口）**：快窗到期不再自停——低频自退避观测随「stdio 活跃 + token 有效」生命周期延续，迟到确认仍刷新（正式回归 + 探针双证据）；代价是长寿命只读子任务在低频段持续低率观测（默认 5s→40s 退避，回环 GET，非业务调度）。
- amagi 上游无条件交付 codemode 的结构性收口、完整取消/恢复真实链（A22/A24 续批）不在本批范围。
