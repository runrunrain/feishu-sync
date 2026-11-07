# F3 唯一一次增量复审

**VERDICT: FIX**

当前冻结源码仍有 **R01（Critical）和R04（Major）未完全关闭**；其余9项关闭。没有把通过的测试数量等同于权限/并发边界通过。初审仅作为历史保留：[完整初审报告](agent-knowledge-review-initial.md)，不与本报告同时作为当前结论。

## 范围与依据

- 基线仍为公共契约 `104ba2f`；本轮只复核04a0416b集中修复及Leader回流后的保护根、CJS、源集合、消息DTO/停止、发布后阅读接线，不重做无关全仓审核。
- 上游：`docs/reports/agent-knowledge-backend.md` §四关闭矩阵、`docs/reports/agent-knowledge-integration.md`末节、公共设计和初审R01–R11；结合当前主树实际代码和新测试核对，未访问原worktree。
- 实际执行：后端7文件71项、前端4文件29项、三段typecheck均exit0。后端包含**真实pi＋本地OpenAI SSE协议fixture**，没有真实远程模型新请求、真实key或用户凭据文件读取。
- 上游最终统一检查按Leader调整#1和集成报告记录为：前端12文件95例、server57文件741例，lint/typecheck/build:all/electron:build/diff-check通过；MCP四工具对最终CJS产物的真实stdio调用通过。这些为Leader证据，不冒称本轮重跑。

## R01–R11关闭矩阵

| 原编号 | 当前状态 | 独立核对的修复与证据 |
|---|---|---|
| R01 Critical | **未完全关闭** | `protected-roots.ts`现保护repo/app整树、Electron资源、默认/显式PI目录、Node字面/realpath的bin、pi包。应用src/依赖/Electron拒绝及独立资料目录允许的测试通过；但**resolver会执行的npm实际代码树仍可授权写入**，见下。 |
| R02 Major | 关闭 | ConfigManager合并后检查Workspace冲突；配置路由补运行时根；index注入当前配置守卫，spawn与每个Workspace工具执行时再查。raw/std反向冲突不落盘、旧运行能力执行拒绝的测试通过。保护根资产集合的剩余遗漏归R01，不重复报。 |
| R03 Major | 关闭 | `provider-descriptor.ts`被probe/session/build共用；session实际设置providerJson与key子env。真实pi＋本地端点验证所选模型、Bearer sentinel、回复及run token不外发通过。未将本地fixture冒充真实远端app-llm key验证。 |
| R04 Major | **未完全关闭** | 正常streaming投递已改同一run的steer/follow_up；不会第二次prompt/抹监听，真实pi工具轮插话测试通过。但**进程仍存活、运行已settled的收尾窗口仍会接受队列消息**；当前409测试只模拟进程退出，见下。 |
| R05 Major | 关闭 | session/build都在spawn前reserveSlot；start/register失败terminate＋revoke＋release；两个spawn都绑定exit→revoke。池满不spawn、预留消费/幂等、exit移除测试通过。exit令牌绑定另做静态链路确认，未声称已故障注入全部OS退出时序。 |
| R06 Major | 关闭 | session运行前setBusy(true)，finally setBusy(false)；busy期间不排idle timer，结束后重起窗口。fake timer验证运行120s不回收、完成后完整窗口回收通过。 |
| R07 Major | 关闭 | full工作集取snapshot全部源；覆盖检查覆盖全工作集，full空产出拒绝；仅removed有affectedDocs时合成批次。full覆盖/空产出测试通过；上游重复full真实发布仍覆盖两源且raw SHA不变。 |
| R08 Major | 关闭 | source_changed毒化buildState，批/finish/validating检查；`await validateStaging`之后、publish之前同步执行verifySnapshotIntact，复扫当前源集合/hash，主文档与CSV均复核，主文件realpath围栏再次检查。对应新增/改动/observed-only/越界symlink测试通过。 |
| R09 Major | 关闭 | 启动对账按同buildId查存在行并UPDATE、仅缺行INSERT；published回填并清旧error。测试分别覆盖publishing/failed/interrupted同id，且不重复插入，通过。 |
| R10 Major | 关闭 | CURRENT提交后清理扫描异常被捕获，不再沿原始EACCES路径删除新release；当前release从保留清理中排除。readdirSync抛EACCES的故障注入测试验证新发布仍可读、旧release保留，通过。 |
| R11 Major | 关闭 | JSONL索引全部带id节点，沿文件序最后节点回溯，仅DTO输出阶段过滤非message。中间compaction、末尾model_change、分叉回溯测试通过，不再用跳过父节点的弱fixture证明。 |

## 未关闭项：触发条件、证据及最小方向

### R01｜Critical｜Node的bin已保护，但发现过程执行的npm代码仍可被Work改写

**位置**：
- `server/src/agent/protected-roots.ts:100-123`：运行时根只增加nodePath父目录、node realpath父目录、piPackageRoot。
- `server/src/agent/runtime-resolver.ts:168-178,263-289`：自动发现会调用同bin下的npm执行`root -g`；收集候选后才挑有效pi包，已找到常见布局pi候选也不跳过该调用。
- `server/src/routes/agent.ts` Workspace创建时的collectAllProtectedRoots调用；`server/src/agent/agent-tool-service.ts:653-666,734起`：工具仍仅按同一根集合和Workspace containment裁决。

**失败输入/调用链**（自动发现、无显式piCliPath的常见POSIX安装布局）：

1. Node位于`<prefix>/bin/node`，npm为`<prefix>/bin/npm → ../lib/node_modules/npm/bin/npm-cli.js`，pi位于`<prefix>/lib/node_modules/@earendil-works/pi-coding-agent`。
2. 将`<prefix>/lib/node_modules/npm`作为Workspace注册并进入Work。它既不在受保护bin内，也不在pi包、应用、数据/凭据/raw/std根内；系统目录拦截也不禁止用户目录内的该路径。
3. Work的`ws_write`可修改`bin/npm-cli.js`或`lib/cli.js`等普通JS文件。
4. 用户点击Agent重新检测（resolver invalidate）/下次自动发现时，`npm root -g`经bin中的symlink执行已修改的JS。

**证据等级与实际影响**：静态调用链＋真实安装布局只读取证，**未改写npm、未执行攻击载荷**。本轮`readlink /Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/bin/npm`实际返回`../lib/node_modules/npm/bin/npm-cli.js`；只读查看该入口为`require('../lib/cli.js')(process)`。此npm根位于用户目录，不受系统`/usr`规则兜底。保护可执行symlink所在bin不能保护其指向的可写代码树。攻击由已授权Work工具自身完成，不需要shell工具或另一个同uid恶意进程；因此原“可写运行代码→间接执行”的Critical边界没有完全关闭。

**最小修复方向**：把发现/执行过程中实际加载的npm入口及依赖根纳入保护，或取消这条未隔离的可执行发现路径；应基于实际解析根而非仅把bin称为安装根。Node/pi经包管理器外置依赖时同样按真实加载关系确认，不必泛化禁止整个用户主目录。

**验收反例**：保留上述symlink布局，真实Workspace路由对npm包内目录必须400、对普通资料仍201；测试覆盖npm入口真实根及自动发现消费者，不修改宿主npm。当前测试只检查Node的bin目录400，不能覆盖此反例。

### R04｜Major｜settled后仍存活的收尾窗口会把新消息排入无人消费的旧队列

**位置**：`server/src/agent/session-service.ts:278-312,390-427`；`server/src/agent/pi-rpc-process.ts:521-534`；`server/tests/agent-session-concurrency.test.ts:233起`的收尾测试。

**失败时序/最小复现**：

1. 第一轮收到`agent_settled`，PiRpcProcess结束activeRun并resolve prompt；pi进程仍存活。
2. SessionService发出`run_end`，随后`await process.sendCommand('get_state', {})`回填sessionFile；此时`runs`直到finally仍保留原run。令受控RPC的这次get_state延迟返回，即可稳定放大窗口，无需真实模型。
3. 窗口内再次POST messages，带`delivery:'steer'`或`'followUp'`。代码只检查pool.get存在且进程未退出，所以向已经idle的pi发送steer/follow_up，并返回accepted及旧runId。
4. pi将消息排入内存队列而不会自行发起新的prompt；get_state完成后SessionService删除runs、广播idle。这条已被接受的消息不会在本轮产生回答/进入已消费的JSONL；需要下一次额外prompt才可能带出，或进程idle回收后丢失。

**支持证据**：静态时序已核实，未冒称新HTTP/模型复现。除项目代码外，只读核对本机pi1.4运行实现：`dist/modes/rpc/rpc-mode.js:319-325`直接调用session.steer/followUp；`dist/core/agent-session.js:1751-1767,1795-1820`无论isStreaming与否都会queue并返回`queued`，没有启动新一轮prompt。因此不能依赖RPC在idle时自动拒绝。新增收尾单测把fake.exited设为true，只验证“进程已退”分支，未覆盖“进程活着但activeRun已完成”。

**实际影响**：消息API确认接受，却不能保证本轮/独立下一轮执行，UI回idle而用户消息挂起或随后丢失。正常streaming场景已修复，但任务明确要求的收尾409仍未落实。

**最小修复方向/验收**：SessionService区分starting/running/settling，或使用权威RPC运行状态，在prompt结束的同步收尾入口停止接受delivery；settling期间409，或明确将其创建为新的受控运行。正式测试延迟get_state且保持进程存活，确认不再返回旧runId的虚假accepted；保留正常steer/follow_up同run验证。无需真实远程模型请求即可验证。

## 附加接线复核（没有另开新需求）

- **CJS**：读取`agent-assets.serverDistRoot`对dist-electron的专门分支；实际执行`agent-assets-cjs.test.ts`的真实bundle/加载/有Workspace更新测试通过。它证明CJS格式与路径接线，不证明Electron GUI本机可启动。
- **消息与停止**：读取完整assistant DTO、前端必需字段校验、message_end不清run锚点、多轮draft继续接流，以及abort ACK不覆盖较新SSE状态的修正；相关测试通过。不能据此前端修正将R04后端收尾窗口视为已关闭。
- **发布后阅读**：KnowledgeView按新树重选失效docId，正文依赖release和重试nonce，request sequence与release不一致响应被拒，渲染也检查树/状态/正文release一致。新增3项选择测试通过。采信上游bg-06a78e98“不刷新页面DOM buildId等于新CURRENT、raw完整SHA不变”证据；截图13是修后，07/09/12保留的修前失败现场不作当前回归。
- **MCP/构建**：本轮未重跑无改动MCP四工具；采用Leader最终生成产物真实stdio重测记录。没有新增MCP写工具或SQLite依赖的证据。

## 实际命令与可信度

1. cwd=`server/`：
   `npx vitest run tests/protected-workspace.test.ts tests/agent-assets-cjs.test.ts tests/agent-session-concurrency.test.ts tests/app-llm-fixture.test.ts tests/agent-session.test.ts tests/kb-build.test.ts tests/agent-config.test.ts`
   → **exit0，7文件71项，约17秒**。app-llm两项为真实pi对本地fixture；temporary FEISHU_SYNC_HOME/DB隔离，不碰真实认证文件。
2. cwd=项目根：
   `npx vitest run src/views/KnowledgeView.test.ts src/utils/agentReadiness.test.ts src/utils/sseStream.test.ts src/components/preview/remoteImageConsent.test.ts`
   → **exit0，4文件29项**。
3. cwd=项目根：`npm run typecheck` → **exit0，前端/根配置/server三段通过**。
4. 只读取证：`command -v node`、`command -v npm`、上述npm的`readlink`、实际npm入口读取、git status/diff统计。工具把command-v探测误提示为可能交互，但命令实际即时退出，没有启动REPL；未据此调整环境或重试安装。

没有新增测试/复现脚本：唯一写面仍为本报告；未关闭项提供具体输入和可控时序，正式回归由实施者负责。现有测试全部通过不覆盖这两个反例。

## 未覆盖、遗留观察及交付边界

- 真实远程app-llm Key/端点、Electron dyld运行、Windows/安装包资源真加载仍未验证；本轮没有模型新请求、真实3191/5178操作、依赖/ABI/OS调整或提交。真实GLM工具/Work/构建及重复full证据采用集成报告，不冒称本轮执行。
- R05的每种OS异常退出→令牌失效未逐个做真实进程故障注入；当前exit绑定与失败清理路径可静态复核，池与受控并发测试通过，保留为验证盲区而非额外未证实finding。
- 初审已声明的本地发布目录被外部同uid修改、超大库成本/性能与视觉审美等观察不因本轮复审升级为新阻断项；未发现需另报的修复引入Major回归。
- 当前关闭矩阵不表示安全阶段已通过。按主上“仅一次增量复审”的约定，交还Leader上报R01/R04残留，不自行修复、不自动进入下一轮。
- 本轮只覆盖写入报告；报告回滚为恢复/删除本报告文本，项目代码无本轮变更。
