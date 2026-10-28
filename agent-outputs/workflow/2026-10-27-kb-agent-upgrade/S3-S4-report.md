# S3+S4 报告：并行构建（流水线内）+ 构建图片链

任务书：S3+S4 切片（先 S4 后 S3，单任务顺序完成）。上游输入：`docs/design/kb-agent-upgrade-design.md` §3/§4、`S1-report.md`（工具族注册 + `pool.acquire('background')`）、`S2-report.md`（VisionDescriber/describeMany）、`server/src/kb/kb-build-service.ts`（基线）。

## 一、改动清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `server/src/kb/build-units.ts` | 新增 | `planUnits()` 纯函数 + `BuildUnit` + `directoryClusterKey()` |
| `server/src/kb/path-claims.ts` | 新增 | `PathClaims`（首写者认领，单元重试不释放） |
| `server/src/kb/source-images.ts` | 新增 | 图片引用提取/围栏解析/mediaHash/`inlineImageBlocks`/`enrichEntriesWithMedia`/`verifyEntryMediaHash` |
| `server/src/kb/kb-build-service.ts` | 独占写面·重构 | preflight 媒体增强+预描述；W≥2 单元化并行路径（worker 拉取 LPT、`kb_unit_done`、收尾轮、重试、取消句柄集、`kb_unit_failed` 包装）；W=1 保留既有单进程路径（等价回退，见 §五-1）；进度 DTO 扩展；`computeChangeset(+visionEnabled)`；`verifySnapshotIntact` mediaHash 复核；覆盖检查 skipped 并集 |
| `server/src/agent/agent-tool-service.ts` | 追加 | `BuildRunState` + units/unitDone/claims/imageDescriptions/visionReady；`RunContextOptions.worker`；`VisionDescriberLike` 可选注入；kb 族 + `kb_unit_done`；raw 族 + `raw_read_image`；kb_write/delete 路径认领、kb_finish phase 门、raw_list 单元过滤、raw_read 内联描述（构建+会话） |
| `server/src/agent/tool-specs.ts` | 追加 | `KB_UNIT_DONE_SPEC`、`RAW_READ_IMAGE_SPEC` |
| `server/src/types/agent-knowledge.ts` | 追加 | `RawSourceSnapshotEntry.mediaHash/imageCount`、`StandardKbConfig.buildParallelism`（默认 2）、`KbBuildProgressDto` 族类型、`KbBuildDto.progress/parallelism/warnings`、TOOLS 常量（BUILD + `kb_unit_done`；DISCUSS/WORK + `raw_read_image`，S1 报告 §四提醒已同步） |
| `server/src/modules/config-manager.ts` | 追加 | `buildParallelism` 宽容归一（1..6）+ 严格校验 |
| `server/src/modules/local-map-store.ts` | 追加 | `kb_builds` 4 新列（DDL + PRAGMA 守卫 ALTER 双登记）、`updateKbBuild` 新字段 |
| `server/src/routes/kb.ts` | 追加 | `/api/kb/changes` 增 `images: { total, uncached }`（待处理源图片计数 + 当前模型缓存探测） |
| `server/src/index.ts` | 追加 | 共享 `VisionDescriber` 注入 AgentToolService + KbBuildService |
| `server/src/agent/prompts/standard-kb-build.md` | 修订 | 工具清单与工作方式改为单元语义（kb_unit_done / 收尾轮 / image_description 不可信说明） |
| `server/tests/` 新增 ×4 | 新增 | `kb-build-units.test.ts`(7)、`kb-path-claims.test.ts`(3)、`kb-source-images.test.ts`(6)、`kb-build-parallel.test.ts`(11) |
| `server/tests/` 同步 ×2 | 锚定同步 | `agent-tool-families.test.ts`（冻结基线 +2 工具名）、`agent-internal-auth.test.ts`（discuss 规格 4→5） |

## 二、并行结构（S4 §4.1）

```
preflight（DB status='preflight'）
 ├─ stage=snapshot            快照 + mediaHash/imageCount 增强（全部条目）
 ├─ changeset                 contentHash ∨(vision 启用∧双方 mediaHash 非空且不等)
 └─ stage=describing_images   工作集源图片枚举 → vision ready ? describeMany（缓存命中不调远端）
                              : 全部 unavailable(vision_unconfigured)（U5 不阻断）
running（DB status='running'）
 ├─ planUnits（纯函数）→ units[]（LPT 序：bytes 降序）
 ├─ W = max(1, min(buildParallelism, 单元数, 池后台配额 M−1)))
 ├─ W=1 → 等价回退：既有单进程流水线（全局批切分 + kb_finish 单轮，spawnBuildProcess 接缝保留）
 └─ W≥2 → 单元化并行：
     worker_i（pool.acquire('background') FIFO → spawnWorkerProcess，key=build:<id>:w<i>）
       循环：pull 下一单元 → 单元内批次串行 prompt → 末批 kb_unit_done（缺则一次纠正，仍缺=单元失败）
             可重试错误（model_timeout/model_request_failed/pi_process_exited）自动重试 1 次
             （新进程从首个未完成批次续跑；PathClaims 认领不释放）
     join：任一单元最终失败 → 中止全部 worker → failed(kb_unit_failed{unitId,cause})，CURRENT 不动
     收尾轮（stage=finishing）：复用最后存活 worker（context phase→final）否则 acquire('build-final')
             新拉进程 → 单元摘要 + 跨单元文档清单 → 允许合并 → kb_finish（单值）
validating → publishing（不变：聚合状态校验 + CURRENT 原子切换；verifySnapshotIntact 复核 mediaHash）
```

- 毒化（F3-R08）：共享 `state.poisoned`，worker 批次边界检测 → 协调器中止全部。
- 取消/整体超时：`entry.cancelController`（abort 全部排队 acquire）+ `entry.workers` 进程 abort 集；`finally` 逐个 `pool.terminate`。
- 首槽位 deadline：`buildTimeoutMinutes` 内拿不到首个槽位 → `failed(agent_busy)`（§4.5）。

## 三、单元划分算法（§4.2）

- **incremental**：`文档↔源(workset∪removed)` 二部图并查集。受影响文档（sources ∩ 图源非空或 requiredRewrites）把其图内源 union 成同一分量；分量含 ≥1 工作集源 → 一个单元；仍在 staging 的分量文档路径进 `ownedDocs`（预认领进 PathClaims）；仅引用已删除源的文档标 `deletedByDefault`（提示可重建，不预认领）。大分量不拆。**纯删除增量**（无工作集源）保底一个空单元（batches=[[]]，对应现状保底空批）。
- **full**：relPath 一级目录聚类（`_custom/<文件夹>` 视为一级；根文件归 `(root)` 键），目录内按 relPath 排序，每 `batchSize×3` 源切一单元；ownedDocs 为空。
- 单元 id（u1、u2…按首源序稳定）；返回序 bytes 降序（LPT 拉取）；单元内批次 = chunk(sources, batchSize)。
- 认领：`kb_write_doc`/`kb_delete_doc` 在 unit 轮先 `claims.claim(path, unitId)`；他单元路径 → 工具错误 `kb_path_owned_by_other_unit`（消息含所属文档标题与持有单元及其源）；final 轮不受限。

## 四、mediaHash 兼容性证据（U4/验收 2）

1. `contentHash` 公式零改动（`computeSourceHash` 未动）；mediaHash 是新增独立字段。
2. 变更判定（`computeChangeset(current, base, {visionEnabled})`）只在 **双方 mediaHash 均非空且不等** 时叠加 changed；旧 manifest 条目无 mediaHash → 条件恒假 → **升级后首次增量不触发全量 changed**。测试锚定：`kb-build-parallel.test.ts › mediaHash 兼容`（旧 manifest vs 升级条目 isEmpty=true；双方有且不等 + vision 启用 → changed；vision 关闭 → 不变）。
3. `verifySnapshotIntact` 对有 mediaHash 的源同步复核图片字节（`verifyEntryMediaHash`），构建中图片被替换 → `source_changed_during_build`（单测覆盖图片替换前后复核翻转）。
4. `enrichEntriesWithMedia` 对全部快照条目就地补充（preflight 一次本地读，无需远端）；缺失图片以 `missing:<name>` 占位参与哈希（图片消失=变更）。

## 五、S5 UI 契约（DTO/进度/SSE/配置）

### KbBuildDto（`/api/kb/builds*`）
```ts
progress: {
  batchIndex: number; batchTotal: number;      // 兼容字段：已完成批次 / 全部批次+1（收尾轮）
  stage: 'snapshot'|'describing_images'|'units'|'finishing'|'validating'|'publishing'|null;
  units:   { total; done; running; failed; retried };
  workers: Array<{ workerId; state: 'waiting_slot'|'running'|'finishing'|'exited';
                   unitId: string|null; unitBatchIndex; unitBatchTotal }>;
  images:  { total; described; cached; unavailable };
}
parallelism: number;                            // 实际生效并行度（1=等价回退）
warnings: Array<{ code: string; count: number; message: string }>;  // 如 images_unavailable
```
- 无活跃 entry 时 progress 为零值结构（stage=null、workers=[]）。

### SSE（`/api/kb/builds/:id/events`，seq 机制不变）
- `tool` / 单元级 `build_log` data 增可选 `workerId`、`unitId`。
- 新事件 `build_worker`（data=单个 worker 进度项，同 progress.workers 元素）。
- 新事件 `build_units`（data=`{total,done,running,failed,retried}`，单元计数变化时刷新）。
- `build_status` 仍随 DB 状态切换推送完整 DTO。

### 其他
- `GET /api/kb/changes` → 响应增 `images: { total: number; uncached: number }`（待处理源引用图片数 / 未命中当前模型缓存数；vision 未启用时 uncached=total）。`GET /api/kb/status` 的 `pending` 维持源计数（设计 §3.6 只指定 changes 增维）。
- 配置：`standardKb.buildParallelism`（1..6，默认 2；PUT /api/config 越界报 `invalid_config{field:'standardKb.buildParallelism'}`）。UI 提示受 `agent.maxConcurrentProcesses` 后台配额（M−1）约束。
- `raw_read_image` 工具（Discuss/Work）：`{objToken, src}` → `<untrusted_image_description>` 包裹描述文本；vision 未就绪 → 工具错误 `vision_unconfigured`；src 不属于该源 → `invalid_request`。

## 六、偏差（与设计稿字面差异）

1. **`buildParallelism=1` 走"既有单进程路径"而非"单 worker 跑单元"**。设计 §4.1 说"退化为单 worker + 同进程收尾，行为与现状等价"；任务约束要求既有 kb 构建测试（kb-version/provider-protocol-live 等，它们以 `Object.assign(service,{spawnBuildProcess})` 注入假模型并依赖旧提示词序列）**不改动全绿**——因此 W=1 分支逐字保留旧流水线（全局批切分 + kb_finish 单轮 + `spawnBuildProcess` 测试接缝），单元语义（kb_unit_done/认领/单元重试）只在 W≥2 生效。切换 1↔2 会改变提示词形态，这是回退开关的既有语义。
2. `computeMediaHash(items: Array<{src,file}>)` 而非设计的 `files: string[]`——"按 src 排序"需要 src 键。
3. `describeMany` 以 `<objToken>::<src>` 组合键传入再拆回——S2 的结果 Map 以 src 为键，跨源同名 src 会互相覆盖；缓存写入按图片字节 hash 不受影响。
4. `describing_images` 不落 DB status（`kb_builds.status` 的 CHECK 约束无法 additive 修改）——细粒度 stage 只存在于 progress DTO；DB status 仍为 preflight/running/…粗粒度集合。
5. worker 进程跨单元复用：同一 token 的 run context 以可变 `options.worker` 跟随单元切换/收尾轮（不按单元换进程；仅失败重试时换新进程），实现 §4.4 的 BuildRunContext 语义。
6. 会话侧 raw_read 只在 vision `ready` 时内联（disabled 时不插 not_desclared 噪声块）；构建侧 U5 语义不变（未配置也插 unavailable 标记 + 警告）。
7. `buildParallelism` 配置默认 2（设计 §4.6）；运行时 `?? 1` 兜底（旧对象字面量/未归一配置 → 1）。

## 七、验证证据

| 项 | 命令（cwd=server） | 结果 |
|---|---|---|
| 新增单测 | `npx vitest run tests/kb-build-units.test.ts tests/kb-path-claims.test.ts tests/kb-source-images.test.ts tests/kb-build-parallel.test.ts` | 27/27 ✅ |
| server 全量 | `npm test` | **89 files / 1150 tests 全绿**（含 kb-version 21、provider-protocol-live 3、kb-build 24 等既有构建面不改动全绿） |
| typecheck | `npm run typecheck`（root+node+server 三段） | exit 0 |
| 前端全量 | 根目录 `npm test` | 20 files 全绿 |
| eslint | 涉改 15 文件 | 0 error 0 warning |
| 关键行为 | 假 pi（processFactory 接缝，工具走真实 AgentToolService） | 等价回退发布 ✅；双 worker 他单元预认领路径 409 `kb_path_owned_by_other_unit`（消息含标题+持有单元）且构建仍发布 ✅；单元失败重试仍败 → `failed(kb_unit_failed)` CURRENT 不动 ✅；model_timeout 一次性失败自动重试发布（≥3 进程）✅；取消 → 全部假进程 abort/terminate、cancelled、CURRENT 不动 ✅；vision 关闭 → raw_read 内联 `reason="vision_unconfigured"` + `images_unavailable` 警告落库 + manifest 条目带 mediaHash/imageCount ✅；旧库 kb_builds ALTER 补列默认值可用 ✅ |

假 pi 全部经 `processFactory` 测试接缝注入（不真实调模型）；vision 相关用结构化 mock describer（S2 mock 模式）；未触真实远端。

## 八、未覆盖 / 风险

- **真实多进程 pi 并行构建未实测**（真模型 fixture 对比 parallelism=1/3 的文档数与重复主题属设计 §11 未知项）；假 pi 覆盖调度/认领/失败/取消逻辑本身。
- vision ready 的构建链（describeMany 真实路径 + raw_read 内联 described 文本）在单测中以 mock describer 验证接口契约；真实远端模型质量依赖 S2 的用户显式 test。
- `buildParallelism` 的 PUT 严格校验分支未单独断言（归一路径已由既有 agent-config 兼容测试覆盖主链路）。
- `/api/kb/changes` 的 images 维度未独立路由测试（经 kb-version 全量 /changes 调用冒烟，未破坏既有形状）。
- 共享树并行切片在途：本切片涉改公共文件均为追加式；`git status` 中 session-service/app-plugin-store/routes/feishu 等改动属兄弟切片，未纳入本报告。

## 九、回滚

- 运行时回退：`standardKb.buildParallelism=1` → 既有单进程构建（等价旧行为）；`agent.vision.enabled=false` → 构建不再调远端（图片处仍插 unavailable 标记，属 U5 既定语义）。
- 代码回滚：revert `server/src/kb/kb-build-service.ts`、`agent-tool-service.ts`、`tool-specs.ts`、`types/agent-knowledge.ts`、`config-manager.ts`、`local-map-store.ts`、`routes/kb.ts`、`index.ts`、`prompts/standard-kb-build.md` 九文件的 S3/S4 段，删除 `kb/source-images.ts`、`kb/build-units.ts`、`kb/path-claims.ts` 与 4 个新测试；注意 `types/agent-knowledge.ts`/`agent-tool-service.ts`/`index.ts`/`config-manager.ts` 含兄弟切片在途改动，整文件回滚需在合并窗口协调（逐段反向恢复见 §一）。
- 数据无迁移风险：kb_builds 新列 additive（旧代码忽略）；config 新字段旧版本下次保存时丢弃；vision 缓存目录独立可整目录删除。
