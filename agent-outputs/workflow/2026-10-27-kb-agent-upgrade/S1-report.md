# S1 报告：工具族注册 + 进程池准入（基础切片）

任务：`AgentToolService.registerToolFamily()` 工具族注册模型 + `AgentProcessPool.acquire()` FIFO 准入排队（设计 §4.4/§4.7/U9、切片表 S1 行）。

上游输入：`docs/design/kb-agent-upgrade-design.md` §4.4/§4.6/§4.7/§10、`server/src/agent/agent-tool-service.ts`、`server/src/agent/agent-process-pool.ts`（重构前版本）。

## 一、改动摘要

| 文件 | 改动 | 性质 |
|---|---|---|
| `server/src/agent/agent-tool-service.ts` | 新增 `AgentToolFamily`/`AgentToolFamilyTool` 导出类型与 `registerToolFamily()`/`registeredFamilies()`；内置 raw/kb/draft/ws 四族在构造器登记；`createRunContext` 白名单、`getToolSpecsForToken` 规格、`executeTool` dispatch 全部改由族注册表派生；删除 17-case 的 `dispatch` switch 与内联白名单三元链 | 重构（行为等价，见 §二） |
| `server/src/agent/agent-process-pool.ts` | 新增 `acquire(kind: 'session' \| 'background', { signal? })` FIFO 排队、`queueDepth()`、后台配额（M>1 ? M−1 : 1）、`ReservationSlot.consume()`（注册消费不触发晋级，防超卖）、closeAll 清空队列；上限钳制 1..4 → 1..6、默认 2 → 3 | 既有 API 语义保持 + 追加 |
| `server/src/types/agent-knowledge.ts` | `buildDefaultAgentConfig().maxConcurrentProcesses` 默认 2 → 3（任务书指定的两处 additive 之一） | 追加式（默认值变更） |
| `server/src/modules/config-manager.ts` | 宽容归一 `Math.min(4,…)` → `Math.min(6,…)`；严格校验 `>4` → `>6`（两处 additive 之二） | 追加式（范围放宽） |
| `server/tests/agent-config.test.ts` | 默认值断言 2 → 3（2 处） | 随默认值同步 |
| `server/tests/agent-process-pool.test.ts`（新） | 15 用例：FIFO/取消/配额/会话保留槽/closeAll/扩容晋级/既有语义 | 新增 |
| `server/tests/agent-tool-families.test.ts`（新） | 15 用例：表驱动白名单快照/规格同一性/dispatch 错误码逐字/成功路径/追加接口/重复拒绝 | 新增 |

注：`config-manager.ts`/`agent-knowledge.ts` 的 git diff 同时含 S2 兄弟切片（vision 段）的在途改动；本切片在这两个文件里的净改动仅上表两行范围。

## 二、等价性证据（重构前后工具面）

1. **白名单逐字快照**：`agent-tool-families.test.ts` 以重构前 `createRunContext` 内联数组为冻结基线（`LEGACY_WHITELISTS`），断言四个 runKind（build/work/discuss/probe）的 `context.allowedTools` 与旧实现**含顺序**完全相等，并同时与 `toolsForRunKind()`（types 导出、pi 进程 `--tools` 参数源）互验 —— 全部通过。
   - 顺序保持机制：`allowedToolsForRunKind()` 成员来自族注册表 runKinds 命中集；顺序 = 基线 `toolsForRunKind` 冻结顺序在前 + 新增族按注册顺序追加在后。既有工具输出逐字节不变；未来新族追加在尾部（不会重排既有面）。
2. **规格面**：`getToolSpecsForToken` 输出与白名单同序，且每个 spec 与 `tool-specs.ts` 的 SPEC 常量是**同一对象**（`toBe` 断言）——族只引用不复制，tool-specs.ts 仍是唯一定义源，参数 Schema 零漂移。
3. **dispatch 面**：错误码/状态码/消息逐字断言通过：401 `run_token_invalid`（`运行令牌无效或已过期`）、403 `tool_not_allowed`（`工具 ws_write 不在本运行的工具白名单内（runKind=discuss）`）、404 `kb_not_published`/`not_found`、403 `本运行不是构建运行`、403 `本运行未绑定 Workspace`；成功路径 `ws_write`→`ws_read` 往返内容逐字一致。
4. **实现同一性**：四族执行器全部转发到重构前的同一 private 方法（`toolKbSearch` 等 17 个方法体零改动），仅注册位置搬运。
5. **既有回归面**：`agent-internal-auth.test.ts`（真实 buildServer 路由级，白名单/执行/鉴权）、`agent-session*.test.ts`、`kb-build.test.ts`、`agent-config.test.ts`、`agent-status-regression.test.ts`、`agent-assets-cjs.test.ts` 全绿（见 §五验证矩阵）。

## 三、池语义变化说明（U9）

- **新增**：`acquire('background')` 后台类 FIFO 排队——后台配额（M>1 ? M−1 : 1）与总容量均有富余时立即授槽，否则入队；`release`/进程 exit/`terminate`/`configure` 扩容同步晋级队首；`signal` 取消即出队拒绝（`AbortError`），不再占位；授槽后取消不影响已授出的槽。`closeAll()` 清空队列（等待者以 `进程池已关闭` 拒绝），队列不跨重启。
- **会话保留槽**：M≥2 时后台合计并发 ≤ M−1，第 M 槽始终可供 `reserveSlot()`（会话/probe 立即语义不变：满 → null / `acquire('session')` 满 → `AgentBusyError`，保留给显式不排队场景）。M=1 时后台与前台互斥。
- **后台配额口径**：`kind='build'` 的注册条目（既有构建进程）也计入后台占用——当前唯一构建调用方走 `reserveSlot()` 通用槽，行为不变（通用槽不排队、不查后台配额），配额只约束新的 `acquire('background')` 入口。
- **防超卖细节**：`register` 消费预留走 `consume()`（计数转移、不触发晋级）；`release()` 才触发晋级——避免「预留转注册」瞬时空窗向等待者超发槽位。
- **上限**：构造/`configure` 钳制 1..6（原 1..4），默认 3（原 2）；`configure` 扩容立即放行队首，缩容不抢占已占槽。
- **既有行为不变**：`reserveSlot()`（返回 null）/`register()` 无槽超限 `AgentBusyError`（边界 `> max` 的历史宽容语义逐字保留）/`setBusy`/idle 回收/`retireIdle`/`closeAll` 幂等——`agent-session-concurrency.test.ts` R05/R06 全部原样通过。

## 四、给 S3/S6/S10 的追加接口

1. **新增工具族**（不改 dispatch 主体）：
   ```ts
   // server/src/agent/tools/<name>-family.ts（新文件）
   import type { AgentToolFamily } from '../agent-tool-service.js';
   export const TASK_FAMILY: AgentToolFamily = {
     name: 'task',
     tools: [{ spec: TASK_SUBMIT_SPEC /* tool-specs.ts 定义 */, runKinds: ['work'],
               execute: (ctx, args) => … /* ctx: InternalRunContext（已导出），可读 ctx.options/ctx.sessionId 等 */ }],
   };
   // agent-tool-service.ts registerBuiltinFamilies() 末尾追加一行：
   this.registerToolFamily(TASK_FAMILY);
   ```
   - 新族工具自动进入声明 runKind 的白名单尾部（追加序），`getToolSpecsForToken`/`executeTool`/403 白名单错误消息格式自动一致；重复族名/工具名注册期抛错。
   - 简单追加也可直接在调用方 `service.registerToolFamily({...})`（测试即用此形态）。
2. **S3（raw_read_image）**：在 raw 族文件追加工具项（或经 `registerToolFamily` 新子族），`runKinds: ['build','work','discuss']` 由该切片定；注意若需进 pi `--tools` 参数面，还需在 `types/agent-knowledge.ts` 的对应 TOOLS 常量追加名（该文件公共追加区段）——白名单顺序基线取自 `toolsForRunKind`。
3. **S4（并行构建 worker）**：worker/final spawn 用 `pool.acquire('background', { signal: cancelController.signal })`；构建取消 abort 即出队；key 建议 `build:<buildId>:w<i>` / `build:<buildId>:final`，`register(key, rpc, 'build', slot)` 消费槽位。
4. **S6（task 进程）**：`pool.acquire('background', { signal })`，key `task:<taskId>`；`buildTimeoutMinutes` 内拿不到首个槽位的 `failed(agent_busy)` 语义由调用方超时+abort 实现。
5. **配置**：`agent.maxConcurrentProcesses` 现为 1..6 默认 3；`AgentProcessPool.max` 可读当前生效值。**未覆盖**：前端 `AgentSettingsCard.tsx` 本地 fallback 仍是 2 且无 1..6 范围展示（属 S5/UI 切片），运行时以 server 端归一值为准。

## 五、验证证据（共享树，兄弟切片在途）

| 项 | 命令（cwd=server） | 结果 |
|---|---|---|
| 新增池单测 | `npx vitest run tests/agent-process-pool.test.ts` | 15/15 ✅ |
| 新增族等价单测 | `npx vitest run tests/agent-tool-families.test.ts` | 15/15 ✅ |
| agent 回归面 | `npx vitest run tests/agent-internal-auth.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/agent-status-regression.test.ts tests/kb-build.test.ts` | 72/72 ✅ |
| 资产/配置 | `npx vitest run tests/agent-assets-cjs.test.ts tests/agent-config.test.ts` | 17+ ✅ |
| 全量 `npm test` | 898 tests | 876 ✅；22 failed 全部为 S2 vision-*（在途未完成）；6 个 suite 级失败全部因 `src/index.ts:339` 语法错误（S8 切片正在写该文件的中间态，非本切片文件）——`agent-internal-auth`/`agent-status-regression` 单独跑即绿 |
| `npm run typecheck` | `tsc --noEmit` | 全项目 6 个 error 全部位于 `sync-engine.ts`/`sources/source-edit-service.ts`（S11 在途）；本切片 4 个涉改文件 error 数 = 0 |
| eslint | 涉改 6 文件 | 0 error 0 warning ✅ |

结论：本切片自身写面内全绿；全量失败项均可归因兄弟切片在途中间态（git status/diff 比对确认），非 S1 回归。

## 六、回滚

`git checkout -- server/src/agent/agent-tool-service.ts server/src/agent/agent-process-pool.ts server/src/types/agent-knowledge.ts server/src/modules/config-manager.ts server/tests/agent-config.test.ts` 并删除两个新测试文件与本报告。注意前两个公共文件含 S2 兄弟改动，整文件回滚需在合并窗口协调；仅回滚本切片可按 §一表格行反向手工恢复（默认值 3→2、6→4 两处、族注册块与池 diff）。
