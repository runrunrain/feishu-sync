# C3 / P5 内网只读 MCP 网关交付

## 生产默认看门狗补测（最新）

Leader 已将此前4个增量文件和报告集成主树并报告主树构建及P5相关测试通过；本节只记录本 worktree 新增的独立实测，不冒称重跑主树测试。**生产默认时序下，本次真实 regex→SIGKILL→新客户端 literal 成功耗时 13,029.46 ms，满足 ≤15,000 ms，余量 1,970.54 ms。** 这是一次本机观测，不是跨机器、负载或睡眠的最坏情况保证。

- 真实入口：`KbLanGatewayManager` + `server/dist/mcp/kb-mcp-gateway.cjs` + MCP SDK HTTP Client；临时合成 release 的正文含60个 `a` 和后缀 `b`，实际调用 `grep_knowledge` 的 regex `(a|aa)+$`，等待父进程 watchdog 归因并 SIGKILL；重新连接后实际调用 literal `fixture` 且结果包含该词。
- 配置：**未传 `timing`、未传时钟注入**；实读管理器运行值 `tickMs=2000`、`heartbeatMs=10000`、`backoffMs=1000`。回环 `127.0.0.1` 随机端口、临时合成目录；计时从发起 regex 调用前到新客户端 literal 调用返回，包含看门狗、重启退避、客户端重连与调用。
- 运行命令（cwd 本 worktree `server/`）：`npx vitest run tests/kb-lan-prod-watchdog-temporary.test.ts`，命令预算60s、测试预算35s；退出0、1/1通过、总耗时13.43s。debugTag `p5-production-watchdog`。测试之后正常关闭客户端与管理器并删除其临时目录，按授权删除本次临时脚本；因此上述脚本路径仅为本次运行记录，不是仓库持久测试入口。
- 脱敏原始关键日志（无 token、完整 session、端口或资料内容）：

```json
{"phase":"regex-start","tickMs":2000,"heartbeatMs":10000,"backoffMs":1000,"timingInjected":false}
{"phase":"watchdog","killObservedMs":11929.381625,"sessionAttributed":true}
{"phase":"recovered","elapsedMs":13029.462416999999,"killObservedMs":11929.381625,"firstExitMs":11921.3745,"restartedMs":13018.465167,"firstSignal":"SIGKILL","spawnedChildren":2,"pendingOutcome":"disconnected","literalError":false,"literalHasFixture":true,"indexBuilds":2,"sessionAttributed":true,"regexLeaked":false,"budgetMs":15000,"withinBudget":true}
```

`killObservedMs` 为轮询读到审计的时间，故可以晚于进程 `exit` 回调的 `firstExitMs`；两者均相对发起 regex 计时。审计成功归因原 session、未记录正则文本；两次子进程各完成一次索引构建。本次唯一保留改动为本报告，未改产品代码或默认测试，未跑全量测试、未提交 Git。真实 sleep/24h、异机、Electron 主进程负载仍未覆盖。

## 最终续接结果（当前状态，覆盖下方历史阻塞结论）

**结果：三端真实集成与必要构建已通过，先前同步缺口闭合。** Leader 同步的 `server/src/routes/kb.ts` 经 `cmp -s` 确认与主树逐字节一致，第 275 行使用 `await store.search(...)`。此前旧路由将 Promise 直接放入 JSON，导致 `/api/kb/search` 返回 `results:{}`（历史失败 debugTag `p5-real-redos`）；同步后在本 worktree 重跑构建与完整三端集成，均退出0（`p5-final-integration`）。本代理没有改该路由或写主树。

最终续接轮实际只修改本报告；未修改代码、测试或 Leader 同步文件。下述“重项续接增量”保留上一轮本代理相对依赖同步基线的真实新增/修改，供 Leader 精确合并；复制的依赖不计本代理产出。用户要求的真实语料/80条、异机、睡眠、24h、Electron 主进程负载均未覆盖，不能以单机合成结果替代。

当前收到的合成规模生成器 `server/scripts/lib/kb-eval-synthetic.ts` 引用的 `kb-eval-io.ts` 在本树未同步，主树两者均实存。本轮 benchmark 显式**只读**主树原版生成器与依赖来写系统临时目录，未复制或改主树；可迁移环境需通过 `KB_LAN_PERF_GENERATOR` 指向含完整依赖的真实生成器。无真实80条、第二设备、睡眠、24h证据；UI/Electron交互由 Leader 与洛神承担。

### 重项续接增量（相对接收同步后的基线；非整树覆盖）

1. `server/src/mcp/kb-mcp-gateway.ts`：使用现有公开 `KbIndexCache` 注入接口，在原 cache 的实际 build callback 外计时并输出 `index_build/indexBuildMs` 审计；缓存命中、并发等待不重复计数；失败只记录状态和耗时，不泄漏目录或内容。没有改公共查询引擎、构建算法或另造索引。
2. `server/src/kb-lan/audit.ts`：允许上述 `index_build` 事件，沿用字段白名单（`indexBuildMs` 原本已有白名单但没有生产者）。
3. `server/tests/kb-lan-watchdog-integration.test.ts`：正式 CJS + 实际工具 + 子进程看门狗与索引审计集成。
4. `server/tests/kb-lan-performance.test.ts`：显式 opt-in 的真实网关与现有 `scripts/kb-lan-bench.ts` 组合压测；默认跳过，绝不对真实库自动生成数据。
5. `agent-outputs/workflow/20261029-kb-retrieval-mcp/gateway-report.md`：本报告。**没有修改** Leader 同步进来的文件、公共搜索引擎、基准 CLI 或主树；未 commit/stage。下方历史树清单记录的是更早的完整切片，不能当成本次续接增量。

#### indexBuildMs 精确最小合并片段

合并到已有 `server/src/mcp/kb-mcp-gateway.ts`：增加 `KbIndexCache`、`KbIndex` 两个 import，在已有 `emit` 之后加入如下子类；仅把原先 `new KbQueryService(root)` 换为 `new KbQueryService(root, { cache: new AuditedIndexCache() })`。`super.get` 仍负责原有缓存命中和 pending 去重，仅真正触发的 `build()` 计时，错误重新抛出：

```ts
import { KbIndexCache } from '../kb/search/kb-index-cache.js';
import type { KbIndex } from '../kb/search/index-types.js';

class AuditedIndexCache extends KbIndexCache {
  override get(key: string, build: () => Promise<KbIndex>): Promise<KbIndex> {
    return super.get(key, async () => {
      const start = performance.now();
      try {
        const index = await build();
        emit({ type: 'audit', event: 'index_build', releaseId: index.releaseId, status: 'ok', indexBuildMs: performance.now() - start });
        return index;
      } catch (error) {
        emit({ type: 'audit', event: 'index_build', status: 'error', indexBuildMs: performance.now() - start });
        throw error;
      }
    });
  }
}
// service 初始化替换：
const service = new KbQueryService(root, { cache: new AuditedIndexCache() });
```

合并到 `server/src/kb-lan/audit.ts`：在 `EVENTS` 集合中只追加 `'index_build'`；`indexBuildMs` 的非负有限数值白名单原有即存在，无需改公共 cache、service、store 或其他字段。两份新测试按路径单独合并，不把 Leader 同步的 `routes/kb.ts`、`kb/search`、`kb-mcp-tools.ts`、`kb-mcp-server.ts`、`kb-search.ts`、`standard-kb-store.ts`、既有集成测试与 fixture 当作本次新增文件整树覆盖。

### 重项一：正式 CJS、合成规模真实数值

命令（cwd 本 worktree `server/`，Node v24.21.0，macOS arm64，本机 127.0.0.1 随机端口；生成器 deterministic seed `0x20261029`，不是真实语料/真实内网）：

```sh
npm run build
KB_LAN_PERF_GENERATOR=/Users/run.mao/workpace/feishu-sync/server/scripts/lib/kb-eval-synthetic.ts npx vitest run tests/kb-lan-performance.test.ts
```

两命令退出0；性能 2 tests，debugTag `p5-perf-final`。每规模生成全新临时 release（正文分别精确 10,485,760 / 31,457,280 bytes，250 / 750 篇），每工况重新启用全新实际子进程。预热与首个客户端并发，首调计时包含 initialize + search + 客户端 close；`冷启动总计`从 manager enable 前开始，含 spawn/ready/首调。warm 是已有 SDK benchmark 脚本调用 `search_knowledge`，六个固定合成查询循环；单客户端30轮30次，3客户端各4并发×10轮120次。

| 正文 | 工况 | 冷启动总计 ms | 首客户端 ms | 实际 indexBuildMs | warm p50/p95/max ms | queue p95 ms | kb_busy / errors | 父loop p99 基线→负载，增量 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 10 MiB | 1×1 | 227.20 | 116.96 | 111.52 | 2.18 / 3.87 / 4.42 | 0.0118 | 0 / 0 | 11.108 → 11.772，+0.664 |
| 10 MiB | 3×4 | 247.96 | 193.90 | 163.82 | 13.96 / 28.00 / 38.46 | 0.0115 | 0 / 0 | 11.297 → 11.592，+0.295 |
| 30 MiB | 1×1 | 436.16 | 309.66 | 309.65 | 3.96 / 8.01 / 9.35 | 0.0257 | 0 / 0 | 11.076 → 11.043，−0.033 |
| 30 MiB | 3×4 | 389.34 | 307.31 | 311.95 | 27.61 / 52.97 / 58.62 | 0.0070 | 0 / 0 | 11.076 → 11.330，+0.254 |

每子进程的 `index_build` 精确1条（包括启动预热/首调竞争），工具审计数分别32或124，包含预热后的首次调用与benchmark连接首调。queue p95 来自父审计的应用层队列等待，含冷首调，不包含客户端网络/Node事件循环中请求尚未进入队列的等待；不能把小 queueMs 解释成总排队延迟。p95 是这一短样本的观测，30单次/120并发；负载/基线 p99 来自**同一 Node 测试父进程** `monitorEventLoopDelay`（10ms分辨率、基线1s），并非 Electron 主进程实测。按设计的合成单机预算，10MiB 单/3×4及30MiB单实例均低于表中阈值、busy=0；30MiB并发为仅记录项。**第二设备链路、真实语料和 Electron p99 增量仍未验证**，不能外推真实容量。

### 重项二：真实 grep → watchdog → 恢复

`npx vitest run tests/kb-lan-security.test.ts tests/kb-lan-http.test.ts tests/kb-lan-manager.test.ts tests/kb-lan-config-api.test.ts tests/kb-lan-server.test.ts tests/kb-lan-watchdog-integration.test.ts`，cwd `server/`，退出0，6文件66项；debugTag `p5-regression`。

新增测试使用实际 `KbLanGatewayManager`、正式 `kb-mcp-gateway.cjs`、SDK HTTP Client、真实 `grep_knowledge`，临时 release 文档包含60个 `a` 后接 `b`，调用 `mode=regex, pattern=(a|aa)+$`；该样例能通过嵌套量词粗判而真正卡住 JS regexp。观测：旧进程 PID 11216 收 `SIGKILL`，PID 11272 重新启动，旧请求断开，新会话 literal grep 成功，经过 **3135.30ms**；审计包含原会话前8位并不包含正则文本。测试独立注入 **heartbeatMs=3000、tickMs=100、backoffMs=100**；生产默认分别10s、2s、1s，不能把3.14秒称为正式阈值实测。本测试还断言两个子进程分别实际构建索引一次，审计记录 `indexBuildMs=0.656/0.890ms`，未重复计数。真实系统睡眠/24h仍未测。

### 真实入口回归与边界

- `npm run build`（cwd `server/`）退出0：tsc与完整资产构建通过，构建脚本对两个MCP bundle执行无 better-sqlite3/.node 检查。
- `npx vitest run tests/kb-lan-integration.test.ts -t 'Node20/Electron'` 退出0：1通过/1跳过。**Node20 Electron RunAsNode 实际 bundle**：列出7工具并真实 search；此测试没有逐一调用7工具。
- 最终续接：`npm run build && npx vitest run tests/kb-lan-integration.test.ts`（cwd worktree `server/`）退出0，**2/2通过**。实际 desktop 管理 API→正式 CJS 子进程→MCP SDK，search 的网关与 stdio 完整响应一致、结果与 server API 一致；网关实际调用7工具，两个 session 独立 CURRENT 变更 notice 各只出现一次；rotate 后旧 Bearer 401、旧 session 携新 Bearer 404；disable 关闭监听并分别验证保留/撤销令牌；审计不含令牌或合成查询。第二项通过 Electron RunAsNode 列出7工具并搜索，不等于完整 Electron UI 测试。测试用临时根和本机随机端口。
- 历史失败保留：旧同步快照上 `npx vitest run tests/kb-lan-watchdog-integration.test.ts tests/kb-lan-integration.test.ts` 退出1，原因见本节开头；该失败现被上述实际通过覆盖，不改写为历史通过。
- `npx eslint server/src/mcp/kb-mcp-gateway.ts server/src/kb-lan/audit.ts server/tests/kb-lan-watchdog-integration.test.ts server/tests/kb-lan-performance.test.ts && git diff --check -- server`（cwd worktree）退出0。
- 未跑全量测试、没有配置模型覆盖、没有启动共享UI、没有访问真实知识库或开放真实内网。

### 验收矩阵更新

| 项 | 本轮状态 |
|---|---|
| A1 | 机制回归66项通过；本树真实管理链及令牌轮换/禁用2项集成通过 |
| A2 | 同一 search 网关与stdio完整响应一致、结果与server一致；双session的CURRENT切换 notice各一次；旧路由同步缺口已闭合 |
| A3 | **实际grep→真实CJS watchdog→恢复通过**：生产默认时序单次13,029.46ms ≤15s；另有注入短时序回归。真睡眠/24h未测 |
| A4 | **合成10/30MiB回环单机指标如上**；异机和真实Electron主进程隔离未测 |
| A5 | SDK实连；pi/Claude及异机、中文截断未测 |
| A6 | UI真实交互非本轮，交Leader/洛神 |
| A7 | build、bundle原生检查、Node网关七工具调用、Electron Node20列7工具及真实search通过；Electron Node20未逐个调用其他六工具 |
| A8 | 本轮Node测试父进程真实管理子进程；完整Electron应用开启网关仍待Leader |

**本轮回滚**：只局部移除上列 4 个增量文件中的计时事件与两项测试，以及本报告续接段；不要撤销已同步的Leader文件、共用引擎或他人现场。进程、临时 release 与临时根由测试 teardown 回收。安全/生命周期 Gate 留 Leader 集成审核。

---

## 上一轮历史记录（当时依赖缺失，状态不再适用）

## 结论与 QUESTIONS

**状态：blocked，不是成品已验收。** 已实现全部独立的令牌、网络、HTTP 会话、并发、进程管理、配置/API/命令表防旁路、构建接线和基准脚本；最新 5 个新增测试文件 **65 项通过**。相关 stdio / CLI 回归另已通过。最终网关入口严格引用冻结的共用注册与检索服务，没有复制工具或自造占位。

**Q1（续接唯一必要输入）**：请 Leader 将 B1 已验收的 `server/src/kb/search/`（含 `kb-query-service.ts` 及其真实依赖）与正式 `server/src/mcp/kb-mcp-tools.ts` 同步进本 worktree 后 resume。当前这两个导入在本树均不存在，`npm run build` 退出 2，只有对应两条 TS2307。主树 registry 已实读，契约兼容；本轮观察时主树检索服务仍未实存，因此没有擅自拷入半成品或用 stub 消除错误。

不长等、不提交 Git。安全/生命周期最终 Gate 仍由 Leader 集成后交 diting。

## 上游输入与已读范围

完整实读：
- `/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`（1234 行，§13 全部）。
- 本 worktree `CLAUDE.md`、`docs/design/agent-knowledge-design.md`、`docs/design/kb-agent-upgrade-design.md`。
- `/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/20261029-kb-retrieval-mcp/investigation.md`。
- `/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-retrieval-ui/agent-outputs/workflow/20261029-kb-retrieval-mcp/ui-report.md`，含 API 章节。
- `/Users/run.mao/workpace/feishu-sync/server/src/mcp/kb-mcp-tools.ts`（只读：冻结的 registerKbTools 与 KB_MCP_INSTRUCTIONS）。

实现前按目标段读取既有 index/config/ops/auth/CLI/资产构建/SDK 类型；未触前端、检索引擎、stdio 源码、锁文件、Electron 源码或发布格式。

## Changed files / 树路径

工作树：`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-retrieval-gateway`。

```text
server/
├── src/kb-lan/                                  新增
│   ├── network.ts                              CIDR、mapped IPv6、绑定与配置校验
│   ├── token-store.ts                          持久秘密、摘要比较、防链接与原子替换
│   ├── audit.ts                                父进程白名单审计、认证聚合、轮转
│   ├── call-queue.ts                           有界公平准入与 regex 串行
│   ├── http-gateway.ts                         Stateful Streamable HTTP 传输
│   └── gateway-manager.ts                      子进程/心跳/恢复/网卡/管理操作
├── src/mcp/kb-mcp-gateway.ts                    新增：正式子进程入口，依赖待提供
├── src/routes/kb-lan-mcp.ts                     新增：七个 desktop-only 管理 API
├── src/index.ts                                修改：DI、路由、启动/关闭/standalone 信号
├── src/types/index.ts                          修改：可选 KbLanMcpConfig
├── src/modules/config-manager.ts               修改：内存缺省、校验、规范化
├── src/routes/config.ts                        修改：所有主体剔除 kbLanMcp；输出根变更重启
├── src/ops/command-table.ts                     修改：禁止整段及所有子键，帮助文字同步
├── scripts/lib/mcp-bundle.mjs                   修改：共用 node20 CJS 构建 + 原生模块断言
├── scripts/build-agent-assets.mjs              修改：新增网关 bundle
├── scripts/kb-lan-bench.ts                      新增：SDK 多客户端实际调用基准
└── tests/                                      新增
    ├── kb-lan-security.test.ts                  42 项
    ├── kb-lan-http.test.ts                       8 项
    ├── kb-lan-manager.test.ts                    9 项
    ├── kb-lan-config-api.test.ts                 5 项
    └── kb-lan-server.test.ts                     1 项
```

共 7 个既有文件修改、14 个新实现/测试文件，另有本报告。生成的 `server/dist/` 是忽略的构建输出，不宣称已生成可交付网关 bundle。

预检已有 `?? node_modules` 外链；本轮为缺失的 server 依赖接入 `server/node_modules -> /Users/run.mao/workpace/feishu-sync/server/node_modules`，仅依赖复用，不纳入代码交付/提交。额外观察到范围外 `amagi.json` 修改，未触碰、未纳入交付。未 commit/stage。

## 规格 → 实现

| 规格 | 产物与行为 |
|---|---|
| 独立进程、固定端口、主监听不外放 | gateway-manager 派生 node20 CJS 入口；未修改主服务 hostname/port 选择。实际主服务测试绑定 127.0.0.1 随机端口 |
| 只读工具共用 | 入口只 new 一次 KbQueryService；registerKbTools(Server, service, state) 每会话独立 state；instructions 复用正式导出；预热走同一 service.releaseInfo |
| 有状态 HTTP | 仅 `/mcp`；GET405，无 GET SSE；enableJsonResponse；64KiB 声明长度/分块体限制；10s/60s/5s 超时；随机 UUID；每请求认证；socket IP 绑定；墙钟 TTL30m；默认16、硬1..64，满时淘汰最老且空闲>5m 的会话 |
| 网络 | 只用 socket.remoteAddress，忽略 XFF；默认私网集合，配置 CIDR 只能收窄；IPv6 BigInt 子网比较、mapped 十进制/十六进制归一，保留 link-local scope 身份 |
| 鉴权与拒绝顺序 | 源地址 → Origin → 失败 IP 限速 → Bearer → 会话；10 次/60s 后封5m；摘要32B等长 timingSafeEqual 全表比较。foreign 头审计并拒绝（即使同时带正确 Bearer）；401 只有 Bearer realm，不引导 OAuth |
| 并发 | 全局4、会话2、等待32/10s；最老可执行请求晋级，饱和会话不挡其他客户端；kb_busy 可重试；regex 全局串行并在开始前发审计 |
| 令牌 | secrets 0700 / 文件0600；明确 lstat / O_NOFOLLOW / nlink 检查；同目录独占 tmp、fsync、rename、chmod 与失败清理；明文不入 config/argv，child env 仅摘要；停用保留/撤销、轮换先停旧 child，查看有审计 |
| Manager | ready/hb/audit/fatal NDJSON；只继承指定非敏感调参，Electron 额外 RunAsNode；2s心跳/10s单调看门狗、父漂移>5s重置；1..60s退避、10m5次停止；port_in_use 不换不重试；30s网卡恢复/auto换址；SIGTERM3s后KILL；关闭不复活 |
| 状态与 URL | 冻结字段；macOS 由 scutil LocalHostName 取得真实系统 `.local` 名称，失败不捏造；wildcard 地址转换为接口 URL；Windows 不加 .local |
| 审计 | 仅父进程落盘，白名单元数据，无 query/body/token；session8位；auth_fail 按IP/分钟延迟聚合计数；5MiB轮转仅一份 `.1`；定时审计失败停止子进程，不让异常穿透主事件循环 |
| 单一管理入口 | 管理 API 自带 desktop 校验并拒 CLI actor/头；PUT config 所有主体丢 kbLanMcp；共用 config.set 拒整段/任意子键，无新 LAN 运维命令；缺省段仅内存补，不触发迁移回写 |
| 生命周期 | startServer 主监听后异步 start；started.close 先关网关。既有 Electron QuitCoordinator 已走该 close，不重复改 Electron；standalone SIGINT/SIGTERM 同样调用 close |

### API（已按 UI 冻结形态对齐）

所有路径前缀 `/api/kb-lan-mcp`。必须 `X-Desktop-Token`，显式 CLI actor/头返回 `403 kb_lan_forbidden_actor`；所有响应 `Cache-Control: no-store`。

| 方法/后缀 | 输入 | 输出 |
|---|---|---|
| GET `/status` | — | `{enabled,state,bindAddress,resolvedHost,port,urls,sessions,inflight,queued,heapUsed,lastError,tokenMasked,interfaces}`，**lastError 为 string\|null** |
| POST `/enable` | `{bindAddress?,port?}` | status；明确 IP 必须当前存在；auto 暂无接口时保留启用意图并报 no_private_interface，后续自动恢复 |
| POST `/disable` | `{revokeToken?:boolean}` | status；默认保留令牌 |
| PUT `/settings` | `{bindAddress,port,maxSessions,allowCidrs?}` | status；省略 allowCidrs **恢复默认集合**，不保留旧列表；不能夹带 enabled/secret |
| POST `/token/rotate` | — | `{tokenMasked}`，旧 child 退出后再发布新摘要 |
| POST `/token/reveal` | — | `{token:string\|null}`，未生成/已撤销为 null，有查看审计 |
| GET `/audit?limit=50` | 整数1..200 | **直接审计条目数组**，最新在前，不包 entries envelope |

高级 wildcard 选择仍需前端风险确认，但后端独立校验端口、绑定地址、网卡存在性和 CIDR，不能由 UI 确认代替。v1 HTTP 明文剩余风险按设计保留，不修改防火墙、不广播、不做公网映射。

## 实际验证记录

cwd 除 lint 外均为 `<worktree>/server`。全部临时 root，HTTP 测试仅 127.0.0.1 随机端口。没有真正启用实际内网共享。

| 命令/步骤 | 退出 | 实际结果 |
|---|---:|---|
| `npx vitest run tests/kb-lan-security.test.ts tests/kb-lan-http.test.ts tests/kb-lan-manager.test.ts tests/kb-lan-config-api.test.ts tests/kb-lan-server.test.ts`（最终轮） | 0 | 5文件65项，2.71s。debugTag `gateway-final65` |
| `node --input-type=module -e "import {bundleMcp} from './scripts/lib/mcp-bundle.mjs'; console.log(await bundleMcp());"` | 0 | 旧 stdio bundle 536715B，新增原生模块断言通过；**不代表网关 bundle 已通过** |
| `npx vitest run` 上述5文件加 `tests/mcp-kb.test.ts tests/cli-endpoint.test.ts tests/cli-client.test.ts tests/cli-args.test.ts`（前一集成轮） | 0 | 当时共9文件125项。既有相关回归61项通过；之后新增1个auto恢复测试并对本任务65项最终重跑。debugTag `gateway-regression` |
| `npx eslint server/src/kb-lan server/src/mcp/kb-mcp-gateway.ts server/src/routes/kb-lan-mcp.ts server/src/index.ts server/src/types/index.ts server/src/modules/config-manager.ts server/src/routes/config.ts server/src/ops/command-table.ts server/tests/kb-lan-*.test.ts`（cwd worktree） | 0 | 目标源/测试无错误或警告；未把被项目忽略的 scripts 误称 lint 已覆盖 |
| `node --check server/scripts/lib/mcp-bundle.mjs` / `node --check server/scripts/build-agent-assets.mjs`（cwd worktree） | 0 | MJS 语法通过 |
| `git diff --check -- server`（cwd worktree） | 0 | 无空白错误 |
| `npm run typecheck` | 2 | 仅冻结上游两个模块未实存的 TS2307，不加 stub/声明绕过 |
| `npm run build`（最终轮） | 2 | tsc 同样两条 TS2307，尚未进入资产打包。debugTag `gateway-build-blocker` |

真实入口补充：
- `kb-lan-server.test.ts` 启动真实主 Hono server、SQLite 临时库、动态回环端口，经 fetch 实测 health/desktop管理/CLI commands/config.set 禁改/三域令牌拒绝及 close 后断连。
- 最新 lsof 原文关键行：`node 91511 … TCP 127.0.0.1:61813 (LISTEN)`；测试实际执行 `/usr/sbin/lsof -nP -a -p <pid> -iTCP:<port> -sTCP:LISTEN`，同时断言不含 `*:<port>`。
- HTTP 测试是真 socket + 官方 SDK Client，**工具 handler 明确是传输隔离 fixture**，不是检索服务集成。会话 IP 变化用 socket-address fixture 注入，不冒充第二设备或真实不同网卡。
- Manager 测试使用实际子进程与 NDJSON fixture，实际 SIGKILL/TERM→KILL/崩溃退避/看门狗；ReDoS fixture 实际执行 `(a|aa)+$` 对50个a加b，父进程杀掉堵塞的子进程并记录上一 regex session。这不等于真实 grep_knowledge 的完整软/硬防护已联调。
- 正式默认时间参数用可注入短参数验证机制；漂移测试注入单调时钟，没有声称真实睡眠测试。

## 测试 ↔ A1..A8 验收矩阵

| 验收 | 证据 | 状态 / 未闭合 |
|---|---|---|
| A1 安全矩阵 | security/http/config-api/server 56项；令牌权限/链接/轮换、CIDR、Origin、XFF、失败限速、声明/分块体限制、会话IP/TTL、管理守卫、共享命令表、主服务三域互斥与 lsof | **partial**：独立机制通过；正式网关进程的开启/停用/轮换后旧Bearer401+旧session404还需真实上游/入口补证 |
| A2 三端一致/会话notice | HTTP 双 SDK 客户端独立 state fixture 通过；正式入口只共用 service 与 registry | **partial**：不能以 fixture notice 代替真实版本切换；逐字节三端一致、真实索引只建一次待 engine |
| A3 隔离恢复 | manager9项 + HeartbeatDeadline；实际子进程崩溃、SIGKILL、真实Regex阻塞、归因、退避停止、漂移/网卡/退出 | **partial**：机制通过；真实 grep HTTP→watchdog→恢复≤15s、真睡眠与24h未测 |
| A4 性能 | 已交 `scripts/kb-lan-bench.ts`，环境取令牌，N SDK客户端×并发，显式JSONL查询，输出聚合 p50/p95/max/首调/kb_busy/errors | **未运行**：缺真实engine/bundle；10/30MB、多客户端数值、queue p95、Electron event-loop 增量与第二设备均未测 |
| A5 客户端兼容 | 官方SDK HTTP实际连接可用；未用其替代 pi/Claude Code | **未覆盖**：第二设备、真实pi/Claude挂载、错误令牌客户端文案、8k/15k中文截断 |
| A6 前端 | 上游 ui-report 的隔离mock证据；本轮API按其解释对齐 | **非本轮写面 / 未完成集成验收**：真实Electron交互由Leader续接 |
| A7 产物 | 共用node20 CJS bundle与原生模块断言已接；旧stdio真实4项回归通过 | **blocked**：网关构建、Node20/Electron RunAsNode实际tools/call、网关无.node断言未执行 |
| A8 两种运行形态 | Node24真实startServer动态主端口、main回环、CLI/desktop/close通过；Electron退出钩子复用现存started.close | **partial**：真实Electron与standalone启用正式网关各一次尚未完成 |

## 续接清单、风险与回滚

依赖同步后最小续接：
1. 完整 build/typecheck；确认正式 gateway bundle 和 stdio 均无 better-sqlite3/.node。
2. 用临时已发布合成 release，实际启动网关 CJS；SDK 调7工具；比对 stdio/server 字节输出，双会话真实 CURRENT 切换告知、单 service/索引去重、分页游标。
3. 真管理API→子进程端口→tools/call→rotate/disable→旧Bearer/session拒绝；实际端口冲突不重试；真实regex经HTTP触发硬看门狗恢复。
4. Electron RunAsNode(Node20.18)与Node运行冒烟；运行多客户端bench，测10/30MB与父进程事件循环；不用机制fixture性能冒充成品性能。
5. Leader对齐并联调UI、diting安全/生命周期Gate；第二设备、实际睡眠、24h条件不具备则继续如实保留未覆盖。

风险：v1明文HTTP不防同网嗅探；同uid代码可读秘密，本实现不是OS沙箱；Windows ACL/IPv6真实网卡/睡眠/长期运行仍无实机证据；无真实语料性能数据。当前代码因缺输入不可完整构建，不应先发版或声称P5完成。

回滚：未提交，保留他人工作；只按本报告列出的7个既有文件 diff 局部撤回，并移除本轮14个新增实现/测试文件即可；不要 reset/restore 全树或改 amagi.json/他人外链。运行时依规范走 disable（可保留令牌），旧版本忽略可选配置段；不需要更改知识库发布文件/数据库。当前测试产生的临时进程和目录已由各测试 teardown 回收。
