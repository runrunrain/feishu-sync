# R2-F10-02 最后单项 quick 核验

**结论：FIX。R2-F10-02 仍为 Major / partial：A、B closed；C、D 原直接反例已关，但同类 schema 边界仍未闭合。没有另起 R2 Gate，也没有重审已采纳的成员封存/信号算法。**

## 1. 范围、基线与证据身份

- 必读输入：`r2-incremental-review-report.md`（尤其 §3）、`fix4-scanner-report.md`、`/tmp/feishu-build-v2-r4/scanner-delta.patch`、`/tmp/feishu-build-v2-r4/feature-final/`。仅审核相对 R3 的 `process-residual.ts` 与新增 `build-runtime-damaged-evidence.test.ts` 及其实际消费链。
- HEAD=`25cc0b43b17e70cf0c6513a81f42a8e7dd268743`。独立校验新 index 相对 HEAD 的累计 patch SHA256=`782e3c51a8881782f5884b7d691dc99b8788139f8afb4d3a5ca77f776a618a93`；**58 路径逐 blob 与 feature-final 比较，0 不一致**。实体 patch 实际名为 `/tmp/feishu-build-v2-r4/final-feature.patch`，同 SHA；初查 `final-scanner-candidate.patch` 不存在，未据名称假定存在。
- 回源的冻结上游：`/tmp/feishu-build-v2-r2/amagi-pi-2.21.31/extensions/amagi-core/{task-store.ts,contracts/task.ts,artifact.ts,launch-anchor.ts}`，补查其 `task-recovery.ts`、`task-kernel.ts` 和实际派发调用。此目录仅作冻结正式上游，不导入旧 R2/R3 候选实现。
- 本轮仅写本报告和 `final-scanner-evidence/`；临时数据在 `/tmp/feishu-build-v2-r4/review/`，显式 HOME/FEISHU_SYNC_HOME。未改源码/项目测试/上游/index，未提交；未读取生产资料或凭据。取证脚本不是项目正式测试。

## 2. 原四类子例逐项裁决

源码行号均为 **R4 feature-final**，不是共享主树。

| 原子例 | 裁决 | 独立核验 |
|---|---|---|
| A：固定 epoch/legacy home 非目录 | **closed** | `process-residual.ts:263–294`：普通文件明确 degraded；epoch/home 悬空 link、祖先悬空 link 经 confirmedMissing 保留缺证。真实 adapter → shutdown 均 unconfirmed/false。真空 home confirmed/true。epoch 仅接受正式 eN 名称，未把系统辅助名虚构成 epoch。 |
| B：v2-store 合法任务位置被 Dirent filter 丢弃 | **closed** | `:210–253` 不再先 filter；与冻结 `artifact.ts:105–107` 的 sanitizeId（1..64 个 A-Za-z0-9_-）一致。UUID 普通文件/link 均 unreadable，贯穿 unconfirmed/false；辅助 README/README.md/.DS_Store/.gitkeep 不制造任务。未采用“所有字符串都是 task”的判法。 |
| C：未知 execution 被当终态 | **partial** | 十态 execution/四态 processState 与冻结契约一致；未知枚举、终态 alive/unknown 已保守拒绝。**但缺必需 processState，或 done/error/truncated + not-started，仍 confirmed/true**，见 §3-C。不是要求重写既有执行态算法。 |
| D：小数 PID 被 ps 缺席伪证 exited | **partial** | rootPid/leaderPid/pgid 小数、越界 rootPid、负 at、坏 droppedRuns、数字 rootIdentityToken 均 untrusted→unconfirmed/false；合法整数 absent PID、合法 at/零 droppedRuns 保留 confirmed/true。**但正式锚点的 boot 成对字段损坏仍被接受为可信退出事实**，见 §3-D。 |

`confirmedMissing`（`:100–117`）的静态路径与真实 FS 取证相符：只接受 ENOENT 且最近既存祖先是可达目录；目标 link 或祖先 link 存在但不可达，不是确证缺席。独立覆盖 home/epoch、anchor 根/任务/file、v2-store 根/task、共同祖先，不以普通 ENOENT 一概抹除。

## 3. 唯一未关闭 finding

### R2-F10-02｜Major｜partial：schema 缺证仍可产生 confirmed/quiesced

**归因**：沿用原编号与严重度。以下是本轮明确 scanner/schema 范围及 Leader steer 的未闭合边界，不另包装成两个新增 Major；不是原 F03、PID 多声称、准入或成员算法回归。

#### C：业务终态仍掩盖必需进程态缺失 / not-started

- **定位**：`server/src/agent/build-runtime/process-residual.ts:241–250`。`:242` 对 `undefined` 不校验；`:248` 对已知非 active execution，只要不是 alive/unknown 即 continue，包含 undefined 和 not-started。
- **触发与真实结果**：使用冻结 Native `FileTaskStore.replaceCurrent()` 写入**完整、校验成功**的 TaskRun（包含 version/ownerId/taskId/revision/specId/stateSeq/三轴/backend/recovery/queuedAt/processState），不是仅 `{execution:...}` 的缺字段 fixture。
  - `done/error/truncated + not-started`：Native validateTaskRun=true，本地 intents 无缺证 → adapter confirmed → shutdown.quiesced=true。
  - 先 Native 写入合法 done/exited，再从落盘对象删除必需 processState：Native validateTaskRun=false，本地仍同样 confirmed/true。
  - 同样完整对象的终态 alive/unknown 正确 unconfirmed/false；exited 正确 confirmed/true。十态×四态共40行均实际执行。
- **正式依据 / steer 裁决**：冻结 `contracts/task.ts:196,649–650` 的 processState 是必需字段，校验不是可选；没有该字段可缺省为退出的 legacy 约定。冻结 `task-recovery.ts:562–569,579–586` 明确：有 launchIntent 而非 exited 属不确定；done/error/truncated 即使无 launchIntent，not-started/alive 也**没有物理退出证据**，不能凭终态判干净。`task-kernel.ts:733,745` 的 grant-start 先写 running+launchIntent，不同步把 not-started 改为 alive，not-started 并不无条件证明从未跨入派发。
- **边界不扩张**：不是把所有 terminal/not-started 一律认作活进程。取消于派发前、无启动意图的正常未执行记录可以有合法解释；本 finding 的确定反例是上述 done/error/truncated，以及 Native 正式必需字段损坏。不能只凭这个枚举跳过必要退出/未派发证明。
- **影响**：没有进程退出证明的任务被清除出未确认面；真实 shutdown 出具允许消费方清理的 quiesced=true，新鲜恢复 guard 不会因这份事实阻断。未声称本轮实际删除了目录或启动了第二 Leader，也未在 fixture 中伪称存在活子进程。
- **证据**：`final-scanner-evidence/scanner-probe.mts` / `scanner-probe-run.log` 的 `done/not-started`、`error/not-started`、`truncated/not-started`、`missing-process` 行；`assert-evidence.mjs/.log` 独立断言观察结果。
- **最小方向**：必需 processState 缺席/非法保留 unreadable；已知业务终态仅在有充分 exited 或符合正式未派发契约的证明时忽略，不让 not-started 无条件替代退出证明。保留合法 terminal+exited 正例。

#### D：Native 正式锚点的系统启动身份字段损坏被忽略

- **定位**：`server/src/agent/build-runtime/process-residual.ts:151–177`；读取形状只核 PID/at/rootIdentityToken，没有核 `bootId/bootTimeMs` 成对及合法性。
- **触发与真实结果**：独立调用冻结 **`recordLaunchAnchor()`**（包括同步 boot 探测与异步出生令牌补写）生成完整 Native 锚点，再分别删 bootTimeMs、删 bootId、或改为 bootId=23/bootTimeMs=-1。没有替换 native/scanner/OS 探针。
  - 冻结 `readLaunchAnchor()` 对这三种对象全部拒绝（undefined）。
  - 本地 scanner 全部 `untrusted=false`，把合法整数 absent root PID 送入真实 ps，生成 child verdict=exited；adapter confirmed、真实 shutdown.quiesced=true。
  - 完整未损坏 Native 锚点正例 confirmed/true；rootIdentityToken 数字负例 untrusted/false，证明不是“无法运行 Native 读器”或全都拒绝的夹具。
- **正式依据**：冻结 `launch-anchor.ts:97–110` 明定 boot 字段成对，bootId 必须匹配 BOOT_ID_RE，bootTimeMs 必须正安全整数；半缺/畸形表示写入异常或篡改，**整体不可信**。这不是要求审核者猜所有未知扩展字段；是正式上游已识别且明确拒绝的字段。两字段皆缺席才走合法 legacy 兼容。
- **影响**：正式证据已不可信仍被当作可信 run，实际发出 exited/confirmed/quiesced；违背本轮“schema 失败不得伪证退出”承诺。不要求本地实现跨 boot 退出算法，只要求别把损坏证据升级成可信退出事实。
- **证据**：`final-scanner-evidence/native-shape-probe.mts/.log`，三行 `bootId-only` / `bootTime-only` / `boot-bad-type`；另有74行矩阵对 boot 半缺的复核，`assert-evidence.mjs` 对 nativeAccepted=false 而 exited/confirmed/true 独立断言。
- **最小方向**：复用/对齐正式 boot 成对 schema；坏字段 untrusted，完整旧版两字段皆缺席仍按已有 legacy 判定，不新增系统重启推断或扩大历史 PID 信号能力。可选 PGID/rootIdentityToken 的显式 null 当前也被 `!= null` 当缺席归一；如修订 schema，应区分正式缺席与坏类型，避免再引入同类洞（未单独计 finding）。

**新增独立 finding：0。原 Major 剩余：1（R2-F10-02）。未发现已证实的修复引入回归。**

## 4. 消费链与验证记录

### 独立执行

1. `node final-scanner-evidence/snapshot-check.mjs`（项目根）→ exit0，累计 SHA/58路径/0不一致，见同名 `.log`。
2. cwd=`/tmp/feishu-build-v2-r4/feature-final/server`，临时 HOME/FEISHU_SYNC_HOME：
   ```text
   npm test -- --cache=false --fileParallelism=false tests/build-runtime-damaged-evidence.test.ts tests/build-runtime-process-residual.test.ts tests/build-runtime-scan-recovery.test.ts tests/build-runtime-adapter.test.ts tests/kb-build-service-shutdown.test.ts tests/build-runtime-integration.test.ts
   ```
   → **exit0，6文件155 passed，0 skip**，`final-scanner-evidence/targeted.log`。未改 timeout/原断言；真实 OS 用例仅清理自有 ChildProcess。
3. 同 cwd，另设 TMPDIR=`/tmp/feishu-build-v2-r4/review`、`AMAGI_PI_SOURCE_DIR` 与 `PI_PROBE_SOURCE_AMAGI` 指向冻结2.21.31；PI_PROBE_PI_CLI 为已读取 package.json 的 **Pi1.4.0 正式 bin `dist/bundle/cli.js`**：
   ```text
   npm test -- --cache=false --fileParallelism=false tests/build-runtime-fix-e2e.test.ts tests/build-runtime-integrity.test.ts tests/build-runtime-e2e.test.ts
   ```
   → **exit0，3文件34 passed，0 skip**，`final-scanner-evidence/native.log`。真实 Native安装/Leader/child/桥/发布/恢复执行，fixture模型非真实模型质量；实际出现 `[kept-home:shutdown-unsettled]`，unknown home 保留，未删。
4. cwd=`/tmp/feishu-build-v2-r4/feature-final`，同临时 HOME/FEISHU_SYNC_HOME，执行两个独立取证脚本：
   ```text
   node --import tsx --import <evidence>/upstream-loader.mjs <evidence>/scanner-probe.mts
   node --import tsx --import <evidence>/upstream-loader.mjs <evidence>/native-shape-probe.mts
   ```
   均 exit0；**74矩阵行+6 Native producer行**，见 `scanner-probe-run.log`、`native-shape-probe.log`。退出码只表示取证完成，不表示产品通过。随后 `node <evidence>/assert-evidence.mjs` exit0，逐类断言结果及剩余错误确实存在。
   初次直接导入冻结上游失败于未安装 typebox；随后一次 hooks 未传入 tsx 子进程、一次动态 require.resolve hooks 递归，原错误分别保存在 `scanner-probe.log` / `scanner-probe-resolved.log` / `scanner-probe-final.log`。最终 loader 只预解析宿主 Pi1.4 安装内的 typebox，不替换任何上游实现/读器/判定函数，不安装、不修改上游。完整 Native 34例是正常正式启动链，不依赖此取证 loader。

### 真实消费链核对

- `process-residual.ts:440–529` 将 degraded/untrusted/unreadable/anchorless 导入 findings，`:536–544,738–749` 按未确认项决定 outcome；不是只修改 note。
- `adapter.ts:104–114,174–198` 根扫描失败直接 unconfirmed、多 home 合并任一 unknown 则 unknown。
- `kb-build-service.ts:1042–1061,319–355`：真实磁盘对账到 shutdown DTO，unconfirmed 阻止 quiesced。取证每行均调用真实 `reconcileBuildRootResiduals()` 与 `KbBuildService.shutdown()`，没有替换 scanner/权限/探针/判定。
- `build-runtime-host.ts:914–919` 使用同一 adapter；`build-leader-supervisor.ts:354–425` 在新 launch/换代/epoch 前新鲜复核，unconfirmed 到期仍拒绝。该门禁的实际相关用例在155例中通过；本轮反例未实际启动第二 Leader，放行风险由真实 confirmed 结果和此 guard 静态分支证实。
- `server/src/index.ts:812–820,902–910` 未收口保留现场；原生34例真实观察到保留 home。没有对未知 PID 发终止信号；历史数字 PID 生产零终止 signal 政策未改。`ps`/出生探测和 signal 0 不是终止信号。

### 上游日志抽核（不冒充本节点重跑）

`/tmp/feishu-build-v2-r4-check.log` 摘要确为前端519、server3031、16skip；`/tmp/feishu-build-v2-r4-build.log` 完成 Vite/tsc/assets/MCP/CLI，有 bundle size warning。实现者全量/纯feature typecheck/build记录仅为补充，本节点没有重新执行全量check/build。旧并行失败日志/timeout/断言保持不变；本节点串行定向绿不抹掉原失败历史。

## 5. 未覆盖与收尾

- 原 F03、PID多声称、准入等不受 delta 影响，继承前次已关闭裁决；不重做全仓审计。无前端改动，本轮不做视觉认证。
- 未穷尽所有 FS TOCTOU、权限/挂载故障；未测 Windows 真机/UNC、setsid、真实六源A23、性能中位数、远程真实模型质量。不是 OS sandbox，也未把冻结上游记账终态当 OS 沙箱证明。
- 正式测试由实施者补；本节点只交复现与最小方向，不写修复 patch。原测试24例有效且通过，但不足以覆盖 §3；测试通过不能签发 schema 完整闭合。
- 回滚仅涉及本报告及新增 evidence 文件；源码/项目测试/上游/index 无本节点修改，无需回滚。临时未知运行 home 保留，不清理。节点到此一次完整上报，不自动开下一轮。

VERDICT: FIX
