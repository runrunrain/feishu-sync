# 知识库检索与 MCP 服务：Phase A0 只读证据调查

> 任务：P1/P2/P3/P5 实现接入点调查 + 真实评测前提 + 运行时/客户端可用性探测。只读，不改代码，不重跑测试。
> 输入：`…/知识库检索与MCP服务设计方案.md`（v1.1，1233 行，已完整读）、`docs/design/agent-knowledge-design.md`（784 行，已完整读）、`docs/design/kb-agent-upgrade-design.md`（645 行，已完整读）、CLAUDE.md。
> 调查日期：2026-10-29。所有行号以当前工作区文件为准（cwd=/Users/run.mao/workpace/feishu-sync）。

## 结论索引

| # | 主张 | 三态 | 锚点 | 适用边界 |
|---|---|---|---|---|
| A1 | 设计缺陷 F1–F11 全部在代码中印证，无遗漏无夸大 | 观察 | §A 各行号 | 当前工作区快照 |
| A2 | 设计 §2.3 未列的现状差异：MCP server 名 `feishu-kb`、`list_knowledge` 参数名 `prefix`、错误码 `kb_doc_not_found`/`kb_not_configured`/`unknown_tool` | 观察 | kb-mcp-server.ts:58,131,101,187 | P2 改名/改参数需按 additive 处理 |
| B1 | **UI 路由每次请求 `new StandardKbStore`**——P1 若把索引缓存挂 store 实例上，UI 端缓存形同虚设 | 观察 | routes/kb.ts:144-146 | agent 侧已有 `stores` Map 复用（agent-tool-service.ts:235,371）；MCP 进程单例无此问题 |
| B2 | 发布预热钩子挂点：`publishReleaseInner` 末尾 CURRENT rename（kb-build-service.ts:2060 附近），外层 `publishRelease` 成功返回后 | 观察 | kb-build-service.ts:1985-2006,2060 | 预热须不阻塞发布（设计 §6.4），挂 rename 后 |
| C1 | MCP v2 的唯一程序化消费者 `tests/mcp-kb.test.ts`（151 行）beforeAll 按需 `bundleMcp()` | 观察 | mcp-kb.test.ts:69-74 | P2 更新此测试即覆盖全部已知消费者 |
| D1 | 内置工具裁决面 = tool-specs.ts 规格 + agent-tool-service.ts 族注册 `runKinds` + `toolsForRunKind()` 派生 `--tools` 参数面 | 观察 | agent-tool-service.ts:271-305,320-363；session-service.ts:27,693-695 | P3 新增 kb_grep/改 kb_search 需同步两处 |
| E1 | P5 全部先例文件在位：路由顺序、close 生命周期、令牌文件、Host 头回环、asarUnpack、bundle 脚本、命令表禁改面、可选配置段、设置页卡片 | 观察 | §E 各锚点 | 与设计 §13 假设一致，无阻断性缺口 |
| F1 | 本机**无已发布标准库**：outputRoot 目录不存在、kb_builds 空、无任何 release | 观察 | §F 锚点 | E0 真实门槛/延迟只能用合成语料，U1 维持 |
| F2 | 可用 kb_search 查询日志 = 0 条（agent/sessions 目录不存在，agent_sessions=0） | 观察 | §F 锚点 | 评测集 80 条只能走来源①③（人工+读文档），来源②为空 |
| G1 | 无独立 Node 20；Electron 31.7.7 `ELECTRON_RUN_AS_NODE=1` 实测可跑（node v20.18.0，ABI 125） | 观察 | §G 命令输出 | Node20 验证只能走 Electron RunAsNode 或临时安装 Node 20 |
| G2 | **Claude Code 本机安装已损坏**：npm 包 2.1.312 的 `bin/claude.exe` 是 500B 报错 stub（原生二进制未安装），PATH 无 claude | 观察 | §G 锚点 | 修复命令在 stub 文本内：`node node_modules/@anthropic-ai/claude-code/install.cjs`（未执行） |
| G3 | pi 1.4.0 就绪（PATH 命中、cli.js 存在、engines ≥22.19.0 满足）；`~/.pi/agent/mcp.json` 尚不存在 | 观察 | §G 锚点 | pi 可承担 stdio/HTTP MCP 挂载验证 |
| H1 | 本机私网条件满足 P5：192.168.5.8/24 + Tailscale 100.92.24.117/32（CGNAT 段在放行段内）；LocalHostName `runmaodeMac-Mini` | 观察 | §G 命令输出 | 本机信息列举，未扫描网络 |
| H2 | 第二台设备（A4/A5 验收主体）无法从本机确认可得性 | 未覆盖 | — | 需主上提供一台装有 Claude Code/pi 的内网设备 |

---

## A. 设计与代码现状核对（缺陷印证 + 差异披露）

设计 §2.2 缺陷清单逐项与代码比对，全部属实：

| # | 设计主张 | 代码证据 |
|---|---|---|
| F1 整串退化 | `searchDocs` 拿 `query.trim().toLowerCase()` 整串做 `includes/indexOf`，无分词 | kb-search.ts:32,43-47 |
| F2 raw_search 不排序 | `toolRawSearch` 遍历顺序 push，`if (results.length >= limit) break;`——有 score 字段但只用于判零，不参与排序 | agent-tool-service.ts:582-620（break 在 ~615） |
| F3 全量重读 | `StandardKbStore.search` 每次调用新建 `bodyCache` Map，逐篇 `readReleaseDoc` 读盘 | standard-kb-store.ts:207-232 |
| F4/F5 无章节/分页 | `toolKbRead` 有行分页（offset/limit 默认 800），但 MCP `get_knowledge` 一次返回整篇 JSON | kb-mcp-server.ts:133-153；agent-tool-service.ts:513-547 |
| F6 list 平铺 | MCP `list_knowledge` 全量平铺带 summary，`prefix` 裸 `startsWith` | kb-mcp-server.ts:155-163 |
| F9 无版本告知 | MCP 每次调用仅 `store.readManifest()`，无 `lastServedCurrent` 记录 | kb-mcp-server.ts:99-101 |
| F10 headings 限制 | `publishReleaseInner` 只收 `/^##\s+/gm` 且 `.slice(0, 30)` | kb-build-service.ts:2033 |
| F11 缩进 JSON | 全部工具 `JSON.stringify(…, null, 2)` | kb-mcp-server.ts:124,153,161,182 |

设计 §2.3 已披露的差异之外，本轮新发现的现状差异（P2 落地时的对齐点）：

- MCP server 名 `feishu-kb`、version `0.1.0`（kb-mcp-server.ts:57-58）——设计 §7.1 目标名 `feishu-sync-kb`。server 名只出现在 initialize 响应 serverInfo，改名对客户端配置无影响。
- `list_knowledge` 现参数名 `prefix`（kb-mcp-server.ts:131,158）——设计 v2 用 `pathPrefix`。输入兼容 = 需同时接受 `prefix`（additive）。
- 现错误码：`kb_doc_not_found`（:114）、`kb_not_configured`（:101）、`unknown_tool`（:185）——设计 §7.9 用 `kb_not_found`；`kb_not_configured` 是 v2 错误表未列的现状码。
- MCP `search_knowledge` limit clamp 1..20（:123）；内置 `kb_search` 同（agent-tool-service.ts:501）；UI 路由同（routes/kb.ts:262）——三端 clamp 一致，v2 想放宽到 30 需三端同步。
- MCP `get_release_info` 现返回 `sourceCount`（:178）——v2 输出 schema 未含，属可保留的额外字段。

## B. P1（引擎+索引）接入点

1. **三端调用链（现状）**：
   - UI：`routes/kb.ts:255` `GET /api/kb/search` → `loadStore()`（:144-146，**每次请求 new StandardKbStore(config.standardKb.outputRoot)**）→ `store.search(manifest,q,limit)`。
   - 内置 agent：`agent-tool-service.ts:499` `toolKbSearch` → `this.storeFor(outputRoot)`（:371-374，按 outputRoot 缓存 store 实例的 `Map`，:235）。
   - MCP：kb-mcp-server.ts 进程内单 store（:88）。
   - **含义**：P1 的 `KbIndexCache` 若挂在 `StandardKbStore` 实例上，MCP 与 agent 端可行；**UI 路由必须改为共享实例**（模块级缓存或路由闭包内复用），否则每次请求重建索引。这是 P1 最容易被忽略的接入点事实。
2. **`searchDocs` 签名**（kb-search.ts:26-31）：`(docs: SearchableDoc[], query, limit=20, bodyFetcher?) => SearchHit[]`，纯函数。P1 改为薄包装转调 `KbQueryService.search` 时签名不变、结果排序变化（设计 §6.1）。`SearchHit` 已含 summary（基线 §10 未列，设计 §2.3 已披露）。
3. **发布预热钩子**：`publishReleaseInner`（kb-build-service.ts:2008）末尾 `fs.renameSync(tmpPath, pointerPath)`（:2060）是 F3-R10 指针提交点；外层 `publishRelease` 在其后再做尽力清理（:1992-1998）并返回 manifest。预热应挂 `publishRelease` 成功路径（rename 之后、异步不阻塞），与设计 §6.4「发布成功后异步触发预热」一致。
4. **构建/打包**：`server/scripts/lib/mcp-bundle.mjs`（esbuild bundle、platform=node、format=cjs、target=node20、无 external）→ `server/dist/mcp/kb-mcp.cjs`；由 `server/scripts/build-agent-assets.mjs` 调用（server `npm run build` = `tsc && node scripts/build-agent-assets.mjs`）。P1 新增 `kb/search/*` 源码目录会被 tsc + esbuild 自然带走，验收「bundle 不含 better-sqlite3」可直接对产物做字符串断言。
5. **contentHash 公式**：`computeSourceHash(path.join(docsDir,file), [], docsDir)`（kb-build-service.ts:2045）——P1 索引校验须复用同一函数（从 kb-build-service 导出或抽公共），不能另写。
6. **realpath 围栏**：`StandardKbStore.readReleaseDoc`（standard-kb-store.ts:148-157）已实现 `realpathSync.native` + `isPathInside` 校验；`buildKbIndex` 的读文件路径直接复用。

## C. P2（MCP v2 工具面）接入点

1. **改造主文件**：`server/src/mcp/kb-mcp-server.ts`（189 行）。工具注册在 `ListToolsRequestSchema` handler（:60-118），执行在 `CallToolRequestSchema` switch（:99-186）。v2 的 7 工具、预算、游标、`lastServedCurrent` 切换告知都在此文件展开；`resolveKbRootFromArgs`（:20-37）的 `--kb-root` + config 回退逻辑保持。
2. **唯一程序化消费者**：`server/tests/mcp-kb.test.ts`（151 行），beforeAll 按需 `bundleMcp()`（:69-74），用 StdioClientTransport 连真实产物、临时目录 fixture。P2 随工具面更新此文件即可；新增工具/错误码/预算合规/游标锚定单测放这里或拆新文件。
3. **文档更新点**：`docs/agent-knowledge.md` §「给其他工具连接只读 MCP」工具表（:186-191 现列 4 工具）。
4. **MCP SDK**：server/node_modules `@modelcontextprotocol/sdk` 1.32.2（与设计 E1 一致），`StreamableHTTPServerTransport` 存在（P5 用）。
5. **常驻 token 预算验收**（≤2.5k token）量法：`tools/list` 输出字符数估算——直接用 SDK Client `listTools()` 即可，测试基建已就绪。

## D. P3（内置工具/UI 对齐）接入点

1. **工具规格唯一源**：`server/src/agent/tool-specs.ts`（528 行）——`KB_SEARCH_SPEC`（:19-33）/`KB_READ_SPEC`（:35-50）/`RAW_SEARCH_SPEC`（:52-65）。P3 的 `kb_search` 加 `pathPrefix`+`hits`、`kb_read` 加 `section`、新增 `KB_GREP_SPEC` 都在此定义。
2. **族注册与模式白名单**：`agent-tool-service.ts:320-363` `registerToolFamily({ tools: [{ spec, runKinds, execute }] })`；`allowedToolsForRunKind`（:299-307）从族注册推导 runKind 白名单；session-service.ts:693-695 用 `toolsForRunKind(runKind)` 组 pi `--tools` 参数面。**新增 kb_grep = tool-specs 加 spec + 族注册加一行（runKinds: ['work','discuss']）+ 能力令牌如需同步在族名机制内处理**；Discuss 只读边界由 runKinds 白名单 + server 端 `allowedTools` 校验（agent-tool-service.ts:5 头注释）共同保证。
3. **raw_search 最小修复**（P0 范围，P3 报告需知）：`toolRawSearch`（agent-tool-service.ts:582）——P0 改为先打分排序再截断。
4. **UI 路由**：`routes/kb.ts:255-272` `GET /api/kb/search` 响应为 `{releaseId, results}`（SearchHit[]）；P1/P3 加 `hits` 为字段超集，前端可先不消费（设计 §9）。
5. **测试落点**：`server/tests/kb-search.test.ts`（纯函数）、`mcp-kb.test.ts`（MCP 面）、agent 工具测试在 `server/tests/agent-*.test.ts` 系列。

## E. P5（内网网关）接入点

全部先例已在位，与设计 §13 的事实假设（E1–E8）逐项吻合：

1. **路由注册顺序**（server/src/index.ts）：health（:552，永远最先）→ agentInternal（:557，pre-auth 自带回环+令牌）→ cliAdmin（:570，desktop token 域）→ cliRoutes（:577，CLI 令牌域）→ `authMiddleware()`（:588，desktopMode 时）→ 全部业务路由（:596-643）。**P5 的 `/api/kb-lan-mcp/*` 管理端点挂 desktop auth 之后的受保护区**（与 kbRoutes 同段），并按设计拒绝 CLI actor。
2. **startServer/close 生命周期**（index.ts:674-805）：
   - `startServer(options & {port?, hostname?})`，hostname 默认 `127.0.0.1`；Electron 传 port 0（electron/main.ts:187-192），standalone `127.0.0.1:3001`（:838-843，`FEISHU_SYNC_PORT` 可改）。
   - `close()` 顺序：approvals.close → 轮询器 stop → agentPool.closeAll（SIGTERM→3s→SIGKILL）→ HTTP close（宽限期踢连接）→ cliEndpoint.revoke。**网关子进程的停止挂这条链**（类似 cliEndpoint.revoke 的收尾位置或 agentPool 同级）；Electron 侧唯一退出路径 QuitCoordinator → started.close()（electron/main.ts:714 before-quit → handleBeforeQuit；S8 评估结论注释见 index.ts:804-806），server close 内挂钩即可覆盖两种形态，与设计 §13.2.2 生命周期表一致。
3. **spawn 形态**：`startServer` 在 Electron 主进程内运行，`process.execPath` 即 Electron 可执行；standalone 下是 node。网关 `spawn(process.execPath, [gatewayCjs,...], {env:{ELECTRON_RUN_AS_NODE:'1',...}})` 与设计 §13.2.2 表格逐字对应。**实测 Electron RunAsNode 可用**（见 §G）。
4. **bundle 挂点**：`server/scripts/build-agent-assets.mjs` 现有 `bundleMcp()`（mcp-bundle.mjs）+ `bundleCli()`（cli-bundle.mjs）两个先例；新增 `kb-mcp-gateway.cjs` 照抄 cli-bundle 模式加第三个调用即可。产物落 `server/dist/mcp/`，`asarUnpack: ["server/**"]`（electron-builder.config.cjs:98-100）已覆盖解包。
5. **令牌文件先例**：`server/src/cli-endpoint.ts`（180 行）——目录 0700 / 文件 0600 / tmp+rename / 写后显式 chmod（:167-172）、`crypto.randomBytes(32).toString('base64url')`（:110）、timingSafeEqual（:150-156）。P5 `kb-lan/token-store.ts` 沿用此模式（但持久化多令牌、只存明文按设计 §13.3.3）。
6. **回环判定事实（E2）**：`middleware/cli-auth.ts:34-40` 回环看 **Host 请求头**（URL host 兜底），非 socket 源地址；`CLI_TOKEN_HEADER = 'X-Cli-Token'`（:48）。设计「主监听器不能对内网开放」的论据成立。
7. **命令表禁改面**：`ops/command-table.ts:107-113` `CONFIG_SET_FORBIDDEN` 现禁 `cli.*`、llm 密钥面、`agent.workspaces`、`feishuWrite`——P5 增 `kbLanMcp.*` 一条即可；命令表不新增 kb-lan 命令（设计 §13.8.1）。
8. **可选配置段先例**：`types/index.ts:82-84`（`cli?: CliConfig; feishuWrite?: FeishuWriteConfig;`）；`config-manager.ts:1424,1427`（`normalizeCliConfigLoose(raw.cli)` 等 loose 归一 + :1107-1109 validate）。`KbLanMcpConfig` 照此三处接入；`PUT /api/config` 消费者侧丢弃先例在 routes/config.ts:166-177（对 CLI actor 删 `feishuWrite`），P5 对所有主体删 `kbLanMcp` 段。
9. **前端设置页先例**：`src/components/CliAccessSettingsCard.tsx`（CLI 卡片）与 `src/components/agent/AgentSettingsCard.tsx`（CardShell 组件 :58，AgentRuntimeSettingsCard :180 / AgentKbSettingsCard :730）——「知识库共享」卡片照 CliAccessSettingsCard 结构新建；API 出口统一 `src/api/client.ts`（X-Desktop-Token 自动注入 :83-88）。
10. **审计先例**：`<dataRoot>/agent/audit/cli.jsonl`（cli-auth.ts:83-95 appendAudit；只记元数据不记 body）——kb-lan-mcp.jsonl 同目录同约定。

## F. 真实评测前提（E0 可行性）

| 项 | 事实 | 锚点 |
|---|---|---|
| 默认位置 CURRENT | `~/.feishu-sync/standard-kb/` **目录不存在**（无 CURRENT.json、无 releases/） | `ls` 输出：No such file or directory |
| config `standardKb.outputRoot` | `/Users/run.mao/.feishu-sync/standard-kb`（= 默认值；retainReleases=3, buildParallelism=2, buildBatchSize=10）。仅提取此段，未读取/输出 llm 等其余段 | node 读 config.json，仅输出 standardKb |
| 发布统计（篇数/字节/章节） | **不适用**：kb_builds 表 0 行、无 release、agent_sessions 0 行 | better-sqlite3 只读查询 |
| 可用 kb_search 查询日志 | **0 条**：`~/.feishu-sync/agent/` 下无 `sessions/` 目录（仅 audit/pi-home/plugins）；Discuss 从未产生会话 | ls 输出 |
| 审计目录现状 | 仅 cli.jsonl / source-edits.jsonl / source-pushes.jsonl | ls 输出 |

**推论（基于上述证据）**：设计 §10.1 评测集三来源中来源②（会话日志采样）为空，80 条只能由来源①（策划/程序各 20 条真实问题）+ 来源③（标注者阅读文档补齐）构成。当前标准库未发布 → 标注对象也不存在；**E0 的真实语料前提尚不具备**，只能先做合成语料正确性验证（设计 U1 的处置：发布一个真实 release 前只用合成 fixture）。发布真实 release 需要可用的构建模型通道——config 含 llm 段（未读内容，存在性已确认），此处不判别其可用性（待核验项 V3）。

**纪律确认**：本轮未输出任何密钥/认证数据（config 只提取 standardKb 段）；未复制任何真实正文进仓库；无 LLM 生成评测条目。

## G. 运行时与客户端矩阵

| 项 | 事实 | 证据 |
|---|---|---|
| 系统 | macOS 27.0，arm64（Mac mini）；LocalHostName `runmaodeMac-Mini`（`.local` 稳定 URL 可用） | `sw_vers`/`uname -m`/`scutil --get LocalHostName` |
| Node（外部） | v24.21.0（fnm 唯一版本，default 别名）；无 volta/nvm/brew node。**无独立 Node 20** | fnm 目录列表 |
| Electron | 31.7.7（node_modules/electron）；`dist/Electron.app/Contents/MacOS/Electron` 存在；**`ELECTRON_RUN_AS_NODE=1` 实测输出 `node v20.18.0 electron-abI 125`** | 实测命令输出 |
| pi | 1.4.0 @ fnm v24.21.0 全局；`command -v pi` 命中；`dist/cli.js` 存在；engines `node>=22.19.0` 满足 | ls/node require |
| pi MCP 配置 | `~/.pi/agent/mcp.json` **不存在**（无既有 MCP 挂载，P2/P5 挂载时新建）；pi 文档 `docs/mcp.md` 确认 `--bearer-token-env-var` 存在（文档 :18） | cat 输出 |
| Claude Code | 包 2.1.312 @ fnm 全局，但 **`bin/claude.exe` 是 500B ASCII stub（无执行位，执行报 "claude native binary not installed"）**；`~/.claude/downloads/versions/` 空；PATH 无 `claude`；`~/.claude.json` installMethod=global、mcpServers 空；`~/.claude/` 有 10-28 使用痕迹（此前可用） | file/执行输出/ls/node 读 .claude.json |
| 私网接口 | `inet 192.168.5.8/24`（活动连接）+ Tailscale `100.92.24.117/32`（在放行段 100.64.0.0/10 内）；服务列表含 Ethernet/Wi-Fi/Thunderbolt Bridge/Tailscale | ifconfig/networksetup（本机信息，未扫描网络） |

Claude Code 修复路径（stub 文本自带，**本轮未执行**）：`node node_modules/@anthropic-ai/claude-code/install.cjs` 或重装（不带 --ignore-scripts/--omit=optional）。修复前 P2 §10.4 端到端抽检与 U2/U7 实测不可做。

## H. 能完成与外部验收限制

**本轮证据支持的实现范围（不受阻）**：
- P0/P1/P3 全部代码与单测（合成 fixture）；P1 三端一致性单测、bundle 断言、Node20 冒烟可经 **Electron RunAsNode** 执行。
- P2 全部 schema/错误码/预算/游标单测（mcp-kb.test.ts 基建）；tools/list token 预算测量；**pi 挂载的 stdio MCP 实测可行**（pi 1.4.0 就绪）。
- P5 全部安全矩阵/一致性/隔离单测（vitest + 临时 FEISHU_SYNC_HOME + 网关绑 127.0.0.1 临时端口）；本机回环即覆盖 A1 大部分。
- E0 合成语料基准与评测工具脚本。

**外部验收限制（实现者需上报/等待条件）**：
1. **真实语料评测**（E0 真实门槛、§6.5 真实延迟）：无已发布 release。前置 = 发布一个真实 release（需可用模型通道，V3）。
2. **Claude Code 端到端**（P2 §10.4、U2/U7、P5 A5 Claude 侧）：本机安装损坏，需先修复（一条命令，但属环境变更，须主上/实现者授权执行）。
3. **第二台设备**（P5 A4/A5）：无法从本机确认存在；需主上提供一台内网设备（装有 Claude Code 与/或 pi）。本机网络条件（私网 + Tailscale + .local 主机名）满足服务端前提。
4. **独立 Node 20 环境**：不存在；「Node 20 下跑通」验收以 Electron RunAsNode（v20.18.0）为准，与设计 C2 的运行形态一致，但如需纯净 Node 20.19 CLI 验证需临时安装（环境变更，未执行）。
5. **macOS 真机交互验证**（P5 A6 前端卡片、A8 双形态）：需 Electron 真机运行，属实现阶段验证，非本轮调查范围。

## I. 待核验项与所缺证据

| # | 待核验 | 所缺证据 | 影响面 |
|---|---|---|---|
| V1 | Claude Code 修复后 `claude mcp add --transport http --header` / `.mcp.json` `${VAR}` 展开的实际行为（U7） | 修复安装后的本机实测 | P5 客户端接入文档与 X-Kb-Token 备用头决策 |
| V2 | Claude Code MCP 输出上限实测（U2：15k/25k/40k 各一次） | 同上 | `KB_MCP_MAX_CHARS` 默认值 |
| V3 | 构建模型通道可用性（llm 段配置了什么、端点是否可达——本轮按任务纪律未读 llm 段内容） | 需授权读取/探测 | 发布真实 release 的前置 |
| V4 | 第二台设备可得性及其客户端版本 | 主上提供设备 | P5 A4/A5 |
| V5 | pi 对 v2 `instructions` 首行的实际展示（U3 剩余） | P2 挂载后核对 | instructions 首行措辞 |
| V6 | 设计 §13.10 A3 系统睡眠唤醒/24h 长跑 | 实现阶段真机测试 | 看门狗参数 |

## 覆盖范围声明

- 已完整读：设计方案 v1.1 全文（1233 行）、agent-knowledge-design.md 全文（784 行）、kb-agent-upgrade-design.md 全文（645 行）。
- 已读代码：kb-search.ts、standard-kb-store.ts、kb-mcp-server.ts、tool-specs.ts（全文）；agent-tool-service.ts / kb-build-service.ts / index.ts / routes/kb.ts / config.ts / command-table.ts / cli-auth.ts / cli-endpoint.ts / electron-main.ts 的目标段；mcp-bundle.mjs、build-agent-assets.mjs 全文。
- 定向 grep/ls 覆盖：routes 目录、tests 目录（kb/mcp 相关）、前端组件目录、类型文件、构建链。
- 未做：泛仓库索引、测试重跑、任何文件修改、网络扫描、config 密钥段读取、Claude 修复安装。
