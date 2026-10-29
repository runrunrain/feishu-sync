# 阶段 B full 独立审核（首审）

VERDICT: FIX

## 基线、输入与边界

- 基线：main `8fba395`；审核对象为当前工作区 P1+P2+P3 集成内容（含未跟踪新文件），不是仅 tracked diff。首审，未修改实现或项目测试。
- 必读已完成：仓库 CLAUDE.md；完整用户设计 `/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`（§§0–13、附录）；下列两份上游 artifact。
- 上游：`/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/20261029-kb-retrieval-mcp/stage-b-evidence.md`、同目录 `engine-report.md`。
- 范围：server/src/kb/search/**、kb-search.ts、standard-kb-store.ts、kb-build-service.ts 的预热薄补丁、routes/kb.ts、AgentToolService 的 kb 读链、tool-specs.ts、types/agent-knowledge.ts、mcp/kb-mcp-{server,tools}.ts、kb-eval.ts / lib/kb-eval-lex.ts、相应新/改测试与 docs/agent-knowledge.md、docs/kb-evaluation.md。P5 UI、网关及其他并行改动均排除；即使审核时 status 中已经出现 P5 后端文件，也未纳入。

## Findings

### F1｜Major｜搜索分页在 UI/内置适配层断路，预算命中的尾部结果不可继续取得

- 定位：`server/src/kb/standard-kb-store.ts:189–190`；`server/src/routes/kb.ts:275`；`server/src/agent/agent-tool-service.ts:512–526`；`server/src/agent/tool-specs.ts:20–34`。
- 触发：请求 limit=20，匹配文档的累计 hits/summary 超过 search 页预算（默认名义 8000，统一预留 512）。不需要异常大字段；本次 20 篇普通双章节合成文档即可触发。
- 可观察失败：共享门面返回 total=20、首屏16条、next，下一页4条；Store 只取 .results，HTTP 随之丢弃 total/next，默默只返16条。内置 kb_search 虽把 next 返回，却未在 spec 声明 cursor，执行路径也不转发 cursor；直接带回该值仍得到相同首屏。只有 MCP/门面具备有效继续路径。原请求20条在此变成不可发现/不可续取的16条，是本轮预算接入引入的适配回归，不是排序算法分叉。
- 证据：附录脚本实际执行 exit 0；输出见下文。现有三端一致性测试只有3篇小文档，比较的是首屏 results，无法证明预算跨页场景。服务层分页测试不能覆盖 Store/内置入口吞游标。
- 契约依据：设计 D4/C4、§7.1 的“超出预算一律分页，不静默截断”、附录 B.6；集成报告声称 UI/内置/MCP 分页一致，当前只做到首屏拆分一致，没有贯通继续能力。
- 最小修复方向：明确旧 UI 搜索契约的兼容策略；若保留有界页，应在 Store/HTTP additive 暴露并接收 cursor/next，内置 spec 与执行层同步 additive 接收/传递 cursor。若兼容返回指定 top-k，应在对应适配层明确排空所需页，不能继续无提示地丢掉 next。请实施者补预算跨页的真实入口回归（不只门面测试）。

### F2｜Minor｜内置 kb_read 预查错误拆分合法含 # 的文件名

- 定位：`server/src/agent/agent-tool-service.ts:554`（对照 `server/src/kb/search/kb-query-service.ts:240–250` 的精确路径优先解析）。
- 触发：发布路径如 `C#指南.md`；通过内置 kb_read 的 path 或该文件的章节 anchor 读取。
- 可观察失败：内置预查把文件名截为 C，在进入公共门面之前报 kb_doc_not_found；同一文件通过门面读取成功，通过内置 docId 也成功。这是新增 anchor 支持引入的既有合法 path 回归；可用 docId 绕过，影响局部，定 Minor。
- 证据：附录脚本实际输出 facade=r1、builtin path=kb_doc_not_found、builtin docId=C#指南.md；服务层已有含 # 文件名测试，但内置测试未覆盖该路径。
- 契约依据：设计 §9 的 kb_read additive section 扩展、§5.7/§7.6 的 path/anchor 读取与共用解析；不能以新增 anchor 功能破坏原路径。没有任何发布路径契约禁止 #。
- 最小修复方向：不在适配层用首个 # 提前裁决；复用门面的“精确文件优先、最长已有 path# 前缀”结果取得文档元数据。实施者补内置含 # 文件及 anchor 的回归。

## Full 清单覆盖与判定

“未见阻断”只表示本次静态路径与现有证据未推翻对应承诺，不表示完成全部外部验收。

| 检查面 | 核对结果 / 证据 |
|---|---|
| hash / workbook / 路径围栏 | buildKbIndex 使用发布同式 computeSourceHash(file, [], docsDir)，含 source_workbook；目录、manifest、正文与附件 realpath 围栏；损坏/缺失不入索引，精读报 integrity error。已有附件变化与 symlink fixture；未见新增阻断。 |
| release / 清理 / 缓存 / 并发 | begin 每调用解析一次版本；cursor 固定版本；先解析目录再取缓存；yield 后复核目录；settled LRU=2、pending Promise 去重、拒绝后清除；发布 CURRENT rename 后异步预热。缓存内不持续监控外部原地篡改，已在 engine-report 明确，符合不可变 release 前提。 |
| BM25F / 回退 / 分段 | 对照 §5 的参数、df=0 回退、词表前向匹配、扫描项上限、tf/IDF/长度归一、覆盖率平方、同段加权与 path 确定性排序；H2/H3 不重复正文、fence、表头、原始行号映射。纯 core 与 I/O 分离；未见已证实阻断。 |
| 预算 / cursor / 错误 / 零进展 | 门面统一 -512；JSON/text 序列化长度、next 与帧计入；参数摘要含预算；放不下原子项时拒绝而不发原地 cursor。MCP 自己最终再验 cap。适配层缺陷见 F1。 |
| 正文 / 不可信指令 | read/bundle 属性 XML 转义、正文精确闭合串 </kb_doc> 转义、行截断有标记；instructions 与读工具说明声明资料内指令无效。按设计的不可信资料提示核查，不把文本帧宣称为 OS/LLM 安全沙箱。 |
| MCP / 兼容 / notice | 7只读工具；旧4名字与 list.prefix 保留；输入 additive（get/list 文本输出变化为设计批准例外）；server-side schema 校验、错误紧凑 JSON、无 structuredContent；lastServedCurrent 按传入状态管理、显式 release/cursor 不更新跟随状态；notice 使用共享预留预算。网关会话生命周期不在本轮。 |
| 内置 spec / 令牌 / 模式 | kb_grep 同步登记 ALL_SPECS、DISCUSS/WORK、族 runKinds；仍由既有能力令牌裁决，不进 build/task/probe；未见写权限扩张。路径解析缺陷见 F2。 |
| 三端 / Node20 / 无原生模块 | 阅读真实 Hono、能力入口与 SDK stdio 一致性测试，未把排序/磁盘 mock 掉；沿用上游 Node24/真实 ElectronRunAsNode20 成功证据。首屏外能力不一致见 F1。 |
| E0 / 评测真实性 | lex adapter 真实调用门面，固定 release，不补造 grep 结果，partial/error 使评测失败；排空 top-k 与 grep 页；拒绝 l1 环境冒称 lex；无真实80条的占位数据。docs 与报告如实区分合成和真实。 |
| 性能 / 迁移 / 维护性 | 沿用10/30MiB数据（下节）；无新增发布格式/DB迁移。共享门面防分叉；F1/F2 恰是额外适配代码未完整复用的局部问题。未重新做大规模压力审计。 |

## 验证证据与可信度

1. 只读取证：git status --short 与 git diff 8fba395 的授权路径；直接阅读未跟踪 search/、共用注册、eval adapter 和新测试，避免 git diff 漏审。没有因并行 P5 变化修改或丢弃现场。
2. 上游执行证据（本轮不重跑）：11文件157项针对性测试通过；lint/typecheck 退出0；SDK stdio Node24/Node20、真实三端短样本一致性。测试结构可复核，但本轮没有重新执行这些157项，不把转引说成本轮亲测。
3. 上游合成测量：10/30MiB preparation=131.89/377.96ms，search warm p95=3.89/7.95ms，排空 literal grep p95=62.23/486.58ms，forced-GC heap增量21.71/63.51MiB。数值满足设计合成预算；30MiB grep 接近500ms边界，合成分布不能外推真实余量。RSS约105/221MiB不是heap。合成12条质量结果不是80条真实验收。
4. 本轮最小证伪：在仓库根目录，从本报告附录提取 JS，以 node --import tsx --input-type=module 执行，exit 0；只建立并清理自有临时合成目录，无生产数据、无模型/网络、无项目测试文件变更。实际 stdout：

~~~text
{"total":20,"firstPage":16,"secondPage":4,"storeReturns":16,"storeExposesCursor":false,"builtinCursor":true,"specAcceptsCursor":false,"passingCursorRepeatsFirst":true}
facade C# path: r1
builtin C# path: kb_doc_not_found
builtin C# docId: C#指南.md
~~~

5. 可信度：上述两条 finding 为实际复现；其余结论为静态核对加转引真实上游证据，没有“测试全绿即停止深查”。本轮未新增正式项目测试，也未实施修补。

## 尚未满足的外部门槛 / 盲区

- 真实 release/80条人工标注、真实各类质量与相对回归门槛、阈值冻结，仍未具备；不得据合成12条 Q5=0.5 启动 P4，也不得据此宣称 P1 全部质量门槛完成。
- Claude Code/pi 实际模型12问、真实 Discuss 会话、客户端截断（含 U10 中文字节限制）、第二设备，仍未验证。SDK protocol 与 ToolService 集成测试不是这些外部验收的替代。
- 未重跑全量回归或性能；未审 P5、前端交互/视觉、网关鉴权/看门狗。JS regex 无硬中断是设计已知风险，不另报为本轮回归。
- 因已有 Major，本范围代码门为 FIX；外部质量/客户端门另记未完成，修复 F1/F2 也不会自动使那些门变成 PASS。

## 交接与回滚

请实施者按 F1/F2 最小方向修复并补针对性入口回归；重大修复后按原编号做一次增量终审，不把未改区域扩成反复首审。无实现修改需回滚；本轮唯一项目产物为本报告。临时合成目录已自行清理。运行时 l1 回退可改排序，但不能修复 F1/F2 的适配错误。

## 附录：可复核最小证伪脚本（非项目测试）

复跑命令（cwd=/Users/run.mao/workpace/feishu-sync；读取本报告第一个 js fence）：

~~~bash
node -e 'const fs=require("fs"),cp=require("child_process"); const report=fs.readFileSync("agent-outputs/workflow/20261029-kb-retrieval-mcp/stage-b-review.md","utf8"); const script=report.match(/```js\n([\s\S]*?)\n```/)[1];const r=cp.spawnSync(process.execPath,["--import","tsx","--input-type=module"],{input:script,encoding:"utf8"});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1)'
~~~

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSearchRelease } from './server/tests/helpers/kb-search-fixture.ts';
import { KbQueryService } from './server/src/kb/search/kb-query-service.ts';
import { StandardKbStore } from './server/src/kb/standard-kb-store.ts';
import { AgentToolService } from './server/src/agent/agent-tool-service.ts';
import { KB_SEARCH_SPEC } from './server/src/agent/tool-specs.ts';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-'));
process.env.FEISHU_SYNC_HOME = home;
process.env.FEISHU_KB_RANKER = 'lex-v1';
try {
  const body = '# 规则\n## 暴击\n暴击 伤害' + '完整规则说明'.repeat(40) + '\n## 结算\n暴击 伤害' + '其他完整说明'.repeat(40);
  writeSearchRelease(home, 'r1', [
    ...Array.from({length: 20}, (_, i) => ({path: `系统/${String(i).padStart(2,'0')}.md`, docId: `d${i}`, title: '暴击伤害规则', summary: '规则摘要'.repeat(30), body})),
    {path: 'C#指南.md', docId: 'csharp', title: 'C#指南', body: '# C#\n## 协议\n规则'}
  ]);
  const service = new KbQueryService(home, {prewarm:false});
  const first = await service.search({query:'暴击 伤害', limit:20});
  const second = await service.search({query:'暴击 伤害', limit:20, cursor:first.next});
  const store = new StandardKbStore(home);
  const ui = await store.search(store.readManifest(), '暴击 伤害', 20);
  const tools = new AgentToolService({dataRoot:home, documentsProvider:()=>[]});
  const {token} = tools.createRunContext({runKind:'discuss', outputRoot:home, knowledgeBaseRoot:home});
  const call = async (args) => JSON.parse((await tools.executeTool(token, 'kb_search', args)).content[0].text);
  const builtin = await call({query:'暴击 伤害', limit:20});
  const retry = await call({query:'暴击 伤害', limit:20, cursor:builtin.next});
  console.log(JSON.stringify({total:first.total, firstPage:first.results.length, secondPage:second.results.length,
    storeReturns:ui.length, storeExposesCursor:false, builtinCursor:!!builtin.next,
    specAcceptsCursor:Object.hasOwn(KB_SEARCH_SPEC.parameters.properties,'cursor'),
    passingCursorRepeatsFirst:JSON.stringify(retry.results)===JSON.stringify(builtin.results)}));
  console.log('facade C# path:', (await service.read({path:'C#指南.md'})).releaseId);
  try {await tools.executeTool(token, 'kb_read', {path:'C#指南.md'}); console.log('builtin C# path: success');}
  catch(e) {console.log('builtin C# path:', e.code);}
  console.log('builtin C# docId:', (await tools.executeTool(token, 'kb_read', {docId:'csharp'})).details.path);
  tools.revokeToken(token);
  // Drain scheduled prewarm before removing our own synthetic release.
  await store.queryService.prewarmCurrent();
  await new Promise(resolve=>setImmediate(resolve));
} finally {fs.rmSync(home, {recursive:true, force:true});}
```


---

# 阶段 B 增量终审：F1 / F2 修复核销（终轮）

## 范围与证据基线

- 保留以上首审正文、原始 FIX 结论及复现输出作为历史证据；本节是修复后的最终状态，不覆盖历史。
- 必读上游：`/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/20261029-kb-retrieval-mcp/stage-b-fixes.md`。
- 对照首审已读内容，仅核修复涉及的 Store.search、kb_search spec/执行、splitAnchor、Service.read/内置预查及两份新增入口回归；没有重读未改引擎或扩审 P5 网关/UI。

## 逐编号结论

| 编号 | 结论 | 修复定位与支持证据 |
|---|---|---|
| F1 Major | **关闭；未见修复引入的直接回归** | `server/src/kb/standard-kb-store.ts:188–200` 在同一共享服务、同一 manifest.releaseId、同一 query/limit 下续取预算页，收够所需 top-k 或结果耗尽后返回旧数组契约；因此 HTTP 不必新增分页接口，也不再无声少返。 `server/src/agent/agent-tool-service.ts:513–527` 转发 cursor，续页不注入新 CURRENT 的 releaseId；`server/src/agent/tool-specs.ts:30` 同步 additive 声明 cursor。最小复跑 Store=20、specAcceptsCursor=true、passingCursorRepeatsFirst=false。新增 `server/tests/kb-search-consistency.test.ts:31–60` 对24篇越预算文档验证真实 Store/Hono top20、能力入口无重复续页、切 CURRENT 后仍锚定原版、合并前20与UI一致。 |
| F2 Minor | **关闭；未见修复引入的直接回归** | `server/src/kb/search/outline.ts:58–65` 共用解析器按精确文件→最长已有 path# 前缀→旧规则裁决；`server/src/kb/search/kb-query-service.ts:241` 与 `server/src/agent/agent-tool-service.ts:556` 共同调用，并使用同一版 manifest 的 knownPaths。原先在适配层提前 split 的回归消失；最小复跑内置 path 成功。新增 `server/tests/kb-builtin-query.test.ts:70–85` 四次真实能力调用覆盖 C#、章节中#、多个#的更长文件名及其 anchor，核实正文和元数据归属；原门面围栏/完整性调用链保留。 |

Store 返回完整旧 top-k 后，UI 数组可能大于 MCP 单页预算，这是首审允许的兼容策略，不是绕过 MCP 字符限制：MCP/内置仍返回各自有界页，公共排序与页序一致；UI 并未被改成另一个排序器。未要求或修改前端。

## 增量验证

- 已阅读修复报告及原始日志 `/Users/run.mao/.pi/agent/amagi/data/run-bg/bg-4d46c406.log`：build 产物生成；6文件49项通过（1.60s），其中直接相关4文件为 consistency 4 / builtin 9 / query-service 12 / MCP 10。网关/config的其余测试仅是上游日志内容，不作为本轮扩范围结论。strict tsc 通过沿用修复报告陈述；日志没有单独打印 tsc 命令/成功行，不夸称逐项重跑。
- 本轮实际执行：在仓库根目录，沿用本报告附录首审最小脚本（命令同首审），exit 0；不重跑49项或157项，不写项目测试、不改实现。新的实际 stdout：

~~~text
{"total":20,"firstPage":16,"secondPage":4,"storeReturns":20,"storeExposesCursor":false,"builtinCursor":true,"specAcceptsCursor":true,"passingCursorRepeatsFirst":false}
facade C# path: r1
builtin C# path: success
builtin C# docId: C#指南.md
~~~

其中 storeExposesCursor=false 为旧数组契约的保留，不再是缺陷：Store 已在内部取满所需 top-k。切 CURRENT 与多#细分场景通过阅读真实新增测试及上游通过日志核对，没有冒称本轮逐例亲测。

## 最终判定与保留边界

- F1、F2 均关闭；本次修复及直接影响链未发现新的 Critical/Major/Minor，不新增首审 finding，不启动下一轮自动修复。
- 真实80条质量标注与阈值冻结、Claude/pi实际客户端/模型问答、真实 Discuss 等首审外部未验收项仍未完成。代码缺陷核销不等于这些产品验收门通过，P5仍不在本轮结论内。
- 无实现回滚项；本轮唯一写入为原报告追加本节，原首审文本原样保留。

最终 VERDICT: PASS（仅阶段B代码审核及本轮F1/F2修复核销；不代表未具备外部条件的质量/客户端验收通过）。
