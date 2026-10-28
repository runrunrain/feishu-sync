# lark-cli 新能力命令面实测（P0/P1/P2 取证）

- **日期**：2026-10-27 · **CLI**：`lark-cli 1.0.98`（`lark-cli --version` 实测）
- **方法**：仅 help / `--dry-run` / skill 参考读取，**零写执行**（Risk:write 命令只取 help）。
- **通用**：所有 `+` 快捷命令支持 `--dry-run`（打印请求不执行）、`--jq/-q`、`--format json|pretty|table|ndjson|csv`、`--as user|bot`。dry-run 输出顶层 `ok/identity/dry_run/data.api[]/context`。
- **身份上下文（dry-run 实测）**：`app_id: cli_aa6b8a86f4b8dc16`，user 模式带 `user_open_id`。

---

## 1. whiteboard SVG 导出/更新（1.0.58 #1559）✅

**命令**：`lark-cli whiteboard +export`（Risk: **read**）/ `lark-cli whiteboard +update`（Risk: **write**）；docs 域有同参别名 `docs +whiteboard-update`。

### +export 参数表

| flag | 说明 |
|---|---|
| `--whiteboard-token` | 画板 token（需读权限） |
| `--output-type` | `preview \| svg \| source \| raw` |
| `--output` | 输出路径；`preview` 必填；`svg/source/raw` 不填则直接输出（stdout/JSON） |
| `--overwrite` | 覆盖已存在文件 |

**dry-run 实测**（svg）：`POST /open-apis/board/v1/whiteboards/{token}/export`，body `{"export_type":"svg"}`。

### +update（SVG 更新入参形态）

| flag | 说明 |
|---|---|
| `--whiteboard-token` | 目标画板（需编辑权限） |
| `--source` | 输入数据，支持 `@file` / `-`(stdin) |
| `--input_format` | `raw \| plantuml \| mermaid \| svg`（默认 raw）——**SVG 可直接作为更新入参** |
| `--overwrite` | 先清空既有内容再写（默认 false） |
| `--idempotent-token` | 幂等 token，min length 10，默认空 |

**注记**：SVG 双向闭环成立（export svg ↔ update input_format=svg），适合「读改写」画板；本应用 LarkCliClient 现无 board 域封装，接入需加命令与 scope。skill 指引：更新已有画板必须复用现有 token，禁止新建空白画板。

---

## 2. docs 版本历史（1.0.65 #1612）✅

**命令**：`docs +history-list`（read）/ `+history-revert`（write）/ `+history-revert-status`（read）。

| 命令 | 关键参数 | 说明 |
|---|---|---|
| `+history-list` | `--doc`；`--page-size`(1-20, 默认20)；`--page-token` | dry-run 实测：`GET /open-apis/docs_ai/v1/documents/{token}/histories?page_size=20` |
| `+history-revert` | `--doc`；`--history-version-id`（取自 list）；`--wait-timeout-ms`(0-30000, 默认30000) | 同步等待回滚完成，超时返回 task_id |
| `+history-revert-status` | `--doc`；`--task-id` | 查询回滚任务状态 |

**输出形态**：list 每页最多 20 条 history 记录（含 `history_version_id`）；revert 为异步任务模型（task_id 轮询）。
**注记**：可作为「源库受控写」回滚兜底的候选机制；但 revert 会覆盖正文，属高危，需经批准流。

---

## 3. drive +update-title / +copy（1.0.85）✅

### +update-title（Risk: write）

| flag | 说明 |
|---|---|
| `--url` / `--token`+`--type` | `--type` 枚举：`docx|sheet|bitable|base|slides|file|folder|wiki|apps|doc|mindnote`（**含 mindnote**） |
| `--title` | 非空；`--type file` 时整体替换文件名（含扩展名） |
| `--on-extension-mismatch` | `keep`(默认：无扩展名自动补、改扩展名拒绝) / `allow`(原样提交) |

Tips（help 原文要点）：wiki 节点传 node token + `--type wiki`，改名双向同步 node/文档标题；`981003`=类型不匹配或未知 token；改名限流 `99991400` 需串行+退避；`981004`=无编辑权限。

### +copy（Risk: write）

| flag | 说明 |
|---|---|
| `--url` / `--token`+`--type` | `--type` 枚举：`doc|docx|sheet|file|mindnote|slides|bitable|base|wiki` |
| `--folder-token` | 目标文件夹 token/URL/常量 `my_space`（我的空间根） |
| `--name` | ≤256 bytes |
| `--extra` | 重复 key=value 透传，如 `--extra target_type=docx`（legacy doc → docx 副本） |

**注记**：wiki URL 源自动解包后复制底层资源；skill 明示「复制文档用 drive +copy，不要 fetch+create 重建」。适用知识库快照副本场景。

---

## 4. docs reference_map（1.0.61/64）✅

**无专用 flag，属 `docs +fetch` 响应结构**。dry-run 实测请求体：`POST /open-apis/docs_ai/v1/documents/{token}/fetch`，`extra_param` 固定含：

```json
{"enable_user_cite_reference_map":true,"include_comments":true,"return_html5_block_data":true}
```

**输出形态**（skill 参考原文要点）：响应 JSON = `content` + `reference_map` 同一份 sidecar；一级键为引用组（资源组按 block_type 命名，二级键 `ref` → 真实属性）；保留组 `comments` 用 `<ref>.data` 存评论（xml/markdown/im-markdown 三格式均返回，markdown 正文无内联引用是协议设计）；`comments.tips.data` 表示评论截断；无数据时可能为空。
**回写侧**：`docs +create --reference-map`（接受 inline JSON / `@file` / `-`），主要用于保全/重放既有 `document.reference_map`；普通写入优先把结构直接嵌正文。
**注记**：对本应用即「fetch 原样保留完整 JSON 响应即可获得 reference_map」，无需额外参数；写回飞书时 FeishuWriteService 需考虑是否透传。

---

## 5. docs fetch selection anchors（1.0.69 #1815）✅

`docs +fetch` 局部读取参数（help 原文）：

| flag | 说明 |
|---|---|
| `--scope` | `full \| outline \| range \| keyword \| section`（默认 full） |
| `--start-block-id` | range/section 锚块 id；section 必填，range 可选起点 |
| `--end-block-id` | range 终点；`-1` = 到文档末尾 |
| `--keyword` | 大小写不敏感子串/正则回退，`\|` OR 分支（如 `foo\|bar`） |
| `--max-depth` | outline 标题级数上限 / 其他 scope 子树深度（-1 无限，0 仅块自身） |
| `--context-before` / `--context-after` | 选中顶层块的前/后兄弟块上下文 |
| `--revision-id` | 指定修订版读取，-1 最新 |
| `--detail` | `simple \| with-ids \| full` |

局部读取输出被 `<fragment>` 包裹（skill 参考）。**注记**：KB 构建增量读取（只取某 section）可显著降 token；`with-ids` 供块级引用。

---

## 6. doc create --title（1.0.58）+ 本地 authoring（1.0.85 #1921）✅

### docs +create（Risk: write）

| flag | 说明 |
|---|---|
| `--content` | 文档体；XML（默认）或 Markdown（`--doc-format markdown`）；支持 `@file`/`-` |
| `--title` | 传入后 CLI 自动前置 `<title>...</title>`，标题优先于 content 内标题 |
| `--doc-format` | `xml \| markdown` |
| `--parent-token` / `--parent-position` | 文件夹/wiki node token；互斥；`--parent-position my_library` |
| `--reference-map` | 见 §4 |

### docs +script（Risk: read）— 本地 authoring

| `--command` | 用途 |
|---|---|
| `init-draft` | 建 `draft_<hex>_folder/draft.xml` 独占草稿工作区 + `.presentation-decision.json` 基线（需 `--presentation-decision`，可传 `{}`） |
| `parse` | 解析本地 XML（`--content @file`，不调 OpenAPI）或在线文档（`--doc`，需 `docx:document:readonly`），返回 `data.profile`（`word_count/char_count/block_count/blocks[]`）+ `data.diagnostics[]` + `data.assessment.status` |

校验约束：`word_count:{min,max}`、`visual_plan.blocks[].{type,min_count}`；`--dry-run` 只返回执行计划。
**注记**：这是「写前本地预检」通道——先 parse 通过再 `+create`/`+update`，可把格式错误拦截在本地；当前应用 sync 管线无对应物。

---

## 7. slides +screenshot（1.0.57）✅

| flag | 说明 |
|---|---|
| `--presentation` | slides URL/wiki URL/xml_presentation_id（list 模式） |
| `--slide-id` / `--slide-number` | 页 id / 页号，可重复或逗号分隔；**单请求 ≤10 页** |
| `--output` | 单张时首选相对输出路径（扩展名可选 png/jpg/jpeg） |
| `--output-dir` | 批量目录（默认 `.lark-slides/screenshots`） |
| `--content` | 直接渲染 slide XML（配合 `--output-name`），不必先上传 |

Risk: read。**dry-run 实测被 scope 拦截**：`missing required scope(s): slides:presentation:screenshot`（当前 user 授权未覆盖；授权命令 `lark-cli auth login --scope "slides:presentation:screenshot" ...`）。不打印 Base64，直接落盘文件。
**注记**：Vision 通道可复用为 slides 缩略图源；需增量授权该 scope。

---

## 8. word statistics helper（1.0.62）✅

命令位置：**`docs +script --command parse`**（见 §6）。输出：`data.profile` = `{word_count, char_count, block_count, blocks[]}`（block 分型画像），`data.diagnostics[]` 字符级诊断（severity/code/expected/actual/suggested）。skill 路由原文：「草稿初始化、解析与统计 — +script：统计字数并返回字符诊断；**不支持 Markdown 输入**」。命令本身 Risk: read（`--content` 本地路径时零 API 调用）。

---

## 9. wiki move-to-drive（1.0.71 #1869）✅

`lark-cli wiki +move-to-drive`（Risk: **write**）：

| flag | 说明 |
|---|---|
| `--node-token` | wiki **node_token**（非 obj_token；不确定时先 `wiki +node-get`） |
| `--folder-token` | 目标 Drive 文件夹；**省略 = 移到个人空间根** |

异步任务 + 有界轮询，超时返回 `next_command` 续查（也可用 `drive +task_result` 轮询，其 help 覆盖 wiki move-to-drive 任务类型）。
**注记**：移出 wiki 会脱离知识库树并切换为 Drive 权限模型——对 watchedRoot 场景是破坏性结构变更，若暴露给 Agent 必须走 destructive 批准级。

---

## 10. docs fetch --format im-markdown（1.0.58）✅ 枚举确认

flag 实际名为 **`--doc-format`**（非 `--format`），枚举：`xml | markdown | im-markdown`（默认 `xml`）。help 原文：markdown 返回纯正文+comments sidecar；**im-markdown 额外把残留 DocxXML 片段降级为 IM 消息可用形式**，仅用于取内容后投递 IM 场景。
**注记**：对本应用同步管线无新增价值（自有 DocxXML→本地 Markdown 重构层），排除。

---

## 11. mindnote（1.0.85 registry）✅ 部分支持

- **独立域**：`lark-cli mindnotes`，仅 `nodes list`（read）/ `nodes create`（创建/更新**已有**思维笔记的节点）。
- **`docs +fetch` 不支持 mindnote**（skill 明示：思维笔记入口在 lark-doc，实际走 `mindnotes nodes`，不走 `docs +...`）。
- mindnote token 获取：`drive +inspect --url` 解包（wiki URL 必须解包，直接传 wiki token 报 `3410003`）。
- **新建 mindnote 不走本链路**，走 lark-doc-whiteboard 工作流。
- 周边支持：`drive +update-title`/`+copy` 的 `--type` 均含 `mindnote`。
- **dry-run 实测被 scope 拦截**：`mindnotes nodes list` 需 `mindnote:node:read`，当前 user 授权未覆盖。
**注记**：KB 源若含 mindnote，现有 fetch 分型读取（docx/sheet/slides）不覆盖，需新链路或先 `+export`/whiteboard 通道。

---

## 12. drive comment shortcuts（1.0.81）✅

评论族快捷命令（drive 域，覆盖 doc/docx/file/sheet/slides/base(bitable)/apps，URL 解析 + wiki 解包）：

`+add-comment`(write) · `+add-reply`(write) · `+list-comments`(read) · `+list-replies`(read) · `+batch-query-comments` · `+update-reply`(write) · `+delete-reply`(write) · `+resolve-comment`(write) · `+restore-comment`(write) · `+react-reply`(write, emoji reaction)

### 关键参数（+add-comment / +list-comments 实测 help）

- `+add-comment`：`--doc`(URL/token/wiki URL)、`--content`(reply_elements JSON, 支持 @file/-)、`--block-id`（docx=块 id；sheet=`<sheetId>!<cell>`；slides=`<slide-block-type>!<xml-id>`；base=`<table-id>!<record-id>!<view-id>`）、`--full-comment`（整文档评论，无 location 时默认）、`--type`（bare token 必填）。
- `+list-comments`：`--comment-scope all|whole|partial`、`--solved-status false|true|all`(默认 false=未解决)、`--need-reaction`、`--need-relation`（docx 评论关联）、`--page-size`(1-100, 默认50)、`--page-token`。

**注记**：`docs +fetch` 已内联紧凑评论（reference_map.comments 组，可能截断）；完整评论操作走本族。本应用若做「评论同步」可用 `+list-comments` 只读链路，写操作（resolve/reply）属 Risk:write 需批准。

---

## 汇总：对本应用（kb-agent 升级）的可用性速览

| # | 能力 | Risk | 本应用可消费点 |
|---|---|---|---|
| 1 | whiteboard svg export/update | read/write | 画板内容纳入 KB 分型读取；SVG round-trip |
| 2 | docs history | read/write | 受控写回滚兜底候选（revert 高危需批准） |
| 3 | +update-title / +copy | write | KB 副本快照（+copy 解包 wiki）；标题同步 |
| 4 | reference_map | read(fetch 结构) | fetch 保留完整 JSON 即得；写回需评估透传 |
| 5 | selection anchors | read | KB 增量构建降 token；with-ids 块引用 |
| 6 | +create --title / +script | write / read | 写前本地预检（parse）接入 FeishuWriteService |
| 7 | slides +screenshot | read | Vision 通道输入源；**需新增 scope** |
| 8 | word statistics | read(本地) | 预检画像 word_count/blocks 校验 |
| 9 | wiki +move-to-drive | write | 结构变更，destructive 级才可暴露 |
| 10 | im-markdown | read | 不适用（IM 投递场景） |
| 11 | mindnote | read(+scope) | fetch 分型不覆盖；需 mindnotes 新链路 + scope |
| 12 | comment shortcuts | read/write | 评论读取可接；写需批准 |

**未验证/盲区**：所有 write 命令仅取证 help（按任务约束零写执行）；slides screenshot 与 mindnotes 的请求形态因 scope 缺失未获 dry-run 预览（已记录缺失 scope 名）。输出 JSON 完整字段形态（history 条目、copy 结果 `permission_grant`/`extension_appended` 等）来自 help/skill 文本，未实跑。
