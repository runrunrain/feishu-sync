# P1-S8 发布服务报告：标准库 md → 飞书文档（计划/执行/两遍发布/回读校验）

> 任务：`kb_publications` 表 + `kb/publication-service.ts`（门控/计划/执行/回读校验/冲突 fail-closed/creating 对账）+ `routes/kb-publications.ts`（preview/execute/列表/详情/target）+ CLI 与 app_command 双通道命令 + 审计 + 快照排除与 release 在用标记。
> 设计依据：`lark-cli-newcaps-P1.md` §4（全部小节）；上游：P1-S7 `renderForPublish`/`countText`、P1-S1 PB 实测定稿（create 响应 document_id+url、`--title` 单独传、parse 口径 [0.8,1.25]）。

## 一、产物与写面

| 文件 | 状态 | 内容 |
|---|---|---|
| `server/src/kb/publication-service.ts` | 新建 | KbPublishService + 双向校验纯核心 + release 在用标记（46KB） |
| `server/src/routes/kb-publications.ts` | 新建 | 5 条路由（preview/publish/publications/详情/target） |
| `server/tests/kb-publication.test.ts` | 新建 | 40 用例（算法层 + in-memory LMS + lark stub + 真实路由） |
| `server/src/modules/local-map-store.ts` | 追加 | `kb_publications` 双登记 + 5 个行方法 |
| `server/src/modules/lark-cli-client.ts` | 追加 | `createDocumentMarkdown` / `parseDocumentProfile` 最小封装 |
| `server/src/types/index.ts` | 追加 | `FeishuPublishConfig`/`PublishTargetConfig`/行类型 + `Config.feishuPublish?` |
| `server/src/modules/config-manager.ts` | 追加 | feishuPublish 段四处接线（默认/严格校验/合并/宽容归一） |
| `server/src/routes/config.ts` | 追加 | CLI 主体丢弃 `feishuPublish` 段（与 feishuWrite 同门） |
| `server/src/ops/command-table.ts` | 追加 | `CONFIG_SET_FORBIDDEN` + feishuPublish；3 条命令 |
| `server/src/index.ts` | 追加 | import + 启动对账 + 路由挂载 + `publishedTokensProvider` |
| `server/src/kb/kb-build-service.ts` | 追加 | 快照排除 + 构建警告 + 清理跳过在用 release |

未动 sync-engine；既有读写链路 argv 零改动（lark-cli-client 只新增方法）。

## 二、API 契约（P1-S9 UI 消费）

### POST /api/kb/publish/preview
body `{ releaseId?, kbPaths?: string[], force? }`（kbPaths 缺省=整个 release；显式 releaseId 时无 CURRENT 也可发布——release 不可变）。
响应 `PublishPlanDto`：

```ts
{
  releaseId: string;                 // 实际发布的 release
  target: { kind, token, spaceId?, label } | null;
  planKey: string;                   // `releaseId|kbPath:action,…`（kbPath 排序）
  items: Array<{
    kbPath, title, contentHash,
    action: 'create' | 'update' | 'skip_unchanged' | 'blocked',
    blockedReason?: 'publish_cloud_edited' | 'cloud_missing' | 'state_unknown' | 'render_failed',
    warnings: [{ code, kbPath, target?, text?, local?, cloud? }],
    state,                            // 当前行状态（null=无行）
    cloudToken, cloudUrl,
    cloudEdited: boolean              // publish_cloud_edited 冲突（force 可解除）
  }>;
  removed: string[];                  // 全量模式将置 kb_removed 的路径
  gates: { feishuWriteEnabled, writeScopesGranted, missingScopes, publishEnabled, targetConfigured };
  confirmRequired: 'PUBLISH' | 'OVERWRITE_PUBLISHED';
}
```

preview 只读（previewSpecs 安全）；云端 metas 批量取 update 候选的 obj_edit_time（≤200/批）。

### POST /api/kb/publish
body 同上 + `confirm`（必填）+ `planKey?`（复核，变化 → 409 `publish_plan_changed`）+ `actor?`（'ui'|'cli'|'agent'，审计用）。
响应 `PublishRunResultDto`：`{ releaseId, target, items: [{kbPath, action, outcome, state, cloudToken, cloudUrl, warnings, error?}], removedMarked, counts: {created, updated, skipped, blocked, failed, secondPass} }`。

### GET /api/kb/publications 与 /api/kb/publications/:kbPath
行 DTO = LMS 行 + 解析后的 `warnings: { warnings[], previousCloudTokens? }`。列表 kb_path 序；详情无行 404 `publication_not_found`。路径参数需 URL 编码（含 `/`）。

### PUT /api/kb/publish/target（仅 desktop token）
body `{ url, label?, spaceId? }`（粘贴 `/drive/folder/<t>` 或 `/wiki/<t>`）| `{ kind, token, label?, spaceId? }` | `{ target: null }` 清除。
即时双向校验（wiki 走云端祖先链，深度 ≤50，解析失败 502 `publish_target_unverifiable` fail-closed；命中 → 409 `publish_target_inside_watched_root` / `watched_root_inside_publish_target`）。CLI 主体（`X-Feishu-Sync-Actor: cli` 或 CLI 令牌）→ 403。

### 错误码
`publish_disabled`/`feishu_write_disabled`/`feishu_write_scope_missing`(403) → `publish_target_not_configured`/`publish_target_invalid`/`publish_in_progress`/`publish_plan_changed`(409) → `kb_not_published`/`kb_doc_not_found`(404) → `invalid_request`/`confirmation_required`(400)。

## 三、命令契约（CLI + app_command）

| 命令 | risk | confirm | 路由 |
|---|---|---|---|
| `kb.publish-preview` | read | — | POST /api/kb/publish/preview（releaseId/kbPaths/force 透传） |
| `kb.publish` | remote_write | `PUBLISH` | POST /api/kb/publish（body 内置 actor:'cli'） |
| `kb.publications` | read | — | GET /api/kb/publications |

- `kb.publish` 挂 **confirmPlan**（与 source.push 同一 T3d-05R 机制）：批准前经真实 preview 派生确认值——`force ∧ 计划含被 force 解除的冲突（cloudEdited）→ OVERWRITE_PUBLISHED`，否则 `PUBLISH`；全部阻断（无 create/update 项）→ `OpsArgumentError publish_plan_not_executable` 拒绝；批准后复核 planKey，变化 → `approval_plan_expired` 重新批准。
- CLI `--yes` 注入基线值 `PUBLISH`；request() 静态猜测 `force→OVERWRITE_PUBLISHED`（force 但无冲突时服务端以 `confirmation_required` 提示实际所需值——与 source.push 同款已知限制）。
- `config.set` 禁改 `feishuPublish.*`（`CONFIG_SET_FORBIDDEN`）；`PUT /api/config` 对 CLI 主体丢弃 `feishuPublish` 段。

## 四、发布状态机（§4.7 实现）

```
(无行) ──create──▶ creating ──成功+校验通过──▶ published
                     └─成功+校验偏差/不可用──▶ published_with_warnings
                     ├─业务错误──▶ failed ──（重发）──▶ creating
                     └─超时/重启对账──▶ unknown ──force 重新发布为新文档──▶ create（旧 token 归档 previousCloudTokens）
published* ──KB 内容变化──▶ update 候选 ──时间门通过──▶ overwrite ──▶ published*
              │                 ├─云端时间前进或不可读──▶ blocked(publish_cloud_edited)，行置 conflict
              │                 │      └─force+OVERWRITE_PUBLISHED──▶ update
              │                 └─404/981003──▶ cloud_missing ──force──▶ create（归档旧 token）
              └─KB 已删除（全量发布）──▶ kb_removed ──路径重现──▶ update（沿用旧 cloud_token）
```

关键语义：
- **跳过判定按任务书**：已有记录且 `contentHash` 相同 → `skip_unchanged`（不查云端时间——云端手改但本地未变时不重推，符合「contentHash 相同→跳过」契约）。
- **冲突 fail-closed**：仅 update 候选（hash 不同）触发时间门；云端 `obj_edit_time > published_obj_edit_time` 或**不可读**均 → `publish_cloud_edited`；execute 时行置 `conflict` 并记录 lastError，零写调用。
- **creating 对账**：启动时 `reconcileKbPublicationsCreating()` 把全部残留 creating 行 → `unknown`（不重建）；运行中计划的 creating/unknown 行 → `blocked(state_unknown)`，force → 重新发布为新文档。
- **两遍发布**：第一遍后用「全部已发布行 URL ∪ 本批新建 URL」重渲染，`contentHash` 变化才立即 overwrite 一次（首发布互链完整；本批创建失败的项无 token 跳过）。
- **回读校验**：`parseDocumentProfile` 的 `char_count` / `countText(body).chars ∉ [0.8,1.25]` → 警告 `publish_verify_mismatch{local,cloud}`、state=`published_with_warnings`；parse 失败 → `publish_verify_unavailable`（不判失败，不自动撤销——撤销即删除，违反「永不删除」）。
- **obj_edit_time 基线**：每次成功写入后回读 metas 记录 `published_obj_edit_time`（不可读记 null，下次 update 时间门 fail-closed）。

## 五、门控与双向校验（防自我喂养）

执行门（requireGates，顺序即拒绝顺序）：`feishuPublish.enabled` → `feishuWrite.enabled` → 写 scope（`docx:document:write_only`）→ target 已配置 → target 廉价复核（token 不得等于任一 watchedRoot 身份；完整祖先链校验在 target 设置时做过一次）。

**双向校验**（任务书表述「发布根必须在所有监听目录之外，且监听目录不得在发布根内」的实现裁定）：发布根是云侧目标（`drive_folder|wiki_node`），watchedRoots 是 wiki 子树——云 token 与本地路径不可比，因此**方向 A/B 均按 watchedRoot 身份（id + URL node token）比对**：A. target token 等于 watchedRoot 身份或其祖先链（getNode 上溯 ≤50，环路/到根即停）命中任一 watchedRoot → 拒；B. 任一 watchedRoot 祖先链含 target token → 拒。drive_folder 与 wiki 不同命名空间，双向天然不重叠（设计 §4.1）。祖先解析失败 → `publish_target_unverifiable` fail-closed 拒绝配置。

**快照排除**（防线 2）：kb-build-service 构建快照排除 `listPublishedCloudTokens()` 命中的源（用户把已发布文档移进监听树时同步仍如实镜像，但构建排除），并给构建警告 `published_doc_in_sources`（§4.1）；排除只作用于构建。

**release 在用标记**：`markReleaseInUse/releaseInUseEnded`（模块级注册表），`cleanupOldReleases` 跳过使用中的 release（§4.6 原子钩子已按「无此钩子则 P1-S8 增加」落地）。

**永不删除**：发布链路零删除调用；`kb_removed` 只改行状态。

## 六、配置段与审计

- `feishuPublish: { enabled: false, target?: { kind, token, spaceId?, label } | null }`（additive；load 宽容归一、PUT 严格校验、CLI 双通道禁改）。
- 临时文件：`createDocumentMarkdown`/`overwriteDocument` 均在 client 封装内 mkdtemp + 子进程 cwd 相对 `@file`（不落 argv/日志）——设计 §4.4 的 `<dataRoot>/agent/publish-tmp/` 落点由该封装承担（与 S12 写回同一已审安全属性），隔离语义一致。
- 审计 `<dataRoot>/agent/audit/kb-publish.jsonl`：`publish_started | item_created | item_updated | item_failed(result/errorCode) | publish_finished`，含 releaseId/kbPath/cloudToken/actor/secondPass/contentHash/objEditTime，不记正文。

## 七、并行冲突记录（任务书要求）

- **P0-S3 先落 LMS**：本任务开始时 LMS 无 `source_push_log`，实施中途 P0-S3 兄弟任务先提交（imports `SourcePushLogRecord`、表、行方法）。**已按「先到为准后者重读」处理**：重新读取目标区域后把 `kb_publications` 追加在 `source_push_log` 块之后，双登记两处均完成；无语义冲突。
- **P0-S4 中间态**：终验时 `server/src/sources/cloud-history-service.ts`（兄弟任务未跟踪新文件）有 tsc 错误（'last' possibly null），非本任务写面；排除该文件后全仓 typecheck 绿。
- 共享文件 `config-manager.ts`/`lark-cli-client.ts`/`types/index.ts` 与 P1-S5/P0 系并行改动为互不重叠的追加式修改。

## 八、验证证据

| 验证 | 命令（cwd） | 结果 |
|---|---|---|
| 定向单测 | `npx vitest run tests/kb-publication.test.ts`（server） | **40/40 绿**（两遍发布全链/冲突 fail-closed/creating→unknown/cloud_missing/超时→unknown/kb_removed/门控双向校验/命令表+confirmPlan 派生/迁移双登记/路由含 PUT target 三态） |
| 回归 | vitest：ops-command-table + config-manager + config-routes + local-map-store + lark-cli-client + source-push + cli-source-commands + kb-build(+parallel) + kb-version + mcp-kb + publish-render + text-stats + agent-status-regression + cli-endpoint + cors | **369/369 绿**（16 文件） |
| 类型 | `npm run typecheck`（root 三段） | 退出码 0（P0-S4 中间态文件落地前）；排除兄弟文件后 server 段亦 0 错 |
| Lint | `npx eslint <11 个本任务文件>`（root） | 0 error |

未运行全量 `npm test`：共享树有并行兄弟任务（luban/98f81dca、luban/94c47b9f 及 P0 系）中间态，全量套件可能撞非本任务失败；结算基线由 harness 隔离快照执行。

## 九、边界与未覆盖项（P1-S9 注意）

1. **title 更新不在 update 发布内**：`docs +update` 不传 title（设计 §4.4 未定义）；`updateDocumentTitle` 已存在于 client，若需标题同步属后续切片。
2. **skip_unchanged 不查云端时间**（任务书契约「hash 相同→跳过」）：云端被手改但本地未变的文档不会被阻断/重推；如需「云端手改探测」需另设计。
3. **/api/kb/status、/changes 的 pending 计数未排除已发布 token**（快照排除只接线在构建，按设计 §4.1「排除只作用于标准库构建」）；已发布文档移入监听树后这两个入口会持续显示其为待构建源，构建时才被排除并出警告。
4. **wiki_node 发布根的创建路径未实测**（P1-S1 只实测了 Drive 文件夹）；配置面接受 wiki 节点，若 PB-1 后续实测失败按设计降级为只允许 drive_folder。
5. **parse 比值区间为设计常量 [0.8,1.25]**（P1-S1 实测 1.02–1.05），样本仅 2 份；S9 真机联调后可按设计预留的中位数校准再收紧。
6. **进程内互斥**：发布任务互斥是服务实例内存态（publish_in_progress），多进程场景（desktop+standalone 同库）不设防——与现有构建互斥同口径。
7. `<cite type="citation">` 参考文献形态 create 时被飞书静默丢弃（P1-S1 已知边界，发布 v1 不阻断不告警）。

## 十、回滚方式

删除 3 个新文件（publication-service.ts / kb-publications.ts / kb-publication.test.ts）并还原 8 个共享文件的追加块即可；`kb_publications` 表保留无害（旧版本应用忽略新表）。关闭功能只需 `feishuPublish.enabled=false`——已发布云文档由用户在飞书自行处置，映射表保留以便重新启用时继续 update 而非重建。
