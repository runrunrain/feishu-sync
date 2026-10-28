# T2a-r 修复报告：MarkdownView 渲染端缺陷（T0a 清单渲染侧）

- 分支：feat/agent-knowledge-workbench（共享树）
- 改动文件（全部在授权写面内）：
  - `src/components/preview/MarkdownView.tsx`（修改）
  - `src/utils/html-table.ts`（修改）
  - `src/components/preview/MarkdownView.defects.test.tsx`（新增，44 用例）
- 未触碰 `server/`（产物生成端缺陷由并行切片 T2a-p 处理；git status 中 server/ 的改动为兄弟任务产物，非本任务写入）。
- 证据形态：vitest + `react-dom/server` renderToStaticMarkup 锚定渲染输出 DOM（代码库既有测试形态，无 jsdom/testing-library 依赖——项目未安装 testing-library，零运行时依赖约束保持）。

## 验证链（先测后修的 RED→GREEN 闭环）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED（修复前） | `npx vitest run src/components/preview/MarkdownView.defects.test.tsx` | 27 failed / 16 passed（16 项为回归守护或旧代码巧合通过，其中 3 处断言已加固为真区分度：SSR 转义形态 `&lt;/image&gt;`、`&lt;!--`、D8 同 `<li>` 归属） |
| GREEN（修复后） | 同上 | 44 passed / 44 |
| 全量前端测试 | `npm test` | 18 files / 160 tests 全绿 |
| 类型检查 | `npm run typecheck`（root + node + server 三段） | 通过 |
| Lint | `npx eslint src/components/preview/ src/utils/html-table.ts` | 0 error 0 warning（仓库其余 3 个 warning 为既有遗留，非本任务文件） |
| 格式 | `npx prettier --check src/components/preview/MarkdownView.defects.test.tsx` | 新文件符合配置 |

过程偏差记录：首次收尾误对两个**遗留未格式化文件**（渐进采纳治理 G1 对象）执行了 `prettier --write`，产生 843+/428- 的无语义重排 diff；已恢复 HEAD 基线后按文件既有风格重放全部语义修改，终态 diff 为 486+/84-（语义等价性经「剥离空白/分号后逐字节比对」与格式化版本核验一致）。

## 逐项缺陷：编号 → 修复方式 → 测试锚点

测试锚点均指 `src/components/preview/MarkdownView.defects.test.tsx` 的 describe 块。

| 编号 | 修复方式（文件:函数） | 测试锚点 |
|---|---|---|
| D2 高 | `preprocess()` 重构为围栏切段：开栏 `/^```/`、闭栏 `/^```\s*$/`（与 parseBlocks 同规则），所有替换仅作用于非代码段 `transformTextSegment()`；未闭合 `<!--` 只剥标记不吞正文（第二次 `/<!--/g` 清理） | D2（6 用例，含 feishu_sync 头回归） |
| D19 高 | `XML_MEDIA_RE` 追加 `(?:[^<]*<\/\1\s*>)?` 可选包裹内容+闭合标签（镜像 sync-engine renderLocalizedMediaReferences 写法；`[^<]*` 防跨标签贪婪） | D19（3 用例） |
| D1 渲染侧 高 | parseBlocks 新增 `details` 块型：`<details>` 收集至 `</details>`，提取 `<summary>`，内容递归 parseBlocks；renderBlock 渲染原生 `<details>` 折叠区块（React 受控元素，无 raw HTML 注入） | D1（2 用例）+ 综合冒烟 |
| D17 渲染侧兜底（任务书编号，T0a 实为 D18）低 | `<sheet>` 兜底正则 `<sheet\s+…` 改 `<sheet\b([^>]*?)\/?>`，容忍无属性裸标签与自闭合 | D18（2 用例，含带属性回归） |
| D17 嵌套表格 低 | 三处：① `extractHtmlTableBlocks` 改 `<table>` 开/闭深度计数匹配；② parseBlocks 块收集按 `tableDepthDelta` 深度闭合（内层 `</table>` 不提前闭块）；③ 单元格内容剥离嵌套结构标签保文字（内层行降级并入外层，内容保真无泄漏） | D17（2 用例：单行/多行嵌套） |
| D3 渲染侧兜底 高（额外覆盖） | `transformTextSegment` 步骤1 扩展：file/source 的本地非图片路径（含 `/` 或扩展名；飞书 token 不中）转 `[basename](路径)` 链接——消费端兜底，同时覆盖自定义归档历史产物 | D3（3 用例，含 token 不误转） |
| D5 中 | `renderListNodes` 列表项文本匹配 `[ ]`/`[x]` 前缀 → 渲染 ☐/☑ 勾选框（`data-md-task` 标记 + aria-label） | D5（1 用例） |
| D10 中 | INLINE_RE 扩充 `u/ins/mark/sub/sup/font` 白名单 + renderInline 分支：u/ins→`<u>`，mark→高亮，sub/sup→原生标签，font→color 白名单（`FONT_COLOR_RE`：#hex + 常用命名色），非法值降级保内容 | D10（2 用例） |
| D8 中低 | 列表收集循环新增缩进续行归并（`isListContinuationLine`：缩进普通行并入前项文本，CJK-aware 拼接；块起点行与紧随 GFM 表格仍结束列表） | D8（2 用例，含同 `<li>` 归属断言） |
| D7 中低 | 列表重写为树：`ListItemData` 逐项记录 `ordered`/`num`，`buildListTree` 按缩进构树，`renderListNodes` 递归渲染嵌套 ol/ul（子级保留自身标记类型；替代旧 marginLeft 平铺缩进） | D7（2 用例，含同构回归） |
| D9 中低 | parseBlocks 新增 `callout` 块型（emoji-id/background-color 解析，自闭合/未闭合宽容）；renderBlock 渲染提示卡：`CALLOUT_EMOJI` 字形映射（19 项，未知降级 💬）+ `CALLOUT_TONE` 底色类映射（9 色，未知降级中性色）；preprocess 的整段剥除已移除（该剥除即 emoji/底色丢失根因） | D9（2 用例）+ 综合冒烟 |
| D13 中低 | `joinParagraphLines`/`appendCjkAware`：两侧边界均 CJK（`\u3000-\u9fff\uff00-\uffef`）无空格拼接，否则保留单空格；段落与列表续行共用 | D13（3 用例） |
| D14 中低 | 开栏正则 `^```(\S*)\s*$` → `^```(.*)$`（info string 整行为语言标记，闭栏规则不变）；preprocess 分段用同规则 | D14（2 用例） |
| D6 低中 | 首项编号 `num` 透传 `<ol start>`；起始 1 不输出（保持既有输出） | D6（2 用例） |
| D12 低 | span 分支解析 `style` 属性 → `parseSafeInlineStyle` 白名单（color/font-weight/… 8 项，阻断 expression/url(/引号），安全子集以 React style 应用 | D12（2 用例） |
| D11 低 | `<a>` 非引号 href 正则字符类 `[^\\s>]`（误排除字面 `s`）修正为 `[^\s>]` | D11（1 用例） |
| D15 低 | `stripMdTitle()`：图片 src 与链接 href 剥离尾随 title（` "…"` / `'…'` / `(…)` 三形态），防鉴权 fetch 404 | D15（3 用例） |
| D16 低 | INLINE_RE 斜体组加侧边界 `(?<![\w*])…(?![\w*])`：`2*3*4` 不再误判；ASCII 词内斜体让渡（如 `a*b*c`，CommonMark 会判 em，此处保守拒绝以压制数学误报），CJK 强调不受影响 | D16（3 用例） |

统计：修复 17 项缺陷编号（16 项任务书列举 + D3 渲染侧兜底额外覆盖），新增测试 44 用例（其中 8 个为既有行为回归守护），另加综合冒烟 1 用例（真实 sheet 产物形态组合：A 型 details + 浮动图片附录 + 围栏 + callout + CSV 链接）。

## 未修项及原因

| 项 | 原因 |
|---|---|
| D4（datatable 单元格未转义） | 根因在生成端 `layout-reconstructor.ts:244-268`（server/，任务书明确不改，由 T2a-p 处理）；渲染端 `splitTableRow` 已正确处理 `\|` 转义与 `<br>`，无渲染侧可修内容 |
| D3 生产端修法（custom-doc-sync 复用 renderLocalizedMediaReferences） | server/ 边界外；本任务以渲染端兜底覆盖历史产物，新生成端行为由 T2a-p 决定 |
| D17 嵌套表格的「单元格内完整子表」渲染 | 深度匹配已消除截断/泄漏；单元格内子表降级为文字并入（剥结构标签）。完整递归子表渲染待真实样本确认必要性（T0a §⑤-8）后另行设计 |
| D9 callout 底色未映射值 | 飞书 background-color 实际取值域未知（可能为 `larkYellow` 等内部名），映射表覆盖 9 个常用色名，未知降级中性色，待真实样本扩展 `CALLOUT_TONE` |
| D16 ASCII 词内斜体 | 侧边界约束的保守取舍，见上表说明 |

## 需真实样本确认清单（T0a §⑤，本任务不盲目修复）

1. 飞书 docx 公式导出形态（`$…$`/`$$…$$`/`<formula>`）
2. mermaid/画板块导出形态（whiteboard 已覆盖）
3. 下划线/高亮/上标真实导出标签形态（本任务按 T0a 样例形态 u/mark/sub/sup/font 实现）
4. 任务列表（待办块）导出语法（按 GFM `- [ ]` 形态实现）
5. 未知新块型（投票/Iframe/小组件）裸标签落盘形态
6. sheet CSV 单元格含 `|`/换行的真实频率（D4 严重度定级）
7. LLM 对齐输出实际风格（硬换行/任务列表/带属性围栏/图片 title 触发面——对应修复已按 GFM 语义实现）
8. 历史产物 HTML 表格嵌套/同段多表相邻形态
9. `<synced-source>` 实际包裹范围（现有剥离已兼容行内/块级）
10. slides `## 媒体资源` 段完整性

## 安全面核对（不放宽既有语义）

- `sanitizeHref` 协议白名单与降级行为零改动（新增 D3 附件链接走同一 renderInline 链路受其约束）。
- 受控 HTML 表格白名单零放宽；span/font 样式经 `parseSafeInlineStyle`/`FONT_COLOR_RE` 白名单，阻断 expression/url(/javascript。
- 新增标签渲染均为 React 受控元素（u/mark/sub/sup/details/callout），无 dangerouslySetInnerHTML，属性不透传（font 仅白名单 color）。
- callout 底色为静态类名映射表（tailwind 扫描可静态分析），不接收任意 style 字符串。

## 回滚方式

`git checkout -- src/components/preview/MarkdownView.tsx src/utils/html-table.ts && rm src/components/preview/MarkdownView.defects.test.tsx`（仅本任务三文件，不涉及其他工作区改动）。
