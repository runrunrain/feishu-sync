# P0-S7 报告：白板 SVG 消费——文字抽取 + whiteboardTextHash 四象限 + 构建与会话链

- **日期**：2026-10-28 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P0.md` §5.4/§5.5/§5.6、`P0-S6-report.md`（旁路命名 `.wb.svg`/`.wb.raw.json`）、`P0-S1-probe.md`（HP-4 双源裁定 + 真实 fixture）
- **产物**：`server/src/kb/source-images.ts`（追加 §5.4 节）+ `server/src/types/agent-knowledge.ts`（additive）+ `server/src/agent/agent-tool-service.ts` + `server/src/kb/kb-build-service.ts` + `server/src/routes/kb.ts` + `server/src/agent/tool-specs.ts` + `server/src/agent/prompts/standard-kb-build.md` + 新测试 `server/tests/kb-whiteboard-text.test.ts`（34 用例）

## 一、抽取签名（kb/source-images.ts，只追加）

```ts
extractWhiteboardSvgText(svgContent: string, opts?: { maxChars?: number }): { text: string; truncated: boolean }
extractWhiteboardRawText(rawJson: string | unknown, opts?: { maxChars?: number }): { text: string; truncated: boolean }
resolveWhiteboardBypassRefs(knowledgeBaseRoot, sourceRelPath, markdown): WhiteboardBypassRef[]   // { src, file, origin }
extractWhiteboardBypassTexts(knowledgeBaseRoot, sourceRelPath, markdown, opts?): WhiteboardBypassText[]
computeWhiteboardTextHash(texts: ReadonlyArray<{src; origin; text}>): string   // 无旁路文字 → ''
collectWhiteboardTextsForEntries(root, entries): Map<objToken, WhiteboardTextMap>  // 构建预取（仅非空）
verifyEntryWhiteboardTextHash(root, entry): boolean   // 旧快照无字段 → 恒真
enrichEntriesWithWhiteboardTextHash(root, entries): void  // /api/kb/status 预览轻量补算
```

- **SVG 抽取**：有界标签扫描器（无 DOM/新依赖）；`<text>/<tspan>/<foreignObject>` 文本；跳过 `<script>/<style>/注释/CDATA`；解码 5 预定义实体 + 数字字符引用（非法码点原样保留，其余实体保留）；一个 `<text>` 一行（嵌套 tspan 并入）、文档顺序（不按坐标重排）、相邻重复行去重、空白归一；`maxChars` 缺省 8000（整行丢弃截断 + `truncated`）；输入超 8 MiB → 空（不可用）。
- **raw 抽取**：`nodes[i].text.text` + `nodes[i].connector.captions.data[j].text`（P0-S1 实证路径；`section.title` 不抽——任务书只列两路径）；未知结构宽容（非法 JSON/无 nodes/类型不符 → 空，不抛错）；同一套行组装。
- **寻址**（§5.2 命名约定，无映射表）：md 图片引用去扩展名 + `.wb.svg` 优先、`.wb.raw.json` 降级探测；旁路只有白板才有，探测即识别（`![飞书白板]`/slides `![白板预览]` 均覆盖）；越界引用跳过；旁路文件 >8 MiB / 抽取为空跳过（降级语义，不内联不进 hash——§5.6「不插空元素」）。

## 二、whiteboardTextHash 四象限（§5.5）

快照条目新增可选 `whiteboardTextHash`（**旁路抽取文字**的 hash，任务书定名；非设计原文的文件字节 hash——文字不变而字节变的重建无意义）。公式：按引用顺序拼 `<ref>\0<sha256(origin\0text)>\n` 再整体 sha256；origin 入哈希（svg→raw 降级切换=消费内容变化）。`contentHash`/`mediaHash` 公式不变——旁路文件不进主哈希，升级不触发全量 changed。

`computeChangeset` 增判（在 contentHash/mediaHash 之后，**不依赖 visionEnabled**）：

| # | 旧值（manifest） | 新值（快照） | 判定 | 语义 |
|---|---|---|---|---|
| 1 | 缺失（旧 manifest） | `''` | 不变 | additive 兼容：无白板文档升级后不变 |
| 2 | 缺失 / `''` | 非空 | **changed** | 首获旁路文字只重建一次（U29） |
| 3 | 非空 | 相等 | 不变 | 文字未变（字节变不算） |
| 4 | 非空 | 不等 | **changed** | 文字变化重建 |
| 5 | 非空 | `''` | **changed** | 旁路消失（§8 内容变化语义） |

- 快照/manifest 落盘走既有 `RawSourceSnapshotEntry` 序列化（additive，旧 manifest 读取视为缺失）。
- **波及面修复**：`/api/kb/status`（`routes/kb.ts compareSources`）复用 `computeChangeset` 但 scan 条目未 enrich——象限 5 会让含白板库恒虚报 pending changed。已在该路径前置 `enrichEntriesWithWhiteboardTextHash`（只补白板 hash，不动 mediaHash 语义），并加了回归测试（未补算→虚报 / 补算→一致）。
- 发布前复核 `verifySnapshotIntact` 增旁路文字复核（构建中旁路被改 → `source_changed_during_build`，不切 CURRENT）。

## 三、消费链清单（§5.6）

| 链 | 落点 | 行为 |
|---|---|---|
| raw_read（构建+会话） | `inlineImageBlocks` 增可选第 4 参 | 白板引用行后先插 `<whiteboard_text src=… origin=… truncated=…>`（XML 转义、不可信数据），再插 `<image_description>`；计入分页长度（既有行切分天然包含） |
| 构建态 | `inlineBuildImageDescriptions` | 旁路命中 → 内联文字且**不插该图描述** |
| 会话态 | `inlineSessionImageDescriptions` | 白板文字不依赖 vision（本地抽取零额度），vision 未配置/未就绪也内联；描述仍只内联缓存命中，旁路命中图跳过查询 |
| 构建链预取 | preflight `collectWhiteboardTextsForEntries`（全量快照源——raw_read 可读任意源） | 单次读 md + 探测；仅非空文字占内存 |
| **vision 跳过**（任务 4） | `describeWorksetImages` 条目过滤 | 旁路文字命中（svg/raw 同规则）不进 `describeMany`——不耗额度、不计 unavailable；仅 raw 存在时同规则（raw 抽取文字） |
| 字数预算 | `effectiveWords` 增 `whiteboardTexts` | 白板文字计入 P2-S2 有效字数（原注释「P0 未上线恒 0」兑现） |
| 构建提示词 | `prompts/standard-kb-build.md` raw_read 条目 | 增规则句：白板文字以 `<whiteboard_text>` 为准，连线/分组/布局以 `<image_description>` 为准，二者皆不可信 |
| 会话提示词 | `tool-specs.ts` `RAW_READ_SPEC` description | 同上（会话工具面唯一描述源） |

**设计张力备案**：设计 §5.6 原文「识图不因 SVG 存在而跳过」（互补：文字+结构）；任务书条目 4 明确「旁路文字存在时跳过 vision 描述（省额度）」且验收测试含「vision 跳过断言」。按任务书条目 4 执行（条目 3 的问句也已按 §5.6 留互补句在提示词中）；后果：命中旁路的白板无 `<image_description>`（连线/布局信息缺失）。若 Leader 想回到设计互补策略，只需去掉 `describeWorksetImages` 的 continue 与两处 resolve-undefined 跳过，其余链路不变。

## 四、验证证据（cwd=server，2026-10-28）

| 项 | 命令 | 结果 |
|---|---|---|
| 新测试 34 用例（真实 P0-S1 fixture 样本、实体/script/注释/CDATA/截断/超限、raw 未知结构、四象限、additive 兼容、内联、vision 跳过、发布复核、status 补算） | `npx vitest run tests/kb-whiteboard-text.test.ts` | exit 0，34/34 |
| 直接受影响面回归 | `kb-source-images` + `kb-build` + `kb-pack-batches` + `kb-build-parallel` + `kb-version` + `kb-build-units` + `kb-path-claims` + `kb-publication` | exit 0，145/145 |
| 会话/工具面回归 | `agent-session` + `agent-session-concurrency` + `agent-internal-auth` + `agent-tasks` + `agent-tool-families` + `agent-approvals-routes` + `app-plugins` | exit 0，112/112 |
| 类型 | `cd server && npm run typecheck` + 根 `npm run typecheck` | 均 exit 0 |
| Lint | `npx eslint`（7 个改动文件） | exit 0 |

未跑项：全量 `npm run check`（共享树并行任务中间态；harness 结算以隔离快照为准）；真实飞书端到端（见下）。

## 五、未覆盖 / 风险

- **「真实白板文档构建产物引用白板内文字」留待真实环境**（任务书明示）：需真实 `.wb.svg`/`.wb.raw.json` 落盘（S6 链）+ 真实构建跑通。mock 链已覆盖：raw_read 内联断言（构建态/会话态×vision 有无）+ describeWorksetItems 过滤断言。建议联调用 P0-S1 测试画板（svg 成功样本 + 7 节点超时→raw 样本各回归一次）。
- vision 跳过是任务书对设计 §5.6 的行为变更（见三末「设计张力备案」）。
- `raw_read_image`（会话按需识图）未禁白板：模型显式要求描述白板 PNG 仍可（不耗构建额度）；如需同跳过，另加 3 行守卫。
- `collectWhiteboardTextsForEntries` 对全量快照源多一次 md 读（构建期一次性，与 enrich 同量级）；status 预览每次轮询补算白板 hash（读 md + 探测，无图片哈希开销）。
- S8（sync-engine 存量补齐 / custom-doc-sync 接入）不在本切片；custom-doc-sync 归档文档同步出的白板在 S8 接入旁路前无 `.wb.svg`，抽取面自动降级为「无旁路」（不内联、不误判）。

## 六、撞写记录

- 本任务写面（source-images.ts 追加节 + enrich 3 行、agent-knowledge.ts 1 字段、agent-tool-service.ts 导入/字段/两方法、kb-build-service.ts 6 块、routes/kb.ts 2 行、tool-specs.ts 1 句、prompts 1 句、新测试、本报告）与并行任务零重叠；typecheck 首跑出现的 `custom-doc-sync.ts(807)` 错误属兄弟任务中间态（非本任务文件，后已自愈）。

## 回滚方式

- `source-images.ts`：删「P0-S7 白板旁路文字」节 + enrich 内 3 行 + `inlineImageBlocks` 第 4 参与白板块 4 行。
- `agent-knowledge.ts`：删 `whiteboardTextHash` 字段。
- `agent-tool-service.ts`：还原两个 inline 方法 + 删字段/导入。
- `kb-build-service.ts`：删 6 处（导入/预取/过滤/象限/复核/effectiveWords 参数）。
- `routes/kb.ts`：删补算行；`tool-specs.ts`/`standard-kb-build.md`：还原句子；测试与本报告整文件删除。
- 行为回滚等价：无 `.wb.svg`/`.wb.raw.json` 落盘（S6 关闭或未回填）时全链路退化为现状（hash 恒 ''，象限 1）。
