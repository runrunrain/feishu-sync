# 标准库构建提速：full 对抗审查

**结论：需修复。Critical 0 / Major 5 / Minor 0。** R1–R4 是本轮改动引入或直接留下的验收缺口；R5 是本轮声称治理、但仍未解决的既有截断问题，不把截断机制本身冒充新回归。

## 1. 基线、范围与输入

- 仓库：`/Users/run.mao/workpace/feishu-sync`；基线 HEAD：`ceea273d7ea1d7693c1ce93b32e2dbd28c1b9041`。
- 审核对象：相对 HEAD 的未提交 `git diff`（24 个 tracked 文件）＋新增 `server/src/kb/publish-readiness.ts`＋5 个新测试。不是已提交基线的全仓安全审计。
- 必读且已读：同目录 `diagnosis.md`、`wpA-report.md`、`wpB1-report.md`、`wpB2-report.md`、`wpC-report.md`、`wpD-report.md`；事实以最终工作树代码为准，报告中的“已修复/全绿”未当作结论。
- 仅写本报告；未改项目代码、未编写项目测试、未读写真实 `~/.feishu-sync`。独立反例脚本保存在本报告附录，通过 stdin 执行，fixture 只落系统临时目录。

## 2. Findings

### R1｜Major｜声明精确绑定不等于问题范围已被复核：明确未核的范围也能关闭 blocking

**定位：** `server/src/kb/review-authority.ts:459-470, 600-619`；入口接受范围的位置为 `server/src/agent/agent-tool-service.ts:4463-4502`。

- **触发：** 当前存在主体绑定的 needs_revision/blocking 报告。随后声明发生变化（可仅是 docs 元数据，问题本身未修）；新独立审查回执结论为 pass，但 `checkedDimensions` 仅排版，`uncheckedScope` 明示“a.md 的证据列位未检查”。其正文与声明哈希都精确绑定当前候选。
- **实际影响：** `collectCurrentCandidatePassPaths` 只检查 valid/pass、报告 ID/候选哈希/结论、声明及 doc 哈希；不检查 `uncheckedScope` 或问题范围。`collectAuthorityValidatedReports` 随之把旧证据列位 blocking 报告整个剔除，`canPublish` 不再看到该阻断。独立性没有丢，但独立者并未复核这个问题，质量门实际被削弱。
- **证据（已复现到权威选择层）：** 附录脚本 R1 输出 `validReportIds:["pass"]`，旧报告 skipped 原因为 `blocking_issues_closed_by_current_pass`，尽管 pass 报告明确声明证据列位未核。生产提交入口原样存储 checkedDimensions/uncheckedScope，未禁止该组合；这不是靠作者自审或伪造正文触发。反例为权威回执/报告 fixture，不宣称跑过模型端到端发布。
- **最小修复方向：** 关闭须绑定具体 issue/复核范围（至少显式关联前轮问题、校验未核范围不排除该问题）；不能把“本路径有任意当前 pass”当成“本问题经复核关闭”。结构化证明不足时 fail-closed。仅检查声明漂移或 pass 时间新旧，均不足以解决本反例。

### R2｜Major｜问题清单把已有 pass 当作永久豁免，同候选新发现的 blocking 被立即吞掉

**定位：** `server/src/kb/build-actors.ts:938-962`，共用 helper `server/src/kb/review-authority.ts:424-473`。

- **触发：** a.md 已有完整当前候选 pass；没有修改正文或声明，Leader 随后通过 `build_issues_submit` 新登记该路径的 blocking（例如刚发现遗漏）。无需前轮 blocking，无需修订，无需新复核。
- **实际影响：** `openBlockingIssues()` 仅以 targetPath 是否属于当前 pass 路径集合过滤，直接返回 0；`build_request_publish` 的清单前置门丧失该问题。若问题只有 kil 清单而非另一个 blocking 审查报告，后面的报告门也不会替它拦住。此函数不接收 gatePolicy，严格模式同样受影响；不是“严格模式下的报告选择逻辑未改”就能证明安全。
- **证据（已复现）：** 附录 R2 使用另一份 `uncheckedScope:[]` 的完整 pass，随后 `recordIssueList` 新增 `new-problem`；实际 `same-candidate new blocking count: 0`。与 R1 的部分复核反例独立。
- **最小修复方向：** 给问题绑定其起始候选/前轮报告/问题身份，并要求后续复核明确覆盖该问题；重登记同 issueKey 应能沿用真实关闭证明，但全新的 issueKey 和同候选审查分歧不能被旧 pass 消掉。严格模式须显式保持既有策略。

### R3｜Major｜准入在后续校验前扣账：一次被拒派发即可让空池长时间误报满载

**定位：** `server/src/agent/build-runtime/dispatch-guard.ts:438-443, 497-535`。

- **触发：** capacity=1、有效新鲜空快照 seq=1；提交合法角色但错误 model，随后立刻按报错修正 model 重试。首次请求在 admission 中累加 unacked，然后才被 `dispatch_model_not_frozen` 拒绝，根本没有创建任务。
- **实际影响：** 修正后的请求被 `dispatch_inflight_write_exhausted` 拒绝；没有实际子任务，自然没有它的完成通知来释放槽。需等无关事件推进 seq 或快照过期（默认 15 分钟）才可能恢复；也可能先被空闲监督收口。这与“未入账补偿只低估、不高估”和可直接重试的承诺相反。容量更大时可由数次参数失败耗尽；taskFile/严格范围检查后拒绝也同型。
- **证据（已复现真实守卫）：** 附录 R3 连续调用输出 `dispatch_model_not_frozen dispatch_inflight_write_exhausted`，期间快照始终 `inflight:[]`，未运行任务。
- **最小修复方向：** admission 判定与记账分离；全部守卫校验成功后才预留。对后续原生派发失败/dryRun 等非创建结果也应释放预留，或以可确认的提交身份追踪确认，不能仅靠 seq/超时兜底。

### R4｜Major｜只放开 additionalProperties 未移除 required，四个别名入口仍在客户端被拒

**定位：** `server/src/agent/tool-specs.ts:90, 194, 210, 1094`（各工具的 `required`）；服务端别名实现位于 `server/src/agent/agent-tool-service.ts:6172-6237, 6306-6314`。

- **触发：** `raw_search({queries:["test"]})`、`draft_search({queries:["test"]})`、`draft_read({docPath:"a.md"})` / `{paths:["a.md"]}`、`kb_tool_schema({tool:"draft_read"})`。
- **实际影响：** schema 仍分别要求 query/query/path/name。JSON Schema 的 additionalProperties=true 不抵消 required；调用在 pi/amagi 校验层被拒，进不到 normalizeToolArguments。WP-C 明确要消除的别名重试回合仍发生。
- **证据：** 附录 R4 列出各别名输入缺失的 required，同时真实 normalizer 均接受。wpC-report 已确认生产 schema 在客户端先校验；新测试直接调用 executeTool/normalizer，绕过了这一层，所以通过不证明别名端到端可用。此项是 schema 结构静态证实＋真实规范化函数抽检，未伪称运行了客户端拒绝。
- **最小修复方向：** 用受支持的 anyOf/oneOf 同时接受 canonical 与列举别名，或将这些必填检查统一留给服务端（保留其他校验）；补真实下发 schema 的客户端接缝验证，而非只测 handler。

### R5｜Major｜字节预算只算原文，JSON 膨胀后仍超过客户端截断线；完整回执与已裁掉内容失配

**定位：** `server/src/agent/agent-tool-service.ts:5281-5283, 5298-5307, 5364-5374`；`raw_read` 同类遗漏在 `1327, 1584-1594`（坐标/页眉/链接附加在预算后）。

- **触发：** 90 行、每行 120 个反斜杠的合法源文本，共 10,889 UTF-8 字节。无任何超长单行，默认 kb_read_batch 一页读完。序列化会把每个反斜杠转义，元数据、segmentMap 另占空间；多请求、声明和 cursor 也不计入 bytesUsed。
- **实际影响：** 实际 content 为 **22,389 字节**，超过上游报告已核实的 pi MCP 20,480 字节中段截断线，但服务端返回 `truncated:false,nextCursor:null`，且登记覆盖全部 90 行的 1 份读回执。模型可能失去正文中段，却仍可引用完整回执；与本轮“不会回执声称读过但内容被裁掉”的验收不符。raw_read 也只算 slice 原文，不算坐标/页眉，不能保证最终窗口低于阈值。
- **证据（部分动态、部分静态）：** 附录 R5 通过真实 AgentToolService/RawSourceSnapshot 复现全部上述尺寸与分页/回执结果；本轮未通过真实 pi MCP 观察实际中段删除，删除行为/阈值依据必读 `wpD-report.md §2`。故直接证明的是服务端预算防护失效，客户端丢失由既有截断路径推出。
- **归因：** 客户端截断和预登记回执是既有机制，本轮没有首次引入它；但 WP-D 新预算未治理该风险，且协议撤去小页限制并声称可依赖自动预算。本 finding 是范围内未解决的验收缺口，不是捏造新回归。
- **最小修复方向：** 对最终实际发送的 content 做 UTF-8 预算（含 JSON 转义、坐标、声明、cursor、资源元数据），裁页定型后再登记相同范围回执；无法装入的单行/声明需显式续传或报错，不可声明完整读取。验证最终 content 的字节数，而非只验多页拼接无损。

## 3. Full 覆盖清单与未发现项

| 面向 | 核查与结论 |
|---|---|
| 正确性/质量门 | B1 当前候选声明+正文绑定、主体保留、报告双向绑定、kri/kil 两级门均追踪。找出 R1/R2；无 pass、stale、声明再变、不可归属的既有负例仍通过。报告层 strict 精确路径保持；不能据此掩盖 kil 层 R2。 |
| 独立性/安全权限 | kb_submit_review 仍验证角色与 assertReviewerIndependent；证据 verifyEvidence/resolveSelector 判定未改，新增仅错误提示和同语义去重。未发现作者自审新入口。 |
| 派发/并发 | A1 同模型池键确与 agent-dir-config 渲染一致，按唯一 modelSpecPoolKey 求和正确；现有角色的容量不一致/缺模型池/总容量超限检查仍在。同池=1/2/3/6、异池、换代、过期 fail-open 用例通过。A2 unacked 拒绝扣账见 R3；seq 任意前进即清补偿会短时超放，是报告已披露的队列退化，不当权限漏洞报。 |
| extension 信任/IO | 读取绝对路径来自冻结信封；不是模型参数直读任意路径。快照缺失/损坏/代次错会 fail-open，权限/完整性检查仍保留。256KB 检查发生在 readFileSync 之后、且按字符串长度，不是前置内存上限；宿主控制且正常体积小，本轮未证实越权利用，不列为阻断 finding。 |
| WP-C 参数/一致性 | ev_auto 追加避开已有键；同键去重指纹包含对象/断言/源/selector/role/nature，未见借去重绕过新事实核验。columns 字母/数字规范化后仍进入原 CSV 校验。openIssues 序列化可能裁至600字符、冲突别名有优先级说明：不作“原样无损”保证。顶层 batch 包装/多查询/游标已审；真实 schema 可达性缺口见 R4。 |
| WP-D 分页/回执 | 服务端裁页窗口本身与 next_offset/receipt 的范围相符，batch 续页预算重置且不重不漏；最终客户端可见范围不符见 R5。claim 新包含校验经写/编共享链，现有合法继承/坐标平移回归通过；未找到当前合法草稿被误拒的确定反例，但未检查真实全部旧检查点。 |
| WP-B2 发布共用 | validateStagingDocs 确实调用 uncoveredWorksetTokens；预览 gather 仍独立采集事实，不能把“同纯函数”夸成所有 IO/错误状态也完全等价。预览异常只降级，不放松发布门。 |
| 写权与生命周期 | 作者后代链转交在同步循环内先 supersede 旧分配，再建新 active；新持有者被排除避免遍历新 Map 项无限继承，旧持有者撤销，提交前重核仍在。未发现同目标同时多个有效分配的新路径。 |
| 跨包/协议 | agent-tool-service 共用 writeDocCore 和 executeTool 接线完整；build-actors 同时改关闭/续接/积压，未见 hunk 丢失。leader-protocol 3–5/7 步均保留。author 净增6行、reviewer 净0行，没有独立的长度阻断问题；哈希漂移/缺失/symlink、角色资源清单与示例契约回归通过。 |
| 兼容/性能/维护 | 声明/回执/检查点没有新增必须迁移字段；旧策略恢复和声明 scope 回归通过。预览同步扫描与字符串裁页成本存在，但没有真实大构建吞吐/CPU测量，不给无证据性能 finding。 |

## 4. 验证记录、可信度与盲区

所有 vitest 的 cwd 为 `/Users/run.mao/workpace/feishu-sync/server`，命令退出均为0。

1. `npx vitest run tests/review-blocking-issue-closure.test.ts tests/publish-readiness.test.ts tests/kb-tool-param-tolerance.test.ts tests/kb-author-efficiency.test.ts tests/build-runtime-dispatch-inflight.test.ts tests/build-runtime-dispatch-guard.test.ts tests/build-runtime-contracts.test.ts tests/build-runtime-agent-dir-config.test.ts tests/build-runtime-extension.test.ts tests/build-actors.test.ts tests/knowledge-skill-examples.test.ts tests/frozen-pipeline.test.ts` → **12 文件、223 passed**，4.67s。
2. `npx vitest run tests/build-runtime-integrity.test.ts tests/build-runtime-tools.test.ts tests/build-runtime-toolfix-regressions.test.ts tests/review-subject-standard.test.ts tests/review-declaration-scope.test.ts tests/kb-build-resume.test.ts tests/kb-build.test.ts tests/kb-knowledge-tools.test.ts tests/knowledge-schema.test.ts tests/evidence-resources.test.ts tests/kb-mechanical-precheck.test.ts tests/link-repair.test.ts tests/raw-search.test.ts` → **13 文件、363 passed / 1 skipped**，16.00s；跳过项为 F12 live 真实 Leader 完整性联测，环境条件未满足。
3. 附录脚本经 `node --import tsx --input-type=module` 从 stdin 执行 → **退出0**，输出如下。它是本轮独立反例取证，不是新增项目测试；R1/R2 的权威回执由 fixture 构造，未重复验证生产独立身份认证，认证另由既有工具链测试覆盖。
4. `git diff --check` → **退出0，无输出**。未跑完整 check/typecheck/lint，不借既有报告冒充本轮执行；未跑全量 vitest，已知 bundled-amagi 版本基线失败未重测。
5. 首次落报告使用 server cwd 下错误的相对路径而失败，未写入任何文件；改为声明绝对路径后成功。首次失败的管道缺少 pipefail，故未采信其 shell 成功状态；最终取证启用 pipefail 并有真实输出。

```text
R1 partial pass closure: {"validReportIds":["pass"],"skipped":[{"reviewId":"old","reviewerTaskId":"independent-old","reason":"blocking_issues_closed_by_current_pass"}]}
R2 same-candidate new blocking count: 0
R3 rejected then corrected: dispatch_model_not_frozen dispatch_inflight_write_exhausted
R4 schema required missing: raw_search ['query']; draft_search ['query']; draft_read ['path']; kb_tool_schema ['name']
R5 batch: {"sourceBytes":10889,"responseBytes":22389,"returned":90,"truncated":false,"nextCursor":null,"receipts":1}
fixture: /var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-review-probe-DhX5V4
```

**可信度：** 高于仅看测试全绿（有独立反例）；局部函数/工具服务证据充分，不等于真实模型、客户端 MCP、GUI、全量发布的端到端证明。未做真实构建，不能量化本轮提速。原子发布既有回归通过，没有制造真实 CURRENT/release 写入。

**回滚：** 本轮没有实现改动可回滚；本报告可单独移除。fixture 在上述临时目录，保留以便复核；不建议整文件 checkout 任何共享改动。

## 附录：独立取证脚本（非项目测试）

脚本从 server/ 执行，只创建系统临时 fixture，不触真实用户数据。

```javascript review-probe
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardTaskSubmit, resetDispatchGuardAdmissionState } from './src/agent/build-runtime/dispatch-guard.ts';
import { AgentToolService, normalizeToolArguments } from './src/agent/agent-tool-service.ts';
import { RAW_SEARCH_SPEC, DRAFT_SEARCH_SPEC, DRAFT_READ_SPEC, KB_TOOL_SCHEMA_SPEC } from './src/agent/tool-specs.ts';
import { BuildActorStore } from './src/kb/build-actors.ts';
import { collectAuthorityValidatedReports, scopedKnowledgeDeclarationHash } from './src/kb/review-authority.ts';
import { contentResourceHash } from './src/kb/evidence-locator.ts';
import { RawSourceSnapshot, computeSourceHash } from './src/kb/raw-source-snapshot.ts';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kb-review-probe-'));
const root=path.join(temp,'staging');
fs.mkdirSync(path.join(root,'docs'),{recursive:true}); fs.mkdirSync(path.join(root,'reviews'));
const body='unchanged body'; fs.writeFileSync(path.join(root,'docs/a.md'),body);
const draft={schemaVersion:1,buildId:'b_probe',docs:{'a.md':{title:'old'}},clientKeys:{},evidenceKeys:{},objects:[],presentations:[],relations:[],evidence:[],coverage:[],calls:{}};
const oldHash=scopedKnowledgeDeclarationHash(draft,['a.md'],['src']);
draft.docs['a.md'].title='new'; fs.writeFileSync(path.join(root,'knowledge-draft.json'),JSON.stringify(draft));
const newHash=scopedKnowledgeDeclarationHash(draft,['a.md'],['src']);
function review(id,verdict,decl,uncheckedScope=[]) {
 const issues=verdict==='pass'?[]:[{issueId:'i1',draftLocation:'a.md 证据',sourceLocation:'src line 1',description:'证据列位错误',severity:'blocking'}];
 const report={reportId:id,buildId:'b_probe',draftHash:'candidate',coverage:{draftHashes:['candidate'],sourceRefs:['src']},checkedDimensions:['排版'],issues,uncheckedScope,conclusion:verdict,serverVersionTag:'fixture'};
 fs.writeFileSync(path.join(root,'reviews',id+'.json'),JSON.stringify(report));
 return {reviewId:id,buildId:'b_probe',generation:1,reviewerTaskId:'independent-'+id,scopePaths:['a.md'],draftHash:'candidate',dependencyHashes:{'doc:a.md':contentResourceHash(body),'subject:a.md':'subject','knowledge-declaration':decl,'declaration-scope':'document-v2','source-snapshot':'snapshot','workflow-rules':'rules'},verdict,issues,status:'valid',reportId:id,reportUnitId:id,createdAt:'2026-11-01T00:00:00Z'};
}
const old=review('old','needs_revision',oldHash);
const pass=review('pass','pass',newHash,['a.md 的证据列位未检查']);
console.log('R1 partial pass closure:',JSON.stringify(collectAuthorityValidatedReports({stagingRoot:root,store:{listReviews:()=>[old,pass]},documentHashes:new Map([['a.md',contentResourceHash(body)]]),subjectOf:()=> 'subject',current:{declarationHash:newHash,sourceSnapshotHash:'snapshot',workflowRulesHash:'rules'}})));
const completePass=review('complete-pass','pass',newHash,[]);
const store=new BuildActorStore({buildId:'b_probe',stagingRoot:root,generation:1});
store.recordReview({...completePass,issues:[]});
store.recordIssueList({authorTaskId:'leader',issues:[{issueKey:'new-problem',severity:'blocking',targetPath:'a.md',description:'pass 后新发现的问题',draftLocation:'a.md',sourceLocation:'src',fromReviewId:null}]});
console.log('R2 same-candidate new blocking count:',store.openBlockingIssues());
resetDispatchGuardAdmissionState();
const config={buildId:'b_probe',generation:1,workDir:'/tmp/kb-work',reportRoot:'agent-outputs',forbiddenZones:[],roles:{luban:{key:'writer',models:['valid'],mcpTools:[]}},dispatch:{rolePoolKeys:{writer:'pool'},poolCapacities:{pool:1},inflightStatePath:'/tmp/not-used'}};
const now='2026-11-01T00:00:00Z';
const snapshot={schemaVersion:1,buildId:'b_probe',generation:1,seq:1,updatedAt:now,inflight:[],pendingReview:0,pendingRevision:0};
const opts={now:()=>now,inflight:snapshot};
console.log('R3 rejected then corrected:',guardTaskSubmit(config,{agent:'luban',task:'one doc',model:'invalid'},opts).code,guardTaskSubmit(config,{agent:'luban',task:'one doc',model:'valid'},opts).code);
for(const [name,spec,args] of [['raw_search',RAW_SEARCH_SPEC,{queries:['test']}],['draft_search',DRAFT_SEARCH_SPEC,{queries:['test']}],['draft_read',DRAFT_READ_SPEC,{docPath:'a.md'}],['kb_tool_schema',KB_TOOL_SCHEMA_SPEC,{tool:'draft_read'}]]) console.log('R4 schema required missing:',name,(spec.parameters.required??[]).filter(k=>!(k in args)),'handler accepts:',normalizeToolArguments(name,args).args);
const kb=path.join(temp,'kb'); fs.mkdirSync(kb);
const raw=Array.from({length:90},()=>String.fromCharCode(92).repeat(120)).join('\n'); fs.writeFileSync(path.join(kb,'raw.md'),raw);
const entry={objToken:'src',objType:'docx',title:'source',relPath:'raw.md',contentHash:computeSourceHash(path.join(kb,'raw.md'),[],kb),objEditTime:null};
const snapshotRaw=RawSourceSnapshot.fromEntries([entry],{knowledgeBaseRoot:kb,sheetCsvPaths:()=>[]});
const state={knowledgeBaseRoot:kb,snapshot:snapshotRaw,mode:'full',workset:new Map([['src','added']]),stagingRoot:root,finishInfo:null};
const svc=new AgentToolService({dataRoot:temp,documentsProvider:()=>[]});
const ctx=svc.createRunContext({runKind:'build',buildId:'b_probe',outputRoot:path.join(temp,'output'),knowledgeBaseRoot:kb,buildState:state,allowedToolsOverride:['kb_read_batch']});
const result=await svc.executeTool(ctx.token,'kb_read_batch',{requests:[{kind:'raw',objToken:'src'}]});
const payload=JSON.parse(result.content[0].text);
console.log('R5 batch:',JSON.stringify({sourceBytes:Buffer.byteLength(raw),responseBytes:Buffer.byteLength(result.content[0].text),returned:payload.results[0].returnedLines,truncated:payload.results[0].truncated,nextCursor:payload.nextCursor,receipts:result.details.receipts}));
console.log('temporary fixture preserved:',temp);
```

## 最终结论

需修复 R1–R5 后复审；当前不建议合入。

VERDICT: FIX
