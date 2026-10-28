# P0-S1 实测定形：写回历史 / 白板 SVG / 标题同步

- **日期**：2026-10-28 · **CLI**：`lark-cli 1.0.98`（user 身份，全 scope 集实测时刻可用）
- **对象**：专用测试文档 ×2（`feishu-sync-p0s1-probe` / `feishu-sync-p0s1-probe2`，`drive +import --type docx` 自建），**已全部删除并验证**（见 §清理）。
- **方法**：真实执行（读+写），全部命令原文与关键输出在 §各 HP 项；脱敏 fixture 落 `server/tests/fixtures/p0s1-lark-cli/`（README 有逐文件索引）。
- 上游输入：`lark-cli-newcaps-P0.md` §3/§9、S0 probe `lark-cli-newcaps-probe.md`。

---

## HP-1 history-list 输出形态 ✅

**命令**：`lark-cli docs +history-list --doc <t> --page-size 5 --format json`

新建（import）文档**立即**有 1 条历史，不存在空列表形态（解析器仍须容忍 `entries:[]`）：

```json
{"ok":true,"identity":"user","data":{"entries":[
  {"edit_time":"2026-10-28T09:05:03Z","editor_ids":["ou_…"],
   "history_version_id":"1024","revision_id":1,"type":1}],
 "has_more":false,"page_token":""}}
```

**结论**：
- `history_version_id` 是**字符串**，取值 1024×n 步进（1024/2048/3072/4096），与 revision 无耦合；`revision_id` 是数值。
- `edit_time` RFC3339Z（秒级取整）；同一操作产生的多条目可共享同一 `edit_time`。
- **没有编辑者姓名**，只有 `editor_ids`（open_id 数组）。→ 设计 §3 `DocHistoryEntry.editorName` 应改为 `editorIds: string[]`（要姓名需再查通讯录，v1 不做）。
- `type`：**1=建档、2=普通编辑、3=revert 产生的历史**——建议 DTO 保留 `type`，「云端历史」抽屉可用它标注「回滚快照」。
- `name`/`description` 字段未设置时不出现（可选字段）。
- **scope**：当前授权集直接通过，无需增量授权（未能降权隔离出最小 scope 名，对应用无影响：读历史与 fetch 同走既有读授权面）。

## HP-2 push→history-list→revert→revert-status→fetch 全链 ✅

链路（测试文档 1，基线 h1+段落，import 产生 rev1/rev2 两条历史）：

1. **append**：`lark-cli docs +update --doc <t> --command append --content @append-v2.xml` → `{result:"success", document:{revision_id:3}, warnings:[]}`。
2. **history-list**：出现 `2048/revision_id:2/type:2` 条目——**本次 append（rev3）的条目当时未出现**（见 HP-4 粒度）。
3. **revert 到 rev2 快照**：`lark-cli docs +history-revert --doc <t> --history-version-id 2048 --wait-timeout-ms 30000` → **同步完成**：
   ```json
   {"ok":true,"data":{"poll_after_ms":0,"status":"done","task_id":"6cd924ae-…"}}
   ```
   （done 时仍返回 task_id；`poll_after_ms:0`。）
4. **revert-status**：`docs +history-revert-status --doc <t> --task-id …` → `{"status":"done","failed_block_tokens":[]}`——**注意 `failed_block_tokens` 字段**，非空 = 部分块回滚失败，解析器必须读取。
5. **fetch 回读**：正文**逐字节恢复 rev2 状态**（h1+基线段，追加段消失），`revision_id:5`。
6. **revert 自身产生新历史**：list 出现 `4096/revision_id:4/type:3` → 设计 HP-2 假设成立：**回滚可再回滚**，U24 的「回滚前锚点」语义闭环。

**异步分支**（测试文档 2）：`--wait-timeout-ms 0` → `{"status":"running","task_id":"8d870a87-…","poll_after_ms":10000}` → 6s 后 status 轮询 `done`。`--wait-timeout-ms 0` 合法且是触发 running 形态的手段。

**附带语义**：revert 只回滚正文块，**文档 title 不回滚**（metadata 与正文分离）；revert 到建档条目（type=1）得到空正文（仅 title）——**UI 回滚目标应默认排除 type=1 建档条目**或明示「将清空正文」。

## HP-3 revert 权限 / 错误码 ✅

- **scope**：三个 history 命令在当前授权集全部通过；**无需新增 scope**（`WRITE_SCOPES` 不必为此扩充；最小集未隔离，见 HP-1 scope 注）。
- **错误码形态**（全部真实触发）：

| 场景 | 输出 | 分类建议（§3 classifyError） |
|---|---|---|
| 同文档并发 revert | `code:10020` "Another history revert task is already in progress…" | **可重试**类：先轮询再重试；与服务端单飞门对应，本地 `cloud_revert_running` 门是镜像 |
| 不存在的 history_version_id | `code:3380002` "INVALID ARGUMENT" | 不可重试、`history_not_found` |
| **目标是最新历史条目** | 同 `3380002`（最新条目被下一次写超越后才可作目标） | 同上；preview 校验 `entries[0]` 不可选 |
| `0` / 非正整数字符串 | CLI 本地 `validation/invalid_argument`（不发请求） | 参数错误 |

- CLI 进程退出码：API 错误时 **exit 1**（`ok:false` 即非零）。

## HP-4 whiteboard export：创建与双形态 ✅（含关键分支裁定）

**创建路径**（比设计假设更顺）：`docs +update --command append --content '<whiteboard type="mermaid">…</whiteboard>'`，**响应直接给画板 token**，无需 fetch 解析：

```json
{"data":{"new_blocks":[{"block_id":"doxcn…","block_token":"<画板token>","block_type":"whiteboard"}],"revision_id":6}}
```

**SVG 形态**（2 节点画板导出成功，1.6KB，fixture `whiteboard-min-sample.wb.svg`）：
- 标准 `<svg xmlns width="256" height="123" viewBox="…">` 头；尺寸在 width/height + viewBox。
- **文字是真实 `<text>/<tspan>` 节点，中文逐字原文，非路径化字形**（font-family 硬编码 Noto Sans SC）→ U28 抽取前提成立。
- 连线为无语义 `<path>` + `<defs><marker>`；节点 id（`t1:2`/`o1:1`）与 raw 的 node id 同源。
- 响应字段：`data.svg_path` + `size_bytes`（**不是** `output_path`；preview 是 `preview_image_path`，raw 落盘是 `output_path`——§3 方法解析须按类型取键）。

**关键限制（分支裁定依据）**：7 节点中文画板 svg 导出**稳定失败**——`{"type":"network","subtype":"timeout","message":"API call failed: server time out error"}`，**~6.5s 即返回**（服务端渲染错误，非客户端等待耗尽），重试 4 次全败；同画板 raw/preview/source 全部正常。失败是**内容相关**的（复杂度/节点数触发服务端渲染超时）。

**raw 形态**：稳定可用（17KB JSON，`data.nodes[]`，含几何/连线/样式）。文字抽取路径：形状 `nodes[i].text.text`（样式对象内层 `.text` 字符串）、连线标注 `nodes[i].connector.captions.data[j].text`。**source 形态**：`data.code`（mermaid 源码逐字往返）+ `syntax_type`，仅对源码派生画板有效。

### 分支裁定（U26/U28 修订建议）

**U28「只存 svg」不成立**——复杂画板 svg 恒定服务端超时，纯 svg 方案会让文字通道在这类画板上系统性缺失。裁定：
1. **svg 为主产物**（`<whiteboard_text origin="svg">` 首选源，文字节点语义最干净）；
2. **raw 为降级产物**：svg 导出失败（network/timeout 类）→ 导出 raw 落 `.wb.raw.json` 旁路，抽取器按 raw 路径取文字；两源都失败才 `whiteboard_svg_unavailable`；
3. 抽取器需双源实现（`extractSvgText` + `extractRawNodesText`），raw 源的 `<whiteboard_text origin="raw">` 同语义；
4. `sync.whiteboardSvg` 语义扩为「白板旁路导出」（svg+raw 降级链），配置名不变。

## HP-5 whiteboard scope ✅

- 现有授权集**覆盖**导出（`board:whiteboard:node:read` 已在授予集，export 成功即证）；无 missing scope 拦截（对照 slides screenshot 的 dry-run 拦截形态）。
- 错误形态见 HP-4：唯一触发的是内容相关服务端 timeout；**preview 扩展名须 `.jpg`**（本地校验：preview 响应是 jpg，`--output` 传 `.png` 被拒）——本应用同步链走既有 `media-download --type whiteboard`（PNG），不经 `+export preview`，不受影响。

## HP-6 update-title ✅

- **改名**：`drive +update-title --token <t> --type docx --title "feishu-sync-p0s1-probe 改名测试"` → `{"data":{"file_token":…,"title":…,"type":"docx","updated":true,"url":…}}`；`drive +inspect` 复核标题已变（fixture 双证）。
- **改回**：同命令同形态，`updated:true`。
- **类型错配**（docx token 传 `--type sheet`）：`code:981003 "not found."` + CLI hint（建议先 `+inspect` 核对类型）——与 probe §3 记载一致，U31「失败不自动换 type 重试」成立。
- **空标题**：CLI 本地拦截（`validation/invalid_argument`），hint 明示 API 会接受并把标题清空——服务层沿用 CLI 拦截 + 自身 `title_invalid` 门。
- 限流 `99991400` 未触发（仅 3 次串行调用）；help 确认 scope 码为 `99991672`（app 未申请）/`99991679`（user 未授予）。

## HP-7 update-title scope / wiki 差异 ⚠️ 部分

- **scope**：当前授权集**足够**（真实改名成功）。最小 scope 名未隔离（无法在不影响主上认证态的前提下降权实测）；实现侧维持「失败即 `scope_missing` 引导增量授权」的兜底即可。
- **wiki 行为**：**未测**——无 wiki 测试节点授权，红线禁止触生产知识库。help 文档面确认语义（node token + `--type wiki`，双向同步 node/文档标题；底层 obj token 不被接受）。**记为待验**：首个 wiki 场景接入时补一次实测（S9 验收项已含 wiki 成员改名）。

---

## 设计 §9 残余项（任务外顺带闭环）

- **§9 HP-3（fetch --revision-id）✅**：`docs +fetch --doc <t> --revision-id 2` 精确返回 rev2 历史版正文（响应回带 `revision_id:2`）。**id 空间注意**：`--revision-id` 收**数值 revision_id**，不是 history_version_id；history 条目同时携带两 id 即天然映射表。不存在版本 → `4000002`。→ U26「历史正文预览」具备数据通路（仍按设计留待后续）。
- **§9 HP-7（内嵌子资源回滚）✅**：含白板的文档 revert 到白板存在之前的段落状态后，fetch 显示**白板块随正文整体恢复**（token 保留、mermaid 源内联在 `<whiteboard token=…>` 块中，fixture `fetch-whiteboard-inline-restored.json`）。→ 回滚弹窗无需「内嵌白板不随回滚」警告（至少对白板块成立；sheet/bitable 未测）。
- **§9 HP-4（历史粒度）✅（重要）**：历史条目**异步定型**，三个实测证据：
  1. append（rev→3）后立即 list，rev3 条目缺失（数秒后被下一写触发才出现）；
  2. 条目 `revision_id`/`edit_time` 可被**回写更新**（2048 条目从 rev3@09:16:03 定型为 rev4@09:16:07）；
  3. 并非每个 revision 都有条目（doc2 的 rev2 始终无独立条目）。
  → **U23 保守设计必要且正确**：`entries[0]` 是「上一稳定版」，不保证覆盖写前全部云端修改，`anchor_exact` 判定按既有公式；U22 取 `pageSize:5` 足够。

## 清理确认 ✅

- 文档 1：`drive +delete --file-token … --type docx --yes` → `{deleted:true, status:"success", task_id:"schedule|…"}`；15s 后 `docs +fetch` → **3380003 Document deleted**（inspect 元数据短暂残留属缓存，内容 API 已确证删除）。
- 文档 2：同上，同样 3380003 验证。
- 无生产/知识库文档被触碰（全程仅两个 probe 文档；wiki 域零调用）。

## 对 S2（CLI 封装）的契约修订清单

1. `DocHistoryEntry`：`editorName` → `editorIds: string[]`；增 `revisionId: number`、`type: 1|2|3`；`historyVersionId: string`。
2. `revertDocumentHistory` 返回 `{status:'done'|'running', taskId, pollAfterMs}`（字段名 status/task_id/poll_after_ms）；`getHistoryRevertStatus` 返回 `{status, failedBlockTokens: string[]}`（非空=部分失败，需上抛警告）。
3. `exportWhiteboardSvg` 响应解析 `data.svg_path`（非统一 output 字段）；建议同步封装 `exportWhiteboardRaw`（`--output-type raw --output <path>` → `data.output_path`）。
4. `classifyError` 新增：`10020`（revert 并发，可重试·先轮询）、`3380002`（历史目标无效）、`3380003`（文档已删）、`4000002`（revision/block 参数无效）、`981003`/`981004`/`99991400`/`99991672`/`99991679`（按 §3 既有规划）。
5. UI/服务层语义增补：回滚目标排除「最新条目」与 type=1 建档条目（或明示后果）；revert 不回滚 title。
6. fixture 全部可被 S2 单测直接引用（`server/tests/fixtures/p0s1-lark-cli/`，含 README 索引与脱敏说明）。
