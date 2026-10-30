# P1 共用 lex-v1 引擎交付报告

## 结论与集成边界

P1 实现完成，留在 worktree 工作区，未 commit、未切分支、未覆盖主树 P2。排序、完整性、围栏、缓存、分页及三端真实入口的针对性回归通过；10/30MB 和真实检索质量门槛由 Leader/A2 后续接线，未在本轮重复测量。

- worktree：`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-retrieval-engine`
- 分支：`amagi/kb-retrieval-engine`
- 本报告实际路径：`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-retrieval-engine/agent-outputs/workflow/20261029-kb-retrieval-mcp/engine-report.md`
- 只改 P1 引擎及既有 search 的必要接线；不实现七工具注册、网关、内置新工具、会话 notice。没有改 `raw_search` 段。
- 特别注意：本树 `server/src/mcp/kb-mcp-server.ts` 只有旧 search 的一行 `await`；`server/tests/mcp-kb.test.ts` 只有真实 fixture hash 和临时 home 补丁。**不要整文件覆盖主树 Leader 的 P2 stdio/工具注册/测试**。应保留主树 P2，并按需要吸收这两项薄补丁。

## 必读输入与上游

- `/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`：完整 §§0–13 与附录。
- worktree `CLAUDE.md`、`docs/design/agent-knowledge-design.md`、`docs/design/kb-agent-upgrade-design.md`。
- worktree `agent-outputs/workflow/20261029-kb-retrieval-mcp/workflow.md`。
- 集成兼容核对只读参考：主树 `server/src/mcp/kb-mcp-tools.ts`；其 `maxChars`、QueryError、七方法与本轮接口匹配，未改主树。

## 实际产物与规格映射

| 要求 | 产物 | 行为 |
|---|---|---|
| §5.1 逐行 NFKC、大小写、Markdown 标记、行号 | `search/normalize.ts`、`index-core.ts` | 正文行与规范化行一一对应；path 单独规范化，tags 用分隔符连接 |
| §5.2 围栏、H2/H3 分段、H4 并入、表格 | `search/outline.ts` | 排序段不重叠；读 H2 时包含子 H3；引言只读自身；重复标题报歧义 |
| §5.3/5.4 查询、精确 df=0 才回退 | `search/query.ts`、`rank-lex-v1.ts` | 引号短语、去重、8 单元、ignored；语料词表最大正向匹配及未匹配段 bigram；每单元 8 子词、扫描项最多 24 |
| §5.5/5.6 BM25F | `search/rank-lex-v1.ts` | 集中导出冻结 `LEX_V1`；精确语料 df、IDF、tf cap、字段长度归一、覆盖率平方、同段共现、多段及全标题加成；未四舍五入前排序，path 确定性并列 |
| §5.7 片段、锚点 | `search/snippet.ts` | 命中单元最多的行，最多 160 字，表头最多 80 字且计入片段总预算；原文 `⟦⟧`；NFKC 扩展、组合字符和全角标记映射回原文 |
| §5.8 穷举 | `search/grep.ts` | literal 扫完整行；regex 原文匹配、固定 u/i、嵌套量词粗拒绝、单行前 2000 字、每 1000 行检查 300ms；path/行号排序，不按相关度截断 |
| §6.3 完整性与围栏 | `search/kb-index.ts`、`release-reader.ts` | 复用真实 `computeSourceHash`（包括 source_workbook），非正文 hash；release/docs/manifest/doc realpath 围栏；mismatch/missing 剔除；read 报完整性错误；releaseInfo 披露 |
| §6.4 生命周期 | `search/kb-index-cache.ts`、`kb-query-service.ts` | 2 个 settled index 的 LRU；在途 Promise 单独去重，拒绝可重试；默认每 50 篇 setImmediate；解析版本先过目录存在性/围栏；构建让出后再次检查清理 |
| §7/8 公共门面 | `search/kb-query-service.ts` | 七方法、字符预算、参数摘要绑定游标、游标锚定版本、单次单 release、章节/行号统一；没有 lastServedCurrent |
| 三端共用与预热 | Store、routes、agent-tool、旧 MCP search；build service | await 同一服务；API Store 复用；输出根共享 facade；CURRENT rename 后 setImmediate 预热，不等待预热结果 |

`search/` 相对上述目录均为 `server/src/kb/search/`。辅助文件 `header.ts` 避免 Store↔Service 环，`index-types.ts` / `index-core.ts` 保持纯 core 与 I/O 分离，`query-error.ts` 提供稳定错误。

## 公共 API：P2 / P5 可直接消费

实际导出位置：`server/src/kb/search/kb-query-service.ts`（ESM import 使用 `.js`）。以下类型均已导出，不需要下游再造参数、游标、预算或读取逻辑。

```ts
import { KbQueryService, QueryError, resolveRelease, readCurrent,
  type SearchParams, type GrepParams, type OutlineParams, type ReadParams,
  type BundleParams, type ListParams, type ReleaseInfoParams,
} from '../kb/search/kb-query-service.js';

new KbQueryService(kbRoot: string, options?: KbQueryServiceOptions)
service.prewarmCurrent(): Promise<void>
service.resolveRelease(releaseId?: string): ResolvedRelease
resolveRelease(kbRoot: string, releaseId?: string): ResolvedRelease
readCurrent(kbRoot: string): KbCurrentPointer | null

service.search(params: SearchParams): Promise<SearchResult>
service.grep(params: GrepParams): Promise<GrepResult>
service.outline(params: OutlineParams): Promise<TextPage>
service.read(params: ReadParams): Promise<ReadPage>
service.bundle(params: BundleParams): Promise<TextPage>
service.list(params?: ListParams): Promise<TextPage>
service.releaseInfo(params?: ReleaseInfoParams): Promise<ReleaseInfoResult>
```

`KbQueryServiceOptions`：`{ maxChars?: number; cache?: KbIndexCache; prewarm?: boolean; onWarmError?: (error: unknown) => void; yieldEvery?: number; yieldFn?: () => Promise<void> }`。构造默认后台预热；`prewarmCurrent()` 无 CURRENT 时正常返回，其他错误 reject；自动预热错误记日志或调用 onWarmError。`service.maxChars: number` 是有效硬上限，`service.cache: KbIndexCache` 可供测试/观测。options 不能绕过环境变量硬上限。

`ResolvedRelease = { releaseId: string; releaseDir: string; manifest: KbManifest; currentReleaseId?: string }`，releaseDir 已 realpath 裁决。每方法内部自行解析一次版本，下游不必先解析再传，避免二次解析竞态。

精确参数形状（可选值均按设计默认；maxChars 是统一门面提供的 additive 预算覆盖）：

```ts
interface PageParams { releaseId?: string; cursor?: string; maxChars?: number }
interface SearchParams extends PageParams {
  query: string; limit?: number; pathPrefix?: string; tags?: string[]; maxSnippets?: number;
}
interface GrepParams extends PageParams {
  pattern: string; mode?: 'literal'|'regex'; caseSensitive?: boolean;
  pathPrefix?: string; context?: number; maxMatches?: number;
}
interface OutlineParams extends PageParams {
  path?: string; docId?: string; pathPrefix?: string; depth?: 2|3;
}
interface ReadParams {
  path?: string; docId?: string; section?: string; startLine?: number;
  maxLines?: number; includeSources?: boolean; releaseId?: string; maxChars?: number;
}
interface BundleParams extends PageParams {
  pathPrefix?: string; paths?: string[]; dryRun?: boolean; lineNumbers?: boolean;
}
interface ListParams extends PageParams { pathPrefix?: string; depth?: number; includeSummary?: boolean }
interface ReleaseInfoParams extends PageParams { includeChanges?: boolean }
```

返回值与消费方式：

- `SearchResult`：`{releaseId, ranker, rankerVersion, query:{units,fallback,ignored,truncated?}, total, results, next, hint?}`；results 含旧五字段及 `score/coverage/hits`。lex-v1 的 summary ≤120 字；`snippet` 是首 hit。L1 回退保留旧五字段。
- `GrepResult`：`{releaseId,totalMatches,totalFiles,complete,partial?,partialReason?,regexTruncatedLines?,files:[{path,title,matches:[{line,heading,anchor,text,tableHeader?,before?,after?}]}],next}`。每匹配行一个记录（不是每个字符出现位置），全扫描后再分页。
- `TextPage = { releaseId: string; text: string; next: string|null }`：outline/list/bundle 的 **text 已含** release、必要的 next 行；bundle 还含摘要与 page 序号。P2 直接返回 text，不再 JSON.stringify 整个 TextPage。
- `ReadPage = { releaseId: string; text: string; next: number|null; startLine: number; endLine: number }`：startLine/endLine 是实际正文绝对行号；**next 是下一次调用的 startLine 参数**，有 section 时为节内 1-based 坐标，无 section 时即正文绝对行号。text 内已有相同 next 提示，并给出 releaseId 供继续读取。
- `ReleaseInfoResult`：设计字段外含 `sourceCount/model/next`；`changes.docs` 只有 path/title/kind/additions/deletions，不输出 patch。大 integrity / availableReleases / changes 清单可用同参数和 next 继续，verified/docCount/bodyChars 保持版本总量。
- `QueryError`：`new QueryError(code, message, details = {})`，公开 `code/message/details`，`toJSON()` 返回 `{error:{...details,code,message}}`。错误码为设计 §7.9 全集。

调用示例（真实接口用法，不冒充额外运行证据）：

```ts
const query = new KbQueryService(kbRoot);
await query.prewarmCurrent();
const hitPage = await query.search({ query: '暴击 结算', limit: 10 });
const first = hitPage.results[0]?.hits?.[0];
if (first) {
  const read = await query.read({ path: first.anchor, releaseId: hitPage.releaseId, maxLines: 100 });
  if (read.next !== null) {
    await query.read({ path: first.anchor, releaseId: read.releaseId, startLine: read.next, maxLines: 100 });
  }
}
const grepPage = await query.grep({ pattern: '1001', maxMatches: 100 });
if (grepPage.next) await query.grep({ pattern: '1001', maxMatches: 100, cursor: grepPage.next });
const bundle = await query.bundle({ pathPrefix: '战斗', dryRun: true });
// MCP 注册层：JSON 方法紧凑 JSON.stringify；文本方法取 .text。
// lastServedCurrent 只能在注册层的 sessionState 管理；显式 releaseId/cursor 均非跟随 CURRENT。
```

## 明确决策与边界

1. 设计同时要求 searchDocs 同步签名及转调异步门面，无法字面同时满足。本轮采用任务书推荐：`searchDocs(docs, query, limit?, bodyFetcher?) -> SearchHit[]` 仍同步，调用相同纯 rank core；release I/O 的 Store/search 与 service 异步。`l1SearchDocs` 与 `legacySearchDocs` 分别显式保留 P0/L1 与 L0；E0 的 L1 adapter 应调用 **l1SearchDocs**，不是新默认 lex-v1 的 searchDocs。
2. `FEISHU_KB_RANKER=l1` 同时控制同步入口和异步服务。l1SearchDocs 第五个可选参数 `unbounded=false` 仅供服务完整分页，默认四参行为与历史 cap 保持不变。
3. 默认预算：search/outline/list 8000、grep 12000、read/bundle/releaseInfo 为硬上限；`KB_MCP_MAX_CHARS` 默认 20000。每次实际 text / 紧凑 JSON 长度计入 next、表头、帧。最小 maxChars 2000；若一个完整原子结果仍放不下，抛 invalid_request，绝不发一个零进展游标。单行 cap 2000 有显式行截断标记。
4. 游标参数摘要绑定工具、规范默认值、预算与 release；不含当前指针、会话状态。翻页保持参数不变（包含 limit/maxMatches/maxChars）；cursor 不需要再传 releaseId，显式给不一致版本时报 invalid_cursor。
5. 缓存中已验证的不可变文档不逐请求重做 hash；每次请求仍检查 release 目录与 manifest 围栏，清理后不从缓存伪装服务。外部原地篡改一个已经缓存的不可变 release，不会被持续监控；重建索引或进程重启后重新校验。这与设计的不可变 release 假设一致。
6. settled LRU 最多 2 个；在途构建另外持有 Promise 以防淘汰导致重复构建，多个不同版本同时冷启可暂时有超过 2 个在途工作。预热和读取同版本共用 Promise。
7. regex 防护是软防护，不能中断单次 RegExp.exec；前 2000 字的行限制通过 regexTruncatedLines 披露。网关串行通道/看门狗属于 P5，不由本服务假装提供硬超时。

## 验证证据

所有新增测试及 stdio 子进程使用临时 FEISHU_SYNC_HOME / 临时知识库。无生产资料、无出站模型调用。以下是实际执行，不是计划。

| 入口 / 命令 | cwd | 实际结果 |
|---|---|---|
| `npm run build`（最终产物刷新） | worktree/server | exit 0；tsc 通过，生成 kb-mcp.cjs ~578.5KB 与既有 CLI；无新增原生依赖 |
| `npx vitest run tests/kb-search-engine.test.ts tests/kb-query-service.test.ts tests/kb-search-consistency.test.ts tests/mcp-kb.test.ts tests/agent-tool-families.test.ts tests/kb-build.test.ts tests/kb-version.test.ts --silent` | worktree/server | exit 0；**7 文件 / 100 测试通过**，约 1.62s；其中新增引擎 13、门面 12、真实入口 3 |
| `npm run typecheck --prefix server` | worktree | exit 0；最终 build 的 tsc 也覆盖后续源码 |
| 针对所有改动 TS 文件及新目录的 `npx eslint ...` | worktree | exit 0，无错误 |
| `git diff --check` | worktree | exit 0 |
| `node --version` | worktree | v24.21.0 |
| `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --version` | worktree | v20.18.0 |

`kb-search-consistency.test.ts` 真正执行 Hono `GET /api/kb/search`、AgentToolService.executeTool(`kb_search`) 与 SDK StdioClientTransport → tools/call(`search_knowledge`)，对三条查询逐个比较所有 hit 字段及 releaseId；在 Node 24 与真实 Electron/Node 20 子进程各跑一次，另测 CURRENT 切版。仅未用到的构建/DB 路由依赖是注入替身，排序、Store、service、磁盘及 MCP transport 没有 mock。

同文件检查构建产物不含 `better-sqlite3`，且没有 `.node` 模块导入。SDK 内有普通 `.nodes` 属性；这不是原生模块引用，不用裸子串 `.node` 误判。

失败过程也如实保留：首次 typecheck 因本树 server/node_modules 未链接而缺 SDK 等包，同时抓到新增 async 方法/unused import，已分别接 portable 链接及修正；首次 workbook 测试 fixture 在附件创建前算 hash，修正为先创建附件再算真实 hash；首次分页测试只有 35 条，dryRun 一页能装下，改为 90 条明确越预算；lint 抓到旧 P0/新查询正则的不必要转义，等价移除。最终上述命令均通过，没有删弱断言来放行。

## 风险与测试对应

| 风险 | 对应验证 |
|---|---|
| 单元解析/规范化/df 回退误触发、IDF/覆盖率/共现排序 | kb-search-engine 的纯算法测试，含保留 L0/L1 与同步签名 |
| fence 内伪标题、H3 重复计分、表头/行号错位 | outline/snippet 测试；真实 SDK 1001 命中行与表头比较 |
| hash 只算正文或漏 workbook、缺失/越界文件 | 真实发布公式、附件改变、symlink、mismatch/missing 披露及 read 错误测试 |
| 旧 release 缓存服务清理后的资料、并发重复构建 | 目录先解析、清理中 yield、LRU 2 版本、Promise 去重/拒绝重试、三请求并发预热测试 |
| 调用中 CURRENT 切换混版 | yield 时切版，当前调用仍全部来自旧 release，下次跟随新版 |
| 预算/游标静默漏数据 | seven-method 参数、JSON/text 字符预算、读与 bundle 全行恢复、grep 全匹配行计数、大完整性清单逐页恢复、参数/工具/版本错游标 |
| 发布被预热阻断、原发布语义变化 | 非等待 setImmediate 钩子；原 kb-build 30 + kb-version 23 相关回归通过 |
| 三端分叉 / Node20 不可运行 / 原生依赖泄漏 | 上述真实入口与构建产物测试 |

## 可集成 changed files

新增：

- `server/src/kb/search/normalize.ts`
- `server/src/kb/search/outline.ts`
- `server/src/kb/search/query.ts`
- `server/src/kb/search/rank-lex-v1.ts`
- `server/src/kb/search/snippet.ts`
- `server/src/kb/search/grep.ts`
- `server/src/kb/search/kb-index.ts`
- `server/src/kb/search/kb-index-cache.ts`
- `server/src/kb/search/kb-query-service.ts`
- `server/src/kb/search/header.ts`
- `server/src/kb/search/index-core.ts`
- `server/src/kb/search/index-types.ts`
- `server/src/kb/search/query-error.ts`
- `server/src/kb/search/release-reader.ts`
- `server/tests/helpers/kb-search-fixture.ts`
- `server/tests/kb-search-engine.test.ts`
- `server/tests/kb-query-service.test.ts`
- `server/tests/kb-search-consistency.test.ts`
- 本报告。

修改：

- `server/src/kb/kb-search.ts`：同步 lex-v1 薄包装；显式 L1/L0 留存。
- `server/src/kb/standard-kb-store.ts`：异步 search、共享 facade、header helper；metadata/doc 根读取复用 release 围栏，防旧调用在进入 service 前先绕过围栏。
- `server/src/kb/kb-build-service.ts`：CURRENT rename 后异步预热，仅 import + hook。
- `server/src/routes/kb.ts`：Store 复用、await search、QueryError 映射。
- `server/src/agent/agent-tool-service.ts`：只有 toolKbSearch 的 async 签名及 await 两处，raw 段零改动。
- `server/src/mcp/kb-mcp-server.ts`：只有既有 search await，主树 P2 已替代时不要覆盖。
- `server/tests/mcp-kb.test.ts`：真实 contentHash、子进程临时 FEISHU_SYNC_HOME；主树 P2 测试已替代时按需吸收。

不纳入：`amagi.json` 有未归因的外部变动，本轮未写；根 node_modules 为预置 portable 链接，server/node_modules 为本轮接入主树 server 依赖的链接，均不是产品变更，不提交。`server/dist` 是 ignored 构建产物，应由集成后构建生成。

## 未覆盖 / 剩余责任 / 回滚

- 本轮没有跑全量项目回归；按任务要求仅跑直接相关测试。
- 没有真实 80 条质量评测、10/30MB 性能重测、第二设备、Claude/pi 人工问答或视觉走查；不声称达到 §10.3/§6.5 的真实门槛。性能与真实质量交 Leader/A2，七工具 notice/transport 交 P2/P5。
- UI 只改后端 search 读取链，没有前端组件变化；实际 HTTP handler 验证不冒充浏览器/Electron 视觉验证。
- 没有修改发布格式、SQLite schema、依赖 manifest/lockfile、真实生产根；没有写索引文件或 commit。
- 回滚：运行时可设 `FEISHU_KB_RANKER=l1` 回退排序（索引完整性/读取围栏仍保留）。代码回滚由 Leader 按上述精确文件/薄补丁撤销；不要整文件恢复 agent-tool-service、stdio 或其 P2 测试，避免抹掉并行改动。发布数据不需迁移。
