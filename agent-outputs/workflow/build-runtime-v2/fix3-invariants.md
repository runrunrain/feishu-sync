# R2 Gate后修复不变量（R3目录批次）

来源：独立full报告`r2-review-report.md`；Advisor `advisor-008b32b8-d5fc-45a2-96ca-4ed5f4e3faa9`，openai-codex/gpt-6-astra:high，selected咨询。不是审核PASS，也不实施上游改动。已分别steer给3aa28cce/dd537581/39495c8e。

## 完整授权影响

授权状态转换而不是只核输入：新增核新族；修改/移族核旧+新族；删除核旧族；跨path另核旧/新canonical。正文变化、对象索引删除、clientKey重绑定同样计入。Doc写权不覆盖Family排他。`objects`省略/[]/非空按原契约区分。

装配与最终同步提交使用同一完整影响集，并确认旧声明/索引基线未在await期间漂移；否则拒绝或重算，不能只查旧集合的当前租约。最终核验至首个受保护副作用无await，失败不留正文/声明/索引/成功回执的局部变化。核write/edit共用内核及delete/replace/migrate所有旁路；保留被授权合法操作正例。

## 证据分区

发现、关联、已对账、信号能力是四个独立集合。anchor存在不能直接等于covered；被filter的anchor不能消除运行意图unknown。PID/taskId不能作为唯一关联身份，build/epoch/generation/run冲突保留缺证。

`confirmed = 必要扫描完整 AND 已知运行事实全对账 AND 无unresolved`；过滤后空集不是证明。binding/ledger缺失不能抹掉anchor。可信foreign可排除、不signal且不能覆盖本次意图；声称foreign/损坏/不可信不能等同证明foreign。ENOENT仅在该层契约允许且无相反事实时为空；EACCES/ENOTDIR/schema/预算截断/枚举后读失败均degraded向总体传播。不能可信绑定的anchor可阻断全部退出，但不授权signal。生产历史PID保持零终止信号。

核每层home/epoch/anchor/v2-store/ledger扫描、adapter过滤/covered生成、cancel/shutdown/session/rebuild及清理/DTO消费。dead-anchor正例必须证明实际执行退出核验；unknown必须同时阻新launch、阻删home、零signal。

## 停机准入

实例单向open→closing→closed；shutdown在任何await/快照/扫描前同步撤准入租约，并发shutdown共用收口。所有可能启动/写入/提交操作在首个await前登记inFlight并捕获租约；readiness/锁/恢复扫描等待也属于在途。

最终落库/入列/spawn/CURRENT前同步核同一租约。关闭后不能把操作从集合抹掉假装收口；取消/等待/安全收尾仍须证明，超时如实unknown。`quiesced = 准入永久关闭 AND 在途不再可能写/启动 AND OS事实对账通过`，不只OS快照空。

CURRENT前关闭拒绝提交；CURRENT后不粗暴回滚，DB/状态收尾仍计入等待。核create/resume/rebuild/retry/auto续跑/manual publish及迟到回调。HTTP close顺序不能代替服务层lease。

## 合并验证

重放原探针，再补：声明装配await+旧状态/授权变化；恢复扫描degraded+shutdown；发布锁排队+shutdown；CURRENT后安全收尾；readiness迟到释放后不再入列/启动；timeout/重复shutdown；普通运行合法正例。纯feature候选验证，不依赖原用户WIP护栏。R2本批约定只做一次增量复审；原full的4Major修复完成后再派。
