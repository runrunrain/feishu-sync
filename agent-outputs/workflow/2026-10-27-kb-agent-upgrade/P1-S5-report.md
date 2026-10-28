# P1-S5 报告：可选读 scope 机制 + slides 截图采集（同步侧）

- 日期：2026-10-28 · 分支：`feat/agent-knowledge-workbench`（共享树）
- 上游输入：`lark-cli-newcaps-P1.md` §3.1–3.4、`P1-S1-probe.md`（SP-1 实测定型：scope 校验先于一切、`missing_scopes` 仅 `slides:presentation:screenshot`、`--slide-number` 逗号 ints 可解析、错误原文存档于 `server/tests/fixtures/p1s1-lark-cli/`）
- 状态：**已实施**；主验证面（scope 未授权时的跳过路径）已按 mock 全覆盖，真实采集路径待主上授权后按 §5 清单实测。

## 1. 规格 → 产物 → 证据

| # | 规格 | 产物 | 证据 |
|---|---|---|---|
| 1 | `OPTIONAL_READ_SCOPES` 注册表（首项 slidesScreenshots） | `server/src/modules/lark-cli-manager.ts`：`OptionalReadFeature` / `OPTIONAL_READ_SCOPES` / `optionalScopesForFeature` / `allOptionalReadScopes` / `enabledOptionalScopes` | `tests/p1-s5-slides-screenshot.test.ts`「注册表首项」「enabledOptionalScopes」用例 |
| 2 | device flow 请求基线并入可选集（§3.4：scopeSet 沿用当前值） | `lark-cli-manager.ts` `startDeviceAuth` 增 `options.includeOptionalScopes`；未显式传 scopeSet 时按已授集合自动判定（已授 ⊇ WRITE_SCOPES → write，否则 read）；整单 invalid scope 拒绝仍降级最小必需集（可选集一并退场） | 「includeOptionalScopes=true 并入/自动 write」「已授无写集→read 不误申请写权限」「缺省 argv 字节不变」「invalid scope 降级」4 用例 |
| 3 | auth-status 增 `optionalScopes:{granted,missing}` | `server/src/routes/feishu.ts` `GET /api/feishu/auth-status`（注册表全量对照已授集合；异常态形态稳定）；`POST /api/feishu/auth/device/start` body 增 `includeOptionalScopes`（非法类型 400） | 路由 3 用例（Hono 真实请求入口） |
| 4 | 不改变默认 requiredScopes 行为 | 可选 scope 不进 `requiredScopes` / `checkAuthReady` 校验；开关全关时 `enabledOptionalScopes()=[]`，device flow argv 与既有逐字节一致 | 「缺省 argv 字节不变」+ 既有 `lark-cli-manager.test.ts` 63 用例全绿未改 |
| 5 | `screenshotSlides` client 方法（只追加） | `server/src/modules/lark-cli-client.ts`：`SlidesScreenshotOutput` 接口 + `screenshotSlides`（argv：`slides +screenshot --as user --presentation <t> --slide-number <n1,n2> --output-dir <rel> --format json`；页码升序去重、1–10 页校验；输出围栏同 fetchMediaToPath：cwd=父目录 + 逐条 containment 校验拒绝逃逸）；apiType 新增 `slides` 桶（1 QPS，仍受全局 3 QPS） | client describe 6 用例（argv/入参拒绝/退化扫描/无映射拒绝/围栏逃逸） |
| 6 | scope 缺失错误透传分类 `missing_scope` | `LarkCliErrorCode` 增 `'missing_scope'`；`classifyError` 新分支保留上游原文（含 scope 名与 CLI 增量授权 hint），retryable=false | 「P1-S1 SP-1 错误原文」用例（fixture 同源样本） |
| 7 | 同步侧流程（§3.2 最小追加） | `server/src/modules/sync-engine.ts`：`FetchedDocument.slideCount`（fetchSlidesContent 从 adapter 带出）→ `stageSlidesScreenshots`（开关→页数上限 60→scope 授权缓存一次 checkAuthReady→≤10/批→魔数/体积校验→落 `images/<docname>-pNN.<ext>`）→ `appendSlidesScreenshotReferences`（每页一行 `- 幻灯片 N 截图：![…](images/…)`，位于该页既有媒体行之前；无媒体区时按同格式创建） | 同步侧 7 用例（见下） |
| 8 | all-or-none | 任一页失败 → 删除全部已暂存截图（含先前批次成品）→ 返回空 → 正文与现状逐字节一致；截图失败是警告（`slides_screenshot_unavailable(reason=…)` console.warn）不是阻断，文档照常提交、基线照常推进 | 「任一页失败→零截图引用且与关闭态逐字节一致」「非图片魔数判失败」用例 |
| 9 | scope 缺失即跳过（主验证面） | 引擎持有授权缓存（每实例一次 `checkAuthReady({verify:false})`）；未授权/未启用 → 零 `screenshotSlides` 调用、正文与关闭态逐字节一致 | 「scope 缺失→零调用+字节一致」用例（主上当前真实形态：screenshot scope 未授权） |
| 10 | 配置 additive `sync.slidesScreenshot:{enabled}`（段位按设计 §3.2 的 `sync` 段） | `server/src/types/index.ts` `SyncConfig` + `Config.sync?`；`config-manager.ts`：`normalizeSyncConfigLoose`（load 宽容）/`validateSyncConfig`（PUT 严格）/`DEFAULT_CONFIG.sync`/`migrateConfig`/`updateConfig` 显式提供时采用（同 S8 cli/S12 feishuWrite 模式） | 「normalize/validate/ConfigManager 落盘回读」3 用例；旧配置无段 → 默认关闭 |
| 11 | 默认行为零变化（既有 slides 同步测试不改全绿） | — | 既有 `sync-engine(-atomic).test.ts`、`lark-cli(-client/-manager).test.ts`、`config-*` 全部未改动全绿；server 全量 95 文件 1340 用例绿；root 三段 typecheck 绿；eslint 绿 |

自验命令（cwd=`server/`）：`npx vitest run tests/p1-s5-slides-screenshot.test.ts`（28 用例）；全量 `npx vitest run`（1340 用例）；根 `npm run typecheck`；根 `npx eslint <改动文件>`。均 exit 0。

## 2. 配置契约

```jsonc
// ~/.feishu-sync/config.json（additive 段，旧配置无此段时内存补默认，不触发迁移回写）
{
  "sync": {
    "slidesScreenshot": { "enabled": false }   // 缺省 false
  }
}
```

- 写入面：`PUT /api/config`（严格校验：非法类型 400 invalid_config）→ `ConfigManager.updateConfig` 显式提供时采用。
- 语义：`enabled=true` 只代表「愿意采集」；实际采集还需当前授权含 `slides:presentation:screenshot`（auth-status `optionalScopes.missing` 非空 → 设置页弹增量授权）。用户放弃授权时配置保持 true，状态显示「已开启，等待授权」，同步侧合法跳过并记警告（§3.4）。
- 关闭开关不撤 scope（lark-cli 无单 scope 撤销语义）。
- 与设计 §3.2 的偏差：任务书只要求 `enabled` 字段，`slidesScreenshotMaxPages` 配置项未实施；页数上限以常量 60 落在引擎内（超限警告 `too_many_pages` 并跳过）。如需可调再 additive 扩展。

## 3. 采集流程（sync-engine，slides 分支）

```
syncSingleDocument(objType=slides)
  fetchSlidesContent ──► FetchedDocument{ content, images, slideMedia, slideCount }   ← additive 字段
  ... staging workspace / downloadImages / appendSlidesMediaReferences（既有逻辑零改动）
  │
  ├─ config.sync.slidesScreenshot.enabled !== true ──────────────► return []（零调用）
  ├─ slideCount < 1 ────────────────────────────────────────────► return []
  ├─ slideCount > 60 ── warn slides_screenshot_unavailable(too_many_pages) ──► return []
  ├─ checkAuthReady({verify:false}) 不含 screenshot scope（引擎内缓存一次）
  │      └─ warn slides_screenshot_unavailable(scope_missing) ──► return []   ← 主上当前真实路径
  └─ for batch of ceil(pages/10)：
        client.screenshotSlides(objToken, batch, staging/.slides-screenshots-<batchIdx>/)
        映射页号→文件 → 校验（存在/非空/≤10MiB/PNG|JPEG 魔数）
        → copy 到 staging/images/<docname>-pNN.(png|jpg)
        任一失败 → 删除本文档全部已暂存截图 → warn(capture_failed) → return []   # all-or-none
  成功 → images.push(截图)          # 复用既有 images 通道：ir.images / extraFiles /
  │                                 # imagesCount / 原子提交 / 回滚全部自动覆盖（U36 不另造通道）
  └─ appendSlidesScreenshotReferences：每页一行截图引用
       位置：该页既有媒体行之前；无「## 媒体资源」区时按同格式创建
```

产物命名：`<docname>-p<NN>.<ext>`，docname = md 文件基名（watched-root 布局下为 `README`，与 sheet `<docname>.csv-data/` 既有约定同源；自定义归档文档为文档标题文件名）。旧截图随既有「md 引用的普通图片」替换/生命周期逻辑处理（无特例）。

## 4. 授权交互（server 面，§3.4 时序落点）

```
设置页开关开启（前端，未实施）
  → PUT /api/config { sync.slidesScreenshot.enabled:true }
  → GET /api/feishu/auth-status
      .optionalScopes = { granted:[], missing:['slides:presentation:screenshot'] }
      已含 → 「已开启」；缺失 → 弹「追加飞书授权」
  → POST /api/feishu/auth/device/start { includeOptionalScopes:true }   ← 新增透传项
      Manager：请求集 = 必需 ∪ (write?WRITE_SCOPES) ∪ enabledOptionalScopes(config) ∪ 已授(并集保留)
      scopeSet：body 显式传则用之；未传则按已授自动判定（⊇WRITE_SCOPES→write else read）
      整单 invalid scope → 降级最小必需集重试（可选集退场，基础授权仍可完成）
  → complete/cancel 走既有 device flow 端点（不变）
取消 → 配置仍 true；同步侧 scope_missing 跳过 + 警告（已实现且已测）
```

## 5. 授权后待实测清单（P1-S6 前置，主上授权 screenshot scope 后执行）

| # | 待实测 | 当前实现的假设与容错 | 不成立时处置 |
|---|---|---|---|
| SP-2 | `slides +screenshot --format json` 的页号↔文件映射真实形态 | 宽容解析：深度 ≤4 递归扫描「页号键（slide_number/slideNumber/slide/page/page_number）+ 路径键（saved_path/path/file/file_path/output）」共现对象；无映射时退化扫描输出目录按文件名数值排序配对（数量不匹配拒绝）；相对路径先按子进程 cwd 解析、不存在再按输出目录解析 | 按实测形态收敛解析器（或改逐页 `--slide-number n` 单页调用，上限 60 页仍可接受——设计 §8 预案）；同步侧无需改 |
| SP-3 | 同一页重复截图字节稳定性 | 未验证；截图按 md 引用走既有 contentHash/mediaHash 链，字节不稳会导致每次重同步重识图 | 按设计 §6：重同步受 obj_edit_time 变化约束；必要时设置页成本提示措辞调整 |
| SP-4 | 输出格式与单页体积（假设 PNG 数百 KB） | 魔数白名单 PNG/JPEG；>10MiB 判失败（all-or-none） | 单页普遍 >10MiB → 放宽上限或按设计记失败并提示 |
| 真机端到端 | 授权后真实 slides 文档全链路（采集→原子提交→md 引用→预览/识图） | 同步侧逻辑已 mock 全覆盖；真实 CLI 行为（输出目录命名、saved_path 基准、页码边界/越界整批拒绝语义——S1 §5 已证 scope 校验先于一切故不可达）待真实跑 | 按实测修正 argv/解析/校验常量 |
| 设置页 UI | 开关 + 增量授权弹窗 + 「重新同步全部幻灯片」按钮 + 成本提示 | server 契约已就绪（auth-status optionalScopes / device start includeOptionalScopes / config sync 段） | 前端切片实施时需真机浏览器/Electron 交互验证（CLAUDE.md 红线） |

**重同步按钮语义核对结论（§3.2「先核对再决定」）**：`POST /api/sync` 接受显式 `documents` 清单，`SyncEngine.syncSingleDocument` 对清单内文档无条件重新 fetch 正文——**无 obj_edit_time 短路**，因此不需要 `SyncOptions.refetchUnchanged`。按钮 = 前端从 SQLite 取全部 `obj_type='slides'` 文档构造清单提交既有 `POST /api/sync`（`apply:true + confirmation:'APPLY'`，`local_edit_pending` blocker 语义照旧）。

## 6. 并行撞写记录

- `lark-cli-client.ts`：P0-S2 并行追加五方法（exportWhiteboard/listDocumentHistory/revertDocumentHistory/revertDocumentHistoryStatus/updateDocumentTitle，+424 行测试）。本任务先落 `screenshotSlides`/`missing_scope`/`slides` 桶，P0-S2 后到重读后追加成功，两者无重叠区；合并态已复跑 typecheck/eslint/141 用例（client+manager+P1-S5）与 server 全量 1340 用例，全绿。
- 本任务未触碰 P0-S2/P1-S2 的任何文件（custom-folders、reference-graph 等为兄弟任务产物，仅观察）。

## 7. 未覆盖项 / 风险 / 回滚

- **未覆盖**：前端设置页 UI（开关/弹窗/重同步按钮/成本提示）——server 契约已就绪，属后续切片且需真机验证；`slidesScreenshotMaxPages` 配置化未做（常量 60 代替）；授权后真实采集路径未实测（见 §5）。
- **已知边界**：截图警告目前走 `console.warn`（与引擎既有 LLM 降级警告同通道），未进 SyncResult 结构（SyncResult 无 warnings 面，属跨切片契约变更）。
- **回滚**：`sync.slidesScreenshot=false` 即回到现状（下次同步正文自动不含截图行）；彻底回滚 = revert 本切片对 6 个源文件的 additive 改动 + 删除 `tests/p1-s5-slides-screenshot.test.ts`，无 DB 迁移、无新表、无头部字段变化（`feishu_sync` 头 round-trip 零触及）。
