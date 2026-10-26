# 自定义文件夹归档审核修复报告（diting review）

修复 diting 审核「自定义文件夹归档」发现的 6 项 Major + 2 项 Minor。

> 注：审核报告原文路径（`reviewer/20260812-051300-review-custom-folder-archive/review-report.md`）在仓库中不存在；本修复严格依据任务内联的 8 条问题清单（含 file:line）逐条实现并自验。

## 变更文件

| 文件 | 涉及项 |
|---|---|
| `server/src/modules/custom-doc-sync.ts` | #1 媒体下载参数顺序；#3 回滚所需 committedFiles |
| `server/src/routes/custom-folders.ts` | #2 路径冲突；#3 原子回滚+批次隔离；#4 回退收紧；#5 去结构归属；#7 docs:[]；#8 错误分类 |
| `server/src/modules/local-map-store.ts` | #2 getDocumentByLocalRelPath；#5 setDocumentCustomFolder 置空 wiki_node_token/watched_root_* |
| `server/src/modules/reconciliation.ts` | #6 dbPath 自动读取 custom_folders 前缀 |
| `server/src/modules/reconciliation-apply.ts` | #6 透传 dbPath |
| `server/scripts/reconcile-knowledge-base.ts` | #6 传入 dbPath（默认标准库路径） |
| `server/scripts/reconcile-apply.ts` | #6 已传 dbPath（现被透传） |
| `server/scripts/gate2-closeout.ts` / `gate5-live-shadow-canary.ts` | #6 传入 dbPath |
| `server/tests/custom-folders.test.ts` | 新增 9 条回归用例 |
| `server/tests/reconciliation.test.ts` | 新增 1 条回归用例 |

## 逐项方案与证据

### Major #1 — downloadMedia/previewMedia 参数顺序反了
- **根因**：`LarkCliClient.downloadMedia(token, outputPath, type)` / `previewMedia(token, outputPath)`，而 `custom-doc-sync.ts` 调用 `downloadMedia(stem, ref.token, type)`、`previewMedia(stem, ref.token)` —— 参数颠倒，含图/白板/附件文档必然下载失败（旧测试因 fake client 把收到的「outputPath」当 token 写到 cwd 而误判通过）。
- **修复**：`custom-doc-sync.ts:264/272/304/306` 全部改为 `(ref.token, stem, ...)`。
- **测试**：`downloads doc media into the KB images dir (arg order fixed)` —— 归档含 `<image token=.../>` 的文档，断言图片落在 `_custom/Archive/images/` 且正文引用本地相对路径（旧顺序下此用例必失败）。

### Major #2 — 同标题文档静默覆盖
- **根因**：归档路径仅由标题生成，无冲突检测。
- **修复**：新增 `resolveUniqueDocRelPath`（`custom-folders.ts:118`）：同时查 DB（新增 `local-map-store.ts:1374 getDocumentByLocalRelPath`，归属不同 obj_token 即视为占用）与磁盘文件，冲突时追加 `-2/-3…`，保证一文档一文件、文件与 DB 行一一对应。
- **测试**：`two same-title docs get distinct files (-2 suffix) and distinct DB rows`。

### Major #3 — 文件提交与 DB 写入不原子 + 单文档异常中断批次
- **根因**：DB 写失败后文件不回滚；`setDocumentCustomFolder` 未被 try/catch 包裹，抛出即中断整个批次。
- **修复**：
  - `custom-doc-sync.ts` 返回 `committedFiles`（md + 全部 media/attachment 绝对路径，`custom-doc-sync.ts:80/220`）。
  - `custom-folders.ts:686-707`：DB 写入失败时 `fs.rmSync` 删除该文档刚落盘的全部 committedFiles，返回 `fetch_failed`+「已回滚」。
  - 批次循环 `custom-folders.ts:411-435`：每条 link 包 try/catch，单文档任何意外 throw 转为单条 error result，不中断其它文档。
- **测试**：`rolls back the committed file when the DB write fails`（Proxy store 注入 DB 写异常，断言文件已删除 + 错误含「已回滚」）；`a sync throw on one link still returns a result for the rest`。

### Major #4 — 非 wiki 回退未限定 131005 / 未校验 host
- **根因**：getNode 任意失败都走 URL 提取 + fetch，权限错误与恶意 host 均可绕过。
- **修复**（`custom-folders.ts:491-502`）：回退触发条件收紧为 `error instanceof LarkCliError && error.upstreamCode === '131005'`；URL 提取前用 `isAllowedFeishuHost`（`custom-folders.ts:180`，白名单 feishu.cn/larksuite.com/larkoffice.com 及子域）校验，不通过则 `parse_failed`。非 131005 错误一律原样上抛（classifyLinkError）。
- **测试**：`rejects fallback for a non-feishu host (host whitelist)`；`does not fall back when getNode fails with a permission error`（断言无 DB 行/文件，证明未回退）。

### Major #5 — wiki 归档保留 wiki_node_token 致结构树重复命中
- **根因**：归档时 DB 行保留 `wiki_node_token`，而结构树 feishu-view 查询按 `wiki_node_token IS NOT NULL` 过滤 → 同一文档同时出现在结构树/自定义归档。
- **修复**（选择「置空 + 拒绝已在结构树内的文档」的语义清晰且改动小方案）：
  - `custom-folders.ts:659/686`：归档时对 `syncDocxToCustomFolder` 与 `setDocumentCustomFolder` 均传 `wikiNodeToken: null`（文件头与 DB 一致，均为纯文档语义；provenance 由 `original_link` 保留）。
  - `local-map-store.ts:1334-1336`：`setDocumentCustomFolder` ON CONFLICT 显式 `wiki_node_token = excluded.wiki_node_token`、`watched_root_url = NULL`、`watched_root_id = NULL`（去掉旧 COALESCE，确保重新归档也置空）。
  - 已在结构树（watchedRoot）内的文档：现有 `getDocumentByObjToken` 早返回 `already_exists` + `existingLocation='已在同步结构树'`，即「拒绝并提示」语义（无需额外改动）。
- **测试**：`nulls wiki_node_token so the archived wiki doc leaves the structure tree`（断言 wikiNodeToken/watchedRootUrl/watchedRootId 均 null）；`rejects a wiki doc already present in the structure tree`。

### Major #6 — 对账入口未传 customFolderRelPaths 致 _custom 被误判
- **根因**：`buildReconciliationReport` 依赖可选 `customFolderRelPaths`，正式脚本入口均未传入。
- **修复**（消除对可选参数的依赖，库自服务）：
  - `reconciliation.ts:88` `ReconciliationOptions` 增 `dbPath?`；`reconciliation.ts:218` 优先用显式参数，否则 `readCustomFolderRelPathsFromDb(dbPath)`（`reconciliation.ts:505`，用 `createRequire` 按需加载 better-sqlite3 只读读取 `custom_folders.local_rel_path`，DB/表缺失返回 `[]`）。
  - `reconciliation-apply.ts:90` 透传 `dbPath`。
  - 所有正式脚本入口（`reconcile-knowledge-base.ts`、`reconcile-apply.ts`、`gate2-closeout.ts`、`gate5-live-shadow-canary.ts`）传入 dbPath（前者新增 `--db`，默认 `~/.feishu-sync/feishu-sync.db`）。
- **测试**：`auto-loads custom-folder prefixes from dbPath so _custom is not outside_watched_roots`（对比：不传 dbPath 时 _custom=outside_watched_roots；传 dbPath 后 _custom 被排除、watched-root 文档照常分类）。

### Minor #7 — POST/PATCH 响应缺 docs:[]
- **修复**：`custom-folders.ts:305/343` POST 201 与 PATCH 200 均返回 `{ folder: { ...folder, docs: [] } }`，对齐前端 `CustomFolder.docs` 类型。
- **测试**：`POST and PATCH responses include docs: []`；server 实测 `mk=201 {..."docs":[]}`。

### Minor #8 — 普通写盘错误误分类为 parse_failed
- **修复**：`classifyLinkError`（`custom-folders.ts:154`）默认分支由 `parse_failed` 改为 `fetch_failed`；`parse_failed` 仅保留给真正的解析失败（LarkCliError code='parse' + 调用方显式提取失败）。
- **测试**：`classifies a generic write error as fetch_failed, not parse_failed`（把文件夹目录堵成文件触发提交失败，断言非 parse_failed）。

## 验证

| 验收 | 证据 | 状态 |
|---|---|---|
| 全量测试 | `npx vitest run` → **35 files / 392 passed**（基线 381 + 新增 11） | ✅ |
| server tsc | `npx tsc --noEmit` 干净（含 `noUnusedLocals`） | ✅ |
| 前端构建 | `npm run build` → 1804 modules，built in 991ms | ✅ |
| server 启动复测 | 起 standalone server：health=200、GET /api/custom-folders=200、POST=201 且响应含 `docs:[]` | ✅ |
| 同标题不覆盖 | 单测「two same-title docs ...」：两文件 `Same Title.md` / `Same Title-2.md` 独立存在、两 DB 行 localRelPath 不同 | ✅ |
| media 图片文档可下载 | 单测「downloads doc media ...」：图片落 `_custom/Archive/images/`、正文引用本地路径、不再因参数错序失败 | ✅ |
| 恶意 host/非 131005 不回退 | 单测「rejects fallback for a non-feishu host」+「does not fall back ... permission」：均无 DB 行/文件，分别 parse_failed / permission_denied | ✅ |
| 对账入口不误判 _custom | 单测「auto-loads custom-folder prefixes from dbPath」：传 dbPath 后 _custom 不再被判 outside_watched_roots | ✅ |

## 剩余风险 / 未覆盖项

- 真实飞书 lark-cli 端到端归档（含真实 media 下载、真实 131005）需在已认证环境由用户复测；本修复以「真实路由 → 真实 LocalMapStore → 真实 atomic-commit → 真实文件系统 + 签名正确的 fake lark-cli」集成测试覆盖，可抓住合理实现错误。
- `readCustomFolderRelPathsFromDb` 在 DB 存在但 custom_folders 表缺失时返回 `[]`（旧库兼容，安全降级）。
