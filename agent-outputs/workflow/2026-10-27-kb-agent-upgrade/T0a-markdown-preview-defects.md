# T0a 调查报告：源知识库 Markdown 预览渲染缺陷清单

- 项目：/Users/run.mao/workpace/feishu-sync（分支 feat/agent-knowledge-workbench，工作树读取）
- 方法：只读精读渲染端（MarkdownView.tsx 957 行 / html-table.ts / feishu-cite.ts）与生成端（layout-reconstructor.ts / media-reference.ts / sync-engine.ts 产物段 / custom-doc-sync.ts / bitable-exporter.ts / sheet-media.ts / media-gap.ts），交叉比对产物结构与渲染子集。渲染行为一栏为基于代码路径的**推断**（未在浏览器执行）；生成端结构为**观察**（代码直接产出）。
- 核对文件：src/components/preview/MarkdownView.tsx、MarkdownView.test.tsx、src/utils/html-table.ts、html-table.test.ts、src/utils/feishu-cite.ts、server/src/modules/{layout-reconstructor,media-reference,sync-engine,custom-doc-sync,bitable-exporter,sheet-media,media-gap}.ts、server/src/kb/body-policy.ts、server/tests 目录清单。

## 结论索引

| 编号 | 主张 | 三态 | 关键锚点 | 适用边界 |
|---|---|---|---|---|
| D1 | `<details>` 元数据块按原文泄漏为文本 | 推断 | layout-reconstructor.ts:223-229；MarkdownView.tsx:294,109-141 | sheet 类文档 A 型块 |
| D2 | preprocess 剥离不区分代码围栏，代码块内容可被破坏/大段丢失 | 推断 | MarkdownView.tsx:124-126,128-129,131-141 | 正文含 HTML 示例的代码块 |
| D3 | 自定义归档 docx 附件标签 `<file token="attachments/…">` 原文泄漏且不可点击 | 观察(生产端缺口)+推断(渲染) | custom-doc-sync.ts:230 vs sync-engine.ts:613,1392；MarkdownView.tsx:41,113-115 | 自定义归档链路 |
| D4 | datatable 单元格含 `\|`/换行未转义，预览表格断裂 | 观察(生产端)+推断(渲染) | layout-reconstructor.ts:244-268；对照 bitable-exporter.ts:401-404 | sheet CSV 单元格含特殊字符 |
| D19 | 包裹式媒体标签转换后残留闭合标签（`</whiteboard>` 等） | 推断 | MarkdownView.tsx:41-43,113-115；旁证 sync-engine.ts:1394,1399-1404 | 产物存在包裹式媒体标签时 |
| D5 | 任务列表 `- [ ]` 显示为字面括号 | 推断 | MarkdownView.tsx:657,739 | 任务列表导出/LLM 输出 |
| D10 | 非白名单行内标签（u/mark/sub/sup/font）原文泄漏 | 推断 | MarkdownView.tsx:294 | 飞书导出含此类标签时（待样本） |
| D8 | 列表项续行（缩进图片/文本）脱离列表项 | 推断 | MarkdownView.tsx:657-671；sheet-media.ts:568-569 | 子表图片资源附录等 |
| D7 | 混合有序/无序多级列表丢失子级标记类型 | 推断 | MarkdownView.tsx:657-671,739 | LLM 输出/异构列表 |
| D9 | `<callout>` 剥离丢失 emoji 与背景色 | 观察(剥离逻辑) | MarkdownView.tsx:122-123 | callout 块 |
| D13 | 段落硬换行以空格拼接，中文句中插空格 | 推断 | MarkdownView.tsx:701 | 硬换行段落（LLM 输出多见） |
| D14 | 代码围栏 info string 含空格时不识别为代码块 | 推断 | MarkdownView.tsx:578,583 | 带属性围栏（LLM 输出可能） |
| D6 | 有序列表起始编号丢失（3. 渲染为 1.） | 推断 | MarkdownView.tsx:657-671,739 | 非起始编号列表 |
| D12 | `<span style>` 样式被剥离，颜色/高亮丢失 | 观察(剥离逻辑) | MarkdownView.tsx:294 + span 分支 | 彩色文字导出 |
| D11 | HTML `<a>` 非引号 href 字符类写错（`[^\\s>]`） | 观察(源码) | MarkdownView.tsx:461 | 非引号属性（罕见） |
| D15 | 图片 title 语法污染 src 致 404 | 推断 | MarkdownView.tsx:326 | `![a](u "t")` 形态 |
| D16 | `*斜体*` 误匹配乘号式文本（`2*3*4`） | 推断 | MarkdownView.tsx:294 | 数学/星号文本 |
| D17 | 嵌套 HTML 表格被非贪婪截断，残片泄漏 | 推断 | html-table.ts extractHtmlTableBlocks；MarkdownView.tsx:608-626 | 产物存在嵌套表格时（待样本） |
| D18 | 无属性裸 `<sheet>` 标签不触发兜底提示 | 推断 | MarkdownView.tsx:133 | 罕见形态 |

优先级：内容丢失/错误（D2、D4、D3、D19、D1）＞ 展示瑕疵（D5、D10、D8、D7、D9、D13、D14、D6、D12、D11、D15、D16、D17、D18）。

---

## ① 渲染器支持子集清单（观察）

入口：`MarkdownView` → `preprocess()`（MarkdownView.tsx:109-141）→ `parseBlocks()`（:563）→ `renderBlock/renderList`（:739,791）→ `renderInline()`（:294 起的 INLINE_RE 分支）。

**preprocess 预处理**（全文替换，先于块解析）：
- XML 媒体标签（image/img/file/source/whiteboard，token|src 属性，MarkdownView.tsx:41）值为本地图片扩展名时 → `![媒体](路径)`（:113-115）
- 剥 `<synced-source>` 包裹（:117-118）、剥 HTML 注释（:124-126，含文件头 feishu_sync YAML）、剥 `<callout>` 包裹（:122-123）
- `<table` 前后注入空行（:128-129）；`<sheet …>` 兜底为提示引用块（:131-141）

**块级**（parseBlocks，MarkdownView.tsx:563-707）：
- ATX 标题 `#`~`######`（顶格+空格，:594 区域）；水平线 `-`/`*`/`_` ≥3（:603）
- ``` 围栏代码块：开栏 `^```(\S*)\s*$`、闭栏 `^```\s*$`（:578-583），语言标记仅展示
- 块级 HTML `<table>`（:608-626）→ html-table.ts：colgroup/col（span,width）、thead/tbody/tfoot、th/td 的 colspan/rowspan/align/valign/白名单 style（vertical-align、text-align、width、color、background 等 8 项）、安全过滤（剥 script/style/iframe/object、on* 属性、javascript: href）
- GFM 管道表格（:629-654）：对齐行 `:---`/`:---:`/`---:`、`\|` 转义（splitTableRow）、缺列自动补齐
- 列表 `-`/`*`/`+`/`1.`/`1)`（:657-671）：按缩进marginLeft嵌套，整块 ordered 由首项决定
- 引用块 `>`（:669 区域）；段落=连续普通行以空格拼接（:701）
- 渲染器**不支持**：任务列表、数学公式、脚注、setext 标题、`~~~` 围栏、4 空格缩进代码、details/summary、块级 HTML（table 外）、列表项多段落

**行内**（INLINE_RE，MarkdownView.tsx:294 + renderInline）：
- `**粗体**`、`*斜体*`、`~~删除线~~`、`` `行内码` ``、`[链接](url)`（sanitizeHref 协议白名单 http/https/mailto/相对路径，:66-88）、`![图片]`（相对路径经 getMediaBlobUrl 鉴权 fetch，远程 URL auto/confirm 策略）
- `<cite doc-id/title/user-name>` → wiki 链接/@提及（feishu-cite.ts parseCiteTag）
- 行内 HTML 白名单：b|strong、i|em、br、del|s、code、a（同白名单）、span（**样式剥离**）

## ② 同步产物结构谱系（观察）

1. **docx（结构树 + 自定义归档）**：lark-cli `docs +fetch` markdown，含 `<image|img token/src>`、`<file|source token>`、`<whiteboard token>`、`<callout>`、`<cite>`、`<sheet sheet-id token>`、`<synced-source>` 标签 → `rewriteFeishuMediaReferences`（media-reference.ts）token→本地路径 → **仅结构树链路**再经 `renderLocalizedMediaReferences`（sync-engine.ts:1392-1404，:613 调用）：whiteboard→`![飞书白板](…)`、file/source→`[文件名](attachments/…)`；`<sheet>` 由 expandInlineSheetTags 展开为 `## 子表:` 段（sync-engine.ts:697,1651）；slides 追加 `## 媒体资源` 段（:1420）
2. **sheet**：LayoutReconstructor 五型重构（layout-reconstructor.ts:196-216）：A 元数据→`<details><summary>元数据</summary>`（:223-229）；B 层级→缩进列表（:231）；C 数据表→GFM 表（:244，**无转义**）；D 段落（:269）；E 稀疏→`* **key**：value`（:277）；段格式 `## 子表: 标题`+`[CSV 原始数据](…csv)`（sync-engine.ts:697）；浮动图片附录 `### 子表图片资源`+缩进图片行（sheet-media.ts:558-572）
3. **bitable**：确定性渲染（bitable-exporter.ts:943-979）：`# 标题`/`>` 概览/`## 数据表:`/`### 字段`/`### 记录` GFM 表（单元格经 escapeMdCell 转义 `|` 与换行→`<br>`，:401-404）/`## Base 元数据存档`，`---` 分隔
4. **文件头**：`<!-- feishu_sync: … -->` YAML 注释（sync-engine.ts:1454-1499）
5. **LLM 风格对齐输出**（可选 enableLLM，B6 失败兜底保留重构结果，sync-engine.ts:711-784）：任意 markdown，形态不受生成端约束

## ③ 缺陷清单

格式：样例为可直接复现的 md 片段；表现/根因为代码路径推断或观察；行号为本次读取时点。

### 内容丢失/错误类

**D2｜preprocess 不区分代码围栏，破坏代码块内容**（高）
- 样例：
  ```` ```html\n<!-- 示例注释 -->\n<div>x</div>\n``` ````
- 表现：步骤3 `/<!--[\s\S]*?-->/g` 跨行跨围栏删除，代码块内注释被删；若代码块含未闭合 `<!--`，非贪婪匹配吞到文中下一个 `-->`，**丢失中间全部正文（含闭栏）**。步骤5 对代码内行中 `<table` 注入换行；步骤6 将代码内 `<sheet …>` 替换为提示引用；步骤4 同理剥代码内 `<callout>`。
- 根因：MarkdownView.tsx:124-126（注释剥离）、128-129（table 注入）、131-141（sheet 替换）、122-123（callout）——均在 parseBlocks 前对全文执行。
- 修复落点：MarkdownView.tsx `preprocess()` —— 按围栏切段，仅对非代码段做替换（或先 tokenize 围栏再逐段处理）。

**D4｜datatable 单元格未转义 `|`/换行，预览表格断裂**（高）
- 样例（CSV 单元格 `A|B` 与多行文本）：`| A|B | 说明 |\n| --- | --- |\n| x\n续行 | y |`
- 表现：`A|B` 被拆成 2 列 → 列错位/幻影列；含换行的单元格使 GFM 表格收集中断，后续行降级为段落，表格结构破坏。
- 根因：layout-reconstructor.ts:244-268 `reconstructDatatable` 直接 `' | '` join，无转义；同仓库正确实现已存在（bitable-exporter.ts:401-404 `escapeMdCell`：`\|`→`\\\|`、`\n`→`<br>`），渲染器 `<br>` 支持闭环。
- 修复落点：layout-reconstructor.ts `reconstructDatatable()`（镜像 escapeMdCell）；A/B/E 型列表路径同样建议做换行折叠。

**D3｜自定义归档附件标签原文泄漏且不可点击**（高）
- 样例：`<file token="attachments/01-需求包.pdf"/>`（或 `<source …>`、包裹式 `<file token="…">名称</file>`）
- 表现：自定义归档链路只做 token→`attachments/xx` 改写（custom-doc-sync.ts:230），**不执行** sync-engine 的 renderLocalizedMediaReferences（sync-engine.ts:1392，仅 ：613 结构树链路调用）；渲染端 XML_MEDIA_RE（MarkdownView.tsx:41）虽匹配 file/source，但 `looksLikeLocalMedia`（约 ：100）按图片扩展名过滤，`.pdf` 等不中 → 原标签整段按文本显示，附件入口丢失。
- 根因：生产端 custom-doc-sync.ts:230 缺转换步骤；消费端 MarkdownView.tsx:113-115 只把图片扩展名转图片。
- 修复落点：MarkdownView.tsx `preprocess()` 将 file/source 本地路径转 `[basename](路径)` 链接（消费端修法可同时覆盖历史产物）；或 custom-doc-sync 归档时复用 renderLocalizedMediaReferences（生产端修法）。

**D19｜包裹式媒体标签转换后残留闭合标签**（高）
- 样例：`<whiteboard token="images/a.png">板书</whiteboard>`、`<image token="images/b.png"></image>`
- 表现：XML_MEDIA_RE 只消费到首个 `>`，开头标签转 `![媒体](…)` 后，`</whiteboard>`/`</image>` 残留为正文文本。
- 根因：MarkdownView.tsx:41-43 正则无闭合标签消费；旁证——sync-engine.ts:1394/1399-1404 生产端转换特意带 `(?:\s*<\/whiteboard>)?` / `(?:<\/(?:file|source)>)?`，说明产物中包裹式形态实际存在。
- 修复落点：MarkdownView.tsx `XML_MEDIA_RE` 追加可选闭合标签匹配（镜像 sync-engine 写法）。

**D1｜`<details>` 元数据块按原文泄漏**（高）
- 样例（sheet A 型块实际产物，layout-reconstructor.ts:223-229）：
  ```
  <details>
  <summary>元数据</summary>

  * 更新日志：2026-06-15
  </details>
  ```
- 表现：`<details>`/`<summary>` 不在 preprocess 剥离表与 INLINE_RE 白名单（:294）→ 首两行并入段落显示字面 `<details> <summary>元数据</summary>`；`</details>` 独立段落再次泄漏。全部 sheet 类文档只要有 A 型块（首格含"更新日志/作者/版本/日期"等关键词）即触发。
- 根因：生产端 layout-reconstructor.ts:223-229 输出 HTML 折叠块；消费端 MarkdownView 无对应处理。
- 修复落点：MarkdownView `preprocess()` 将 details 块降级为引用/提示块，或 parseBlocks 新增 `details` 块型（可折叠渲染）；或生产端改输出引用块。

### 展示瑕疵类

**D5｜任务列表字面显示**（中）：`- [ ] 待办` → 列表项文本 "[ ] 待办"。根因 MarkdownView.tsx:657（列表正则无 checkbox 语义）、renderList:739。修复：renderList 识别 `[ ]`/`[x]` 前缀渲染 ☐/☑。
**D10｜非白名单行内标签泄漏**（中，待样本确认形态）：`<u>下划线</u>`、`<mark>高亮</mark>`、`<sub>/<sup>/<font>` 原文显示。根因 MarkdownView.tsx:294。修复：扩充行内白名单或"未知标签剥壳保内容"兜底。
**D8｜列表项续行脱离**（中低）：子表图片附录（sheet-media.ts:568-569 实际产物 `- **单元格 A1 浮动图片**…` + 缩进 `  ![…]`）中，缩进行不匹配列表正则 → 列表块提前结束，图片成独立段落。根因 MarkdownView.tsx:660-665。修复：列表收集循环容忍缩进续行归并前项。
**D7｜混合列表标记类型丢失**（中低）：`- 父项`+缩进 `1. 子项` 同块时整块按首项 unordered 渲染，子级 `1.` 标记丢失仅剩缩进。根因 MarkdownView.tsx:657-671+renderList:739（未递归构树）。修复：renderList 按标记+缩进递归构嵌套 ol/ul。
**D9｜callout 语义丢失**（中低）：`<callout emoji-id="warning" background-color="yellow">` 整开标签被剥（MarkdownView.tsx:122-123），emoji/底色消失，内容降为普通块。修复：转带样式的提示块。
**D13｜硬换行段落插空格**（中低）：中文段落行以空格拼接（MarkdownView.tsx:701 `buf.join(' ')`），句中出现多余空格。修复：CJK 相邻行无空格拼接或保真换行（需权衡）。
**D14｜围栏 info string 含空格不识别**（中低）：```` ```ts title="x" ```` 不匹配 `^```(\S*)\s*$`（MarkdownView.tsx:578）→ 围栏行成段落、代码内容按普通块泄漏。修复：开/闭栏正则容忍 info string。
**D6｜有序列表起始编号丢失**（低中）：`3. x` 渲染为 1（:657 丢弃标记数字，renderList 无 start 属性）。修复：首项数字→`<ol start>`。
**D12｜span 样式剥离**（低）：`<span style="color:red">` 只留内容（span 分支不解析 style）。修复：白名单解析 color/font-weight（镜像 parseSafeInlineStyle）。
**D11｜`<a>` 非引号 href 字符类错误**（低）：MarkdownView.tsx:461 `([^\\s>]+)` 在字符类中排除字面 `s`，非引号 href（含 https/images）在 `s` 处截断；引号形态（产物主流）不受影响。修复：改为 `[^\s>]`。
**D15｜图片 title 污染 src**（低）：`![a](images/a.png "标题")` 的 src 未剥 title（MarkdownView.tsx:326）→ 鉴权 fetch 404 → "图片加载失败"。修复：图片分支剥离 ` "title"`。
**D16｜斜体误匹配**（低）：`2*3*4` 中 `*3*` 被转斜体（INLINE_RE 无 flanking 规则，:294）。修复：加 CommonMark 侧边界约束。
**D17｜嵌套 HTML 表格截断**（低，待样本）：`<table>…<table>…</table>…</table>` 被非贪婪截断，残片泄漏。根因 html-table.ts `extractHtmlTableBlocks` 与 MarkdownView.tsx:608-626 收集逻辑。修复：深度计数匹配（若确认产物无嵌套可接受局限）。
**D18｜裸 `<sheet>` 不触发兜底**（低）：`<sheet></sheet>`（无属性）不匹配 `/<sheet\s+…/`（MarkdownView.tsx:133）→ 原文泄漏。修复：正则容忍无属性形态。

## ④ 测试覆盖现状

已锚定（观察）：
- src/utils/html-table.test.ts：实体解码、style 白名单、sanitize（script/on*/javascript:）、thead/tbody/colspan/rowspan 解析
- src/components/preview/MarkdownView.test.tsx：HTML 表格块（含单行形态）、cite 渲染与三级降级、resolveMediaPath 反斜杠归一、括号文件名 src 完整性、sanitizeHref 协议白名单全矩阵、远程图片 confirm 策略
- server/tests/media-reference.test.ts：token→本地路径改写（D3 的改写半边）
- server/tests/sheet-media.test.ts：浮动图片注入/附录，集成式引用真实 LayoutReconstructor（:610）
- server/tests/atomic-commit.test.ts:119-121：`## 子表:` 段与 CSV 链接
- server/tests/bitable-exporter.test.ts:242-248,554-555：bitable md 结构（escapeMdCell 路径有断言）

缺口（无任何测试锚定）：
- **layout-reconstructor 无专项测试文件**：五型分类与产物形态（含 A 型 `<details>`、C 型未转义）无直接断言 → D1/D4 无回归保护
- **preprocess 零测试**：XML 媒体转换、synced-source/callout/注释剥离、sheet 兜底均无断言 → D2/D3/D19 无保护
- 列表细节（D5/D6/D7/D8）、围栏 info string（D14）、img title（D15）、嵌套表格（D17）均无测试
- 无跨层「服务端产物 → MarkdownView 渲染」端到端用例（生成端测试只断言字符串包含，未过渲染器）

## ⑤ 需真实样本确认清单

本机无生产数据根（`~/.feishu-sync` 不存在），以下形态无法从代码闭环判定：
1. 飞书 docx 公式导出形态（`$…$`/`$$…$$`/`<formula>`？渲染器无数学支持，若存在则新增缺陷项）
2. mermaid/画板块的导出形态（whiteboard 已覆盖；是否存在 mermaid 代码块）
3. 下划线/高亮/上标等行内样式的真实导出标签（决定 D10 修复面）
4. 任务列表（待办块）导出语法（决定 D5 触发面）
5. 未知新块型（投票/Iframe/小组件等）是否以裸标签落盘
6. sheet CSV 单元格含 `|`/换行的真实频率与形态（定 D4 严重度）
7. LLM 对齐输出的实际风格：硬换行、任务列表、带属性围栏、图片 title（定 D13/D14/D15 触发面）
8. 历史产物中 HTML 表格是否嵌套、同段多表相邻（定 D17 修复必要性）
9. `<synced-source>` 实际包裹范围（行内/块级；现有剥离已兼容两种，风险低）
10. slides `## 媒体资源` 段在真实产物中的完整性

## 覆盖范围与负面发现

- 已覆盖：任务书指定的 6 份必读文件全部读完；另精读 feishu-cite.ts、sheet-media.ts 附录段、bitable-exporter 渲染段、custom-doc-sync 归档段、media-gap.ts 残留扫描、sync-engine 产物生成段（:594-980,1370-1500,1631-1700）、两端全部测试文件清单与关键断言。
- 负面发现：未找到 layout-reconstructor 专项测试；未找到 preprocess 相关测试；未在仓库中发现数学公式/任务列表/脚注的任何处理痕迹（渲染端与生成端均无）——此为「搜索边界内未找到」，不代表飞书产物中不存在。
- 行为推断未经浏览器执行验证（只读约束）；关键推断（D1/D4/D19）均有生产端输出代码与消费端正则的直接对照，锚点已列。
