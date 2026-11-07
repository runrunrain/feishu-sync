# WP-C 报告：构建期知识工具的参数容错与可自动修复的错误反馈

日期：2026-11-07 ｜ 范围：diagnosis.md R5（工具参数被 schema 拒绝 / kb_evidence_unresolved 反复出现，每次浪费一个完整 LLM 回合）

## 0. 校验发生在哪一层（先回答任务书的追问）

实测复现证据（`analyze-build-sessions.py`，5 个真实构建）显示失败形如：
`Validation failed for tool "mcp__feishu_kb_bridge__raw_search": - objToken: schema is false - root: must not have additional properties`。

链路：**tool-specs.ts（唯一 schema 真相源）→ `/api/agent-internal/tools`（getToolSpecsForToken 原样下发）→ claude-bridge.cjs（`inputSchema: s.parameters` 原样转发）→ amagi/pi 在客户端按 JSON schema 校验后才发 tools/call**。即拒绝发生在调用侧校验层，server 端各 handler 根本没收到参数。因此：

- **放宽点必须在 tool-specs.ts**（放行到服务端），规范化与精确错误在 **agent-tool-service**（`normalizeToolArguments`，executeTool 统一入口，规范化结果在幂等键派生之前）。
- `server/src/mcp/`（kb-mcp-tools.ts）是对外只读 MCP（search_knowledge 等），与构建工具面不同源，**本次未动**；公共工具的 `validate()` 严格性保持。
- 别名不在 schema 里宣传（描述文本不变），只在服务端容忍——`additionalProperties: true` 只对枚举的只读工具放开。

## 1. 逐项处理结论

| # | 实测问题 | 处理层 | 结论 |
|---|---|---|---|
| 1 | `build_handoff_submit.openIssues.N: must be string`（对象项） | tool-specs（items 放宽为 string\|object）+ normalizeToolArguments | 对象项序列化为一句字符串：优先 description/text/message/summary/issue/reason，其余 k=v 附注（≤600 字符），兜底 JSON；纯数字等不可序列化项仍报精确错误。规范化在幂等键前完成，重放语义不变 |
| 2a | `raw_search` 误传 `queries`/`objToken`/`sourceId`/`root` | 同上 | `queries`（1..8 项）逐个执行合并去重（matchedQueries 标注）；`objToken/sourceId` 限定单源（不存在→not_found）；`root` 等歧义参数报精确错误列出真实参数名。单查询路径返回形状字节级不变 |
| 2b | `draft_search` 误传 `path`/`filter`/`kind`/`queries` | 同上 | `queries` 合并；`path` 限定范围（精确或前缀）；`kind` 无害忽略+说明；`filter` 歧义→精确错误 |
| 2c | `raw_csv_find` 缺 `resourceId` / `queries`>8 | tool-specs（maxItems 8→24）+ handler | 上限放宽到 24：>8 执行并在结果 note 注明超批；>24 报精确错误；缺 resourceId 报精确错误（说明完整 #csv: 资源 ID 来自 raw_read 资源表）。不做 resourceId 别名猜测（无实测别名形状，猜错更危险） |
| 2d | `raw_csv_cells` 传 `columns`、`recordStart<1` | tool-specs（recordStart min 1→0）+ normalize | `columns` 忽略+说明（本工具返回全部非空单元格，列选择属证据 selector）；`recordStart=0` 规范化为 1+说明；负值/未知参数报精确错误 |
| 2e | `draft_read` 传 `kind`/`docPath`/`paths`/缺 `path` | 同上 | `docPath`→path；`paths` 单项→path（多项→建议 kb_read_batch 的精确错误）；`kind` 忽略+说明；缺 path 报精确错误 |
| 2f | `draft_list` 传 `limit` | 同上 | 全部多余参数忽略+说明（工具无参数） |
| 2g | `kb_read_batch` 传单个 `{kind,path,…}` 而非 `requests` | tool-specs（移除顶层 anyOf + 放开 additionProperties）+ normalize | 顶层单请求对象包装为 `requests:[…]`；`resources` 数组别名（mcp-examples 点名的高频误填）同样映射；`requests+cursor` 优先级与 F05 行为不变（对应回归测试已更新断言）；歧义形状报精确错误 |
| 2h | `build_issues_list` 传 `issueListId`/`listId` | 同上 | `listId/issueListId/revision` 忽略+说明（始终返回最新 revision）；其他未知参数报精确错误 |
| 2i | （取证补充）`kb_tool_schema` 传 `tool` 而非 `name` | 同上 | `tool`→name 别名规范化 |
| 3 | `csvTableImports.0.columns.N: must be integer`（"@A"/"A"/"3"） | tool-specs（items 放宽 int\|string）+ normalizeKbWriteDocArgs | "@A"/"A"/字母坐标→0 起始整数列位（A→0，与 evidence selector 的 @A 语义一致，经 csv-table-import.ts 约定核对）；"3"→3；"C5" 等单元格引用/歧义形式报精确错误。规范化在幂等哈希前 |
| 4 | `kb_edit_doc`：`evidenceClaims.clientKey 重复: ev_auto_…` | agent-tool-service（writeDocCore 证据循环 + normalizeKbWriteDocArgs） | ①同 clientKey 且内容完全相同（对象/断言/来源/selector/角色/性质规范化指纹一致）→去重容忍；内容不同→报冲突并指出两条修法（evidenceSelectorUpdates / 换新键）。②根因修复：`ev_auto_*` 自动键生成在 kb_edit_doc 追加同身份新证据时会按序号从 1 重启而撞旧键——现在传入既有键集，冲突时递增序号重生成，无 clientKey 追加不再被误拒 |
| 5 | `kb_get_plan` 提示里出现但不在授权面 | 代码侧 + 汇报 | 引用位置（未改动，均不在本任务写面）：`server/src/agent/prompts/standard-kb-build.md:19、:78`（写作轮提示，v2 writer 面无此工具）；`standard-kb-review.md:9`；`standard-kb-plan.md:9`。`agent/skills/knowledge-build/mcp-examples.md` 经 grep 无 kb_get_plan 引用（无需最小删除，该文件由 WP-D 编辑）。代码侧：`kb_tool_schema` 对未授权工具的错误现在列出当前角色完整可用面（"当前可用：…"），提示词提到的工具名不再让模型反复探测 |
| 6a | `kb_evidence_unresolved`：CSV 选中全空 | agent-tool-service + evidence-locator（新增 `csvNonEmptyColumnLabels`） | 错误末尾追加「该 record 范围实际非空列：@A, @B」（无任何非空列时明示整段为空）；既有前缀与 R物理行/C逻辑 record 说明保持，测试断言兼容 |
| 6b | TextSpan/CsvCells 超出回执范围 | agent-tool-service（新增 `evidenceReadHint`） | 追加精确补读参数：text_span→`raw_read(objToken,offset,limit)`（经 assembleBuildRead 段映射把资源本地行换算为拼接输出窗口，考虑图片描述派生行位移；换算失败退回资源行号近似）；csv_cells→`raw_csv_cells(objToken,resourceId,recordStart,recordEnd)`（直接登记覆盖该 record 区间的回执） |
| 6c | 没有覆盖所选范围的 raw_read 回执 | 同上 | 同 6b 提示追加（同一 helper，三个抛点共用） |
| 7 | `read` 越出信封根（child-policy） | — | 不改（预期围栏） |

规范化统一行为：成功时在返回中追加 `paramNotes`（JSON 载荷写入字段；文本载荷追加 `<param_notes>` 行），绝不静默；歧义输入一律报「一次可修复」的精确错误（列出该工具真实参数名，并提示 `kb_tool_schema` 查完整契约）。

## 2. 决定不做 / 降级的项及理由

- **raw_search 的 `root`、draft_search 的 `filter` 静默忽略**：两者都是范围语义，静默丢弃会返回误导性结果（违反"不静默吞掉有歧义的输入"），故报精确错误。
- **raw_csv_find 的 resourceId 别名猜测**（如 `resource`/`csvName` 字段匹配）：无实测别名形状，猜测错资源比报错更危险；保持精确错误。
- **kb_read_batch requests 项内别名**（`type`/`token` 等）：未列入任务清单，items schema 保持严格；只做顶层包装与 `resources` 别名。
- **`server/src/mcp/kb-mcp-tools.ts`**（对外只读 MCP）：与本任务失败无关（构建工具走 agent-internal 桥），`validate()` 严格性与 `additionalProperties:false` 保持。
- **evidence-resources.ts / csv-read-compact.ts**：核对后无清单内的错误提示需求（工作簿/图片资源错误与空行折叠提示已达标），未改。
- **prompts/standard-kb-*.md**：不在本任务写面，仅汇报引用位置（见上表 #5）。
- **raw_read 分页/默认 limit**：WP-D 边界，未动。

## 3. Changed files

- `server/src/agent/tool-specs.ts` — 只读工具 additionalProperties 放开（raw_search/raw_csv_cells/raw_csv_find/draft_read/draft_list/draft_search/kb_read_batch/build_issues_list/kb_tool_schema）；kb_read_batch 移除顶层 anyOf；raw_csv_find maxItems 24；build_handoff_submit.openIssues items string|object；kb_write_doc.csvTableImports.columns items int|string。全部附 WP-C 注释；对模型展示的参数描述文本未新增别名宣传
- `server/src/agent/agent-tool-service.ts` — 新增 `normalizeToolArguments`/`appendParamNotesToResult`/`stringifyOpenIssueItem`/`normalizeCsvColumnCoordinate`（executeTool 统一接线，规范化先于幂等键与失败暂存）；toolRawSearch 拆出 scoreRawEntries 支持多查询合并+单源限定（单查询路径不变）；toolDraftSearch 多查询+path 范围；raw_csv_find 上限 24+超批注明；kb_tool_schema 未授权错误列出可用面；normalizeKbWriteDocArgs 支持 columns 规范化与既有键感知的 ev_auto 生成；writeDocCore 证据循环：同键去重/冲突判定 + 3 处 kb_evidence_unresolved 提示（evidenceReadHint）+ 全空列清单
- `server/src/kb/evidence-locator.ts` — 新增导出 `csvNonEmptyColumnLabels`（纯函数）
- `server/tests/kb-tool-param-tolerance.test.ts` — 新增 29 用例（每项：规范化成功 + 歧义仍报错对照；证据提示 4 例；ev_auto 去重/冲突/免误拒 3 例）
- `server/tests/build-runtime-toolfix-regressions.test.ts` — F05 用例更新为"schema 不再 anyOf"的新契约（服务端行为断言原样保留）

## 4. 验证

命令（cwd=server）与结果：

- `npx vitest run tests/kb-tool-param-tolerance.test.ts` → **29/29 通过**
- `npx vitest run tests/kb-knowledge-tools.test.ts tests/build-runtime-tools.test.ts tests/build-runtime-toolfix-regressions.test.ts tests/raw-search.test.ts tests/knowledge-skill-examples.test.ts tests/kb-version.test.ts tests/build-actors.test.ts` → **268/268 通过**
- 另过：build-runtime-e2e / build-runtime-fix-e2e / kb-discuss-integration / agent-tool-families / agent-internal-auth / agent-approvals-routes / kb-author-efficiency（后两者全量并发跑时受兄弟任务中间态干扰，隔离复跑均通过）
- `npx tsc --noEmit` → **0 错误**（任务书基线 3 个 portable-kb-service 错误在当前共享树已不存在；全量编译错误均为兄弟任务中间态，本任务写面内文件 0 错误）
- `npx eslint <changed files>` → 0 问题
- 全量 `npx vitest run`：仅 `tests/bundled-amagi.test.ts` 1 项失败 = 任务书声明的基线失败；其余全量失败项经隔离复跑均通过（并行任务中间态/负载超时，非本任务回归）
- 真实数据：仅只读取证（analyze-build-sessions.py 读真实构建会话定位失败形状）；所有测试用临时 FEISHU_SYNC_HOME/临时目录；未调用真实模型

## 5. 回滚说明

单 commit 级回滚：还原上述 5 个文件即可（无数据迁移、无配置变更、无落盘格式变化）。`git checkout -- <files>` 会连带兄弟任务的未提交改动，**禁止**；应按文件内 WP-C 注释标记的块反向 apply，或由 Leader 在隔离快照中定向 revert 本任务 diff（`git diff server/src/agent/tool-specs.ts server/src/kb/evidence-locator.ts` 全部为本任务改动；agent-tool-service.ts 与两个测试文件为共享文件，按 WP-C 注释块甄别）。

## 6. 安全性论证（没有放宽哪些门禁）

- **零伪造回执/quoteHash 服务端重算/路径围栏**：未触碰 read-receipts 登记、verifyEvidence 判定逻辑与 PathGuard；`evidenceReadHint` 与全空列清单只追加在错误消息尾部，判定条件一字未改（既有测试断言全部通过）。
- **角色工具面冻结**：工具面名单（build-actors V2_*、LEADER_TOOL_WHITELIST）、amagi 白名单、dispatch-guard 全部未动；kb_tool_schema 只是把"不在工具面"的错误说得更完整。
- **写入工具保持严格**：kb_write_doc/kb_edit_doc 顶层 schema 仍 `additionalProperties:false`，仅枚举的 `csvTableImports.columns` item 形状放宽且规范化后仍过 csv-table-import 全部既有校验（列位范围/去重/字节预算/回执登记不变）；build_handoff_submit 仅 openIssues item 形状放宽且幂等键在规范化后派生。
- **容错只做形状规范化，不做语义放行**：所有规范化都是「同义改写」（别名→真名、0→1、包装、序列化）并在返回中说明；任何带语义歧义的输入（root/filter/单元格引用/缺 resourceId/未知参数）仍报精确错误，不静默吞掉。
- **additionalProperties 放开仅限枚举的只读工具**（+枚举的 build_handoff_submit item 形状）；raw_read/raw_list/kb_search 等未列工具 schema 未动。
- **思考强度、独立审查、原子发布**：未触碰任何模型/审查/发布配置。

## 7. 复审修复（R4，2026-11-07 第二轮）

**问题（review.md R4，Major）**：第一轮只放开了 `additionalProperties`，但 raw_search/draft_search 的 `required:['query']`、draft_read 的 `required:['path']`、kb_tool_schema 的 `required:['name']` 仍在——别名入口（`queries`/`docPath`/`paths`/`tool` 单独出现、canonical 缺失时）依旧在 pi/amagi 客户端校验层被拒，到不了服务端 normalizer。第一轮新测试直接调 executeTool/normalizeToolArguments，绕过了这一层，故未暴露。

**方案选择**：不采用顶层 anyOf（与 kb_read_batch 移除 anyOf 的先例一致——客户端兼容面不可靠且 kb_read_batch 已用「schema 不做结构强制 + 服务端精确错误」方案），对这四个工具**移除 required，把缺失检查统一留给服务端**：

- `server/src/agent/tool-specs.ts`：RAW_SEARCH_SPEC / DRAFT_SEARCH_SPEC / DRAFT_READ_SPEC / KB_TOOL_SCHEMA_SPEC 移除 `required`，附 R4 注释；description 不新增别名宣传。
- `server/src/agent/agent-tool-service.ts` normalizeToolArguments：补齐缺失时的精确错误——raw_search/draft_search「需要参数 query（…）；多查询可用 queries 字符串数组」、kb_tool_schema「需要参数 name（…）」（draft_read 原已有）。缺失检查在别名归一化之后执行：`{queries:[…]}`/`{docPath:…}`/`{tool:…}` 先被改写为 canonical，再判缺失。
- required 保留的工具复核：raw_csv_cells/raw_csv_find 的 required（objToken/resourceId/recordStart/recordEnd、queries）**保留**——它们没有别名入口，客户端缺失报错本身列出真实参数名（一次可修复），服务端精确错误继续作为直连 HTTP 的兜底；kb_read_batch/draft_list/build_issues_list 本就无 required；kb_search/raw_read/raw_list 等未触碰。

**新增「真实下发 schema 接缝」测试**（kb-tool-param-tolerance.test.ts §8，25 用例）：用 **ajv 8.20.0**（server node_modules 既有传递依赖）对 tool-specs 导出的 `spec.parameters`——即 claude-bridge 原样下发给客户端的同一 schema 对象——做真实 JSON Schema 校验：

- 16 组别名入参（queries/docPath/paths/kind/tool/columns+recordStart=0/24 项 queries/顶层单对象/仅 cursor/listId/limit/openIssues 对象项等）全部通过 schema；
- 4 组「canonical 缺失+无别名」在 schema 层放行（required 已移除的既定语义）且 normalizeToolArguments 报精确错误；
- required 保留的工具（raw_csv_find 缺 resourceId、raw_csv_cells 缺 record 区间）仍在 schema 层被拒。

**验证（第二轮，cwd=server）**：`npx vitest run tests/kb-tool-param-tolerance.test.ts` → **54/54**；`tests/raw-search.test.ts`（required 断言已随新契约更新：kb_search 保持 required query、raw_search 无 required）+ kb-knowledge-tools + build-runtime-tools + build-runtime-toolfix-regressions + knowledge-skill-examples + kb-version + build-runtime-bridge → **228/228**；`npx tsc --noEmit` 在本任务写面内 0 错误（当前共享树仅剩 1 个错误，位于 build_issues_submit 的 originBindingOf——WP-B1 问题关闭逻辑的中间态，非本任务代码）；eslint 0 问题。

**共享树过程记录**：第二轮验证期间 WP-D 正在改 toolRawRead/toolKbReadBatch（R5 字节预算），出现短暂的 `sliceWithByteBudget`/`KB_READ_BATCH_TEXT_BUDGET_BYTES` 未定义中间态并波及依赖 raw_read 的测试；未触碰其代码，待其定义落地后全部恢复通过（54/54）。

**未做（复审范围外，归属他项）**：R1/R2（review-authority/build-actors 问题关闭语义）、R3（dispatch-guard 准入记账）、R5（raw_read/kb_read_batch 字节预算——WP-D 已在修）。本修复未动 review-authority/dispatch-guard/toolRawRead/toolKbReadBatch。
