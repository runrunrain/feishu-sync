# P1-S1 实测定型：reference_map / slides 截图 / 反向发布 parse

- **日期**：2026-10-28 · **CLI**：`lark-cli 1.0.98`（user 认证，自动 refresh 后可用）
- **方法**：专用 Drive 文件夹 `p1s1-larkcli-probe-1027`（token `UubtfDKTTlTt5jdKp0qc4oganJ3`）内自建自删：文档 A（title/parse 样本）、文档 B（四类引用样本 + 评论 + sheet 嵌入）、slides `p1s1-截图测试`（2 页）。测试对象 4 项已全部 `drive +delete --yes` 删除，fetch 复核返回 "Document page has been deleted"。
- **fixtures**：`server/tests/fixtures/p1s1-lark-cli/`（9 文件，租户域名/open_id/用户名已脱敏，token 为已删除资源仅留结构对照）。
- 上游：`lark-cli-newcaps-P1.md` §8（RP/SP/PB）与 §2.1/§3/§4.3 契约假设；probe（2026-10-27 零写取证）。

## 1. RP-1 reference_map 形态 —— **假设修正：引用不进 sidecar**

**命令**：`docs +fetch --api-version v2 --doc <t> --doc-format markdown --detail simple`（与 `fetchDocumentMarkdown` 同 argv）。变体覆盖：xml/im-markdown × simple/full/with-ids、省略 `--api-version`，共 6 组。

**实测**：
- 文档 B 含 @doc cite、@user cite、参考文献、普通链接、sheet 嵌入块——以上全部**内联正文 markdown**，`reference_map` 键**整体缺失**（document keys = `content/document_id/revision_id`）。
- 加一条全文评论后，`reference_map` 出现且**仅含 `comments` 组**：`{"comments":{"c1":{"data":"<comment comment-id=... is_whole=\"true\"><msg user=...>…</msg></comment>"}}}`。
- skill 参考原文：「XML、Markdown 和 IM Markdown **在存在可见评论时**都会返回该组」；`<html5-block data-ref>` 占位类资源才依赖 `reference_map["html5-block"][ref].data`（大体积资源 sidecar 场景）。

**结论 / 分支裁定（冲击 U32、S2 范围）**：
- RP-1 原问题「`--detail simple` 下是否含 reference_map」：**条件含**——有可提取数据（评论、html5-block 等）时 simple 也返回；@doc/@user 引用**不依赖也不出现**在 reference_map。
- **引用图的主体来源是正文内联标签**：`extractBodyReferences` 必须扩展为「markdown 链接 + `<cite doc-id>` + `<sheet token>` 等内联标签」双解析；`extractRefmapReferences` 通用扫描保留（排除 `comments`、覆盖 html5-block 类真 sidecar 组），接口不变。
- 请求体固定 `enable_user_cite_reference_map:true` 已实测不影响上述行为。

## 2. RP-2 引用与正文的对应 —— `<cite>` 内联，与 feishu-cite.ts 完全兼容

**实测正文形态**（`--doc-format markdown`）：

```
普通链接：[文档A的链接](https://<tenant>.feishu.cn/docx/<token>)
@文档：  <cite doc-id="<token>" file-type="docx" title="p1s1-发布测试A" type="doc"></cite>
@人：    <cite type="user" user-id="ou_xxx" user-name="测试用户"></cite>
嵌入表格：<sheet sheet-id="GGRbGT" token="PhQvsydSBhy0UStlHk0c3zoJnoe"></sheet>
```

- `src/utils/feishu-cite.ts` 的 `parseCiteTag` 属性名（doc-id/file-type/title/type/user-id/user-name）与 fetch 输出**逐一吻合，直接可用**。targetType 映射可依 `file-type`（实测 docx=「docx」，skill 佐证 wiki/sheets/bitable 取值）。服务端 `+update append` 后 fetch round-trip 保真（cite/sheet 属性无丢失）。
- **`<cite type="citation">`（参考文献容器）被 create 静默丢弃**：markdown 入参后正文/XML 均无该块、revision 正常推进、无 diagnostics 警告。→ 标准库内容若含参考文献形态，发布后丢失；v1 记为已知边界（`image_not_published` 同级的 `citation_dropped` 类警告可考虑，不阻断）。
- 代码块内 URL 不转链接（§2.1「代码块不计」假设成立）；表格分隔行 create→fetch 归一 `|---|`→`|-|`（确定性归一，无害）。

## 3. RP-3 空引用形态 —— 键整体缺失

无可提取数据（无评论）时 `reference_map` **不是** `{}`/`[]`/null，而是**整个键不存在**。解析器必须容错键缺失——`extractRefmapReferences(referenceMap: unknown)` 签名已兼容，S2 单测补「键缺失」样本（fixture：`fetch-no-refmap.json`）。

## 4. SP-1 slides 截图 scope —— 单 scope 成立；按纪律未授权

**实跑**（自建 2 页 slides `AhCksWVJYlAe31duDQoc3DxIn3b`）：`slides +screenshot --presentation <id> --slide-number 1 --output-dir …` → **exit=3**：

```json
{"error":{"type":"authorization","subtype":"missing_scope",
 "message":"missing required scope(s): slides:presentation:screenshot",
 "hint":"run `lark-cli auth login --scope \"slides:presentation:screenshot\" --no-wait --json` to get device_code and verification_url; present verification_url to the user exactly and end this turn; after the user confirms authorization, run `lark-cli auth login --device-code <device_code>` in a later turn to finish login",
 "missing_scopes":["slides:presentation:screenshot"]}}
```

- `missing_scopes` **仅此一项** → 「仅 `slides:presentation:screenshot`」假设成立（U37 注册表单条目即可）。
- **分支裁定（U37 授权交互）**：CLI hint 本身就是两段式 device flow（`--no-wait --json` 先取 verification_url 展示给用户 → 用户确认后 `--device-code` 完成）——与应用内 reauthorize 弹窗流程同构，§3.4 时序可直接落此模式；授权动作留给主上（本任务未执行）。
- 参数面：`--slide-number` 为 pflag ints，`"1,2"` 逗号形式解析通过（未报格式错，到达 scope 拦截）→ 设计 §3.2 argv 逗号拼接可用；help 明示单请求 ≤10 页、`--output-dir` 默认 `.lark-slides/screenshots`。
- **不可测**（如实标注）：输出文件路径形态、PNG 尺寸、多页批量与 JSON 映射——scope 未授权，零文件产生。待主上应用内授权后由 P1-S5 实施前补测（连同 SP-2/SP-3/SP-4）。

## 5. SP-2 截图失败形态 —— scope 校验先于一切，服务端行为不可达

dry-run、越界页 99、非法页 0、11 页超限：**全部同一 missing_scope 错误**。结论：
- CLI 客户端**无**页号/页数本地预校验；scope 检查最先执行。
- all-or-none 服务端语义（越界页整批拒绝）**当前授权下不可达**——P1-S5 实施时需在授权后先跑「单页 / 多页 / 越界」三态实测再固化 all-or-none 逻辑，验收清单已在设计 §3.5，S1 此项移交 S5 前置。

## 6. PB-1 create --title —— 响应含 token+URL；title 前置但不去重正文 H1

**命令**：`docs +create --doc-format markdown --title "p1s1-发布测试A" --content @docA.md --parent-token <folder>` → `data.document.{document_id, revision_id, url}`（**含 token+URL**，PB-2 假设成立）。

**fetch 回读**：正文首行 `<title>p1s1-发布测试A</title>`；正文内 H1 `# 内容内标题-应被覆盖` **原样保留**（CLI 只前置 title，不去重）。

**分支裁定（U39 / §4.3 渲染）**：「与标题相同的首个 H1 从正文移除」**必须由本地 `renderForPublish` 承担**，CLI 不代劳——设计已如此规定，实测确认其必要性。另两点入账：① fetch 回读的 `<title>` 行属于 content 首行，发布后 parse 校验的 char 口径对照应排除该行（见 PB-3）；② 附带确认 create 时 markdown 嵌 XML 标签（cite/sheet）会被解析生效而非字面量（skill 警告成立，转义规则见 lark-doc-xml.md）。

## 7. PB-2 parse 回读 —— profile 形态定型

**命令**：`docs +script --command parse --doc <token> --format json` → `data.profile = {word_count, char_count, block_count, blocks[]}`；`blocks[]` 为**块型统计** `[{type:"p",count:6,ratio:0.333},…]`（非块列表）；`data.assessment.status:"passed"`；diagnostics 空。样本：A `119/272/18`，B `62/68/10`。P2 字数统计输入假设成立（`docx:document:readonly` 在既有授权内）。

## 8. PB-3 char_count 口径（设计 PB-3 表项）

本地可见字符（去 md 标记、空白不计、剥引用标签保属性文字）对照：

| 样本 | 本地(含 title 行) | 本地(不含) | cloud char_count | 比值(不含口径) |
|---|---|---|---|---|
| A | 285 | 260 | 272 | 1.046 |
| B | 89 | 67 | 68 | 1.015 |

- cloud 口径 ≈ **不含文档标题**的正文可见字符（A 差 +12 ≈ title 13 字符；B 差 +1）。
- 分支裁定：§4.5 区间 [0.8, 1.25] 充裕（实测 1.02–1.05）；`kb/text-stats.ts` 按「不含 title、空白不计」实现最贴近云端。样本仅 2 份，S8 联调时可按设计预留的「中位数校准」再抽一轮。

## 9. PB-3(任务书) reference-map 回写 flag —— help 定型 + update 侧新事实

- `docs +create --reference-map`：类型 `reference_map`，接受 **inline JSON / `@reference-map.json`（相对路径）/ `-`（stdin）**；「must be used with `--content`；主要用途=保全或重放既有 `document.reference_map`；普通写入优先把结构直接嵌正文」。未实际回写（按任务书）。
- **实测新事实**：`docs +update` 同样有 `--reference-map` flag（同三形态）——**推翻 probe §6「update 无此参数」记录**（1.0.98 help 逐字确认）。U35「写回不透传」的理由需从「CLI 不支持」修正为**设计选择**（避免重放 sidecar 状态覆盖正文）；`reference_loss_risk` overwrite 预览警告仍有效（html5-block 类内容真实存在于 sidecar 时）。
- html5-block 回放场景（skill 佐证）：`<html5-block data-ref="html5_1"/>` 占位必须配合 `--reference-map @file` 重放 `reference_map["html5-block"]["html5_1"].data`。

## 10. 分支裁定汇总（供 P1 设计修订与切片排期）

| # | 冲击 | 裁定 |
|---|---|---|
| 1 | U32/S2 | 引用边主体来自**正文内联标签**（cite/sheet），非 reference_map；`extractBodyReferences` 扩双解析，refmap 通用扫描降级为补充（comments 排除、html5-block 覆盖） |
| 2 | U35 | `docs +update` 实测**有** `--reference-map`；「不透传」改为显式设计选择，警告保留 |
| 3 | U37 | scope 单条目成立；授权交互按 CLI hint 两段式 device flow 落地（`--no-wait --json` → 展示 verification_url → `--device-code` 完成） |
| 4 | U39/§4.3 | title 去重必须本地做；char 校验排除 `<title>` 行 |
| 5 | §3.2/§3.5 | `--slide-number` 逗号 ints 可用；all-or-none / 输出映射 / 字节稳定性 / PNG 尺寸移交 **P1-S5 授权后前置实测**（SP-2/SP-3/SP-4 未闭合项） |
| 6 | §4.3 | `<cite type="citation">` create 静默丢弃——发布 v1 已知边界 |

## 11. 清理确认

| 对象 | token | 操作 | 结果 |
|---|---|---|---|
| 文档 B（含评论） | `XjO4dP7NGoWVMfxMn3HcReVMnrf` | drive +delete --yes | ok |
| 文档 A | `VtS3d0GPLoAxLJxAGHLcv1tMnQZ` | drive +delete --yes | ok（fetch 复核 "has been deleted"） |
| slides | `AhCksWVJYlAe31duDQoc3DxIn3b` | drive +delete --yes | ok |
| 测试文件夹 | `UubtfDKTTlTt5jdKp0qc4oganJ3` | drive +delete --yes | ok（4 项 delete 全部退出码 0） |

本地临时文件留在 `/tmp/p1s1/`（会话外自动清理，不影响仓库）。
