# F09/F10 修复方向基线（Leader采纳边界）

来源：独立review-report F09/F10，Advisor advisor-c11fd424（建议，不是验证结论）。不改amagi上游、不加应用任务调度器；进程所有权观察/回收不是业务调度。

- 分开 `generation`（写租约）、`runtimeEpoch`（Pi会话/amagi内部库边界）、`launchId`（每次进程启动）。成果区域独立；binding持久epoch/sessionDir/launch/终止状态。
- session恢复：冻结包、配置、规则相容且旧进程收敛才复用原epoch/session。rebuild：总是全新epoch/agentDir/work/sessions/sessionId，不能通过固定`--session-id build-${id}`打开旧会话，不复制旧amagi内部库/对话；仅导入可验证成果/问题，审查需精确依赖仍匹配。旧actor只作历史，不计新活跃集合。
- 受信原生创建/v2-store runtime可作发现线索，但进程归属还须OS出生身份、boot身份、可执行/参数指纹、所属运行/父链交叉核验。账本在模型禁区且不包含key/整份env；覆盖创建事件未处理即硬崩窗口。
- 正常stdin关闭后10s宽限；Leader已死仍核查child/桥。不能仅裸PID/kill(-pid)/递归taskkill，PID与PGID可复用。推荐受信registry+宿主身份证明为基础，独立进程组/Job辅助；若无足够证明，不冒险杀进程，持久termination_unconfirmed并阻止第二Leader（换epoch也不能绕过）。不要声称Node PID检查等于稳定内核handle或OS沙箱。
- Advisor高保证建议：POSIX原生出生身份/Windows稳定process handle+Job Object；CIM适合发现诊断，不替代稳定handle。实施需在现项目约束内选择最小可验证机制，不能为通过测试引入未验证本机native依赖；能力不足明确拒绝/未确认，不能安全假通过。若采取不同务实方案，报告精确保证、残余竞态与不可证明时行为，交独立复审裁决。
- cancel/finish/应用重启统一消费并持久 `TerminationResult`，不能catch终止错误后清掉唯一句柄，也不能非requestCancel终局丢结果。业务发布终态和进程清理状态分开；CURRENT已提交时后置取消不得说未发布或回滚CURRENT。
- 硬证据：真实Pi Leader+长驻child/桥，SIGKILL Leader后回收或明确未确认且阻止重复启动；PID复用模拟不发信号；同会话真续/成果级新内部库；脱组/权限不足/创建前崩溃；旧actor不计活跃。不能拿正常stdin退出或fixture发布代替。
