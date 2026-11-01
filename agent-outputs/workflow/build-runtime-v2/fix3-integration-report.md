# R2唯一增量复审批：四个Major修复集成（R3目录批次）

状态：实现切片accepted、自检已集成验证，但R2唯一增量1b5f488c仍FIX：14closed/1partial，R2-F10-02扫描/schema四类损坏反例未闭合。见r2-incremental-review-report.md；本实现报告不能代替Gate。按既定规则上报、不自动循环，不提交完成版本。原full失败与候选均独立保留。

上游：`r2-review-report.md`（8ab9e825，13closed/2partial、4Major）、`fix3-invariants.md`（Advisor完整不变量）。切片：3aa28cce Authority、dd537581→19ab71d8 Residual、39495c8e Admission；全部已显式接受，未提交源码。

## 四项修复

| Finding | 完整修复与消费链 |
|---|---|
| R2-F03-01 | 旧/新对象状态转换收齐旧族、新族、旧canonical；objects省略/[]/非空按契约区分；同路径移族、部分/全部删除、clientKey重绑、edit继承与kb_delete_doc均核族排他。装配与同步提交核同一集合，提交前重查声明基线，漂移拒绝。失败不留正文/声明/索引/回执的局部改变。 |
| R2-F10-01 | 匹配的anchor实际逐run对账；有Leader登记集但不匹配的run明确unknown、不充covered；登记集为空时仍按私有home内可见事实逐个真实探测，而不是filter空后confirmed。活根unknown、确证死根真正经过ps核验。 |
| R2-F10-02 | anchor/v2-store根与逐文件读取显式missing vs degraded/untrusted；非ENOENT、坏schema、截断等直接生成unconfirmed，贯穿adapter/shutdown，不能只改note。旧事实读取失败不允许目录清理。 |
| R2-LC-01 | shutdown先同步永久封准入，create/resume/manual release-confirm首个await前登记inFlight，同一lease在最终入列/spawn/CURRENT前同步重核。在途admission进入等待与超时报告；CURRENT后安全DB/状态收尾不粗暴回滚；迟到发布回调/已结算发布锁拒绝。内部cancel仍可执行。 |

## Leader合并复核补强

1. Authority原补丁的旧族收集仍写在crossPath分支的else-if中；补为正交检查：即使同时持有旧/新Doc，跨path又改族也须核旧Family。先红后绿回归证明未修前仍会绕权；显式转授旧Family后迁移成功。
2. PID不是运行身份：原Map只留首份声称可把old-token先/live-token后误判not-ours/confirmed。续轮改claimsByPid保留多份，冲突逐声称真实裁决、活匹配者unknown且零signal。Leader再把anchor关联的leader/pgid、ledger的birth/build/epoch/generation纳入去重，补同task同birth但pgid冲突漏孤儿、同launchId两birth冲突两反例。完全相同物理关联仍可去重。
3. 并发shutdown共享同一Promise内核，不只共用封印bool；封印第一同步步立即生效，内核微任务前已登记，防重入重复cancel/扫描。项目回归验证并发两调用只扫描一次、共享结果且立即拒create。
4. shutdown的50/200ms等待timer保留ref，裸Node/top-level await也能等到诚实的超时报告，不依赖HTTP/Vitest句柄保活。原admission脚本在100ms截止后明确quiesced=false、放行readiness仍拒创建、PIPELINE_ROW=null。

等待预算说明：timeoutMs共同覆盖admission与pipeline等待；取消链和持久逐目录扫描仍有其自己的探针上界，不声明这是整条shutdown的严格墙钟总deadline。报告里的“总等待”不能误读为OS原子退出或无限历史数量下固定时长。

## 验证证据（`/tmp/feishu-build-v2-r3/`）

- 主树静场`npm run check`：前端519/server3007通过，server16skip；build:all通过，`check-final-quiet.log`/`build-final.log`。最后timer-ref小修后的默认并行确认`check-current.log`遇F02桥接夹具500ms观测窗口负载抖动（growth=0）；隔离原文件通过`bridge-isolated.log`。随后相同全量、原断言与原timeout，仅关闭文件并行做控制确认`check-serial.log`：lint/typecheck/前端519/server3007通过，16skip，exit0；`build-current.log` exit0。不把默认并行的该次失败抹成通过。
- 第一轮全量唯一失败为既有legacy 32文档恢复测试5s超时；未改timeout/用户文件。隔离原文件通过（`resume-isolated.log`），随后原口径静场全绿；保留`check-final.log`失败，不抹掉。
- 主树冻结资源真实原生链6文件123执行通过（`native-final.log`）；unknown home实际保留，非宣称全部OS进程已退出。
- 纯feature独立typecheck/build通过（`feature-typecheck.log`/`feature-build.log`）；14文件343执行通过/4显式资源skip（`feature-unit.log`）；真实原生3文件34通过（`feature-native.log`），同样真实触发unknown保留。
- 原审核四脚本仅改源码import与临时夹具根，导入纯feature，全部exit0（`replay/*.log`）：
  - change-prior-family/remove-objects均ERROR；旧对象族、revision、正文及receipts保留。
  - 真实自有Node根存活：UNBOUND_ANCHOR=unconfirmed、SHUTDOWN_UNBOUND.quiesced=false；finally仅杀自有ChildProcess句柄并等close。
  - 内层ENOTDIR：UNREADABLE_SCAN=unconfirmed，SHUTDOWN_UNREADABLE.quiesced=false；不混称该损坏夹具另有活进程。
  - readiness迟到：SHUTDOWN_BEFORE_READINESS.quiesced=false/timedOut=true/inFlight登记；释放后CREATE_ERROR，PIPELINE_ROW=null，无新行/启动。

计数均为用例执行次数（跨文件导入契约不包装成独立场景）。fixture不是LLM质量/性能证据。正式资源仍pi1.4.0声明bin+冻结amagi-pi2.21.31 SHA9485dd95c004，不用2.21.32演进树冒充支持证明。

## 纯功能投影与用户现场

- 从保留的R2纯index叠加相对dirty-snapshot28605c53的增量，独立临时index `/tmp/feishu-build-v2-r3/feature.index`；目录`feature-final`，57个候选路径。
- 唯一三方冲突在delete-doc新族检查旁的原用户revision保护：仅在临时文本移除用户块，保留本批族检查；主树用户字节不动。投影与全工作树的代码差异仍仅原14路径，`user-remains.patch`留档。
- 原R2`feature.index`/`feature-final`及02d8c854候选不覆盖；新累计候选`final-feature.patch` SHA256 `f0e8da6aec7c132d9fdf8f1fac37cadb10a3481eebcb1204f1b28dcfca830aa6`。
- Main原暂存区没有被临时index覆盖。完成提交只取纯功能index与本任务artifact，不夹用户12修改+2新增。

边界保持：Windows真机/UNC/打包、setsid逃逸、真实六源A23/质量性能仍未测；2份sheet缺失不伪造，legacy默认不切换；模型文件围栏不称OS沙箱，生产历史PID零终止signal。回滚只用精确patch先reverse-check，不checkout整文件。
