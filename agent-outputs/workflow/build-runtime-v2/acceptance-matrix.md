# 设计 v2 验收矩阵

## 当前终态：已知审核发现全部闭合

主上续令后，最后R2-F10-02 scanner/schema补齐：固定home/task可见损坏不丢事实、execution/processState闭合、终态不代替OS退出、PID整数范围及Native boot成对schema。独立增量d62dfd56已accepted，**VERDICT=PASS，四类全closed、0新增finding**；与前轮14closed合并，原F01–F15全部closed（所列代码覆盖层，不是所有设计/平台验收）。报告`final-scanner-review.md`，初次FIX保留`final-scanner-review-initial.md`。

最终全量同原断言/timeout、仅串行文件：lint/typecheck、前端519/server3080通过、16skip、build通过；纯feature编译/构建、204定向/34真实原生通过；独立89项producer/矩阵/关联取证通过。候选SHA256=33d9919363a8be40fb06587c965c3d7c2aa8285f905e4e1fab04f25bcddc80d4，用户原12+2不纳入提交。legacy默认、A23六源/Windows/setsid/全FS TOCTOU/真实模型质量边界维持，不虚构通过。

## 历史裁决：R2唯一增量FIX（保留失败）

1b5f488c：14closed/1partial（F10），剩1个Major R2-F10-02：home非目录、UUID task位置file/link、未知execution、小数PID/PGID仍可假confirmed并允许清理。A17/A18/A24及ENOTEMPTY整体承诺不能关闭；A26产品Gate未通过。按既定规则上报，不自动循环、不把候选作为完成版本提交。见`r2-incremental-review-report.md`。

## R2审前/阶段记录（不覆盖最新裁决）

原7 Major+1 Minor及关闭竞态已集成修正：最终check519+2948/build、真实原生123、probe36/0；剔除用户WIP的快照编译/构建+284及原生34通过。退出unknown时真实保留home，未把流水线完成/rm成功当OS quiescence。新整批full Gate **8ab9e825=FIX，13closed/2partial、4Major**；旧族移出/删除、缺绑定锚点、内层扫描失败与关闭准入仍待补齐，三切片正在修复。详见`fix2-integration-report.md`与`r2-candidate-feature.patch`。

A23仍外部阻塞，Windows真机/setsid与真实模型质量不虚构；legacy默认不切换。

## 历史R1矩阵（保留原失败，不覆盖证据）

原轮Gate：**7fa31cae = FIX**，原F01–F15为9 closed/5 partial/1 open；7个Major及1个Minor。审核产物已接受，产品Gate当时未通过；随后主上明确授权R2续修。

`met`仅指所列覆盖层的证据，不等于整体验收/上线/性能达标。真实fixture、GLM最小烟测、性能质量基准严格分列。详细反例见 `incremental-review-report.md`。

| ID | 设计 | 验收行为 | 当前状态/证据与阻断 |
|---|---|---|---|
| A01 | 3.1/13.1 | 专用home、固定包/hash、配置禁读写 | needs-fix F12-R1：四配置/policy/包/skill完整性已接通，但真实child递归grep从祖先跨deny泄漏合成sentinel；不能用直接read拒绝证明围栏完整 |
| A02 | 3.2 | 静态zhipuai、env key、无PI凭据、未知映射拒绝 | met（声明覆盖层）：contracts/environment与GLM5.3-flash 17项最小通道烟测；不代表全部profile |
| A03 | 3.3 | 精确应用MCP、readOnlyHint、无可调用codemode/tool_search | met（工具面）：F02closed；同连接迟到刷新由真实Pi MCP客户端独立复核；禁用facet不可发现桥/强制调用拒绝；非OS沙箱 |
| A04 | 3.4 | Leader白名单与实际工具面一致、无正文/内置工具 | met（实际白名单）：native probe声明+执行阻断；F14-R1的文档仍错误示范Leader用mcp_call，不额外放宽权限 |
| A05 | 3.4 | 改参进入native冻结契约、越界角色/模型拒绝 | met（冻结参数链）：918a4d13及probe真实v2-store证据；不表示被委托文件围栏无递归漏洞 |
| A06 | 3.5/6 | 唯一skill、Leader系统规则、自动行为冻结计数 | partial：实际skill hash已冻结；F14-R1 Leader示例外层工具不可达；完整自动行为计数仍未验收 |
| A07 | 3.6 | 仅amagi调度、模型池≤K、Leader应用一槽 | partial：原生probe池上限/串行、主链单槽、d21双作者并行证据；非六源吞吐结论 |
| A08 | 4.1 | native创建与env身份一致、pending只读、错角色拒绝 | met（身份/动态面）：F02closed；同一真实MCP连接延迟确认新增写工具、撤销拒绝；业务授权专项通过 |
| A09 | 4.2 | 唯一分配/冲突/先撤旧/续接继承 | needs-fix F03-R1：装配期对象/族归属已校验，await后族/旧canonical影响面授权未终检，Leader转移族后旧作者仍能提交 |
| A10 | 4.3 | 非作者/续接链独立审查、精确依赖hash | met（结构授权层）：F07/F08closed；默认actor报告、多reviewer、四依赖、对象凭据与manual冷恢复；不是内容语义质量认证 |
| A11 | 4.4 | 幂等同载荷重放、异载荷拒绝、换代迟到拒写 | partial：F01/F06closed，ctx/actor/代次/发布窗口及calls语义hash已验；完整对象授权租约仍受F03-R1阻断 |
| A12 | 5.1–5.3 | 冻结/图片缓存、材料清单、交接回读、局部审查失效 | partial：共用流水线/缓存恢复与单源链已有证据；完整图片实景与六源未测；v1发布拒租约后草稿丢失见F11-R1 |
| A13 | 5.4 | agent_end非结束、后台通知、自触发/leader_idle | needs-fix F09-R1：session同epoch换generation后旧actor仍挂后端idle；UI已排旧代次但后端未统一 |
| A14 | 5.4 | 候选锁定、阻断清零、原知识门禁/原子CURRENT | needs-fix F11-R1：CURRENT提交点租约及精确指针对账已修，但v1先rename唯一docs、租约拒绝再清理导致已接受草稿丢失 |
| A15 | 7 | 局部编辑继承/定位/结构化冲突、批读预算游标 | met（编辑/读取机制）：F04/F05/F06closed，字符区间/坐标/同键并发与cursor-only真实用例；总体写入权限仍另受F03阻断 |
| A16 | 8/9 | checkpoint保留成果/审查/问题/分配、三轴分离 | partial：epoch/rounds/终止记录已持久；F11草稿丢失及F10缺终止记录的rebuild绕过对账未闭环 |
| A17 | 9 | 先撤凭据、stdin/10s宽限、残留/PID所有权、无双Leader | needs-fix F10-R1/R2/R3：根退出遗漏同组孤儿；根归属失效仍误发成员信号；无termination记录的rebuild不查残留 |
| A18 | 9 | 同会话/成果级恢复、包变更不复用内部状态 | needs-fix F09/F10：新epoch/home/session及真实session续接已过，但同epoch旧代次idle与缺证rebuild仍失败 |
| A19 | 10/13.5 | Claude-native未验收拒绝、旧checkpoint legacy、无静默fallback | met（模式策略）：显式模式/持久化/未知模式拒绝；不等于新模式恢复安全通过 |
| A20 | 12 | 真实任务/成果/问题/当前计划、未知不伪造百分比 | met（UI语义）：F15closed；组件25例+真实published/unconfirmed浏览器，无百分比、历史并发/轮次unknown；后端假confirmed另属F10 |
| A21 | 12/13.1 | 用量/自动行为/时延来源区分、不重计父子 | partial：末次SDK用量、累计/子任务unknown口径正确；更细自动计数/成本/性能仍未验收 |
| A22 | 13.2 | 真实API：1Leader+2并行作者+独立审查+候选提交 | partial：真实API单作者+reviewer、d21双作者重叠及probe；修复批正向链不能抵消F03/F10/F11反例 |
| A23 | 13.3 | 同六源/模型/32768/并发6/热图片三次对照，中位≤20min | blocked：仅4/6冻结字节可得，2份sheet缺失、无批准夹具；未跑对照，不宣称20分钟/质量达标 |
| A24 | 13.4 | 丢回执/迟到/取消/崩溃/升级/转移/恢复/发布并发故障链 | needs-fix：7个Major隔离反例已复现；不能以34 native用例本体绿替代这些竞争窗口；最新suite还发生afterAll ENOTEMPTY |
| A25 | 13.5 | 保守legacy默认、不删旧调度、不静默降级 | met（默认/降级策略）：仍legacy默认，未自动fallback，Claude-native拒启；不声称失败必保留草稿（F11） |
| A26 | 项目约定 | check/build、浏览器交互、用户改动保护、阶段提交 | blocked Gate：静场主树check519+2886过/build过、纯feature148过，最新native34本体过但suite清理失败；初始12+2保留，修复候选未作为完成版本提交 |

## 交接边界

- `fix-integration-report.md`记录合并、纯feature去用户WIP验证、首次3秒shell启动超时与静场全量通过；失败原日志保留，未改用户timeout。
- 纯featureprobe另有35pass/0fail（`/tmp/feishu-build-v2-baseline/feature-only-probe/`），与独立祖先递归探针泄漏反例可以同时成立；断言覆盖范围不同，不以总数豁免。
- F10 queued/not-started/无锚点仍严格unconfirmed，未采纳0469e24a放宽补丁。正常收尾保守阻断是已接受边界，不是本轮3个F10 Major的替代解释。
- Windows真机、setsid逃逸孙进程、真实质量/六源性能仍未测；F10-R1为普通同组孤儿，不属于setsid豁免。
- 增量审核7fa31cae产物已接受，VERDICT FIX；不再自动派发修复或第二次复审，等待主上裁决。
