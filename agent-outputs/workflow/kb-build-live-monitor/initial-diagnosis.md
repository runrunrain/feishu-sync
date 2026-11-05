# 构建现场盘点：b_20261105092329_e8471c（初诊，v2 修订）

时间：2026-11-05 09:23:29Z 起；v1 采样至 09:40:50Z，v2 修订补采至 09:46Z 并**修正 v1 #6 的未经证实归因**（详见 §3.2 与文末修订记录）。只读取证，未改任何生产状态。
已安装版本 0.3.51（commit b2b1447）；rebuildSelected 增量构建（用户单选一篇测试），pi-amagi 编排，基准 release `r_20261105T040943_8535e7`。

## 结论索引

| # | 主张 | 状态 | 锚点（摘要见正文） | 适用边界 |
|---|---|---|---|---|
| 1 | 119 = 全量原始源快照口径，非错误扩面；真实工作集 = 1 个所选源 | 观察 | events seq3/seq6；state workset/rebuildSelected/preservedDocs | 本构建（rebuildSelected 模式） |
| 2 | 唯一变更源 =《200-044-演出任务看板数据结构（施工）》（sheet，3 图），目标 `数据化战斗/演出任务看板数据结构.md` | 观察 | raw-snapshot 命中项；assignments.json；requiredRewrites | 同上 |
| 3 | 无门禁阻断、无重复读、无排队、无错误重试风暴；docsWritten 长时间为 0 是写作未落笔，非卡死 | 观察 | build-actors/events 全量；cc_* 回执 11 条唯一；会话持续增长；09:44:33 写入落地 | 截至 09:46Z |
| 4 | 最大耗时 = 写作模型长思考轮（139/195/221s×3）；单篇写入 09:25:43→09:44:33 ≈ 18.8 min | 观察 | luban 会话 durationMs；artifact_write_doc 事件 | 单篇重写、glm-5.3-flash:high |
| 5 | 异常①：Leader 首次 task_submit 被 ContractError 拒单（staging 路径误填 inputs.required），自纠 1 次，浪费 ~36s+1 轮 | 观察 | Leader 会话 L12 toolResult + L13 thinking | 新 Leader 会话首轮可能复发 |
| 6 | preflight 的 seq9→seq10（59.5s）窗口含三段：**远端识图 3 张（缓存 miss，全部新鲜描述）+ includeRetainedImageCache 扫描 65 个保留带图源 + 证据版本比对；各段占比无分段计时，未知** | 观察（拆分未知） | images 计数 described=3/cached=0；imageDescriptions 前 3 条 state='described'；vision-cache 3 文件 writeCache 落盘 01:23-01:24 | rebuildSelected 且 !resume；本窗口 |
| 7 | 基线承接重验证（3078 条回执）实测 ~0.9s，非瓶颈；规模随 KB 增长 | 观察 | state 装载时刻；receipts toolCallId 统计；:3326-3465 | 本 KB（119 源/1092 对象） |
| 8 | strictGates=false 构建创建时冻结并落盘；flow/角色提示词哈希绑定且实际生效有行为证据 | 观察 | 检查点 gatePolicy（cp_eabe 已轮转，观测时在）；SKILL.md sha256=workflowRevision；Leader 行为符合 8 步流 | 发布期降级行为未到，未直接观测 |
| 9 | 门禁面无异常：0 阻断（progressiveBlocked=[]），不应为优化制造问题 | 观察 | state；events 无 blocker | 截至 09:46Z |

## 1. 工作集与 119 的口径

- events seq3（09:23:30.161）：「快照完成：119 个原始源（0 个候选源文件缺失）」；seq6：「继续构建：1 个所选源」。**sourceTotal=119 是快照阶段对知识库根全量源计数**（49 docx + 67 sheet + 2 bitable + 1 slides，raw-snapshot.json 统计），changed=1 是用户单选重建源。
- `checkpoints/cp_2317…/state.json`：rebuildSelected=true，workset 1 项，preservedDocs=149，docMeta=150。
- 变更源：《200-044-演出任务看板数据结构（施工）》（sheet，imageCount=3），目标文档 `数据化战斗/演出任务看板数据结构.md`。

## 2. 实测时间线

| 时刻(UTC) | 事件 | 证据 |
|---|---|---|
| 09:23:29.65 | 构建创建 preflight | events seq1 |
| 09:23:30.16 | 快照 119 源（0.5s） | seq3 |
| 09:23:31.03 | 基线登记装载：1092 对象 + 3078 条承接回执重验（~0.9s） | seq7；receipts |
| 09:23:31.06 | **进入图片阶段**：日志「图片预描述：3 张（命中缓存不调远端）」——该文案是 describeMany 调用**前**的策略分支描述（visionReady && !refreshImages），**不是结果报告** | seq9；:3675-3678 |
| 09:24:30.54 | 「识图证据已更新」——两日志间 **59.5s 窗口**：describeMany 3 张（实际结果 described=3/cached=0，**3 张全部远端新鲜描述**，缓存 miss 合理推断为源图片内容随源变更而变）+ includeRetainedImageCache 扫描 65 个非工作集带图源（390 图，逐源 readVerified+逐图哈希+缓存 lookup，命中置 state='cached'）+ visionDescriptionImproved（内存比对）。**无分段计时，占比未知** | seq10；cp_2317 images 计数与 imageDescriptions 前 3 条 state='described'；vision-cache 3 条目 writeCache mtime 01:23×2/01:24×1 |
| 09:24:31.36 | Leader 启动（pid=1331） | seq14-15；process-ledger |
| 09:24:39.50 | Leader 首轮 8.0s：get_workset | Leader 会话 L10 |
| 09:25:15.35 | task_submit#1（35.7s 推理）→ **ContractError required-input-missing** | L12 |
| 09:25:33.10 | task_submit#2（17.7s）受理，luban 确认 | L14；actors.json |
| 09:25:43.26 | build_assign_output 分配目标文档 | L16 |
| 09:25:43.85→09:37:13 | luban 读旧稿→主文档 3 段→2 CSV→10 对象声明（逐轮 6-43s）+ 三轮长思考 138.8/195.2/220.9s + 取 write 契约 + 补读 CSV | luban 会话 idx8-38 durationMs |
| 09:44:33.11 | **artifact_write_doc：草稿写入完成**（写作全程 ≈18.8 min） | build-actors/events 第 4 条；cp_a625 writtenPaths=['数据化战斗/演出任务看板数据结构.md'] |

**正常推理 vs 卡死判定**：luban 会话 09:25→09:44 持续增长（150KB→更高，每 1-4 分钟落盘）；Leader task_control wait（10min）09:35:53 返回 running 且报告最近工具活动，续等；09:44:33 写入落地。全链活性完整，判为正常长推理。180 分钟无进展时限为兜底（seq12）。

## 3. 异常与瓶颈清单

1. **ContractError 首轮拒单（轻微、可复发）**。Leader 把目标文档路径填进 `inputs.required`，契约按 epoch 工作目录解析为本地文件→不存在→拒单；下一轮自悟（“staging drafts live in the app bridge, not on local disk”）重提成功。leader-protocol.md:16 只写“objToken 是桥接标识，不是本地文件路径”，:31 只覆盖续接场景旧 agent-outputs 路径；未覆盖“staging 文档路径不能进 inputs.required”。
2. **【v2 修正】preflight 图片窗口 59.5s，归因拆分未知**。窗口内含三段，证据与结论：
   - **远端识图确实发生**：checkpoint `progress.images={total:3,described:3,cached:0}`；`imageDescriptions` 中工作集 3 图 state=`'described'`（vision-describer.ts:311-312：远端描述成功→writeCache→返回 `'described'`；读缓存命中才返回 `'cached'`，:284/:297-298）；vision-cache 3 条目 mtime 01:23×2、01:24×1 为**写缓存时刻**而非读取。v1 把日志「命中缓存不调远端」当结果、把缓存文件 mtime 当命中证据，均为误读，撤回。
   - **includeRetainedImageCache 的扫描面是代码事实**（kb-build-service.ts:3721-3753：遍历全部非工作集带图源 65 个/390 图，逐源全文读+逐图哈希，唯一哈希查缓存，命中 ~380 条置 'cached' 供文本预算计数），但其**墙钟占比未测**，v1 的“59.5s 全部是扫描”“收益省 ~60s”撤回。
   - 各段耗时拆分需分段计时/插桩，现状**未知**。远端 3 张串行/并行节奏（01:23 两张、01:24 一张落盘）与“远端描述占可观份额”相容，但不构成定量结论。
3. **写作模型推理延迟是最大头**（不变）：luban 16+ 轮累计 ~12 min 纯推理，三轮 139/195/221s；单篇写入全程 18.8 min。属模型/提示词工程面。
4. **非异常澄清**（不变）：3078 条 baseline-carry 回执（2726 text/csv + 352 image）为设计内基线承接重验换发，~0.9s；重复选择器 233 组（最高 69 次）为“每证据项一条回执”的设计行为，模型自身读取（cc_* 11 条）无重复。

## 4. 冻结策略 / flow 实际生效验证

- **strictGates=false**：首检查点 cp_eabe（09:24:31，v1 观测时在、现已被轮转删除）与现存 cp_2317（09:25:33）state.gatePolicy 均 `{"strict":false,"version":1}`；leaderRun.spec.strictGates=false。创建时冻结有落盘证据。
- **flow**：leaderRun.spec.workflowRevision=`cb709028…` 与构建 pi-home `…/home/skills/knowledge-build/SKILL.md` sha256 实测相等；Leader 会话首条用户消息声明规则经系统注入并哈希绑定。
- **角色**：SKILL.md 三个 ROLE_SKILL sha256 标记与 role-luban/diting/baize.md 实测哈希全一致。
- **行为**：Leader 执行 get workset → task_submit → assign output → wait 循环，符合 8 步流；luban 按 role 协议走回执→声明→写入链。
- **未覆盖**：发布期非严格门禁降级行为未到发布阶段，无直接观测。

## 5. 最小落点与回归用例建议（供下游裁决）

1. **leader-protocol.md 补派写约束**（`server/src/agent/skills/knowledge-build/leader-protocol.md` 第 3 步）：「任务书 `inputs.required` 只能填本地真实存在文件路径；staging 草稿/对象/来源是桥接资源，路径仅写任务书正文」。回归：build-runtime e2e 断言 Leader 首个 task_submit 无 required-input-missing；钉住 workflowRevision 的测试需同步更新。
2. **preflight 图片窗口优化（降级为候选，收益未量化）**：includeRetainedImageCache 可按 state.preservedDocs 的 sources 集合收窄扫描面（:2684 调用处、:3721 实现），回归用文本预算既有测试+新增“非保留集带图源不被 readVerified”断言。**v2 注**：本窗口内远端识图占额未知；若远端为主，收窄扫描的单次收益有限。建议先加分段计时（describeMany / retained 扫描 / 版本比对三段各一条 build_log）再决策。
3. 门禁面**无需动作**（不变）。

## 6. 覆盖范围与未覆盖

- 已读：.builds/.staging 状态全量、两份 pi 会话 JSONL 全量、build-actors、process-ledger、vision-cache mtime、raw-snapshot、现存检查点 state（cp_eabe 已轮转）；代码核到 kb-build-service.ts 相关函数、vision-describer.ts 状态语义、leader-protocol.md。未改任何文件（本报告除外）。
- 未覆盖：diting 审查往返（写作 09:44:33 完成后尚未见派发）、发布门禁实际行为、SQLite/DB（不在授权范围）、构建总耗时终值。
- 并行提示：任务书 API 观察与现场一致，无冲突。

## 7. 待核验项

1. diting 独立审查派发与往返耗时（下一采样点看 build-actors 新 actor/事件）。
2. 发布阶段 strict=false 的 warning 化与 stageBlockedPaths 行为。
3. ContractError 在新 Leader 会话的复发率（本轮仅 1 样本，可查历史构建 epochs）。
4. **59.5s 窗口三段拆分**：需分段计时插桩（当前无任何输出可判）。
5. 3 张图缓存 miss 的成因确认（推断为源图片内容变更导致 hash 变化，未直接比对新旧图 hash）。

## 修订记录

- v2（09:46Z）：按反馈修正 #6——撤回“59.5s 全部为 includeRetainedImageCache 扫描”“全缓存命中无远端调用”“收窄扫描省 ~60s”三项断言；补 vision-describer 状态语义证据（described=远端+写缓存）；图片窗口改记为“三段构成、占比未知”；§5.2 降级为候选并前置分段计时建议；补 09:44:33 写入完成与 cp_eabe 轮转说明。其余现场发现保留。
