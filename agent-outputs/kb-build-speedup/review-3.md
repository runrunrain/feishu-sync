# 终轮增量复审：R1–R5

**结论：FIX。Critical 0 / Major 1 / Minor 0。** 原始五个反例及 review-2 的四个具体变体已获得修复证据；但 R1 的同一关闭逻辑仍可被英文未核范围绕过，不能签发质量门通过。

## 基线与边界

- 上游全文已读：`agent-outputs/kb-build-speedup/review.md`、`agent-outputs/kb-build-speedup/review-2.md`。
- 仓库 `/Users/run.mao/workpace/feishu-sync`；实际 HEAD `ceea273d7ea1d7693c1ce93b32e2dbd28c1b9041`。对象为当前未提交工作树，终轮增量复核，不扩为全仓审计。
- 真实 bash 动态执行；只新增本报告与同目录取证脚本/日志，没有修改项目源码或项目测试。所有 fixture 使用 `os.tmpdir()`；未触真实用户配置、SQLite、知识库或模型。

## 逐编号结算

| 原编号 | 结论 | 动态证据 |
|---|---|---|
| R1 | **原具体反例关闭；需求仍未关闭** | 原 uncheckedScope 直接指出 a.md 未核时，权威集合保留 `old,pass`；新英文变体仍误关闭，见 R1-B。 |
| R1-A | 中文混合句反例关闭，但同族问题未根治 | `除 b.md 外，全部文档的证据列位均未检查` → closure=false；不是仅凭静态关键词判断。 |
| R2 | 关闭 | 原附录同候选新 blocking 计数=1；指定测试同时覆盖真实标准模式工具链与同候选分歧。 |
| R2-A | 关闭 | 独立脚本 strict 清单 + fromReviewId 指向旧 needs_revision + 当前精确 pass → 计数=1；真实 selector 修订的 strict 变体测试亦通过。 |
| R3 | 关闭（原拒绝扣账问题） | 错 model 返回 `dispatch_model_not_frozen`，紧接修正请求 `decision='allow'`；不再误占空池。 |
| R4 | 关闭（所列别名） | 对 `getToolSpecsForToken()` 实际下发 schema 做 AJV 校验：raw_search/draft_search 的 queries、draft_read 的 docPath/paths、kb_tool_schema 的 tool 均接受。不是只测 normalizer。 |
| R5 | 原 JSON 膨胀反例关闭 | 90 行反斜杠原文两页无损拼接；最终 content 最大 16,894B，回执区间 [1,67]/[68,90]，哈希与实际返回窗口一致。 |
| R5-A | 关闭 | draft 正文14,000 ASCII + raw 单行5,000 ASCII，两请求分两页，raw 未跳过，回执精确覆盖 [1,1]。 |
| R5-B | 关闭 | draft 单行25,000 ASCII，两页码点分片完整重建；cursor 必推进，没有空页死循环，最大17,000B。 |

## Finding

### R1-B｜Major｜`server/src/kb/review-authority.ts:495,509–519,567`

- **触发条件：** 标准模式，a.md 有主体绑定的 needs_revision/blocking；候选声明已漂移，存在精确绑定新候选的独立 pass，scopePaths 包含 a.md、b.md，checkedDimensions 非空。pass 的 uncheckedScope 为以下任一合法自由文本：
  - `Nothing but b.md was checked`（仅 b.md 检查过，即 a.md 未核）；
  - `Everything besides b.md was not checked`（b.md 以外均未核）。
- **实际影响：** a.md 明确不在已核范围，但旧 blocking 被从权威报告集合剔除，发布侧不再看到该报告的阻断。此为前轮 R1/R1-A 修复直接相关的漏网路径，不是无因果关系的新全仓观察。
- **证据（已复现权威选择层）：** `review-3-probe.mjs` 末段分别构造两份报告，调用真实 `collectAuthorityValidatedReports`，两次均输出：
  ```json
  {"validReportIds":["english-pass"],"skipped":[{"reviewId":"old","reviewerTaskId":"independent-old","reason":"blocking_issues_closed_by_current_pass"}]}
  ```
  同脚本对直接 helper 的结果也为 `closed=true`。英文 `all documents except b.md were not checked` 对照返回 false，说明漏洞是自然语言枚举漏识别，不是候选/回执 fixture 不满足前提。
- **路径解释：** 剔除 b.md 后，上述英文不命中 GENERIC_EXCLUSION_TEXT（`every` 不匹配 `Everything`，也未识别 `Nothing but` / `besides`）；mentionsOther=true，遂把“提及其它路径”当成仅排除其它路径，最终 closed=true。a.md 正文和声明精确绑定并不能补足问题范围未复核这一事实。
- **最小修复方向：** 不再用有限自然语言关键词证明关闭范围。为未核范围建立结构化路径/问题绑定；过渡期非空且无法结构化证明不涉及该问题的 uncheckedScope 应 fail-closed。仅补这两个英文词组还会留下同义表达绕过。正式回归测试由实施者补齐。
- **复现：** cwd=`server/`，`node --import tsx --input-type=module < ../agent-outputs/kb-build-speedup/review-3-probe.mjs`。最后的 `REPRO_FALSE_CLOSURE` 断言的是实际错误状态，用于证明漏洞存在，不代表满足期望契约。

## 新反例尝试与覆盖

| 面向 | 实际尝试与结果 |
|---|---|
| 英文/空白/特殊字符未核范围 | 英文 all/except 被拒；上述两个英文句误放（R1-B）。零宽字符 `a.\u200bmd 未检查` 与单独零宽字符被保守拒绝；纯空格被当作无有效未核项，closure=true。纯空白本身不表达未核承诺，未另立 finding。 |
| CJK 分片 | draft 单行 `中汉字`.repeat(5000)，三页，最大16,999B；逐片 charStart/charEnd 连续、码点数相等，原串逐字重建通过。 |
| 四字节字符分片 | raw 单行 `😀𠮷`.repeat(5000)，三页，最大16,999B；无 U+FFFD、无漏重、cursor 推进；分片不登记整行证据回执，避免冒认已完整读取。 |
| raw_read 字节裁页/next_offset | 150 行混合 CJK、四字节字符、反斜杠/引号，实际九页：[0,18]…[126,18],[144,6]。每页最终 content≤19,500B，nextOffset=offset+returnedLines（末页null），回执覆盖1–150且 hash逐页吻合。 |
| raw_read 真超长行 | 25,000 ASCII首行 + NEXT，明确 oversized_line、returnedLines=0、nextOffset=1、无首行回执；下一页返回 NEXT 并结束。这不是 raw_read 自身无损：它明确跳行并引导改用 kb_read_batch；后者长行分片无损已另验。 |
| 事故主链 | 指定 vitest 中真实 AgentToolService/BuildActorStore/KbBuildService 链：selector-only修订 + 针对新候选完整pass → 发布门关闭；重登记同issueKey仍关闭。无复核/复核仍needs_revision/候选再变/同候选新blocking等负例均通过。 |
| 安全与并发范围 | 原角色独立性/发布门调用链由指定真实工具测试覆盖；未伪造生产模型身份认证。派发修正重试动态核实；未做池压力测试或新全仓权限审计。 |

分页脚本对所有成功页断言最终UTF-8 content预算、contentBytes一致、非空结果、cursor变化；按lineChunk坐标或整行offset重建正文，并对raw正常页的落盘回执ID、范围、returnedHash及新增回执数逐项核对。没有把局部内容字节数冒充最终序列化字节数。

## 执行证据

所有 Node/vitest 命令 cwd：`/Users/run.mao/workpace/feishu-sync/server`。

1. `node --import tsx --input-type=module < ../agent-outputs/kb-build-speedup/review-3-original.mjs` → **退出0**。原附录五个反例原样执行；输出显示原缺口已改变为预期安全行为。
2. `node --import tsx --input-type=module < ../agent-outputs/kb-build-speedup/review-3-probe.mjs` → 最终**退出0**；日志 `review-3-probe.log`。固定变体断言全部通过，同时复现 R1-B 两次误关闭。
3. `npx vitest run tests/review-blocking-issue-closure.test.ts tests/build-runtime-dispatch-guard.test.ts tests/build-runtime-dispatch-inflight.test.ts tests/kb-tool-param-tolerance.test.ts tests/kb-author-efficiency.test.ts tests/publish-readiness.test.ts tests/build-actors.test.ts` → **退出0，7文件173 passed**（两次运行一致，最终6.35s）；完整日志 `review-3-tests.log`。
4. 仓库根 `git diff --check` → **退出0，无诊断**；另取 git status/HEAD，未做stash/reset/checkout/restore。

**取证脚本自身纠错（不隐瞒失败）：** 增量脚本前三次分别因误用守卫结果字段allowed（实际为decision）、草稿fixture缺少`# 标题`、误把raw_read公开回执摘要当完整selector记录而退出1。均核对真实实现后只修正报告脚本；最终所有断言和漏洞取证完成。项目文件未改，未吞异常或降低预算/无损校验。

## 可信度、盲区与产物

- 已完成本轮要求的动态反例、事故链、针对性测试和diff检查；不是仅沿用Leader的全绿声明。未重跑tsc/eslint/全量vitest，Leader提供的bundled-amagi失败不计为本轮已复核证据。
- 测试与取证使用真实工具服务/真实schema/真实文件回执；报告权威fixture不等于真实模型全流程发布或MCP客户端端到端截断实测。最终content预算已有服务端直接字节断言，但未连接实际pi客户端。
- 超长raw分片不产生证据读取回执是显式策略，不把“已交付可拼回”冒充“可引用整行证据”。raw_read超长行显式跳过的限制如上。
- 未做生产资料构建、GUI、真实CURRENT/release切换或性能基准；本结论仅适用于声明的终轮增量范围。
- 支持产物均位于 `agent-outputs/kb-build-speedup/`：`review-3-original.mjs`、`review-3-probe.mjs`、`review-3-probe.log`、`review-3-tests.log`。脚本从server目录经stdin执行；fixture仅在系统临时目录，具体路径见日志。
- 回滚：本轮无实现变更；仅本轮review-3系列报告/取证文件可单独撤回，不要撤回其他共享工作树内容。

VERDICT: FIX
