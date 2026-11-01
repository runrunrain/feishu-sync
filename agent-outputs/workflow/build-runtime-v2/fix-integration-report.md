# 统一修复批集成验证

状态：唯一full增量复审7fa31cae已完成并接受审核产物，**VERDICT=FIX**（7 Major + 1 Minor未闭合）。原编号9closed/5partial/1open；产品Gate未通过，按约定停止自动修复/审核循环，等待主上裁决，修复候选不作为完成版本提交。

## 集成内容

- F01/F03–F06：撤租终检、对象/族授权、exact_text字符区间、游标分页预算、语义幂等hash与旧账本拒绝盲重放。
- F07/F08/F11/F14：权威审查回执进入候选；正文/声明/来源/规则依赖核验；machine-review凭据回写；自动/手工提交点租约及精确CURRENT归属；六skill资产契约。
- F02/F12/F13：同连接MCP工具面变化通知；快窗后退避续看迟到确认；实际四配置/policy/包/冻结skill文件完整性；宿主平台绝对路径语义。
- F09/F10/F15：新epoch/home/session；generation/runtimeEpoch/launchId分离；每个信号前新鲜birth证明；结构化终止结果持久化及恢复阻断；旧epoch/代次任务留档但不计当前并发；未知轮次不伪0。
- Leader补接缝：审查凭据也是写入，声明锁内重检ctx/actor/代次/发布窗口（4场景）；draft_read编辑哈希与返回正文同次字节快照；前后端新增termination-unconfirmed DTO贯通。

## 验证记录

| 验证 | 结果 | 原始证据 |
|---|---|---|
| 主树静场 `npm run check` | exit0；前端77文件519例、server189文件2886例/16skip（随后仅新增一个strict queued缺口测试，见纯feature验证） | `/tmp/feishu-build-v2-baseline/fixes-full-check-final.log` |
| 主树 `npm run build:all` | exit0，含server资产/MCP/CLI打包 | `fixes-full-build-final.log`（同临时目录） |
| 显式amagi源的真实原生故障链 | 3文件34例过：fix-e2e6、原e2e3、integrity25（含导入的contract用例） | `fixes-native-e2e.log` |
| 新epoch完整原生工具面probe | exit0；35pass/0fail；取消对账confirmed；codemode-facet仍hidden/rejected/不可发现桥 | `merged-live-probe.log`、`merged-live-probe-report.md` |
| 真实浏览器 | published；pi-amagi/无百分比/末次观测并发/真实轮次/unconfirmed警示；零伪造DTO | `ui-real-api-acceptance.md` §七，`/tmp/feishu-build-v2-ui/shot-19.png`、`shot-20.png` |
| 去除全部用户WIP后的feature-only快照 | 根/server typecheck过；7文件148例过，包含审查4租约矩阵及strict queued缺口反例 | `/tmp/feishu-build-v2-baseline/feature-only-check.log` |

首次全量有一个用户原有metadata-shell夹具的3秒子进程超时；原样单文件诊断37ms通过。未改用户测试/timeout；等并行原生任务结束后上述静场全量通过。保留首次失败日志 `fixes-full-check.log`，不把失败隐藏成首次全绿。

真实原生链和浏览器首轮在最后新增的审查锁内actor/代次/发布窗口重检前执行；重检复用既有前置授权，后续完整check及纯feature148例覆盖其正负路径。最新纯feature真实链已重跑：34/34用例本体过（含published/硬崩/恢复/完整性），但suite exit1：fix-e2e afterAll第373行删除临时home出现ENOTEMPTY，尚未归因，不能写成最新suite全绿。原始日志 `feature-only-native.log` 已交增量审核核实关闭quiescence/临时清理接缝，不盲重跑或加大重试掩盖。没有把未重跑的远程模型性能/质量冒充本批证据。

## 用户WIP与可提交快照

- 初始12个修改文件与2个未跟踪文件保持在工作树，不提交用户改动。
- 初始用户快照为43c35e71（dirty snapshot，含用户改动），原基线aa13b34；`initial.patch`记录用户差异，不能重复套到43c。
- 临时index：`/tmp/feishu-build-v2-baseline/final-feature.index`。对共享五文件反向剔除initial.patch；agent-tool-service做三方剔除，保留本批draft_read单读hash，保留用户的声明读取扩展在工作树而不纳入本阶段commit。
- 纯feature源码快照：`/tmp/feishu-build-v2-feature-tree/`（无用户新model-output-limits模块）；阶段patch：`/tmp/feishu-build-v2-baseline/final-feature.patch`。独立编译与148例证明本批不依赖未提交用户代码。
- 当前主index只有此前本批kb-knowledge-tools小hunk；独立审核通过后才统一形成阶段提交，不自行夹带用户12+2。

## F10 严格边界与拒绝的补丁

真实UI正常published后4条queued/not-started意图无PID/锚点，因此保守unconfirmed。0469e24a提出把此类记录视为从未spawn，但同时确认native spawn→锚点/started提交间硬崩也可能留下同一形态。Leader拒绝该补丁（接受轴rejected，代码未回流），主树继续严格阻断；新增对应反例，不能凭空进程表或缺PID假confirmed。

这意味着正常收尾也可能未确认；它不等于发现活进程，但自动恢复受阻。只有重新对账获得可信退出事实才可放行。消除原生微窗口需要更强pre-spawn/内核级证明另行决策，不借本批改amagi上游，不降级pgid/Node命令名误杀。

## 未覆盖

A23六源冻结夹具/性能与质量对照仍外部阻塞；Windows真机未测；setsid逃逸孙进程不在现有锚点/组员回收面；真实模型仅此前17项最小通道烟测，不代表质量/性能。legacy仍默认，新路径不静默fallback。

## 最终Gate与交接

唯一增量报告 `incremental-review-report.md` 已accepted，产品仍FIX。7 Major：F03对象/族影响面最终授权缺租约；F09同epoch旧代次挂idle；F10根退出遗漏同组孤儿、根归属失效仍误信号、缺termination的rebuild跳过对账；F11 v1拒租约后删除唯一草稿；F12真实child从祖先递归grep越过deny读取合成禁区sentinel。另F14 Leader示例错误使用不可达的mcp_call为Minor。

上述反例与绿测试可同时成立；失败不是靠增加测试数量就能豁免。真实证据保留在 `/tmp/feishu-build-v2-incremental-review/`。后补纯feature完整原生probe35pass/0fail（`feature-only-probe/`）也只证明其断言范围，不抵消祖先递归反例。ENOTEMPTY现场最终残留SDK auth.json（2bytes，审核未读内容），具体写者/时序未闭合，不据此直接认定某个F10反例为其根因。

执行已停止，无新的修复任务/复审。主仓候选、临时feature-only index/tree/patch与用户12+2均保留；下一批实施及新的验收阶段需主上裁决。A23/Windows/真实质量仍不可宣称通过。

持久交接：冻结候选patch另存本目录`candidate-feature.patch`（相对25cc0b4，未通过版本），关键复现脚本/小日志原样副本在`incremental-review-evidence/`，含SHA256SUMS与执行安全说明。原63KB完整事件JSON仍在临时目录；没有复制历史PID文件，不自动执行OS脚本。此归档不构成修复、再审核或完成提交。
