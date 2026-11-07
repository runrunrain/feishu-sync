# WP-H 报告：首稿自检清单 + 旧提示文案清理

## H1：首稿 needs_revision 率 → author-protocol 提交前自检

### 数据核实（reviews.json 实读，任务书初判与实际略有出入）

来源：`~/.feishu-sync/standard-kb/.staging/b_20261107061134_8b2173/build-actors/reviews.json`（只读）。
实际为 **22 条审查记录（全部 generation=1）覆盖 13 篇文档，首审 9 篇 needs_revision（69%）**，共 **17 条 blocking**（任务书初判 14 次审查/6 篇；以 reviews.json 真实数据为准）。

### blocking 共性归纳（全部 blocking 描述逐条读后归类）

| 共性 | 次数 | 典型示例 |
|---|---|---|
| A 证据 text_span 范围未覆盖断言核心（空行/仅标题/行号错位） | 4 blocking + 1 sug | 「三阶段×六类岗位」断言证据只圈节标题行 R29-30，核心枚举在 R31 表内（#12）；两条证据 quoteHash=SHA256("") 选到空白行，内容在 R97/R103（#6）；误把输出行 O30 当资源行写入 selector（#20）；断言实质在 CSV record 25-26，证据却绑主文档空占位行（#1） |
| B 图示/白板仅逐字抽取却写箭头方向/归属/因果 | 5 blocking（含 1 复审未完全关闭） | 白板关键词逐组绑定到实/虚/架偏向，无连线佐证（#0+#3 复审）；组装链路「[人物性格]+[事件]→[权重]→…」方向为源外结论（#13）；时间条「后续节点」顺序断言+五条 A→B→C 链路方向（#20×2） |
| C 源外增补：程度词/自拟维度名/源外概念与示例 | 4 blocking + 2 sug | 「主要产出来源」的「主要」源外且方向与源不符（#1）；「人口交互」概念源外引入（#2）；「人际关系」示例全源零命中（#16）；「R组」不在本篇声明来源（#20）；sug：「平滑阻尼」定性词、「处境/基调」自拟维度名 |
| D CSV 证据 record/列不含断言依据单元格 | 1 blocking | 断言核心句唯一依据是 record 5 @F 注释列，绑定三条证据均未覆盖该 record（#2） |
| E 源内口径冲突静默合成 | 2 blocking | 效果4 名称/参数/示例为铜币口径、描述句为经验口径，草稿单方面按铜币改写未披露（#2）；情绪环 alt 口径与机器描述口径冲突静默合成+「不清晰（似为激动）」写成确定「红温」（#13） |
| F 遗漏源枚举关系项 | 1 blocking | 系统关系六项漏「经验值系统」一项，证据已覆盖该行但正文未收录（#1） |
| G 正文残留整理过程措辞 | 1 sug | 「正文未随源同步」「源中为…」「本文档（仅结构占位）」（#13-s） |

A、B、C、G 为原自查清单未覆盖项（E、F、限定词已有对应条目）；A/D 同源（证据范围），已合并为一条。

### 新增自检行全文（author-protocol.md「写前/交接前自查」段，净增 4 行）

- 程度词、定性词与维度名贴源：不写源中没有的「主要/平滑」式概括或自拟维度名；示例与概念在源中零命中的删除。
- 每条断言的证据范围必须含它引用的枚举、数值或注释所在行（CSV 含 record 与列），不是仅标题行或空行；selector 用回执资源内坐标，不把展示输出行当资源行。
- 图示/白板只有逐字文字抽取时，不写箭头方向、分组归属或先后顺序，按节点/词条集合照录；机器描述标「不清晰」的内容不写成确定。
- 正文面向库读者：不残留「源中为…」「正文未随源同步」等整理过程措辞。

reviewer-protocol.md 与之不重复（审查侧已有「白板旁路文字不能证明图形布局」复核规则，作者侧缺预防项，互补不改）。
mcp-examples.md 增加对应证据范围正例（净增 1 行，纯文本无 json 块）：

> 证据范围必须覆盖断言引用的内容本身：断言某表有三个阶段、六类岗位时，selector 要取到该表所在行（含表体而非仅节标题行或空行）；断言依据 CSV 注释列时，`columns` 须含该列（如 `["@B","@I"]`），只圈数据列会被审查以「selector 不支撑断言」记 blocking。

## H2：kb_get_plan 误导引用清理

### 加载点核查（pi-amagi 路径）

`kb_get_plan` 在 tool-specs.ts **实际注册**（`KB_GET_PLAN_SPEC`，:609，handler 在 agent-tool-service.ts），不是不存在的工具；问题在 **v2/pi-amagi 子任务工具面不含它**（`V2_CHILD_READ_TOOLS`/`V2_WRITER_TOOLS`/`V2_REVIEWER_TOOLS`/`V2_LEADER_TOOLS` 均无；仅旧 `BUILD_TOOLS` 面有）。diagnosis R5 实测作者误调被拒浪费回合，故 pi-amagi 加载文件内的提及必须改写。

| 文件 | pi-amagi 是否加载 | 处置 |
|---|---|---|
| prompts/standard-kb-build.md | **是**——`materializeWorkflowSkill` → `qualityBaselineSections(promptAssets)` 注入三角色冻结 skill 与 Leader 系统提示（kb-build-service.ts:1286-1301）；另经 AppPluginStore `kb-build-rules` 插件 | **已修正 3 处**：工具清单 `kb_get_plan`/`kb_unit_done`/`kb_finish` 行标注「仅应用内编排会话；amagi 子任务工具面不含，勿调用」；「跨单元对象」段改写为「用服务端写回执分配的 objectId 引用（需要确认时 `draft_read` 对方草稿的声明；amagi 子任务无 `kb_get_plan`）」 |
| prompts/standard-kb-review.md | **是**——同上注入 diting 角色与 Leader 系统提示（`reviewPrompt` 段，index.ts:393 → kb-build-service.ts deps.reviewPrompt） | **已修正 1 处**：`kb_get_plan` 行尾加「仅应用内编排会话可用；amagi 审查任务工具面不含，勿调用」 |
| prompts/standard-kb-plan.md | **否**——仅 `planRulesText()`（kb-build-service.ts:4902）→ `runOrchestratedPlan`（:6017）旧编排规划轮（legacy `orchestrated` 分支）；pi-amagi 走 `runLeaderSupervisedPhase` 提前 return | **保持不动**（旧管线审查者/规划者面 `BUILD_TOOLS` 含 `kb_get_plan`，该文件提及对旧管线是真实工具） |

### 全工具名核对（skills/knowledge-build/*.md + prompts/*.md，对照 tool-specs.ts 46 项注册 + amagi 原生 task_*/amagi_resource）

- **无未注册工具名**：所有反引号提及的工具名均在 tool-specs.ts 注册或属 amagi 原生工具面。`kb_evidence_unresolved`（author-protocol/mcp-examples）是错误码非工具名，无需处理。
- v2 面外工具在 pi-amagi 加载文件中的提及仅有 `kb_get_plan`/`kb_unit_done`/`kb_finish` 三项：author-protocol.md 第 4 条原有「`kb_unit_done`/`kb_finish` 属旧版批处理工具，勿调用」兜底，本次在 build.md/review.md 补齐面标注后三处一致。
- mcp-examples/leader-protocol/SKILL/achievement/reviewer 协议中全部工具名均在对应角色面（knowledge-skill-examples.test.ts 的 F14 契约测试同口径校验，通过）。

## 验证

- 改前基线：knowledge-skill-examples + raw-links = 18 passed。
- 改后针对性：knowledge-skill-examples + raw-links + kb-build + kb-tool-param-tolerance = **110 passed**。
- server `tsc --noEmit`：**0 错误**。
- server 全量 vitest：3586 passed / 2 failed——① `bundled-amagi.test.ts`（**预期基线失败**，与任务书口径一致）；② `desktop-server-process.test.ts` 性能计时断言 213ms > 180ms 上限，为全量并发负载下波动，**单独重跑通过**，且本次仅改 4 个 md 提示文件、无 ts 改动，非本次回归。
- 未改任何 .ts 源码；未 git commit/stash/checkout/reset。

## 改动文件清单

| 文件 | 净增行 | 内容 |
|---|---|---|
| server/src/agent/skills/knowledge-build/author-protocol.md | +4 | 自查段 4 条新自检项 |
| server/src/agent/skills/knowledge-build/mcp-examples.md | +1 | 证据范围正例 |
| server/src/agent/prompts/standard-kb-build.md | 0 | 3 处行内标注/改写 |
| server/src/agent/prompts/standard-kb-review.md | 0 | 1 处行内标注 |

回滚：`git checkout -- <上述 4 文件>`（未做，留待主上决定）。
