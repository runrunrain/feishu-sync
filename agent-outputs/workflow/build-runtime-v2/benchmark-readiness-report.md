# 六源对照（设计 §13.3）基准可复跑性核查报告

- 任务性质：独立只读核查（不改代码、不跑模型、不提交、不触飞书远程）。
- 上游输入：设计 `…/编排构建效率优化/重构/基于Agent基座与工作流插件的构建重构设计-v2.md` §13；指标证据 `…/编排构建效率优化/构建耗时证据.json`。
- 核查时间：2026-11-01（主树 HEAD `5f39dd8`，含未提交 R/E 后续批次改动）。
- 纪律声明：只读取证；未查询生产 SQLite 内容、未输出任何密钥值（仅 hasKey 布尔）、未复制生产正文；生产 release/CURRENT 指针未触碰。

## 0. 结论索引

| # | 主张 | 三态 | 锚点（摘录见正文） | 适用边界 |
|---|---|---|---|---|
| C1 | 基准构建证据链（buildId→checkpoint→events→release）完整且哈希可验 | 观察 | 证据 json；events.jsonl sha256 实测一致 | 本机生产数据根；事件配对局限沿证据 interpretationLimits |
| C2 | 冻结 snapshot 元数据（6 源 hash）可获得 | 观察 | checkpoints/cp_2dff28…/state.json `.snapshot[]` | 仅元数据；不含源字节 |
| C3 | 六源中 4 源字节级可复得；2 源（均为 sheet）冻结字节本地已丢失 | 观察+推断 | 磁盘/git/发布 source-contents 三处哈希比对 | "丢失"限定为：本地已核路径；云端恢复未测（越界） |
| C4 | 图片热缓存完整：143/143 命中 | 观察 | vision-cache 文件数=143；checkpoint imageHash 全 HIT | 内容寻址；临时 FEISHU_SYNC_HOME 需显式复制才是"热" |
| C5 | 角色模型/思考档位/32768/并发 6 等运行参数完整冻结于 checkpoint 且当前 config 仍可解析出同值 | 观察 | state.json orchestration.spec；config.json llm.providers | 模型服务端行为（限流/版本漂移）不在本核查内 |
| C6 | 质量规则（prompts）自基准提交以来零漂移 | 观察 | `git diff aa13b34..HEAD -- server/src/agent/prompts/` 为空；工作区无改动 | 仅指 prompt 文件；代码层规则随 R/E/T/U 演进 |
| C7 | 已修复 legacy 路径＝主树工作区可运行，六项对照条件可配置满足 | 观察（可运行性）；推断（条件满足需冻结代码+夹具） | kb-build-service.ts；pool build 容量 1..8 | 参考轮实际并发为 1，"并发 6"未在任何路径实测过 |
| C8 | 新 pi-amagi 路径当前主树不可运行（503 显式拒绝），不满足开跑前提 | 观察 | workflow.md P1-I running；`server/src/agent/skills/` 主树不存在 | 待 P1-I 合并+13.1 探测后重评 |
| C9 | 用户通用 workflow 无固定实现/输入绑定/验收绑定，无法做等价对照 | 观察（缺失） | 证据 interpretationLimits 第 4 条；仓库内无实现 | 未扫用户 home 全域（按任务边界）；仅项目与 amagi-pi 仓 |
| C10 | 不存在"已批准的六源夹具"；一切性能试验需先从生产资料显式隔离建夹具 | 观察 | agent-outputs/ 与生产数据根内均无夹具登记 | — |

## 1. 基准构建证据链（C1）

- buildId `b_20261031213007_31acc7`；eventLog `~/.feishu-sync/standard-kb/.builds/b_20261031213007_31acc7/events.jsonl`，sha256 实测 `6e91fab8…32ba0` ＝ 证据文件 `eventLogSha256`（一致，置信高）。
- 事件构成（378,093 字节，931 行）：tool 826 / build_log 48 / build_worker 30 / build_status 13 / model_turn 11 / build_units 3。首个 build_status：`model=feishu-sync-llm/glm-5.3`、`parallelism=1`、`mode=incremental→preflight`。
- 两个检查点均在：`cp_030e5b22796df629fb79`（修复前）与 `cp_2dff28f32d40dbfcbe08`（CURRENT 代）；各含 state.json/candidate.json/read-receipts.jsonl（1057 行）/governance-freeze.json（snapshotHash `5cf49311…`，takenAt `2026-10-31T21:30:07.335Z`）。
- 发布指针：`standard-kb/CURRENT.json` → `r_20261101T024021_672fb1`（publishedAt `2026-11-01T02:40:21.467Z`，对应证据第 3 段 0.152s "published"）。**该 release 是现行生产发布**；对照试验必须在临时 FEISHU_SYNC_HOME，防止覆写。
- 编排任务链完整冻结于 state.json：11 任务（write/review r0–r2、integrate r0–r1、final r0–r1）、10 回执、interfaceRetries 2 处、ended=null（末次为发布收口）。
- 局限（沿用证据自述）：工具耗时为 FIFO 配对非 API trace；本轮含修复前运行+修复后恢复，不可作修复后性能基线。

## 2. 六源快照可获得性（C2/C3）

知识库根（生产）：`/Users/run.mao/workpace/weixiao-database/飞书同步知识库`（git，HEAD `14b6397`，2026-10-31T02:32:28+08:00）。

冻结 hash（cp_2dff28 state.json `.snapshot[]`，relPath 均在 `策划 - Designer/100-概念&游戏定位&美术风格&生产规划/` 下）：

| objToken | 类型 | 标题（截断） | 冻结 contentHash | 当前盘 | git HEAD | 发布 source-contents |
|---|---|---|---|---|---|---|
| KsMdd7q0…cnvd | docx | 000-难点与焦点（子项目化） | 33b0f67d…a268f | = | = | = |
| Gummsu16…ZnZc | sheet | 000-难点和焦点文档 | 8e34a162…703762d | ≠769ecb21… | ≠ | ≠（769ecb21…） |
| ZJXPdr6s…qn85 | docx | 100-概念&游戏定位&美术风格&生产规划 | b0ae6117…9e24dd | = | = | = |
| AOiaswsW…Un1f | sheet | 100-武将三观设计（环概念） | 56311625…263603 | ≠2136a25e… | ≠ | ≠（2136a25e…） |
| FP0gs1xS…Qnuf | slides | 【必读】…制作人阐述…V.1.3 | dd5df3d9…faff | = | = | = |
| XsCydDQk…KsnAb | docx | 汉代社会金字塔 | 72f74a86…6d67 | = | = | = |

- 4/6：磁盘字节＝git HEAD＝发布内嵌＝冻结 hash，字节级可复得（三处独立来源一致）。
- 2/6（两个 sheet）：冻结字节在 git 全部历史（14b6397/489a585/bed4cf2）均未出现过；当前盘与发布内嵌均为另一版本（769ecb21…/2136a25e…）。时间线（推断，依据：当日更早两个构建 b_20261031125652_8bf183、b_20261031205326_63f52a 的 checkpoint 冻结的是同一对 8e34a1…/563116…）：该版本至少自 10-31 12:56Z 起在盘、21:30Z 被冻结、02:40Z 发布收口前已被替换为与 git HEAD 相同的内容——盘上未提交状态被回退或被重新同步覆盖，具体动作不可考。**推断前提**：各 checkpoint snapshot 为构建启动时磁盘实况。
- 恢复面（未覆盖）：两源 objEditTime（1781098823 / 1785920920）早于一切 divergence，若云端未变，则差异源于本地重导出的非确定性或本地回退；等价恢复只能靠飞书云端按版本重导出+hash 对账——属远程读，本任务明令禁止，列为待核验。
- 结论：**"同源复跑原构建"对 2/6 源不可实现**；§13.3 三路径对照仍可成立，但夹具必须"现在重新冻结"（6/6 以新 hash 登记），三路径共用同一新夹具即满足"同一份源快照"，只是不再与基准轮比特同源。

## 3. 图片缓存热态（C4）

- 生产缓存 `~/.feishu-sync/agent/vision-cache/`（2-hex 分片、内容寻址 json）：143 个叶文件，572K。
- checkpoint `imageDescriptions` 提取全部 imageHash（去重 143）逐一对账：**143/143 HIT**，与证据 `cachedImageCount=143` 一致。
- 边界：临时 FEISHU_SYNC_HOME 数据根为空 ⇒ 缓存冷启动；"热图"条件要求把该 143 文件目录显式复制进临时数据根（体量小，无隔离难度）。参考轮 vision 通道未被锻炼（described=0, cached=143），vision 模型仅在未来源含新图时才相关。

## 4. 角色/模型/思考/输出上限/并发（C5）

checkpoint `orchestration.spec`（specHash `bd288e83…571b`，sourceSnapshotHash `980233fa…c3a8`）冻结值 vs 当前 `~/.feishu-sync/config.json` 实况：

| 项 | 冻结值 | 当前 config | 状态 |
|---|---|---|---|
| writer | model-mvwcgbep→`glm-5.3-flash`，thinking `max`，maxTokens 32768，ctx 300000 | preset 在，`glm-5.3-flash`，maxTokens 32768，levels [high,max] | 可复现 |
| reviewer/integrator | model-mvwce5ug→`glm-5.3`，thinking `max`，maxTokens 32768，ctx 400000 | preset 在，同值 | 可复现 |
| provider | provider-mvwce5ug→`https://open.bigmodel.cn/api/coding/paas/v4` | 同 baseUrl，hasKey=true（布尔，未读值） | 可复现 |
| concurrency | spec 6 | standardKb.buildParallelism=6；agent.maxConcurrentProcesses=2 | 可配置 |
| 并发展望 | — | 进程池构建容量独立 1..8、不受 M 截断（agent-process-pool.ts:143-157 注释"B 案 R3"） | 6 路可达（未实测） |
| 模式 | pipelineMode `orchestrated`、publishMode `auto`、maxAutoRevisions 2 | orchestrationMode 缺省（=legacy） | — |

- 参考**轮实际**并发：`parallelism=1`、units total=1（单写作单元 3 批），spec.concurrency=6 只是上限——三路径对照的"并发 6"没有任何已存在运行证据。
- 附注：主树存在用户未提交 maxTokens 相关改动（未跟踪 `server/src/modules/model-output-limits.ts`，`DEFAULT_MAX_OUTPUT_TOKENS=32768`；`ModelProviderSettings.tsx` 改动），preset 显式值优先，32768 口径不受影响，但性能轮前须冻结代码。

## 5. 质量规则（C6）

- 规则载体 `server/src/agent/prompts/`（standard-kb-build/plan/review/style + image-describe，共 22,710 字节）：`aa13b34..HEAD` 无 diff、工作区无改动——与基准提交同字节（基准轮跑在 aa13b34+dirty 树上，prompts 不在当时的 dirty 面，此为推断；置信中高）。
- 验收链（审查 r 轮、候选校验、原子发布）在 checkpoint 任务链中留有完整结构证据（§1）；固定验收样本（"世界金字塔"＝源《汉代社会金字塔.md》、"里与亭并行建制"）属源内内容，随夹具自然携带。
- 代码层质量执法随 R/E/T/U 批次演进（kb-build-service.ts 工作区 43 行未提交、tool-specs.ts +263 未提交），对照轮必须固定同一代码提交。

## 6. 三条路径可运行性（C7/C8/C9）

| 条件 | 已修复 legacy（主树工作区） | 新 pi-amagi | 用户通用 workflow |
|---|---|---|---|
| 同源（同一六源夹具） | 可（用新冻结夹具；非基准轮比特同源，见 §2） | 设计上可，未开跑 | 无输入绑定机制，需先定义 runbook |
| 同模型/思考 max | 可（preset 在配） | 设计上可（agentDir 静态声明，未实测） | 无保证机制 |
| 32768 | 可（preset 显式值） | 设计上可，未实测 | 无保证机制 |
| 并发 6 | 可配置（build 容量 1..8）；未实测 | 设计上可，未实测 | 无受管并发 |
| 热图 | 可（复制 143 缓存文件） | 同左（经 MCP 工具读图描述时命中） | 无接线（vision 缓存属应用侧） |
| 同质量规则 | 可（prompts+审查+发布门禁同一套） | skill 包已在 integration worktree，主树缺 | 不绑定；按设计只能当"正文生成指标" |
| **当前真实可运行** | **是**（主树工作区；需临时 FEISHU_SYNC_HOME+冻结提交） | **否**：orchestrationMode=pi-amagi → `build_runtime_unavailable`(503)；`server/src/agent/skills/` 主树不存在；生产数据根 runtimes/ 仅 claude-code-stage-*，无 amagi 运行时物化 | **否**（无实现） |
| 依据 | workflow.md（P1-R/T/E/U accepted；legacy 行为等价 301 回归）；integration-report.md | workflow.md（P1-I c5936873 running、P1-C/P3-L running）；integration-report.md §二/§五.2 | 证据 json interpretationLimits 第 4 条；仓库内无实现 |

amagi-pi 侧：`/Users/run.mao/workpace/amagi-pi` HEAD `929000e`＝证据 codeHeads，包版本 2.21.31，工作区干净（版本面可冻结）。

## 7. 可复跑输入清单与缺失项

可复跑输入（全部在场）：
1. 冻结参数全文：checkpoints/cp_2dff28…/state.json（roles/resolvedRoles/concurrency/任务链）。
2. 六源清单与 hash：同上 `.snapshot[]`（4/6 字节可复得，路径见 §2 表）。
3. 图片热缓存：`~/.feishu-sync/agent/vision-cache/`（143 文件，hash 对账全命中）。
4. 质量规则：repo `server/src/agent/prompts/*.md`（零漂移）。
5. 模型 preset：config llm.providers（GLM 双 preset，32768/[high,max]）。
6. 度量口径：构建耗时证据.json + events.jsonl（sha256 验证过）。
7. 生产知识库 git（HEAD 14b6397）：4 源的第二重字节来源。

缺失项（阻断或降级）：
- **M1（阻断"复跑原构建"，不阻断三路径互比）**：2 个 sheet 源的冻结字节（8e34a162…/56311625…）本地不可得；仅存 hash。云端重导出对账未做（越界）。
- **M2（阻断 pi-amagi 参赛）**：主链 P1-I 未合并、skills 未入主树、运行时未物化、13.1 探测与 live probe 未收口。
- **M3（阻断通用 workflow 等价对照）**：无固定实现、无同输入/同验收口径日志（证据自述）；需先立 runbook+验收绑定，否则只能报告正文生成耗时。
- **M4**：三路径各自的"并发 6"运行证据为零（基准轮 parallelism=1）。
- **M5**：基准轮代码态＝aa13b34+dirty（不可精确重建）；三路径对照只能各自冻结"当前"提交互比，与基准轮仅剩输入侧（4/6 源+热图+参数）可对齐。
- **M6**：GLM 服务端并发额度/稳定性未观测（设计 §14 已列）。

## 8. 夹具面：可安全复用 vs 需隔离

- 可安全复用（只读引用/复制来源，无生产风险）：repo prompts、checkpoints 元数据、events.jsonl、证据 json、KB git 历史、vision-cache（复制用途）。
- 生产资料，必须先隔离（复制进临时 FEISHU_SYNC_HOME，显式登记来源与 hash）：
  - 六源文件本体（生产同步树 `策划 - Designer/100-概念&游戏定位&美术风格&生产规划/…`，含全部父目录结构与 feishu_sync 头）；
  - `~/.feishu-sync/agent/vision-cache/`；
  - `~/.feishu-sync/config.json`（含明文 apiKey——夹具配置只抄 preset/模型/思考/并发字段与 hasKey 布尔所需的最小面，密钥处置由 Leader 决定）。
- 严禁触碰：生产 SQLite、`standard-kb/CURRENT.json`→`r_20261101T024021_672fb1`（现行发布）、`~/.feishu-sync` 其余状态。
- **不存在已批准夹具**：agent-outputs/ 与生产数据根内均无登记（C10）；首次性能试验前须按上述来源显式建夹具并留 provenance。

## 9. 待核验项（移交 Leader）

1. 两个 sheet 源能否经飞书云端按 objEditTime 版本重导出并命中冻结 hash（需远程读授权；objToken Gummsu16RhQhk9tEb2NcxzNRnZc / AOiaswsWPhYP2Rte9QEcn4EUn1f）。
2. 生产 SQLite 中该两 objToken 的 obj_edit_time 现值（本任务按读面纪律未查库），用于判定云端是否仍停在冻结版本。
3. pi-amagi：P1-I 合并 + 13.1 probe + live probe 收口后，重跑本核查 §6 第 2 列。
4. 通用 workflow 是否立 runbook（同夹具/同模型/32768/并发 6/同验收），否则按设计降级为正文生成指标。
5. 并发 6 首轮实测时的 GLM 限流与池排队观测（设计 §14 残余风险）。
6. 基准轮 dirty 树中 prompts 是否确未改动（M5 的残余不确定性；可通过当时无备份这一事实接受为不可证）。

## 附：生产锚点速查（供 Leader 建夹具）

- 构建：`~/.feishu-sync/standard-kb/.builds/b_20261031213007_31acc7/`（events.jsonl sha256 `6e91fab8…32ba0`；checkpoints/CURRENT.json→cp_2dff28f32d40dbfcbe08）
- 发布：`~/.feishu-sync/standard-kb/releases/r_20261101T024021_672fb1/`（source-contents.json：4/6=冻结字节，2/6=新字节）
- 热图：`~/.feishu-sync/agent/vision-cache/`（143 文件/572K）
- 源树：`/Users/run.mao/workpace/weixiao-database/飞书同步知识库`（git HEAD `14b6397`）
- 代码：feishu-sync HEAD `5f39dd8`（工作区另含 T/U+用户未提交面）；amagi-pi `929000e`（v2.21.31）
