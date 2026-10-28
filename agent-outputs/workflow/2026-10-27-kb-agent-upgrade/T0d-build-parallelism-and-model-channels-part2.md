# T0d 续篇：模型通道 / UI 配置面 / 落点地图

主篇：`T0d-build-parallelism-and-model-channels.md`（结论索引、流水线精读、冲突面 C1-C11、进程池）。基线 59a76fa，行号同基线。

## 三、模型通道现状

### 3.1 app-llm provider 注册链（会话与构建共用）

- 解析链：`resolveAppLlmModel(llm, agent)` = `resolveProviderModel(llm, agent.model)`（runtime-resolver.ts:567-571 → model-selection.ts:9-27）。`resolveProviderModel` 逻辑：`llm.providers` 过滤 enabled → provider 按 `selection.providerId` 优先、否则 `activeProviderId`、否则第一个 → protocol 校验 ∈ {openai-completions, openai-responses, anthropic-messages} → preset 按 `selection.modelId` → `defaultModelId` → 第一个。
- 运行注入（provider-descriptor.ts:27-49 `buildAppLlmRunConfig`）：`model = "feishu-sync-llm/<openAiModel>"`；`providerJson = {baseUrl, api, models:[{id, contextWindow, maxTokens, reasoning}]}`；apiKey 单独返回，只进子进程 env（F3-R03：probe/会话/构建三链路同一实现）。
- pi 侧注册（feishu-sync-agent.js:94-110）：`pi.registerProvider('feishu-sync-llm', {baseUrl, apiKey: '$FEISHU_SYNC_AGENT_API_KEY', api, models})`，models 元数据 **`input: ['text']` 硬编码**（L104）——主模型按纯文本注册。
- 另有 pi-agent-dir 模式：`registerConfiguredModels`（configured-models.js:26-49）只读共享 home 的 models.json/auth.json，按 provider 注册全部已配置 chat 模型。
- 模型配置类型（types/agent-knowledge.ts）：
  - `AgentModelConfig`（L26-38）：`{source, providerId?, modelId?, piModel?, thinkingLevel, contextWindow, maxTokens}`——**单模型槽**，全局 Agent 用；
  - `SessionModelConfig`（L263）= Pick 同名字段——**会话级单模型覆盖**，落 DB `model_config_json`（session-service.ts:180-183），REST 校验在 routes/agent.ts:160-170；
  - 构建进程不用会话覆盖，直接 `config.agent.model`（kb-build-service.ts:672-690 spawnBuildProcess 内 buildAppLlmRunConfig）。
- 就绪检查（runtime-resolver.ts:439-500 `checkReadiness`）：app-llm 缺 provider/preset → `model_unconfigured`；缺 key → `model_auth_missing`；探测进程看不到模型 → 同 code。

### 3.2 direct-channel.ts 作为 vision 直连通道的复用可行性

- 构造（L36-41）：`resolveActiveLlmConfig(llm, selection)` 一次性解析 provider profile → flat shape；`selection: ModelSelection`（model-selection.ts:3-8）= `{providerId?, modelId?, contextWindow?, maxTokens?, thinkingLevel?}`——**换一组 selection 即换模型**，双模型的最小通道基础。
- 三协议分支（L85-140）：anthropic-messages（`@anthropic-ai/sdk`，L90 起）/ openai-responses（L112 起）/ openai-completions（L134 起）。当前所有分支的 message content 都是**纯文本 string**（`buildPrompt` L204-239 产出）——vision 需要把 content 扩为多模态块数组（OpenAI `image_url` / Anthropic `image.source{type:'base64'}`）。
- 超时与错误（L72-77,161-199,251-260）：`options.timeoutMs ?? llm.timeoutMs ?? 600_000`，AbortController；abort → `finishReason:'timeout'`；SDK 错误 → `'error'` 且消息脱敏 apiKey（`split(apiKey).join('***')` L247）；**不抛异常**，错误经 AdaptOutput 返回（content-backend 契约）。
- 配置来源：`LlmConfig.providers[]`（types/index.ts:108-127，含 protocol/apiKey/openAiCompatBaseUrl/models）+ `activeProviderId/activeModelId`（L136-155）。key 明文落 config.json（既有架构决策）。
- 复用结论（推断）：新增「vision 通道」最小实现 = `new DirectChannel(llm, {providerId: vision.providerId, modelId: vision.modelId})` + 多模态 content 扩展；不需要新 SDK 依赖。Anthropic 分支的 thinking 参数与图片块可共存（content 数组）。

### 3.3 会话内工具执行链与 `raw_read_image` 类工具落点

- 执行链：pi 进程内 feishu-sync-agent 扩展启动时 `GET /api/agent-internal/tools` 拉规格并 `pi.registerTool`（feishu-sync-agent.js:119-135）→ 模型调用 → 扩展 `POST /api/agent-internal/tools/:name`（L129）→ routes/agent-internal.ts:60-80（回环 Host + 无 Origin + X-Agent-Run-Token 三重校验）→ `AgentToolService.executeTool`（token→context→allowedTools 403，L174-201）→ `dispatch` switch（L209-227）。
- 新增工具四件套：
  1. `tool-specs.ts` 加 `XXX_SPEC`（纯 JSON Schema）并入 `ALL_SPECS`（L287-305）；
  2. `agent-tool-service.ts` `createRunContext` 的 allowedTools 按 runKind 加名（L125-131；build 白名单与 `BUILD_TOOLS` 常量对应，types/agent-knowledge.ts:342-352）；
  3. `dispatch` 加 case + 实现（server 侧调 vision 模型，返回 `ToolResult{content:[{type:'text'}]}`——描述以文本回流，主模型无需多模态）；
  4. 无需改扩展——扩展按 specs 动态注册；`tool_call` 钩子 fail-closed 只放行 selfTools/已启用插件工具（feishu-sync-agent.js:147-150），新工具在 specs 内即自动放行。
- 权限面：build/work/discuss 各自白名单独立；vision 工具若只给 build，加进 BUILD_TOOLS + createRunContext build 分支即可。
- 注意：vision 调用发生在 server 进程（工具执行端），不占 pi 进程池槽位；但会占用该分片 prompt 的运行时长（工具调用期间 pi 等待），超时预算需独立于 promptTimeout。

### 3.4 原始库中图片的存在形态与构建时枚举

- 落盘（sync-engine.ts）：
  - `downloadImages`（L1073-1120）：目标 `<saveDir>/images/<NN>-<token>`（NN=两位序号；**故意不带扩展名**，lark-cli 按 Content-Type 定后缀 L1086-1091）；
  - 引用改写：`localMediaReferences.set(token, 'images/'+basename)`（L608）；子目录文档为 `<relativeDir>/images/<name>`（L851,858）；
  - whiteboard 同通道（L1394 的 `token="images/…"` 识别）；sheet 浮动图片走同一 images/ 通道且嵌进 CSV 渲染（L664,1621,1785-1797）。
- 改写产物即本地 md 中的相对路径（media-reference.ts:88-118 `rewriteFeishuMediaReferences` 只替换 token→本地相对路径）。
- **构建链现状不含图片**：`readRawContent`（agent-tool-service.ts:373-396）= 主 md + CSV 附件文本拼接；`computeSourceHash`（raw-source-snapshot.ts:63-84）= 主文档 + XLSX（source_workbook 标记）+ CSV，**images 不参与快照**——图片变化不会触发源 changed（有意为之，注释 L66-67：文本衍生品对图片变化不敏感）。
- 「某源的关联图片」枚举途径（现状无现成 API，三种可行来源）：
  1. 读源 md 内容，用 `extractFeishuMediaReferences` / 正则 `images/…` 解析本地引用，再 `resolveInside(knowledgeBaseRoot, …)` 定位文件（引用即路径，无需 DB）；
  2. 列 `<docDir>/images/` 目录（sync-engine 布局固定）；
  3. sheet 源另有 `source_workbook` XLSX + CSV 嵌图（L1621）。
- 构建时把图片送 vision 的位置：在 `raw_read_image`（或 `raw_read` 扩展参数）内按上述枚举定位文件 → base64 → vision 通道 → 文本描述回流。

## 四、UI 配置面现状与「图片理解模型」段落落点

（任务书所写 `src/components/AgentSettingsCard.tsx`、`ConversationModelPicker.tsx` 实际位于 `src/components/agent/` 子目录；`src/components/` 下无此二文件——锚点以实际路径为准。）

- `src/components/ModelProviderSettings.tsx`（541 行）：provider+preset 编辑器。协议 Select（`接口协议` L309-315 附近）、Base URL/API Key/模型预设列表/「应用默认提供商/预设」Select（L504-517）；「保存并用于 Agent」（L226-247 `handleSave(true)`）把 `config.agent.model` 写成 `{source:'app-llm', providerId, modelId}` 窄 patch。**加「图片理解模型」段的自然落点**：在本卡「应用默认提供商/预设」区旁加一组 Select（数据源同一 `llm.providers`），保存时随 `llm` patch 写新字段（如 `llm.visionProviderId/visionModelId`）。
- `src/components/agent/AgentSettingsCard.tsx`（624 行）：`AgentRuntimeSettingsCard` 有模型来源 radio（app-llm/pi-agent-dir）+ provider/preset 下拉（L226-300 附近）+ thinking；`AgentKbSettingsCard` 管标准库目录/Workspace/MCP。若 vision 归「Agent 用模型」语义，落本卡 app-llm 分支。
- `src/components/agent/ConversationModelPicker.tsx`（73 行）：会话级模型/思考强度浮层（`listConversationModels`/`saveConversationModel`）。会话级 vision 覆盖若需要，落点在此（当前 SessionModelConfig 无 vision 字段，需先扩类型+routes/agent.ts:160-170 校验）。
- 配置写路径：全部经 `useConfig().updateConfig` 窄 patch → PATCH /api/config → ConfigManager；无新增端点需求。

## 五、落点地图（改动点 × 性质 × 冲突面）

### R1 双模型（文本模型 + 图片理解模型分离，vision 描述进构建链）

| 改动点 | 文件:符号 | 性质 | 与其他切片冲突面 |
|---|---|---|---|
| vision 配置字段 | server/src/types/index.ts `LlmConfig`（或 agent-knowledge.ts `AgentModelConfig`） | 扩展（additive 可选字段） | config.json 兼容：旧配置无字段走「未配置 vision」路径；GET /api/config 脱敏逻辑须覆盖新字段若含 key（复用 provider key 则无需新 key） |
| vision 通道实现 | server/src/modules/（新文件 vision-channel.ts 或 direct-channel.ts 加多模态方法） | 新文件/扩展 | direct-channel.ts 若原地改需回归同步整理测试（tests 对 direct 契约有覆盖）；建议新文件复用 `resolveActiveLlmConfig` |
| 图片枚举/读取 | server/src/agent/agent-tool-service.ts 新 `toolRawReadImage`（复用 media-reference.ts 引用解析 + path-guard resolveInside） | 扩展 | path-guard 只读围栏已覆盖；图片是二进制——只出 base64 不落盘，无 staging 污染 |
| 工具规格 | server/src/agent/tool-specs.ts 新 `RAW_READ_IMAGE_SPEC` | 扩展 | MCP（kb-mcp.cjs）与转发扩展按 specs 动态生成——MCP 只读标准库不含 raw_*，无冲突；CLI 切片若暴露 agent-internal 工具面需同步该 spec |
| 白名单 | types/agent-knowledge.ts `BUILD_TOOLS` + agent-tool-service.ts:125-131 | 扩展 | work/discuss 是否可用 = 产品决策，不改不影响 |
| provider 元数据 | feishu-sync-agent.js:104 `input:['text']` | 不必改（vision 描述走文本回流）；若未来主模型直读图需改 | — |
| UI | src/components/ModelProviderSettings.tsx 加段（首选）；agent/AgentSettingsCard.tsx 备选 | 扩展 | 「保存并用于 Agent」patch 语义需带上新字段避免互踩 |

### R2 并行构建（N 分片并行）

| 改动点 | 文件:符号 | 性质 | 与其他切片冲突面 |
|---|---|---|---|
| 分片调度器 | kb-build-service.ts `runPipeline`（L291-560）批次循环 → 分片 fan-out/join | 重构（状态机保留，running 内部重写） | C3/C4/C6/C8 聚合协议需先设计（fuxi 侧）；C7 progress DTO |
| finish 聚合 | agent-tool-service.ts `toolKbFinish`（L649-676）→ per-shard 上报 + 聚合器 | 重构/新工具（如 kb_shard_done） | kb_finish 规格变更影响 prompt 资产（prompts/buildRules 提示词在 build-agent-assets 复制链路内） |
| 校验时机 | kb-build-service.ts `validateStagingDocs` 调用点（L867-876） | 扩展（聚合后调用，函数本体可不动） | C4；测试 validateStagingDocs 直测不受影响 |
| 池容量 | agent-process-pool.ts:50-56 clamp、分片 key、批量预留 | 扩展 | 会话竞争策略（分池 vs 提示用户调 maxConcurrentProcesses）是产品决策 |
| 进度模型 | InMemoryBuild（kb-build-service.ts:60-68）+ `toDto` progress | 扩展 | 前端 SSE 消费（KbBuildProgress 类组件）需同步 DTO 变更 |
| cancel/timeout | kb-build-service.ts:227-235,487-491,554 句柄集合化 | 重构（局部） | 无跨切片 |
| 配置项 | types/agent-knowledge.ts `StandardKbConfig`（L48-56）加 shard 并发数 | 扩展 | UI（AgentKbSettingsCard 标准库段）+ additive 迁移 |

共享面提示：R1 的 `raw_read_image` 与 R2 的分片调度无直接冲突（vision 调用在 server 工具端，分片进程数不因此变化）；两切片都动 `agent-tool-service.ts`（allowedTools/dispatch）与 prompt 资产，合并时注意先后。

## 六、覆盖范围与来源说明

- 已读全文：kb-build-service.ts、agent-process-pool.ts、pi-rpc-process.ts、agent-tool-service.ts、tool-specs.ts、provider-descriptor.ts、configured-models.js、feishu-sync-agent.js、direct-channel.ts、model-selection.ts、media-reference.ts、routes/agent-internal.ts、三份 UI 组件。
- 已读关键段：runtime-resolver.ts（checkReadiness/resolveAppLlmModel）、content-backend.ts（resolveActiveLlmConfig）、types/index.ts（LlmConfig L100-180）、types/agent-knowledge.ts（模型/构建配置段）、routes/kb.ts（构建/SSE 段）、session-service.ts（L480-605 spawn 段）、sync-engine.ts（图片下载/改写段）、raw-source-snapshot.ts（候选/哈希/readVerified 段）、index.ts（依赖注入段 L176-256）。
- 未覆盖：前端 SSE 进度消费组件（DTO 变更影响面只在 §五 标注，未逐行核对）；kb-version-store.ts / standard-kb-store.ts 内部（publish 链只读到调用点）；tests/ 目录回归面未逐一列举。

## 七、待核验项（缺证据，不附方案）

1. `localMapStore.getActiveKbBuild()` 的 SQL 语义（是否按状态过滤唯一行）未读 local-map-store.ts——C9 的「单活跃行」表述基于调用方行为推断。
2. prompts 资产（buildRules/styleGuide）实际文件与 kb_finish 提示词措辞位置未读（build-agent-assets.mjs 复制链只确认存在）；finish 聚合改造会触及该资产。
3. 前端对 `progress.batchIndex/batchTotal` 的具体消费组件未定位（只确认 DTO 形状）。
4. R1 产品面：「图片理解模型」配置在 vision 不可用时的降级语义（跳过图片 vs 构建失败）无现有代码先例，需需求侧裁决。
5. `FEISHU_SYNC_AGENT_PLUGIN_SNAPSHOT` 插件快照下的工具白名单与外部插件工具并存时，vision 工具的 `setActiveTools` 行为（feishu-sync-agent.js:141-146）未实测。
