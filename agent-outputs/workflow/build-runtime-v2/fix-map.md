# full Gate 统一修复批（原编号保持）

## 当前终态：已知审核发现全部闭合

主上续令后，最后R2-F10-02 scanner/schema补齐：固定home/task可见损坏不丢事实、execution/processState闭合、终态不代替OS退出、PID整数范围及Native boot成对schema。独立增量d62dfd56已accepted，**VERDICT=PASS，四类全closed、0新增finding**；与前轮14closed合并，原F01–F15全部closed（所列代码覆盖层，不是所有设计/平台验收）。报告`final-scanner-review.md`，初次FIX保留`final-scanner-review-initial.md`。

最终全量同原断言/timeout、仅串行文件：lint/typecheck、前端519/server3080通过、16skip、build通过；纯feature编译/构建、204定向/34真实原生通过；独立89项producer/矩阵/关联取证通过。候选SHA256=33d9919363a8be40fb06587c965c3d7c2aa8285f905e4e1fab04f25bcddc80d4，用户原12+2不纳入提交。legacy默认、A23六源/Windows/setsid/全FS TOCTOU/真实模型质量边界维持，不虚构通过。

## 历史R2唯一增量：FIX（保留失败）
1b5f488c审核产物已accepted：原4Major关闭3项，R2-F10-02仍partial/Major；原F01–F15累计14closed/1partial。四类同根因损坏schema仍被误作退出：home非目录、UUID task位置file/link被filter、未知execution被当终态、小数PID/PGID伪证退出。见`r2-incremental-review-report.md`及incremental-*原证据。自检3007与独立172通过不能排除这些反例。按约定上报，不自动再开循环；未提交完成候选，待裁决。

原 Gate：eec182a8，review-report.md，VERDICT=FIX（13 Major/2 Minor）。唯一增量7fa31cae已完成并接受审核产物，**VERDICT仍FIX：9 closed/5 partial/1 open，7 Major+1 Minor未闭合**。随后主上明确授权继续修复至闭环；当前进入R2整批修复与新Gate，历史审核结论保留。A23仍阻塞，legacy默认不切换。

## R2新full Gate：FIX（优先于下方审前实现记录）

8ab9e825审核产物已接受；13closed/2partial（F03/F10），4Major：旧族移出/删除漏核授权；unbound锚点被coverage+filter空组合误判confirmed；内层scanner读失败吞空；shutdown未封闭在途准入。证据见`r2-review-report.md`及`r2-review-evidence/`。三切片3aa28cce/dd537581/39495c8e已并行修完整影响面，集成后仅做本R2一次增量复审。当前不提交完成版本。

## R2审前集成记录（绿测不覆盖上述反例）

- F03：完整DeclarationAuthImpact在最终同步提交段重核，族/旧canonical授权撤销反例已回放修复。
- F11：v1复制入release，提交前永不移走唯一草稿；拒租约后原字节保留。F14：Leader/子任务按各自真实工具面给示例。
- F12：移除递归/发现入口，native文件仅冻结信封根；词法+真实落点双判。Leader新增SDK路径别名/Unicode空格/Windows非规范分量拒绝，并禁止不存在read目标触发SDK候选路径回退；正常skill/工作区读取、报告写入与MCP通道保留。
- F09/F10：同epoch旧代次不挂idle；根死同组成员保持unknown；R0→M0(候选)→C0→M1→M2→C1→R1封存链+私有session前提；生产历史PID零信号；所有旧事实/不可读账本重新对账后才可新launch。
- 关闭竞态：真实写者为Pi auth-storage；不能以pipeline完成或rm成功当OS quiescence。R2已补shutdown对unconfirmed的结果传播，以及测试/探针保留未确认现场，禁止继续删除潜在活写者目录；整体扫描失败即便active为空也拒绝清理。
- 已集成静场`npm run check`：前端519/server2934通过，16跳过；`build:all`通过（`/tmp/feishu-build-v2-r2/{check-integrated-r2,build-integrated}.log`）。最终修正已复验：check519+2948/build、原生123、纯feature编译/构建+284及原生34通过；新Gate仍待裁决，不预先标closed，见fix2-integration-report.md。

## 历史R1审核结论（不被实现自检覆盖）

- closed：F01/F02/F04/F05/F06/F07/F08/F13（仅代码层）/F15。
- partial：F03（族/旧canonical提交授权租约）、F09（同epoch旧代次挂idle）、F11（v1提交前拒租约删除唯一草稿）、F12（祖先递归grep跨deny读禁区）；另F14 Leader示例误用不可达mcp_call外壳为Minor。
- open：F10，3个Major：根退出遗漏同组孤儿而假confirmed；根归属失效仍给无关成员发信号；没有termination记录的rebuild跳过旧运行对账。
- 每项复现/影响/建议见`incremental-review-report.md`，临时证据`/tmp/feishu-build-v2-incremental-review/`。该轮修复候选当时未作为完成版本提交；R2续修已获主上授权，后续以新整批Gate裁决，不改写本历史结论。

## 实现/集成留档（不等于Gate闭环）

| Finding | 责任/句柄 | 集成验证记录（审核前） | 验收目标 |
|---|---|---|---|
| F01 取消在途写 | Tools 27b5d076→b18dd149 + Leader | 已合主树，定向过 | ctx撤租最终检查；审查凭据锁内再核ctx/actor/代次/发布窗口，拒绝迟到回写 |
| F02 pending MCP缓存 | Integrity 65a04158→b02b4e4b | 已合主树，真实连接及迟到确认过 | list_changed + 快窗后低频退避续看；401/stdio关闭停止，不能永久只读 |
| F03 对象/族所有权 | Tools | 已合主树，定向过 | clientKey/三元组夺取拒绝；显式旧路径/族授权迁移仍可用 |
| F04 exact_text丢同行 | Tools | 已合主树，定向过 | 行内/跨行前后缀完整，声明坐标正确 |
| F05 死cursor | Tools | 已合主树，定向过 | 每页预算重置，cursor-only契约可用，全遍历终null |
| F06 编辑并发/丢回执 | Tools b18dd149 | 已合主树，定向过 | 锁内重放；calls稳定语义payloadHash；丢receipts后异payload/path冲突，旧无hash拒绝 |
| F07 默认actor报告被忽略 | Publish 22c29fc4→f0bdac8d | 已合主树，真实发布过 | 默认unitId省略、多reviewer权威回执进生产候选 |
| F08 对象machine-review/依赖 | Publish | 已合主树，定向过 | objects/claims/readReceipt发布；正文/声明/快照/规则漂移阻断；规则未知fail-closed；manual冷实例同authority |
| F09 rebuild复用内部库 | Runtime 4245961b→d78fa303 | 已合主树，真实故障链过 | 新epoch/home/session；旧actor不计活跃；session真续与rebuild分开 |
| F10 硬崩残留/丢终止结果 | Runtime + Leader裁决 | 已合严格版；保守阻断边界待审核 | 每信号前birth fresh证明；未知不发信号、不假confirmed；queued无锚点也保留unknown，详下 |
| F11 取消/超时与CURRENT | Publish f0bdac8d | 已合主树，定向及真实API过 | 提交点ctx租约/timeout；manual DB租约；精确本build CURRENT/manifest归属，不认他build指针 |
| F12 派发时完整性缺检查 | Integrity→357fca76 | 已合主树，真实Leader负例过 | 四配置/policy/包/冻结skill实文件核验；启动后删改skill/policy/config阻断，无child模型请求 |
| F13 Windows路径必拒 | Integrity | 已合平台路径语义；Windows未测 | path.isAbsolute按宿主平台；Windows进程出生证明不可用时fail-closed，不宣称真机通过 |
| F14 skill错误示例 | Publish | 已合主树，六资产schema验证过 | 所有JSON示例真实契约；skill hash进入派发冻结面，旧规则会话拒绝 |
| F15 假并发/历史轮次0 | Leader前端+Runtime后端 | 主树单测/真实浏览器过 | 终局仅末次观测并发；历史epoch/代次排除；rounds未知不伪0；终止未确认不可标已停止 |

## 主树集成与证据

- Tools/Publish/Integrity/Runtime按方法面三方合并；没有用兄弟整文件覆盖。`authorityLease`整对象透传、epoch dirs传入integrity refs、DTO新增字段均已集成。用户原12修改+2未跟踪继续保护，不属于本阶段提交。
- 主树Tools+Publish定向：6文件129例通过（随后审查锁内权限矩阵由1例扩为4例，最终全量日志为准）。ctx撤租/对象权限/并发幂等/真实知识声明与发布门禁覆盖。
- 主树 `npm run typecheck`、`npm run build:all` 通过；真实原生链：3文件34例通过（fix-e2e 6、原e2e 3、integrity 25，包含其导入的契约用例，不作独立用例数相加）。日志 `/tmp/feishu-build-v2-baseline/fixes-native-e2e.log`。
- 新epoch下完整原生工具面probe：35pass/0fail，exit=0，日志 `merged-live-probe.log` / `merged-live-probe-report.md`（同临时证据目录）。确认codemode-facet仍hidden+rejected且不可发现桥，取消终止核验confirmed。
- 浏览器追加轮2：真实published；历史并发/轮次真值/无百分比/真实unconfirmed告警均核验，见 `ui-real-api-acceptance.md` §七及shot-19/20；没有伪造DTO。
- 首次全量check：前端/lint/typecheck过，server 2882pass/1fail/16skip；唯一失败为用户既有metadata-shell夹具3s子进程超时。原样单文件诊断37ms通过；不改用户文件、不加大其timeout，等并行原生验证结束后静场重跑，最终日志 `fixes-full-check-final.log` 为准。

## F10 最终保守裁决（必须保留）

- UI正常published出现4个pid未知项；真实数据为queued/not-started、无startedAt/backendRunId。`0469e24a`调查确认此形态也覆盖native spawn→同步锚点/started提交前的硬崩微窗口。
- **拒绝采纳**0469e24a的“queued/not-started即从未spawn”排除补丁：同一记录形态不能排除上述孤儿窗口，ps为空也不能替代出生/退出证明。主树仍是d78fa303严格版；该子任务接受轴rejected，研究证据有效但代码不回流。
- 因此正常退出也可能保守unconfirmed；这是可用性限制，不是已发现活进程。UI如实告警；同build恢复先重新对账，未确认不启动新Leader。不得以成功发布或进程列表为空改写confirmed。
- 不改amagi上游、不加应用调度器。若要求消除该窗口且自动解除unknown，需要额外可信的原生pre-spawn/内核级证明机制另行决策；本批不隐含提供。
- Windows真机、setsid逃逸孙进程、A23六源性能/质量对照仍未验证；fixture/GLM最小烟测都不冒充这些证据。
