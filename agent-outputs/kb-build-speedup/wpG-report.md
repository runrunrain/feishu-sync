# WP-G 报告：新构建 b_20261107061134_8b2173 暴露的剩余写作工具摩擦

日期：2026-11-07 ｜ 范围：任务书 G1–G5。取证：`~/.feishu-sync/agent/builds/b_20261107061134_8b2173/epochs/e1/home/sessions/--Users-run.mao-.feishu-sync-agent-builds-b_20261107061134_8b2173-epochs-e1-work--/`（26 个 worker 会话 + 1 Leader，只读）。会话目录名注意：点号在 `run.mao`（任务书目录名少一个点）。

## 0. 全构建错误面扫描结论（G5）

按工具×错误码聚合全部 26+1 会话（脚本同 WP-E 取证口径）：该构建工具错误共 49 条，其中 20 条客户端 schema 拒绝、9 条 kb_evidence_unresolved（全部为 WP-E 已修的 krr_stage 跨构建回执类，本构建运行在 WP-E 合入前的服务端上，勿重复处理）、5 条 kb_coverage_invalid（G1）、2 条图片资源缺失（G2）、2 条 kb_output_not_assigned（派发侧，报错已含 retryOf 修复参数，不动）、1 条 not_found 双拼 token（G3）、1 条 raw_search queries 超批（G3）、1 条 child-policy 文件工具越界（G3 评估项）、1 条 draft_read includeCoverage（G4）。**低效模式**：raw_read 共 81 次（26 会话，均值合理）；仅有的 2 次完全重复读取均为 raw_read `kind` 字段被 schema 拒后的重试（WP-E E4 已修）；draft_read 250 次主要是逐对象声明分页（18KB summary cap + declarationObjectKey 的按设计流，G1 修复减少其必要性）。未见其他值得服务端介入的模式。

## 1. G1：kb_coverage_invalid「改写会移除仍被覆盖映射引用的对象」（3 篇修订轮整篇重写）

### 1.1 证据与根因（会话行）

| 会话 | 文档 | 现场 |
|---|---|---|
| 06-14-58-550Z | 数值系统/属性与数值思考.md | L38 首次 kb_write_doc（objects.clientKey=objectId、variantKey/scopeKey 均省略）→ L39 拒；L40 重试 → L41 同错；L47 又遇 `mapped 目标对象未注册`；L42 补显式 variantKey+scopeKey 后 L49 才成功（06:25→06:29，5 次往返） |
| 06-32-41-225Z | 人物系统/人物系统总览.md | 同错 ×2；作者思考直接命中根因：「我的 clientKey 传的是 objectId 形式（ko_9f1f...），但服务端可能把…」 |
| 06-36-57-195Z | 策略尺度/回合设计与数据结构.md | 同错 ×2；作者长思考识别出第二形态：6 个旧对象中 3 个（参数换算/世界规模基准/世界参数）在当前源已无内容支撑，无法重申，只能改覆盖项去向——但旧错误只给「重申原对象」一条路 |

根因链（代码 + 数据取证）：
1. **显示的 clientKey 不是登记的 clientKey**：增量携带的已发布对象没有 clientKeys 登记（上一构建 staging knowledge-draft.json 实测 0 hits），`renderDraftDeclarations`（agent-tool-service.ts）回退显示 `clientKey = objectId`。作者照抄该键重申时，`draft.clientKeys[clientKey]` 查找落空。
2. **族三元组兜底也 miss**：省略 scopeKey 时 normalizer 从 `(docPath, scopeText)` 派生 `scope_auto_<hash>`（normalizeKbWriteDocArgs）。实测派生值 `scope_auto_e8889f6d…` ≠ 存档值 `scope_auto_3687c039…`（旧构建写入，哈希史不同）——scopeText 原文逐字一致仍不命中。
3. 两路皆 miss → 新随机 objectId → 旧对象进 removedIds → 旧覆盖项（继承，未重申仍生效）引用悬空 → 拒绝。12 个对象里只有被覆盖项引用的 2 个被报出，作者无从知道其余 10 个其实也漂移了。

### 1.2 改动（agent-tool-service.ts，两处，只加不改判定）

- **身份回退（主修）**：对象声明 priorId 解析在 clientKeys 查找与族三元组之间新增一档——`clientKey` 为 `ko_` 前缀且精确等于某非 tombstone 既有 objectId 时直接沿用该身份。ko_+objectId 是无歧义引用，命中后照走原 F03 族排他/跨路径核权、重复登记与移除守卫（授权链零变化）。
- **错误一次给全修复参数**：拒绝消息逐对象列出 `- <objectId>（<title>；family=<familyKey>/<variantKey>/<scopeKey>）← 覆盖项 <itemId>(<category>[/important])`，随后给两条路径：①精确读取调用 `draft_read({path,declarationObjectKey:"<id>",limit:0})` + 「按原 familyKey/variantKey/scopeKey 重申（clientKey 可直接用该 objectId）」；②对象已无来源支撑时「coverageUpdates 按原 itemId 显式改去向（mapped→承接对象 / excluded_*（须 reason）/ unresolved）」——覆盖 06-36-57 会话的第二形态。
- **tool-specs.ts**：objects.clientKey/variantKey/scopeKey 描述补身份语义（clientKey 可用 objectId；三元组构成身份、重申回传原值），减少首发犯错。

### 1.3 keepObjects / 锚点自动保留——评估后不做（论证）

任务书允许「至少把错误做成一次给出完整修复参数」。自动保留评估结论：**保留未重申对象将携带旧 bodyRange 落盘，发布时 compileDoc 按 `bodyRange.startLine + lineOffset` 注入锚点并计算发布范围（knowledge-compiler.ts compileDoc/anchors 装配）——整篇重写后行坐标必然失效，锚点与对象发布范围静默错位，属于用「保留」外衣引入坐标损坏**，与「不得静默丢失」同级的质量问题。锚点判别（正文含 `<a id="ko_x">`）也只能给出起点不能给出 endLine，且实测三篇重写的提交正文都不含锚点行（模型不写 HTML，锚点仅存在于上一构建发布的正文），判别根本不触发。身份回退主修后，重申本身就是廉价路径（一次粘贴），且带来新正文的正确坐标。

## 2. G2：图片证据「资源不在本构建资源表」（2 次）

### 2.1 证据

06-15-24-057Z（工具与拓展/地图编辑器/前置安装与启动.md）：L38 `kb_evidence_unresolved: 证据资源不在本构建资源表: YAc7dWEx…#image:images/05-F6QEbk8u….png（可用：YAc7dWEx5oqX28xK3v9cQpAUnob；…未描述图片不登记）`——可用列表只有正文资源，无任何图片信息。L39 作者重发时**直接删掉了图片证据**，L41 交接注明「图片描述恢复属应用侧管线能力，Leader 可按需安排」。

### 2.2 改动

- **evidence-resources.ts**：新增导出 `imageResourceStatuses`（纯枚举：与 `collectImageEvidenceResources` 同一 `resolveSourceImages` 面，逐图给出 src/registered/预描述 state·reason）。
- **agent-tool-service.ts**：resourcesFor 的 pack 附带懒求值 `imageStatusOf`（仅源含图片或引用含 `#image:` 前缀时才有，正常路径零开销）；证据资源缺失且为图片时错误一次性给出：未登记图片的真实状态（无描述 / unavailable+reason，如 `reason=too_large`）、**该源已登记图片资源 id 清单**、src 不属于该源图片引用时的判别与该源全部图片 src 清单。
- **不提 raw_read_image**（重要裁量）：任务书设想「给出读取它的精确工具调用」，但仓库事实是识图描述由构建预飞生成，且 `raw_read_image` 只在 work/discuss 工具面（`runKinds: ['work','discuss']`），v2 构建三角色面（V2_CHILD_READ_TOOLS/Leader 面，build-actors.ts）**均不含它**——作者无构建内补描述通路，错误里给该建议即误导。修复面在 build-actors（任务书禁改），故错误如实告知「本构建内不可用作证据；确需支撑在交接记录说明，由应用侧修复识图后重新构建」。

## 3. G3：not_found 双拼 token / queries 形状 / child-policy

- **双拼 token**（06-26-45-178Z L8/L10：`V3LcdMbkxo5ZVzxJt6NcGUYbnlcGUYbnlc`）：新增纯函数 `boundedEditDistance`（带上限提前退出）+ `nearestObjTokenHint`（包含关系〔拼接/截断〕→ 编辑距离，构建快照工作集优先 + 会话 documents 候选），not_found 错误追加「；你是不是想读 <最近 token>」。应用于 raw_read / raw_search / readRawContent（raw_read_image/raw_links 共用）/ raw_csv_cells / raw_csv_find / kb_read_batch raw 项共 7 处；无近似命中时不给建议（对照用例）。toolRawComments（work/discuss-only、无 context 签名）未改——无构建态会话证据，改签名超最小范围。
- **queries 形状**（06-29-53-808Z L24/L25：raw_search 12 项）：normalizeQueriesAlias 错误回显收到项数（含非字符串项时列类型）与拆批修法（「拆成多批（每批 ≤8）或用 query 单查」）。
- **child-policy**（06-29-53-808Z L12：pi 输出重定向临时文件被 read 拒）：现有提示已点名 raw_read/raw_search；剩余缺口（draft 截断场景指向 draft_read 分页）在 `build-runtime/child-policy.ts`——任务书文件边界外，仅记录。

## 4. G4：draft_read includeCoverage（1 次）

证据：06-27-36-326Z L33 调用 / L35 拒绝。改动：draft_read 归一化层对 includeCoverage 给定向错误（不新增参数）：「覆盖项信息用 metadataOnly:true（返回本篇 sources 的 coverageItems：itemId/sourceId/disposition）或 includeDeclarations」；其余未知参数维持通用 unrecognizedParamError。

## 5. G5 其余发现（记录不改，含理由）

| 发现 | 次数 | 不改理由 |
|---|---|---|
| build_handoff_submit 客户端 schema 拒（summary missing + 杂散 `", "` 键） | 1 | 模型生成 JSON 毛刺（多出的字面量键），拒绝发生在 MCP 客户端 ajv 层，服务端不可见；summary 是真实契约必填。属模型偶发，无稳定修法 |
| kb_edit_doc coverageUpdates.itemId missing（客户端 schema 拒） | 1 | 同为客户端层；已在 tool-specs 描述补「itemId 必填，可用 draft_read(metadataOnly:true) 查询」（低成本提示，见 §3 附带） |
| kb_get_plan 权限拒绝（协议提到但不在授权名单） | 1 | 名单属角色工具面/prompts（禁改面）；记录供 Leader 裁量 |
| kb_review_scope_missing / kb_draft_revision_conflict / build_issues_list issuesListId / kb_output_not_assigned | 各 1–2 | 审查权限链/并发保护/既有精确报错，不在本任务修复面；kb_output_not_assigned 报错已含 retryOf 修复参数 |
| raw_read/raw_csv_find 等既有 WP-E 修复项 | — | 勿重复（任务书明示） |

## 6. Changed files

- `server/src/agent/agent-tool-service.ts` — G1 身份回退 + kb_coverage_invalid 一次性错误；G2 pack.imageStatusOf + 图片资源错误；G3 nearestObjTokenHint/boundedEditDistance + 7 处 not_found 追加建议 + queries 形状回显；G4 includeCoverage 指向（全部 WP-G 注释块标注）
- `server/src/kb/evidence-resources.ts` — 新增导出 `imageResourceStatuses`/`ImageResourceStatus`（纯函数，登记判定零改动）
- `server/src/agent/tool-specs.ts` — objects.clientKey/variantKey/scopeKey 身份语义描述；kb_edit_doc coverageUpdates itemId 指引（描述性改动，无 schema 结构变化）
- `server/tests/kb-write-friction.test.ts` — 新增 12 用例（见 §7）

未动：prompts/skills/review-authority/build-actors/dispatch-guard/publish-readiness/build-metrics/cli/child-policy/evidence-locator。

## 7. 测试（tests/kb-write-friction.test.ts，临时目录 + 手工快照，无 SQLite、无真实模型）

| 验收项 | 用例 | 结果 |
|---|---|---|
| G1 成功路径：clientKey=objectId + 省略 variantKey/scopeKey（scopeText 改写 → 派生三元组不命中，复现实测形态） | 重写成功；objectId 不变、revision 1→2、clientKeys 新增 ko_ 登记、覆盖项 cov_g1 仍指向该对象 | ✅ |
| G1 既有语义回归：原 clientKey（登记命中）重申 | 照常成功 | ✅ |
| G1 门禁对照 1：换全新对象且覆盖项未改去向 | 仍拒 kb_coverage_invalid；消息含 objectId/title/family 三元组/cov_g1/declarationObjectKey/按原 itemId 改去向；草稿零部分写入 | ✅ |
| G1 门禁对照 2：objects:[]（全部不重申） | 仍拒（静默丢失零容忍） | ✅ |
| G2 未描述图片 | 拒绝；含真实状态、该源已登记图片资源 id（pic1）；**不含 raw_read_image 建议**；草稿未写入 | ✅ |
| G2 unavailable 图片 | 拒绝；含 reason=too_large 与不可作证据说明 | ✅ |
| G2 src 不属于该源 | 拒绝；列出该源全部图片（pic1、pic2） | ✅ |
| G2 对照：已描述图片 media_region | 成功；selector.imageHash 服务端钉住（sha256:图片字节） | ✅ |
| G3 双拼 token | not_found + 「你是不是想读 tokA」 | ✅ |
| G3 对照：无近似 token | 不给建议 | ✅ |
| G3 queries 12 项 | 回显「收到 12 项」+ 拆批修法 | ✅ |
| G4 includeCoverage | 指向 metadataOnly:true 与 coverageItems | ✅ |

## 8. 验证（cwd=server）

- `npx tsc --noEmit` → 0；根 `npm run typecheck`（root + node + server 三段）→ 0
- `npx eslint`（4 个改动文件）→ 0 问题
- 定向：kb-write-friction 12/12；kb-knowledge-tools + kb-tool-param-tolerance + kb-edit-rebind + evidence-resources + evidence-budget + raw-search 166/166；kb-build + kb-build-parallel + build-runtime-tools + knowledge-skill-examples + progressive-source-snapshot + progressive-knowledge-draft 149/149
- 全量 `npx vitest run`：**3611 passed / 1 failed / 18 skipped**——唯一失败 = `tests/bundled-amagi.test.ts`（任务书声明的基线失败：本机未安装 bundled amagi）
- 真实数据仅只读取证（会话 JSONL、上一构建 staging knowledge-draft.json、配置）；测试全部临时目录；未调用真实模型

## 9. 门禁未放宽论证

- **覆盖映射门禁原样**：未重申且覆盖项未改去向 → 照旧拒绝（两个对照用例）；错误只改「信息量」，判定分支 `referencedRemovedIds.length > 0` 与 409 语义未动。
- **身份回退不绕授权**：ko_-objectId 命中与族三元组命中走同一段 F03 代码（族排他、跨路径迁移核权、提交期重核）；它只是让 draft_read **显示**出来的引用真正可解析，不新增任何未授权身份获取面——三元组命中本就允许任何知道三元组的作者绑定同一对象。
- **图片证据门禁原样**：无描述/白板文字的图片仍不进资源表、仍不可作证据（对照用例：未描述→拒，已描述→过）；错误改进只提供判别信息，不给绕过路径（明确不提 raw_read_image，因为构建面不可达）。
- **not_found 建议只改文案**：解析结果不变，无近似命中不给建议；编辑距离只用于提示。
- **G4 不新增参数**：includeCoverage 仍拒绝，只指向既有真实入口。
- **发布/校验链零改动**：compileDoc、verifyEvidence、quoteHash、read-receipts、审查失效机制全部未触碰；全量回归仅基线失败。

## 10. 未覆盖与风险

- G1 身份回退只覆盖「ko_ 前缀 + 精确 objectId」的显示回退形态；作者完全改写 familyKey 且不回传三元组时仍会漂移——此时由一次性错误兜底（含三元组与两条修复路径）。
- nearestObjTokenHint 的编辑距离上限按 `max(2, len/6)` 启发式裁剪：极短（<4 字符）token 不参与建议，避免噪声；不保证语义正确，只是提示。
- queries 形状回显在纯字符串超批场景只报项数；混合类型才列类型清单（避免 12 项 string/string 噪声）。
- 上一构建 scope_auto 哈希与当前派生公式不一致的成因（哈希史/旧公式）未深挖——不影响本次修复（两路兜底已闭合），如需彻底统一需另行审计 normalizer 演进史。
- 并行任务共享工作树：全量/定向测试均一次通过，未撞上兄弟中间态；结算以隔离快照为准。

## 11. 回滚

四文件均为独立增量：agent-tool-service.ts / tool-specs.ts / evidence-resources.ts 按 `WP-G` 注释块反向 apply；新测试文件直接删除。回退后恢复「显示 clientKey（objectId 回退形态）不可解析、省略 scopeKey 重申即身份漂移、旧版两条错误文案」的行为。

## 12. 复审修复（review-5 R5-01 / R5-03，2026-11-07 续轮）

独立审查判 FIX，R5-02 归 WP-F；本轮修 R5-01（Major）与 R5-03（Minor）。

### R5-01：not_found 建议泄露构建外 objToken

- **问题**（review-5 P1 动态复现）：`nearestObjTokenHint` 扫完构建快照后无条件追加全局 documentsProvider——构建态用 4 字符前缀（如 `Priv`）探测即可让错误回显完整构建外 token（`PrivateSourceSecretToken9876`）。
- **修**（agent-tool-service.ts，helper 内部收敛，7 个调用点一并生效）：构建态候选严格限定本构建冻结快照（工作集优先，非工作集快照条目属沿用源仍在信封内）；documentsProvider 仅非构建态（discuss/work）参与。无合法候选不提示。
- **回归**（kb-write-friction.test.ts 新增 2 用例）：①构建态前缀探测构建外 token → 错误既无建议也无 secret 字样，且同会话快照内双拼 token 建议照常；②discuss 态用其可见 documents 建议照常。另以独立探针 `review-5-p1p5-verify.mjs`（review-5-probe P1–P5 断言按修复后语义翻转）动态验证：P1 无泄露、P1b discuss 照常、P2/P3 门禁保持、P4 同 call 改向成功、P4b 守卫拒悬空、P5 includeCoverage:false 仍拒。

### R5-03：「改去向」建议在同次重写中被旧覆盖状态先行拒绝

- **问题**（review-5 P4）：移除检查读旧 draft.coverage，即使同提交内已按建议重述 itemId 去向，也在覆盖项应用前被拒——建议不可执行。
- **修（选案 a，有效覆盖状态判定）**：移除检查改为基于「应用本次 coverageUpdates 后的有效覆盖」——被本次同 itemId 重述的旧项不再计入悬空判定；未重述旧项仍引用被移除对象照旧拒绝。配套新增写入点守卫：重述的 mapped 项若仍指向本次移除的对象（含 clientKeys/ko_ 回退/计划键解析命中）→ 拒绝「重述后仍指向本次移除的对象」——否则该悬空会穿过覆盖项解析（existingById 含被移除登记）迟到发布门才暴露。错误文案同步改为「在同一提交的 coverageUpdates 里按原 itemId 显式改去向……后移除该对象」。
- **门禁未放宽论证**：静默丢失仍拒（无重述 → carried 覆盖引用被移除对象即拒，G1-b/G1-c 对照不变）；放开仅限「作者显式重述去向」这条明确意图通道，且最终无悬空由新守卫在写入点保证（重述项不得指向被移除对象）+ 既有发布门「mapped 目标不存在」双保险；objectMerges 改向路径不受影响（合并在检查前已在 draft.coverage 原地转向）。
- **回归**（新增 3 用例）：①objects:[] + 重述 unresolved → 成功，对象移除且 cov_g1=unresolved；②换承接对象 + 重述 mapped→新对象 → 成功，目标指向新 objectId；③守卫对照：重述 mapped 仍指向被移除对象 → 原子拒绝，草稿字节不变。

### 验证（cwd=server）

- `npx tsc --noEmit` → 0；根 `npm run typecheck`（三段）→ 0；eslint（4 个改动文件）→ 0。
- 原始 review-5-probe.mjs（断言旧缺陷存在）：P1/P4 断言如期失败（缺陷不再复现），翻转版探针全绿退出 0（见上）。
- kb-write-friction 17/17；定向 kb-knowledge-tools/kb-edit-rebind/kb-tool-param-tolerance/evidence-resources 172/172。
- 全量 `npx vitest run`：3623 passed / 1 failed / 18 skipped——唯一失败 = tests/bundled-amagi.test.ts（任务书声明的基线失败）。（过程说明：修复轮中途一次全量出现过 build-metrics-pi-amagi 的瞬态失败，系并行 WP-F 正在改 kb-build-service/build-metrics 的中间态，非本任务文件；其完成后定向与全量均通过。）
- 测试全部临时目录；真实数据仅只读；未调用真实模型；未 commit/stash/checkout/reset。

### 回滚（追加）

R5-01/R5-03 同样按 `R5-01`/`R5-03` 注释块反向 apply；回退后恢复「构建态建议混入全局 documents」「同 call 改去向仍被旧覆盖状态拒绝」的行为。
