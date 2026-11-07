# R1–R5 增量复审（静态审核完成，执行验收 blocked）

**静态结论：FIX。原 R1/R2/R5 仍有修复相关 Major；R3/R4 的原缺口在所读代码中已消除，但未动态确认关闭。**

## 基线与证据限制

- 上游必读输入：`/Users/run.mao/workpace/feishu-sync/agent-outputs/kb-build-speedup/review.md`，全文已读。
- 对象：任务指定工作树的当前源码、相关测试和消费者；未修改任何项目文件，仅写本报告。
- 原报告记录 HEAD 为 `ceea273d7ea1d7693c1ce93b32e2dbd28c1b9041`，本轮**无法独立确认 HEAD、未提交 diff 和并发快照**，不把原基线冒充本轮 git 取证。
- 当前实际工具仅 read/write/grep/find/amagi_resource/codemode/toolcall_continue；通过 `searchTools('bash')` 返回空、ALL_TOOLS 枚举核实无命令执行工具。codemode 不提供 Node/fs/import 或子进程能力，不能代替 shell。
- 因此：**附录反例、vitest、git diff --check 均未运行**。下述行为由实际分支静态证实；不宣称实测输出、测试通过或真实发布通过。用户所述 bundled-amagi 版本失败仅作为已知背景，未复核。

## 逐项复审结论

| 原编号 | 结论 | 本轮依据与缺口 |
|---|---|---|
| R1 | **未关闭** | 原附录中直接提及 a.md 的 uncheckedScope 已被拦；但新实现以字符串出现其他路径作为排除安全证明，多路径仍可错误关闭，见 R1-A。 |
| R2 | **未关闭** | 标准模式登记 originBinding、同候选不漂移条件阻止原反例；同 issueKey 保留首次 originBinding。严格模式没有显式禁止关闭，fromReviewId 兼容分支可绕过“未记录 originBinding”的策略，见 R2-A。 |
| R3 | **静态修复成立，动态关闭未确认** | reserveUnackedSlot 移至 guardTaskSubmit 最终 allow 前；模型/taskFile/范围拒绝先 return。原拒绝后修正路径不再预留。TTL/seq/同轮计数已查，见覆盖表。 |
| R4 | **静态修复成立，动态关闭未确认** | 四工具移除 required；normalizer 有 query/path/name 缺失精确错误；下发桥接透传 schema，未发现仓库内转换重新补 required 的路径。AJV 接缝测试存在但未执行。 |
| R5 | **未关闭，修复引入分页回归** | 最终序列化预算覆盖原反斜杠膨胀路径；但普通行会因页剩余容量不足而被跳过，draft 超长单行可产生永不推进的 cursor，见 R5-A/B。显式跳过真正超长 raw 行也不满足任务要求的无损续读。 |

## Findings（均为本轮修复直接相关；Critical 0 / Major 4 / Minor 0）

### R1-A｜Major｜`server/src/kb/review-authority.ts:495–506, 550–558`

**触发条件：** 沿原附录 R1 保持 a.md 的 blocking、候选漂移和当前候选 pass；pass 的 scopePaths 包含 `a.md,b.md`（完整提供两路径正文依赖和同范围声明哈希），checkedDimensions 为 `['排版']`，uncheckedScope 为单项 `['除 b.md 外，全部文档的证据列位均未检查']`。a.md 的 issue 定位使用原附录的 `a.md 证据`。

**实际影响：** a.md 明确属于未核范围，但该 pass 被当作能关闭 a.md 的证据；原 blocking 报告可从权威报告集合剔除，清单层共用 helper 也受影响。

**静态证据：** `entry.includes('a.md')` 与 `entry.includes('a.md 证据')` 均 false；knownPaths 已加入当前回执 scopePaths，`mentionsOther` 因 b.md 为 true，于是不执行泛化排除的 return true，最终返回 false（未排除），随后设置 `closed[index]=true`。该字符串是合法自由文本，无需伪造回执或作者自审。已新增测试只覆盖“泛化不含路径”和“明确其他路径”，没有覆盖路径名与泛化排除混合的句子。

**最小修复方向：** 不把“提及其他路径”等同于“仅排除其他路径”；以结构化 issue/path 复核范围绑定关闭证明，不能明确证明覆盖时 fail-closed。

**复核入口：** 原报告附录 review-probe 的 R1 fixture，按上述修改多路径 pass/声明绑定。本轮无可运行脚本产物、未执行，完整变体输入已在此给出。

### R2-A｜Major｜`server/src/kb/build-actors.ts:953–997`；`server/src/agent/agent-tool-service.ts:5122–5151`

**触发条件：** 严格模式：先有 a.md 的 needs_revision 报告，Leader 通过 build_issues_submit 登记 blocking，`fromReviewId` 填该报告 reportId；随后 selector-only 修订，再生成精确绑定新候选的完整 pass。

**实际影响：** 严格模式清单也能被自动关闭，违反本次修复承诺的“严格模式保持既有计数策略”。现有严格模式用例不会覆盖此输入。

**静态证据：** strict 仅使 originBindingOf 返回 undefined；仍原样保存 fromReviewId。openBlockingIssues 不接收 gatePolicy；blockingIssueOriginDrifted 在无 originBinding 时查找该 reportId 的回执，不要求旧回执 valid。旧声明与当前声明不同，因此 reviewReceiptPathOriginDrifted 返回 true；新 pass 是 valid、精确匹配且完整覆盖，passReviewClosureForIssues 返回 true，清单计数变为 0。旧报告被严格写入失效不妨碍此路径，因为 fromReviewId 查找不筛 status。`tests/review-blocking-issue-closure.test.ts:179–184,315–326` 的严格测试调用 registerIssue，而该 helper 固定传 `fromReviewId:null`，只能证明 null 路径不关闭。

**最小修复方向：** 在清单关闭判定中显式携带/检查严格策略；旧清单 fromReviewId 回退须区别标准兼容路径与严格策略，不能靠“不记录 originBinding”间接保证 strict。

**复核入口：** 现有 strict fixture 同样流程，仅将登记 fromReviewId 改为先前 needs_revision 的 reportId，比较 openBlockingIssues；本轮未执行，也未修改项目测试。

### R5-A｜Major｜`server/src/agent/agent-tool-service.ts:5364–5369,5449–5469`

**触发条件：** kb_read_batch 同页先返回约 14–15KB 的草稿正文结果（无附带声明），后续 raw 请求只有一行约 5KB ASCII 正文。两项单独都远小于 19,500B 硬上限，但合并超 17,000B 软预算，较小的 skipItem 仍能装进剩余预算。

**实际影响：** 正常 raw 单行被误报“超单页硬上限”并直接跳过，未返回正文、未登记回执，最后一行时不再入队，nextCursor 可为 null。预算防护引入真实漏读，非仅超长行策略争议。

**静态证据：** admit 在 results 非空时只接受整页 ≤17,000B；当前 raw hi=1，无法通过 admit 后直接进入 `chosenLines <= 1` 分支。该分支没有用空 results/新页预算验证单行是否真正超限。skipItem 的小体积可通过 admit；随后仅当 `offset+1 < totalLines` 才重新入队，所以此单行永久消失。错误 note 却声称该行超过硬上限。所读测试覆盖单 raw 超长行，没有覆盖“前一个结果已消费预算、后一个正常单行”的情形。

**最小修复方向：** 当前页放不下时先 defer 到下一页；只有在空页完整封套下仍超硬上限才进入不可分单元处理，且不可自动跳过要求无损的源内容。

**复核入口：** 两请求 `[{kind:'draft',path:'large.md'},{kind:'raw',objToken:'single'}]`；large.md 取约 14,000 个 ASCII 字符的正常草稿正文，single 为一行 5,000 个 ASCII 字符。断言整个 cursor 链重建得到原 raw 行，不出现 oversizedLine，且读取回执包含该行。本轮仅静态取证，具体 fixture 封套字节未实测。

### R5-B｜Major｜`server/src/agent/agent-tool-service.ts:5499–5534`

**触发条件：** kb_read_batch 请求一份仅一行、约 25KB 正文的合法 draft，includeDeclarations 未启用。

**实际影响：** 成功返回空 results 和未推进的 nextCursor；按 nextCursor 续读永远重复，不能获取该行或收到明确失败。此问题直接落在本轮单行超长与 cursor 有效性的验收内。

**静态证据：** hi=1，admit 在空页也超过硬上限；缩窗分支要求 hi>1，故不执行。失败处理只在 `request.includeDeclarations && results.length===0` 时报错，否则 queue.unshift(request) 后 break。没有正文结果、offset 不变，cursor 序列化同一请求。下一次每请求预算重置，但该原子单行仍超硬上限，因此无限重复。

**最小修复方向：** 为 draft 不可分超长正文提供显式错误或可无损推进的子行续传，禁止成功返回永不推进的 cursor。

**复核入口：** `requests:[{kind:'draft',path:'single-long.md'}]`，正文一行 `'x'.repeat(25000)`；连续回传两次 nextCursor，检查 offset/结果推进或明确错误。本轮未执行。

## 覆盖清单、验证可信度与剩余风险

| 验收面 | 已核实的静态事实 | 未执行/盲区 |
|---|---|---|
| R1 原反例 | uncheckedScope 直接含问题路径会拒关闭；checkedDimensions 空也拒绝 | 附录原脚本未重跑；多路径混合泛化绕过见 R1-A |
| 事故主链与再变 | collectAuthorityValidatedReports 要旧声明漂移；当前 pass 正文和声明精确匹配，声明再变即不构成关闭；单路径 selector-only + 新 pass 的链路仍在 | 主链真实工具 fixture 与重登记均未动态跑 |
| R2 同候选新 blocking | API 标准模式从当前 staging 计算 originBinding；同候选不漂移，计数保留；原附录直连 store 无 origin/fromReviewId 也 fail-closed | 所需实测 count=1 未取得；旧清单带 fromReviewId 和 strict 不等价，见 R2-A |
| R2 重登记 | recordIssueList:1057–1070 同 issueKey 继承首次 originBinding | 只继承 originBinding，不冻结 targetPath/fromReviewId；身份变更兼容未完整验证，不另立无复现 finding |
| R3 同轮/capacity=1 | 校验后预留；同 seq count 累加；capacity=1 一次合法 allow 后同轮第二次被限制；seq 改变使旧补偿为0；TTL 为最后一次预留后 >60,000ms 过期 | 未动态运行；seq 变化即可清补偿、TTL 到期低估风险为原报告披露，不当新 finding；后端原生失败仍可占60秒，不宣称即时释放 |
| R4 schema/错误 | raw_search/draft_search/draft_read/kb_tool_schema 的 required 删除；normalizer 缺失提示指向 query/path/name；kb_edit_doc 仍 required path、additionalProperties:false | 未跑 AJV/pi/typebox；写工具契约未做全仓 diff 比对，不签“所有写工具均未改” |
| R4 MCP/类型转换 | `agent/pi-extension/feishu-sync-agent.js:390–394` 直接传 spec.parameters；`agent/claude-bridge.cjs:152` 直接映射为 inputSchema，没有 required 重新构造 | 外部 pi/amagi TypeBox/MCP 运行转换未执行。独立只读 KB MCP 有另一个 raw_search schema，非此 build 工具 schema，不混为回归 |
| R5 反斜杠/引号/CJK | batch docBytes 对最终 JSON.stringify 做 Buffer.byteLength；raw 对最终渲染文本计字节；原膨胀盲点已处理 | 无最终字节动态断言，无多页重建/回执实测，不能签阈值与无损均通过 |
| R5 单行/声明 | raw_read 和 batch raw 真超长行都显式 skip、不登记其回执；draft includeDeclarations 原子超大给精确错误；续页关闭 includeDeclarations | 真超长 raw 行仍被丢弃，不满足此次“续读无损”要求；raw 尾页链接裁剪、资源元数据巨量、声明混合多请求未动态覆盖 |
| R5 登记时序 | raw_read 定型后登记；batch 在最终硬上限断言前 appendReadReceipts（5543在断言之前） | 若断言失败会留下未交付响应的回执；未证明可达触发，本轮列风险，不另计 Major |

### 待续跑命令（**不是执行记录**）

cwd：`/Users/run.mao/workpace/feishu-sync/server`

```sh
npx vitest run tests/review-blocking-issue-closure.test.ts tests/build-runtime-dispatch-guard.test.ts tests/build-runtime-dispatch-inflight.test.ts tests/kb-tool-param-tolerance.test.ts tests/kb-author-efficiency.test.ts
```

另需将上游附录的相对 import 改为仓库源码绝对路径，经 `node --import tsx` 重跑原 R1–R5，并按 findings 给出的输入扩展取证。取证脚本只能放授权报告面，不修改项目测试。由于本轮没有 shell，未创建伪“已运行”脚本或输出日志。

### 阻塞项

需要在具备命令执行工具的检验环境续接，完成任务明确要求的附录重跑、事故主链、相关 vitest、最终字节和无损续页断言、git diff 基线确认。当前报告足以支持修复所列静态 Major，但**不足以签发全验收完成或 PASS**。已审未改且与修复无因果关系的新问题未扩审。

回滚：无代码改动；仅本报告可单独撤回。未触真实用户数据、未安装、未构建、未提交。

VERDICT: FIX
