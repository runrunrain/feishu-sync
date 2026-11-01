# 最后一项scanner/schema Major修复

主上收到延迟Advisor建议后明确要求继续原任务。本批仅修R2唯一增量仍未闭合的R2-F10-02；不重做已采纳的成员封存算法，不改历史PID零终止信号政策，不改amagi上游。当前为实现/自检报告，不预先签发审核PASS。初次单项核验596f155f仍FIX（原报告已保全final-scanner-review-initial.md）；下面续补正式Native schema的剩余C/D，再做本单项的一次增量核验。

## 根因与完整处理

- 固定home存在但非目录不再当不存在；legacy/epoch home统一degraded。合法eN目录、真缺失home、OS辅助文件保留契约区分。
- ENOENT不一概当无事实：`confirmedMissing`检查最近既存祖先，目标/祖先可见但不可达的link仍为缺证。此判据共用于home/epoch、anchor根/逐anchor、v2-store根。
- v2-store不先filter(isDirectory)：正式sanitizeId任务键（1..64个[A-Za-z0-9_-]）位置为file/link保留unreadable task事实；明确README/.DS_Store/.gitkeep等辅助条目不伪造任务。实际任务目录依旧读取current.json并核状态。
- execution采用冻结amagi2.21.31的十态封闭枚举；未知字符串与未知processState保留unreadable。已知终态但仍宣称alive/unknown不能拿业务完成冒充OS退出；合法终态+exited保留正例。
- rootPid/leaderPid/可选PGID核安全整数与支持范围；非法PID不进入ps后伪造exited。at/droppedRuns及可选birth字段也作形状校验，坏run标untrusted并贯穿总体unknown。

## 正式回归

新增`server/tests/build-runtime-damaged-evidence.test.ts`，24例：
- epoch/legacy home普通文件、home/epochs不可达link；
- UUID task普通文件/不可达link、v2-store不可达根；
- 未知execution/processState、终态但alive；
- 小数rootPid/PGID/leaderPid、超范围PID、非法at；
- 真空目录、合法辅助文件、六种合法终态+exited、合法整数PID确证退出正例。

每个损坏用例同时走真实adapter与KbBuildService.shutdown，断言unconfirmed/quiesced=false，不替换判定/权限/进程探针、不创建任务进程、不发信号。

原审核七场景脚本仅改import与临时根，导入纯feature后回放：unknown-execution/task-entry-file/home-file/fractional-anchor/bad-current-type/truncated-anchor全部unconfirmed+false；empty-home=confirmed+true，并用独立assert逐行验证。原失败脚本/日志不改，新的日志`/tmp/feishu-build-v2-r4/replay/matrix.log`。

## 隔离与验证

- 只改`process-residual.ts`及新增测试，无共享用户文件改动。
- 定向六文件、server typecheck、改动文件eslint通过，日志`/tmp/feishu-build-v2-r4-targeted.log`。
- 新纯feature index `/tmp/feishu-build-v2-r4/feature.index` 从R3纯index仅叠加这两文件；原R2/R3失败候选保持原样。
- 新候选SHA256=`782e3c51a8881782f5884b7d691dc99b8788139f8afb4d3a5ca77f776a618a93`；快照`/tmp/feishu-build-v2-r4/feature-final`。
- 主树相同全量/原断言/timeout串行文件验证与build均exit0：前端519/server3031通过、16skip，见`/tmp/feishu-build-v2-r4-check.log`、`/tmp/feishu-build-v2-r4-build.log`。不把旧默认并行时序夹具失败抹掉。
- 纯feature typecheck/build通过；六文件155执行通过、原生三文件34执行通过（`feature-check.log`、`feature-unit.log`、`feature-native.log`），真实unknown仍保留home，不宣称全部OS进程已退。

Windows真机、setsid、真实六源A23未测，legacy仍默认；围栏不是OS沙箱，缺证保unknown，未确认home不能删。完成全部验证后对本小范围修复及实际消费链做独立核验，不把此报告当审核。

## 正式Native producer续补（C/D）

- processState按正式TaskRun必需字段处理，缺失/非法均unreadable；任何execution业务态都不代替物理退出。没有独立未派发证明时not-started也不放行；十态×四processState完整矩阵仅exited允许无锚点收口，保持queued缺证保守策略。
- bootId/bootTimeMs严格对齐冻结Native readLaunchAnchor的成对schema：两者皆缺席为合法legacy；一缺/坏UUID/非正安全整数均untrusted。保留合法boot字段，并纳入重复关联比较；显式null PGID/birth不归一成合法缺席。
- 新正式回归73例（原24+49），定向六文件204通过；全量相同断言/timeout串行文件 lint/typecheck+前端519/server3080、16skip+build通过（/tmp/feishu-build-v2-r5-{check,build}.log）。
- 纯feature typecheck/build通过、六文件204过、真实冻结资源原生三文件34过，unknown home实际保留（/tmp/feishu-build-v2-r5/feature-*.log）。
- 独立审核原80行取证脚本仅改import/临时root，回放74矩阵+6 Native producer（真实FileTaskStore/recordLaunchAnchor，不替换上游函数）。boot三坏形态现untrusted/quiesced=false，valid原生锚点true；终态非exited与缺processState均unknown。/tmp/feishu-build-v2-r5/replay/。
- 新候选SHA256=33d9919363a8be40fb06587c965c3d7c2aa8285f905e4e1fab04f25bcddc80d4，纯index/快照位于/tmp/feishu-build-v2-r5/，旧R4失败候选不覆盖。用户代码差异仍原14路径，无共享用户文件改写。
