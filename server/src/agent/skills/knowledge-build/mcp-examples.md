# MCP 桥接调用示例（Pi 子任务）

知识工具经 `mcp_call` 到达应用桥接（server 名固定 `feishu-kb-bridge`）。下方 JSON **就是 `mcp_call` 的参数对象**，直接传入；不要再包一层 `{"tool":"mcp_call","arguments":...}`，也不要把整个示例塞进外层 `arguments`。业务参数只嵌套一次在 `arguments` 中。`mcp_list_tools` 只返回工具名称与简介；需要完整参数契约时调用只读 `kb_tool_schema`，不要靠失败调用猜字段。身份由环境自动附带。本文件示例面向子任务；Leader 的原生工具见文末。

```json
{"server":"feishu-kb-bridge","tool":"kb_tool_schema","arguments":{"name":"kb_edit_doc"}}
```

`kb_write_doc` 对同一路径是整体替换，不是增量追加。再次调用时必须在一次请求中提交该路径完整的对象、证据与覆盖数组；只改正文或已有证据的 selector 时用 `kb_edit_doc`。不要先写最小稿，再用多次 `kb_write_doc` 分批补声明。

## 读取

```json
{"server": "feishu-kb-bridge", "tool": "raw_read", "arguments": {"objToken": "<token>", "offset": 0, "limit": 120}}
{"server": "feishu-kb-bridge", "tool": "raw_csv_cells", "arguments": {"objToken": "<token>", "resourceId": "<token>#csv:表.csv", "recordStart": 184, "recordEnd": 187}}
{"server": "feishu-kb-bridge", "tool": "raw_csv_find", "arguments": {"objToken": "<token>", "resourceId": "<token>#csv:表.csv", "queries": ["建造大营", "补给概念"]}}
```

`raw_read` 的 `<read_receipts>` 块位于正文前，含 `readReceiptId`、`resourceId` 与该资源本地行范围。单次限制 120 行以免正文被工具输出截断；继续读时增加 `offset`。重要事实在声明中引用实际回执。
构建态来源正文逐行带有脚本生成的 `[O123/R45]` 或 `[O123/R45/C43]` 前缀：`O` 是拼接输出行，供下一页 `offset` 和任务书跳读；`R` 是资源内物理行，供文本 `text_span.lineStart/lineEnd`；`C` 是 CSV 逻辑记录号，供 `csv_cells.recordStart/recordEnd`。带引号的多行 CSV 单元格可能连续多行共用同一个 `C`。这些前缀只用于定位，不是源正文；直接抄对应的 `R` 或 `C`，不要人工从页首数行或把 `O` 写入证据 selector。
连续 3 行以上、由服务端核实为全空的 CSV 记录默认缩成 `<blank_csv_rows>`，标记保留源资源行号和输出行号；分页的 `returned` 与读取回执仍按未压缩原文计算。若需要逐字核查空行，原参数加 `"includeBlankCsvRows":true` 重读即可。
`<raw_page next_offset="N">` 给出下一次读取的精确 `offset`；`next_offset="end"` 表示本源已读到末页，立即写本篇，不重复探测末尾。它的 `offset/returned/total` 是拼接输出的行坐标，证据行号仍用 `<read_receipts>` 中各资源的本地坐标。
`objToken` 始终是原始文档的 token。`<token>#csv:文件名.csv` 是该文档的附件资源 ID，只用于 `evidenceClaims[].sourceRef.resourceId`；不要把它传给 `raw_read.objToken` 或 `kb_read_batch.requests[].objToken`。

需要一次读取多份短资源时，`kb_read_batch` 的精确调用为：

```json
{"server":"feishu-kb-bridge","tool":"kb_read_batch","arguments":{"requests":[{"kind":"raw","objToken":"<token>","offset":0,"limit":100}],"maxLines":100}}
```

批量读取请求的字段是 `requests`、`kind`、`objToken`、`offset`、`limit`，不是 `resources`、`type`、`token`。单次总量控制在约 120 行；返回 `nextCursor` 时用 `{"cursor":"<nextCursor>","maxLines":120}` 续页。搜索与清单工具：`raw_list`、`raw_search`、`raw_links`。

## 写正文与声明（仅写作身份）

下面的紧凑示例包含 v2 写入所需的对象、证据和覆盖声明。不要只提交正文；缺少声明会使候选无法通过发布校验。

- `path`/`markdown`/`sources`/`summary` 必填；正文不含文件头或 `#` 总标题（server 生成）。`title` 从路径文件名生成，`operationId` 从载荷生成，均可省略。
- 局部修改：按服务端返回的变更集/定位参数提交，不整篇重发。
- 对象迁移显式提交（迁移意图字段见工具清单），不删除重建。
- 回执丢失时原样重放同一载荷；若显式填写 `operationId`，同 ID 必须使用同载荷。

模型负责 `familyKey`（业务问题归属）、`scopeText`（适用范围）、断言风险、证据定位和覆盖去向。服务端补齐 `variantKey=default`、稳定 `scopeKey`、证据键、读取回执和覆盖项 ID，并仍按冻结来源逐条校验。`lineStart`/`lineEnd` 是源资源本地、从 1 开始的行号；必须先实际读到这些行。对象的 `headingPath` 指向本次 markdown 中的标题。示例占位符须替换为真实来源与内容，不得虚构证据。

```json
{
  "server": "feishu-kb-bridge",
  "tool": "kb_write_doc",
  "arguments": {
      "path": "规则/行动.md",
      "markdown": "## 行动次数\n每回合可执行一次标准行动。",
      "sources": ["<objToken>"],
      "summary": "每回合的标准行动次数",
      "objects": [{
        "clientKey": "action-count", "type": "rule", "title": "行动次数",
        "familyKey": "action-count", "scopeText": "标准行动",
        "headingPath": ["行动次数"],
        "claims": [{"claimKey": "once-per-turn", "riskCategory": "high"}]
      }],
      "evidenceClaims": [{
        "objectKey": "action-count", "claimKey": "once-per-turn",
        "selector": {"kind": "text_span", "lineStart": 12, "lineEnd": 12}
      }],
      "coverageUpdates": [{
        "sourceId": "<objToken>",
        "category": "rule", "importance": "important", "disposition": "mapped",
        "targetKeys": ["action-count"]
      }]
  }
}
```

大量 CSV 明细不要复制进 `markdown` 或 JSON 数组。先通过少量 `raw_read` 确认附件名、列坐标、表头和数据起点；正文放一个占位标记，`csvTableImports` 由服务端读取**冻结的 CSV**、跳过全空尾行、转义单元格并生成表格，同时登记覆盖导入范围的真实读取回执。下例中的记录范围和列坐标只是结构示例，实际调用以本篇源表为准。模型只撰写字段含义、规则、例外与适用边界；不要凭导入动作推断交叉匹配数量。

```json
{"server":"feishu-kb-bridge","tool":"kb_write_doc","arguments":{"path":"角色/人物名录.md","markdown":"## 人物名录\n{{kb-csv-table:people}}","csvTableImports":[{"key":"people","sourceId":"<objToken>","csvName":"人物.csv","columns":[0,1],"headerRecord":1,"firstRecord":2}],"sources":["<objToken>"],"summary":"人物名录的字段与记录","objects":[{"clientKey":"people-list","type":"data_structure","title":"人物名录","familyKey":"people-list","scopeText":"人物名录记录","headingPath":["人物名录"],"claims":[{"claimKey":"listed-records"}]}],"evidenceClaims":[{"objectKey":"people-list","claimKey":"listed-records","sourceRef":{"sourceId":"<objToken>","resourceId":"<objToken>#csv:人物.csv"},"selector":{"kind":"csv_cells","recordStart":2,"recordEnd":3,"columns":["@A","@B"]}}],"coverageUpdates":[{"sourceId":"<objToken>","category":"data_structure","importance":"important","disposition":"mapped","targetKeys":["people-list"]}]}}
```

`selector.kind` 只能取 `text_span`、`csv_cells`、`workbook_cells`、`media_region`。文本证据用 `lineStart`/`lineEnd`，不用 `startLine`/`endLine`。单来源文本证据可省略 `sourceRef`；多来源证据须填 `sourceRef.sourceId`，CSV/工作簿/图片须指明资源，CSV 还可给 `selector.resourcePath` 由服务端定位资源。`coverageUpdates.disposition` 为 `mapped`、`excluded_template`、`excluded_nonknowledge` 或 `unresolved`；映射项用 `targetKeys` 指向对象 clientKey。校验失败时只修正报错字段；禁止用临时路径写入再删除来探测 schema。
`raw_read` 中临时插入的 `<image_description>` 与 `<whiteboard_text>` 不属于原文资源的 `text_span` 行号。由图片描述或白板原始节点文字支撑的事实应指向 `<objToken>#image:<图片 src>`，使用 `selector:{"kind":"media_region"}`、`nature:"machine_description"`；imageHash 由服务端钉住，白板文字及原图一同登记为证据。白板旁路仅支持已提取的节点文字，不能据此推断图形布局或未提取的关系。正文 `text_span` 只能证明实际原文文字，不能用宽泛区间或把性质改成 machine_description 来代替图片证据。
构建态 `raw_read` 的 `<image_resources>` 会列出本页可引用图片的资源 ID、图片哈希与派生方式；图片 `media_region` 不需要文本行读取回执。该资源表只列有图片描述或白板旁路文字且原图可读的图片，不能把未列出的图片当成证据。
CSV 证据不能用 `text_span`：在对应 `evidenceClaims` 项使用 `"sourceRef":{"sourceId":"<objToken>","resourceId":"<objToken>#csv:表.csv"}` 与 `"selector":{"kind":"csv_cells","recordStart":2,"recordEnd":2,"columns":["列名"]}`。record 1 通常是表头；列名照 CSV 首条 record 原字填写。飞书 sheet 的导出 CSV 若前几行全空或表头重复，用显式物理列坐标 `"columns":["@C"]`（可多列 `@A/@B/...`）；`recordStart/recordEnd` 仍是从 1 起始的逻辑 record 号。`coverageUpdates` 的 `sourceId` 仍必填，填来源 objToken。
`claims[].riskCategory` 只能是 `high` 或 `normal`；`coverageUpdates[].importance` 只能是 `important` 或 `normal`，不能写 `minor`。覆盖排除理由写交接记录或总结，不在 `coverageUpdates` 项里添加 `excludeReason`。
同一来源、同一分类的覆盖项在修订时若要插入或重排，请显式给各项稳定 `itemId`，避免按序号生成的 ID 改指别的事项。
当 `coverageUpdates[].disposition` 为 `excluded_template` 或 `excluded_nonknowledge` 时，**该项还必须有非空 `reason` 字段**；不要因缺少理由让整次写入失败。

审查某一条断言的证据范围时，`draft_read` 可只取该 `claimKey` 的对象和证据，避免整篇声明超过桥接输出额度。下面只读取正文首行与该断言声明；若只需替换已有证据的 selector，用该结果中的 `evidenceId` 调用 `kb_edit_doc.evidenceSelectorUpdates`，无需读取或重填整篇声明。
填写 `declarationClaimKey` 或 `declarationObjectKey` 时，服务端自动开启声明读取；`includeDeclarations` 可以省略。

```json
{"server":"feishu-kb-bridge","tool":"draft_read","arguments":{"path":"规则/行动.md","offset":0,"limit":1,"includeDeclarations":true,"declarationClaimKey":"once-per-turn"}}
```

## 局部编辑已有草稿（仅写作身份）

先用 `draft_read` 取得当前 `contentHash`。`anchor.kind` 仅可为 `exact_text`、`heading_body`、`line_range`；不要试 `heading`、`section`、`range` 或 `body_range`。下面的编辑只替换唯一匹配的旧文本，未改的对象声明由服务端继承。

```json
{"server":"feishu-kb-bridge","tool":"kb_edit_doc","arguments":{"path":"规则/行动.md","expectedContentHash":"<draft_read.contentHash>","patches":[{"anchor":{"kind":"exact_text","oldText":"每回合可执行一次标准行动。"},"newText":"每回合可执行一次标准行动；额外行动另行结算。"}]}}
```

整节正文可用 `{"kind":"heading_body","headingPath":["行动次数"]}` 定位；行区间可用 `{"kind":"line_range","startLine":12,"endLine":15}`，坐标取 `draft_read`。已有证据只改选择范围时可单独提交 `{"path":"规则/行动.md","evidenceSelectorUpdates":[{"evidenceId":"<draft_read.evidenceId>","selector":{"kind":"text_span","lineStart":3,"lineEnd":8}}]}`；服务端继承其余声明并校验新范围的读回执。已有覆盖项只改去向时可单独提交 `{"path":"规则/行动.md","coverageUpdates":[{"itemId":"<原覆盖项ID>","disposition":"mapped","targetKeys":["<已有对象clientKey>"]}]}`；服务端按 `itemId` 继承来源、分类和重要性。重复对象并入已有对象时提交 `{"path":"规则/行动.md","objectMerges":[{"fromObjectId":"<本篇旧objectId>","toObjectId":"<后继objectId>","reason":"同源重复归属，后继篇保留完整规则"}]}`，必要时同次加正文补丁和证据更新；服务端转移旧对象的覆盖映射并继承未改声明。不要把仍有知识内容的覆盖项批量标成 `excluded_nonknowledge`。`kb_edit_doc` 不接受 `markdown`、`objects` 或 `evidenceClaims`；对象拆分、断言结构或来源关系变化才用完整 `kb_write_doc`。若继承的旧证据返回 `kb_evidence_unresolved`，先按当前来源重新读取，再重试局部证据更新或完整重写；不用不存在的 `markdown2` 字段或半篇正文探测。

## 提交审查报告（仅审查身份）

```json
{"server": "feishu-kb-bridge", "tool": "kb_submit_review", "arguments": {"coverage": {"docPaths": ["combat/actions.md"], "sourceRefs": ["<token>"]}, "checkedDimensions": ["完整性", "事实与数值", "来源忠实性"], "issues": [{"draftLocation": "combat/actions.md 怒气消耗节", "sourceLocation": "《战斗系统》源表 3", "description": "怒气消耗数值与来源表 3 不符（读取回执 rr_123）", "severity": "blocking"}], "uncheckedScope": [], "conclusion": "needs_revision"}}
```

- `conclusion` 取 `pass`/`needs_revision`/`insufficient_material`/`fail`；blocking 问题必须带 `sourceLocation`。
- 缺省 `unitId` 时报告落在你的审查者身份名下（多审查者各占一份）；整体审查填 `unitId: "all"`。

## 交接记录（子任务收尾）

```json
{"server": "feishu-kb-bridge", "tool": "build_handoff_submit", "arguments": {"summary": "行动规则文档完成：正文 1 篇、对象 2 个，证据齐备；跨文档公式归属待 Leader 裁定", "artifactRefs": ["combat/actions.md@3"], "sourceScope": ["<token>"], "openIssues": ["怒气公式与技能文档重复定义，待归属调整"], "nextInfo": ["需要技能树的共享对象分配结果"]}}
```

## Leader 工具（仅 Leader 身份）

Leader 的工具面没有 `mcp_call`——应用构建工具（材料清单/分配/发布等）作为原生工具直接下发，直接按工具名调用，参数就是业务参数本身：

```json
{"tool": "build_manifest", "arguments": {"limit": 50}}
```

```json
{"tool": "build_assign_output", "arguments": {"ownerTaskId": "<子任务ID>", "targets": ["combat/actions.md"]}}
```

```json
{"tool": "build_request_publish", "arguments": {"requestedRevision": "<候选哈希>", "summary": "全部主题通过独立审查，申请发布"}}
```

`mcp_call`/`feishu-kb-bridge` 外壳仅子任务身份可用；Leader 若包一层 mcp_call 会被拒（工具面不可达，不是参数错误）。

## 常见错误

- 未分配目标写入 → 可重试错误：先完成阅读，确认分配后再写。
- 参数结构不符 → 调用一次 `kb_tool_schema` 读取真实参数契约，再按结构化反馈修正；同类错误连发时交接问题，不盲试。
- `kb_write_doc` 声明校验拒绝并返回 `retryOf` → 原任务调用 `{"server":"feishu-kb-bridge","tool":"kb_write_doc","arguments":{"path":"规则/行动.md","retryOf":"<错误中的 wr_ 令牌>","objects":[{"clientKey":"action","type":"rule","title":"行动次数","familyKey":"action-count","scopeText":"战斗回合","headingPath":["行动次数"]}]}}`；这里只重传报错字段（示例为修正后的完整 `objects` 数组），正文、来源和未变数组由服务端短期复用，提交仍须通过原权限与全部校验。
- 版本冲突 → 按返回的当前 revision 重读后重试，不覆盖。
