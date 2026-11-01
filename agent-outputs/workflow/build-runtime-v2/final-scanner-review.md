# R2-F10-02 scanner/schema：R5 单项增量核验

**结论：PASS。原 R2-F10-02（Major）关闭；A/B/C/D 四类均 closed。本轮范围内无新增已证 finding、无已证修复回归。**

本结论仅针对 R4→R5 最后单项修复及直接影响边界，不是另开全仓 Gate，不代表所有平台/模型/性能验收通过。

## 1. 基线、输入与证据身份

- 必读输入：`fix4-scanner-report.md`（含新增“正式Native producer续补”）、`final-scanner-review-initial.md`、`/tmp/feishu-build-v2-r5/scanner-delta.patch`、新纯feature源码。原 R2 四类定义承接 `r2-incremental-review-report.md` §3。
- **纯候选**：`/tmp/feishu-build-v2-r5/feature-final/`；index=`/tmp/feishu-build-v2-r5/feature.index`；累计 patch=`/tmp/feishu-build-v2-r5/final-feature.patch`。独立计算累计 SHA256=`33d9919363a8be40fb06587c965c3d7c2aa8285f905e4e1fab04f25bcddc80d4`，与冻结输入一致。
- HEAD=`25cc0b43b17e70cf0c6513a81f42a8e7dd268743`；**58路径逐 index blob 与 feature-final 比较，0不一致**。不以共享WIP或用户原14路径充当候选护栏，也不把它们纳入写面。
- 本轮 delta 仅 `server/src/agent/build-runtime/process-residual.ts` 与 `server/tests/build-runtime-damaged-evidence.test.ts`。已读具体实现与新增73例正式测试，不据实现者自述或绿测数量裁决。
- 正式上游仍为冻结 `/tmp/feishu-build-v2-r2/amagi-pi-2.21.31/extensions/amagi-core/` 的 task-store、contracts/task、artifact、launch-anchor 及相关 boot-identity/task-recovery/task-kernel 契约；不是旧R2候选。本轮没有导入R4/R3候选源码。
- 覆盖前核验原报告与 Leader 备份逐字 SHA 相同：`e0ee859062cd875ce1ef4bd3d936baa9a95699db326f5c9b7e0019b324a8f07d`。备份 `final-scanner-review-initial.md` 未修改；历史取证不覆盖，新增证据统一为 `final-scanner-evidence/r5-*`。

## 2. 原编号与四类子例裁决

行号均相对 **R5 feature-final**。

| 原编号/子类 | 本轮状态 | 回源及独立证据 |
|---|---|---|
| R2-F10-02 A：固定home非目录 | **closed（保持）** | `process-residual.ts:102–120,274–306`：epoch/legacy普通文件、home/epoch悬空link、共同祖先不可达均保留degraded；实际adapter→shutdown为unconfirmed/false。真空home仍confirmed/true。R5未改变该判别。 |
| R2-F10-02 B：合法task位置被过滤 | **closed（保持）** | `:220–244`：正式sanitizeId任务键的普通文件/link保留unreadable事实；UUID任务位置损坏均unconfirmed/false，README等辅助文件仍confirmed/true。没有把任意字符串视为task。 |
| R2-F10-02 C：执行/进程态schema及终态假收口 | **closed** | `:250–266`：processState必需、四态闭合；未知execution/processState或缺processState不可读。所有execution均不凭业务终态跳过非exited事实。**十态×四态40行完整Native TaskRun实际写入、Native校验成功**：无锚点时30个非exited组合均unconfirmed/false，10个exited组合均confirmed/true；删除必需字段的原反例现unreadable/false。 |
| R2-F10-02 D：非法身份/boot被伪证exited | **closed** | `:153–187`：PID/PGID/leaderPid安全整数范围、at、droppedRuns原防线保持；boot成对/UUID/正安全整数与Native读器一致；显式null PGID/birth拒绝。**真实recordLaunchAnchor producer**写出的完整锚点被局部损坏后，三种原boot反例现均untrusted→unconfirmed/false；完整Native与legacy、整数PID确证退出仍confirmed/true。 |

**原唯一Major R2-F10-02：closed。新增finding：Critical 0 / Major 0 / Minor 0。** 没有仅为报告更优写法而新增问题，也没有降档处理原Major。

### C：Native合法未执行情形与退出证明边界

- 独立取证调用冻结 `FileTaskStore.replaceCurrent()` 写完整TaskRun，不是仅含两个字段的fixture；包括version、任务身份、revision、stateSeq、三轴、backend、recovery、queuedAt与processState。
- Native合法 `queued/not-started`、`cancelled/not-started` 等仍被识别为**合法状态**：Native validateTaskRun=true，本地 unreadableTasks为空；但没有独立未派发/退出证明时保留anchorless unknown，不伪造exited。该保守策略是本轮明确接受的边界，不声称这类现场已有活进程，也不声称它们能够自动清理。
- `not-started` 合法不等于无条件从未跨入派发：冻结task-kernel的grant-start先持久化launchIntent；task-recovery对终态无物理退出证据保持不确定。本轮修复没有删掉合法枚举或把合法未执行数据判成损坏，而是区分schema有效与OS可收口。
- 全部合法execution+exited正例保留；若有可信锚点，仍沿既有逐个体真实对账，不因非exited意图直接伪造退出。queued/not-started缺证可能持续阻断，不能把PASS解释成已实现独立未派发证明或自动豁免。

### D：boot schema、legacy与关联边界

- 正式 `boot-identity.ts` 的BOOT_ID_RE与本地UUID规则逐字一致；`launch-anchor.ts`要求两字段成对、bootTimeMs正安全整数。R5未新增“看起来像旧系统启动”就放行的跨boot推断。
- Native producer同步写boot、异步补令牌后：完整正例退出确认；删bootId/删bootTimeMs/坏类型均不可信。另独立检验零/非安全整数/null boot、空birth拒绝；大小写合法UUID和两boot字段均缺的legacy保留正例。
- `:522–530` 保留boot字段并参与重复关联。真实ps路径独立验证：完全相同锚点声称只出1个退出项；仅bootId不同或仅bootTime不同的声称均保留2个退出项，未被去重吞掉。这里没有重做PID多声称或成员封存算法，也不宣称boot单独赋予信号资格。

## 3. 独立验证（本节点执行）

证据目录：`agent-outputs/workflow/build-runtime-v2/final-scanner-evidence/`。临时HOME、FEISHU_SYNC_HOME及TMPDIR均显式落 `/tmp/feishu-build-v2-r5/review/`；取证脚本使用独立临时子目录，无生产资料/凭据或远程模型访问。

| 验证 | 命令/实际入口 | 结果与证据 |
|---|---|---|
| 快照一致性 | 项目根 `node <evidence>/r5-snapshot-check.mjs` | exit0；SHA正确，58路径/0不一致；`r5-snapshot-check.log`。 |
| 直接影响回归 | 新纯feature/server：`npm test -- --cache=false --fileParallelism=false tests/build-runtime-damaged-evidence.test.ts tests/build-runtime-process-residual.test.ts tests/build-runtime-scan-recovery.test.ts tests/build-runtime-adapter.test.ts tests/kb-build-service-shutdown.test.ts tests/build-runtime-integration.test.ts` | **exit0，6文件204 passed，0skip**；`r5-targeted.log`。含73例正式damage、真实OS扫描和恢复/关闭消费链；未改断言/timeout。 |
| 正式Native链 | 同cwd：`npm test -- --cache=false --fileParallelism=false tests/build-runtime-fix-e2e.test.ts tests/build-runtime-integrity.test.ts tests/build-runtime-e2e.test.ts`；AMAGI_PI_SOURCE_DIR/PI_PROBE_SOURCE_AMAGI均指冻结2.21.31，PI_PROBE_PI_CLI指Pi1.4.0正式声明bin `dist/bundle/cli.js` | **exit0，3文件34 passed，0skip**；`r5-native.log`。真实安装/Leader/child/桥/发布/恢复，fixture模型非真实模型质量；实际出现 `[kept-home:shutdown-unsettled]`。 |
| 原反例及全状态矩阵 | 新纯feature根：`node --import tsx --import <evidence>/upstream-loader.mjs <evidence>/r5-scanner-probe.mts`、同入口运行 `r5-native-shape-probe.mts` | 各exit0；**74矩阵行+6 Native producer行**，`r5-scanner-probe-run.log`、`r5-native-shape-probe.log`。原C/D不再confirmed/true，正例不退化。 |
| boot关联与边界 | 同Node入口运行 `r5-boot-association.mts` | exit0；**9例**含原生producer、legacy/大小写UUID/异常boot/null/空birth、重复与不同boot声称；脚本内独立assert，`r5-boot-association.log`。 |
| 逐行复核 | 项目根 `node <evidence>/r5-assert-evidence.mjs` | exit0；独立断言74+6行及9例数量、Native合法状态未被判损坏、SHA/58路径；`r5-assert-evidence.log`。 |

补充执行事实：第一次复用确定性`review/case-N`路径碰到既存current，Native CAS如实拒绝，原失败保存在 `r5-scanner-probe.log`；未删既存现场、未放宽CAS。新取证脚本仅将自己的临时根改为mkdtemp唯一子目录后完成回放。所有原取证文件保持原样。

Native helper取证复用原只读 `upstream-loader.mjs`，仅解析冻结源码缺少的typebox依赖到宿主Pi1.4安装，不替换上游producer/reader/validator/OS探针。正式34例Native启动不依赖这个loader。辅助脚本未创建任务进程或发终止信号；项目真实OS用例只清理持有自有ChildProcess句柄的fixture，未向未知PID发终止signal。

## 4. 完整直接影响链与测试有效性

- **FS root/task/file/read/parse/shape**：confirmedMissing仍只接受确证无路径；悬空link/不可达祖先保留未知。A/B原取证在R5重新执行，非目录/不可达不被过滤。JSON/坏类型/枚举/schema由scanner保留缺证；不把schema失败送入ps伪证exited。
- **scanner→outcome**：`process-residual.ts:447–520,548–555,750–761` 中degraded/untrusted/unreadable进入finding并决定整体state，而非只改note。
- **outcome→adapter→shutdown**：`adapter.ts:104–114,174–198` 保守合并；`kb-build-service.ts:319–355,1042–1061` 磁盘未知阻止quiesced。独立矩阵每行都调用真实adapter与KbBuildService.shutdown，没有替换扫描/权限/判定函数。
- **不清理/不新launch**：`server/src/index.ts:812–820,902–910`、`build-runtime-host.ts:914–919`、`build-leader-supervisor.ts:354–425` 延用未知保留/新鲜复核门禁。Native实际观察到unknown home保留；恢复门禁相关实际项目测试通过。逐个损坏夹具没有另外启动第二Leader，阻断语义由真实unknown结果及相同guard分支核实，不虚构每个夹具的额外进程启动试验。
- **测试有效性**：73例新增正式测试在真实adapter/shutdown入口断言，但current部分是最小fixture；因此另用完整Native TaskRun与真实recordLaunchAnchor补足，不把缺字段fixture的绿测当Native兼容证明。原生34例与辅助89行是不同层证据，不合并成一个“全量测试总数”。
- **未变影响面**：A/B、成员封存、历史PID生产零终止signal、原F03/PID多声称/准入均不在本轮重设计；继承前次已关闭结论，本轮仅核实新字段关联没有吞事实。用户WIP不纳入修复归因。

## 5. 上游日志、盲区与收尾

- 只读抽核 `/tmp/feishu-build-v2-r5-check.log`：前端519、server3080、16skip；`/tmp/feishu-build-v2-r5-build.log`：Vite/tsc/assets/MCP/CLI完成、有bundle size warning；`feature-check.log`：纯feature typecheck/build完成。本节点未重跑全量check/build，不把实现者日志等同独立执行；旧并行失败历史不抹去，串行文件参数没有改timeout或断言。
- 未穷尽所有FS TOCTOU、权限/挂载故障；Windows真机/UNC、setsid、六源A23、性能基准、远程真实模型质量仍未验证。本轮无前端变更，不签视觉认证。不是OS sandbox，不将同uid/插件权限围栏夸大为系统隔离。
- 产物：本报告及新增`final-scanner-evidence/r5-*`；无源码/index/项目测试/上游修改、无提交。回滚仅需Leader按需要恢复已核SHA的`final-scanner-review-initial.md`，本节点不执行回滚或清理未知home。临时未收口现场保留。
- 本轮一次增量完整上报到此结束，不自动开启下一轮Gate或修复。

VERDICT: PASS
