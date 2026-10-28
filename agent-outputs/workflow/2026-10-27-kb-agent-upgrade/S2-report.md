# S2 报告：Vision 通道（识图模型直连 + 描述缓存）

任务书：S2 切片（设计 §3.1-3.2/§3.6）。上游：`docs/design/kb-agent-upgrade-design.md` §3.1-3.2、`server/src/modules/direct-channel.ts`、`server/src/routes/agent.ts`。本切片不含构建链集成（S3）与 UI（S5）。

## 一、改动清单（写面）

| 文件 | 性质 | 内容 |
|---|---|---|
| `server/src/types/agent-knowledge.ts` | 追加 | `AgentVisionConfig`（enabled/providerId/modelId/concurrency/maxImageBytes/maxImagesPerBuild/timeoutMs）、`VISION_MAX_IMAGE_BYTES_CEILING`、`buildDefaultAgentVisionConfig()`、`AgentConfig.vision` 字段 |
| `src/types/index.ts` | 追加 | `LlmModelPreset.supportsImages?: boolean`（仅 UI 提示；运行时不据此判定可用性） |
| `server/src/modules/config-manager.ts` | 追加 | `normalizeVisionConfigLoose()`（宽容归一+夹取范围）、`validateAgentAndKbConfig` vision 结构校验段、`validateVisionProviderReference()` 交叉校验，接入 `updateConfig` 与 `updateLLMConfig` 两条保存路径 |
| `server/src/agent/vision/vision-channel.ts` | 新增 | `VisionChannel`：三协议 SDK 直连多模态请求，永不抛异常，apiKey 脱敏 |
| `server/src/agent/vision/vision-describer.ts` | 新增 | `VisionDescriber`（status/lookup/describeOne/describeMany）+ 内容寻址缓存 + magic bytes 嗅探 + `resolveVisionContext()` 纯函数 |
| `server/src/agent/agent-assets.ts` | 追加 | `readAgentPromptFile()`（utf-8 prompt）、`readAgentPromptBinary()`（二进制资产，vision-test.png） |
| `server/src/agent/prompts/image-describe.md` | 新增 | 识图提示词（中文、四段结构化输出、不臆测约束） |
| `server/src/agent/prompts/vision-test.png` | 新增 | 内置测试图（320×320 RGBA PNG，12.5KB；含「识图测试」中文与 "Vision S2 fixture 2026"；已由视觉模型复核转写正确） |
| `server/src/routes/agent.ts` | 只追加 | `GET /api/agent/vision/status`、`POST /api/agent/vision/test`（端点段追加在 `return routes` 前，既有路由零改动；describer 路由内惰性单例） |
| `server/tests/vision-*.test.ts` ×4 | 新增 | 37 用例（见 §五） |

`build-agent-assets.mjs` 无需登记：其 `copyDir` 对 prompts 目录整目录复制，md 与 png 自动随 build 落 `dist/agent/prompts/`（实测 `copied 4 prompt file(s)`，dist 内 4 文件齐全）。

## 二、S3 消费接口（可直接 import）

```ts
// server/src/agent/vision/vision-channel.ts
export type VisionImageMime = 'image/png'|'image/jpeg'|'image/gif'|'image/webp';
export interface VisionRequest { bytes: Buffer; mime: VisionImageMime; prompt: string }
export type VisionFinishReason = 'stop'|'length'|'error'|'timeout';
export interface VisionResult { text: string; finishReason: VisionFinishReason; model: string; latencyMs: number; errorMessage?: string }
export class VisionChannel {
  constructor(llm: LlmConfig, selection?: ModelSelection);   // 复用 resolveActiveLlmConfig，按 providerId/modelId 换模型
  describe(req: VisionRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<VisionResult>;  // 永不抛异常
}
// 协议适配：completions→image_url(data URL)；responses→input_image(+detail:'auto')；anthropic→image/base64 source

// server/src/agent/vision/vision-describer.ts
export type ImageUnavailableReason = 'vision_unconfigured'|'vision_failed'|'too_large'|'unsupported_format'|'limit'|'missing_file'|'not_described';
export interface ImageDescription { src: string; imageHash: string; state: 'described'|'cached'|'unavailable'; reason?: ImageUnavailableReason; text?: string; message?: string }
export interface VisionStatus { state: 'disabled'|'ready'|'invalid'; model: string|null; message: string }
export function sniffImageMime(bytes: Buffer): VisionImageMime | null;
export function resolveVisionContext(config: Config): ResolvedVisionContext | null;  // disabled/引用失效 → null
export class VisionDescriber {
  constructor(deps: { dataRoot: string; config: () => Config | Promise<Config> });  // S3 传 () => configManager.load()
  status(): Promise<VisionStatus>;
  lookup(imageHash: string): Promise<string | null>;      // 只读缓存
  cachedCount(): Promise<number>;                          // 跨模型计数（设置页展示）
  describeOne(file: string, src: string, signal?: AbortSignal): Promise<ImageDescription>;
  describeMany(items: Array<{file: string; src: string}>, opts: { signal: AbortSignal; onProgress(p: {done: number; total: number}): void }): Promise<Map<string, ImageDescription>>;
}
```

要点：
- `describeMany` 缓存命中不占 `maxImagesPerBuild` 配额；未缓存超额标 `limit`；并发取 `vision.concurrency`（1..8）。
- `ResolvedVisionContext` 携带 `presetId`——经 VisionChannel 的 selection 回传，确保显式 `vision.modelId` 不被 provider 默认预设覆盖。
- 设计稿 `status()/lookup()` 为同步签名，实现为 async（ConfigManager.load 异步）；S3 全部 await 即可，已在签名处注明。
- `raw_read_image`（会话侧）由 S3 接：`lookup(hash)` 命中 → 内联，未命中 → `not_described`（reason 值已预留在联合类型中）。

## 三、缓存格式

- 路径：`<dataRoot>/agent/vision-cache/<imageHash[0:2]>/<imageHash>.<modelKey>.json`
- `imageHash = sha256(图片字节)`；`modelKey = sha256(providerId + '/' + openAiModel + '/' + promptVersion)[0:12]`；`promptVersion = sha256(image-describe.md 内容)[0:8]`（prompt 改动自动换 key）
- 条目 JSON：`{ schemaVersion: 1, imageHash, modelKey, model, promptVersion, text, createdAt }`；写入 tmp+rename 原子，失败静默降级（不阻断描述主链路）；v1 无淘汰（设计 §11）
- apiKey 绝不进缓存/日志/错误信息（split-join 脱敏，沿 direct-channel 技法）
- prompt 资产缺失时用内置等义兜底常量（链路可用，promptVersion 仍按实际内容计算）

## 四、S5 API 契约（status/test）

`GET /api/agent/vision/status` → 200
```json
{ "enabled": false, "state": "disabled|ready|invalid", "provider": "vp|null", "model": "vision-model|null", "message": "", "cachedCount": 0 }
```
- `provider` 是配置引用的原始展示（disabled 时也回显引用值）；`model` 仅 ready 时非空；`message` 在 invalid 时给人读的原因。

`POST /api/agent/vision/test`（body 可空或 `{providerId?, modelId?}`；显式覆盖允许在启用前试测候选模型）
- 未启用且无覆盖 → 400 `{error:'vision_unconfigured'}`；引用不可用 → 400 `{error:'invalid_config'}`；测试图缺失 → 500 `vision_fixture_missing`
- 调用成功 → 200 `{ok, finishReason, model, latencyMs, sample}`；远端失败 → 200 `{ok:false, finishReason:'error'|'timeout', sample:'', error:{code, message}}`（消息已脱敏）
- test 端点不写缓存（fixture 与生产资料严格分离）

配置（`agent.vision`，PUT /api/config）：`enabled=true` 时引用的 provider/预设必须存在且启用，否则 400 `invalid_config{field:'agent.vision.providerId'|'agent.vision.modelId'}`；llm 侧保存删除/停用被引用 provider 同样被交叉校验拒绝；`enabled=false` 时不校验引用（允许先关后修）。数值归一范围：concurrency 1..8、maxImageBytes 1024..20MiB、maxImagesPerBuild 0..5000、timeoutMs 5000..600000。

## 五、验证证据

| 项 | 命令 | 结果 |
|---|---|---|
| vision 单测 | `cd server && npx vitest run tests/vision-channel.test.ts tests/vision-describer.test.ts tests/vision-config.test.ts tests/vision-routes.test.ts` | 4 files / 37 tests 全绿 |
| server 全量 | `cd server && npm test` | 77 files / 981 tests 全绿（含兄弟任务并行改动） |
| server typecheck | `cd server && npx tsc --noEmit` | exit 0 |
| root typecheck | `npm run typecheck`（root+node+server 三段） | 三段 exit 0 |
| 前端全量 | `npm test`（根目录） | 18 files / 160 tests 全绿 |
| server build + 资产 | `cd server && npm run build` | exit 0；`copied 4 prompt file(s)`，`dist/agent/prompts/` 含 image-describe.md + vision-test.png |
| 真实入口冒烟 | `FEISHU_SYNC_HOME=<tmp> FEISHU_SYNC_PORT=3177 node dist/index.js` + curl/fetch | status 缺省 disabled；test 未配置 400 vision_unconfigured；PUT provider 后 test 显式覆盖 → 200 ok:true sample 含「识图测试」（本地回环 fixture，未触真实远端） |
| 测试图视觉复核 | amagi-media-understanding 委托视觉模型 | 「识图测试」「Vision S2 fixture 2026」逐字转写正确，无豆腐块 |

单测覆盖明细：三协议请求体断言（多模态块形态/模型别名/max_tokens/鉴权头/端点路径）、length/timeout/error 分类、外部 signal 中止、apiKey 脱敏（4xx 响应含 key 时 errorMessage 只见 ***）、缓存命中不触网（计数器断言）、跨 modelKey 缓存隔离、magic bytes 拒绝非图片、missing_file/too_large/vision_unconfigured/limit/vision_failed 全路径、describeMany 进度单调收尾、status 三态、配置归一化与交叉校验（含 llm 侧删除 provider 拒绝保存）、路由层状态递进 + fixture 端到端。

## 六、未覆盖 / 风险

- **真实远端模型未实测**（任务书约束：真实端点调用只由用户经 `/api/agent/vision/test` 显式触发）。各真实 provider 对图片端点的兼容性（尤其 openai-responses 网关、anthropic 兼容端点的 media_type 支持）待用户在设置页点「测试」验证。
- 缓存无淘汰（设计 §11 未知项，沿用设计决定）；`cachedCount` 跨模型计数，若后续需要按模型分列再扩。
- `maxImagesPerBuild` 的语义是「未缓存图片数」；构建中图片被替换的场景由 S3 的 verifySnapshotIntact 兜底，本切片不涉及。
- 与 DirectChannel 的关系：未抽共享请求构造层（耦合评估见 vision-channel.ts 模块头注释），两通道独立演进；若未来收敛，建议从「错误分类 + 脱敏 + abort 组合」三个纯函数开始。
- `vision-test.png` 由 qlmanage（SVG→PNG 缩略）生成，源 SVG 未入库；需要再生成时可在 macOS 用 QuickLook 重渲染（或任何工具重画，内容约定：白底蓝方橙圆 + 「识图测试」中文 + "Vision S2 fixture 2026"）。

## 七、回滚

全部改动为 additive：删除 `server/src/agent/vision/`、`server/src/agent/prompts/image-describe.md`、`vision-test.png`、4 个 `server/tests/vision-*.test.ts`，并 revert `agent-assets.ts`/`config-manager.ts`/`routes/agent.ts`/`types/agent-knowledge.ts`/`src/types/index.ts` 五个文件的追加段即可；无数据迁移、无 DB 变更、无公共契约破坏（旧配置无 vision 段时 load 自动补默认 disabled）。
