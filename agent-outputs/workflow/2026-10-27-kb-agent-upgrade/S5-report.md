# S5 报告：构建 UI（vision 设置段 + 并行数 + worker/图片进度与警告）

任务书：S5 切片（设计 §3.6 / §4.6 UI 部分）。上游：`S2-report.md`（vision status/test 契约）、`S3-S4-report.md`（progress DTO / 警告 / changes images 维度）。写面：`src/components/kb/**`、`AgentSettingsCard*`、client/types/agentReadiness 追加、前端测试；未触碰对话页组件、DocPreviewPanel、设置页其余卡片、KnowledgeView/SettingsView（新段全部挂在既有卡片内，无 tab 级登记变更）。

## 一、改动清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/types/agent.ts` | 追加 | `AgentVisionConfig`、`AgentConfig.vision?`、`StandardKbConfig.buildParallelism`、`AgentVisionStatusDto`/`AgentVisionTestResult`、`KbBuildStage/Units/WorkerState/WorkerProgress/ImagesProgress/ProgressDto/Warning`、`KbBuildDto.progress→KbBuildProgressDto` + `parallelism` + `warnings`、`KbBuildEvent` 增 `build_worker`/`build_units` 与 `tool/build_log/assistant_delta` 的可选 `workerId/unitId` |
| `src/utils/agentReadiness.ts` | 追加 | `KB_BUILD_STAGE_LABEL`、`KB_BUILD_WORKER_STATE_LABEL`、`KB_BUILD_WARNING_LABEL` |
| `src/api/client.ts` | 追加 | `getAgentVisionStatus()`、`testAgentVision({providerId?,modelId?}={})`（timeoutMs 620s，不早于服务端 vision.timeoutMs 上限截断） |
| `src/types/kb-version.ts` | 追加 | `KbChangePreview.images?: { total; uncached }`（可选防御旧服务端） |
| `src/components/agent/AgentSettingsCard.tsx` | 追加段 | ①运行时卡「图片理解」段：启用开关（存 `agent.vision.enabled`）、识图提供商/模型下拉（`supportsImages===true` 标「支持图片」、`===false` 置灰+「不支持图片」、未标注不置灰）、状态行（badge + `describeVisionStatus`，含缓存计数）、「测试识图」按钮（显式覆盖允许启用前试测）+ 结果展示（ok→模型/时延/样例前 200 字；fail→脱敏错误）；②标准库卡「构建并行数」1..6 下拉（选择即保存，提示后台配额约束）；`saveAgent` patch 增 `vision`，基座合并保留既有 vision；`saveOutputRoot` 基座补 `buildParallelism`。导出纯函数 `canTestVision`/`describeVisionStatus`/`describeVisionTestResult`/`DEFAULT_VISION_CONFIG` |
| `src/components/kb/KbBuildPanel.tsx` | 追加 | 面板内 2.5s `getKbBuild` 轮询（仅非终态；父层 SSE 终态优先，轮询失败静默保持上一帧）；头部细粒度 stage 徽标 + `并行 N`；「并行进度」条：单元 done/total 进度条（进行/重试/失败计数）+ worker 徽标列表（workerId·单元·批 x/y·状态）+ 图片行（已理解 described+cached / total（缓存 N · M 张未理解））；`warnings` 块（`images_unavailable` 追加「设置 → Agent 运行时与模型 → 图片理解」引导，发布成功仍展示） |
| `src/components/kb/KbChangesPanel.tsx` | 追加 | 待更新差异页顶部 `KbPendingImagesHint`（total/uncached 计数 + 未启用时「未理解」标记提示与设置引导；total=0 不渲染）；组件导出供单测 |
| 新增测试 ×3 | 新增 | `KbBuildPanel.test.tsx`(10)、`AgentSettingsCard.test.tsx`(11)、`KbChangesPanel.test.tsx`(4)，共 25 用例（SSR markup + 纯函数锚定，沿用 ApprovalCard/CliAccessSettingsCard 模式） |

**设计偏差（有据）**：进度实时化用面板内轮询而非 SSE `build_worker/build_units` 消费——KnowledgeView（SSE 消费方）不在本切片写面；`build_status` 只在 DB status 切换时携带完整 DTO，running 内推进的 worker/单元计数无事件到达面板，轮询是写面内唯一闭环方案。事件类型已进 `KbBuildEvent` 联合，S7/KnowledgeView 后续可直接消费（届时轮询可撤）。

## 二、契约对照表（S2/S3-S4 报告 ↔ 本切片消费）

| 契约（来源） | 服务端实测 | 前端消费点 |
|---|---|---|
| `GET /api/agent/vision/status → {enabled,state,provider,model,message,cachedCount}`（S2 §四） | `{"enabled":false,"state":"disabled","provider":null,"model":null,"message":"图片理解未启用","cachedCount":0}`；启用后 `state:"ready"` + model + cachedCount | 设置段状态行 |
| `POST /api/agent/vision/test {providerId?,modelId?}`：未启用无覆盖→400 `vision_unconfigured`；失败回 200 `{ok:false,error}`（S2 §四） | 空 body → `{"error":"vision_unconfigured",...}`；假端点 → 200 `{"ok":false,...,"error":{code:"vision_failed",message:"VisionChannel: SDK call failed - Connection error."}}` | 测试按钮（结果/错误展示；400 经 catch 转 `{ok:false,error}` 展示） |
| `KbBuildDto.progress`（batchIndex/batchTotal/stage/units/workers/images）+ `parallelism` + `warnings[{code,count,message}]`（S3-S4 §五） | seed 行经 `GET /api/kb/builds/:id` 原样返回（warnings_json 解析、parallelism 默认 1） | KbBuildPanel 并行条/警告块 |
| `GET /api/kb/changes` 增 `images:{total,uncached}`（S3-S4 §五） | `{"baseReleaseId":null,"sources":[],...,"images":{"total":0,"uncached":0}}` | KbPendingImagesHint |
| `agent.vision` 配置（PUT /api/config；enabled 时引用校验 400 invalid_config）（S2 §四） | PUT providers 成功；vision.enabled 开关保存成功 | 开关/下拉保存链 |
| `standardKb.buildParallelism` 1..6（S3-S4 §五） | PUT 后 GET 回读 `buildParallelism=4` | 构建并行数下拉 |
| SSE `build_worker`/`build_units`/`tool.build_log+workerId,unitId`（S3-S4 §五） | 服务端按 buildId 推送（本切片未消费，类型已登记） | `KbBuildEvent` 联合类型 |

## 三、真机浏览器验证（agent-browser，隔离环境）

环境：`FEISHU_SYNC_HOME=/tmp/s5-fshome-32374`（一次性目录，隔离 SQLite/config）、server standalone :3191（`FEISHU_SYNC_PORT`，`FEISHU_SYNC_DEV_TOKEN` 固定）、vite :5175（`BACKEND_PORT=3191`，proxy 注入 token）。种子：config 假 provider（vp，端点 127.0.0.1:59999 不可达）+ 三预设（supportsImages true/false/未标注）；kb_builds 两行（published+warnings_json、running+parallelism=2）——**均注入在隔离临时 DB，非生产资料**。

| # | 操作序列 | 证据 |
|---|---|---|
| 1 | 设置 → Agent 标准库 → 运行时与模型：vision 段渲染（开关未勾、下拉、测试按钮、发送端点提示） | `01-agent-tab-overview.png` |
| 2 | 勾选「启用图片理解」→ 状态行刷新「就绪（badge）· 图片描述通道可用 · glm-4-fake · 已缓存图片描述 0 条」 | `02-vision-enabled.png`；eval 实测 toggle=true |
| 3 | 点「测试识图」→ 真实远端调用（假端点连接拒绝）→「测试失败（vision_failed）：VisionChannel: SDK call failed - Connection error.」 | `03-vision-test-result.png` |
| 4 | Agent 标准库 → 标准库与 Workspace：「构建并行数」1..6（1 路=单进程回退标注、当前 2）；改为 4 → PUT /api/config → GET 回读 **buildParallelism=4** | `04/05-build-parallelism*.png`；curl 回读 |
| 5 | 标准库视图 → 构建侧栏：seed published 构建（真实 API）→ 警告块「图片未理解：3/8 张图片未理解…可在「设置 → Agent 运行时与模型 → 图片理解」…」+ 写入 6 篇/删除 1 篇 | `06/07-*.png`；panel.textContent 实测 |
| 6 | seed running 构建（reload 后接管）→ 面板「生成中 + 并行 2 + 取消构建」，面板内轮询实测 6 次请求 **间隔恒 2501ms**（performance entries 14636→27137） | `08-build-panel-running-poll.png` |
| 7 | `/api/kb/changes` 空库 images={0,0} → 待更新差异页提示不渲染（零态） | `06-kb-view.png`；curl 实测 |

已知缺口（真机可见）：**识图模型下拉的「支持图片/不支持图片」标记未显示**——根因不在本切片 UI：服务端 `config-manager.normalizeModelPresets`（server/src/modules/config-manager.ts:594）白名单重建 preset 时丢弃 `supportsImages` 字段（S2 只在前端 `src/types/index.ts` 加了该字段，server/src/types/index.ts 的 `LlmModelPreset` 与归一化均无），GET /api/config 已实测剥离。组件测试证明字段存在时标记/置灰正确。

**写面外最小修复请求（供 Leader 批准或转 S2 补丁）**：
1. `server/src/types/index.ts` `LlmModelPreset` 追加 `supportsImages?: boolean;`（注释：仅 UI 提示）
2. `server/src/modules/config-manager.ts` `normalizeModelPresets` 的 `presets.push({...})` 内追加一行 `...(typeof raw.supportsImages === 'boolean' ? { supportsImages: raw.supportsImages } : {}),`
两处均 additive；修复后设置页标记即全链路生效，无需前端改动。

## 四、验证证据

| 项 | 命令（cwd=根） | 结果 |
|---|---|---|
| 新增组件测试 | `npx vitest run src/components/kb src/components/agent/AgentSettingsCard.test.tsx` | 3 files / 25 tests ✅ |
| 前端全量 | `npm test` | **27 files / 237 tests 全绿**（早一轮 sibling 的 client.test.ts scopeSet 失败已由兄弟切片修复，非本切片回归） |
| typecheck | `npm run typecheck`（root+node+server 三段） | exit 0 |
| server typecheck | `cd server && npm run typecheck` | exit 0（本切片未动 server） |
| eslint | 涉改 10 文件 | 0 error 0 warning |
| 真机浏览器 | agent-browser（见 §三） | 8 截图 + eval/curl 实测 |

## 五、未覆盖 / 风险

- **真实多 worker 并行构建的运行画面未实测**（需真实 pi + 真实模型额度）：worker 徽标/单元进度/图片计数的运行态渲染由组件测试锚定（fixtures 与 `progressOf()` 零值结构对齐）；真机覆盖到 running 态接管 + 轮询 + published 警告态。首次真实并行构建时建议人工复核一眼。
- **supportsImages 服务端剥离**（见 §三修复请求）：修复前标记在真实配置下不出现（未标注预设仍可选，不误伤可用性——置灰只在显式 false 时）。
- SSE `build_worker/build_units` 前端未消费（KnowledgeView 写面外）；当前由面板轮询兜底实时性，代价是构建期间每 2.5s 一次轻量 GET（仅面板打开且非终态时）。
- 「测试识图」成功路径（ok:true + sample 展示）未真实触发（无真实远端凭据；任务书约束真实调用由用户显式触发）——失败路径真实覆盖，成功路径由纯函数测试锚定。
- 视觉/审美复核：截图已留存但未做视觉评审（属洛神职责），本报告只做行为与渲染存在性验证。

## 六、回滚

全部 additive，无数据迁移/无契约破坏（`KbBuildDto.progress` 旧两字段保留在新结构内；`KbChangePreview.images` 可选；`vision` 可选）。回滚 = revert `KbBuildPanel.tsx`/`KbChangesPanel.tsx`/`AgentSettingsCard.tsx` 三个组件的追加段 + `client.ts`/`types/agent.ts`/`types/kb-version.ts`/`agentReadiness.ts` 追加段，删除 3 个新测试文件。注意 `client.ts`/`types/agent.ts` 含兄弟切片在途改动（AgentTaskDto 等），整文件回滚需合并窗口协调，逐段反向恢复按 §一清单。
