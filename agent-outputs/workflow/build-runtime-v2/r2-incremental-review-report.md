# build-runtime-v2：R2 唯一增量复审（full 影响边界）

**结论：FIX。原 4 Major：3 closed、1 partial（R2-F10-02）。原 F01–F15 累计：14 closed、1 partial（F10）。**

原 full 报告已独立保全为 [`r2-full-review-report.md`](r2-full-review-report.md)，SHA256=`27fb7cb2f36f5b9fb3418c4040444ef5d187c8f2b2c2efb672f03464cfe85c77`，其结论为 FIX / 4 Major。本轮核对备份与覆盖前主报告逐字哈希相同；按主上续接裁决，本报告写回机器契约主路径，不修改原 full 备份及原取证。

**本轮候选**：`r2-incremental-candidate.patch`，SHA256=`f0e8da6aec7c132d9fdf8f1fac37cadb10a3481eebcb1204f1b28dcfca830aa6`。这是同一次因路径冲突暂停后的复审，不是新开一轮 Gate。

## 1. 基线、输入与范围

- HEAD=`25cc0b4`；修复 delta 基线为 dirty-snapshot `28605c53`。回源对象为 `/tmp/feishu-build-v2-r3/feature-final/`、`gate-fix-code.patch`；不把共享主树或用户 WIP 当候选实现。
- 独立核验候选文件 SHA 与 `GIT_INDEX_FILE=/tmp/feishu-build-v2-r3/feature.index git diff --cached --binary HEAD` SHA 相同；再逐路径比较 index Git blob 与 feature-final 文件，**57 路径、0 不一致**。校验脚本见 `r2-review-evidence/incremental-snapshot-check.mjs`。
- 必读上游：`fix3-integration-report.md`、`fix3-authority-report.md`、`fix3-residual-report.md`、`fix3-admission-report.md`、`fix3-invariants.md`，以及原 full 备份。实现自述均与源码、正式断言或真实日志对照，不据自述签发关闭。
- 审核范围：四个原 Major 的完整修复面、claimsByPid/ledger 去重补强、准入/发布/关闭消费链及受影响回归。原先已审且未受修复影响的 F01–F15 结论按原 full 有条件继承，不冒充重新全仓审计。
- 本轮只写本报告与新增 `incremental-*` 取证脚本/日志；未改源码、项目测试、候选/index/快照、原取证或上游 amagi/pi；未提交。临时 HOME/FEISHU_SYNC_HOME 位于 `/tmp/feishu-build-v2-r3/review/`。不读取生产资料/凭据、不请求远程模型。

## 2. 四个原 Major 逐条裁决

| 编号 | 状态 | 回源与验证结论 |
|---|---|---|
| R2-F03-01 | **closed** | `agent-tool-service.ts:2535–2560,2600–2655,2717–2750` 收集新族、移出旧族、同路径删除与跨 canonical 影响；`:2217–2254` 最终重核同一集合。旧声明基线漂移守卫在 `:1934–1951`，并非仅再查旧集合租约。write/edit 共用同步提交段；delete 独立收集被删对象旧族。独立运行 authority-impact 18 例及 toolfix 33 例：同路径移族、objects:[]、部分省略、clientKey 重绑、跨 path+改族、旧/新族 await 转让、delete/edit、基线漂移拒绝与合法迁移正例通过；声明/正文/回执保全有断言。objects 省略仍依原写入契约处理，edit 继承声明，未改成额外授权旁路。 |
| R2-F10-01 | **closed（合法事实关联与逐身份裁决范围）** | `process-residual.ts` 的 reconciledRuns/unboundRuns 分区不再让被过滤 run 充当 covered；登记集空时真实逐个体探测，非空 mismatch 生成 unconfirmed。claimsByPid 保留冲突声称，去重包含 birth/leader/pgid 等身份事实；ledger 同 launchId 也不吞出生冲突。58 例 residual + 4 例真实 OS scan-recovery 独立通过：旧前新后/逆序、跨文件/ledger-anchor/ledger-ledger、缺令牌/探测失败、不同 pgid、退出及完全重复正例均有断言。未知数字 PID 无生产 kill 出口；真实测试仅清理自有 ChildProcess。损坏事实的扫描完整性另归 R2-F10-02，不重复算此项未关。 |
| R2-F10-02 | **partial，仍 Major** | 原两个根目录 ENOTDIR、逐 anchor 非 ENOENT、损坏 JSON/untrusted 已能向 adapter/shutdown 传播 unknown；原反例关闭。但完整 scanner 契约仍未成立：非目录 home、非目录 task entry、未知 execution 枚举及非整数 anchor PID 仍能变成 no-facts/confirmed，见 §3。同属本轮明确要求的“每层扫描/schema fail-closed”未闭合，不计为修复引入的新回归。 |
| R2-LC-01 | **closed** | `kb-build-service.ts:920–942,966–1038` 首同步封印、inFlight 登记、共享 shutdownTask 内核；create/resume/releaseConfirm 在 await 后和提交点验证同一租约，finally 释放。CURRENT 后不回滚，收尾仍纳入等待。独立 admission 14 例 + shutdown 14 例 + publish-cancel 17 例通过：readiness 迟到、恢复扫描等待、发布锁排队/迟到回调、CURRENT 前后、超时/并发 shutdown 单次扫描、正常发布均覆盖。超时预算仅涵盖 admission+pipeline 等待，不宣称整个 cancel+磁盘探测总耗时受该 deadline 严格限制。 |

## 3. 唯一剩余阻断：R2-F10-02｜Major｜损坏事实仍可绕过 scanner 的 unknown 传播

### 定位、触发与实际行为

行号均相对本轮 `feature-final/`。

| 子例 | 定位 | 最小触发 | 实际结果 |
|---|---|---|---|
| A：home 是普通文件 | `server/src/agent/build-runtime/process-residual.ts:239–251`；`adapter.ts:133–134` | 已有 `epochs/e1/home`，但它是普通文件；无其它 ledger/binding | `statSync(...).isDirectory()===false` 被当不存在，homes=[] 且 degraded=false；adapter 返回 null/no-facts。直接扫描该 home 明明得到 anchors/intents degraded=true，真实 shutdown 却 quiesced=true。 |
| B：枚举后 task entry 异常 | `process-residual.ts:183–192,214–221` | 合法 UUID taskId `12345678-1234-4234-8234-123456789abc` 所在路径由目录变为普通文件（current.json 为 ENOTDIR）或不可达 symlink（ENOENT）；无其它锚点/账本 | readdir 先 filter(isDirectory) 抹掉该条目，storePresent=false、degraded=false；outcome confirmed，note 声称“无派发意图”，shutdown quiesced=true。与本轮已修的 process-audits/task 普通文件场景不对称。 |
| C：未知枚举被当 terminal | `process-residual.ts:202–212` | 合法 JSON `current.json` 为 `{execution:"corrupted-state",processState:"alive"}`，无锚点 | 只验证 string 类型，`!ACTIVE_EXECUTIONS.has(...)` 就跳过；unreadableTasks=[]，outcome confirmed、shutdown quiesced=true。没有任何已知终态或退出事实。对照 execution=123 则正确 unknown，说明仍是 schema 判别缺口。 |
| D：坏 PID 被伪证退出 | `process-residual.ts:143–157` 及后续进程表缺席判定 | anchor version=1，rootPid=999999.5、pgid=999999.5，leaderPid/at 为合法数值 | scanner 接受为 trusted run；真实 ps 当然没有小数 PID，进而生成 `verdict:exited`、confirmed、shutdown quiesced=true。非法身份被转成“已证明退出”，而不是 schema unknown。 |

- **契约依据**：`fix3-invariants.md` 的“证据分区”明定 `confirmed = 必要扫描完整 AND 已知运行事实全对账 AND 无unresolved`，要求核每层 home/epoch/anchor/v2-store/ledger，且 ENOTDIR/**schema** 等缺证向总体传播。`fix3-residual-report.md` 也承诺 malformed 与内层不可读 fail-closed，不只是根目录那两次 readdir。
- **实际影响**：相同的目录/状态损坏，能在更早一层被静默过滤，或被误分类为终态/退出，从而绕开本轮新增的 degraded/untrusted 传播。真实 shutdown 出具允许清理的 quiesced=true；恢复 guard 的相同 adapter 可以放行。证明的是**未获得退出证明仍声称收口**，不声称这四个损坏夹具里另有活进程，也不声称本轮实际执行了危险清理。
- **已复现证据**：`r2-review-evidence/incremental-scan-matrix.mts` / `.log`。七个独立临时 root，直接导入纯 feature 的 scan → adapter → KbBuildService.shutdown，未替换权限/探针/判定函数；A–D 全部 quiesced=true。对照坏类型 current、截断 JSON anchor 均 unconfirmed/quiesced=false；真正 empty-home confirmed/quiesced=true。B 额外记录真实 current.json 读取错误码 ENOTDIR。脚本不创建任务进程，不发任何信号。
- **Leader steer #1 专项核验**：新增 `incremental-task-entry.mts/.log`，三个独立夹具先建立同一合法 UUID taskId 的 running/alive current，再分别保留目录、替换同名普通文件、替换不可达 link。正常目录 → anchorless unknown / shutdown=false；两个损坏 task-id 位置 → 被 Dirent filter 丢弃、storePresent=false、confirmed / shutdown=true，均已实际执行。冻结 amagi2.21.31 `extensions/amagi-core/task-store.ts:4–8,168–178,501–502,514–550` 定义 `<root>/<sanitizeId(taskId)>/`，spec/current/receipt/lease/tmp 均在任务目录内；`artifact.ts:105–107` 的 sanitizeId 保留该 UUID。这里不是把任意 README/.DS_Store 等系统非任务文件当任务；修复应识别正式任务命名/目录契约，并保留契约允许的辅助文件，而不是见任意根级文件都报 unknown。不可达 link 的 ENOENT 也有相反事实（lstat 可见任务位置的 link），不是全新无任务目录的 ENOENT。上游 TaskStore 的列表过滤同样不是本应用 shutdown 的 OS 退出证明。
- **归因**：这些判别不足在累计候选中已存在，**不是本轮修复新引入**；本轮修的是相同 scanner 的完整缺证传播，且验收显式包含每层/schema，因此判原 R2-F10-02 **partial**，不另包装成四个新 Major，也不要求无关全仓审计。
- **最小修复方向**：固定目录位置“存在但非目录”标 degraded；v2-store 条目按正式存储契约区分已知合法辅助条目与无法解释的 task 事实，不先无声 filter；execution 只对已知合法终态作终态处理，未知枚举保留 unreadable；PID/PGID 等身份字段按正式 schema 校验安全整数/范围，非法 run 标 untrusted。继续让这些缺口经现有 outcome 传播，保留真正 ENOENT/空目录/合法终态/确证退出正例。由实施者将上述取证转为项目正式测试；本审核未写修复或项目测试。

**新增独立 finding 清单：Critical 0 / Major 0 / Minor 0。原 Major 未关闭：1（以上 R2-F10-02，含四个同根因边界）。未发现已证实的修复引入回归。**

## 4. 原 F01–F15 累计闭合表

closed 仅指原缺陷在既定边界关闭，不代表平台/模型/性能验收通过。

| 编号 | 累计 | 本轮依据 / 继承边界 |
|---|---|---|
| F01 | closed | toolfix 撤 ctx/actor/窗口租约回归通过；影响面修订未绕开最终写点。 |
| F02 | closed | 桥接未受本轮修复影响，继承原 full；上游串行/纯 feature 通过，但默认并行桥接时序夹具失败如实保留，见 §5。 |
| F03 | **closed** | 完整旧/新族与删除/迁移、基线漂移及共用提交点，见 R2-F03-01。 |
| F04 | closed | exact_text 字符区间保全在 toolfix 中重新通过。 |
| F05 | closed | 游标/逐页预算不受 delta 影响，继承原 full。 |
| F06 | closed | toolfix 并发幂等/异载荷重放通过，未改 operation/hash 契约。 |
| F07 | closed | review-authority 14 例含缺省 unitId、双 reviewer、真实 CURRENT 正例重新通过。 |
| F08 | closed | authority 与 publish-cancel 重新覆盖依赖漂移、null 规则、manual 冷实例和取消/发布真相。 |
| F09 | closed | fresh/session/rebuild 身份逻辑未改变；恢复准入增加封印，不重定义代次。上游 integration/adapter 回归另见原报告与集成日志。 |
| F10 | **partial** | 合法锚点关联/PID 多声称/生产零信号已关；扫描/schema 假收口仍在 §3。ENOTEMPTY 总承诺仍不能签关闭。 |
| F11 | closed | 独立 publish-cancel 17 例通过：v1/v2 草稿、提交前取消、CURRENT 后 DB 异常与重试恢复。 |
| F12 | closed（所审工具边界） | policy/runtime-integrity 未改，继承原 full SDK 取证；上游冻结原生资源日志只作补充，不宣称 OS sandbox。 |
| F13 | closed（代码层） | Windows 宿主路径语义不受本轮修改影响；仍无 Windows 真机/UNC/打包认证。 |
| F14 | closed | Leader/child 示例契约未改，继承原 full。 |
| F15 | closed（DTO/组件语义） | unknown 语义和 shutdown 新 unsettleAdmissions 消费链已核；当前错误在 F10 事实生产端，不要求 UI 自造真相。未做视觉复验。 |

## 5. 验证证据与可信度

### 独立执行（不是实现者自述）

1. 备份/候选/index SHA 校验 exit0；`node r2-review-evidence/incremental-snapshot-check.mjs` → **57 paths / mismatches=[]**。未改 index。
2. cwd=`/tmp/feishu-build-v2-r3/feature-final/server`，显式临时 HOME/FEISHU_SYNC_HOME：
   ```text
   npm test -- --cache=false tests/build-runtime-authority-impact.test.ts tests/build-runtime-process-residual.test.ts tests/build-runtime-scan-recovery.test.ts tests/kb-build-shutdown-admission.test.ts tests/kb-build-service-shutdown.test.ts tests/build-runtime-publish-cancel.test.ts tests/build-runtime-toolfix-regressions.test.ts tests/build-runtime-review-authority.test.ts
   ```
   → **exit0，8 文件 172 passed，0 skipped**；完整输出 `r2-review-evidence/incremental-targeted-tests.log`。其中真实 OS 用例只向自身持有句柄清理；其余 PID 信号矩阵为明示注入，不冒充生产能力。
3. cwd=`/tmp/feishu-build-v2-r3/feature-final`：
   ```text
   HOME=/tmp/feishu-build-v2-r3/review/home FEISHU_SYNC_HOME=/tmp/feishu-build-v2-r3/review/home node node_modules/tsx/dist/cli.mjs /Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/build-runtime-v2/r2-review-evidence/incremental-scan-matrix.mts
   ```
   → exit0（脚本执行成功，不代表产品通过），七场景如 §3，完整 JSONL 在同名 `.log`。
4. 同 cwd/隔离环境运行 `incremental-task-entry.mts`（沿用第3项 tsx 命令，仅替换脚本名）→ exit0；正常 UUID task 目录 unknown、文件/link 异常错误地 confirmed，详见同名 `.log`。该脚本没有进程/信号副作用。

### 抽核上游日志（未在本节点重跑整套负载）

- `/tmp/feishu-build-v2-r3/check-serial.log`：前端 **519 pass**，server **3007 pass /16 skip**；`build-current.log`：Vite/tsc/agent assets/MCP/CLI 完成，有 bundle size warning。
- **不能称默认 CI 零失败**：`check-final.log` 的 `kb-build-resume` 5000ms 超时（1 fail）；`check-current.log` 的 bridge 低频观察 `growth>=1` 失败（1 fail）。串行绿与隔离绿只支持负载/时序敏感解释，不能抹掉原失败日志；本轮没有改超时/删断言来求绿，也未据此推定新增功能回归。
- `feature-unit.log`：14 文件 **343 pass /4 gated skip**；`feature-native.log`：3 文件 **34 pass**。`native-final.log` 是更广的 6 文件 **123 pass**，与前述34有重叠，不累加为独立总量。
- `replay/{authority-probe,authority-delete-probe,residual-probe,shutdown-admission-probe}.log` 抽核：原移族/删除拒绝且登记 revision=1/receipts=1；unbound 存活个体 unknown/shutdown=false；原 ENOTDIR unknown/false；readiness 迟到 CREATE_ERROR、PIPELINE_ROW null。正式项目回归在本节点重跑，replay 日志本节点只读。
- 原生日志使用 Pi1.4.0 与冻结 amagi-pi2.21.31；明确 `[kept-home:shutdown-unsettled]`，未用 2.21.32 工作树替代。其资源目录虽沿用旧批次命名，只是冻结上游包；本节点没有导入旧 R2 候选源码。原生链是 fixture 模型，不是真实模型质量证据。

绿测不排除 §3：目前损坏测试覆盖根目录文件、JSON 语法错误/字段基本类型，未覆盖固定 home 非目录、v2-store task 在 filter 前被丢弃、未知 execution 字符串及小数 PID。这些不同输入落在真实扫描路径，不需改产品或替换验证函数即可复核。

## 6. full 影响边界清单、盲区与交付

| 维度 | 本轮结论 |
|---|---|
| 正确性/权限 | 旧新声明→完整授权集→最终同步写段；delete/edit/迁移旁路、显式合法授权均核。F03 关闭。 |
| 一致性/并发 | await 旧基线漂移、族转让、关闭同步封印、inFlight、并发 shutdown、发布锁与 CURRENT 前后重核。未见新的提交回归。 |
| 生命周期/恢复 | 空登记集/mismatch/PID冲突逐身份对账与零信号通过；扫描损坏仍可假收口，F10 不关闭。 |
| 兼容/迁移 | legacy 默认不切换；缺失/空目录和 dead-anchor 正例保留。未知 schema 不应被当兼容成功，见阻断。 |
| 资源/性能 | shutdown timeout 只限制 admission+pipeline 等待；取消/逐目录 OS 探测在其外，与已声明范围一致。未做大量历史目录的总关闭时长或吞吐基准。 |
| 可维护性/测试有效性 | 真实入口定向172通过；反例只写授权 evidence，不兼任项目测试作者；保留默认并行失败事实。 |
| UI/视觉 | 本轮无前端改动，不启动浏览器/Electron，不签视觉验收。 |

仍未覆盖：Windows 真机/UNC/安装包；setsid 逃逸边界；同 uid 插件/外部执行器的任意 OS 权限；所有文件系统 TOCTOU；远程真实模型质量；六源 A23（仍缺两份 sheet）及性能三路径三次中位数/20分钟。queued/not-started 无退出证明的保守 unknown 为已接受限制，不列 finding。

本轮约定的唯一增量复审到此完成，一次列全剩余问题，不自动再开修复或复审。Leader 可据本报告回派最小修复或完整上报主上；不应切默认或把本报告当上线认证。

产物回滚：仅本报告及新增 `incremental-*` 证据；若需恢复覆盖前主报告，可使用已核 SHA 的 `r2-full-review-report.md`，由 Leader 决定。本节点不执行回滚/清理，不删除未知运行目录；源码/index/用户现场无需回滚。

VERDICT: FIX
