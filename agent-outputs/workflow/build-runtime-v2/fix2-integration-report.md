# R2整批集成与验收记录

状态：本报告为R2审前候选的实现/自检记录；8ab9e825新full Gate已判FIX，13closed/2partial、4Major，见r2-review-report.md。绿测与这些反例可以同时成立；下列修复声明不能替代Gate。后续三切片正在补完整授权、缺证传播与关闭准入，再做本R2唯一增量复审。原R1结论不改写。

## 修复与关键裁决

- F03：DeclarationAuthImpact完整捕获族与跨canonical迁移；异步准备结束后的最终同步段重核全部授权，随后无await触盘。原族撤销反例：`fileWritten:false`、无回执。
- F11：v1复制草稿入release，提交前保留唯一原件；撤租约后staging/acceptedDraft仍在，release/CURRENT均未产生。F14区分Leader直达应用工具与子任务MCP外壳，示例经真实schema验证。
- F12：禁用codemode/发现/递归工具；native read仅冻结skill同目录和任务workDir，write/edit仅报告根；词法+真实落点（最近既存祖先）双判，dangling/EACCES拒绝。正常skill/work读取、嵌套报告写入和MCP桥均有真实正例。
- Leader追加SDK语义修复：拒绝会被Pi二次解释的`@`、`~`、file URL、特殊Unicode空格、Windows shell盘符便捷输入；Windows设备名/ADS/非规范尾点空格拒绝。调用方应使用普通绝对/相对路径。read原目标须存在且F_OK可确认，禁止SDK缺失文件候选回退到另一条完整路径。真实Pi强制@/file URL读取未返回外部合成正文。
- F09：idle活跃任务统一generation+epoch；同epoch旧代次保留为历史但不阻止收尾。首次fresh不再被误加代，generation从1开始。
- F10：根死亡但同组成员仍存活→unconfirmed，零信号；封存链R0→M0(仅候选)→C0→M1→M2→C1→R1，另核私有session前提。同PGID本身不是授权。生产无稳定自有引用的历史PID不发终止信号；注入回收正例不冒充生产能力。
- 所有旧运行事实跨epoch重新对账；缺termination、探针失效、账本/目录degraded均不能被当成无旧进程。queued/not-started无锚点仍严格unknown，不采纳046放宽方案。
- Leader补应用侧spawn窗口：调用rpc.start前原子持久化pid=0/launchState=intent；成功后同launchId登记PID。断流遗留意图阻断新Leader与目录清理，不凭“未登记PID”推断从未spawn。账本条目结构不完整也degraded，不静默丢掉旧事实。

## ENOTEMPTY根因与诚实收尾

真实写者为Pi auth-storage惰性创建auth.json；pipeline完成、业务cancelled、HTTP关闭、rm成功都不等于OS quiescence。原“rm成功后仍重建，因此无害/已关闭”的结论已撤回。

- KbBuildService.shutdown等待流水线，并合并内存与持久锚点/账本新鲜对账；整体扫描不可得即便active为空仍quiesced=false。
- shutdownServices返回报告；生产close只记录未收口并保留运行目录，不新增历史PID扫杀。
- e2e只有quiesced===true才删除home；unknown保留并打印`[kept-home:shutdown-unsettled]`。最新主树和纯feature原生套件均实际触发保留分支，未以“测试绿”冒充所有进程已退。
- 独立probe cleanup同样检查CancelResult.termination.state，unknown/对账异常保留目录，且cleanup幂等。正式probe最终仍有未知事实时明确记保留；早先观察时点的无残留检查不替代最终确认。

## 验证

所有资料、FEISHU_SYNC_HOME、HOME、agentDir均为临时fixture。正式资源固定pi1.4.0的声明bin `dist/bundle/cli.js` + 冻结amagi-pi2.21.31（SHA256 `9485dd95c004f6962b89638fc39c868e5ae8f2069b51e45742525ba80d9251ab`）；不改2.21.32演进工作树，不升级pin。

| 检查 | 结果 | 日志（均在`/tmp/feishu-build-v2-r2/`） |
|---|---|---|
| 主树静场npm run check | exit0；前端519、server2948通过；server16跳过 | check-final.log |
| 主树build:all | exit0；前端/server/agent资产/独立MCP与CLI | build-final.log |
| Runtime+shutdown定向 | 4文件104次执行通过 | shutdown-and-launch-final.log |
| 真实Pi/amagi/API/工具信封 | 6文件123次执行通过；unknown现场真实保留 | native-final.log |
| 正式真实子任务/MCP probe | 36pass/0fail/10not-measured，exit0；最终未知则保留home | probe-confirmed-cleanup/report.md、probe-confirmed-cleanup.log |
| 纯feature typecheck/build | exit0 | feature-typecheck.log、feature-build.log |
| 纯feature定向 | 11文件284通过/4显式资源skip | feature-unit.log |
| 纯feature真实原生链 | 3文件34次执行通过；未确认home保留，不再ENOTEMPTY假红/清理假绿 | feature-native.log |
| 原反例对主树重放 | 族撤租拒写；v1拒租保字节；同组孤儿unknown；根换人零信号；缺终止rebuild重试9次仍阻；旧代idle收尾 | root-probes/*-final.log |

计数为用例执行次数（部分测试跨文件导入契约），不包装成独立场景数量。fixture不是LLM质量或性能证据。

## 用户WIP隔离与交付

- 纯feature由R1纯index + 相对R2 dirty-snapshot的代码delta三方装配，不覆盖工作树共享文件；独立目录`/tmp/feishu-build-v2-r2/feature-final`不含用户12修改+2新增模块。
- feature与当前全工作树的代码差异仍仅原14路径；`user-remains.patch`记录残余，初始非共享8路径保持原字节。共享draft_read的注释/格式交界随用户增强保留，不夹入本批提交。
- 最新纯提交候选`/tmp/feishu-build-v2-r2/final-feature.patch`，临时index `feature.index`。主树原有暂存区未被临时index操作覆盖。
- Runtime增量补丁的新文件段缺@@头，git apply未创建专项测试；Leader已回源核对后仅复制该新增测试，并补整体扫描/账本schema用例。原补丁保留作交付记录，最终以实际集成diff与测试为准。
- ESLint排除报告/不可改写的原始反例归档（agent-outputs），保留其SHA256原字节；不修改归档脚本来伪造源码lint通过。应用src/server/tests仍完整检查。

## 边界

Windows真机/打包/UNC整链、setsid逃逸后代、真实LLM六源质量/性能A23仍未验证。2份sheet原夹具缺失，不能伪造。legacy继续默认；本批只闭合代码发现及如实报告的生命周期边界，不声称OS沙箱或严格零误杀，不因unknown保留就宣称发现了活进程。

回滚只用本批精确patch，并先`git apply --reverse --check`；禁止整文件checkout破坏用户WIP。审核通过前不作为完成版本提交。
