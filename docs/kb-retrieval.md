# KB 检索子系统

面向开发者，描述标准库/原始库检索的模块结构、数据流、索引时机、限流与降级。检索子系统独立于同步引擎与构建流水线，纯只读、无 SQLite 依赖。使用侧说明见 [agent-knowledge.md](agent-knowledge.md)，共享配置见 [kb-lan-mcp.md](kb-lan-mcp.md)，评测见 [kb-evaluation.md](kb-evaluation.md)。

## 分层结构

| 层 | 模块 | 职责 |
|---|---|---|
| 纯函数 | `server/src/kb/kb-search.ts`、`kb/search/rank-lex-v1.ts`、`grep.ts`、`snippet.ts`、`normalize.ts`、`query.ts`、`outline.ts` | 查询解析、排序、片段、大纲；无 IO |
| 索引 | `kb/search/index-core.ts`、`kb-index.ts`、`kb-index-cache.ts`、`index-types.ts`、`header.ts` | release → 内存索引的构建与 LRU 缓存 |
| 查询门面 | `kb/search/kb-query-service.ts` | UI、内置 Agent 工具、stdio MCP、LAN MCP 共用的唯一查询入口（无会话状态、无写入） |
| 对象视图 | `kb/search/knowledge-index.ts`、`evidence-currency.ts`、`query-metadata.ts` | knowledge.json 的对象/关系/证据访问层；证据与当前源并列比对 |
| release 解析 | `kb/search/release-reader.ts`、`query-error.ts` | CURRENT 指针 → release 目录 → manifest 校验 |
| 原始库 | `server/src/kb/raw-query-service.ts`、`raw-search-score.ts`、`raw-mcp-catalog.ts` | 基于 raw-catalog.json 的浏览/检索/阅读/表格/图片/引用 |
| MCP 契约 | `server/src/mcp/kb-mcp-tools.ts`、`kb-mcp-server.ts`（stdio）、`kb-mcp-gateway.ts`（LAN 子进程） | 20 个只读工具的注册、参数校验、分页与预算 |

## 标准库数据流

1. **release 解析**（`release-reader.ts`）：读 `<outputRoot>/CURRENT.json` 指针（缺省即最新，可显式传 `releaseId`）；`releases/<id>/` 目录与 `manifest.json` 经 `resolveInside` realpath 围栏校验；`schemaVersion` 仅接受 1/2（v2 必含组织段）。未发布 → `kb_not_published`；版本被清理 → `kb_release_unavailable`。
2. **索引构建**（`kb-index.ts` `buildKbIndex`）：逐 manifest 文档读取 `docs/<path>`，用发布链同一公式 `computeSourceHash` 复核 `contentHash`；通过才进入索引，否则记入 `integrity.missing/mismatched`。`indexDoc`（`index-core.ts`）产出逐行缓存：`lines`/规范化全文 `normAll`/行偏移/字段 meta（title、tags、path、summary）/章节树（`outline.ts`）/表格范围；`assembleIndex` 汇总词表与平均长度。
3. **排序**（`rank-lex-v1.ts`，版本号 `lex-v1`）：BM25 风格字段权重（k1=1.2；title 5 / tags 4 / heading 4 / path 3 / summary 2 / body 1），tf 截断（meta 3 / body 20），coverage 平方乘子 + floor 0.25；查询单元无精确命中时经词表回退（回退分乘 φ=0.15，回退命中只作召回提示，不算关键词命中）；标题全覆盖 ×1.3；多单元同节命中加 proximity 0.3。结果先按「有无精确命中单元」分组再按分值与路径排序。
4. **查询方法**（`KbQueryService`）：`search` / `grep` / `outline` / `read` / `bundle` / `list` / `releaseInfo` / `getObject` / `objects`。对象级过滤（usage=browse|operational、types、businessStatuses、reviewStatuses、domainIds、asOf 业务日期）只在对象感知模式下生效；`operational` 仅返回 approved+已审查可用对象，无命中返回原因计数、不退回候选。证据新鲜度（`evidence-currency.ts`）：接受可选的当前源根，对每条证据按同一 hash 公式比对，输出 current / stale（并列发布依据与当前源版本）/ source_missing / unsupported。
5. **穷举**（`grep.ts`）：literal 逐行规范化匹配（NFKC；命中回映射原文偏移）；regex 显式模式拒绝嵌套量词、单行截 2000 字符、软时间预算（默认 300ms，超时返回 `complete:false, partialReason:'regex_time_budget'`），行长超限计入 `regexTruncatedLines`（`regex_line_limit`）。命中表格附表头。

应用内 `kb_grep` 仅支持 literal（正则走独立 MCP），见 `server/src/agent/tool-specs.ts` `KB_GREP_SPEC`。

## 索引缓存与更新时机

- **缓存键 = release 目录**，值 = 构建好的 `KbIndex`；`KbIndexCache`（`kb-index-cache.ts`）LRU 容量 2，构建中的 Promise 单独去重（并发请求共用一次构建，含驱逐后重入）。
- **更新即发布**：新构建原子切换 `CURRENT.json` → 下次 `resolveRelease` 得到新目录 → 新键构建新索引；旧 release 被清理策略回收后，缓存条目经存在性/realpath 复核删除（`kb-query-service.ts` `load`），调用者收到 `kb_release_unavailable`。索引不监听文件变化；release 目录本身不可变。
- **预热**：`KbQueryService` 构造即 `setImmediate` prewarm 当前 release（`prewarmCurrent`；未发布静默返回）。进程级共享入口 `getKbQueryService(kbRoot)`（同文件）按 kbRoot LRU 2 复用服务实例。
- **原始库清单**：业务 server 进程（Electron 桌面形态为 utilityProcess 子进程）启动时与运行期每 10 秒重写 `<dataRoot>/mcp/raw-catalog.json`（`server/src/index.ts` `startServer` 的 `rawCatalogTimer`；失败清空清单，不沿用旧允许面）。stdio/LAN MCP 读该清单访问原始库文件；应用关闭后 stdio MCP 用最后清单继续只读。
- **内存隔离**：LAN 网关是独立子进程，索引与缓存不占业务 server 进程的事件循环（Electron 下 server 本身也是 utilityProcess 子进程；`server/src/kb-lan/gateway-manager.ts`、`server/src/mcp/kb-mcp-gateway.ts`）；索引构建耗时经 `index_build` 审计事件上报。

## MCP 20 工具与检索的关系

`server/src/mcp/kb-mcp-tools.ts` 是 stdio 与 LAN 共用的唯一工具契约（`registerKbTools` 同一注册）：

- **标准库 9**：`search_knowledge`、`grep_knowledge`、`get_outline`、`get_knowledge`、`get_knowledge_bundle`、`list_knowledge`、`get_object`、`compare_knowledge`、`get_release_info`——内部直调 `KbQueryService` 同一方法。
- **原始库 10**：`raw_list`、`raw_search`、`raw_read`、`raw_list_sheets`、`raw_search_sheet`、`raw_read_sheet`、`raw_list_images`、`raw_search_images`、`raw_read_image`、`raw_links`——内部走 `RawQueryService`。
- **聚合 1**：`search_all_knowledge` 同时检索两类来源，任一来源失败仍返回另一来源。

内置 Agent 工具 `kb_search`/`kb_grep`/`kb_read`（`server/src/agent/tool-specs.ts`）经 `AgentToolService` 同样调 `getKbQueryService(outputRoot)`——UI、Agent、stdio MCP、LAN MCP 四入口同一门面，保证结果一致（`kb-search.ts` 模块头契约）。

原始库侧（`raw-query-service.ts`）：清单 >16MiB 或条目文件失联 → `raw_unavailable`（提示先启动应用完成索引）；单文件 >8MiB 拒读；评分 `raw-search-score.ts`（标题/路径/正文子串加权，单短语无命中才做碎片回退、回退分 ×0.1 且需 ≥2 碎片）；表格读取公式缓存值不重算；图片只复用识图缓存，不触发模型调用。

## 预算、分页与降级

- **字符预算**：服务级上限 `KB_MCP_MAX_CHARS`（默认 20000，最小 2000）；每页固定预留 512 字符给版本切换 notice（`kb-query-service.ts` `budget`）。工具按类设页帽：search/outline/list 8000、grep 12000、raw 单页 2800（pi 客户端时）。pi 客户端（按 `getClientVersion` 识别）整体压到 ≤6000 字符/页——pi 约 20KB 处截断文本；结构化副本与文本共同计入 19KB 拒绝线（`kb-mcp-tools.ts`）。
- **分页契约**：标准库用不透明 `cursor`（游标摘要含预算策略，notice 不影响游标）；原始库用 `nextOffset` + `contentHash`/`catalogHash` 变化检测；跨页携带同一 `releaseId` 保持行号有效。
- **版本切换 notice**：未钉版本的连续调用间 CURRENT 变化 → 首行提示「知识库已更新」，旧行号仅对旧 releaseId 有效。
- **降级路径**：文档哈希不匹配 → 逐文档 `kb_integrity_error`（不静默跳过）；对象数据在 v1 release 缺失 → legacy 提示；`get_object` 证据比对不可推导 → `unsupported` 如实标注。索引构建失败 → `kb_index_failed`。

## 限流与会话管理（LAN）

限流只作用于 LAN 网关，独立于 Agent 进程池（`server/src/kb-lan/call-queue.ts`、`http-gateway.ts`）：

| 参数 | 默认 | 行为 |
|---|---|---|
| 全局在途 | 4 | 超出排队 |
| 单会话在途 | 2 | 饱和会话不阻塞其他客户端队首 |
| 队列长度 / 等待 | 32 / 10s | 超限返回 `kb_busy`（retryAfterMs 1000） |
| 正则互斥 | 同一时间 1 个 | regex 调用串行，防回溯叠加 |
| 会话数 | 16（1..64） | 满 → 503 `kb_sessions_full`；空闲 ≥5min 可驱逐，TTL 30min |
| 认证失败 | 10 次/分钟/IP | 401 → 429 封禁 5 分钟 |
| 请求体 | 64KiB | 超限 413 |

**看门狗**：正则是不可中断的单次 `RegExp.exec`，网关以心跳（2s tick / 10s 超时）监督子进程；心跳超时 SIGKILL 重启，审计记 `watchdog_kill`（关联最近 regex 会话）。重启退避 1s×2ⁿ 封顶 60s，10 分钟内 5 次崩溃停止重试（`gateway-manager.ts`）。这会断开全部共享会话，但不阻塞桌面主进程。

## 评测

离线评测不启动应用、不连模型、不读 SQLite：`server/scripts/kb-eval.ts` + `scripts/lib/kb-eval-*`；`lex-v1` ranker 直接调产品 `KbQueryService`（真实章节命中与穷举分页），`l0`/`l1` 为基线 ranker。指标 docRecallAt10 / sectionHitAt5 / mrrAt10 等；人工标注 queries.jsonl 需 `provenance` 声明，真实数据不入仓。口径与运行方式见 [kb-evaluation.md](kb-evaluation.md)。

## 相关文档

- [security-model.md](security-model.md)：MCP 只读围栏、令牌与审计。
- [troubleshooting.md](troubleshooting.md)：检索相关故障速查。
- [data-contract.md](data-contract.md)：release/manifest 与标准头契约。
