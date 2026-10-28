# 知识库构建 Agent 升级：双模型 / 并行构建 / 编排插件 / CLI / 源库写回飞书

> 本文是 `docs/design/agent-knowledge-design.md`（下称**基线**）的增补演进，不替代基线。只写增量结论、接口、不变量与切片；未提及的契约一律沿用基线。引用写作「基线 §x」。
> **状态：已实施（S0–S14 合入），基线修订见 `agent-knowledge-design.md` §18。本文保留为实施依据，不删内容。**
> 输入证据：`agent-outputs/workflow/2026-10-27-kb-agent-upgrade/` 下 T0b（lark-cli 写能力）、T0c（amagi-pi 编排机制）、T0d（并行化与模型通道，含 part2）。代码基线 `feat/agent-knowledge-workbench @59a76fa`。预览渲染修复（T2a）不在本文范围。

## 0. 决策总表

| # | 方向 | 决策 | 理由 | 可逆性 |
|---|---|---|---|---|
| U1 | R1 配置位置 | vision 配置放 **`AgentConfig.vision`**，以 `providerId/modelId` 引用 `llm.providers`，不新增 key 字段；`LlmModelPreset` 加可选 `supportsImages` 只作 UI 提示 | 59a76fa 已把 `llm.providers` 定为唯一提供商注册表；消费者是 Agent 与构建，与 `agent.model` 并列；不复制密钥 | 可逆 |
| U2 | R1 图片入链 | **构建：preflight 预描述 + 内容寻址缓存，`raw_read` 内联描述**；会话：`raw_read` 内联已缓存描述 + 工具 `raw_read_image` 按需描述。**不做** pi 多模型注册 | 预描述保证工作集图片全覆盖、跨分片/跨构建复用；文本模型无需多模态、不改 `input:['text']`；pi 多模型依赖模型自觉调用，覆盖不可控，且图片字节进 pi 进程 | 可逆 |
| U3 | R1 通道 | 新增 `vision-channel.ts`，复用 `resolveActiveLlmConfig` 与三协议 SDK，content 扩为多模态块；不抛异常 | T0d：DirectChannel 已按 `ModelSelection` 换模型；不改 DirectChannel 本体以免回归原文整理 | 可逆 |
| U4 | R1 快照 | 快照条目新增 **`mediaHash`**；`contentHash` 公式**不变**；vision 启用时变更判定 = `contentHash` 或 `mediaHash` 变化 | 改 `contentHash` 会让升级后首次构建全量 changed；旧 manifest 无 `mediaHash` 视为未变 | 可逆 |
| U5 | R1 降级 | vision 未配置/失败时**构建照常**，图片处插入 `unavailable` 标记，构建记录与 UI 显示「N 张图片未理解」警告 | 纯文本标准库是既有合法产物；不静默、不阻断 | 可逆 |
| U6 | R2+R3 分层 | **两层**：R2 并行在 **KbBuildService 流水线内**（工作单元 + 多 worker 进程 + 路径认领 + 单一收尾轮）；R3 编排插件是通用任务编排面，触发构建只走 `app_command kb.build`，不扇出构建分片 | 快照冻结、校验、CURRENT 原子切换由 server 独占；让模型派发构建分片等于把单写者协议交给模型 | 可逆 |
| U7 | R2 分片 | 增量按「文档–源」图连通分量、全量按 relPath 一级目录聚类再切块；worker 拉取式 LPT 调度；单元内批次串行 | 连通分量保证同一已有文档只被一个单元改写（消解 T0d C1/C5） | 可逆 |
| U8 | R2 收尾 | 新工具 **`kb_unit_done`** 逐单元上报；**`kb_finish` 保持单值**，只在唯一收尾轮调用；覆盖检查在 join 后用 `∪unit.skipped ∪ finish.skipped` | 不改 `kb_finish` 语义即消解 T0d C3/C4；校验函数本体复用 | 可逆 |
| U9 | R2/R3 准入 | `AgentProcessPool` 增 FIFO `acquire`（后台类排队，不再 409）；后台类合计 ≤ `M−1`（M≥2 时为交互会话留 1 槽）；`maxConcurrentProcesses` 范围 **1..6、默认 3** | T0c 可复刻项 4；T0d：池硬顶 4、build/会话共用 | 可逆 |
| U10 | R3 载体 | 编排作为**内置 knowledge-workbench 包的新配置项「任务编排」**；角色卡与编排提示随包快照冻结；工具由 server 下发、现有转发扩展注册；状态机与队列在 server（`agent_tasks`） | 基线 §17 一包一插件；T0c 冲突面 1/2/6 要求 server 权威 | 可逆 |
| U11 | R3 v1 面 | 工具 `task_submit/query/resume/cancel`；DONE/BLOCKED marker；blocked→resume；仅 isolated 上下文；不做 steer/fork/接受轴/模板 | T0c §4.4 最小闭环；裁决者错位（冲突面 8）在 GUI 中裁剪 | 可逆 |
| U12 | R4 形态 | 独立 Node CLI，esbuild 单文件 `server/dist/cli/feishu-sync-cli.cjs`（零原生依赖）；应用内一键生成 shim `<dataRoot>/bin/feishu-sync`；v1 不发 npm | 与 kb-mcp.cjs 同构建链、随应用版本 | 可逆 |
| U13 | R4 认证 | **专用 CLI 令牌 + 端点文件**：设置中开启「命令行访问」（默认关）后生成独立 `cliToken`，写 `<dataRoot>/run/endpoint.json`（0600）；中间件要求回环 Host + 无 Origin + timing-safe 令牌（复用基线 §9.6 模式）。**不做 localhost 免令牌** | 免令牌会被同机其他用户与 DNS rebinding 利用；desktop token 不落盘；独立令牌可关、可轮换、可审计 | 可逆 |
| U14 | R4 命令面 | **单一命令表** `server/src/ops/command-table.ts`：命令 = HTTP 映射 + 参数 Schema + 风险级；CLI 与内部 Agent 工具 `app_command` 共用；HTTP API 仍是唯一业务契约 | Work 无 shell（基线 D5），Agent 不能跑 CLI；共表防语义漂移 | 可逆 |
| U15 | R4 内部 Agent | `app_command`：`read` 级直接执行；`mutate/destructive/remote_write` 逐次经**会话内用户批准**；含秘密命令不对 Agent 暴露 | 防提示注入借 Agent 改设置/清理/写回 | 可逆 |
| U16 | R4 离线 | 业务命令**只走运行中的 server**，无离线直写；不可达退出码 3；不自动拉起应用 | SQLite、锁、基线推进由 server 单进程拥有 | 可逆 |
| U17 | R5 源库写 | 新增 **SourceEditService** 作原始库正文的受控写者：header 字节保全、本地 OCC（baseHash）、编辑前备份、审计、构建活跃时拒绝；`source_edits` 登记脏状态，**SyncEngine 遇脏文档出 blocker `local_edit_pending`，绝不覆盖** | 不变量 1 的显式扩展（§9）；保住「同步不吞本地编辑」 | 关闭路由即回到只读 |
| U18 | R5 写回 | **FeishuWriteService** 经 lark-cli `docs +update`：本地正文 = 同步正文 + 尾部追加 → `append`（保留协作块）；否则 `overwrite`，须请求显式 `allowOverwrite`；v1 不做 str_replace/块级增量、不回传新图片。**S0 已定稿：`overwriteSupported=true`（markdown 全文语义保真）**；overwrite 安全协议为**三段式**（fetch→同流程立即写→写后回读校验） | T0b 推荐 A/A'；S0 动态实测（D4/D5）；多命令增量无事务 | planner 纯函数可扩 |
| U19 | R5 振荡 | 写回**不新增推进 synced 基线的路径**：成功后清脏，立即对该文档触发 SyncEngine 单文档 apply 回拉；回拉失败则检测如实报 modified，下次同步收敛到云端。**S0 修订依据（D6）**：`revision_id` 写后即时可读（docx GET API），作为回拉触发依据；回拉正文以**导出形态**为基线（经转义归一化层比对）；obj_edit_time 推进由回拉后的正常同步链路收敛 | 维持「只有 SyncEngine 原子提交推进 synced」契约；最多多一次真实同步，无数据丢失 | — |
| U20 | R5 冲突 | **S0 实测修订（D5）**：飞书 revision 校验只防未来值（>当前 → 4000002 拒绝），**不防过期值**（≤当前静默接受且 stale overwrite 造成正文重复损坏 ×N）。实际防线：①写回前取云端 `obj_edit_time` 比 `source_edits.base_obj_edit_time`，前进 → `409 source_push_conflict`（`force` + `confirm:'OVERWRITE_CLOUD'` 可越过，TOCTOU 窗口存在）；②overwrite 携 fetch 所得 `--revision-id` 仅作**防未来值参数校验**，不作安全承诺；③**写后回读校验必选**（fetch 正文归一化后与预期比对，失配即置 `conflict` 停止，**绝不重试旧 revision**） | 本地 baseHash 防本地并发；S0 D5 四组对照实验推翻「revision 防云端竞态」认知 | — |
| U21 | R5 scope | **S0 已定稿（D2）**：`WRITE_SCOPES = ['docx:document:write_only']`（device flow 整单接受 + 运行时验证）；媒体回传扩展 `docs:document.media:upload`（v1 不申请）；`wiki:node:update` 不可用且无需依赖；运行时 `missing_scope` 错误可读出 scope 名引导增量授权 | S0 实测：与 `docs:document:read` 整单拒绝先例不同，写 scope 无整单拒绝 | 可逆 |

## 1. 增量事实与硬约束

| 事实/约束 | 来源 | 推论 |
|---|---|---|
| 构建单飞（`running` + DB 单活跃行）；running 阶段单 pi 进程串行批 | T0d 结论 1/2 | 并行在单个构建内部做，单飞闸门保留 |
| `PiRpcProcess.prompt()` 单活跃 run | T0d（pi-rpc-process.ts:466） | 并行必须多进程 |
| staging 按 buildId 隔离、`kb_write_doc` 文件级原子；同 buildState 多令牌共享无数据竞争 | T0d C1/C2 | 多 worker 共享一个 BuildRunState 与 staging |
| `kb_finish` 单值、覆盖检查全局、cancel/timeout 单句柄、progress 单值 | T0d C3/C4/C7/C8 | 单元上报 + join 后校验 + 句柄集合 + 进度数组 |
| 池上限 `min(4,max)` 默认 2；build 不参与 idle 回收 | T0d §二 | U9 |
| 图片落盘 `<docDir>/images/NN-<token>`（无扩展名），md 相对引用；快照 hash 不含图片 | T0d 结论 11 | 引用解析 + magic bytes 嗅探 + mediaHash |
| provider 元数据 `input:['text']`；DirectChannel 三协议纯文本 | T0d 结论 9/10 | vision 在 server 侧完成，以文本回流 |
| 原始库已有非 SyncEngine 写者：回收站 restore/purge、源清理移入 `.trash-bin`、孤立文件清理 | `routes/trash.ts` 头注释；`kb/source-cleanup.ts:66-89` | 基线不变量 1 措辞已不精确，§9 一并修订 |
| `markDocumentSynced` 是 synced 基线唯一推进点 | local-map-store.ts:704- | U19 不新增推进点 |
| server 无同步/写全局锁 | grep `server/src` | R5 新增按 objToken 的进程内写锁 |
| desktop token 由 Electron 主进程生成、仅经 preload 注入；standalone 可由 `FEISHU_SYNC_DEV_TOKEN` 固定 | electron/main.ts:585；server index.ts:516-529 | CLI 不复用 desktop token |
| `docs +update` 六种 command；append 支持 markdown；overwrite 的 markdown 兼容性未证实 | T0b §2.3 | overwrite 由 S0 实测门控（§7.5） |
| 设备授权 `auth login --scope <requiredScopes>` | lark-cli-manager.ts:587,964-974 | 写 scope 单独请求集 |

## 2. 架构增量

```
内嵌 Hono server
 ├─ agent/
 │   ├─ AgentProcessPool      + acquire(kind) FIFO、后台配额 M−1              [U9]
 │   ├─ AgentToolService      + 工具扩展点 registerToolFamily()              [S1]
 │   ├─ vision/               VisionChannel · VisionDescriber(缓存)          [R1]
 │   ├─ tasks/                TaskService · RoleRegistry · task_* 工具       [R3]
 │   └─ approvals/            ApprovalService（app_command 批准）            [R4]
 ├─ kb/KbBuildService         快照+图片描述 → 单元调度(N worker) → 收尾轮 → 校验 → 发布 [R1/R2]
 │   ├─ build-units.ts        单元划分（纯函数）
 │   └─ path-claims.ts        构建内路径认领
 ├─ ops/command-table.ts      命令表（CLI 与 app_command 共用）               [R4]
 ├─ cli/                      CLI 源码；cli-endpoint.ts；middleware/cli-auth.ts [R4]
 └─ sources/
     ├─ SourceEditService     原始库正文受控写                                [R5]
     ├─ SourceWriteLock       按 objToken 进程内互斥（SyncEngine 单文档提交同用）
     └─ FeishuWriteService    push planner + lark-cli docs +update + 回拉      [R5]

外部 feishu-sync CLI ──HTTP + X-Feishu-Sync-Cli-Token──▶ server（读 endpoint.json）
pi 会话进程 ──app_command / task_* ──▶ /api/agent-internal（运行令牌）──▶ 命令表 / TaskService
```

## 3. R1 双模型通道

### 3.1 配置（`types/agent-knowledge.ts`，additive）

```ts
export interface AgentVisionConfig {
  enabled: boolean;            // 默认 false
  providerId?: string;         // 引用 llm.providers[].id
  modelId?: string;            // 引用该 provider 的 models[].id
  concurrency: number;         // 1..8，默认 3（server 侧 HTTP 并发，不占 pi 槽）
  maxImageBytes: number;       // 默认 5 MiB，上限 20 MiB；超限 unavailable(too_large)
  maxImagesPerBuild: number;   // 0..5000，默认 300；超出 unavailable(limit)
  timeoutMs: number;           // 单图，默认 120000
}
// AgentConfig 增加 vision: AgentVisionConfig；LlmModelPreset 增加 supportsImages?: boolean（仅 UI）
```

- 文本模型仍为 `agent.model`（app-llm 或 pi-agent-dir）；vision 只走 app-llm 提供商，与文本模型来源无关。
- `PUT /api/config`：`enabled=true` 时 provider/preset 必须存在且启用，否则 `400 invalid_config{field:'agent.vision.providerId'}`。无新秘密字段。

### 3.2 VisionChannel / VisionDescriber

```ts
// server/src/agent/vision/vision-channel.ts
export interface VisionRequest { bytes: Buffer; mime: 'image/png'|'image/jpeg'|'image/gif'|'image/webp'; prompt: string }
export interface VisionResult  { text: string; finishReason: 'stop'|'length'|'error'|'timeout'; model: string; latencyMs: number; errorMessage?: string }
export class VisionChannel {
  constructor(llm: LlmConfig, selection: ModelSelection);
  describe(req: VisionRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<VisionResult>; // 不抛异常；错误消息脱敏 apiKey
}
// openai-completions → image_url(data URL)；openai-responses → input_image；anthropic-messages → image/base64

// server/src/agent/vision/vision-describer.ts
export type ImageUnavailableReason = 'vision_unconfigured'|'vision_failed'|'too_large'|'unsupported_format'|'limit'|'missing_file'|'not_described';
export interface ImageDescription { src: string; imageHash: string; state: 'described'|'cached'|'unavailable'; reason?: ImageUnavailableReason; text?: string }
export class VisionDescriber {
  constructor(deps: { dataRoot: string; config: () => Config });
  status(): { state: 'disabled'|'ready'|'invalid'; model: string|null; message: string };
  lookup(imageHash: string): string | null;             // 只读缓存
  describeOne(file: string, src: string, signal?: AbortSignal): Promise<ImageDescription>;
  describeMany(items: Array<{ file: string; src: string }>, opts: { signal: AbortSignal; onProgress(p: { done: number; total: number }): void }): Promise<Map<string, ImageDescription>>;
}
```

- 缓存 `<dataRoot>/agent/vision-cache/<hash[0:2]>/<imageHash>.<modelKey>.json`，`modelKey = sha256(providerId/openAiModel/promptVersion)[0:12]`，tmp+rename 原子写；v1 无淘汰（§11）。
- 提示词 `server/src/agent/prompts/image-describe.md`（build-agent-assets 复制）：输出图中文字原文、表格/流程结构与关键数值，不臆测；`promptVersion` = 文件 sha256 前 8 位。
- 格式按 magic bytes 嗅探（文件无扩展名）；其他格式 `unsupported_format`。

### 3.3 图片枚举（`server/src/kb/source-images.ts`）

```ts
export function extractImageRefs(markdown: string): string[];   // ![](p)、<img src="p">；忽略 http(s)/data:
export function resolveSourceImages(knowledgeBaseRoot: string, sourceRelPath: string, markdown: string): Array<{ src: string; file: string }>;
  // 相对源文件目录解析，经 resolveInside(root, …, 'read')；逃逸丢弃，缺失记 missing_file
export function computeMediaHash(files: string[]): string | null;  // 按 src 排序逐文件 sha256 再合并；无图 null
```

### 3.4 构建链

1. **preflight**（`stage='describing_images'`）：快照后对工作集源枚举图片，`mediaHash`/`imageCount` 写入快照条目；vision `ready` 时 `describeMany`（命中缓存不计 `maxImagesPerBuild`），结果入 `BuildRunState.imageDescriptions`；取消/超时 signal 贯通。
2. **raw_read（Build）**：在 `<untrusted_source>` 内每个图片引用后插入 `<image_description src="images/03-xxx" state="described">…</image_description>` 或 `<image_description src="…" state="unavailable" reason="vision_unconfigured"/>`。描述同属不可信数据（基线 §7.4）。
3. **变更集**（vision 启用时）：`changed = contentHash 变 ∨ (双方 mediaHash 均非空 ∧ 不等)`；`verifySnapshotIntact` 对有 `mediaHash` 的源同步复核，构建中图片被替换 → `source_changed_during_build`。
4. 快照条目增量：`{ ...既有, mediaHash?: string|null, imageCount?: number }`（`raw-snapshot.json` 与 manifest `sourceSnapshot` 同步）。

### 3.5 会话

- Discuss/Work `raw_read` 只内联**已缓存**描述，未缓存标 `reason="not_described"`。
- 新工具 `raw_read_image`（Discuss/Work）：`{ objToken: string; src: string }` → 描述文本；`src` 必须属于该源 `resolveSourceImages` 结果；vision 未就绪 → 工具错误 `vision_unconfigured`。

### 3.6 API 与 UI

- `AgentStatusDto` 增 `vision: { state: 'disabled'|'ready'|'invalid'; model: string|null; message: string }`。
- `POST /api/agent/vision/test {providerId?, modelId?}` → `{ ok: boolean; finishReason; latencyMs: number; sample: string; error?: { code: string; message: string } }`，使用内置含中文字样的测试图 `prompts/vision-test.png`。
- `GET /api/kb/changes` 增 `images: { total: number; uncached: number }`。
- UI：`src/components/agent/AgentSettingsCard.tsx` 的运行时设置卡在文本模型下加「图片理解模型」段（开关、提供商/预设下拉、`supportsImages===false` 置灰、测试按钮、「图片将发送到所选端点」提示）；构建确认弹窗显示「需理解图片约 N 张（缓存 M）」；构建详情显示图片计数与未理解警告。

## 4. R2 并行构建（流水线内）

### 4.1 运行结构

```
preflight（快照 + 图片描述）
  → planUnits(workset, baseManifest)                   工作单元（纯函数）
  → W = min(buildParallelism, 单元数) 个 worker，每个 pool.acquire('build-worker') 后起 1 个 pi 进程
      worker 循环：拉取下一单元（源字节降序）→ 单元内批次串行 prompt → 末批要求 kb_unit_done
  → join（全部单元 done；任一单元最终失败 → 中止全部 worker → failed）
  → 收尾轮（复用最后存活 worker 进程，否则 acquire('build-final')）：输入单元摘要 + 跨单元新建文档清单 → 允许合并重复主题 → kb_finish
  → validating（join 后对聚合状态执行基线 §6.5 校验）→ publishing（不变）
```

`buildParallelism=1` 退化为单 worker + 同进程收尾，行为与现状等价（回退开关）。

### 4.2 单元划分（`server/src/kb/build-units.ts`）

```ts
export interface BuildUnit { id: string; sources: string[]; ownedDocs: string[]; bytes: number; batches: string[][] }
export function planUnits(input: {
  mode: 'full'|'incremental';
  workset: Map<string, { relPath: string; bytes: number }>;   // objToken → 元数据
  baseDocs: Array<{ path: string; sources: string[] }>;        // incremental：CURRENT manifest.docs
  requiredRewrites: string[];                                  // 受删除源影响需重写的文档
  batchSize: number;                                           // standardKb.buildBatchSize
}): BuildUnit[];
```

- incremental：「文档↔源」二部图并查集；工作集源与受影响文档所在分量为一个单元，分量内已有文档路径进 `ownedDocs`（预认领）。大分量**不拆**（正确性优先）。
- full：按 relPath 一级目录（`_custom/<文件夹>` 视为一级）聚类，目录内按 relPath 排序，每 `batchSize×3` 个源切一单元。
- 单元内批次 = `chunk(sources, batchSize)`；仅有删除的增量保底一个空单元（对应现状保底空批）。

### 4.3 路径认领（`server/src/kb/path-claims.ts`）

```ts
export class PathClaims {
  constructor(preclaimed: Array<{ path: string; unitId: string }>);
  claim(path: string, unitId: string): { ok: true } | { ok: false; owner: string };  // 首写者认领，单元重试不释放
  ownedBy(unitId: string): string[];
}
```

- worker 上下文（`unitId` 非空）的 `kb_write_doc`/`kb_delete_doc` 先 `claim`；他单元路径 → 工具错误 `kb_path_owned_by_other_unit`（消息含所属文档标题，提示换路径）。
- 收尾轮（`phase='final'`）不受认领限制，可合并/删除任意 staging 文档。认领仅存内存。

### 4.4 工具与运行上下文

| 工具 | 变更 |
|---|---|
| `kb_unit_done`（新，Build） | `{ summary: string(≤2000); skipped: Array<{ objToken: string; reason: string }> }`；objToken 须属本单元；重复调用以最后一次为准 |
| `kb_finish` | 语义不变；`phase!=='final'` → 工具错误 `kb_finish_not_allowed_in_unit` |
| `raw_list` | worker 上下文 `filter:'workset'` 只列本单元源 |
| `raw_read` | 图片描述内联（§3.4） |

- `BuildRunContext` 增 `workerId: string; unitId: string|null; phase: 'unit'|'final'`；所有 worker 共享同一 `BuildRunState`，增 `units`、`unitDone: Map<unitId,{summary,skipped}>`、`claims: PathClaims`、`imageDescriptions`。
- 覆盖检查 skipped 集合 = `∪unitDone.skipped ∪ finishInfo.skipped`；校验函数 `validateStagingDocs` 本体不改。

### 4.5 失败、取消、超时、毒化

- 单元末批后无 `kb_unit_done` → 一次纠正 prompt → 仍无即单元失败。可重试错误（`model_timeout`、`model_request_failed`、`pi_process_exited`）每单元自动重试 1 次：新进程从首个未完成批次续跑，提示附本单元已认领文档；不可重试或重试仍败 → 构建 `failed`，中止全部 worker，CURRENT 不动。
- 取消/整体超时：`entry.processes: Map<workerId, PiRpcProcess>` 全部 abort；`finally` 逐个 `pool.terminate('build:<id>:<workerId>')`（含 final）。
- 毒化（基线 F3-R08）：共享 `state.poisoned`；任一 worker 批次边界检测到即协调器中止全部。
- `buildTimeoutMinutes` 内拿不到首个槽位 → `failed(agent_busy)`。

### 4.6 进度、事件、DTO、DB、配置

```ts
interface KbBuildProgressDto {
  batchIndex: number; batchTotal: number;   // 兼容字段：已完成批次 / 全部批次 + 1（收尾轮）
  stage: 'snapshot'|'describing_images'|'units'|'finishing'|'validating'|'publishing'|null;
  units: { total: number; done: number; running: number; failed: number; retried: number };
  workers: Array<{ workerId: string; state: 'waiting_slot'|'running'|'finishing'|'exited'; unitId: string|null; unitBatchIndex: number; unitBatchTotal: number }>;
  images: { total: number; described: number; cached: number; unavailable: number };
}
// KbBuildDto：progress 换为 KbBuildProgressDto；新增 parallelism: number；warnings: Array<{ code: string; count: number; message: string }>
```

- SSE：`tool`/`build_log`/`assistant_delta` data 增可选 `workerId`、`unitId`；新事件 `build_worker`（data=单个 worker 进度项）；seq 机制不变。
- `kb_builds` additive 列：`parallelism INTEGER NOT NULL DEFAULT 1`、`unit_total INTEGER NOT NULL DEFAULT 0`、`vision_model TEXT`、`warnings_json TEXT`（`applyAdditiveMigrations` 与 DDL 两处登记）。
- `StandardKbConfig.buildParallelism`（1..6，默认 2）；`buildBatchSize` 语义改为「单元内每批源数」。
- UI：构建面板显示 worker 列表、单元计数、图片计数与警告；标准库设置加「并行数」（提示受 Agent 进程上限约束）。

### 4.7 进程池（`agent-process-pool.ts`）

```ts
type ProcessKind = 'session'|'probe'|'build-worker'|'build-final'|'task';
class AgentProcessPool {
  reserveSlot(kind: 'session'|'probe'): PoolSlot | null;      // 既有立即语义：满 → null（会话仍 409 agent_busy）
  acquire(kind: 'build-worker'|'build-final'|'task', opts: { signal: AbortSignal }): Promise<PoolSlot>; // FIFO；取消即出队 reject
  queueDepth(): number;
}
```

容量 `M = clamp(maxConcurrentProcesses,1,6)`；后台类同时占用 ≤ `M>1 ? M−1 : 1`；`release` 同步晋级队首；队列不跨重启。key：`build:<buildId>:w<i>`、`build:<buildId>:final`、`task:<taskId>`；build/task 不参与 idle 回收。

## 5. R3 编排插件（任务编排面）

### 5.1 载体与角色卡

- knowledge-workbench 内置包新增配置项 `orchestration`（AppPluginStore 条目：`enabled`，默认 false；Leader 编排提示正文，可覆盖，沿用基线 §17 overrides/revision）。不新增扩展 JS：`task_*` 由 server 工具规格下发、现有转发扩展注册。
- 角色卡 `server/src/agent/roles/*.md`（build-agent-assets 复制），v1 内置三张，不支持用户自定义；文件名即查找键，符号链接拒绝，非法 frontmatter 跳过并告警：

```yaml
---
name: kb-analyst
label: 分析员
description: 只读分析原始库与标准库，给出结构化结论
tools: [kb_search, kb_read, raw_search, raw_read, raw_read_image]
requiresMode: any        # any | work
---
（正文 = 子任务系统提示；server 在其后追加公共子任务契约）
```

| 角色 | 工具请求 | requiresMode |
|---|---|---|
| `kb-analyst` | kb_search kb_read raw_search raw_read raw_read_image | any |
| `kb-converter` | raw_* kb_search kb_read ws_ls ws_read ws_search ws_write ws_edit ws_mkdir | work |
| `kb-reviewer` | kb_search kb_read raw_read ws_ls ws_read ws_search | any |

- 授予工具 = 角色请求 ∩ 父会话当前模式工具集 ∩ 已知工具；为空或模式不满足 → `task_role_not_allowed_in_mode`。子任务**永不**获得 `task_*`、`app_command`（depth=1）。
- 公共子任务契约：最终回复末行 `<!--FS:DONE-->`；缺信息时首行 `<!--FS:BLOCKED-->` 后接 `QUESTIONS:`；缺 marker → 一次纠正 nudge → 仍缺 `failed(task_contract_missing)`。

### 5.2 Leader 工具（Discuss/Work，编排启用时下发）

| 工具 | 参数 | 返回 |
|---|---|---|
| `task_submit` | `{ role: string; title: string(1..80); task: string(1..20000); outputDir?: string }` | `{ taskId; status: 'queued'\|'running'; queuePosition: number }` |
| `task_query` | `{ taskIds?: string[](≤32); wait?: { mode: 'any'\|'all'; timeoutSeconds: 1..600 } }` | `{ tasks: AgentTaskDto[]; timedOut: boolean }` |
| `task_resume` | `{ taskId: string; message: string(1..20000) }` | `AgentTaskDto`（仅 blocked） |
| `task_cancel` | `{ taskId: string }` | `AgentTaskDto` |

- `outputDir`：converter 必填，Workspace 相对路径；该任务 ws 写入根收窄为 `<workspace>/<outputDir>`（PathGuard 以其为根），防并行子任务互写；同会话两个非终态任务 outputDir 不得互为前缀 → `409 task_output_dir_overlap`。
- 每会话非终态任务 ≤ `orchestration.maxActiveTasksPerSession`（默认 8），超出 `task_queue_full`。
- `wait` 在工具内阻塞（受 prompt 超时约束）；不做完成后自动唤醒 Leader（避免未经用户发起的模型调用）。

### 5.3 状态机与进程

```
queued ─acquire('task')→ running ─DONE→ done
                           ├─BLOCKED→ blocked ─task_resume/resume API→ queued
                           └─错误/契约缺失→ failed
任意非终态 ─cancel→ cancelled；server 启动时 queued/running → interrupted
```

- 子任务进程：`runKind:'task'`，`--session-id <taskId>`，`--session-dir <dataRoot>/agent/sessions/tasks`；系统提示 = 角色正文 + 子任务契约；插件快照 revision 取派发时父会话快照并冻结进记录；模型 = `agent.model`（v1 不按任务换模型）。
- 单轮超时 `orchestration.taskTimeoutMinutes`（默认 30）；运行完成判定沿用基线 §4.4。父会话删除 → 其非终态任务取消；父会话切模式不影响已冻结工具集。

### 5.4 存储与 API

```sql
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL, task_text TEXT NOT NULL,
  status TEXT NOT NULL,              -- queued|running|done|blocked|failed|cancelled|interrupted
  parent_mode TEXT NOT NULL, workspace_id TEXT, output_dir TEXT,
  tools_json TEXT NOT NULL, plugin_revision TEXT, model TEXT, rounds INTEGER NOT NULL DEFAULT 0,
  result_text TEXT, questions_text TEXT, error_code TEXT, error_message TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id, created_at);
```

```ts
interface AgentTaskDto {
  id: string; sessionId: string; role: string; title: string;
  status: 'queued'|'running'|'done'|'blocked'|'failed'|'cancelled'|'interrupted';
  queuePosition: number|null; rounds: number; outputDir: string|null;
  questions: string|null; result: string|null; resultTruncated: boolean;   // 工具返回 ≤20000 字符，库内 ≤64KB
  error: null | { code: string; message: string };
  createdAt: string; startedAt: string|null; finishedAt: string|null;
}
```

| 方法 | 路径 | 请求 → 响应 |
|---|---|---|
| GET | `/api/agent/tasks?sessionId=` | → `{ tasks: AgentTaskDto[] }` |
| GET | `/api/agent/tasks/:id` | → `AgentTaskDto` |
| POST | `/api/agent/tasks/:id/cancel` | → `AgentTaskDto` |
| POST | `/api/agent/tasks/:id/resume` | `{ message }` → `AgentTaskDto`（用户在任务面板直接作答） |
| GET | `/api/agent/tasks/:id/messages` | → `{ messages: AgentMessageDto[] }`（解析子任务 JSONL，同基线 §7.6） |

父会话 SSE 新事件 `task_update`（data=`AgentTaskDto`）。UI：对话页右栏新增「任务」区（状态、作答、结果展开、取消）。

### 5.5 T0c 冲突面处置

| # | 冲突 | 处置 |
|---|---|---|
| 1 | 自由 spawn | 只经 `pool.acquire('task')` + PiRpcProcess |
| 2 | tools 直通 | 角色请求 ∩ 父模式工具集，server 运行上下文授权 |
| 3 | 准入 vs 池上限 | 与构建 worker 共用后台配额 `M−1`，FIFO |
| 4 | selected 扫 JSONL | v1 仅 isolated；Leader 把上下文写进 task 文本 |
| 5 | glob 白名单 | 写入面 = Workspace/outputDir + PathGuard |
| 6 | 运行期动态注册 | 插件快照随任务冻结 |
| 7 | 模型解析 | 只用 `agent.model` |
| 8 | 裁决者 | 无接受轴；结果呈现给用户 |

## 6. R4 CLI 与内部 Agent 运维面

### 6.1 进程与分发

- 源码 `server/src/cli/`（`main.ts` 参数解析、`client.ts` HTTP、`output.ts`），只用 Node 内置模块与全局 `fetch`；`scripts/build-agent-assets.mjs` 用 esbuild 打包为 `server/dist/cli/feishu-sync-cli.cjs`（随 `asarUnpack server/**` 解包）。
- shim：`POST /api/cli/install-shim` 写 `<dataRoot>/bin/feishu-sync`（POSIX 0755）与 `feishu-sync.cmd`（Windows）：打包版以应用 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1` 运行 cli.cjs，开发版用当前 Node。不改用户 PATH，只返回追加提示。
- `GET /api/cli/info` → `{ enabled: boolean; shimInstalled: boolean; shimPath: string; command: string; args: string[]; env: Record<string,string>; pathHint: string; endpointFile: string }`。

### 6.2 认证

```ts
// server/src/cli-endpoint.ts
interface CliEndpointFile { schemaVersion: 1; url: string; pid: number; startedAt: string; appVersion: string; cliToken: string }
export class CliEndpoint {
  constructor(dataRoot: string);
  publish(url: string): void;    // cli.enabled 时：32 字节 base64url 令牌；<dataRoot>/run 目录 0700、文件 0600；tmp+rename
  revoke(): void;                // pid 匹配才删文件；内存令牌失效；应用退出时调用
  rotate(): void;
  verify(token: string): boolean; // timing-safe
}
// Config 增加 cli: { enabled: boolean }（默认 false）
```

- `middleware/cli-auth.ts`：请求带 `X-Feishu-Sync-Cli-Token` 时要求回环 Host、**无 Origin**、令牌通过，标记 `actor='cli'` 放行；不通过 401。与 desktop auth 组合为「desktop token **或** CLI token」。CLI 令牌不被 `/api/agent-internal/*` 接受。
- `POST /api/cli/enable {enabled: boolean}`、`POST /api/cli/token/rotate`、`POST /api/cli/install-shim` **只接受 desktop token**（CLI 不能自授权）。`PUT /api/config` 对 `actor='cli'` 丢弃 `cli.*`。
- 审计：`actor='cli'` 的非 GET 请求追加 `<dataRoot>/audit/cli.jsonl`（时间、方法、路径、状态码，不记 body）。
- 安全边界：令牌文件与明文 provider key 的 `config.json` 同属本用户信任域，同 uid 恶意进程两者皆可读——这是既有边界，不宣称更强；令牌阻断同机其他用户、浏览器与 DNS rebinding。Windows ACL 依赖用户目录默认权限（§11）。

### 6.3 命令表（`server/src/ops/command-table.ts`）

```ts
export type OpsRisk = 'read'|'mutate'|'destructive'|'remote_write';
export interface OpsCommandDef {
  name: string;                    // 'kb.build' → CLI `feishu-sync kb build`
  summary: string;
  risk: OpsRisk;
  params: JsonSchemaObject;        // CLI flag 与 app_command args 共用
  request(args: Record<string, unknown>): Array<{ method: 'GET'|'POST'|'PUT'|'DELETE'; path: string; query?: Record<string,string>; body?: unknown }>;
  confirm?: { field: string; value: string };   // 由调用方在确认后注入 body（如 confirm:'BUILD'）
  agentExposed: boolean;
  stream?: 'sse'|'long-poll';
}
export const OPS_COMMANDS: readonly OpsCommandDef[];
```

| 命令 | 风险 | Agent | HTTP（既有或本文新增） |
|---|---|---|---|
| `status` | read | ✓ | `GET /api/health`、`/api/agent/status`、`/api/feishu/lark-cli/status`、`/api/kb/status` |
| `auth status` / `auth login [--switch-account] [--write]` / `auth cancel` | read / mutate / mutate | ✓ | `GET /api/feishu/auth-status`；`POST /api/feishu/auth/device/start`→输出 verificationUrl→`/complete`（long-poll）；`/cancel` |
| `lark install` / `lark init` | mutate | ✓ | `POST /api/feishu/lark-cli/install`；`/config-init/start` + `/complete` |
| `config get [path]` / `config set <path> <json>` | read / mutate | ✓ | `GET /api/config`（已脱敏）；`PUT /api/config` 窄 patch（拒 `*.apiKey`、`agent.workspaces`、`cli.*`） |
| `llm test [--provider --model]` / `vision test` | read | ✓ | `POST /api/llm/test-channel`；`POST /api/agent/vision/test` |
| `llm set-key <providerId> --key-stdin` | mutate | ✗ | `PUT /api/config`（key 只从 stdin 读） |
| `clean orphans [--apply]` | destructive | ✓ | `GET /api/orphan-files`；`POST /api/orphan-files/cleanup` |
| `clean trash list\|restore\|purge` | read/mutate/destructive | ✓ | `GET /api/trash`；`POST /api/trash/restore`；`DELETE /api/trash/purge` |
| `clean sources <objToken…>` | destructive | ✓ | `POST /api/kb/sources/cleanup`（沿用其确认字段） |
| `kb status\|changes\|builds\|versions` | read | ✓ | `/api/kb/status`、`/changes`、`/builds`、`/versions` |
| `kb build [--full]` / `kb cancel <id>` / `kb events <id> --follow` | mutate / mutate / read | ✓ | `POST /api/kb/builds`；`/builds/:id/cancel`；SSE `/builds/:id/events` |
| `kb sources include\|exclude <objToken…>` | mutate | ✓ | `POST /api/kb/sources/selection` |
| `source show <objToken>` | read | ✓ | `GET /api/mapping/content/:objToken` |
| `source state [objToken]` | read | ✓ | `GET /api/sources/edits[/:objToken]`（§7.4） |
| `source edit <objToken> (--from-file f \| --replace old new) [--base-hash h]` | mutate | ✓ | `POST /api/sources/:objToken/edit` |
| `source revert <objToken>` | destructive | ✓ | `POST /api/sources/:objToken/revert` |
| `source push <objToken> [--allow-overwrite] [--force]` | remote_write | ✓ | `POST /api/sources/:objToken/push/preview` → `/push` |

- CLI：`destructive/remote_write` 需 `--yes`，否则打印预览并退出码 4。
- 顺序要求：命令表只引用已存在路由；引用本文新路由的命令在对应切片合入后登记（切片表依赖）。

### 6.4 输出、退出码、离线

- `--json`（或 `FEISHU_SYNC_CLI_JSON=1`）：stdout 单个 `{ "ok": true, "data": … }` / `{ "ok": false, "error": { "code", "message", "httpStatus"?, "details"? } }`；流式命令输出 NDJSON（每行 `{ "event", "data" }`）。人类模式输出中文表格。
- 退出码：0 成功；1 业务错误；2 用法错误；3 应用不可达；4 需要确认。
- 发现：`--home` > `FEISHU_SYNC_HOME` > `~/.feishu-sync`，读 `run/endpoint.json`。缺失 → 3 `app_not_running`（提示启动应用并在「设置 → 命令行」开启）；`/api/health` 不通 → 3 `app_not_reachable`（陈旧文件不自动删）。不自动拉起应用，无离线直写。

### 6.5 `app_command` 与批准

- 工具规格 `{ command: string; args?: object }`；只列 `agentExposed`；Discuss 仅 `read` 级，Work 全部 exposed；Build/Task 不下发。
- 执行：server 内 `app.request()` 携 desktop token 调用目标路由（不走网络），结果 JSON 截断 ≤20000 字符；`confirm` 字段只由 server 在批准后注入，模型传入即剔除。

```ts
// server/src/agent/approvals/approval-service.ts
interface ApprovalRequestDto { id: string; sessionId: string; command: string; risk: OpsRisk; argsSummary: string; preview?: unknown; expiresAt: string }
// SSE 事件 approval_request（ApprovalRequestDto）、approval_resolved（{ id, decision }）
// GET  /api/agent/sessions/:id/approvals                        → { approvals: ApprovalRequestDto[] }
// POST /api/agent/sessions/:id/approvals/:approvalId { decision: 'approve'|'reject' } → { id, decision }
```

工具调用挂起等待；10 分钟或会话中止 → `approval_timeout`/`approval_rejected` 工具错误；审计写基线 §9.6 的会话审计文件。UI 在消息流内渲染批准卡片。

## 7. R5 源库受控写与写回飞书

### 7.1 范围

- 可编辑：`obj_type='docx'` 且头部为当前规范格式（`<!--\nfeishu_sync:` 注释块）的源，结构树成员与 `_custom/` 归档均可。sheet/bitable/slides 的 md 是导出投影 → `422 source_edit_unsupported_type`；历史头格式 → `422 source_header_unsupported`（下次同步会升级）。
- 不在范围：新建云文档（`drive +import`）、wiki 节点增删移、图片回传、块级/str_replace 增量写回。

### 7.2 SourceEditService（`server/src/sources/source-edit-service.ts`）

```ts
export type SourceEditActor = 'ui'|'cli'|'agent';
export type SourceEditOp =
  | { mode: 'replace_body'; body: string }
  | { mode: 'str_replace'; old: string; new: string; replaceAll?: boolean };   // old 须唯一（除非 replaceAll）
export class SourceEditService {
  constructor(deps: { config: ConfigManager; store: LocalMapStore; locks: SourceWriteLock; kbBuild: { isActive(): boolean }; dataRoot: string });
  read(objToken: string): { relPath: string; header: string; body: string; bodyHash: string; state: SourceEditState | null };
  edit(objToken: string, op: SourceEditOp, opts: { baseHash: string; actor: SourceEditActor }): { bodyHash: string; state: SourceEditState };
  revert(objToken: string, actor: SourceEditActor): void;
}
```

写入顺序（持 `SourceWriteLock(objToken)`）：
1. 拒绝条件：标准库构建活跃 → `409 kb_build_active`；状态 `pushing` → `409 source_push_in_progress`；文档 `cloud_deleted=1` 或被屏蔽 → `409 source_not_editable`。
2. 经 `resolveInside(knowledgeBaseRoot, relPath, 'write')` 取文件；按规范头结束符切分 `header` 与 `body`；头部 `obj_token` 必须等于路由参数。
3. `sha256(body) !== baseHash` → `409 source_edit_conflict`（返回当前 `bodyHash`）。
4. 首次编辑：把同步版正文复制到 `<dataRoot>/source-edits/<objToken>/base.md`，写 `source_edits` 行（`base_obj_edit_time = documents.synced_obj_edit_time`）。每次编辑前的正文另存 `<seq>.md`（保留最近 20 份）。
5. 写新内容 = **原 header 字节** + 新 body：同目录临时文件 → fsync → rename；写后重读并用 `IndexScanner.parseMetadata` 解析，元数据必须与写前逐字段相等，否则用 `<seq>.md` 恢复并 `500 source_header_roundtrip_failed`。
6. 更新 `source_edits`（`state='dirty'`、`current_body_hash`、`edit_count+1`、`last_actor`）；追加 `<dataRoot>/audit/source-writes.jsonl`（时间、actor、objToken、relPath、op、前后 hash）。

`documents` 表与 `observed/synced_obj_edit_time` **不动**。标准库下次构建会把该源当 changed（contentHash 变化），符合预期。

### 7.3 与 SyncEngine/检测/重建的交互

| 链路 | 规则 |
|---|---|
| SyncEngine | 单文档提交前查 `source_edits`：`dirty/pushing/conflict` → blocker `local_edit_pending`（不写、不推进基线）；`pushed` 不阻断。提交经 `SourceWriteLock`。提交成功（`markDocumentSynced`）后删除该 `pushed` 行与备份目录 |
| ChangeDetector | 不变；写回后云端 `obj_edit_time` 前进，若未及回拉则如实报 modified |
| IndexScanner 全量重建 | header 字节未变，元数据、`local_rel_path`、身份通道不变；`source_edits` 不参与重建 |
| 回收站/源清理/孤立清理 | 对有 `source_edits` 行（非 pushed）的文档拒绝：`409 local_edit_pending` |
| 前端同步列表 | blocker 文案「本地有未写回的修改：写回飞书或放弃修改后再同步」 |

### 7.4 数据表与 API

```sql
CREATE TABLE IF NOT EXISTS source_edits (
  obj_token TEXT PRIMARY KEY, local_rel_path TEXT NOT NULL,
  state TEXT NOT NULL,                 -- dirty|pushing|pushed|conflict
  base_obj_edit_time TEXT, base_body_hash TEXT NOT NULL, current_body_hash TEXT NOT NULL,
  edit_count INTEGER NOT NULL DEFAULT 0, last_actor TEXT NOT NULL,
  push_mode TEXT, push_revision_id TEXT, last_error_code TEXT, last_error_message TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pushed_at TEXT
);
```

启动时 `pushing` 行置为 `conflict`（`last_error_code='push_interrupted'`，需用户核对云端后重推或放弃）。

```ts
interface SourceEditStateDto { objToken: string; relPath: string; title: string; state: 'dirty'|'pushing'|'pushed'|'conflict';
  bodyHash: string; baseBodyHash: string; editCount: number; lastActor: SourceEditActor; error: null|{ code: string; message: string }; updatedAt: string }
interface SourcePushPlanDto {
  mode: 'append'|'overwrite'|'blocked';
  blockedReason?: 'no_changes'|'overwrite_required'|'overwrite_unsupported'|'images_in_overwrite'|'images_in_append'|'write_disabled'|'write_scope_missing';
  appendMarkdown?: string; bytes: number;
  cloud: { objEditTime: string; revisionId: number|null };
  conflict: boolean;                     // 云端 obj_edit_time 已越过 base_obj_edit_time
  warnings: string[];                    // 如「覆盖会丢失云端评论锚点/协作块」
}
```

| 方法 | 路径 | 请求 → 响应 |
|---|---|---|
| GET | `/api/sources/edits` | → `{ edits: SourceEditStateDto[] }` |
| GET | `/api/sources/edits/:objToken` | → `SourceEditStateDto & { body: string }`（无行 404 `source_edit_not_found`） |
| POST | `/api/sources/:objToken/edit` | `{ op: SourceEditOp; baseHash: string }` → `{ bodyHash; state }` |
| POST | `/api/sources/:objToken/revert` | `{ confirm: 'REVERT' }` → `{ ok: true }`（以 `base.md` 恢复正文并删行） |
| POST | `/api/sources/:objToken/push/preview` | → `SourcePushPlanDto` |
| POST | `/api/sources/:objToken/push` | `{ allowOverwrite?: boolean; force?: boolean; confirm: 'PUSH'\|'OVERWRITE_CLOUD' }` → `{ state; mode; revisionId: number\|null; pull: { ok: boolean; status: string; message?: string } }` |

`confirm` 规则：append 且无冲突 → `'PUSH'`；overwrite 或 `force` → `'OVERWRITE_CLOUD'`。`GET /api/mapping/content/:objToken` 响应增 `bodyHash` 与 `editState`，供预览面板和 CLI 取 baseHash。

### 7.5 FeishuWriteService 与推送规划

```ts
// server/src/sources/push-planner.ts（纯函数）
export function planPush(input: { baseBody: string; currentBody: string; allowOverwrite: boolean; overwriteSupported: boolean }):
  Pick<SourcePushPlanDto, 'mode'|'blockedReason'|'appendMarkdown'>;
// 规则：去尾部空白后 current === base → blocked(no_changes)
//       current 以 base 为前缀 → append（后缀含本地图片引用 → blocked(images_in_append)）
//       否则 allowOverwrite ∧ overwriteSupported → overwrite（current 含本地图片引用 → blocked(images_in_overwrite)）
//       否则 blocked(overwrite_required | overwrite_unsupported)
```

推送顺序（持 `SourceWriteLock`，状态 `dirty|conflict → pushing`）：
1. `feishuWrite.enabled` 且 `writeScopesGranted`，否则 `403 feishu_write_disabled` / `403 feishu_write_scope_missing`。
2. 取云端 `obj_edit_time`（复用 ChangeDetector 的单文档元数据读取）与 `revision_id`（`docs +fetch --doc <objToken> --scope full --detail full --format json`，T0b §2.3 的 overwrite 前置读取）。`obj_edit_time > base_obj_edit_time` 且非 `force` → 状态 `conflict`，`409 source_push_conflict`。
3. append：`lark-cli docs +update --doc <objToken> --command append --doc-format markdown --content @<tmpfile>`；overwrite：`--command overwrite --revision-id <rev> --doc-format markdown --content @<tmpfile>`。**S0 实测修订（三段式协议 + 转义层，详见 S0-write-probe.md §④）**：a) overwrite 必须同一流程内 fetch→立即写→**写后回读校验**（fetch 正文归一化后与预期比对，失配即置 `conflict` 停止，**绝不重试旧 revision**——stale overwrite 会被静默接受并造成正文重复损坏）；b) **转义归一化层**（纯函数+单测）：push-planner 的前缀/相等判断与回拉后 baseBody 更新先归一化（写入/导出转义集不对称：段落内 `\|`/`\[` 字节失真；表格分隔行规范化；`<title>` 行剥离；末尾换行）；c) append/overwrite 正文中的字面 `<`（sync-engine 产物的 `<img>/<whiteboard>/<sheet>` 标签）**必须 `\<` 转义**（markdown 模式下 XML 标签解析生效）；d) `@file` 只接受子进程 cwd 相对路径；e) 写后回读的图片块形态为 `![](https://feishu.cn/file/<file_token>)`，回拉后与既有媒体下载/本地引用重写机制衔接。新增 client 方法 `LarkCliClient.updateDocumentAppend / overwriteDocument / fetchDocumentRevision`。
4. 成功 → `state='pushed'`、记 `push_mode/push_revision_id`、审计；立即调用 SyncEngine 单文档 `apply:true, confirmation:'APPLY'` 回拉（与 `POST /api/sync` 同一内部入口），成功即删行。
5. lark-cli 失败 → `state='conflict'`（revision 未来值 4000002 / 回读失配）或回到 `dirty`（其他错误），保留原始错误码；append 超时且结果未知 → `conflict`（`push_outcome_unknown`），不自动重推。

**S0 定稿（2026-10-27 实测）**：`overwriteSupported=true`（D4 动态往返）；`WRITE_SCOPES=['docx:document:write_only']`（D2）；append 语义级高保真（结构 100%，D3）；revision 仅防未来值（D5）。定值表见 `S0-write-probe.md` §③。

### 7.6 权限与授权

- 配置 `feishuWrite: { enabled: boolean }`（默认 false，只接受 desktop token 修改；`actor='cli'` 的 `PUT /api/config` 丢弃该字段）。
- `lark-cli-manager.ts` 增 `WRITE_SCOPES: readonly string[]`，v1 候选仅 `docx:document:write_only`（不回传图片故不申请 `docs:document.media:upload`），S0 实测定稿；`POST /api/feishu/auth/device/start` body 增 `scopeSet?: 'read'|'write'`，`write` = 既有 requiredScopes ∪ WRITE_SCOPES；`GET /api/feishu/auth-status` 增 `writeScopesGranted: boolean`。
- 内部 Agent 仅能通过 `app_command source.*`（Work，逐次批准）修改源与推送；Discuss/Build/Task 无任何源写通道。
- UI：原始文档预览面板增「编辑」（正文编辑器，头部不可见不可改）、状态徽标、「放弃修改」与「写回飞书」（先展示 push preview，再按 confirm 规则二次确认）；设置页「飞书写入」开关与增量授权入口。

## 8. 新增错误码（并入基线 §8，响应体格式不变）

| HTTP | error | 场景 |
|---|---|---|
| 400 | `invalid_config`（`details.field`） | vision/并行数/编排/cli/feishuWrite 配置校验失败 |
| 401 | `cli_token_invalid` | CLI 令牌缺失/错误/带 Origin/非回环 |
| 403 | `cli_forbidden_route` | CLI 令牌访问只接受 desktop token 的路由 |
| 403 | `feishu_write_disabled` / `feishu_write_scope_missing` | 写回未开启 / 未授权写 scope |
| 404 | `task_not_found` / `approval_not_found` / `source_edit_not_found` | — |
| 409 | `task_queue_full` / `task_not_blocked` / `task_output_dir_overlap` | 编排 |
| 409 | `source_edit_conflict` / `source_push_conflict` / `source_push_in_progress` / `local_edit_pending` / `source_not_editable` / `kb_build_active` | 源编辑与写回 |
| 422 | `source_edit_unsupported_type` / `source_header_unsupported` / `source_push_blocked`（`details.reason`=blockedReason） | — |
| 500 | `source_header_roundtrip_failed` | 写后头部解析不一致，已恢复 |
| 502 | `feishu_write_failed`（`details.larkCode`、原始消息前 500 字） | lark-cli 写失败 |
| —（工具错误） | `kb_path_owned_by_other_unit` / `kb_finish_not_allowed_in_unit` / `vision_unconfigured` / `task_role_not_allowed_in_mode` / `task_contract_missing` / `approval_rejected` / `approval_timeout` | 以工具错误文本返回模型 |
| —（构建失败码） | `kb_unit_failed`（`details.unitId`、引发码） | 单元重试后仍失败 |
| —（blocker） | `local_edit_pending` | SyncEngine 跳过有本地未写回修改的文档 |
| —（CLI 退出码 3） | `app_not_running` / `app_not_reachable` | 仅 CLI 本地产生 |

## 9. 与基线的冲突与修订

### 9.1 基线 §13 不变量修订

| # | 基线原文 | 修订后 | 理由 |
|---|---|---|---|
| 1 | 原始库只被 SyncEngine 写；Agent 相关代码对原始库只有读路径。 | **原始库正文只由登记在册的受控写者修改：SyncEngine（云端→本地）、源生命周期操作（回收站 restore/purge、源清理、孤立文件清理，只移动/删除、不改正文）、SourceEditService（用户或经批准的 Agent 发起的正文编辑）。每次写都有审计记录；Agent 工具（raw_*、ws_*、kb_*、task_*）对原始库仍只有读路径，唯一的写入口是经用户逐次批准的 `app_command source.*`。** | 基线措辞已与现有删除/移动写者不符；R5 需要显式、受控、可审计的第三写者 |
| 1a（新） | — | 文档存在未写回本地修改（`source_edits` 非 pushed）时，SyncEngine 与源生命周期操作不得覆盖、移动或删除该文档；`feishu_sync` 头部字节只由 SyncEngine 生成。 | 防同步吞编辑、保 round-trip |
| 1b（新） | — | `synced_obj_edit_time` 只由 SyncEngine 原子提交推进；写回飞书不推进任何同步基线。 | 沿用 CLAUDE.md 同步契约 |
| 2 | CURRENT 只在校验全部通过后更新 | 不变；补充「并行构建中校验在全部单元 join 与收尾轮之后对聚合状态执行，任一单元失败则整体失败」 | R2 |
| 3 | pi 中只存在扩展注册工具；授权以 server 为准 | 不变；补充「子任务工具集 = 角色请求 ∩ 父模式工具集；`app_command` 的非只读命令需用户逐次批准，模型不能提供 confirm 字段」 | R3/R4 |
| 4 | 无模型不产生内容 | 不变；补充「vision 不可用不阻断文本构建，但必须以 unavailable 标记与构建警告如实告知」 | R1 |
| 5 | 秘密不出现在 argv/日志/SSE/DTO | 扩展：`cliToken` 只存于 0600 端点文件与请求头；CLI 安装 key 只走 stdin；写回内容经临时文件传 lark-cli | R4/R5 |

### 9.2 其他冲突

| 基线位置 | 冲突 | 处置 |
|---|---|---|
| §6.4 running「单进程、任一批失败即整体失败、最后 prompt 调 kb_finish」 | 多 worker、单元重试 1 次、收尾轮 | 以本文 §4 替换该步；`buildParallelism=1` 保持原语义（仅新增重试） |
| §5 配置 `maxConcurrentProcesses`（实现硬顶 4、默认 2） | 范围与默认值 | 改为 1..6、默认 3；旧配置值保留不改写 |
| §7.1 工具表 | 新增 `raw_read_image`、`kb_unit_done`、`task_*`、`app_command` | 工具表增行；Build 行增 `kb_unit_done`；Discuss 行增 `raw_read_image`、`task_*`、`app_command(read)`；Work 行增其余 |
| D5 Work「第一阶段不提供 shell」 | R4 要求内部 Agent 调用 CLI | 不开 shell；以 `app_command` 提供同一命令面，D5 不变 |
| §9.6 agent-internal 仅接受运行令牌 | 新增 CLI 令牌 | CLI 令牌仅用于外部 `/api/*`，不进 agent-internal；两类令牌互不通用 |
| §17 一包一插件、运行期快照 | 编排资源进入内置包 | 作为新配置项，快照冻结到任务记录；不影响外部包管理 |
| §16 源状态以本地版本和 hash 为准 | 本地编辑改变 hash | 符合既有语义：编辑后源为 changed；快照条目增 `mediaHash` 不改 `contentHash` |

## 10. 交付切片

公共文件写入归属（仅归属切片可改，其他切片只追加各自标注区段）：`types/agent-knowledge.ts`、`types/index.ts`、`local-map-store.ts`（DDL+迁移数组）、`config-manager.ts`、`server/src/index.ts`（路由注册）→ **各切片在这些文件中只做追加式修改，合并顺序按依赖列**。`agent-tool-service.ts` 由 S1 改为工具族注册后，其余切片只新增工具族文件。

| 切片 | 目标 | 主要文件边界 | 依赖 | 冲突提示 | 验收（mock 优先） |
|---|---|---|---|---|---|
| **S0** 写能力实测 | 在真实应用上实测写 scope 接受性、append markdown 保真、overwrite 是否接受 markdown、`docs +fetch` revision 字段 | 仅报告 `agent-outputs/.../S0-*.md`；只用测试文档 | 无 | 无代码 | 每项给命令、原始输出、结论；给出 `WRITE_SCOPES` 与 `overwriteSupported` 定值 |
| **S1** 工具族注册 + 进程池准入 | `AgentToolService.registerToolFamily()`；池 `acquire` FIFO、后台配额、上限 1..6 | `agent-tool-service.ts`、`agent-process-pool.ts`、配置校验 | 无 | 基础切片，先合入 | 既有工具行为不变（全量 agent 测试）；acquire 排队/取消/配额/会话保留槽单测 |
| **S2** Vision 通道 | §3.1–3.2：VisionChannel、VisionDescriber、缓存、vision/test API、status 字段 | `agent/vision/*`、`prompts/image-describe.md`、`routes/agent.ts`（追加） | 无 | 与 S6 同改 `routes/agent.ts`（追加不同端点） | 三协议请求体断言（mock SDK）；不抛异常；缓存命中不调用；magic bytes；apiKey 不入日志 |
| **S3** 构建图片链 | §3.3–3.5：图片枚举、mediaHash、preflight 描述、raw_read 内联、`raw_read_image`、changes.images | `kb/source-images.ts`、`kb/raw-snapshot*`、`kb-build-service.ts`（preflight 段）、raw 工具族 | S1,S2 | 与 S4 同改 `kb-build-service.ts`：S3 只改 preflight，S4 改 running | 旧 manifest 无 mediaHash 不触发全量 changed；图片替换→changed；vision 关闭时 unavailable 标记+警告；路径逃逸丢弃 |
| **S4** 并行构建 | §4：单元划分、PathClaims、worker 调度、`kb_unit_done`、收尾轮、重试、取消句柄集、进度 DTO、kb_builds 列 | `kb/build-units.ts`、`kb/path-claims.ts`、`kb-build-service.ts`、kb 工具族、`routes/kb.ts` DTO | S1 | 见 S3 | planUnits 单测（连通分量、全量聚类、空单元）；假 pi 双 worker 写同路径被拒；单元失败→CURRENT 不动；取消终止全部进程；`buildParallelism=1` 既有构建测试全绿 |
| **S5** 构建 UI | §3.6、§4.6 UI：vision 设置段、并行数、worker/图片进度与警告 | `src/components/agent/*`、标准库面板、`src/api/client.ts` | S2,S3,S4（DTO） | 与 T2a 预览修复不同组件 | 组件测试 + 真机浏览器/Electron 交互验证截图并评审 |
| **S6** 任务编排后端 | §5：agent_tasks、TaskService、RoleRegistry、task_* 工具、任务 API、`task_update` SSE、配置项 | `agent/tasks/*`、`agent/roles/*.md`、`routes/agent.ts`（追加）、插件配置项、build-agent-assets | S1 | 见 S2 | 假 pi：DONE→done、BLOCKED→resume→done、缺 marker→nudge→failed、取消、重启→interrupted；工具交集、outputDir 重叠拒绝、子任务无 task_* |
| **S7** 任务编排 UI | 对话页「任务」区、作答、结果、编排开关 | `src/components/agent/*`（新组件） | S6 | 与 S5 不同组件 | 真机交互验证 |
| **S8** 命令表 + CLI 认证 | §6.2–6.3：CliEndpoint、cli-auth、`/api/cli/*`、审计、OPS_COMMANDS（仅既有路由命令） | `cli-endpoint.ts`、`middleware/cli-auth.ts`、`ops/command-table.ts`、`routes/cli.ts`、`index.ts` 中间件注册、electron 退出钩子 | 无 | 改 auth 中间件顺序：须保持 health 先注册、agent-internal 在 auth 前 | 令牌正确/错误/带 Origin/非回环；CLI 不能调 `/api/cli/enable` 与 agent-internal；文件权限 0600；关闭即删文件 |
| **S9** CLI 客户端与 shim | §6.1、§6.4：cli.cjs、输出/退出码、shim 安装、设置页「命令行」 | `server/src/cli/*`、`build-agent-assets.mjs`、设置页组件 | S8 | 与 S3/S6 同改 build-agent-assets（追加产物） | 对本地假 server 的命令端到端；`--json` 形状；退出码 0/1/2/3/4；打包后 `ELECTRON_RUN_AS_NODE` 冒烟 |
| **S10** `app_command` + 批准 | §6.5：工具、ApprovalService、批准 API、SSE、UI 批准卡片 | `agent/approvals/*`、ops 工具族、会话消息 UI | S1,S8 | 与 S7 同在对话页（不同组件） | read 直通；mutate 未批准不执行；模型传 confirm 被剔除；超时/拒绝错误；Discuss 不见 mutate 命令 |
| **S11** 源编辑 | §7.2–7.4：SourceEditService、SourceWriteLock、source_edits、edit/revert/状态 API、SyncEngine blocker、生命周期操作拒绝 | `sources/*`、`routes/sources.ts`、`sync-engine.ts`（blocker 与锁）、trash/cleanup/orphan 守卫 | 无 | 改 sync-engine.ts：与其他在飞切片协调 | header 字节不变 + parseMetadata 往返；baseHash 冲突；构建活跃拒绝；dirty 文档同步出 blocker 且不推进基线；revert 恢复；审计行 |
| **S12** 飞书写回 | §7.5–7.6：planPush、FeishuWriteService、LarkCliClient 写方法、push API、写 scope 授权、回拉 | `sources/push-planner.ts`、`sources/feishu-write-service.ts`、`lark-cli-client.ts`、`lark-cli-manager.ts`、`routes/feishu.ts` | S0,S11 | 改 lark-cli-client：只新增方法 | planPush 全分支单测；argv 断言（--command/--revision-id/--doc-format）；revision 冲突不重试且不推进基线；云端前进→409；成功→回拉→行删除；回拉失败→pushed；经 S0 测试文档真实冒烟一次 |
| **S13** 源编辑/写回 UI + CLI 命令登记 | 预览面板编辑、状态、写回预览与确认、设置「飞书写入」；命令表登记 `source.*`、`vision.test` | 预览面板组件、设置页、`ops/command-table.ts`（追加） | S11,S12,S9;须在 T2a 合入后 | 与 T2a 同改预览面板：串行 | 真机交互验证；CLI `source edit/push` 端到端（假 server） |
| **S14** 文档合并 | 将 §9 修订并入基线文档（§7.1 工具表、§8、§13）与 `docs/agent-knowledge.md` 使用说明 | 两份文档 | 对应功能切片合入 | 无 | 基线不变量 1 措辞替换为 §9.1；无悬空引用 |

并行组：`{S0, S1, S2, S8, S11}` 可同时开工 → `{S3, S4, S6, S9, S10, S12}` → `{S5, S7, S13}` → S14。S3 与 S4 同文件不同阶段，建议同一执行者顺序完成或先 S4 后 S3。

## 11. 未知项

| 未知 | 影响 | 判别办法 | 不可逆风险 |
|---|---|---|---|
| ~~写 scope 名是否被应用接受~~ **已定值（S0 D2）**：`docx:document:write_only` 整单接受+运行时验证 | — | — | 无（写 scope 不进默认集） |
| ~~overwrite 是否接受 markdown~~ **已定值（S0 D4）**：接受且语义保真；回拉导出与本地存在字节级转义非对称（需归一化层，S0 D3） | — | — | overwrite 会改写云端块结构：仅 `OVERWRITE_CLOUD` 确认后执行，飞书历史版本可回退；stale overwrite 静默损坏风险由三段式协议消除（U20） |
| 启用 LLM 整理的文档，本地正文与云端结构不同构 | overwrite 会把整理后的结构写入云端 | preview warnings 提示；S12 验证是否可识别整理标记 | 同上 |
| 视觉模型对飞书导出图片（截图/流程图）的识别质量与成本 | 标准库质量与费用 | S2 用真实样本图抽测（与生产资料分开记录） | 无 |
| vision 缓存无淘汰 | 磁盘增长 | 观察实际体量；后续按 LRU 或「未被任何快照引用」清理 | 无 |
| 并行构建的跨单元主题重复率 | 收尾轮负担 | S4 用真实模型 fixture 对比 parallelism=1/3 的文档数与重复主题 | 无（可退回 1） |
| Windows 下 endpoint.json 的 ACL | 同机其他用户可读令牌 | S8 在 Windows 实测默认继承权限 | 低（令牌可轮换/关闭） |
| 打包版 Electron 可执行文件以 `ELECTRON_RUN_AS_NODE` 运行 CLI 的启动耗时 | CLI 体验 | S9 冒烟计时 | 无 |

## 12. 验收（本升级整体）

1. vision 未配置：构建成功发布，构建记录含 `images_unavailable` 警告；配置后：含图源的标准文档引用图中信息，第二次构建命中缓存不再调用。
2. 升级后首次增量构建不因 `mediaHash` 引入而全量 changed。
3. `buildParallelism=3` 的全量构建：同时存在 3 个构建 pi 进程，交互会话仍可发起（M=4）；发布内容通过基线 §6.5 校验；取消后无残留进程、CURRENT 不动。
4. 会话内 Leader 派发 2 个 analyst 子任务并行完成；一个 BLOCKED 经用户作答后完成；子任务无法调用 `task_*`/`app_command`。
5. CLI：应用未开启命令行访问时退出码 3；开启后 `status --json`、`kb build`、`clean orphans --apply --yes`、`auth login` 可用；浏览器带 Origin 的请求被拒。
6. Work 会话请 Agent「重建标准库」：出现批准卡片，拒绝后未构建，批准后构建开始。
7. 编辑一篇同步 docx 并追加段落：同步列表出现 `local_edit_pending`，正式同步不覆盖；写回走 append，飞书可见新段落；回拉后状态清除，下一次检测不再报该文档 modified；全量重建索引后元数据不变。
8. 云端先被他人修改后写回：得到 `source_push_conflict`，云端未被改动。

## 13. 回滚与迁移

- 新增表 `agent_tasks`、`source_edits` 与 `kb_builds` 新列均为 additive，写入 `applyAdditiveMigrations()` 与 `getCreateTablesDDL()` 两处；旧版本应用忽略新列/新表。
- 新配置段（`agent.vision`、`standardKb.buildParallelism`、`cli`、`feishuWrite`、插件配置项 `orchestration`）缺省即关闭或等价旧行为。
- 逐项回退：`buildParallelism=1`；vision `enabled=false`；关闭编排配置项；关闭命令行访问（删端点文件）；`feishuWrite.enabled=false`。源编辑关闭后已有 `source_edits` 行仍阻断同步，需在 UI/CLI「放弃修改」或写回后解除——这是刻意的，防止回退后同步吞编辑。
- 已写回飞书的内容由飞书文档历史版本回退；本地备份 `<dataRoot>/source-edits/<objToken>/` 在回拉成功前保留。
