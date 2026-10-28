# T0b 调查报告：lark-cli 写能力与飞书文档回写通道

日期：2026-10-27 ｜ 调查人：白泽（depth=1 只读调查）｜ 项目：/Users/run.mao/workpace/feishu-sync

## 结论索引表

| # | 主张 | 状态 | 锚点 | 适用边界 |
|---|------|------|------|----------|
| 1 | 本机安装 lark-cli **1.0.97**（npm 包 `@larksuite/cli`，Go 二进制） | 观察 | fnm node_modules package.json（见 §2.1） | 本机 darwin；版本号随上游演进 |
| 2 | lark-cli 具备**完整写类命令面**：`docs +create/+update`、`drive +upload/+import/+move`、`markdown +create/+patch/+overwrite`、`wiki +node-create/+move/+node-delete`、`docs +media-insert/+media-upload` | 观察 | 二进制内嵌 SKILL.md + CHANGELOG + README（见 §2.2-2.4） | 未跑 `--help`（本会话无 shell 工具）；证据来自包内一手文本与二进制内嵌字符串 |
| 3 | `docs +update --command` 枚举：`append` / `str_replace` / `block_replace` / `block_insert_after` / `block_delete` / `overwrite`；`append` 支持 `--doc-format markdown`，`overwrite` 用 XML 内容 + `--revision-id` 乐观并发 | 观察 | 二进制 lark-cli:1901960-1983、:1894780、:1901172 | 枚举以已观察到的为准，未宣称穷尽（负面发现边界见 §9） |
| 4 | `api()` 透传仅限 `GET|POST`（TS 类型），支持 `--data` JSON，可直调任意 OpenAPI 写端点（Raw API 层宣称 2500+ APIs） | 观察 | lark-cli-client.ts:1063-1074 + README「Raw API Calls」 | method 枚举是应用侧类型约束，非 CLI 侧实测限制 |
| 5 | 「md 写回飞书」**推荐主通道：`docs +update` 家族**（增量用 append/str_replace/block_*，全量替换用 overwrite+revision_id OCC）；新建文档用 `drive +import --type docx` 或 `docs +create` | 推断（基于证据） | 通道矩阵 §4 | 转换器与 diff 策略为待实现工作；overwrite 是否接受 markdown 格式待实测 |
| 6 | 应用当前 scope **全为读类**；写回需新增 `docx:document:write_only`（更新）、`docx:document:create`（新建）、`docs:document.media:upload`（媒体回传）、`docs:document:import`（import 通道）、`wiki:node:update`（wiki 节点操作） | 观察 | config-manager.ts:66-84 + 二进制 scope 名（见 §5） | scope 名有上游失效先例（`docs:document:read` 整单拒绝），新增必须先实测 device flow |
| 7 | 测试 mock 三层模式：execute 覆盖（argv 断言）/ `vi.mock('child_process')` 真实错误链 / 结构化假 client 注入；写通道沿用即可 | 观察 | server/tests/lark-cli-*.test.ts（见 §6） | — |
| 8 | **关键集成风险：写回后云端 `obj_edit_time` 变化会触发本地 ChangeDetector 报 modified（自激振荡），写回成功必须推进本地 synced 基线** | 推断（基于 CLAUDE.md 同步契约） | sync-engine 契约（CLAUDE.md「只有原子提交成功才推进 synced_obj_edit_time」） | 与现有检测/同步双链路强耦合，未实测 |

---

## 1. 调查方式与边界声明

- 本会话运行时**未提供 shell 执行工具**（无 bash/exec），且原生 MCP 网络通道被守卫冻结（grant.mcp 为空）。任务书允许的 `--help` 实测与外部网页检索均不可执行。
- 降级取证路径（完全只读、全部成功）：
  1. **本机 lark-cli 安装目录直接读取**：`/Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@larksuite/cli/`（README、CHANGELOG、scripts/run.js）；
  2. **Go 二进制内嵌文本取证**：对 `bin/lark-cli` 用 grep 提取内嵌 SKILL.md 帮助文本、scope 名、OpenAPI 端点、错误码。内嵌文本自述与 CLI 版本同步构建——「Read agent-readable skill content (SKILL.md and reference files) embedded in the CLI binary at build time, so it stays in sync with the CLI version」（二进制 lark-cli:1870632），证据强度等同随包文档；
  3. **项目代码与测试全文阅读**。
- 因此：命令**存在性与参数形态**为强证据（构建时嵌入）；命令的**运行时行为、scope 实际授予、错误响应形状**为未验证项，逐条列入 §8 待实测。

## 2. lark-cli 发现与命令面

### 2.1 安装与发现链

- 版本 **1.0.97**（`@larksuite/cli/package.json` version 字段；MIT；仓库 github.com/larksuite/cli；bin 入口 `scripts/run.js` → `bin/lark-cli` Go 二进制，postinstall 下载）。
- 应用侧发现链（`resolveLarkCliExecutable`，lark-cli-client.ts:348-410）：`config.larkCliPath`（仅测试哨兵）→ `LARK_CLI_PATH` 环境变量 → PATH → 桌面候选目录（fnm/nvm/volta/pnpm/asdf/Homebrew/~/.local/bin 等，`getNodeRuntimeCandidateDirectories`）。本机 fnm 目录命中即证发现链对写命令同样生效（同一可执行文件）。

### 2.2 写类命令面总览（按域）

| 域 | 写类命令（已证实存在） | 关键证据（二进制内嵌文本锚点） |
|----|------------------------|------------------------------|
| docs | `+create`（`--doc-format markdown --content`）、`+update`（六种 `--command`）、`+media-insert`、`+media-upload`、`+resource-update --type cover` | README「Shortcuts」示例；:1901960-1983；:1900111 `+media-insert --doc doxcnXXX --file ./image.png`；:1894966 `+media-upload --file ./image.png --parent-type mindnote_image`；:1886198 封面资源命令 |
| drive | `+upload`、`+import`、`+move`、`+copy`、`+create-folder`、`+update-title`、`+delete` | :1915649-5686 `+import` 示例集；:1920879 command_family 白名单；CHANGELOG #2172/#2129/#470 |
| markdown | `+create`（`--folder-token`/`--wiki-token`）、`+patch`、`+overwrite`、`+diff` | :1890069-0119；:1891713 目标参数；:1891723-1726 patch 语义 |
| wiki | `+node-create`（`space_id/title/obj_type/parent_node_token`）、`+node-copy`、`+node-delete`、`+move`、`+move-to-drive`、`+space-create` | :1918399 参数表；:1907270「写入操作」警示；CHANGELOG #320/#904/#960 |
| sheets/slides/base/im | 各域 `+media-upload`、`+update-*` 系列 | CHANGELOG #2346/#2537/#450 等（与本任务非重点） |

### 2.3 `docs +update` 详解（核心发现）

`--command` 子命令模型（全部为二进制内嵌 SKILL.md 示例原文）：

```
# 末尾追加（支持 markdown 格式）
lark-cli docs +update --doc "<url_or_token>" --command append --doc-format markdown --content $'<内容>'   (:1901172)

# 文本替换
lark-cli docs +update --doc "xx" --command str_replace --pattern "旧内容" --content "新内容"               (:1901973)

# 块替换（单块 / 范围）
lark-cli docs +update --doc "xx" --command block_replace --block-id blkTarget --content '<p>新段落</p>'    (:1901976)
lark-cli docs +update --doc "xx" --command block_replace --start-block-id blkFirst --end-block-id blkLast --content '<p></p>'  (:1901977)

# 锚点后插入
lark-cli docs +update --doc "xx" --command block_insert_after --block-id blkAnchor --content '<h2>新章节</h2><p>章节内容</p>'  (:1901979)

# 块删除（单块 / 范围）
lark-cli docs +update --doc "xx" --command block_delete --block-id blkA                                   (:1901982)
lark-cli docs +update --doc "xx" --command block_delete --start-block-id blkFirst --end-block-id blkLast   (:1901983)
```

**overwrite 全量覆写**（:1894780 内嵌工作流原文，语义完整）：

> 使用 `docs +fetch --doc "<doc>" --scope full --detail full --format json` 读取当前完整文档…目标与当前响应的 `revision_id` 相同时直接结束，不执行 `overwrite`。否则…仅执行一次 `docs +update --doc "<doc>" --command overwrite --revision-id <current_revision_id> --content @target.xml`，其中 `current_revision_id` 来自当前文档响应。目标响应包含非空 JSON object 形式的 `reference_map` 时…追加 `--reference-map @target-reference-map.json`…`+update` 不支持 `--yes`。

要点：
- **乐观并发控制（OCC）**：revision_id 相同即幂等跳过；飞书侧并发修改时 revision 冲突失败。「`overwrite` 返回 warning 或 `partial_success` 时，先核验最新内容。核验失败或发生 revision conflict 时停止，不要再次覆盖。」（:1894769）
- overwrite 内容格式为 **XML block**（`@target.xml`），非 markdown；append 示例明确用 `--doc-format markdown`。overwrite 是否兼容 markdown 格式**未见证据，待实测**。
- 响应含 `document.new_blocks`（block_id/block_token），可用于后续精确编辑（:1881580）。
- 内容转义有专门规则：「`docs +create` 或 `docs +update` 的 `--doc-format markdown` 写入内容时，字面文本中的特殊字符同样必须转义。`--pattern` 参数中也必须使用转义形式才能正确匹配。」（:1895653）

### 2.4 媒体回传命令

- `docs +media-insert --doc <doc_id> --file ./image.png [--type file] [--align center] [--caption "..."] [--width N]`、`--from-clipboard`（:1900057-0130）——文末插入本地图片/文件。
- `docs +media-upload --file ./image.png --parent-type <type> --parent-node <token>`（:1894966）——上传素材拿 media token。
- 网络 URL 图片可免上传直插：「除了上传本地文件，还可以在 `docs +update` 时直接通过网络 URL 插入图片」（:1900105-0106，`block_insert_after` + URL）。
- **gotcha（内嵌文档明示）**：「如果上一步是 `lark-doc-create`，并且它在知识库/知识空间场景下返回的是 `/wiki/...` 形式的 `doc_url`，后续调用 `docs +media-insert` 时应优先传 `doc_id`，不要直接传这个 `doc_url`。」（:1900147）
- 权限提示：「403 权限不足 → 检查 `docs:document.media:upload` scope；wiki URL 还需要 `wiki:node:read`」（:1890045）。

### 2.5 wiki 与 docx 的关系（CLI 内部解析）

- docs 域命令内部编排含「`[1] Resolve wiki node to docx document`」步骤（:1870176）；`--node-token`/`--doc` 接受 wiki URL、node_token、obj_token 或完整 URL（:1885992）。
- wiki 节点的 `obj_token` 即底层 docx document_id（:1886004 形如 `docxEXAMPLE`；与项目 `getNode()` 返回的 `obj_token/obj_type` 同构，lark-cli-client.ts:1021-1059）。
- **结论：wiki 空间内的 docx 更新走同一套 docs 写命令**（CLI 自动解析 wiki→docx），无需单独的 wiki 写 API；只有节点级操作（创建/移动/删除 wiki 节点）才走 `wiki +node-*`。

## 3. `api()` 透传通道分析

`api()`（lark-cli-client.ts:1062-1074）：

```ts
async api(method: 'GET' | 'POST', apiPath: string, options?: { params?; data?; as? }): Promise<any> {
  const args = ['api', method, apiPath, '--format', 'json'];
  if (options?.as) args.push('--as', options.as);
  if (options?.params) args.push('--params', JSON.stringify(options.params));
  if (options?.data) args.push('--data', JSON.stringify(options.data));
  return this.execute(args, 'wiki');
}
```

- **method 限制**：`'GET' | 'POST'` 是**应用侧 TS 类型约束**。CLI 侧 `api` 命令接受任意 method 字符串（README Raw API 层：「Call any Lark Open Platform endpoint directly, covering 2500+ APIs」）。OpenAPI 写端点几乎全部 POST，故现有签名已够用；若未来需要 PUT/PATCH/DELETE，放宽类型即可，CLI 侧无需改动（此为推断，未实测 DELETE）。
- 写调用构造示例（直接可用形态）：`api('POST', '/open-apis/docx/v1/documents/<document_id>/blocks/<block_id>/children', { params: { document_revision_id: -1 }, data: { children: [...], index: -1 } })`。
- 底层 docx blocks 端点在二进制中出现：`/open-apis/docx/v1/documents/:document_id/blocks/:document_id/children`（:1870425）、`/open-apis/docx/v1/documents/%s/blocks/%s/children/`（:1870309）——即 CLI 快捷命令的底层正是这些端点。
- **QPS 桶注意**：`api()` 硬编码 `apiType: 'wiki'`（3 QPS 桶 + 全局 3 QPS），批量块写入时会与 wiki 检测流量共享配额（lark-cli-client.ts:1067）。
- 错误分类复用现有链：非零退出 + stderr JSON 错误体 → `extractUpstreamCode` → `classifyError`（40403/131006 无权限、99991400 限频、3380003 已删除等，lark-cli-client.ts:1286-1320）——写通道错误可直接复用这套分类。

## 4. 「md 写回飞书」通道矩阵

前提事实：本地知识库 md 的正文（去 feishu_sync header 后）本就是 `docs +fetch --doc-format markdown` 的导出产物（lark-cli-client.ts:497-503 fetchDocumentMarkdown）+ 媒体引用本地化改写（media-reference.ts）。**写回的本质是同一 markdown 形态的反向链路**。

| 维度 | A. `docs +update` 增量写（append / str_replace / block_*） | A'. `docs +update --command overwrite` 全量覆写 | B. `drive +import --type docx` | C. `api()` 直调 docx blocks API | D. `markdown +create/+patch/+overwrite` |
|------|------|------|------|------|------|
| 语义 | 追加/文本替换/锚点块操作，保留其余块结构 | 先 fetch 拿 revision_id，单请求服务端原子覆写整篇 | 本地 .md → **新建**在线 docx（导入任务+轮询） | 自建 md→block 转换器，逐请求创建/更新/删除块 | 操作 Drive **原生 .md 文件**（非 docx 对象） |
| 能否更新既有文档 | ✅ | ✅ | ❌ 仅新建（内嵌分流规则 :1936732：md→在线 docx 用 import） | ✅ | 仅针对 Drive 原生 .md 对象 |
| 输入格式 | append 支持 **markdown**（:1901172）；str_replace 为纯文本 pattern；block_* 为 XML 片段 | **XML block**（@target.xml）；markdown 兼容性待实测 | 原生 .md 文件直传 | JSON block 数组（需完整 block 模型） | 原生 .md |
| md→云端转换成本 | **低-零**（append 直写 md）；diff 策略自建（下详） | 中（md→XML 转换器，项目内无现成代码；或实测 markdown 直写） | 零（文件直传） | **高**（document-ir.ts 只有 IR→md 正向渲染，无逆向；需从零写 md→docx-block 模型） | 零 |
| 原子性 | 单命令单请求；多次命令间无事务 | **单请求 + revision_id OCC**（revision 冲突失败不静默，:1894769） | 导入任务轮询至终态；新建本身原子 | 多请求无事务，部分失败需自建补偿（删旧写新间隔期文档处于不一致态） | patch 是 CLI 侧「下载-替换-覆盖上传」编排，**非服务端原子**（:1891723-1724）；overwrite 单请求 |
| 图片等媒体回传 | `+media-insert`/`+media-upload` 拿 token 后引用；网络 URL 图片可 block_insert_after 直插（:1900105） | 同左；XML 内 `<img token>` 引用 | import 时图片以相对路径随 md 打包上传（服务端解析；行为待实测） | 逐块引用 file_token，需先调 drive media upload | 原生 md 直接内嵌引用 |
| wiki 关系 | `--doc` 接受 wiki URL，CLI 内部 resolve wiki→docx（:1870176）；media-insert 需先解析成 doc_id（:1900147） | 同左 | `--folder-token` 指 Drive 目录；落 wiki 需再 wiki +node-create/move（多步非原子） | document_id 即 wiki 节点 obj_token，同 API | `--wiki-token` 可在 wiki 节点下创建原生 md（:1891713） |
| 协作语义 | 保留飞书侧评论/协作历史（只动目标块） | 整篇替换（块 ID 全变，评论锚点可能失效） | 新文档无历史 | 同 A' 且更碎 | 新对象 |
| 权限（scope） | `docx:document:write_only` + `docs:document.media:upload`（:1890045）+ wiki 场景 `wiki:node:read` | 同左 | `docs:document:import`（:1869796 二进制 scope 名） | `docx:document:write_only` | 原生 md 写 scope |
| 失败恢复 | 命令级失败即整命令无效果；可重试（幂等性视命令） | revision_id 预检天然幂等：重跑先 fetch，相同即跳过（:1894780） | 任务轮询可续查 ticket | 需自建断点续写 | patch 失败留原文件 |

### 通道 A 的 diff 策略谱系（项目侧待实现工作）

- **append-only**（最低成本）：把本地新增内容追加到文末。适合「只增不改」场景；改/删无法表达。
- **str_replace 批次**：对已知旧文本片段做替换。适合小修；大重构 pattern 会失效。
- **block_replace/insert/delete 序列**：需 fetch 拿 block_id 映射（响应含 `new_blocks`，:1881580），把 md diff 映射为块操作。成本中高，能力最强。
- **overwrite 兜底**：检测到结构级差异时整篇覆写。与 A 组合成「先试增量、失败降级覆写」策略。
- 项目内可复用基础：**无现成 md diff→写命令生成器**（document-ir.ts:66 renderDocumentMarkdown 仅正向；ContentAdapter 是 LLM 风格对齐非格式转换）。但正向 header 生成、media-reference 提取/改写、atomic-commit 的 staging 思想可借鉴。

## 5. 权限现状与需求

应用当前默认 scope 全为读类（config-manager.ts:66-76）：

```
wiki:node:retrieve, wiki:space:retrieve, docs:document.content:read,
sheets:spreadsheet:read, docx:document:readonly, drive:drive.metadata:readonly,
docs:document.media:download, slides:presentation:read, offline_access
```

写回需新增（二进制内 scope 名清单证实存在，:1869796/:1869918/:1869962/:1958147/:1958237）：

| scope | 用途 | 通道 |
|-------|------|------|
| `docx:document:write_only` | 更新 docx 正文 | A / A' / C |
| `docx:document:create` | 新建 docx | docs +create |
| `docs:document.media:upload` | 图片/附件回传 | A / A' / C（:1890045 明示 403 时查此 scope） |
| `docs:document:import` | drive import 通道 | B |
| `wiki:node:update` | wiki 节点创建/移动/删除（如需挂载新文档进知识库） | wiki 域 |

**scope 名失效风险（有实证先例）**：`docs:document:read` 曾整单拒绝 device authorization——「实测（lark-cli 1.0.93，OAuth 应用 cli_aab83ada483cdcc0 启用清单 198 项中无此名）带上它发起 device flow 会被整单拒绝」（config-manager.ts:60-64 注释，RETIRED_REQUEST_SCOPES 机制）。**每个新增 scope 必须先在真实应用上单独实测 device flow 接受性**，再进 DEFAULT_REQUIRED_SCOPES。飞书 scope 命名处于新旧交替期（SCOPE_ALIAS_GROUPS 先例），别名组机制可能需要扩展到写 scope。

## 6. 现有测试 mock 模式与写通道测试策略

### 6.1 既有三层 mock 模式（lark-cli 相关测试实证）

1. **execute 覆盖层**（lark-cli-client.test.ts:22-56）：`(client as any).execute = async (args) => …` ——不触碰子进程，断言 **argv 形状** + 返回结构化假数据。用于命令组装逻辑与解析逻辑。
2. **child_process 深层 mock**（lark-cli-exec-error.test.ts:1-51）：`vi.mock('child_process')` 只 mock execFile 最底层，execLarkCli 的 catch/extractUpstreamCode/classifyError 全部真实运行；`rejectNonZero(stdout, stderr, exitCode)` 构造 Node 真实失败形状（Error + .stdout/.stderr/.code）。其头注释明确记载了为什么不用上层 throw mock——会掩盖真实非零退出路径丢 upstreamCode 的 bug。
3. **结构化假 client 注入**（custom-doc-sync.ts:46-53 输入接口）：上层模块只依赖方法签名子集，测试注入假实现，避免 better-sqlite3/网络依赖。

### 6.2 写通道测试策略建议

- **新 client 方法**（如 `updateDocumentAppend` / `overwriteDocument` / `mediaInsert`）沿用模式 1：断言 argv（含 --command、--revision-id、--doc-format markdown）+ 假响应。
- **md→写命令序列生成器**（新模块，纯函数）：输入（旧云端 md、新本地 md）→ 输出命令序列（append/str_replace/overwrite 选择）。纯函数测试覆盖策略矩阵，零 I/O。
- **revision 冲突路径**沿用模式 2：mock execFile 返回 revision conflict 错误 JSON（真实失败形状），验证「不重试、不推进本地基线」——与同步引擎「不推进 synced」契约对称。
- **dry-run 冒烟**：lark-cli 写命令支持 `--dry-run`（README「Dry Run」节明示副作用命令预览），可作无副作用的 CLI 集成冒烟层。
- **端到端真写**：须由人工/授权流程在测试知识库执行，单测体系内不做真实写调用（遵守零副作用边界）。

## 7. 推荐结论

**推荐主通道：A（docs +update 家族），以 A'（overwrite + revision_id OCC）为全量替换与兜底**，理由：

1. **命令面完整且为官方快捷命令**：六种 --command 覆盖增量与全量；append 原生接受 markdown（与本地知识库 md 同构，转换成本≈0）。
2. **原子性最优**：overwrite 单请求 + revision_id 乐观并发，重跑幂等（fetch 相同 revision 即跳过）；优于 C 的多请求无事务编排。
3. **wiki 空间免费兼容**：--doc 接受 wiki URL，CLI 内部解析；无需区分 wiki/云端文档两套代码路径。
4. **错误分类/限流/认证态全部复用**：走 LarkCliClient.execute 既有队列+节流+classifyError。
5. **scope 增量最小**：更新场景仅需 write_only + media:upload 两个新 scope。

**辅助通道**：新建文档场景用 B（drive +import --type docx，文件直传零转换）或 docs +create（markdown 直建）；两者择一视是否需要 wiki 挂载（import 落 wiki 需多步）。

**不推荐 C 作为第一版**：md→docx-block 转换器从零写（项目只有正向渲染），多请求无事务，且 A' 已以单请求覆盖同等效果。C 仅在未来需要「评论保留+细粒度协作」时重评。

**D 不适用于本需求**：markdown 域操作的是 Drive 原生 .md 文件对象，不是既有 docx 的更新通道（CLI 内嵌分流规则明示二者是不同对象族，:1936806）。仅当未来目标是「wiki 里维护 md 原件」时重评。

### 风险清单

| # | 风险 | 等级 | 依据/缓解方向 |
|---|------|------|--------------|
| R1 | **自激振荡**：写回成功后云端 obj_edit_time 变化，ChangeDetector 将该文档报 modified，再次同步会用云端版覆盖本地编辑 | 高（设计级） | 写回成功后必须推进本地 synced/observed 基线到新 obj_edit_time（对称于 SyncEngine「提交成功才推进 synced」契约）；写回流程应与检测状态机联动 |
| R2 | scope 名失效/整单拒绝（先例 docs:document:read） | 高 | 新 scope 逐一实测 device flow；别名组机制扩展 |
| R3 | overwrite 是否接受 markdown 格式未证实；若仅 XML 则需 md→XML 转换器（中等成本） | 中 | §8 实测项 1/3 |
| R4 | 图片回传跨命令编排非原子：media-upload 拿 token 与内容写入是两次调用，中途失败留半态 | 中 | staging 思想（atomic-commit 先例）：先全部 media-upload 成功再写正文；失败清理已传媒体 |
| R5 | overwrite 使块 ID 全变、评论锚点可能失效；协作场景用户可感知 | 中 | 产品侧明示「全量替换 vs 增量」语义；默认增量优先 |
| R6 | markdown round-trip 非无损：fetch 导出形态与 overwrite 写回的云端渲染可能有差异（feishu 特有结构） | 中 | 实测 round-trip 样本（write→fetch 比对） |
| R7 | str_replace --pattern 的匹配语义（字面/正则、转义）未完全证实（:1895653 仅说需转义） | 低 | §8 实测项 4 |
| R8 | 大文档 overwrite 请求体上限未知 | 低 | §8 实测项 6 |
| R9 | 写权限判定：文档「有编辑权限」才能写，40403/131006 现有分类可复用但需补写场景文案 | 低 | classifyError 已有分支 |

## 8. 需要实测验证的点（本次全部未执行写调用/写副作用命令）

1. `lark-cli schema docs.+update`（schema 内省，只读）：拿 --command 权威完整枚举、各命令参数表、scope 要求、overwrite 输入格式（XML only or markdown 兼容）——README 证实 schema 命令存在。
2. 新 scope 名 device flow 接受性：docx:document:write_only / docx:document:create / docs:document.media:upload / docs:document:import / wiki:node:update 逐一验证（防 R2 整单拒绝）。
3. `docs +update --command overwrite --doc-format markdown` 组合是否被接受；不接受时 md→XML 的最小转换面（fetch --scope full 的 XML 形状即转换目标）。
4. str_replace --pattern 匹配语义与转义规则样本（中文/正则元字符/多行）。
5. `+media-upload` 返回的 media token 在 markdown/XML 内容中的引用语法；对同名图片的覆盖语义。
6. 大文档（如 1MB md）overwrite 的请求体上限与耗时（对照 timeoutMs=30s 默认值，可能需要加长）。
7. 写回→检测闭环：overwrite 后 obj_edit_time 变化量、ChangeDetector 报 modified 的时序、基线推进后的稳定态（R1 验证）。
8. api('POST', docx blocks children) 透传实际行为（children 数组上限、document_revision_id 参数语义）——C 通道备用面。
9. import 后新 docx 的 URL/token 返回形态与 wiki 挂载步骤数（B 通道完整性）。

## 9. 覆盖范围与证据强度说明

- **强证据（构建时嵌入文本/包内一手文档/项目源码）**：命令存在性、参数形态、scope 名存在性、OCC 语义、patch 非原子语义、wiki→docx 解析、媒体命令形态、错误契约（stdout ok / stderr error / 非零退出）。
- **推断（基于强证据+项目契约）**：通道推荐、diff 策略谱系、R1 自激振荡机制、api() method 可放宽。
- **未覆盖/负面发现边界**：
  - 未运行 --help/schema/dry-run（无 shell 工具）；--command 枚举来自已观察到的内嵌示例集，**未宣称穷尽**（可能存在 prepend/insert_before 等未观察命令，以 schema 内省为准）。
  - 未验证任何命令的运行时行为（包括只读的 schema/dry-run）。
  - 外部网页检索不可用（MCP 冻结），飞书 OpenAPI 官方文档的 scope 描述、children 单请求块数上限等未能与一手网页文档交叉核验；相关表述仅基于二进制内嵌文本。
  - `docs +create` 的完整参数面未深挖（本任务重点是更新既有文档）。
  - 搜索边界：二进制取证以 grep 模式命中为准；内嵌 SKILL.md 无逐字全文导出（无 shell 不可 strings），锚点 `lark-cli:NNN` 为二进制文件内 grep 命中行号。

## 附：证据锚点索引

| 锚点 | 位置 |
|------|------|
| lark-cli 版本/包名 | ~/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@larksuite/cli/package.json |
| 二进制内嵌文本（行号） | 同目录 bin/lark-cli（Go 二进制，grep 命中行号 :1869456-:1958237 区段） |
| resolveLarkCliExecutable 发现链 | server/src/modules/lark-cli-client.ts:348-410 |
| execute/队列/节流 | server/src/modules/lark-cli-client.ts:473-500（execute）、:106-125（QPS 桶） |
| api() 透传 | server/src/modules/lark-cli-client.ts:1062-1074 |
| fetchDocumentMarkdown | server/src/modules/lark-cli-client.ts:497-503 |
| 错误分类链 | server/src/modules/lark-cli-client.ts:1286-1320（classifyError）、:1200-1240（extractUpstreamCode） |
| DEFAULT_REQUIRED_SCOPES / RETIRED | server/src/modules/config-manager.ts:66-84 |
| SCOPE_ALIAS_GROUPS | server/src/modules/config-manager.ts:117-120 |
| document-ir 正向渲染（无逆向） | server/src/modules/document-ir.ts:66-114 |
| custom-doc-sync 组装链 | server/src/modules/custom-doc-sync.ts:1-20（头注释）、:46-53（假 client 接口） |
| sync-engine LLM/提交链 | server/src/modules/sync-engine.ts:1-46（头注释）、:793-830（DocumentIR 构建） |
| 测试 mock 三层 | server/tests/lark-cli-client.test.ts:18-56；server/tests/lark-cli-exec-error.test.ts:1-51 |
| CHANGELOG 写命令演进 | @larksuite/cli/CHANGELOG.md:1708（+create/+update v2）、:1767（pre-write warnings）、:1832（whiteboard 原子覆写对照）、:2072（drive import/move shortcuts）、:1953（wiki node-create） |
