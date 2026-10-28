# P0-S6 报告：白板 SVG 导出——同步侧旁路（svg 主 + raw 降级）

- **日期**：2026-10-28 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P0.md` §5（§5.1 旁路理由 / §5.2 命名寻址 / §5.3 同步侧流程）+ §10 裁定 1、`P0-S2-report.md`（`exportWhiteboard` 契约）、`P0-S1-probe.md`（HP-4 双源裁定）
- **产物**：`server/src/modules/sync-engine.ts`（白板分支内追加 + extraFiles）+ `server/src/modules/config-manager.ts` + `server/src/types/index.ts`（additive）+ `server/tests/whiteboard-bypass.test.ts`（新增 8 用例）

## 一、旁路文件形态（S7/S8 消费契约）

| 项 | 值 |
|---|---|
| svg 产物 | `images/<stem>.wb.svg`，与 PNG 预览同主干（stem = `{序号}-{token}`） |
| raw 降级产物 | `images/<stem>.wb.raw.json`（svg 失败/超时/校验不过时） |
| 导出顺序 | `exportWhiteboard(svg, svgTimeoutMs)` → 任意失败 → `exportWhiteboard(raw)`（raw 用执行层默认预算） |
| svg 校验链 | 非空 ∧ ≤ 8 MiB ∧ 开头 2 KiB 内含 `<svg`（S2 客户端另有落盘+围栏校验） |
| raw 校验链 | 非空 ∧ ≤ 8 MiB |
| 校验不过/失败 | 删 staging 残留后降级；双失败仅告警 `whiteboard_svg_unavailable(token, svg=…, raw=…)`（console.warn，与 slides_screenshot_unavailable 同通道——SyncResult 无 warnings 字段，遵循仓库现状不扩公共契约） |
| 正文影响 | **零**：旁路不进 `localMediaReferences`、不进 `ir.images`/`requiredRelativePaths`、不进 `feishu_sync` 头；仅经 `extraFiles` 随 atomic-commit 入库（测试断言关闭/双失败两场景 md 逐字节一致） |
| 阻断语义 | §5.1 不变量：缺 PNG 阻断（既有），缺旁路降级（新增，永不阻断、永不抛错） |
| md 引用 | PNG 照旧 `![飞书白板](images/<stem>.png)`；S7 构建侧按 §5.2 命名约定探测 `.wb.svg`/`.wb.raw.json`（无映射表） |

`Image` 接口（sync-engine 内部媒体结构）新增 `whiteboardBypass?: { type: 'svg' | 'raw'; path: string }`——任务 4 的「白板引用旁路文件字段」落点；`MediaReference`（fetch 正文纯解析器）无旁路概念，不改。

## 二、伴生资源枚举点清单（任务 3，全量核实）

设计 §5.2：「凡枚举『某文档的 images 伴生文件』之处，统一把 `.wb.svg` 视为同主干 PNG 的附属；漏掉的后果是残留无主文件（无害），不会破坏正文」。

**核实结论：当前代码库不存在任何枚举文档级 images/ 伴生文件的处理点——PNG 本身也不在这些链路中被删除/迁移**。因此「旁路文件加入同批处理」的前提（既有图片删除/迁移处）不成立；`.wb.svg`/`.wb.raw.json` 与 PNG 天然同生命周期，无需（也不应）新增删除逻辑。全量 fs 写点清单（grep `rmSync|unlinkSync|renameSync` 全库）：

| # | 位置 | 行为 | images/ 伴生（PNG 与旁路）处理 |
|---|---|---|---|
| 1 | `routes/trash.ts` restore / bulk-process trash / purgeOne | 只移动/unlink **md 本身**（原路径 ↔ `.trash-bin/` 镜像） | 不枚举 → PNG/旁路均保留（同生命周期） |
| 2 | `kb/source-cleanup.ts` `prepareSourceCleanup`/`cleanupSources`（源清理公共咽喉：source-batch / manual-delete / kb routes 全经此） | 枚举面 = md + `managedWorkbookCompanions`（sheet xlsx/meta）+ sheet CSV | 不含 images → PNG/旁路均保留（测试固化） |
| 3 | `modules/orphan-files.ts` 孤立清理 | 只认带 `feishu_sync` 头的 .md / 含其目录，目录**整体**移入 `.trash-bin/orphan-*` | 目录内 images/（含旁路）随目录同批移动 ✓；`.wb.svg` 非 .md 不会被单独列为孤立 |
| 4 | `modules/sync-engine.ts` 旧资源替换 | atomic-commit 只 rename 计划内文件，不删计划外旧文件 | 同主干重导出覆盖旧 `.wb.svg`/`.wb.raw.json` ✓；白板删除/序号变化时旧 PNG 与旧旁路同样残留（现状语义） |
| 5 | `modules/operation-manifest.ts` planned_move | blocker（`planned_move` reasonCode），**不自动迁移**，人工复核 | 无自动迁移面 |
| 6 | 其余（recovery-manager / source-edit-service / lark-cli-client / kb-build-service / path-guard / sheet-read-reconstruction / atomic-commit 内部） | 备份、staging、临时目录、标准库 release | 均不在原始库 images/ 文档伴生面 |

**为何不主动新增删除**：① 现状连 PNG 都不删，给旁路单独加删除会引入与 PNG 不一致的行为（越出发设计的行为变化）；② images/ 目录可能被多文档共享（`path-resolver.ts:326` mirror-leaf 布局 `…/images` shared at parent），无归属信息的删除有误删风险；③ 设计明示残留无害。若未来引入文档级 images 归属（如 replace 时清理无引用旧图），旁路文件按「同主干附属」并入即可。

## 三、配置契约（additive，S7/S8/运维消费）

```ts
// types/index.ts SyncConfig（additive；旧配置内存补默认，无迁移回写）
whiteboardExport: { enabled: boolean; svgTimeoutMs?: number }
```

- **缺省 `enabled: true`**（设计 §5.3 缺省开启；P0-S1 HP-5 证实文字为真实 `<text>/<tspan>` 节点，不触发「路径化 → 默认 false」的预案）。仅显式 `false` 关闭；sync-engine 侧同时容错旧 config/测试替身（无 sync 段 → 默认开启；旧 larkCliClient 替身无 `exportWhiteboard` 方法 → 跳过不告警）。
- **`svgTimeoutMs`**：svg 导出超时预算，直通 S2 `exportWhiteboard({timeoutMs})`；缺省回落执行层预算（30s）。P0-S1 实测 svg 服务端超时 ~6.5s 即返回（内容相关），预算只影响客户端等待上限。
- config-manager 四处对齐 `slidesScreenshot` 先例：`DEFAULT_CONFIG`（默认 true）/ `updateConfig` merge / `normalizeSyncConfigLoose`（宽容：enabled 非布尔→true，svgTimeoutMs 非正有限数→剔除）/ `validateSyncConfig`（严格：类型错位抛 `InvalidConfigError`）。
- 测试替身 config 未传 `sync` 段时旁路仍默认开启（与设计缺省一致）。

## 四、验证证据（cwd=server，2026-10-28）

| 项 | 命令 | 结果 |
|---|---|---|
| 新测试（8 用例：svg 入库+timeout 透传 / 超时→raw / 校验不过→raw / 双失败仅告警 / 关闭零调用+md 逐字节一致 / 源清理同生命周期 / 配置归一 / 严格校验） | `npx vitest run tests/whiteboard-bypass.test.ts` | exit 0，8/8 passed |
| 既有白板同步零回归 + custom-folders | `npx vitest run tests/sync-engine.test.ts tests/custom-folders.test.ts` | exit 0，84/84 passed |
| 配置面回归 | `npx vitest run tests/config-manager.test.ts tests/config-routes.test.ts tests/sync-latest-config.test.ts tests/lark-cli-client.test.ts` | exit 0，106/106 passed |
| 类型 | `npm run typecheck`（server）+ 根 `npm run typecheck` | 均 exit 0 |

未跑项：全量 `npm run check` / 真实飞书端到端（共享树并行任务中间态，harness 结算以隔离快照为准；真实 `whiteboard +export` 行为已由 P0-S1 实测固化、S2 单测锁定，本切片 mock 驱动）。

## 五、未覆盖 / 风险

- **`custom-doc-sync.ts`（归档文档同步）未接入旁路导出**：任务书写面限定 `sync-engine.ts`。设计 U27 提及「custom-doc-sync 同构处」，其白板下载点在 `custom-doc-sync.ts:738` 附近（`imagesDir` + media-download 循环），接入方式与本切片同构（PNG 就绪后调 `exportWhiteboardBypassFile` 同款逻辑 + staging 提交）——建议另开小切片或并入 S8 存量补齐。
- **`svgHash`/快照判定/raw 文字抽取**：按任务书属 S7，本切片未做。
- **8 MiB 超限分支**测试以「无 `<svg` 头」覆盖同一「校验不过→删残留→降级」路径，未单独造 9 MiB 文件（同代码路径）。
- **真实端到端**（真实白板文档 svg→raw 降级链）未跑：需真实 lark-cli 认证态，建议 S7 联调时用 P0-S1 测试画板顺带回归一次。
- 警告通道现状为 console.warn（SyncResult 无 warnings 字段）；若 UI 需要聚合展示 `whiteboard_svg_unavailable`，需另立公共契约变更（超出本切片）。

## 六、撞写记录

- 落笔时共享树存在大量并行未提交改动（P0-S3/P1-S5/P1S7-P2S1 等报告与源码）；本任务 5 处写面（types/index.ts SyncConfig、config-manager.ts 4 块、sync-engine.ts 4 块、新测试文件、本报告）均为纯增量块，与并行任务零重叠。
- 未观察到 P2-S2 对 config-manager/types 的并发写入冲突（本任务落笔前后各重读一次锚区）。

## 回滚方式

- `types/index.ts`：删 SyncConfig.whiteboardExport 段。
- `config-manager.ts`：恢复 DEFAULT_CONFIG.sync / merge sync 段 / normalizeSyncConfigLoose / validateSyncConfig 四处（反向 diff 见 `git diff server/src/modules/config-manager.ts` 中 whiteboardExport 相关 hunk）。
- `sync-engine.ts`：删 Image.whiteboardBypass 字段、downloadImages 白板分支 3 行调用、WHITEBOARD_BYPASS 常量与 `resolveWhiteboardExportOptions`/`exportWhiteboardBypassFile` 方法块、extraFiles 旁路 7 行。
- `server/tests/whiteboard-bypass.test.ts`、本报告：整文件删除。
- 关闭开关等价回滚：`sync.whiteboardExport.enabled=false` 后行为与改动前完全一致（已存 `.wb.svg` 无害，S7 前无消费者）。
