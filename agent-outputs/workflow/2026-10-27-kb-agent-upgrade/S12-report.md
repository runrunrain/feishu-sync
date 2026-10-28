# S12 报告：飞书写回（FeishuWriteService + 三段式安全协议）

- 上游输入：`docs/design/kb-agent-upgrade-design.md` §7.4–§7.6 / §8 / §9.1 / §10（S12 行，已按 S0 实测修订）、`S0-write-probe.md` §③定值表+§④落地建议、`S11-report.md`（source_edits/markSourceEditPushed/SourceWriteLock/edit-status）、`server/src/modules/lark-cli-client.ts`
- 产物：代码（见 §一）+ 测试 `server/tests/source-push.test.ts`（43 用例）+ 本报告
- 范围外（按任务书）：真实云端冒烟（Leader 集成阶段执行，步骤见 §六）、UI（S13）、`GET /api/mapping/content` 增字段（S13，edit-status 已覆盖）、媒体回传 `docs:document.media:upload`（v1 不申请）

## 一、改动清单（写面登记）

### 本切片写面内

| 文件 | 性质 | 内容 |
|---|---|---|
| `server/src/sources/push-planner.ts` | 新增 | 转义归一化层（`normalizeForCompare`/`normalizeLine`）+ 写面转义（`escapeLiteralAngleBracketsForWrite`）+ `containsLocalMediaReference` + `planPush` 全分支（纯函数，无 I/O） |
| `server/src/sources/feishu-write-service.ts` | 新增 | `FeishuWriteService`（preview/push、三段式 overwrite、U20① 前置比较、状态机、审计）+ `FeishuWriteError` |
| `server/tests/source-push.test.ts` | 新增 | 43 用例（§七验收映射） |
| `server/src/routes/feishu.ts` | 追加 | `POST /api/sources/:objToken/push/preview` + `POST /api/sources/:objToken/push` + `createFeishuWriteService`/`pullSyncSingleDocument` + device/start `scopeSet` 解析 + auth-status `writeScopesGranted`。**既有端点零语义改动** |
| `server/src/modules/lark-cli-client.ts` | 只追加方法 | `updateDocumentAppend` / `overwriteDocument` / `fetchDocumentRevision`（+私有 `updateDocument` 临时文件封装）。既有读链路与 CONFIG_INIT 无关，零改动 |
| `server/src/modules/lark-cli-manager.ts` | 追加常量+可选参数 | `WRITE_SCOPES=['docx:document:write_only']`、`DeviceAuthScopeSet`、`startDeviceAuth(mode, {scopeSet?})`（缺省 read，既有调用 argv 字节不变）、`DeviceAuthSession.scopeSet`。**CONFIG_INIT_URL_RE 未动** |
| `server/src/types/index.ts` | 只追加 | `FeishuWriteConfig`、Config.feishuWrite?、`SourcePushPlanDto`、`SourcePushResultDto` |
| `server/src/modules/config-manager.ts` | 只追加 | `normalizeFeishuWriteConfigLoose`/`validateFeishuWriteConfig` + load/updateConfig/DEFAULT_CONFIG 三处 feishuWrite 段（同 S8 cli 模式） |
| `server/src/modules/local-map-store.ts` | 只追加方法 | `markSourceEditPushing` / `markSourceEditConflict` / `markSourceEditPushAborted`（回 dirty 不推 edit_count）/ `markInterruptedSourceEditPushes`（启动对账，S11 报告建议项） |
| `server/src/index.ts` | 追加 4 行 | schema 初始化后调 `markInterruptedSourceEditPushes()`（pushing→conflict/push_interrupted）+ 日志 |

### 既有测试更新（本切片授权面内）

`server/tests/lark-cli-manager.test.ts` 3 处断言更新：session 增 `scopeSet:'read'` 字段、route spy 断言 `startDeviceAuth` 新增第二参数 `{scopeSet:'read'}`——这是任务书指定的 scopeSet 扩展的契约性更新，read 路径行为不变。

## 二、三段式 overwrite 时序（S0 D5 反例的防御协议）

```
push(objToken, {allowOverwrite, force, confirm, actor})
│
├─ 前置门
│   ├─ kbBuild.isActive() → 409 kb_build_active          ←【偏差 A1，见 §五】
│   ├─ !feishuWrite.enabled → 403 feishu_write_disabled
│   └─ checkAuthReady scopes ⊉ WRITE_SCOPES → 403 feishu_write_scope_missing
│
├─ SourceWriteLock(objToken) 锁内
│   ├─ 行校验：无行 404；pushing 409 source_push_in_progress
│   ├─ base.md 读取（缺失 500 push_base_missing）
│   ├─ planPush（归一化前缀/相等判断）
│   │     blocked → 422 source_push_blocked(details.reason)
│   ├─ confirm 门：overwrite‖force → 'OVERWRITE_CLOUD'；否则 'PUSH'（400 confirmation_required）
│   ├─ markSourceEditPushing
│   ├─ U20① obj_edit_time 前置比较（drive metas batch，ChangeDetector 同通道）
│   │     cloud > base 且非 force → conflict + 409 source_push_conflict
│   │     （metas 读失败 → 容错跳过，三段式③兜底；S0 D6 受限项）
│   ├─ append 分支：转义后缀 → updateDocumentAppend（非幂等，不重试）
│   └─ overwrite 三段式：
│       ① fetchDocumentRevision（docx v1 documents API，S0 D6 写后即时可读）
│          失败 → 回 dirty + 502（未写入任何内容）
│       ② 同流程立即 overwriteDocument(token, escaped, rev①)
│          rev 仅防未来值（S0 D5：旧 rev 静默接受致内容重复——绝不重试旧值）
│          4000002 → conflict(push_revision_conflict)
│          timeout → conflict(push_outcome_unknown)
│          其他 → 回 dirty + 502 feishu_write_failed(details.larkCode)
│       ③ 写后回读校验：fetchDocumentMarkdown → normalizeForCompare 双侧归一
│          失配 → conflict(push_readback_mismatch)，停止，不重试
│          fetch 失败 → conflict(push_outcome_unknown)（写已发生）
│   └─ 成功 → markSourceEditPushed(pushMode, pushRevisionId) + 审计
│
└─ 锁外：pullSync(objToken)（SyncEngine apply:true/'APPLY' 单文档回拉）
    ├─ 成功 → SyncEngine.finalizePushedSourceEdit 清行删备份（S11 已交付，不重复实现）
    └─ 失败 → 行保留 pushed，响应 pull 如实上报（用户手动同步收敛）
```

append 成功链路：转义后缀 → updateDocumentAppend → pushed → 回拉 → 清行（push_outcome_unknown 场景：append 超时即置 conflict，**不自动重推**）。

## 三、转义归一化规则表（`push-planner.ts`，单测锚定 S0 D3/D4 样例）

| # | 规则 | 写入侧 | 导出侧（S0 实测） | 实现 |
|---|---|---|---|---|
| 1 | 段落内 `\|` 字节失真 | `a\|b` | `a|b`（非敏感位置不重新转义） | 双侧对称反转 `\\|`→`\|` |
| 2 | 段落内 `\[` `\]` 字节失真 | `\[非链接\]` | `[非链接]` | 对称反转 `\\[`→`[`、`\\]`→`]` |
| 3 | `\<` 反转（S12 写面转义的对称面） | `\<img …`（我们写入的转义形态） | `\<img …`（`<` 在无条件转义集，导出保留） | 对称反转 `\\<`→`<`；比较基线恒为未转义原文 |
| 4 | 表格分隔行规范化 | `\|---\|---\|` | `\|-\|-\|`（每格 dash/colon 连续段折叠） | 仅 `\|:- \t` 组成且含 `\|` 与 `-` 的行：split('`|`')→trim→`-{2,}`→`-`、`:{2,}`→`:` |
| 5 | `<title>` 导出附加行 | —（正文无此行） | 首行 `<title>…</title>` + 空行 | 剥离首行 title + 紧随 1 个空行（import 建档文档形态） |
| 6 | 文档末尾换行 | 任意尾空白 | 无结尾换行 | 双侧去文档级尾随空白（首部空白保留） |
| 7 | 写面 `<` 转义（发送方向） | 字面 `<`（sync-engine 产物 `<img>/<whiteboard>/<sheet>` 标签、数学 `a < b`） | —（云端存字面 `<`，导出回 `\<`） | `(?<!\\)<` → `\<`（已转义不重复） |

- `\\*` 等无条件转义类导出字节保留（D3 实测），无需归一。
- **planPush 前缀判断**：原文前缀（常规路径）→ 直接切尾；否则行对齐归一化前缀（既有行仅发生归一化等价变化）→ 末行必须是原文前缀扩展才切分，否则退 overwrite 决策（不安全切分宁可覆盖）。
- **本地媒体检测**（images_in_append/overwrite）：XML 媒体标签（image/img/file/source/whiteboard/sheet）的 token/src/path 属性值非云端 token 且非 https URL，或 markdown 图片目标非 https/非云端 token（`images/…`、`@./…`）。`![](https://feishu.cn/file/<token>)` 回拉形态不算本地引用。

## 四、push API 契约（S13 UI / CLI 消费）

### 授权与配置（§7.6）

- `POST /api/feishu/auth/device/start` body 增 `scopeSet?: 'read'|'write'`（缺省 read）；write = requiredScopes ∪ `WRITE_SCOPES`；响应含 `scopeSet` + `requestedScopes`（授权页需勾选全部 N 项提示沿用）。
- `GET /api/feishu/auth-status` 响应增 `writeScopesGranted: boolean`（WRITE_SCOPES ⊆ currentScopes）。
- 配置 `feishuWrite: { enabled: boolean }`（默认 false；`PUT /api/config` 走严格校验 `invalid_config`；CLI 令牌域仅在 `/api/cli/*`，结构上到不了 PUT /api/config，§7.6「只接受 desktop token」由既有 desktop auth 结构保证）。

### push/preview 与 push（错误码并入 §8）

| 方法/路径 | 请求 | 响应/错误 |
|---|---|---|
| POST `/api/sources/:objToken/push/preview` | — | `SourcePushPlanDto`：`{mode:'append'|'overwrite'|'blocked'; blockedReason?; appendMarkdown?; bytes; cloud:{objEditTime,revisionId}; conflict; warnings[]}`。preview 以能力上限规划（allowOverwrite=true）；未开启/缺 scope → blocked(write_disabled/write_scope_missing) |
| POST `/api/sources/:objToken/push` | `{allowOverwrite?, force?, confirm:'PUSH'|'OVERWRITE_CLOUD', actor?}` | `{state, mode, revisionId, pull:{ok,status,message?}}` |

错误码：403 `feishu_write_disabled`/`feishu_write_scope_missing`(details.missingScopes)；404 `source_edit_not_found`；409 `source_push_conflict`(details.cloudObjEditTime 或 lastErrorCode)/`source_push_in_progress`/`kb_build_active`；422 `source_push_blocked`(details.reason)；400 `confirmation_required`/`invalid_json`；502 `feishu_write_failed`(details.larkCode + 消息前 500 字)；500 `push_base_missing`（§8 表外新码，S14 并入）。

confirm 规则（§7.4 原样）：append 且无 force → `PUSH`；overwrite 或 force → `OVERWRITE_CLOUD`。conflict 态 details.lastErrorCode：`source_push_conflict`/`push_revision_conflict`/`push_readback_mismatch`/`push_outcome_unknown`/`push_interrupted`（启动对账）。

## 五、决策与偏差记录

1. **A1 构建活跃拒绝 push（409 kb_build_active）**：设计 §7.5 推送顺序未列此门，但回拉经 SyncEngine 覆写源正文，与 S11「编辑/放弃修改在构建中拒绝」同一不变量家族（构建快照 vs 源变更竞态）。已按同码拒绝并在测试外标注（任务书未列，属保守扩展；S13 UI 按现有 kb_build_active 文案消费）。
2. **U20① 容错降级**：metas 读失败/无时间戳时跳过前置比较（warning 记入 preview），overwrite 由三段式③兜底——S0 D6 实测 Drive 元数据面受限；append 本身无覆盖语义，风险面不变。
3. **`startDeviceAuth` 签名扩展**：任务书要求 scopeSet 入参；以「可选第二参数 + 缺省 read」实现，既有 3 处测试断言按新契约更新（read 行为字节不变），非纯追加但无行为回归（263/263 定向回归）。
4. **审计落位**：`<dataRoot>/agent/audit/source-pushes.jsonl`（time/actor/objToken/relPath/op=push/mode/bytes/revisionId/result/errorCode），与 S11 source-edits.jsonl 并列——设计 §7.2 的 `<dataRoot>/audit/source-writes.jsonl` 路径由 S11 先落为 `agent/audit/` 前缀，沿用其惯例。
5. **pushed 行直接重推**：不额外设门——U20① 前置比较天然拦截（推送成功后 cloud 时间必越过 base）；Drive 面不可读时靠③回读兜底（append 无③，S13 建议 pushed 行只显示「重试回拉」不显示「写回」）。
6. **回拉 enableLLM=false**：写回拉回的是用户编辑文本，不叠加 LLM 整理（POST /api/sync 默认同语义）。
7. **`@file` cwd 语义（任务书要求核对）**：`LarkCliClient.execute(args, api, {cwd})` 的 cwd 直通 execFile `options.cwd`（lark-cli-client.ts execLarkCli），即 lark-cli 子进程工作目录；`--content @content.md` 由 CLI 按**子进程 cwd 相对**解析（S0 §②-S2：绝对路径报 `unsafe file path`）。实现：mkdtemp 临时目录 + 纯文件名 + `{cwd: 该目录}`；正文不进 argv/日志（§9.1 不变量 5），finally 递归清理。
8. **图片回拉形态衔接（任务书 §7）**：`![](https://feishu.cn/file/<token>)` 与既有 media-reference **一致，无需改动**——`media-reference.ts` `isFeishuHost` 收 feishu.cn/larksuite.com 域、`tokenFromKnownPath` 显式匹配 `/file/<token>`、`classifyUrlContext` 把 `![…](URL` 前缀归类 markdown-image → 下载 + 本地引用重写链路原样工作。
9. **`<sheet>/<whiteboard>` 云端 token 标签也会被 `\<` 转义为字面文本**：任务书明确「字面 `<` 必须 `\<` 转义」（S0 §④-4）。后果：overwrite 会把内嵌 sheet/白板块降级为文本（v1 无块级回写通道，设计 §7.1 明示不在范围）。真实冒烟时需带此类文档验证可接受性（§六步骤 6）。
10. **planPush 的 images 检测阻断白板/附件 markdown 引用**：sync-engine 把本地化白板/附件渲染为 `![…](images/…)`/`[…](attachments/…)`——含此类引用的正文 append 后缀/overwrite 全文会被 images_in_* 阻断（正确：云端无法解析本地路径）。

## 六、真实冒烟步骤清单（供 Leader 执行；测试文档流程，S0 同款）

1. **环境**：`lark-cli auth status --json --verify` 就绪；设置页开启「飞书写入」→ 发起 `scopeSet:'write'` device flow（POST `/api/feishu/auth/device/start` body `{"scopeSet":"write"}`）→ 浏览器授权页勾选全部项 → complete → `GET /api/feishu/auth-status` 确认 `writeScopesGranted:true`。
2. **建测试文档**：`lark-cli drive +import --file <tmp.md> --type docx --name "feishu-sync-s12-smoke-<ts>" --json` 记录 token；应用内登记或直接对该 token 走编辑链（`POST /api/sources/:token/edit`，newText 形态 + edit-status 取 baseHash）。
3. **append 冒烟**：`POST /push/preview` 确认 mode=append → `POST /push {confirm:'PUSH'}` → 200 且 pull.ok=true → 行删除、本地文件被回拉更新、飞书侧肉眼核对追加内容（重点：含 `<` 标签文本落为字面、表格分隔行）。
4. **overwrite 冒烟**：再次编辑改标题+表格 → preview mode=overwrite → `POST /push {allowOverwrite:true, confirm:'OVERWRITE_CLOUD'}` → 回读校验过 → 云端核对。
5. **冲突路径**：云端手动改一次 → 本地再编辑 → push 应 409 source_push_conflict；`force+OVERWRITE_CLOUD` 重推成功。
6. **样例扩充（S0 风险 §⑤-3）**：步骤 2 的 tmp.md 覆盖嵌套列表、代码块、引用块、mermaid、`~~删除线~~`、任务列表——回读校验若误报 push_readback_mismatch，扩充 `normalizeForCompare` 规则表并补单测。
7. **带 `<sheet>/<whiteboard>` 文档**（步骤 9 偏差）：确认文本化降级可接受，否则升级方案回 Leader。
8. **清理**：`lark-cli drive +delete --file-token <t> --type docx --yes` + fetch 复核。

## 七、验证证据

| 项 | 命令/入口 | 结果 |
|---|---|---|
| 本切片测试 | `cd server && npx vitest run tests/source-push.test.ts` | **43/43 通过**（planPush 7 分支；归一化 S0 D3/D4 样例；XML 标签转义含闭合标签；本地媒体检测；client argv 3 命令 + 临时文件内容/清理 + 空输入快速失败；append 成功链（转义后缀/pushed/回拉清行/审计）+ 回拉失败留 pushed；三段式成功（rev=fetch 值/ops 顺序）+ 回读失配 conflict 不重试 + 4000002 conflict + ①段 fetch 失败回 dirty 零写入 + ②段其他错误回 dirty 保留 larkCode + ③段读不回 push_outcome_unknown；obj_edit_time 前进 409 + force 越过；append 超时 push_outcome_unknown；confirm 门两向 400；写门 403×2；plan blocked 422×3 态 + pushing 409；无行 404 + base.md 缺失 500；preview 计划/门/conflict+警告；store 4 原语 + 启动对账；路由 preview/push/confirm 门/409 形状/auth-status writeScopesGranted/scopeSet 校验；manager read/write 两次 start scope 集断言） |
| 定向回归（触碰文件全量） | `npx vitest run tests/lark-cli-client.test.ts tests/lark-cli-manager.test.ts tests/lark-cli-device-auth-shell.test.ts tests/lark-cli-exec-error.test.ts tests/config-manager.test.ts tests/config-routes.test.ts tests/source-edit.test.ts tests/local-map-store.test.ts tests/sync-engine.test.ts tests/sync-engine-atomic.test.ts` | **263/263 通过** |
| 全量 server | `cd server && npm test` | **1091/1111；20 失败全部位于 `kb-version.test.ts`/`provider-protocol-live.test.ts`/`agent-internal-auth.test.ts`**——三者 import 链仅含兄弟切片正在改写的 `agent-tool-service.ts`（未提交 diff 468 行）与 `kb-build-service.ts`（未提交 diff 921 行），失败签名（`kb_unit_done` 未调用、「4 个只读工具」计数）为兄弟中间态；对三者源码 grep S12 关键字零命中，本切片写面 263/263 全绿 |
| typecheck | `npm run typecheck`（root 三段） | exit 2 仅剩 `src/kb/kb-build-service.ts` 3 处错误（兄弟 WorkerRuntime 重构中间态：TS6133/TS2741）；**本切片全部文件 0 错误**（此前 task-tools.ts 兄弟解析错误已由其自行修复） |
| lint | `npx eslint`（本切片 10 个文件） | 0 error 0 warning |
| ABI | `node -e "require('better-sqlite3')"` | 通过（未触发 NODE_MODULE_VERSION） |

## 八、回滚

- 代码：全部为新增文件/追加式修改，反向 patch 即可——删 `sources/push-planner.ts`、`sources/feishu-write-service.ts`、`tests/source-push.test.ts`；feishu.ts 删 push 两路由与 createFeishuWriteService/pullSyncSingleDocument、device/start scopeSet 段、auth-status 字段；lark-cli-client.ts 删 S12 方法块；lark-cli-manager.ts 还原 startDeviceAuth 签名与 WRITE_SCOPES；config-manager/types/local-map-store/index.ts 按追加块反向删除；lark-cli-manager.test.ts 3 处断言还原。
- 数据：feishuWrite 配置段缺省 false（不开启即无行为）；source_edits 无 schema 变化；审计文件 `agent/audit/source-pushes.jsonl` 与数据根同生命周期。
- 云端：无自动写行为（push 全部经显式 confirm 门）。

## 九、未覆盖/风险

- 真实云端冒烟（§六，Leader 执行）：归一化规则表样本覆盖度（S0 §⑤-3 未测形态）、大文档 overwrite 上限、`feishu.cn/file/<token>` 下载可达性（需 download scope，S0 §⑤-6）。
- U20① 的 TOFTOU 窗口：设计已明示唯一防线不承诺消除；Drive 面无 metas 时降级为「三段式③ only」。
- pushed 行重推在 Drive 面（metas 不可读）缺前置拦截，仅 overwrite 有③兜底（§五-5，S13 UI 侧建议屏蔽）。
- `npm test` 全量绿以 harness 结算隔离快照为准（兄弟 kb-build/agent-tool 中间态在共享树上与并行任务并存，本切片无法替其收敛）。
