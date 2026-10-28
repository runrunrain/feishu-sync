# P2-S2 切片报告：装箱与单元——packBatches + planUnits 改造（字数预算制）

> 任务：P2 §2.2–2.8（有效字数 / 装箱 / 单元 / 配置 / 算例 / 与并行度关系）。
> 设计依据：`lark-cli-newcaps-P2.md` §2（U42–U44）；消费 P1-S7+P2-S1 的 `kb/text-stats.ts` `countText`。

## 一、产物

| 文件 | 改动 |
|---|---|
| `server/src/kb/build-units.ts` | 新增纯函数 `packBatches`；`planUnits` 内部改造（`BuildUnit.words`、`workset` meta 增 `words?`、输入增 `wordBudget?`、full 单元装箱切分、排序键 words→bytes→原序）。外部导出 `planUnits`/`BuildUnit`/`PlanUnitsInput` 签名兼容（新字段可选/追加） |
| `server/src/kb/kb-build-service.ts` | S4 段 worksetMeta 计算有效字数（§2.2）；单 worker 路径 `chunkTokens` → `packBatches`（删除私有 chunkTokens）；并行/单 worker 两路径 `wordBudget`+`wordsOf` 贯通；每批字数日志（§2.3）；新增导出纯函数 `effectiveWords` |
| `server/src/types/agent-knowledge.ts` | `StandardKbConfig.buildBatchWordBudget: number`（additive）；`buildDefaultStandardKbConfig` 缺省 40000 |
| `server/src/modules/config-manager.ts` | `normalizeStandardKbConfigLoose` 增钳制（私有 `normalizeBuildBatchWordBudget`）；与兄弟任务（P1-S5 sync 段）改动无重叠 |
| `server/tests/kb-pack-batches.test.ts` | 新增 22 用例（装箱算例/不变量/口径/钳制） |
| `server/tests/kb-build-parallel.test.ts` | 新增 3 个端到端接线用例（单 worker 分批+日志 / budget=0 旧行为 / 并行单元切分+日志）；夹具 doc 路径改按 token 命名（见 §五.3） |

## 二、配置契约（P2-S3 设置页消费）

- **字段**：`standardKb.buildBatchWordBudget`，类型 number，**缺省 40000**（`buildDefaultStandardKbConfig`）。
- **取值域**：`{0} ∪ [4000, 400000]`。语义：`0 = 按源数分批（旧行为，兼容回退开关）`；`>0 = 每批有效字数上限`。
- **钳制（ConfigManager 宽容归一，load 与 PUT 合并路径同一入口）**：非数字/非有限数（含 string/null）→ 缺省 40000；`≤0` → 0；`(0,4000)` → 4000；`>400000` → 400000；区间内 `Math.floor` 取整。
- **严格校验（PUT /api/config）**：**未新增拒绝规则**——设计 §2.5 只定义钳制语义；PUT 传越界值会被静默钳到边界。设置页若需即时反馈，请在前端自行做取值域提示（建议文案「0 = 按源数分批」+ 范围 4000–400000）。
- **CLI**：`config.set standardKb.buildBatchWordBudget` 不在禁止路径，天然可用（无命令表改动）。
- **服务端读取**：`Math.max(0, Math.floor(config.standardKb.buildBatchWordBudget ?? 0))`。`?? 0` 只影响未经 ConfigManager 归一的对象（测试夹具），真实运行时配置恒有值（缺省 40000 = 预算默认开启）。
- **与并行度的关系（§2.7）**：`buildBatchSize` 降为「每批源数上限」（1..50 不变）；full 模式单元上限 = 预算×3 / 个数×3；`buildParallelism` 语义不变。预算变小 → 更多更小单元 → 更充分用满并行度，无需联动。

## 三、装箱日志形态（P2-S3 / BW-1 调优消费）

- 单 worker 路径（`build_log`，budget>0 时在既有「批次 k/n：N 个源」行后追加）：
  `batch 1/2: sources=1, words=345`
- 并行路径（W≥2，每批一行，含单元归属）：
  `unit u3 batch 2/4: sources=5, words=12345`
- **budget=0 时不出现任何新日志行**（旧行为字节级等价，含日志）。
- `words` 为该批源有效字数合计；events.jsonl 与 SSE `build_log` 同步可见。

## 四、实现要点与契约裁定

1. **packBatches（§2.3）**：`wordBudget<=0 → chunk(orderedTokens, maxCount)`；否则顺序贪心——加源前检查「当前批非空 ∧（累计+w > 预算 ∨ 批长=maxCount）」→ 封批；单源超预算自然独占一批（不拆源）。保持输入顺序、只改边界。**恰好等于预算可入批**（`>` 才封）。
2. **planUnits（U44）**：full 模式目录簇内 `packBatches(sorted, words, {预算×3, batchSize×3})` 切单元，`makeUnit` 内 `packBatches(…, {预算, batchSize})` 切批；incremental 连通分量不变、仅 `makeUnit` 换 packBatches；空单元保底空批不变。排序键：`words` 降序 → `bytes` 降序 → 原序。
3. **有效字数（§2.2）**：`effectiveWords = countText(源正文).words + Σ countText(已描述图片 text).words`（`state !== 'unavailable'` 且非空才计）；白板 SVG 项恒 0（P0 白板 SVG 抽取未上线，代码面无此通道——预留项，见 §六）。计算点在 S4 worksetMeta 生成处（识图之后），图片描述取 `buildState.imageDescriptions` 本次构建内存结果；源文件不可读按 0（与 bytes 同口径）。**budget=0 时不读文件内容**（省全量 IO 且旧行为等价）。
4. **不变量 2（可检验形式）**：任意预算下 `∪ unit.sources = 工作集` 且互不相交、`∪ batches = unit.sources`、incremental 分量分组与 `affectedDocs`/`ownedDocs` 不随预算变化——已由随机性质测试锚定。
5. **`buildBatchWordBudget` 不进 manifest / 不参与任何哈希**（调度估计，U43）。

## 五、测试矩阵

### 新增 `kb-pack-batches.test.ts`（22）

| 分组 | 用例 |
|---|---|
| packBatches 算例 (8) | **§2.6 八源算例逐批锚定**（4 批：[3k,2k,35k]/[8k]/[70k]/[1k,1k,30k]）；budget=0 与旧 chunk 逐批相等（maxCount 1/3/10/50）；恰好等于预算可同批；超预算单源独占（首/中/末/唯一）；maxCount 先到封批；maxCount 与预算同时到顶；空输入；顺序保持（展平=输入） |
| planUnits 不变量 (4) | full 随机工作集×4 种子×4 预算（覆盖/互斥/单元字数≤3×预算/个数≤3×batchSize）；incremental 同上且**分量分组、affectedDocs 与预算无关**、批字数≤预算 |
| planUnits 行为 (5) | full 单元切分=预算×3（§2.6 工作集→2 单元+批内再切）；budget=0/缺省=旧 chunk(×3)；个数上限×3 保留；排序键 words→bytes→原序；无 words meta+预算开启=旧 chunk 且 words=0 |
| 路径等价 (1) | **单一单元时 planUnits 的批切分 === 单 worker 全局批切分（同一 packBatches）** |
| effectiveWords (2) | 正文+已描述图片（unavailable/空文本不计、正文 null 仅图片、头部注释剥离）；口径经 countText 透传 |
| 配置钳制 (3) | 缺失/字符串/null→40000；0/-5→0；2000/3999.7→4000；4000 恰等；40500.9→40500；400000 恰等；999999→400000；新库缺省 40000（经 ConfigManager.load） |

### 新增 `kb-build-parallel.test.ts`（3，端到端接线）

- 单 worker：预算=单源字数 → 每源独批（2 个批次 prompt）+ `batch k/n: sources=1, words=345` 日志逐批出现。
- 单 worker：budget=0（缺省）→ 1 批 + 无 `batch ` 字数日志行（旧行为保持）。
- 并行 W=2：预算×3 < 同目录两源合计 → 切 2 单元（`unit_total=2`、`parallelism=2`）+ `unit uN batch 1/1: sources=1, words=345` 日志。

### 既有测试零回归

`kb-build-units.test.ts`（9）、`text-stats.test.ts`（15）、`kb-build.test.ts`、`kb-build-parallel.test.ts` 既有 13 用例、`kb-version.test.ts`、`agent-config.test.ts`、`app-command-family.test.ts`、`agent-session*.test.ts`、`agent-tasks.test.ts`、`source-push.test.ts` 全部不改断言通过（budget 缺省 0 → 字节级旧行为）。

## 六、未覆盖项 / 边界裁定

1. **白板 SVG 字数项**：§2.2 公式第三项（`<whiteboard_text>`）在当前代码面无对应通道（P0 白板 SVG 未上线），`effectiveWords` 未预留参数；上线时在该函数加一项即可（签名向后兼容：新增可选字段）。
2. **`config.set` 严格拒绝**：按设计只钳制不拒绝；P2-S3 设置页如需「非法值报错」需前端自做（§二）。
3. **夹具改动**：`kb-build-parallel.test.ts` 的 FakeRpc doc 路径由 `主题/{unit}-文档N.md` 改为 `主题/{unit}-{token}.md`——预算拆批后 docIndex 每批重置会同路径覆盖（第二个 batch 覆盖第一个 batch 的文档 → `source_not_covered` 校验失败）；按 token 命名是修正夹具缺陷，非业务断言变化（既有用例全部不改断言通过）。
4. **真实库全量构建验证**（预算下批次字数均≤预算、构建成功）属 P2-S3 验收（BW-1），本切片以算法与双路径接线测试覆盖。
5. 前端 `src/types/agent.ts` 的 StandardKbConfig 镜像未加字段（运行时多出的字段无害），P2-S3 设置页一并补。

## 七、验证证据

| 验证 | 命令（cwd=server） | 结果 |
|---|---|---|
| 新算法测试 | `npx vitest run tests/kb-pack-batches.test.ts tests/kb-build-units.test.ts tests/text-stats.test.ts` | 3 files / 44 tests passed |
| 端到端接线 | `npx vitest run tests/kb-build-parallel.test.ts` | 16/16 passed（含 3 新用例） |
| 相邻回归 | `npx vitest run tests/kb-build.test.ts tests/kb-version.test.ts tests/agent-config.test.ts tests/app-command-family.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/agent-tasks.test.ts tests/source-push.test.ts` | 8 files / 259 tests passed |
| 类型 | `npm run typecheck`（server）+ 根目录 `npm run typecheck`（三段） | 退出码 0 |
| Lint | `npx eslint <6 个改动文件>`（repo root） | 退出码 0 |
| 前端 | 根目录 `npm test`（结算基线同口径） | 27 files / 237 tests passed |

未跑项：server 全量 `npm test`（共享树有并行兄弟任务在改 sync-engine/lark-cli 等文件，全量会撞兄弟中间态；与本切片相关的定向面已全绿）。

## 八、并行任务碰撞记录（任务书约束项）

- 编辑前重读 `types/index.ts` 与 `config-manager.ts`：已存在兄弟任务未提交改动（P1-S5 `sync` 段：slidesScreenshot；P0-S3 source_push_log DTO）——与本切片写面（normalizeStandardKbConfigLoose / StandardKbConfig）无重叠，未改动他们的段落。
- 本切片进行中，兄弟任务（P1-S8）又写入 `kb-build-service.ts`（`publication-service.ts`、`publishedTokensProvider` 快照排除面、`published_doc_in_sources` 警告）——与 P2-S2 写面（S4 worksetMeta/两阶段接线）空间不重叠。合并态已复验：server `tsc --noEmit` 退出码 0，`kb-build-parallel` + `kb-pack-batches` 38/38 绿（03:12）。

## 九、回滚方式

`git checkout` 本切片 5 个文件改动 + 删除 `server/tests/kb-pack-batches.test.ts`；配置文件中已写入的 `buildBatchWordBudget` 字段残留无害（旧代码忽略未知字段）。运行期回退：置 `buildBatchWordBudget: 0` 即回到旧行为，无需改代码。
