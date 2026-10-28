# S0 飞书写能力实测报告（真实环境，仅测试文档）

> **状态：两阶段均完成。** 第一阶段（静态内省，认证缺失期间）+ 第二阶段（动态实测，认证补齐后按 §⑤ 命令序列执行）。
> 测试文档：`feishu-sync-s0-probe-164439`（docx token `WA2OdJnWYoFDvrxcYs1cUWH6nlb`），全部实测仅在该自建文档上执行，**已删除（回收站，fetch 复核 3380003 deleted）**。未触碰任何既有文档/wiki 空间。
> 执行环境：lark-cli 1.0.97（fnm node bin → `@larksuite/cli/bin/lark-cli` Mach-O arm64），认证 user 身份（openId ou_a6ea…，user 毛润）。
> 原始证据文件：20 个（import/append/overwrite/occ-*/fetch-*/exported-* 等），保留于 `/var/folders/…/amagi-trash.KXnayv/s0-probe/`（移出工作区保留，未销毁）。

## ① 认证态

| 阶段 | 命令 | 结果 |
|---|---|---|
| 一阶段 | `auth status --json --verify` / `config show` / `auth list` / `auth scopes` | 全部 `not_configured`——lark-cli 未配置未认证，动态项挂起 |
| 二阶段（主上补齐后） | `auth status --json --verify` | `identity=user, verified=true, tokenStatus=valid`；**access token expiresAt 2026-10-27T18:43:51-07:00（授权起约 2h），refresh token 至 2026-11-03**；appId `cli_aa6b8a86f4b8dc16` |

授予 scope 集（关键写类节选，完整原文见一阶段后 auth status 输出）：`docx:document:write_only`、`docx:document:create`、`docs:document.media:upload`、`docs:document:import`、`drive:file:upload`、`space:document:delete/move`、`wiki:node:create/copy/move`、`wiki:space:write_only` 等。**注意：`wiki:node:update` 不在授予集**。

## ② 逐项实测结果总览

| # | 实测项 | 状态 | 结论速览 |
|---|---|---|---|
| 1 | 认证态 | ✅ | 两阶段均完成；token 有效期 ~2h（refresh 7 天） |
| 2 | 写 scope 接受性 | ✅ | **全部实测通过**：device flow 接受 4 个写 scope 名且运行时逐命令验证；`wiki:node:update` 不可用；缺 scope 时错误可读（§②-D2） |
| 3 | append markdown 保真 | ✅ | **语义级高保真**；字节级非往返（转义非对称 + 3 处固定规范化），需归一化层（§②-D3） |
| 4 | overwrite 接受 markdown | ✅ | **动态定稿 true**：success、warnings=[]，往返与 append 同款规范化（§②-D4） |
| 5 | revision 字段与 OCC | ✅ | **重大反例**：OCC 只防未来值（4000002），**旧 revision 静默接受且造成内容重复损坏**（§②-D5） |
| 6 | obj_edit_time 可观测性 | ✅(受限) | wiki 面无法在红线内实测；**revision_id 写后即时可读**（docx API）；图片块导出形态已取得（§②-D6） |
| 7 | 媒体插入 | ✅ | media-insert 成功（image 块 + file_token）（§②-D7） |
| 清理 | 测试文档 | ✅ | `drive +delete --yes` 成功，fetch 复核 3380003 已删除 |

### 一阶段静态半场（保留，均已被 CLI 权威文本证实）

- **S1 scope 名静态复核**（二进制 strings）：`docx:document:write_only`(4)/`docx:document:create`(2)/`docs:document.media:upload`(6)/`docs:document:import`(2)/`wiki:node:update`(1) 均存在；`docx:document:edit` 不存在（0）。
- **S2 markdown 写入契约**（`skills read lark-doc/references/lark-doc-md.md`）：无条件转义 8 类（`\` `` ` `` `*` `_` `[` `]` `$` `~` `<`）；位置敏感 5 类（`#` `+` `-` `>` 行首、`|` 表格 cell 内）；fetch 导出已转义不可反转义；**XML 标签在 markdown 模式下解析生效（字面 `<` 须 `\<`）**；网络图 `![](https://…)`、本地图 `![](@./rel.png)`、附件 `<source path="@./f.pdf"/>`；**`@file` 仅接受 cwd 相对路径**（绝对路径报 `unsafe file path`）。
- **S3 overwrite 静态支持**：`--doc-format` help 原文 "markdown for user-provided Markdown or plain append/overwrite"。
- **S4 命令面**：`--command` 8 种枚举（str_replace|block_delete|block_insert_after|block_copy_insert_after|block_replace|block_move_after|overwrite|append）；`--revision-id int` 默认 -1；update 返回 `document.revision_id`/`new_blocks[]`/`warnings[]`；测试文档生命周期命令（import/update/fetch/delete）。

## ②-D 动态实测记录（二阶段，命令/关键输出/结论）

### D1 测试文档创建（drive +import）

```
$ lark-cli drive +import --file s0-probe/base.md --type docx --name "feishu-sync-s0-probe-164439" --json
→ ok=true; job_status=0(success); token="WA2OdJnWYoFDvrxcYs1cUWH6nlb"; type=docx;
  url=https://qcnbafdrjx7n.feishu.cn/docx/WA2OdJnWYoFDvrxcYs1cUWH6nlb; ready=true
```
**结论**：import 建 docx 一步到位（`docs:document:import` 运行时验证通过）；返回形态 `data.token/url/type/ready/ticket/job_status`。导入 md 的标题成为文档 title 块（fetch 导出首行 `<title>feishu-sync-s0-probe-164439</title>`）。

### D2 写 scope 接受性（U21 定值）

- **device flow 整单接受**：`docx:document:write_only`、`docx:document:create`、`docs:document.media:upload`、`docs:document:import`、`drive:file:upload` 全部出现在已授权 scope 集（无整单拒绝，与 `docs:document:read` 历史先例不同）。
- **运行时逐命令验证**：`docs +update append`（write_only）、`drive +import`（import）、`docs +media-insert`（media:upload）、`drive +delete`（space:document:delete）全部 success，零 scope 错误。
- **`wiki:node:update` 不在授予集**——本应用未启用/未授予该名；S12 不依赖它（写 wiki 内 docx 走 docs 域命令，无需 wiki:node:update）。
- **缺 scope 错误形态（可读、fail-closed、含自愈指引）**：

```
$ lark-cli drive +search --query … --json
→ {"ok":false,"error":{"type":"authorization","subtype":"missing_scope",
   "message":"missing required scope(s): search:docs:read",
   "missing_scopes":["search:docs:read"],
   "hint":"run `lark-cli auth login --scope \"search:docs:read\" --no-wait --json` …"}}
```

**结论（U21）**：`WRITE_SCOPES = ['docx:document:write_only']`（v1 追加正文场景最小集，实测通过）；媒体回传需另加 `docs:document.media:upload`（实测通过，v1 不申请）。S12 运行时可凭 `missing_scope` 错误引导增量授权。

### D3 append markdown 保真往返

写入 payload（语法意图字符 + 字面转义字符混合：标题/列表/表格/行内码/字面 `\|` `\*` `\[`）→ `docs +update --command append --doc-format markdown --content @s0-probe/append1.md` → success(rev 2→3) → `docs +fetch --doc-format markdown` 回读 diff：

| 差异点 | 输入 | 导出 | 判定 |
|---|---|---|---|
| 结构（标题/粗斜体/行内码/链接/两种列表/表格） | — | 与输入逐行一致 | **完全保真** |
| 字面管道（段落内） | `a\|b` | `a\|b`→回读 `a|b` | 语义保真，**字节失真**（非敏感位置不重新转义） |
| 字面括号（段落内） | `\[非链接\]` | `[非链接]` | 同上 |
| 字面星号 | `3 \* 5` | `3 \* 5` | 字节保真（无条件转义类导出保留） |
| 表格 cell 内管道 | `x2 \| 带字面管道` | 原样保留 | 字节保真 |
| 表格分隔行 | `\|---\|` | `\|-\-\|`…（`|---|`→`|-|-|`） | 固定规范化，语义等价 |
| 文档 title | —（首 fetch 有） | `<title>…</title>` 行 | 导出附加行（S12 落库时剥离） |
| 文件末尾 | — | 无结尾换行 | 固定规范化 |

**结论**：append 保真度 = **语义级高保真（结构 100%）**；字节级不往返（转义非对称：写入转义集 ⊋ 导出转义集）。S12 必须加**转义归一化层**（比较/前缀判断前归一），否则 push-planner 误判。

### D4 overwrite 动态往返（U18/S0 门控定稿）

```
$ lark-cli docs +update --doc <t> --command overwrite --doc-format markdown --revision-id 3 --content @s0-probe/overwrite.md --json
→ ok=true; result="success"; warnings=[]; revision_id 3→5
$ docs +fetch 回读 diff（vs 写入全文）：仅 2 处——表格分隔行规范化 + \[转义括号\]→[转义括号]
```
**结论**：**`overwriteSupported = true`（动态定稿）**——overwrite 接受 markdown 全文，语义保真与 append 同款规范化；title 块被 overwrite 清除（该次导出无 `<title>` 行，但 docx API 的文档 title 属性仍在——overwrite.md 首行 `# 标题` 会成为文档标题）。

### D5 revision OCC 实测（U20② 检验——重大反例）

| 实验 | 传入 revision_id | 实际当前 | 结果 |
|---|---|---|---|
| 正常写 | 3 | 3 | success（→5） |
| **旧值** | 3 | 5 | **success（→7），静默接受** |
| **远古值** | 1 | 7 | **success（→9），静默接受** |
| **未来值** | 999 | 9 | **拒绝**：exit=1，`code 4000002` "document version may be stale…" |

**并发损坏实证**：两次 stale overwrite 后，fetch 回读发现**正文重复 ×3**（标题块仅剩 ×1，追加段/图片正常）——stale overwrite 的实际行为 = **删块子操作按 stale 视图失效（或部分失败），插块照常执行 ≈ 追加而非替换**。

**结论（改写 T0b/U20 认知）**：
- 飞书/CLI 的 revision 校验**只防「写在未来版本」（>当前 → 4000002），完全不防「写在过期版本」（≤当前 → 静默按最新执行）**。
- 「revision 防云端竞态」（U20②、T0b 推荐理由 2）**不成立**：检测到执行的窗口内他人修改不会被拒，且重试旧 revision 会造成内容重复损坏。
- revision_id 每次写单调递增（append +1，overwrite +2——内部两步）；可作为变化指示器，但**不是并发控制**。

### D6 obj_edit_time 可观测性（U19 证据，受限完成）

- Drive 元数据通道：`api GET /open-apis/drive/v1/metas`、`/v1|v2/files/<token>` 均 **404**（应用未启用）；`drive +search` 需 `search:docs:read`（未授予）——Drive 文档的 edit_time 在本应用 scope 面内**不可观测**。
- `drive +inspect`：返回 title/token/type/url，**无时间戳**。
- **`wiki +node-get` 对 Drive（非 wiki）文档**：`code 131014 "document is not in wiki"` + hint 不重试——错误分类可复用（S12 区分文档归属）。
- **docx v1 documents API 可用且即时**：`api GET /open-apis/docx/v1/documents/<id>` 返回 `revision_id`，append 后立即 GET 即得新值（10）——**写后状态即时可读，无延迟**。
- **wiki 面 obj_edit_time 未实测**（需 wiki 节点，红线禁止在 wiki 空间创建节点）——U19 依据修订见 §④-3。

### D7 媒体插入（可选项，完成）

```
$ lark-cli docs +media-insert --doc <t> --file s0-probe/tiny.png --json
→ ok=true; data={block_id:"doxcn…", file_token:"K7J7…", type:"image"}
```
fetch 导出图片块形态：`![](https://feishu.cn/file/K7J7b2iH0oGv7Rx8V3bcsRO1n4c)`（空 alt + `feishu.cn/file/<file_token>` URL）——**回拉后本地正文将出现此形态引用**，S12 媒体下载/重写机制需识别。

## ③ 定值结论（终版，全部动态定稿）

| 定值 | 值 | 依据 | 置信 |
|---|---|---|---|
| `WRITE_SCOPES`（v1） | `['docx:document:write_only']`；媒体回传扩展 `docs:document.media:upload` | D2：device flow 接受 + 4 命令运行时验证 | **高（实测）** |
| `overwriteSupported` | **true**（markdown 全文；语义保真） | D4 动态往返 | **高（实测）** |
| append 保真度 | **语义级高保真**（结构 100%）；字节级需归一化层 | D3 diff | **高（实测）** |
| revision OCC | **不防过期**：≤当前静默接受且致内容重复损坏；>当前 4000002 拒绝 | D5 四组对照 | **高（实测，改写既有认知）** |
| revision_id 形态 | int，写后即时可读（docx GET API）；append +1 / overwrite +2 | D4/D5/D6 | 高 |
| scope 错误形态 | `type=authorization, subtype=missing_scope, missing_scopes[]` + 增量授权 hint | D2 | 高 |
| 非 wiki 文档探测 | `wiki +node-get` → 131014 "document is not in wiki" | D6 | 高 |
| 图片块导出形态 | `![](https://feishu.cn/file/<file_token>)` | D7 | 高 |
| `wiki:node:update` | 本应用不可用（不在授予集）；S12 无需 | D2 | 高 |
| obj_edit_time（wiki 面） | **未实测**（红线限制）；以 revision_id + 写后即时回读替代作 U19 依据 | D6 | 中（受限） |
| token 生命周期 | access ~2h / refresh 7 天（offline_access） | ① | 高 |

## ④ 对 S12 的落地建议（按动态证据修订）

1. **overwrite 安全协议必须三段式**（D5 直接后果）：fetch 最新 revision → **同一流程内立即** overwrite（revision 用 fetch 值）→ **写后回读校验**（fetch 正文与预期比对，失配即置 `conflict` 停止，绝不重试旧 revision）。任何「stale 重试」都产生内容重复损坏。
2. **U20 修订**：两级 OCC 实际只有一级——U20①（obj_edit_time 前置比较）是唯一竞态防线且存在 TOCTOU 窗口；U20②（revision 防竞态）**删除或降级为「防未来值」参数校验**，不能作为安全承诺。写后回读校验升级为必选步骤（替代原「warnings 非空即停」——warnings 实测恒空）。
3. **U19 回拉依据修订**：写回成功后立即单文档回拉（revision_id 即时可观测，D6）；回拉正文以**导出形态**为基线（转义归一后），obj_edit_time 推进由回拉后的正常同步链路收敛（写回不自行推进 synced 的决策不变）。
4. **转义归一化层（纯函数+单测）**：push-planner 的前缀/相等判断、回拉后的 baseBody 更新，都必须先归一化（写入转义集与导出转义集不对称：段落内 `\|`/`\[` 字节失真；表格分隔行 `|-|` 规范化；`<title>` 行剥离；末尾换行）。**append 正文中的字面 `<`（sync-engine 产物的 `<img>/<whiteboard>/<sheet>` 标签）必须 `\<` 转义**（markdown 模式下 XML 标签会解析生效，S2）。
5. **`@file` cwd 约束**：tmpfile 以子进程 cwd 相对路径传入（`LarkCliClient` 新方法落地时核对 execute 的 cwd 语义）。
6. **图片回拉处理**：回拉正文含 `![](https://feishu.cn/file/<token>)`，与 sync-engine 现有媒体下载/本地引用重写机制衔接（该 URL 域名与项目已知 CDN 形态是否一致待 S12 联调确认）。
7. **scopeSet:'write' 增量授权**：`WRITE_SCOPES=['docx:document:write_only']` 可安全进 `lark-cli-manager.ts`（D2 实测接受）；运行时遇 `missing_scope` 错误可读出 scope 名引导增量 device flow（hint 原文形态已存）。
8. `wiki:node:update` 不依赖；新建文档场景 `drive +import`（D1）或 `docs +create` 可用。

## ⑤ 遗留风险

| # | 风险 | 等级 | 说明 |
|---|---|---|---|
| 1 | stale overwrite 内容损坏的**根因层**（CLI 内部实现 vs 服务端语义）未定位——表现为删块失效+插块成功，对 S12 只需按「禁止 stale 重试+写后校验」防御 | 中 | 已有防御协议（§④-1） |
| 2 | wiki 面 obj_edit_time 未实测（红线）；U19 完整闭环（写回→检测报 modified→回拉收敛）需 S12 在真实知识库文档上验证 | 中 | revision 即时可读已证，风险收敛为时序细节 |
| 3 | round-trip 规范化清单可能不全（样本 3 次 fetch；未测：嵌套列表、代码块、引用块、mermaid/公式块、`~~删除线~~`、任务列表） | 低-中 | S12 联调期扩充样本 |
| 4 | 大文档 overwrite 上限/耗时未测（T0b R8） | 低 | v1 源文档体量内 |
| 5 | str_replace 转义语义（R7）未测——v1 不用，降级 | 低 | — |
| 6 | `feishu.cn/file/<token>` 图片 URL 的下载可达性未测（需 download scope 联调） | 低 | D7 仅证写入/导出 |
| 7 | token 2h 有效期：长时构建/批量写回需 refresh 自动化（CLI 自持 refresh token，7 天） | 低 | 运维项 |

## ⑥ 本轮状态（两阶段收尾）

- **一阶段（静态内省）**：Leader 已接受为 S0 第一阶段产出（overwrite 静态支持、8 种 command 枚举、markdown 转义契约、@file cwd 约束、5 scope 名复核）——本报告 §② 静态半场保留。
- **二阶段（动态实测，主上补齐认证后）**：§⑤ 原命令序列**全部执行完毕**——scope 接受性 ✅、append 保真往返 ✅、overwrite 动态往返 ✅、revision OCC 拒绝实测 ✅（含重大反例）、obj_edit_time 可观测性 ✅（受限，revision 替代）、media-insert ✅。
- **测试文档已清理**：`drive +delete --file-token WA2OdJnWYoFDvrxcYs1cUWH6nlb --type docx --yes` → deleted:true；fetch 复核 `3380003 Document deleted`。本地证据文件（20 个）移出工作区保留（路径见头部）。
- 本轮零 wiki 操作、零既有文档触碰、项目源代码零改动（仅本报告 + 临时文件已清）。
- **§③ 定值结论已全部动态定稿**，S12 可直接消费；§④ 落地建议按动态证据修订（重点：overwrite 三段式协议、U20② 降级、转义归一化层）。

## 证据与边界声明

- 全部命令真实执行于本机（cwd `/Users/run.mao/workpace/feishu-sync`）；关键输出为原文摘录，原始 JSON/md 证据 20 文件保留（amagi-trash.KXnayv，含删除前的完整 fetch 导出）。
- 写调用全部仅针对自建测试文档 `feishu-sync-s0-probe-164439`（token 见头部）；未执行 wiki 域任何写命令；`drive +search`（缺 scope，零副作用）、`api GET`（只读）亦无云端副作用。
- 未验证项如实标注（§⑤）；obj_edit_time（wiki 面）与完整 U19 闭环为受限项，交 S12。
- 回滚方式：无（云端唯一对象已删除，工作区零残留）。
