# Workflow：知识库构建 Agent 升级（双模型 / 并行编排 / CLI / 上传回飞书 / 预览修复）

- 创建：2026-10-27（Leader：天城）
- 分支：`feat/agent-knowledge-workbench`（HEAD 59a76fa，工作区干净）
- 自治级别：interactive（重大歧义与不可逆决策升级主上；安全默认推进其余）

## 1. 目标与总验收

| # | 需求（主上原文要点） | 可观察验收 |
|---|---|---|
| R1 | 图片/文本双模型配置（部分模型无多模态能力） | 设置页可为「文本模型」「图片理解模型」分别选择 provider/model；构建含图片源时图片内容经 vision 模型转描述进入构建；无 vision 模型时诚实报错/降级提示 |
| R2 | 多子 agent 并行知识库构建 | 一次构建分片派发 N 个并行子 agent 进程（受池上限），总耗时明显低于串行；进度/事件按分片可见；失败分片不影响已校验发布路径 |
| R3 | 参考 amagi-pi 实现 agent 编排插件（构建转化知识库） | 应用内置/可安装一个 Pi 原生插件包，提供编排工具（派发/查询/控制子任务），能驱动知识库构建转化任务 |
| R4 | 封装 CLI 供内部/外部 agent 操作应用 | CLI 可查应用状态、辅助 lark-cli 登录认证、清理知识库文件、调整设置等；内部 agent（工作台会话）与外部 agent 均可调用 |
| R5 | CLI 修改源知识库文件 + 上传有权限云文档回飞书 | CLI 可对源库 md 受控修改（保持 header/索引一致）；对有权限的云文档可将本地版本上传回飞书（写 API 或导入）；无权限/失败诚实报错 |
| R6 | 源知识库 md 预览渲染问题逐项修复 | 已知渲染缺陷逐项列出→逐项修复→每项有可复现样例与修复前后对照；新增用例入测试 |

总验收方式：`npm run check` 全绿 + 真机（dev:all/Electron）交互验证关键链路 + 高风险阶段 diting 审核通过。

## 2. 关键事实（侦察结论，2026-10-27）

- 工作台已有基础：`server/src/agent/`（RPC 进程池、会话、工具、插件管理 §17）、`server/src/kb/`（构建流水线、版本库）、`server/src/mcp/`。设计契约 `docs/design/agent-knowledge-design.md`（737 行）为真相源，本次为增量演进。
- 构建现状：`KbBuildService.runPipeline` 单 pi 进程内串行批（`for batchIndex`），`maxConcurrentProcesses` 默认 2。模型配置 `AgentModelConfig` 为单模型。
- `larkCliClient.api(method, apiPath)` 是通用 OpenAPI 透传（GET/POST）——写飞书文档的候选通道；lark-cli 命令面以读为主，写能力待调查（T0b）。
- `MarkdownView.tsx`（957 行）为自研零依赖渲染器——已知覆盖子集外的语法即缺陷来源（T0a 收集清单）。
- amagi-pi（参考项目）= Pi package：`extensions/amagi-core`（编排工具：task_submit/task_control 等 + agents-loader）+ `agents/*.md`（角色）+ skills/prompts。
- **本机无生产数据根**（`~/.feishu-sync` 不存在，`FEISHU_SYNC_HOME` 未设）：R6 真实渲染问题样本需主上提供（数据根路径或截图/样例文件）；代码层推断先行。
- 「原始库只读」是设计文档 §13 不变量 1；R5 的源库写通道是对该不变量的**受控扩展**，必须以显式设计增补形式落地（新通道、新校验），不允许绕过。

## 3. Phase 表

### Phase 0 调查（并行，无依赖）

| 任务 | 执行 | 输入 | 输出 artifact | 验收 | 状态 |
|---|---|---|---|---|---|
| T0a md 预览缺陷调查 | baize | `src/components/preview/MarkdownView.tsx`、`src/utils/html-table.ts`、`server/src/modules/media-reference.ts`、`server/src/modules/layout-reconstructor.ts`、sync-engine 产物 fixture | `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/T0a-markdown-preview-defects.md` | 缺陷清单逐项：语法结构/样例 md/当前渲染表现/根因定位/修复落点（文件:行）；另列「需主上真实样本确认」清单 | running（f6984df5） |
| T0b lark-cli 写能力调查 | baize | `server/src/modules/lark-cli-client.ts`、lark-cli 实际二进制（PATH 发现后 `--help` 实测）、飞书 OpenAPI 文档知识 | `T0b-lark-cli-write-capability.md` | 能力矩阵：md→docx 写回通道候选（import API / blocks 写 API / api() 透传）、权限模型、风险；附实测证据 | running（c725b166） |
| T0c amagi-pi 编排机制精读 | baize | `/Users/run.mao/workpace/amagi-pi`（extensions/amagi-core、agents、manifest、package.json pi 段） | `T0c-amagi-orchestration-mechanism.md` | 可复刻机制清单：编排工具注册方式、子任务生命周期（提交/控制/回执/接受）、角色定义格式、最小移植面 | done（9cb3d084，回执 ready） |
| T0d 构建/模型通道现状调查 | baize | `server/src/kb/kb-build-service.ts`、`server/src/agent/agent-process-pool.ts`、`pi-rpc-process.ts`、`provider-descriptor.ts`、`pi-extension/configured-models.js`、`app-plugin-store.ts`、routes | `T0d-build-parallelism-and-model-channels.md`（+part2） | 并行化改造点地图（staging 冲突面/状态模型/事件流）+ 双模型接入点（vision 工具落点、provider 注册）+ 插件工具注册面 | done（834b2b2e） |

### Phase 1 方向设计（依赖 T0b/T0c/T0d）

| 任务 | 执行 | 输入 | 输出 | 验收 | 状态 |
|---|---|---|---|---|---|
| T1 fuxi 方向设计 | fuxi(expert) | T0b/T0c/T0d 报告 + 设计文档 + 本 workflow | `docs/design/kb-agent-upgrade-design.md` | 五方向 U1-U21 结论级设计 + 切片表 S0-S14 + 不变量 1 修订 + 回滚方案 | done（2684fec4，accepted） |

### Phase 2 实现（依赖 T1 设计；R6 修复仅依赖 T0a）

| 任务 | 执行 | 输出 | 状态 |
|---|---|---|---|
| T2a-r md 预览渲染端修复（17 项） | luban | 代码+测试+`T2a-r-render-fixes.md` | done（f01af1ca，accepted；前端 160 tests 全绿） |
| T2a-p md 预览生成端修复（D3/D4） | luban | 代码+测试+`T2a-p-producer-fixes.md` | done（56dc7b1e，accepted；server 866 tests 全绿） |
| S0 写能力实测（飞书测试文档） | luban | `S0-write-probe.md` 实测报告 | **done**（静态+动态全部完成：7 项实测、测试文档已清理；D5 反例推动设计 U18-U21 修订已落地） |
| S1 工具族注册+进程池准入 | luban | 代码+测试 | done（accepted；集成 1001 绿） |
| S2 Vision 通道 | luban | 代码+测试 | done（accepted；集成 1001 绿） |
| S8 命令表+CLI 认证 | luban | 代码+测试 | done（accepted；集成 1001 绿） |
| S11 源编辑服务 | luban | 代码+测试 | done（accepted；集成 1001 绿） |
| S3+S4 并行构建+图片链（同文件合并单任务，先 S4 后 S3） | luban | 代码+测试 | done（accepted；集成 1150 绿） |
| S6 任务编排后端 / S9 CLI 客户端 / S10 app_command / S12 飞书写回 | luban | 代码+测试 | 全部 done（accepted；集成 1150 绿） |
| S5 构建 UI / S7 编排 UI / S13 源编辑写回 UI+CLI 登记 | luban | 代码+测试+真机验证 | S7 done（真机 6 截图）；S5 done（244b46e4，237 前端测试+真机 8 截图；其发现的 supportsImages 剥离已由 Leader 直修：config-manager 归一化保留字段+server types 追加，38 测试绿）；S13 运行中 |
| S14 文档合并 | luban | 基线文档修订 | done（817bb55d，accepted；7 类引用一致性检查全过） |

切片详情以 `docs/design/kb-agent-upgrade-design.md` §10 为准（文件边界/依赖/冲突/验收均在其内）。公共文件（types/agent-knowledge.ts、types/index.ts、local-map-store.ts、config-manager.ts、server/src/index.ts）只允许追加式修改。并行组：{S0,S1,S2,S8,S11} → {S3,S4,S6,S9,S10,S12} → {S5,S7,S13} → S14。

### Phase 3 集成验证与审核

| 任务 | 执行 | 验收 | 状态 |
|---|---|---|---|
| T3a 端到端集成验证 | Leader/luban | 真机入口逐项：双模型构建含图片源、并行构建进度、编排插件驱动构建、CLI 全命令面、源库修改+上传（有权限文档）、预览修复前后对照 | **大体完成**（2026-10-27 Leader 实测：①CLI 开启→endpoint.json 0700/0600→shim→全命令面真实调用+退出码矩阵 4/2✓；②R5 完整链路真实云端验证：构造真实测试文档→edit(OCC)→dirty→preview(write_disabled 引导/overwrite+conflict 判定)→无确认 422→`--allow-overwrite --force --yes` 三段式 overwrite→云端回读追加段/`<sheet>` 字面保留/管道方括号保真→回拉 synced+清行→清理无残留✓；③认证断链修复真机验证✓；④S5/S7/S13 真机浏览器含 26 截图✓。受本机无生产数据根限制：真实并行构建/编排真实模型端到端/vision 真实识图——留主上真机环境使用时验证，已列入收口清单） |
| T3b diting 高风险合并审核 | diting(full) | R5 写通道/R2 并行发布路径/安全边界 diff 一次合并审核，VERDICT=PASS | running（07112497） |
| T3c 收口 | Leader | 总验收矩阵 met/partial/missed | pending |

## 4. 跨边界链路清单（初始，T1 后细化）

| 链路 | 谁→谁 | 关键状态/失败路径 | 责任 |
|---|---|---|---|
| 构建分片→并行子进程→staging 合并→发布 | KbBuildService→pool→AgentToolService | 任一分片失败整体不发布；staging 隔离防互写 | 实现切片 + Leader 集成 |
| vision 工具→vision provider | AgentToolService→direct OpenAI 兼容端点 | 无 key/模型未配→工具报错非崩溃；降级提示 | 实现切片 |
| CLI→应用 HTTP API | CLI 进程→Hono server | 应用未运行→清晰报错+引导；desktop token 获取通道 | 实现切片 |
| CLI→源库写→上传飞书 | CLI→server 新写通道→lark-cli api | 权限不足/冲突→诚实报错；header/索引一致性 | 实现切片 + diting 审 |
| 编排插件→子任务派发→构建 | Pi 插件扩展→server | 与手动构建互斥（409）；回执/取消 | 实现切片 |

## 5. 并行与隔离

- Phase 0 四调查无共享写入，一批并行。
- R6 预览修复（T2a）与 T1 设计并行。
- Phase 2 中同目录（`server/src/agent|kb`、`server/src/types`）冲突切片：worktree 隔离或按 T1 依赖串行；CLI 目录独立可并行。

## 6. 专家 Gate

- fuxi 设计态一次（T1）：无可复用方向 + 跨五需求重大取舍，符合调用条件。
- diting full 一次（T3b）：R5 打破只读不变量 + R2 并行发布路径，高风险阶段标记。
- 不按叶子复制审核。

## 7. 风险、决策与修订日志

- 2026-10-27 侦察：本机无 `~/.feishu-sync`。R6 真实样本来源缺口：T0a 先代码层推断，样本清单回流后向主上索取（数据根路径或样例）；若主上提供数据根路径，用临时 FEISHU_SYNC_HOME 只读扫描。→ T0a 已列 10 项待样本清单（报告 §⑤）；T2a 已修 17+2 项可代码确认项。
- R5 与 §13 不变量 1 冲突：处理为「显式设计增补 + 受控新通道」，禁止绕过 SyncEngine 之外的静默写。T1 必须给出不变量 1 的修订表述。→ fuxi §9.1 已给出修订（「只有登记在的受控写入方可写入」+ 新增两条），S11/S12/S14 落地。
- 主上在会话中途提交了 59a76fa（多协议模型配置）——Phase 0 输入基线以 59a76fa 为准。
- 2026-10-27 派发纪律修正：首次派 luban 未带 shell 通道致无法自验，已取消重派为 guarded；后续实现切片一律 guarded shell。
- **应用内认证断链修复（Leader 直修）**：lark-cli 1.0.97 的 `config init --new` 输出改为「QR 点阵 + `open.feishu.cn/page/cli?user_code=` URL」，旧正则永不命中 → 90s 超时挂死。已修 `CONFIG_INIT_URL_RE` 兼容双形态+补测试（63 绿）+真机验证秒回 URL。主上已走应用内两步流程完成认证（config init + device 扫码），S0 认证前置解决。
- **S0 重大发现（D5）**：飞书 revision OCC 只防未来值，旧 revision 静默接受且 stale overwrite 造成正文重复损坏——设计 U20 已修订为三段式协议（fetch→立即写→写后回读校验），U18/U19/U21/§7.5/§11 同步定稿。S12 按修订版实现。
- 第一批集成验证：server 78 files/1001 tests + 前端 160 tests + 三段 typecheck 全绿（S1+S2+S8+S11+认证修复+T2a 合并态）。
- T2a 两切片验收：Leader 代跑合并后全量（前端 160 / server 定向 56 + 全量 866）全绿、typecheck 通过后 accept（自动基线检查因 vitest 探测形态不可用，waive 并以亲验替代）。
