# build-runtime-v2 交付：已知审核发现闭环

## 结论与范围

按设计v2实现单Pi Leader + amagi原生子任务构建，未新增应用调度器、未改amagi上游。P0–P3、统一修复与主上续令后的最后scanner/schema修复已完成。独立审核原F01–F15累计全部closed（代码/所列覆盖层），无剩余已证Critical/Major/Minor；不是所有平台、真实资料质量或性能验收完成。

审核链保留历史FIX：R1→R2 full→R2唯一增量14closed/1partial→最后单项初审FIX→本单项一次增量d62dfd56 **PASS且accepted**。最后报告`final-scanner-review.md`，初审原字节`final-scanner-review-initial.md`；原R2/R3失败报告/候选/取证不覆盖。

## 最后Major的完整收口

- 固定epoch/legacy home非目录、悬空link、不可达祖先保留degraded；确证缺省才视无事实。
- 合法task键位置的file/link不被目录filter静默抹去，正式辅助文件不伪造任务。
- execution/processState冻结枚举且processState必需；业务终态、not-started不当物理退出证明。无独立未派发证明时unknown，合法exited正例保留。
- PID/PGID/leaderPid安全整数/范围；Native boot字段成对、合法UUID及正安全整数，损坏证据不进入ps后伪证退出；完整Native/legacy保留正例，boot身份关联不被去重吞掉。

既有授权完整影响面、草稿失败保留、SDK路径别名/祖先泄漏、代次/成员归属、准入封闭、shutdown quiescence政策保持。生产不自动终止历史数字PID；queued/not-started缺证可持续阻断；未确认home保留，不拿pipeline完成或rm成功当OS证明。

## 验证

| 层级 | 真实结果 |
|---|---|
| 主树同全量/原断言/timeout，仅文件串行 | lint/typecheck通过；前端519/server3080通过，16skip；build:all通过 |
| 剔除用户WIP的纯feature | typecheck/build通过；直接影响六文件204通过；实际Pi1.4.0正式bin+冻结amagi2.21.31原生三文件34通过 |
| 独立最后增量 | 重跑204定向/34原生，另89项完整Native TaskRun、真实anchor producer、boot关联取证；四类closed，无新增finding |
| 候选一致性 | 58路径逐index blob与快照0差异，独立复核SHA一致 |
| 历史UI/主链 | 真实浏览器/API证据见ui-real-api-acceptance.md；本单项未改前端、不冒称重新视觉认证 |

全量日志`/tmp/feishu-build-v2-r5-{check,build}.log`；纯feature与回放`/tmp/feishu-build-v2-r5/feature-*.log`、`replay/`；独立可持久回源`final-scanner-evidence/r5-*`。Native 34与辅助89不是另一个可与server3080相加的全量总数。旧默认并行5s/500ms夹具失败与隔离证据保留，不抹历史、不放宽断言/timeout。

## 用户改动保护与Git

代码候选`final-scanner-fixed-candidate.patch` SHA256=`33d9919363a8be40fb06587c965c3d7c2aa8285f905e4e1fab04f25bcddc80d4`（相对25cc0b4）。独立index只含58路径feature；完成提交再加入本批artifact，不把用户原12修改+2未跟踪代码混入。

R3与最终R5的“纯feature→完整用户现场”14路径差异patch逐字cmp相同，SHA256=`3517517652bd91a90a5da6bf979939e30148c8c096c09e631e12fcb01694b6cb`；主树代码与当前全量现场index无额外漂移。原patch只留库外临时区，不为报告新提交用户代码。Git收口使用隔离index，原index先备份、最终仅index级更新；不reset/restore/clean或覆盖工作树。提交身份见Git日志与对话终稿，不在提交内自引用hash。

## 不签发的边界

A23六源对照仍缺2/6 sheet；Windows真机/UNC、setsid整链、所有FS TOCTOU、远程真实模型质量/性能基准未认证。legacy仍默认，不擅自切新编排为默认。应用文件围栏不是同uid/受信插件的OS沙箱。后续这些外部验证须独立真实执行，不用fixture或本次PASS代替。

上游：workflow.md、fix-map.md、acceptance-matrix.md、fix3-integration-report.md、fix4-scanner-report.md、r2-incremental-review-report.md、final-scanner-review.md。

<!--AMAGI:DONE-->
