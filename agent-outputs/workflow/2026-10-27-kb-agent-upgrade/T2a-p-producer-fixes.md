# T2a-p 修复报告：同步产物生成端缺陷（T0a 清单生成侧）

- 项目：/Users/run.mao/workpace/feishu-sync（分支 feat/agent-knowledge-workbench）
- 上游输入：`agent-outputs/workflow/2026-10-27-kb-agent-upgrade/T0a-markdown-preview-defects.md`
- 改动文件：
  - `server/src/modules/layout-reconstructor.ts`（D4 转义 + A/B/E 折叠）
  - `server/src/modules/custom-doc-sync.ts`（D3 媒体引用本地化）
  - `server/tests/layout-reconstructor.test.ts`（新增，此前无专项测试）
  - `server/tests/custom-folders.test.ts`（追加 D3 用例 describe 块）

## 一、逐项缺陷 → 修复方式 → 测试锚点

### D4（高）datatable 单元格 `|`/换行未转义 → 表格断裂

- **修复**：`layout-reconstructor.ts` 新增模块级 `escapeMdCell()`（`\|` → `\\|`、`\r?\n` → `<br>`，镜像 `bitable-exporter.ts:401-404`），在 `reconstructDatatable()` 中对表头行与数据行**每个单元格**应用后再 join。
- **共享函数评估**（任务书要求）：未抽共享模块，采用 local copy。理由：① 两模块职责独立（bitable 走 base API 确定性渲染，本模块走 sheet CSV 五型重构），抽公共模块制造跨职责依赖；② 仓库已有同型先例（`custom-doc-sync.ts` `colToLetter` 的 local-copy 约定）；③ 2 行纯函数。两份实现注释互指，改任一侧须同步另一侧。
- **附带修复**（T0a D4 修复落点段建议）：A/B/E 型每行产出一个 `* ` 列表项，单元格内换行会拆散列表结构——新增 `foldCellNewlines()`（仅折叠换行，不转义 `|`，列表路径无表格列语义）应用于 `reconstructMetadata`（A）、`reconstructHierarchy`（B）、`reconstructSparse`（E）。D 型段落路径换行无害（渲染端按段落行拼接），不动。
- **测试锚点**：`server/tests/layout-reconstructor.test.ts`
  - 「转义 | 与换行：含特殊字符的单元格不拆散表格列」——断言精确行 `| alpha | p\|q | 两行<br>续行 |`；
  - 「表头单元格同样转义」——`字段|A` 表头 → `| 字段\|A |…`，并用 `(?<!\\)\|` 计数断言每行恒 4 个未转义分隔符（3 列）；
  - A/B/E 折叠三用例：断言 `<br>` 折叠后列表项仍单行（`* ` 前缀行数不变）。

### D3（高）自定义归档缺 `renderLocalizedMediaReferences` → 附件标签原文泄漏

- **修复**：`custom-doc-sync.ts` `syncDocxToCustomFolder()` step 3 改为与主链路完全一致的两步组合（镜像 `sync-engine.ts:613-615`）：`renderLocalizedMediaReferences(rewriteFeishuMediaReferences(content, localMediaReferences))`。白板 → `![飞书白板](images/…)`、file/source → `[basename](attachments/…)` 可点击链接。
- **实现形态**：local copy（`renderLocalizedMediaReferences` 函数，正则与 sync-engine.ts:1392-1404 逐字符一致）。理由：引擎方法是 private 且绑定引擎类，本模块按文件头约定组合构件而不实例化引擎（同 `colToLetter` 先例）。注释声明「行为必须与引擎侧保持一致，两处一起改」。
- **测试锚点**：`server/tests/custom-folders.test.ts` 追加 describe「custom-folder media rendering (T0a D3 producer fix)」——docx 含 `<file token name="需求说明.pdf"/>` + 包裹式 `<whiteboard token>\n</whiteboard>`，走完整路由 + 原子提交管线，断言：产物 md 含 `[01-<token>.png](attachments/01-<token>.png)` 与 `![飞书白板](images/01-<token>.png)`、不含 `<file `/`<whiteboard` 残留、附件字节真实落盘 `_custom/Archive/attachments/`。

### D1（生成侧评估）sheet A 型 `<details><summary>元数据</summary>`

- **决策：生成端不改**，D1 由渲染端切片（T2a-r）修复。理由：
  1. 产物格式是标准可移植 HTML（GitHub/VS Code 等主流渲染器原生折叠显示），改为引用块会在标准渲染器中**降级**现有体验；
  2. 渲染端修复（MarkdownView 支持 details 块）**同时覆盖存量文件**，生成端改格式只影响下次同步的新文件——修复面严格劣于渲染端；
  3. 与并行切片协调：T2a-r 按 T0a 主修复落点（`MarkdownView preprocess()/parseBlocks`）实施，生成端此时改格式会造成两条链路对同一形态的双重语义；
  4. 本轮 A 型折叠输出补了单元格换行折叠（见 D4 附带），details 内部列表在渲染端支持 details 后即可正确显示。
- **测试锚点**：A 型产物形态由 `layout-reconstructor.test.ts`「A 型 metadata」用例锚定（`<details>` 结构 + 折叠后单行列表项），为 T2a-r 渲染端用例提供固定产物契约。

### 其他 T0a 项生成端落点核查（任务书第 4 条）

| 项 | 生成端落点 | 处置 |
|---|---|---|
| D19 残留闭合标签 | sync-engine 生成侧已消费 `\s*` 闭合（:1394/:1399-1404）；custom-doc-sync 经本轮 D3 修复获得同款消费 | 已闭合（custom 侧）；渲染端半边归 T2a-r |
| D8 列表续行脱离 | 产物形态在 sheet-media.ts（不在本切片写面），修复落点为渲染端列表收集 | 归 T2a-r |
| D2/D5-D18 | 修复落点全部在 `src/` 渲染端（MarkdownView/html-table/feishu-cite） | 归 T2a-r，本切片零接触 |

## 二、产物契约与同步基线

- `feishu_sync` header、sheet A/B/C/D/E 五型分型、`## 子表:` 段格式、CSV 附件链接全部不变；改动只在单元格/列表项**呈现层**转义。
- 同步基线判定基于 `obj_edit_time`（检测）与 staged 原子提交（同步），不比对产物 md 内容——转义不影响基线，不会触发重同步风暴。

## 三、存量文件处理建议（本轮不做存量重写）

- **D3（自定义归档附件标签）**：存量归档正文里的 `<file token="attachments/…">` 可由 T2a-r 渲染端修法兜底（T0a 已注明「消费端修法可同时覆盖历史产物」）——渲染端 preprocess 将本地路径 file/source 转链接即可，无需重写文件。
- **D1（details 块）**：同上，渲染端支持 details 后存量文件直接受益。
- **D4（表格转义）**：存量产物的表格结构**已在文件内断裂**（列已拆散/行已断开），渲染端无法从产物恢复，只能重新生成：① 等云端 `obj_edit_time` 变化触发自然重同步；② 对重点文档做一次性重同步（重置该文档 synced/observed 基线或云端轻微编辑）；自定义归档文档可删除后经快捷添加重新归档。若面广，可后续评估「按 header 指纹批量重同步」工具（超出本切片，未实施）。

## 四、验证证据

- 针对性：`npx vitest run tests/layout-reconstructor.test.ts tests/custom-folders.test.ts tests/sheet-media.test.ts tests/bitable-exporter.test.ts tests/atomic-commit.test.ts` → 5 files / 98 tests 全绿（覆盖新用例 + LayoutReconstructor 的既有间接消费者）。
- 全量：`cd server && npm test` → **69 files / 866 tests 全绿**；`npm run typecheck`（tsc --noEmit）→ 通过，exit 0。
- 未遇 better-sqlite3 ABI 问题（Node ABI 正常，无需 rebuild）。

## 五、未覆盖与已知边界

1. **文本包裹式白板** `<whiteboard …>板书</whiteboard>`（包裹内容非空白）：本轮正则与主链路逐字符一致（`(?:\s*<\/whiteboard>)?`），此类形态会残留 `板书</whiteboard>` 字面文本——与主链路现状**一致**（两侧行为统一优先）。T0a §⑤ 未确认该形态真实存在；若真实样本证实，建议后续对 sync-engine 与 custom-doc-sync **两处一起**升级为有界捕获（如 `(?:([^<>]*)<\/whiteboard>)?` 并把捕获文本用作图片 alt），本切片写面不含 sync-engine.ts，未单方面分叉。
2. 单元格已有字面 `\|` 会二次转义为 `\\|`（渲染为 `\|`）——与 bitable-exporter 既有行为一致，未单方面改变语义。
3. LLM 风格对齐输出（B6）不经过 LayoutReconstructor/custom-doc-sync 重构路径，本轮改动不影响该链路。
4. 渲染行为最终确认依赖 T2a-r 落地后的端到端预览验证（本切片只锚定生成端产物形态）。

## 六、回滚方式

```
git checkout -- server/src/modules/layout-reconstructor.ts server/src/modules/custom-doc-sync.ts server/tests/custom-folders.test.ts
rm server/tests/layout-reconstructor.test.ts
```
（上述 4 处改动全部由本任务产生，git status 已核对无其他归因混入。）
