# 标准库反向发布到飞书

反向发布把**标准知识库某个 release 的文档**发布为飞书云文档：在发布根下逐篇平铺创建，之后可以「更新」方式继续同步。云端版本只是浏览副本——组织元数据（knowledge.json、状态 sidecar）不随飞书分发，权威以本地 release 为准。发布不产生回流：发布根必须位于所有同步（监听）目录之外。

当前版本的操作入口是 CLI 命令与 HTTP API（见下文命令一节）；服务端实现在 `server/src/kb/publication-service.ts` 与 `server/src/routes/kb-publications.ts`。

## 前置条件

四道门全部就绪才能执行发布（`preview` 不强制，会随计划返回各门状态）：

| 门 | 配置/动作 |
|---|---|
| 飞书写入开关 | `feishuWrite.enabled = true`（默认关） |
| 写权限 | 已授予 `docx:document:write_only`（在飞书认证设置发起 `scopeSet=write` 增量授权；反向发布与源文档写回共用同一权限门） |
| 反向发布开关 | `feishuPublish.enabled = true`（默认关） |
| 发布根 | `feishuPublish.target` 已配置且通过双向校验 |

配置段结构：

```json
"feishuPublish": {
  "enabled": false,
  "target": { "kind": "drive_folder | wiki_node", "token": "…", "label": "…", "spaceId": "…" }
}
```

`feishuPublish` 与 `feishuWrite` 两段只接受应用内（desktop token 链路）修改：CLI 主体经 `config set` 禁改该段，`PUT /api/config` 对 CLI 主体丢弃该段，发布根路由直接拒绝 CLI 主体。关闭开关或清除发布根不删除已发布的云端文档，重新配置后可继续更新。

## 发布根

发布根用专用端点设置与清除（仅 desktop token）：

- `PUT /api/kb/publish/target`，body `{ url }`（粘贴链接）或 `{ kind, token, label? }`（结构化）或 `{ target: null }`（清除）。粘贴链接接受 `/drive/folder/<token>` 与 `/wiki/<token>` 两种形态，保存时即时校验。
- **双向不重叠校验（防自我喂养）**：发布根（wiki 节点）与任一同步根（watchedRoot）的祖先链双向比对——发布根在同步树内返回 409 `publish_target_inside_watched_root`（已发布内容会被同步回流），同步树在发布根内返回 409 `watched_root_inside_publish_target`。祖先链不可读时按 502 `publish_target_unverifiable` fail-closed 拒绝：不能证明不重叠就不允许配置。Drive 文件夹与 wiki 子树不同命名空间，天然不重叠。
- 该校验同时在配置保存路径收敛：`feishuPublish` 段或 `watchedRoots` 任一变化、且发布根身份实际改变时，对候选配置重新做完整祖先链交叉验证。
- 发布执行前还有一次廉价复核（发布根 token 不得等于任一同步根身份），防止配置漂移。

## 发布流程：preview → confirm → planKey

1. **预览**（`POST /api/kb/publish/preview`，只读，不改任何记录）：对指定 release（缺省 CURRENT）或选定 `kbPaths` 子集生成计划。计划给出每篇文档的动作、警告、门控状态、`planKey` 与执行所需确认值 `confirmRequired`。
2. **确认执行**（`POST /api/kb/publish`，body 同上 + `confirm`，可选 `planKey`）：`confirm` 必须等于计划派生的确认值——常规发布 `PUBLISH`；`force: true` 且计划含被 force 解除的云端冲突时升级为 `OVERWRITE_PUBLISHED`。传入 `planKey` 时执行前复核计划未变（planKey 由 release 与各文档动作清单构成，任一变化即 409 `publish_plan_changed` 重新预览）；云端并发修改不在 planKey 内，由执行时覆盖前的独立比对拦截（见「安全边界」）。
3. **执行**（逐文档串行；同实例同时只允许一个发布任务，409 `publish_in_progress`）。本批新建文档会做**两遍发布**：第一遍创建后拿到各文档云端 URL，第二遍把这些 URL 回填为文档间互链再覆盖一次（哈希未变则跳过）。

单项动作决策：

| 动作 | 触发条件 |
|---|---|
| `create` | 该路径无发布记录，或发布行无 cloud_token（从未成功创建）；`force` 下 unknown/creating/cloud_missing 状态也转为重新创建为新文档（旧 cloud_token 归档） |
| `update` | 发布行有 cloud_token 且渲染内容哈希变化（含 conflict、kb_removed 重现、failed 后哈希变化），覆盖更新已发布的云文档 |
| `skip_unchanged` | 内容哈希与上次发布一致且状态为 published/published_with_warnings/failed |
| `blocked` | 渲染失败、云端冲突（`publish_cloud_edited`）、状态未知（`state_unknown`）、云端文档缺失（`cloud_missing`）、v2 release 中候选/争议/废弃对象缺少正文状态说明（`kb_status_prompt_missing`） |

全量发布（未指定 `kbPaths`）时，release 中已不存在的已发布路径只标记 `kb_removed`（计划与结果中列出），**不执行任何远端删除动作**——发布链没有任何删除调用。

## 发布映射与状态（kb_publications）

每篇已发布文档在 `kb_publications` 表有一行（kb_path 为主键），记录 cloud_token、cloud_url、发布根、发布时的 release/内容哈希/云端编辑时间与状态：

| 状态 | 含义 |
|---|---|
| `creating` | 创建已起步未确认成功 |
| `published` / `published_with_warnings` | 已发布（含非阻断警告） |
| `conflict` | 云端在发布后有新的修改，需人工核对 |
| `failed` | 上次动作失败（哈希不变时重发可 skip） |
| `unknown` | 创建/覆盖命令发出后结果不确定（超时/解析失败），须人工核对后再以 force 重新发布为新文档；旧 cloud_token 归档进 `previousCloudTokens` 谱系 |
| `kb_removed` | 文档已不在 release 中（云端文档保留） |
| `cloud_missing` | 云端文档已不存在 |

构建快照会排除 `kb_publications` 谱系（当前 cloud_token 与归档的 previousCloudTokens）命中的源，防止把发布副本再次纳入构建——这是防自我喂养的第二道防线。

## 命令

| 命令 | 风险级 | 确认 | 说明 |
|---|---|---|---|
| `feishu-sync kb publish-preview` | read | — | 预览计划（参数 `releaseId` / `kbPaths` / `force` 与 API 同） |
| `feishu-sync kb publish … --yes` | remote_write | `--yes` 注入 `PUBLISH`；带 `--force` 注入 `OVERWRITE_PUBLISHED`（实际无冲突时服务端会要求 `PUBLISH`，按提示重试） | 执行发布 |
| `feishu-sync kb publications` | read | — | 查看发布映射与状态 |

完整命令约定（退出码、`--json`、参数写法）见 [CLI 命令参考](cli-reference.md)。应用内 Agent 经 `app_command` 发起发布时走会话内批准流，确认值由服务端按真实预览派生。

## 安全边界

- **永不删除云文档**：发布链没有任何删除调用；KB 中已删除的文档只标 `kb_removed`。
- **不静默覆盖他人编辑**：每次覆盖前重新取云端 `obj_edit_time` 与发布基线比对，云端前进或不可读即 fail-closed 置 `conflict`（`publish_cloud_edited`）；重发需 `force` 并升级确认值 `OVERWRITE_PUBLISHED`。覆盖前先取云端最新历史作回退锚点并落 `source_push_log` 行，取不到锚点或落库失败则拒绝覆盖。
- **创建不确定不重建**：create/overwrite 命令发出后超时、解析失败或响应不完整一律置 `unknown`，不自动重发（非幂等，防重复云文档）；须人工核对后以 `force` 重新发布为新文档。
- **回读校验**：每篇写入后回读云端正文做字符量比对（比值区间 [0.8, 1.25]），失配按失败处理，不静默放行。
- **发布互斥**：同一实例同时只允许一个发布任务；发布期间该 release 被标记「使用中」，版本保留策略的清理会跳过它。
- **内容审查门**：v2 release 中 businessStatus 为候选/争议/废弃的知识对象，其正文范围内必须含状态边界说明，否则该文档被阻止反向分发（飞书端不携带状态标注，缺失会被误读为已确认结论）。

审计：`<数据根>/agent/audit/kb-publish.jsonl`（publish_started / item_created / item_updated / item_failed / publish_finished，不记正文）。

## 失败处置

| 错误/状态 | 处置 |
|---|---|
| `publish_disabled` / `feishu_write_disabled` / `feishu_write_scope_missing` / `publish_target_not_configured` | 按前置条件表补齐开关、授权或发布根 |
| `publish_target_invalid`（含 `publish_target_unverifiable`） | 更换发布根或稍后重试；祖先链不可读时可用 Drive 文件夹作发布根 |
| `confirmation_required` | 按返回的 `required` 值重发；CLI 用 `--yes`（force 场景注意上文确认值升级规则） |
| `publish_plan_changed` | 批准与执行之间 release 或动作清单变化，重新预览后再执行（云端并发修改由执行时覆盖前的独立比对拦截，见「安全边界」） |
| `publish_in_progress` | 等待当前发布任务结束 |
| 行状态 `conflict`（`publish_cloud_edited`） | 到飞书核对云端修改；确认覆盖用 `force --yes`（`OVERWRITE_PUBLISHED`），或放弃更新 |
| 行状态 `unknown` | 到飞书核对是否已创建/更新；核对后以 `force` 重新发布（旧 token 自动归档，不重复计数） |
| `kb_doc_not_found` / `kb_not_published` | 检查 `kbPaths` 是否在指定 release 中；标准库尚未发布时先完成构建发布 |

源文档正文写回飞书（另一条独立链路）见[源文档云端操作](source-cloud-operations.md)。
