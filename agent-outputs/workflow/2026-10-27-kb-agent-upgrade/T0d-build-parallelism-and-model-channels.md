# T0d 调查：构建流水线并行化与双模型通道现状地图

基线：feat/agent-knowledge-workbench @ 59a76fa。只读调查，未改任何项目文件。所有行号基于当前工作树该基线。
续篇（模型通道 / UI / 落点地图 / 待核验项）：`T0d-build-parallelism-and-model-channels-part2.md`（同目录）。

## 结论索引

| # | 主张 | 三态 | 锚点 | 适用边界 |
|---|------|------|------|----------|
| 1 | 构建是严格单飞：`running` 布尔 + DB 单活跃行双闸 | 观察 | kb-build-service.ts:198,291,558 | 同一 KbBuildService 单例内 |
| 2 | running 阶段 = 单 pi 进程 + `for` 循环串行 prompt，批次由 `chunk(workset, ≤50)` 切 | 观察 | kb-build-service.ts:452,461,502-514 | prompt 层单进程串行是 PiRpcProcess 协议约束（pi-rpc-process.ts:466） |
| 3 | stagingRoot 按 buildId 隔离（`.staging/<buildId>/docs`），token→buildState 绑定，文件写入本身文件级原子 | 观察 | kb-build-service.ts:91,340；agent-tool-service.ts:606-607 | 并行分片若共享同一 staging，写不同路径不互斥 |
| 4 | validating/publishing 的单写者假设集中在 5 处：workset 全局覆盖检查、finishInfo 单值、全局总量 ×3、full 空库检查、verifySnapshotIntact + docs 整目录 rename | 观察 | kb-build-service.ts:1175-1177,1195-1203,1213-1218,1225-1229,869,921-940 | 见 §1.6 冲突面逐项 |
| 5 | 事件流 seq 由 `entry.events.length+1` 在 Node 单线程下同步自增；events.jsonl 只追加；SSE 用 Last-Event-ID 续传 | 观察 | kb-build-service.ts:124-146；routes/kb.ts:375-409 | 多分片共用一个 buildId 事件流无需改序号机制 |
| 6 | InMemoryBuild 条目从不 delete（只截断 events），`active` Map 常驻内存 | 观察 | kb-build-service.ts:1027-1032（cleanupAfterPipeline）；全文无 active.delete | 并行化后多 build 条目累积需另行评估 |
| 7 | 进程池硬上限 `min(4, maxConcurrentProcesses)`，默认 2；build/probe 不参与 idle 回收，只有 session 有 | 观察 | agent-process-pool.ts:50-56,181 | N 分片 + 会话需放开 cap 或分池 |
| 8 | 模型配置是单模型槽：AgentModelConfig / SessionModelConfig 都只有一组 provider/model，无 vision 槽位 | 观察 | types/agent-knowledge.ts:26-38,263 | — |
| 9 | pi 侧 provider 元数据硬编码 `input: ['text']`；主模型纯文本。图片完全不在构建链：raw_read 只回正文+CSV 附件 | 观察 | feishu-sync-agent.js:104；agent-tool-service.ts:378-393 | vision 描述以文本回流时无需改 input |
| 10 | DirectChannel 已支持按 `ModelSelection`（providerId/modelId）解析任意 provider/preset，三协议直连，超时 600s 默认——vision 直连通道的最小复用基础已存在 | 观察 | direct-channel.ts:38,73,85-140；model-selection.ts:3-8 | 当前 prompt 是纯文本 string，多模态需把 content 扩为块数组 |
| 11 | 图片落盘形态 `<docDir>/images/NN-<token>`（NN 两位序号、无固定扩展名），md 内改写为 `images/<basename>` 相对引用；快照 hash 只含主文档+CSV+XLSX，不含 images | 观察 | sync-engine.ts:608,1076,1088-1096,851,858；raw-source-snapshot.ts:63-84 | 「源→图片清单」无现成 API，需从 md 引用解析或列目录 |
| 12 | 新增 server 侧工具（如 raw_read_image）的完整落点链 = tool-specs.ts 规格 → createRunContext allowedTools → dispatch case → 实现；扩展按 specs 动态注册，tool_call 钩子 fail-closed | 观察 | tool-specs.ts:55-72,287-305；agent-tool-service.ts:123-142,181,209-227；feishu-sync-agent.js:119-150 | spec JSON Schema 即 pi 参数校验 |
| 13 | R2 并行的最大语义断点不是文件写，而是 finish/校验协议：kb_finish 单值、workset 覆盖检查全局、skipped 汇总单进程、cancel/timeout 单进程句柄 | 观察+推断 | kb-build-service.ts:516-553,1213-1218；推断：分片模型需要 shard 完成聚合层 | 推断部分需 fuxi 裁决聚合协议 |

---

## 一、构建流水线现状精读（server/src/kb/kb-build-service.ts，1382 行）

### 1.1 状态机与单飞闸门

- 状态机注释（L1-11）：`queued → preflight → running → validating → publishing → published`，失败/取消/中断不移动 CURRENT；CURRENT.json 只在校验全过后 rename 更新。
- 单飞双闸（`createBuild` L198）：`if (this.running || localMapStore.getActiveKbBuild()) throw new ToolError('kb_build_running', …, 409)`。`running` 是实例布尔（L291 置位 / L558 finally 复位）；DB 侧 `getActiveKbBuild()` 只允许一行活跃。
- 服务为进程级单例：index.ts:241-254 构造一次，`pool`/`toolService` 共享。
- 启动对账（`reconcileOnStartup` L1035-1100）：非终态置 interrupted → 删对应 staging → CURRENT 指针与 DB 对账（指针为准，UPDATE 修复 F3-R09）。

### 1.2 running 阶段批次循环（并行化的主改造面）

- preflight 产出：`RawSourceSnapshot.scan`（L305-312，主文档+CSV 参与哈希）；staging 准备（L339-347：`rmSync` + `mkdir docs/` + 写 `raw-snapshot.json`）；增量时复制基线 release docs 进 staging 并写 `.docid-map.json`（L368-396）。
- 工作集（L415-424）：full = 快照全部源标 `'rebuild'`；incremental = `changeset.added + changed`。仅 removed 的增量也保底一个空批次（L453-455）。
- 批次切分（L452）：`chunk([...workset.keys()].sort(), Math.max(1, Math.min(50, config.standardKb.buildBatchSize)))`；`entry.batchTotal = batches.length + 1`（+1 是 finish 轮，L461）。
- 进程：整个 running 阶段**一个** pi 进程（`spawnBuildProcess` L641-734；`rpc.once('exit', …)` 回收令牌 L701）。批次循环（L502-514）逐批 `await rpc.prompt(batchPrompt, {timeoutMs: promptTimeoutMinutes*60_000})`，每批后 `throwIfPoisoned`（L514）。
- prompt 构造（`buildBatchPrompt` L739-810）：源差异 diff（≤8000 字符，`<untrusted_source_diff>` 包裹）+ 本批源表（objToken/标题/relPath/变更类型）+ affectedDocs（≤200）+ 固定 4 条要求（先 raw_read、合并主题、kb_write_doc 声明 sources、本批不 finish）。系统规则 = `buildRules + styleGuide`（插件快照缺省时 `promptAssets()`，L499-503）。
- finish 轮（L517-553）：finish prompt → 若 `!buildState.finishInfo` 发一次强制纠正 prompt → 仍无则 `kb_validation_failed`。
- 超时与取消：整体超时 `buildTimeoutMinutes`（L487-491，超时置 cancelRequested + abort）；`cancelBuild`（L222-241）置 `entry.cancelRequested` 并 `entry.process.abort()`；批次边界检查 cancel（L503,505）。

### 1.3 BuildRunState / staging 绑定

- 状态构造（L427-437）：`entry.buildState = { knowledgeBaseRoot, snapshot, mode, workset, stagingRoot: stagingRootPath, finishInfo: null, writtenPaths: new Set() }`；`docMeta` 经 `patchBuildStateMeta` 挂到 state（L572-576）。
- stagingRoot（L91）：`path.join(outputRoot, '.staging', buildId)`——**按 buildId 天然隔离**。
- 令牌绑定（`spawnBuildProcess` L651-662）：`toolService.createRunContext({ runKind:'build', buildId, outputRoot, knowledgeBaseRoot, buildState, onEvent })` → 返回 token；token 经 env `FEISHU_SYNC_AGENT_RUN_TOKEN` 注入 pi 子进程；工具调用由扩展 POST 回 `/api/agent-internal/tools/:name`（feishu-sync-agent.js:129）。
- 工具执行侧（agent-tool-service.ts）：`executeTool` 校验 token→context→allowedTools（L174-201，白名单外 403）；build 工具经 `requireBuildState(context).stagingRoot` 定位 staging（L484,505,520,601,640,655）。
- 写入（`toolKbWriteDoc` L558-613）：header（doc_id 继承 `.docid-map.json` / sources / build_id）+ 正文 → `atomicWriteFile`（L606，临时文件+rename，文件级原子）→ `writtenPaths.add` + `docMeta.set`（L607-608）。
- 事件回流：`onEvent` 钩子把每次工具 start/end 转成 `emitBuild(buildId,'tool',…)`（L657-663）。

### 1.4 validating / publishing 的单写者假设

- `validateStagingDocs`（L1139-1236，独立函数）：
  - **finishInfo 全局单值**（L1175-1177）：`state.finishInfo` 缺失即 `kb_finish_missing`；
  - **总量 ×3**（L1195-1203）：staging 全部 .md 字节 vs 原始库全部源字节；
  - **requiredRewrites → affected_doc_not_updated**（L1180-1182）；
  - **workset 全局覆盖检查**（L1213-1218）：每个工作集源要么被任一文档 sources 引用、要么出现在**唯一** skipped 里，否则 `source_not_covered`；
  - **full 空库检查**（L1225-1229）。
- publishing（L855-940）：
  - `verifySnapshotIntact`（L869，导出函数 L1268-1308）：发布前逐源重算 contentHash，任一变化抛 `source_changed_during_build`（409）；
  - `publishReleaseInner`（L879-940）：walk staging/docs → 生成 manifest → **`fs.renameSync(docsDir, releaseDir/docs)` 整目录 rename**（L921）→ 写 version → CURRENT.json tmp+rename（L932-940，指针提交点 F3-R10）；
  - 指针提交点后的清理失败不回滚（L846-854）。
- 毒化（F3-R08）：`raw_read`/`raw_search` 读源时哈希不符 → `state.poisoned` 置位（agent-tool-service.ts:378-385）→ 每批结束与发布前 `throwIfPoisoned`（kb-build-service.ts:514,518,538,862）。

### 1.5 事件流与 InMemoryBuild

- `emitBuild`（L124-146）：seq = `entry.events.length + 1`；push 内存 + `appendFileSync` events.jsonl（`<outputRoot>/.builds/<buildId>/`）+ `this.emit('sse', {buildId, …})`。emitBuild 全同步，Node 单线程下 seq 单调无竞争。
- SSE 消费（routes/kb.ts:375-409）：`GET /api/kb/builds/:id/events`，`Last-Event-ID` → `eventsSince(lastSeq)` 初量，之后 15s ping + wake listener 增量推送。
- `eventsSince` 只读内存 `entry.events`（L160-166）；构建结束后 entry 保留在 `active`，60s 后 events>2000 截到 500（`cleanupAfterPipeline` L1027-1032）。**全文无 `active.delete`**——InMemoryBuild 条目常驻（诊断数据）。
- DTO（L148-184）：progress = `entry.batchIndex/batchTotal` 单值对。

### 1.6 并行化冲突面清单（N 个 pi 进程分片处理同一构建）

前提约定：分片 = 同一 buildId 下 N 个进程各领 workset 子集。逐项：

| # | 冲突面 | 现状机制 | N 进程并行时 | 证据 |
|---|--------|----------|--------------|------|
| C1 | staging 文件写 | per-file `atomicWriteFile`，stagingRoot 按 buildId | 共享 staging 时写不同路径安全；**同一 docPath 被多分片写 = 最后写者赢**（跨批合并主题文档时真实会发生）；分片各自 staging 则 validating/publishing 需要聚合多目录 | agent-tool-service.ts:606；kb-build-service.ts:91 |
| C2 | `writtenPaths` / `docMeta` | per-build Set/Map，kb_write_doc 同步更新 | Node 单线程下共享同一 BuildRunState 对象不产生数据竞争；分片进程各持独立 token 可指向同一 buildState（createRunContext 传同一对象）——**这不是断点**；若分片各自 buildState 则校验缺数据 | agent-tool-service.ts:607-608 |
| C3 | `finishInfo` 单值 | `toolKbFinish` 已调用即抛 `invalid_request`（L650-652）；prompt 侧 finish 轮只发一次 | **硬冲突**：N 分片各自 finish → 首个成功后其余全 403；summary/skipped 是单值字段，需要 per-shard 完成上报 + 聚合层 | agent-tool-service.ts:649-676 |
| C4 | workset 全局覆盖检查 | validating 阶段对整个 `state.workset` 检查 referenced ∪ skipped | 分片只在自己批次窗口有 referenced；**校验必须移到全分片完成后**按聚合 writtenPaths/skipped 执行——检查逻辑本身可复用 | kb-build-service.ts:1213-1218 |
| C5 | requiredRewrites / affectedDocs | per-build Set，prompt 里全量下发给每个批次 | 多分片重复看到同一 affectedDocs，可能并发重写同一 affected doc → 叠加 C1 的同路径冲突 | kb-build-service.ts:440-450 |
| C6 | 毒化 poisoned | state.poisoned 置位后每批结束检查 | 任一分片毒化必须终止全部——需要共享 state 或聚合器广播；现状每批 `throwIfPoisoned` 是分片内检查 | kb-build-service.ts:514,862 |
| C7 | 进度与事件 | `entry.batchIndex/batchTotal` 单值；seq 同步自增无竞争；events.jsonl 只追加 | batchIndex 单值被 N 分片互相覆盖 → DTO progress 失真（需改分片进度数组）；事件流本身无需改 | kb-build-service.ts:461,504 |
| C8 | cancel / 整体超时 | `entry.process` 单句柄；cancel → `process.abort()`；超时 → abort | 需改为句柄集合遍历 abort；`finally` 中 `pool.terminate('build:'+buildId)` 只杀单进程（L554） | kb-build-service.ts:227-235,487-491,554 |
| C9 | DB 状态行 | 单活跃行 getActiveKbBuild + `running` 布尔 | 一个 build 多分片仍是一行状态机，`running` 语义可保留（pipeline 存活期间 true）——**不是断点**；分片局部失败如何映射整行状态（failed vs 重试分片）需要设计 | kb-build-service.ts:198,291 |
| C10 | 发布原子性 | docs 整目录 rename + CURRENT tmp+rename | 发布仍是单点（聚合后一次），单写者语义在聚合层恢复——前提是 C3/C4 的聚合先成立 | kb-build-service.ts:921,932-940 |
| C11 | 预算与超时配置 | `promptTimeoutMinutes` per prompt、`buildTimeoutMinutes` 整体、`buildBatchSize` ≤50 | 分片并行下整体超时含义不变；BatchSize 变成分片内批量参数 | types/agent-knowledge.ts:48-56 |

---

## 二、进程池约束（server/src/agent/agent-process-pool.ts，229 行）

- 容量（L49-56）：`maxProcesses = Math.max(1, Math.min(4, maxConcurrentProcesses ?? 2))`——**配置可调但硬顶 4**；`configure()` 同样 clamp。默认 2。
- 预留协议（F3-R05，L68-91）：`reserveSlot()` 在 spawn 前锁槽（`runningCount()+reservations >= max` → null）；`register(key, proc, kind, slot)` 消费预留；无 slot 超限抛 `AgentBusyError`。
- key 约定：构建 `build:<buildId>`（kb-build-service.ts:727）；会话 `<sessionId>`（session-service.ts:581）；同 key 重复注册 terminate 旧进程（L107-115）。
- idle 回收只对 `kind==='session'`（L181）；build/probe 进程不被空闲回收，只靠显式 terminate/exit。busy 期间挂起回收（F3-R06，L136-149）。
- 构建进程生命周期：spawn 前 `reserveSlot()`（kb-build-service.ts:647），失败抛 `agent_busy`；批次循环 finally `pool.terminate('build:'+buildId)`（L554）；`PiRpcProcess.terminate` = stdin.end → 3s 宽限 → SIGKILL（Windows taskkill /T /F）（pi-rpc-process.ts:663-691）。
- **构建 vs 会话竞争**：默认 max=2 → 1 构建进程 + 1 会话进程；第二个会话 spawn 时 `reserveSlot()` 返回 null → 409 agent_busy（session-service.ts:494-497）。扩到「N 分片 + 会话」需要的改动：
  1. 放开 `min(4,…)` cap 或按 kind 分池（build 池/session 池分开计数）；
  2. 分片 key 唯一化（`build:<buildId>:shard:<i>`）；
  3. 并发预留 N 槽的原子性（逐个 reserve 失败需回滚已预留槽）。
- PiRpcProcess 协议层（pi-rpc-process.ts）：`prompt()` 单活跃 run（L466 `run_in_progress`）——**单进程串行 prompt 是硬约束**，并行必须多进程；RPC 命令白名单（L25-39）+ 黑名单（L42-53）；完成判定 = prompt response + `agent_settled` + stopReason（L553-580）；auto_retry 上限 3（L104,588-606）。
- 子进程 env（`buildPiProcessEnv` L693-763）：app-llm 白名单继承 + `PI_CODING_AGENT_DIR=<dataRoot>/agent/pi-home` + `FEISHU_SYNC_AGENT_URL/RUN_TOKEN(/API_KEY)`；每进程独立 token。

→ 续篇：`T0d-build-parallelism-and-model-channels-part2.md`（§三 模型通道 / §四 UI / §五 落点地图 / §六 覆盖 / §七 待核验）
