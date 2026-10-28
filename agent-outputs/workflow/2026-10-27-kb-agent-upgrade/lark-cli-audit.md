# T5 调查：lark-cli 调用面全面审计（对 1.0.98 实测校正）

> 状态：完成（只写报告，零代码改动，写命令零执行，测试文档零创建）。
> 基准版本：**lark-cli 1.0.98**（本机 `lark-cli --version` → `lark-cli version 1.0.98`；npm registry `@larksuite/cli` latest 亦为 1.0.98，registry 上 `lark-cli` 仍为无关 0.1.0 占位包——client 内「必须装 @larksuite/cli」注释仍成立）。
> 审计窗口：应用开发起点（2026-06 初，≈1.0.45/47）→ 1.0.98 全窗口。变更清单输入：`/tmp/lark-cli-relevant-changes.txt`（813 行）+ CLI 自带 CHANGELOG.md 原文核对。
> 实测环境：本机（macOS arm64，认证身份 user=openId `ou_a6ea24…`，appId `cli_aa6b8a86f4b8dc16`）。实测对象：本人个人库/wiki 空间真实节点（只读），S0 已删测试文档 token（只读错误形态），`--dry-run`（参数面），`--help`（命令面）。
> 红线遵守：`docs +update` / `drive +import` / `+delete` / `+media-insert` / `wiki node-create` / `auth login`（CLI 自标 Risk: write）/ `config init`（Risk: write）一律**未执行**；写链路证据取自 S0-write-probe（1.0.97 动态实测）+ 1.0.98 help 核对。

---

## ① 调用点全清单（方法 / argv / 输出假设 / 1.0.98 实测结论 / 漂移判定）

「实测」= 1.0.98 本机真实执行；「help」= `--help` 原文核对；「dry-run」= `--dry-run` 参数面核对；「S0」= 1.0.97 动态实测记录（`S0-write-probe.md`）。

### A. LarkCliClient（server/src/modules/lark-cli-client.ts）

| # | 方法(:行) | argv 假设 | 输出/错误假设 | 1.0.98 实测结论 | 漂移 |
|---|---|---|---|---|---|
| 1 | fetchDocumentMarkdown (:560) | `docs +fetch --api-version v2 --doc <t> --doc-format markdown --detail simple` | `data.document.content`（string）；sheets[]/url 附加字段 | `--api-version` 已隐藏但**仍被解析**（1.0.59 #1580 hide）；实测真实 docx：`{ok,data:{document:{content,document_id,revision_id}}}`，content 语义不变 | **无** |
| 2 | fetchSlidesXml (:568) | `slides xml_presentations get --as user --params {xml_presentation_id,revision_id:-1} --format json` | `data.xml_presentation.content` | 命令存在；dry-run 确认 `--params` 原生 JSON 通道仍支持，url=`/open-apis/slides_ai/v1/xml_presentations/<id>`；**success 形态未实测**（本机无 slides 文档） | 无（命令面证据） |
| 3 | downloadMedia (:676) | `docs +media-download --token <t> --output <name> [--type whiteboard]`，cwd 相对 | `data.saved_path`（相对 cwd，需目录围栏校验） | help：`--token/--output/--type media\|whiteboard/--overwrite` 全在；dry-run ok | 无（help 级） |
| 4 | previewMedia (:680) | `docs +media-preview --token <t> --output <name>` | 同上 | help 全在；dry-run ok | 无（help 级） |
| 5 | getWorkbookInfo (:712) | `sheets +workbook-info --spreadsheet-token <t> --format json` | `data.sheets[]：sheet_id/sheet_name/row_count/column_count[/float_image_count]` | **实测**：`data.sheets[]` 含 `sheet_id/sheet_name/row_count/column_count/float_image_count/index/is_hidden/…` + `data.{title,token,revision,create_time,modified_time}` | **无** |
| 6 | exportWorkbook (:722) | `sheets +workbook-export --spreadsheet-token <t> --file-extension xlsx --output-path <name> --as user --format json`（cwd 相对） | 任务态可能未落盘 → 以 staging 文件存在+非零字节为准 | **实测**：`--output-path` 传具体路径时同步下载完成（`data.saved_path/file_token/ticket/size_bytes`），exit 0，文件 11832B | **无** |
| 7 | getSheetCsv (:741) | `sheets +csv-get --spreadsheet-token --sheet-id --range --include-row-prefix=false --format json` | `data.annotated_csv`（无 `[row=N]` 前缀） | **实测**：`=false` 生效（无前缀）；缺省时输出 `[row=N] ` 前缀；`data` 另含 `actual_range/has_more/revision/warning_message` 等 | **无** |
| 8 | getSheetLayout (:751) | `sheets +sheet-info --spreadsheet-token --sheet-id --include merges,row_heights,col_widths,hidden_rows,hidden_cols,groups,frozen --as user --format json` | `data.{row_heights,column_widths,hidden_rows,hidden_columns,merged_cells,…}`（sheet-read-reconstruction.ts:174 消费） | **实测**：include 枚举全部有效；返回键 `merged_cells/column_widths/hidden_columns/hidden_rows/row_heights/row_groups/column_groups/range/revision/sheet_id/sheet_name` 与消费端期望**逐字吻合** | **无** |
| 9 | getSheetCells (:762) | `sheets +cells-get … --include value[,formula][,style] --skip-hidden=false --max-chars 500000 --as user --format json` | `data.ranges[0].{cells,row_indices,col_indices}` + `data.has_more` | **实测**：flags 全在，返回 `data.{ranges,has_more,approx_char_count,returned_cell_count,revision,warning_message}`；ranges 顶层键吻合 | **无** |
| 10 | getSheetFloatImages (:784) | `sheets +float-image-list --spreadsheet-token --sheet-id --format json` | `data.sheets[]→float_images[]`（snake/camel 容错） | **实测**（0 图表）：`data.{revision,sheets:[],total}`；sheets 包裹层形态吻合；**非空条目形态未实测** | 无（容错解析对冲） |
| 11 | listBaseTables (:745) | `base +table-list --base-token --offset --limit --format json` | `items/has_more`（extractPage 容错） | dry-run：`--offset/--limit` **仍被接受**（params 透传）；help 已**不再列出**该二 flag（#2674 改为 CLI 内部全量拉取，无参数时 limit=300）；**success 形态未实测**（本机无 base） | **语义漂移**（D3） |
| 12 | listBaseFields (:754) | `base +field-list --base-token --table-id --offset --limit --format json` | 同上 | 同 #11（dry-run 接受、help 隐藏） | **语义漂移**（D3） |
| 13 | listBaseViews (:770) | `base +view-list --base-token --table-id --offset --limit --format json` | 同上 | help：`--offset` 存在，`--limit` range **1-200**（exporter 用 200=边界值 OK）；dry-run ok | 无 |
| 14 | listBaseRecords (:796) | `base +record-list --base-token --table-id --offset --limit(≤2000) --format ndjson --output <abs /tmp path>` | stdout=manifest（顶层 `has_more/records_count/offset`）；ndjson 行=`{record_id,fields…}` | help（1.0.98 #2782）：**ndjson 已是默认**（我们显式传 ndjson → 无行为差）；`--limit` ndjson range 1-2000 吻合；dry-run ok；**manifest 成功形态未实测** | 无（默认变更已对冲；D4 残余） |
| 15 | downloadBaseAttachment (:860) | `base +record-download-attachment --base-token --table-id --record-id --file-token --output <dir>` | `saved_path`/目录扫描（容错多键） | help：`--file-token` 现为 **stringArray**（可重复/省略=全部附件）；单 token 时 output 允许文件或目录，我们传目录 → 兼容；dry-run ok | 无 |
| 16 | listBaseDashboards (:873) | `base +dashboard-list --base-token --format json` | items（extractPage） | help：`--page-size 1-100（默认100）/--page-token`，无 offset；我们只传 base-token → 单页 100，>100 静默截断（现状注记 N1） | 无 |
| 17 | listBaseWorkflows (:880) | `base +workflow-list --base-token --format json` | items | 同 #16（page-size 100） | 无 |
| 18 | listBaseForms (:889) | `base +form-list --base-token --table-id --format json` | items | 同 #16 | 无 |
| 19 | checkAuthReady (:919) | `lark-cli --version`；`auth status --json [--verify]` | `data.identity==='user'`；`data.identities.user.{openId,userName,scope(空格串),verified,available,status}` | **实测**：全部字段在（status=ready/available/verified=true/scope 空格串）；**新增** `dpopMode:"preferred"/tokenType:"Bearer"/brand/credentialSource`（纯增量） | **无** |
| 20 | listWikiNodes (:1038) | `wiki +node-list --format ndjson --page-all [--space-id --parent-node-token]` | ≤1.0.72 页包裹 `{has_more,nodes}` / ≥1.0.89 裸实体流 → `data.records`；单实体 → `data:<node>` | **实测**：--page-all 输出纯裸实体流（无 has_more 包裹），实体字段 `node_token/obj_token/obj_type/title/has_child/parent_node_token/space_id/node_type`；client 三形态归一全部命中；**但 `--page-all` 受 `--page-limit` 默认 10 页 × page-size 50 截断**（help 原文） | **现状风险**（D2） |
| 21 | getDocumentMetas (:1073) | `drive metas batch_query --format json --data {request_docs:[{doc_token,doc_type(字符串)}]}` | `data.metas[].{doc_token,doc_type,latest_modify_time(string),title,request_doc_info}`；`data.failed_list[].{token,code}` | **实测**：metas 形态逐字段吻合（latest_modify_time 为 epoch 字符串）；**已删除文档也返回 meta 而非 failed**（注记 N2）；failed_list 未触发（形态沿用容错解析） | 无（N2 注记） |
| 22 | getNode (:1175) | `wiki +node-get --node-token <URL|node_token|obj_token> --format json` | `data.{node_token,obj_token,obj_type,title,space_id,obj_edit_time(string epoch),has_child,parent_node_token}` | **实测**：成功形态逐字段吻合（obj_edit_time="1781495704" 字符串→parseInt 防 NaN 逻辑仍适配）；**「不在 wiki」错误码 131005→131014**（token 与 /docx/ URL 两形态均实测复现） | **漂移**（D1） |
| 23 | api (:1215) | `api GET/POST <path> [--as] [--params JSON] [--data JSON] --format json` | ok 包裹 data | **实测**（docx v1 documents GET）：`{ok,data:{document:{document_id,revision_id(int),title}}}` | 无 |
| 24 | updateDocumentAppend / overwriteDocument (:434/:448) | `docs +update --doc --command append\|overwrite --doc-format markdown --content @<相对文件> [--revision-id] --json`（cwd=临时目录） | `revision_id`（三重 fallback）/`warnings[]` | 红线未执行；help（1.0.98）：`--command 8 枚举（含 append/overwrite）/--doc-format xml\|markdown/--content @file/-/--revision-id/-json` 全在；S0（1.0.97）动态实测响应 `revision_id/warnings` 成立；新增 `--reference-map`（增量） | 无（help+S0 级） |
| 25 | fetchDocumentRevision (:525) | `api GET /open-apis/docx/v1/documents/<t> --format json` | `data.revision_id ?? data.document.revision_id`（number）、`document.title` | **实测**：`data.document.revision_id`（int）+ title 在 | 无 |

### B. LarkCliManager（server/src/modules/lark-cli-manager.ts）

| # | 方法(:行) | argv/机制假设 | 1.0.98 实测结论 | 漂移 |
|---|---|---|---|---|
| 26 | getToolStatus (:290) | checkAuthReady 文案正则（未找到/未安装）识别未装态 | 实测认证链路文案不变；`未找到 lark-cli` 常量路径未触发（已安装） | 无 |
| 27 | queryLatestLarkCliVersion (:320) | `npm view @larksuite/cli version` | 实测返回 `1.0.98`（裸版本行，正则可解析） | 无 |
| 28 | installOrUpdateLarkCli (:425) | `npm install -g @larksuite/cli@latest`（+npmmirror/prefix 回退） | registry 验证：`@larksuite/cli`=1.0.98 为目标包；`lark-cli`=0.1.0 占位（注释判断仍正确）；1.0.98 「manifest-based distribution updates」(#2596) 不影响 npm 通道 | 无 |
| 29 | startDeviceAuth (:529) | `auth login --no-wait --json --scope <空格串>`；INVALID_SCOPE_RE=`/invalid or malformed scopes/i`；输出 `device_code/verification_url/expires_in` | help：`--no-wait/--device-code/--scope(空格或逗号)/--json` 全在；**Risk: write → 未执行**；输出字段形态沿用 S0（1.0.97）+ lenient 双流解析；DPoP(#2679) 对 login 输出的影响**未实测** | 残余未知（D5） |
| 30 | completeDeviceAuth (:727) | `auth login --device-code <code> --json` → `event==='authorization_complete'`+`user_open_id` | 同上（未执行；S0 相邻证据） | 残余未知（D5） |
| 31 | startConfigInit (:862) | `config init --new`；CONFIG_INIT_URL_RE 双形态（app/auth?q= 与 page/cli?user_code=） | help：`--new` 在（另有 --app-id/--brand/--force-init 增量）；机器已配置 → 1.0.98 URL 形态**未复测**（1.0.97 实测形态已在正则内） | 残余未知（D6） |
| 32 | detectLarkCliVersion (:1000) | `--version` → 非空字符串 | 实测输出 `lark-cli version 1.0.98`（纯文本，parseJsonOutput 包装为 data.version，展示用） | 无 |

### C. 散点直调（client/manager 之外）

| # | 文件:行 | 调用 | 1.0.98 结论 | 漂移 |
|---|---|---|---|---|
| 33 | server/scripts/migrate-kb-structure.mjs:461 | `wiki +node-get --node-token <link> --format json`（裸 execFile） | 与 client 同面；实测该命令面正常 | 无（注：其头注释「published npm package is `lark-cli`」为历史包名误解，实际装的是 @larksuite/cli 提供的 lark-cli shim，行为不受影响） |
| 34 | server/scripts/test-fetch.ts:14 | `docs +fetch --api-version v2 …`（dev 探针，win hardcoded `lark-cli.cmd`） | 同 #1，隐藏 flag 仍有效 | 无 |
| 35 | server/scripts/verify-m2b-sync.ts:24 | `wiki +node-get` / `+node-list`（dev 探针） | 同 #20/#22 | 无（131014 漂移同 D1 影响） |

---

## ② 重点怀疑面逐项证实/证伪（原 8 项 + steer 追加 7 项）

**原任务书 8 项：**

1. **base record reads 默认 ndjson（1.0.98 #2782）——证实但已对冲。** help 原文：`--format string  output format: ndjson (default; records file plus manifest summary and column schema/stats) | json (inline raw matrix) (default "ndjson")`。我们的 listBaseRecords **显式传 `--format ndjson`** → 默认值变更零影响。manifest 摘要现描述为「records file plus manifest summary and column schema/stats」，顶层 `has_more` 假设未实测（D4 残余）。bitable-exporter 消费链另有三重兜底（has_more===false / 返回数<limit / items 空）。
2. **list workspace entity 上限 30（1.0.95 #2646）——对本应用证伪。** CLI 自带 CHANGELOG 原文（1.0.95 Bug Fixes）：`list workspace entity 上限调整为 30 (#2646)`。该条对应 workspace/space 实体列举；1.0.98 实测 `wiki +node-list --help`：`--page-size int  page size, 1-50 (default 50)`、`wiki +space-list` 同为 1-50。本应用**不调用 +space-list**，node-list **不传 --page-size**（用默认 50）；CLI 按 page-token 翻页，服务端若按 30 截断只影响页数不影响正确性。无漂移。
3. **errors: prefer rendered OpenAPI messages（1.0.97 #2629）——证伪（分类链仍命中）。** 实测 3380003：stderr JSON `"code": 3380003, "message": "Document page has been deleted. This page can no longer be edited; …"` → classifyError deleted 分支正则 `(?:3380003|document page has been deleted|page can no longer be edited|文档.*已删除)` 命中。关键结构性保障：**错误 JSON 体整体落入 rawMessage**（execLarkCli 折叠 stderr），即使散文文案再变，正则仍匹配 JSON 内的数字码（99991400/40403/131006 同理）。131014 是唯一例外（见 D1：不在旧码表）。
4. **docs: await asynchronous document creation（1.0.95 #2641）——跳过。** 只影响 `docs +create`/导入建文的异步等待；本应用运行时零建文（S0 探针一次性行为，未进产品链路）。
5. **drive: accept folder moves without task ID（1.0.97 #2751）——跳过。** 全仓无 move 消费点（grep 无 drive move/`+move` 调用）。
6. **DPoP support（1.0.98 #2679）——部分证实（增量）。** 实测 `auth status --json --verify` 新增顶层 `dpopMode:"preferred"`、`tokenType:"Bearer"`，旧字段（identity/identities.user.*/verified）**全部保留**，checkAuthReady 解析零改动兼容。device login 输出形态因红线未执行（CLI 自标 Risk: write），静态 strings 不可用（二进制仅 60 行可读串，主逻辑内嵌压缩）。残余未知 → D5。
7. **sheets 参数拼写容错（1.0.96 #2710 / 1.0.95 #2611）——证实为「更宽容」方向，无破坏。** 这些变更是「接受调用方实际会写的拼写」，与本应用既有拼写是包含关系。实测我们的全部 sheets argv（含 `--include-row-prefix=false`、`--skip-hidden=false`、`--max-chars 500000`、`--include` 七类枚举、`--range` 无表前缀形态）均被接受且语义正确。
8. **skills 布局变化（28 official/28 added）——跳过。** manager/client 无任何 skills 调用点（grep 零命中）。

**steer 追加 7 项：**

1. **node_by_token 全系迁移（1.0.95 六处 + node-get resolve #2665）——证实，且产生本次最重要漂移 D1。** 1.0.98 help：`wiki +node-get --node-token  wiki node_token, obj_token, or a Lark URL embedding one of them`（解析能力扩大，含 /docx/ URL）。成功形态实测无损（见清单 #22）；**「文档存在但不在 wiki」错误码由 131005 变为 131014**（`"code": 131014, "message": "document is not in wiki"`，hint 明说不要重试 node-get）。getNode 语义本身增强（obj_token 直查更稳），api() 的 wiki resolve 不受影响（我们直接传 API path），fetchDocumentMarkdown 对 wiki 内 obj_token 走 `--doc`（"document URL or token"）不受影响。131014 分类假设（S12 依赖区分归属）：**1.0.98 上仍可依赖，但码值必须换新**。
2. **sheets legacy 命令面移除（1.0.93 #2572）——证伪。** 本应用 6 个 sheets 命令（+workbook-info/+workbook-export/+csv-get/+sheet-info/+cells-get/+float-image-list）在 1.0.98 全部存在且实测可用（#5-#10）。被移除的是更早的 legacy 面，我们从未使用。
3. **base 列表全量拉取（1.0.95 #2674「make table and field lists fetch all items」）——证实（语义漂移 D3）。** help 已不列 `--offset/--limit`，但**隐藏 flag 仍接受**（dry-run：显式传→params `{limit:100,offset:0}`；不传→`{limit:300,offset:0}` 内部全量）。手翻页循环理论上仍收敛（首轮若返回全量+has_more=false 即止），但 success 响应形态未实测（本机无 base）。
4. **base record NDJSON 保留不支持值（#2701）+ 1.0.98 ndjson 默认——兼容方向。** 保留不支持值=ndjson 行内字段更全；listBaseRecords 的 `{record_id, ...fields}` 解构对增量字段天然透传给 normalizeField/值渲染宽容层。默认值变更已被显式 `--format ndjson` 对冲（见 ②-1）。
5. **remote scopes.json 登录推荐（1.0.94 #1799）——证伪（无影响）。** 本应用 device flow **恒显式传 `--scope`**（空格串），从不依赖 `--recommend`/远程推荐集。实测当前授权 scope 集含全部 9 项 DEFAULT_REQUIRED_SCOPES（wiki:node:retrieve / wiki:space:retrieve / docs:document.content:read / sheets:spreadsheet:read / docx:document:readonly / drive:drive.metadata:readonly / docs:document.media:download / slides:presentation:read / offline_access），RETIRED_REQUEST_SCOPES（docs:document:read）过滤仍正确（该名不在授予集）。
6. **drive token 识别改进（1.0.95 #2680 download/preview）——跳过。** 该条属 **drive 域** `+download/+preview` 的 wiki URL/token 识别；本应用媒体通道是 **docs 域** `docs +media-download/+media-preview`（#3/#4），不走 drive 下载。
7. **其余 docs/drive/wiki/export/import/error 相关项——逐条快筛：** #2641/#2751/#2596（见上）；`drive +update-title/+copy/+member-*`（无调用点）；`docs comments/block ranges`（无调用点）；`drive export preflight`(1.0.85 #2218) 与 `drive +export` 无调用点（sheet 导出走 sheets +workbook-export）；`wiki node-create lock backoff`(1.0.40) 无写点；`wiki: keep node-get stderr machine-readable`(1.0.90 #2449)——实测仍机器可读（JSON 错误体在 stderr、stdout 空、exit 1），extractUpstreamCode 结构化通道依赖的正是这个契约；`docs fetch selection anchors`(1.0.69)/`reference_map`(1.0.61/64) 为增量能力未消费。全部无交集或增量无害。

---

## ③ 漂移清单（按优先级）

### D1【P0·功能断裂】「不在 wiki」错误码 131005 → 131014（node_by_token 迁移的直接后果）

- **调用点**：`server/src/routes/custom-folders.ts:576`（`error instanceof LarkCliError && error.upstreamCode === '131005'` 纯 /docx/ 云文档链接归档 fallback）；`server/src/modules/lark-cli-client.ts:1487`（extractUpstreamCode 文本兜底正则 `\b(131005|131006|40403|3380003|99991400)\b` 不含 131014）。
- **旧假设**（1.0.53 P0 实测锚定）：`wiki +node-get` 对非 wiki 文档报 `131005 "document is not in wiki"`，client 注释（lark-cli-client.ts:1270/1451）与 custom-folders fallback 均以此为据。
- **1.0.98 实际**（两种入参形态均复现）：
  ```
  $ lark-cli wiki +node-get --node-token WA2OdJnWYoFDvrxcYs1cUWH6nlb --format json   # 原始 obj_token
  $ lark-cli wiki +node-get --node-token "https://qcnbafdrjx7n.feishu.cn/docx/WA2OdJnWYoFDvrxcYs1cUWH6nlb" --format json  # /docx/ URL
  → exit=1，stdout 空，stderr：
  { "ok": false, …, "error": { "type": "api", "subtype": "failed_precondition",
      "code": 131014, "message": "document is not in wiki",
      "hint": "The document exists but is not mounted in Wiki. Do not retry wiki +node-get with the same document; use the corresponding docs, sheets, base, or drive command, or provide a Wiki URL/node_token.", … } }
  ```
  结构化通道（extractJsonValues→JSON parse）能取到 `error.code=131014` → `upstreamCode='131014'`，与 `'131005'` 严格比较**永不相等**。
- **影响场景**：快捷归档粘贴纯云文档 /docx/ 链接（不在 wiki 空间）时，custom-folders.ts 的 docx 直连 fallback 不触发 → 归档报 fetch_failed 类错误而非走 docs 通道归档。S12 写回链路的「wiki node-get 131014 区分文档归属」语义本身成立（码值即新事实），但任何硬编码 131005 的判断全部失效。
- **修复建议**：① custom-folders.ts:576 判定改为 `['131005','131014'].includes(upstreamCode)`（保留旧码兼容旧版 CLI）；② lark-cli-client.ts:1487 正则码表追加 `131014`；③ 顺带在 classifyError 增加对 131014 的显式分类（当前落 upstream/retryable=true，而 CLI hint 明示**不应重试**——建议归为 permission 或新增 not-in-wiki 不可重试类）。
- **优先级**：P0（既有功能在 1.0.98 上断裂，一行级修复）。

### D2【P1·静默截断风险】`--page-all` 受默认 `--page-limit 10` 截断（每分支 ≤500 节点）

- **调用点**：`server/src/modules/lark-cli-client.ts:1038`（`['wiki','+node-list','--format','ndjson','--page-all']`，不传 `--page-limit`/`--page-size`）。
- **旧假设**：`--page-all` 自动翻完全部页（注释 "supporting pagination and recursion … handle large knowledge bases"）。
- **1.0.98 实际**（help 原文）：`--page-all  automatically paginate through all pages (capped by --page-limit)`；`--page-limit int  max pages to fetch with --page-all (default 10, 0 = unlimited)`；`--page-size int  page size, 1-50 (default 50)`。即单次调用上限 10×50=**500 个直接子节点**，超限**静默停止**（ok:true、无错误、无截断标记）。
- **影响场景**：某父节点直接子节点 >500 的知识库分支 → BFS 拿到不完整子集且 `complete=true` → 子树文档被误判 missing/deletion 候选（与 2026-09 「bare-entity 事件」同型后果，但触发面更窄）。注意引入版本未能锚定（June 版本行为不可考），按**现状风险**处置。
- **修复建议**：argv 追加 `--page-limit 0`（unlimited，信任上游 QPS 节流），或在 change-detector BFS 层对「返回条数==500 整数倍」加防御性告警/fuse；两措施可并行。
- **优先级**：P1（本仓库 4 个 watched root 实测规模未触界，但企业库形态不可控，且后果是误删除候选）。

### D3【P2·语义变化待真机确认】base table-list/field-list 转 CLI 内部全量拉取（#2674），分页 flag 隐藏化

- **调用点**：`server/src/modules/lark-cli-client.ts:745/754`（listBaseTables/listBaseFields 显式传 `--offset/--limit`）；消费端 bitable-exporter.ts:791/833 手翻页循环。
- **旧假设**：单页语义（offset 递增 + has_more 判断），page size 1-100/1-200。
- **1.0.98 实际**（dry-run 实测）：显式传 flag 仍被接受（params 透传 `{limit:100,offset:0}`）；**不传时** CLI 发 `{limit:300,offset:0}` 并（据 changelog）内部翻页拉全。help 已不列该二 flag（隐藏但兼容）。风险点：全量模式下响应的 `items/has_more` 形态未实测（本机无 base 文档），若 has_more 语义消失，exporter 的三重终止兜底（has_more===false / items<limit / 空）仍可终止循环，但**条数 fuse 上限**（MAX_TABLES=200/MAX_FIELDS_PER_TABLE=500）语义可能提前/延后触发。
- **影响场景**：bitable 同步（表数/字段数多的 base）；当前无真机复现条件，判定为**兼容性待确认**而非已断裂。
- **修复建议**：下一次真实 base 同步时核对首轮响应（items 全量 or 单页、has_more 有无）；代码层可先把 TABLES_PAGE_LIMIT/FIELDS_PAGE_LIMIT 语义标注为「1.0.98 隐藏兼容」，不改行为。
- **优先级**：P2。

### D4【P3·残余未实测】base record-list manifest stdout 形态（1.0.98 摘要含 column schema/stats）

- **调用点**：`lark-cli-client.ts:814-838`（读 manifest 顶层 `has_more`，三层 fallback `manifest?.has_more ?? manifest?.data?.has_more ?? manifest?.hasMore ?? items.length>=limit`）。
- **1.0.98 实际**：help 描述 ndjson 模式输出「records file plus **manifest summary and column schema/stats**」——摘要内容物比 v0.3.34 实测时代更丰富；顶层 has_more 是否保留未实测（本机无 base）。显式 `--format ndjson` 已对冲 #2782 默认翻转；行级 `{record_id,fields}` 解析宽容。
- **修复建议**：与 D3 同场真机核对一次（一次同步同时覆盖 D3/D4）；三重 fallback 已是双读形态，无需预防性改动。
- **优先级**：P3。

### D5【P3·残余未实测】auth login（device flow）1.0.98 输出形态（DPoP #2679 后）

- **调用点**：`lark-cli-manager.ts:529+`（startDeviceAuth 期望 `device_code/verification_url/expires_in`）；`:727+`（completeDeviceAuth 期望 `event==='authorization_complete'`/`user_open_id`）；INVALID_SCOPE_RE 文案匹配。
- **实测边界**：`auth login` CLI 自标 **Risk: write** → 按红线未执行。help 确认 `--no-wait/--device-code/--scope/--json` 参数面全部保留；auth status 侧 DPoP 仅有增量字段；S0（1.0.97，仅一版之差）动态实测上述字段成立。二进制 strings 不可读（内嵌压缩），无法静态复核。
- **风险**：若 1.0.98 改了 `event` 枚举值或字段名，completeDeviceAuth 会走「未收到本次授权成功」兜底（fail-closed，不会误判成功），startDeviceAuth 会报 device_auth_start_failed。**爆炸半径=认证引导流程**，可被「重新认证仍失败」的用户反馈快速暴露。
- **修复建议**：见 ⑤ 向前兼容策略（字段双读 + 版本探测）；或在获得主上明示授权后补一次 `--no-wait` 实测（无凭据改写，仅产生 10 分钟过期的 pending device code）。
- **优先级**：P3（fail-closed + 一版之隔证据 + lenient 解析三重缓冲）。

### D6【P3·残余未实测】config init 验证 URL 形态（1.0.98 未复测）

- **调用点**：`lark-cli-manager.ts:119`（CONFIG_INIT_URL_RE 双形态）。
- **状态**：本机已配置，无法在不破坏现状的前提下复测；正则已覆盖 1.0.95（app/auth?q=）与 1.0.97（page/cli?user_code=）两代实测形态。1.0.98 changelog 无 config init URL 相关条目 → 推定不变。
- **优先级**：P3（下次全新机器引导时自然复核；建议在 URL 提取超时错误信息里带上累积输出尾部 50 行——现已有 tailLines 兜底，可直接诊断）。

### 现状注记（非漂移，建议知悉）

- **N1**：`base +dashboard-list/+workflow-list/+form-list` 为 page-size 单页模型（默认 100、page-token 翻页），client 不传翻页参数 → 单 base 超 100 dashboards/workflows/forms 时静默截断。三者皆增强层（软失败/展示用），影响轻。
- **N2**：`drive metas batch_query` 对**已删除文档仍返回 meta**（实测 S0 已删文档返回 `latest_modify_time=1793144879`，非 failed_list）→ 快速检测不会因删除而 failed/fallback，而是报 modified → 同步 fetch 时由 3380003 deleted 分支接管。链路自洽，但「删除文档在 metas 通道不可见」是写检测语义时要知道的事实。
- **N3**：`docs +fetch` 1.0.98 的 extra_param 默认含 `include_comments:true / enable_user_cite_reference_map:true`（dry-run 实测），markdown 模式 help 描述为「plain content plus the comments sidecar」→ `data.document` 可能携带 comments 附加字段；消费端只读 `content`，无影响。低隐私注记：comments 数据会进入子进程 stdout（maxBuffer 已放宽至 256MB）。
- **N4**：`wiki +node-get` 成功响应新增 `creator/owner/origin_node_token/node_create_time/obj_create_time/updated_at` 字段（增量，未消费）；`node-list` 实体含 `node_type:"origin"` 字段（未消费，shortcut 节点值待考——若未来出现 `"shortcut"` 值，ChangeDetector 的去重逻辑仍按 node_token 去重，无碍）。

---

## ④ 无漂移项核对证据（关键实测摘录）

以下均为 1.0.98 本机真实执行的原文摘录（截取关键字段；完整命令见附录）。

1. **fetchDocumentMarkdown**（真实 docx `U7SBdLTqNoU5QgxHTbyclAMCnGd`，含隐藏 `--api-version v2`）：
   ```
   $ lark-cli docs +fetch --api-version v2 --doc U7SBdLTqNoU5QgxHTbyclAMCnGd --doc-format markdown --detail simple
   → exit=0 {"ok":true,"identity":"user","data":{"document":{
       "content":"# 知识问答\n\n<sub-page-list space-id=\"7200267672453070849\" wiki-token=\"…\"></sub-page-list>",
       "document_id":"U7SBdLTqNoU5QgxHTbyclAMCnGd","revision_id":1}}}
   ```
   `data.document.content` 契约不变。（附：dry-run 显示该命令走 `/open-apis/docs_ai/v1/documents/<t>/fetch`，body `format:"markdown"`。）
2. **getNode 成功形态**（真实节点）：
   ```
   $ lark-cli wiki +node-get --node-token LYZ0w58priPERWkGraic7FyQnje --format json
   → exit=0 {"ok":true,…,"data":{"has_child":false,"node_token":"…","obj_create_time":"1781495704",
       "obj_edit_time":"1781495704","obj_token":"U7SBdLTqNoU5QgxHTbyclAMCnGd","obj_type":"docx",
       "parent_node_token":"","space_id":"7651465784132111570","title":"知识问答","updated_at":"2026-06-15T03:55:04Z",…}}
   ```
   obj_edit_time 仍为 epoch **字符串**（parseInt+NaN 防御适配）；parent_node_token 根节点为空串（typeof string 分支适配）。
3. **listWikiNodes 裸实体流**（--page-all，my_library + 两空间 + parent 下钻共 4 次实测）：
   ```
   $ lark-cli wiki +node-list --space-id 7651465784132111570 --parent-node-token VcmQ… --format ndjson --page-all
   → {"has_child":false,"node_token":"EfjLwy0…","node_type":"origin","obj_token":"UdgIs6P…","obj_type":"sheet","parent_node_token":"VcmQ…","space_id":"7651…","title":"表格文档模版"}
   ```
   无 `{ok,data}` 包裹、无页包裹、无数组字段 → parseJsonOutput 的 allBareEntities→`data.records` 路径命中；单实体→`data:<node>` 归一路径保留。
4. **checkAuthReady**：`auth status --json --verify` → 顶层 `{appId,brand,credentialSource,defaultAs,dpopMode:"preferred",identities:{bot:{…},user:{status:"ready",available:true,verified:true,openId,userName:"毛润",tokenStatus:"valid",scope:"docx:document:readonly … offline_access"(空格串),expiresAt,refreshExpiresAt}},identity:"user",tokenType:"Bearer",verified:true}`。client 消费的全部字段在位，新增字段纯增量。`--version` → 纯文本 `lark-cli version 1.0.98`（parseJsonOutput 无 JSON 分支包装为 `{ok,data:{version}}`，展示链路不变）。
5. **getDocumentMetas**：metas[] 实测含 `doc_token/doc_type/latest_modify_time("1781495704" 字符串)/title/request_doc_info/url`——与解析器逐字段吻合（`Number.parseInt(String(...))` 适配字符串形态）。
6. **fetchDocumentRevision**：`api GET /open-apis/docx/v1/documents/<t>` → `data.document.revision_id`（**int** 1）+ `title`，`typeof revision==='number'` 分支命中。
7. **sheets 全链**（真实 sheet `UdgIs6PY5hgohwtYnptcFM1ZnWM` / af4006）：
   - workbook-info：`data.sheets[0]` = `{sheet_id:"af4006",sheet_name:"日志",row_count:200,column_count:20,float_image_count:0,index:0,is_hidden:false,merged_cells_count:21,…}`；
   - csv-get：`=false` → `annotated_csv:" ,,\\n ,,\\n ,,"`（**无前缀**）；缺省 → `"[row=1] ,,…"`（有前缀）——flag 语义确认；
   - sheet-info：include 七类全收，返回键 `merged_cells/column_widths/hidden_columns/hidden_rows/row_heights/row_groups/column_groups/range/revision/sheet_id/sheet_name` 与 sheet-read-reconstruction.ts:174-175 期望**逐字吻合**；
   - cells-get：`data.{ranges,has_more,approx_char_count,returned_cell_count,revision,warning_message}`；
   - float-image-list：`data.{revision,sheets:[],total:0}`（sheets 包裹层吻合）；
   - workbook-export：`--output-path probe.xlsx` → exit=0，文件落盘 11832B，`data.{saved_path:"/private/tmp/audit-export/probe.xlsx",file_token,ticket,size_bytes}`（saved_path 的 `/private` 前缀正是 fetchMediaToPath realpath 围栏已处理的形态）。
8. **classifyError 分类链**：3380003（deleted）实测命中（消息 "Document page has been deleted. This page can no longer be edited…"）；结构化错误体 `{ok:false,error:{type:"api",subtype:…,code,…}}` exit=1、stdout 空、stderr JSON——与 extractUpstreamCode 的 JSON 通道假设一致（1.0.90 #2449 契约保持）。
9. **命令面存在性（help 逐条核对）**：`docs +update`（--command 8 枚举含 append/overwrite、--doc-format xml|markdown、--content @file/-、--revision-id、--json）；`docs +media-download`（--token/--output/--type media|whiteboard）；`docs +media-preview`；`slides xml_presentations get`（--xml-presentation-id/--revision-id/--params）；`drive metas batch_query`（--data -/@file）；`api`（--params/--data/--as/--format）；`auth login`（--no-wait/--device-code/--scope/--json）；`config init --new`；`base +view-list`（--offset/--limit 1-200）；`base +record-download-attachment`（--file-token stringArray/--output）。全部在位。
10. **dry-run 参数面（8 条 base 命令 + sheets + slides）**：本应用现行 argv 全部被 1.0.98 接受，exit=0。

## ⑤ 建议的向前兼容策略（供 Leader 决策，本报告不实施）

1. **错误码判定一律「码集合」而非单码**（对 D1 的普适化）：上游错误码随 OpenAPI 版本迁移（131005→131014 是实例，历史还有 scope 名迁移）。建议在 LarkCliError 上游码判定处统一用 `const NOT_IN_WIKI_CODES = ['131005','131014']` 常量并集中注释锚点，extractUpstreamCode 的文本兜底码表同步维护。
2. **输出字段双读已是既定模式，扩展到 base manifest**：listBaseRecords 的 `manifest?.has_more ?? manifest?.data?.has_more ?? manifest?.hasMore` 三读应保留；D3/D4 真机核对时若发现新形态（如 schema/stats 键），按「新增键忽略、旧键缺失走兜底」原则补充。
3. **显式参数优于默认值**：本次唯一被默认值翻转（ndjson default）冲击面为零，正因为我们显式传 `--format ndjson`。同类建议：`wiki +node-list` 显式传 `--page-limit 0`（消除 D2 的 10 页上限）+ 保留不传 page-size（跟随 CLI 合法域）；`+csv-get` 维持显式 `--include-row-prefix=false`（本次实测证明有效且防御了默认 true）。
4. **版本探测门**（可选，成本敏感时不做）：`--version` 已进入 checkAuthReady 首步；可在 LarkCliConfig 携带 `larkCliVersion`，对 `>=1.0.95` 启用 131014 判定、对 `<1.0.95` 保留 131005——但鉴于「码集合」方案更简单且天然兼容，**推荐码集合而非版本分支**。
5. **auth 引导类残余（D5/D6）的收口**：一次受控实测（`auth login --no-wait --json --scope <read 集>`，10 分钟过期、零凭据改写）可同时消解 D5 与 INVALID_SCOPE_RE 文案风险；config init URL 在下一台全新机器引导时复核。二者失败模式均 fail-closed（不会误判成功），可接受延后。
6. **真机 bitable 冒烟（D3/D4）**：下次对任一真实 base 同步时，抓取首轮 table-list/field-list/record-list 响应各一份存档（脱敏后可入 agent-outputs），一次覆盖两个残余项。

## 附录：实测命令索引（全部只读；执行日 2026-10-28，本机）

| 目的 | 命令 |
|---|---|
| 版本/包 | `lark-cli --version`；`npm view @larksuite/cli version`；`npm view lark-cli version` |
| 认证 | `lark-cli auth status --json --verify` |
| wiki | `wiki +node-list --space-id my_library [--parent-node-token …] --format ndjson [--page-all]`；`wiki +space-list --format json`；`wiki +node-get --node-token <token|URL> --format json`（成功/131014/两形态） |
| docs | `docs +fetch --api-version v2 --doc <真实t> --doc-format markdown --detail simple`（成功）；同命令对已删 token（3380003）；`docs +fetch/--dry-run`；`docs +update/+media-download/+media-preview --help` |
| sheets | `+workbook-info`、`+csv-get`（=false/缺省/=true 对照 + dry-run 三态）、`+sheet-info`、`+cells-get`、`+float-image-list`（真实 sheet）；`+workbook-export --output-path probe.xlsx`（真实导出）；六命令 `--help` |
| base | `+table-list`（带/不带 offset+limit dry-run 对照）、`+field-list`、`+view-list`、`+record-list`、`+record-download-attachment`、`+dashboard-list`、`+workflow-list`、`+form-list`：dry-run + help |
| drive/api/slides | `drive metas batch_query --data {request_docs…}`（真实 2 token，含已删）；`api GET /open-apis/docx/v1/documents/<t>`；`slides xml_presentations get --params … --dry-run` |
| auth/config | `auth login --help`；`config init --help`（均未执行，仅 help） |

> 上游输入：`server/src/modules/lark-cli-client.ts`（v 基线 git HEAD）、`server/src/modules/lark-cli-manager.ts`、`/tmp/lark-cli-relevant-changes.txt`、CLI 自带 CHANGELOG.md（1.0.98 包内）、`agent-outputs/workflow/2026-10-27-kb-agent-upgrade/S0-write-probe.md`（1.0.97 写链路实测）。
> 未覆盖/盲区：base 成功响应三形态（D3/D4，本机无 base）、auth login 输出（D5，红线）、config init URL（D6，已配置态）、slides/媒体下载成功形态与 float-image 非空条目形态（本机无对应对象）、`not_configured` 错误包 1.0.98 形态（机器已配置；classifyError 的 `not_configured|"type":"config"` 正则按结构推断仍命中，1.0.95 #2583 为相邻变更）、INVALID_SCOPE_RE 1.0.98 文案（未触发）。以上均已给出获取路径。
> 回滚方式：无（纯报告，零代码/零配置/零云端改动；本地仅 /tmp 探针文件，均在 /tmp 生命周期内自清）。
