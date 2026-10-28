# P0-S2 报告：LarkCliClient 五方法封装 + 错误码 + 双读解析（fixture 驱动）

- **日期**：2026-10-28 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P0.md` §3/§10、`agent-outputs/workflow/2026-10-27-kb-agent-upgrade/P0-S1-probe.md`、fixture `server/tests/fixtures/p0s1-lark-cli/`（README 索引）
- **产物**：`server/src/modules/lark-cli-client.ts`（只追加）+ `server/tests/lark-cli-client.test.ts`（新增 5 个 describe / 20 用例）

## 一、五方法签名与返回类型清单（P0-S3/S6/S9 消费契约）

apiType 桶：history / whiteboard → `'docx'`；update-title → `'drive'`。全部输出「结构化 JSON 优先 + 文本兜底」双读（fetchDocumentRevision 同模式）。

### 1. `listDocumentHistory(objToken, opts?) → Promise<DocumentHistoryPage>`

```ts
opts?: { pageToken?: string; pageSize?: number }   // pageSize 钳制 1..20，缺省 20

interface DocumentHistoryPage {
  entries: DocHistoryEntry[];       // 按新→旧排序；容忍空列表
  hasMore: boolean;                 // data.has_more === true || data.hasMore === true
  nextPageToken: string | null;     // hasMore 且 page_token 非空时才有值
}
interface DocHistoryEntry {
  historyVersionId: string | null;  // 字符串（1024×n 步进），回滚目标/写前锚点都用它
  revisionId: number | null;        // 数值；与 `docs +fetch --revision-id` 同一 id 空间
  editTime: string | null;          // RFC3339Z 秒级；双读 edit_time→created_at→create_time
  editorIds: string[];              // open_id 数组（上游无姓名字段）
  type: number | null;              // 1=建档 / 2=普通编辑 / 3=revert 产生（UI 标注「回滚快照」；目标默认排除 type=1）
  raw: unknown;                     // 原条目，仅诊断
}
```

argv（P0-S1 实测 + 本地 1.0.98 help 双核对）：`docs +history-list --doc <t> --page-size <1..20> [--page-token <p>] --format json`

### 2. `revertDocumentHistory(objToken, historyVersionId, opts?) → Promise<DocumentHistoryRevertResult>`

```ts
opts?: { waitTimeoutMs?: number }   // 钳制 0..30000，缺省 30000；0 = 异步形态（合法且实测）

interface DocumentHistoryRevertResult {
  status: 'done' | 'running';       // 未知取值归一 running（调用方轮询到上限）
  taskId: string | null;            // done 形态仍返回 task_id（P0-S1 实测）
  pollAfterMs: number | null;       // running 实测 10000，done 为 0
  failedBlockTokens: string[] | null;
}
```

argv：`docs +history-revert --doc <t> --history-version-id <id> --wait-timeout-ms <0..30000> --format json`。
子进程预算 = `waitTimeoutMs + 15000`（> 服务端等待上限，防同步等待误判客户端 timeout）。**非幂等，调用方绝不重试**（S3/S4 语义）。空 token/空 id 在边界直接抛 `Error`，不起子进程。

### 3. `revertDocumentHistoryStatus(objToken, taskId) → Promise<DocumentHistoryRevertStatus>`

```ts
interface DocumentHistoryRevertStatus {
  status: 'done' | 'running' | 'failed';  // 'error' 也归 failed；其余未知值归 running
  failedBlockTokens: string[] | null;     // 非空 = 部分块回滚失败，服务层必须上抛警告
}
```

argv：`docs +history-revert-status --doc <t> --task-id <id> --format json`

### 4. `exportWhiteboard(whiteboardToken, opts) → Promise<string>`（返回落盘绝对路径）

```ts
opts: { outputType: 'svg' | 'raw'; outputPath: string; timeoutMs?: number }
```

- argv：`whiteboard +export --whiteboard-token <t> --output-type svg|raw --output <basename> --overwrite --format json`，`cwd = dirname(outputPath)`。
- **响应键按类型区分**（P0-S1 实测）：svg → `data.svg_path`；raw → `data.output_path`（相对 cwd，方法内 resolve；缺键回落 requestedPath）。
- **超时预算由调用方传入**（`timeoutMs` 直通 execute；未传用 execute 缺省）——svg 服务端渲染超时（~6.5s，内容相关）是 S6「svg 失败降级 raw」的判定输入。
- 校验链：落盘存在且非空（exportWorkbook 先例）→ 输出围栏 `isPathInsideDirectory`（fetchMediaToPath 同款）。顺序为「先完整性后围栏」：两分支都抛错、上报路径任何形态不外泄；此序避免 macOS /var→/private 符号链接在文件未落盘时抢先触发围栏产生误导文案（实测发现，见测试场景 2）。
- preview 通道**不暴露**：preview 响应键是 `preview_image_path` 且扩展名必须 `.jpg`（本地校验拒 .png）；同步链 PNG 走既有 `media-download --type whiteboard`，不经 `+export`。

### 5. `updateDocumentTitle(fileToken, title, opts?) → Promise<UpdateDocumentTitleResult>`

```ts
opts?: { type?: 'wiki' | 'docx' | 'sheet' | 'slides' | 'bitable' }  // 缺省 'docx'；wiki 传 node token（底层 obj token 不被接受）

interface UpdateDocumentTitleResult {
  fileToken: string | null; title: string | null; type: string | null;
  updated: boolean; url: string | null; raw: unknown;
}
```

argv：`drive +update-title --token <t> --type <type> --title <title> --format json`。**绝不传 `--type file`、不传 `--on-extension-mismatch`**（测试断言）。空 token/空标题边界抛 `Error`（CLI 也本地拦截空标题；S9 服务层另有 `title_invalid` 门）。

## 二、错误分类（classifyError 并入，既有分类零改动）

| 码 | LarkCliErrorCode | retryable | 语义 | fixture |
|---|---|---|---|---|
| 10020 | `'conflict'` | **true** | revert 并发单飞（先轮询既有任务再重试；S4 `cloud_revert_running` 门的本地镜像） | history-revert-error-10020.json |
| 3380002 | `'invalid_target'` | false | 回滚目标无效：id 不存在 **或目标为最新历史条目**（两形态同码）；与 3380003（`'deleted'`，文档已删）明确区分，配对断言测试 | history-revert-error-3380002-{notfound,newest-entry}.json |
| 981003 | `'type_mismatch'` | false | update-title 类型错配（报 "not found."，与未知 token 同码）；不得自动换 type 重试（U31） | update-title-error-981003.json |

配套改动（均为错误分类工作的组成部分）：
- `LarkCliErrorCode` union 尾部追加 3 值（additive；全库无 exhaustive switch，grep 核实零影响）。
- `extractUpstreamCode` 文本兜底已知码集追加 `10020|3380002|981003`（stderr 非 JSON 形态）。
- timeout 分支正则补 `time out`（带空格变体）：P0-S1 svg 服务端超时 fixture 消息 "server time out error" 此前落 `'upstream'`；归 `'timeout'`（同为 retryable，重试语义不变；feishu-write-service 的 timeout→`push_outcome_unknown` 保守映射对此形态更正确）。S6 可用 `error.code === 'timeout'` 判降级。

## 三、测试（20 新用例，全 fixture 驱动，mock execute）

- **argv 断言**：五方法对照 fixture README 真实命令形态（并逐一与本地 `lark-cli 1.0.98 --help` 实核）；含钳制（pageSize 1..20 / wait-timeout-ms 0..30000）、可选参数（--page-token / --type wiki）、拒绝项（--on-extension-mismatch / --type file 不出现）。
- **解析**：multi-entry（4 条 type 1/2/3、字符串 id）、fresh-doc、空页、has_more/page_token 派生（含驼峰双读）、revert done/running fixture、未知状态归 running、`failed_block_tokens` 读取与过滤、svg/raw 双键解析、输出围栏 + 完整性三场景、title 成功归一化。
- **错误分类**：三新码 fixture 体经 parseJsonOutput 真实路径 + stderr 文本兜底双验；3380002 vs 3380003 配对区分；svg timeout 归 timeout。
- **零回归**：既有 30 用例（含既有方法 argv 快照）未改动、全绿。

## 四、验证证据

| 项 | 命令（cwd=server） | 结果 |
|---|---|---|
| 单测 | `npx vitest run tests/lark-cli-client.test.ts` | exit 0，**50/50 passed**（30 既有 + 20 新增） |
| 类型 | `npm run typecheck`（tsc --noEmit） | exit 0 |

未跑项：全量 server 测试 / 根 npm test——任务书自验口径为上述两项；harness 结算以隔离快照跑基线。

## 五、撞写记录（约束要求的报告项）

- 落笔前共享树已有 audit D1/D2 未提交改动（not_in_wiki 分类、`--page-limit 0`）——已在其上追加，未触碰。
- **P1-S5（截图方法）在我首轮 edit 校验失败时并行落盘**（edit-guard 拒绝了我的过期 oldText）：union 已含 `'missing_scope'`、新增 `'slides'` 桶与 `screenshotSlides`。按「后者重读再追加」协议，我重读全部锚区后在其上应用；本任务 5 处 edit 与其零重叠。P1-S5 若再改本文件，其测试如落 `tests/lark-cli-client.test.ts` 同样适用先到为准。
- 修复轮 1 次：exportWhiteboard 校验顺序（围栏↔完整性）——测试暴露 macOS 符号链接归一化差异的误导文案，非行为放宽（两分支都拒绝且路径不外泄）。

## 六、未覆盖 / 风险

- §10-3 其余码（4000002 / 981004 / 99991672 / 99991679）**未并入**——任务书新码集仅三码；4000002 属 `+fetch --revision-id`（非本五方法面），981004 未被 S1 真实触发。S3/S9 消费时若需要可另提增量（981004 建议落 `permission` 不可重试）。
- `listDocumentHistory` 的 `data.items/histories/records` 兜底无真实 fixture（防漂移设计，同 §3 双读原则）。
- wiki 类型改名（`--type wiki`）未真机实测（P0-S1 HP-7 遗留，S9 验收含此项）；本封装 argv/help 已实核。

## 回滚方式

本任务改动集中在两文件的纯增量块 + classifyError 三分支/正则两处微扩：`git checkout` 前须经 Leader 授权；按共享树纪律以精确 diff 反向恢复（五方法块、DTO 块、union 3 行、classifyError 三分支、regex 两处、timeout 一处、测试文件尾部 describe 块与 fileURLToPath import）。
