# F01–F08 增量复审

VERDICT: FIX

结论：F01/F02/F03（按批准缩范围）/F06/F07/F08 可关闭；F04 部分关闭但引入旧检查点恢复回归；F05 仍有实际参数与默认整合角色未冻结的 Major 缺口。相关测试全部通过，不能替代下述反例。

## 基线与输入

- 工作目录：`/Users/run.mao/workpace/feishu-sync`；`HEAD=4df82e3`，审核时为共享未提交工作树。
- 对照基准：`agent-outputs/workflow/2026-11-01-kb-org-orchestration-dev/diting-final-review.md`（完整读取）。
- T7 声明：`/Users/run.mao/.pi/agent/amagi/artifacts/17f2ae72-d7f7-4acb-b728-a441efb6b346/result.md`（完整读取）。
- 范围：仅上述 findings 的修复实现、直接消费者与相关测试；没有重新终审全量 diff。未将工作树无关改动计入结论。

## 逐项关闭结果

| 原编号 | 状态 | 修复与复核证据 |
|---|---|---|
| F01 | **RESOLVED** | `build-checkpoint.ts:68-116,156-166,193-229`：组织草稿、计划、读取回执、candidate、reviews（含 archive）同代复制并登记 SHA-256；read 在 restore 改动 staging 前验证清单。`kb-build-resume.test.ts:298-345` 实测逐字节恢复及篡改拒绝；seam 主闭环验证已审对象中断恢复后仍为 v2、身份/证据不丢。 |
| F02 | **RESOLVED** | `agent-tool-service.ts:1541-1547,1590` 保存 markdown 坐标偏移；`knowledge-compiler.ts:551-575,598-665` 覆盖 canonical、claims、summary 等呈现、exact 片段解析/展开及服务端锚点。seam 经过真实写工具验证两章节、claims、查询 snippet 不串位；另以纯函数输入覆盖 exact + summary、0/2 个前导空行，均无编译 issue 且发布坐标相同。published 基准直通由 seam 增量验证，既有 v1 发布测试仍通过。 |
| F03a | **RESOLVED** | `agent-tool-service.ts:2408-2426` 回写 machine + reportId；`kb-build-service.ts:3145-3155` 仅有效通过报告触发；`knowledge-validator.ts:205-215` 显式阻断 pending。seam 中断前已有单元机器审凭据，发布后绑定最终报告且 operational 查询为 0。额外真实 `runKnowledgeGates` 取证：`validReportIds=[]`、`reviews=[]`、两个 pending 对象，返回 **2 个 kb_review_pending blocking**，原空集合反例不再放行。 |
| F03b | **RESOLVED（按缩范围）** | `knowledge-validator.ts:24-33,219-238` 与 `workflow.md:61-62` 双处披露高风险缺人审仅 warning、人工决定/desktop 人审入口未实现、无 approved 可达路径；测试实际断言该 warning。未将缩范围本身重报缺陷。工具新建业务状态实为 unknown，建议把“最高 candidate+passed”改成“unknown+passed，未开放人工业务决定”，避免读者误以为已提供 candidate 状态转换。 |
| F04 | **PARTIAL** | 新构建主失败路径已修：`build-orchestration.ts:743-749` 任一角色显式或 confirm 即启用；`kb-build-service.ts:1191-1223` 保持确认屏障。`build-pipeline.test.ts` 空 reviewer+confirm 用例实际停 awaiting_release，确认后发布；设置的保存/回显组件测试通过。但同一谓词直接用于旧检查点，没有冻结旧启用模式，产生 **N01 / Major**，详下。 |
| F05 | **PARTIAL** | 新增 resolvedRoles/specHash、模型 ID/端点/协议漂移拒绝与 resume 同步校验有效（`kb-build-service.ts:511-524,3457-3482`；流水测试已过）。但有效参数仍从实时预设取，且默认整合角色没有冻结条目；两个反例均实际复现，见下 **F05-R / Major**。故不能接受“实际模型及参数已冻结”的完成声明。 |
| F06 | **RESOLVED** | `kb-build-service.ts:819-826` 初始化条件不限制 incremental，**full 同样装载**；`1317-1450` 携带对象/证据/非 canonical 呈现/关系/覆盖/迁移、回执；`agent-tool-service.ts:1941-1951` 同族三元组命中原 ID，`1548-1560` 拒绝托管文档旧式重写，发布前另校验 carriedHash（`kb-build-service.ts:4135` 起）。seam 实测增量未改对象 ID/hash/range 延续、旧式改写拒绝且 CURRENT 不动、换 clientKey 纯重申 revision=1。full 的身份初始化+匹配为静态路径确认，**没有完整 full→full 的独立运行证据**。 |
| F07 | **RESOLVED（原反例）** | `knowledge-compiler.ts:185-209` 保存围栏字符与长度，只以同字符、足够长度、空白尾部闭栏；validator 复用同一实现。四反引号中三反引号与 include 示例的原失败输入已由 publish/seam 测试通过。非本轮新增的 info-string 边界见遗留观察。 |
| F08 | **RESOLVED** | `knowledge-schema.ts:438-462` claim 范围减 canonical 起点参与 hash；schema/seam 测试证明整体平移不改 hash，正文/风险等语义变化仍会改 hash。未见本轮改变已发布 v1 路径。 |

## 未关闭项与修复引入回归

### F05-R｜Major｜参数未冻结，默认整合者还可静默换模型

- **定位**：`server/src/kb/orchestration-contracts.ts:53-64`；`server/src/kb/build-orchestration.ts:152,164-170`；`server/src/kb/kb-build-service.ts:3434-3482,3494-3535,2170-2194`；`server/src/agent/provider-descriptor.ts:53-80`。
- **触发 A**：启动后原位修改同一预设的 maxTokens/contextWindow/reasoning/thinkingLevels，或修改角色未覆盖的全局 thinkingLevel；然后派发新任务或恢复构建。
- **实际影响**：resolvedRoles 未保存多数有效参数；mismatches 只比 modelId/providerId/baseUrl/protocol，连已存 thinking 都不比。运行 descriptor 仍由实时配置构造，spawn 的默认 thinking 也来自当前配置。specHash 保持原值但请求参数变化；resume 使用同一个 mismatches，亦不会拒绝这些变化。
- **已复现**：冻结 reviewer.thinking=`off` 后，把同预设 maxTokens 从 8192 改 1234、全局 thinking 改 high：`frozenRoleMismatches=[]`；真实 `resolveRoleModel('b','review').providerJson` 中 maxTokens 变为 **1234**。未启动模型进程；thinking 注入变化由 spawn 代码路径确认。
- **触发 B**：integrator 未配置（UI 的正常“跟随撰写”），在写审完成后改写撰写预设的实际模型，再启动整合。
- **实际影响 / 已复现**：buildSpec 只在 integratorConfig 存在时生成 frozen integrator。resolveRoleModel 虽把缺省整合配置回落 writer，却仍取 `resolvedRoles.integrator`；为空便跳过校验。真实运行：writer/reviewer 冻结为 `before`，把同预设改成 `after` 后，mismatches 已能报告 writer/reviewer 漂移，但 `resolveRoleModel('b','integrate')` **仍成功返回 `feishu-sync-llm/after`**。恢复入口会拦此种模型 ID 漂移，但正在运行的整合派发不会；参数变化则两入口均漏。
- **最小修复方向**：冻结经默认值展开后的完整非密钥有效 descriptor 与 thinking；三角色都冻结（缺省整合者绑定 writer 的冻结结果），派发使用冻结值或完整校验失败，动态来源只保留凭据。补启动后参数变更、默认整合者模型变更与恢复参数变更三个针对性回归。
- **归因**：原 F05 的未关闭路径，不另算无因果新发现。

### N01｜Major｜F04 改谓词把旧流水检查点切进新调度器

- **定位**：`server/src/kb/build-orchestration.ts:743-749`；`server/src/kb/kb-build-service.ts:991,1471-1474,2747-2754,3549-3551`。
- **触发**：T7 前的合法检查点具有 writer 显式、reviewer 空值（或 confirm），当时按旧路径运行；检查点保存旧任务 `t:u1`，其中某任务中断时 running，恢复归一后 queued。
- **失败路径**：旧 spec 无独立“启用新流水”版本/标记；restore 后新谓词立即为 true。seed 添加新 `t:write:u1:r0`，却不移除/迁移旧 `t:u1`；readyTasks 仍会返回旧 queued 任务。新执行器只接受轮次化 ID，最终报 `kb_pipeline_invalid`。即使旧任务均已终态，也会额外启用此前没有的审查/整合流程，违背旧构建保持旧流程承诺。
- **已复现**：用无 resolvedRoles 的旧形状 BuildSpec 建 `t:u1`、置 running、serialize→restore，输出 `newPipeline=true, restoredExecState=queued`；把该任务交给真实 `runOrchestratedTaskOnWorker`，得到 **`kb_pipeline_invalid: 编排任务 id 无法解析：t:u1`**。这是内存级真实谓词/恢复/执行器取证，不宣称跑过 HTTP 恢复集成。
- **最小修复方向**：给新构建冻结显式 pipeline 模式/版本；无该标记的旧快照按旧门控语义恢复（或设计明确迁移且完整迁移任务，但不能静默改变）。补旧 writer-only/confirm 检查点、含 running 旧任务的恢复回归。
- **归因**：F04 修复新引入的兼容回归；F04 因此仅部分关闭。

## 可复核的无写盘取证

均在 `server/` 下用 `node --import tsx --input-type=module` 内联执行，退出 0。为遵守“唯一可写报告”边界，脚本不另落文件。以下为 F05 两反例的最小重跑片段（所有值为合成 fixture，无真实凭据）：

```js
import { KbBuildService } from './src/kb/kb-build-service.ts';
import { buildSpecFromConfig } from './src/kb/build-orchestration.ts';
const config = {
  agent: { runtime: { backend: 'pi' }, model: { source: 'app-llm', thinkingLevel: 'off' } },
  llm: { activeProviderId: 'p', activeModelId: 'm', providers: [{
    id: 'p', name: 'p', enabled: true, protocol: 'openai-completions',
    openAiCompatBaseUrl: 'https://example.invalid/v1', apiKey: 'fixture',
    models: [{ id: 'm', openAiModel: 'before', enabled: true, contextWindow: 128000, maxTokens: 8192, reasoning: true }],
  }] },
  standardKb: { buildRoles: { writer: { modelPresetId: 'm' }, reviewer: { modelPresetId: 'm' } }, publishMode: 'confirm' },
};
const svc = Object.create(KbBuildService.prototype);
svc.deps = { configProvider: () => config }; svc.active = new Map();
const spec = buildSpecFromConfig({ buildId: 'b', snapshotEntries: [], baseReleaseId: null,
  standardKb: config.standardKb,
  resolveRoleModel: ({ config: r }) => svc.describeRoleModel(config, r, 'v1') });
svc.active.set('b', { backend: 'pi', orchestration: { spec } });
config.llm.providers[0].models[0].maxTokens = 1234;
config.agent.model.thinkingLevel = 'high';
console.log(svc.frozenRoleMismatches(config, spec)); // []
console.log(JSON.parse(svc.resolveRoleModel('b', 'review').providerJson).models[0].maxTokens); // 1234
config.llm.providers[0].models[0].openAiModel = 'after';
console.log(svc.resolveRoleModel('b', 'integrate').model); // feishu-sync-llm/after
```

N01 的内存重跑片段：

```js
import { KbBuildService } from './src/kb/kb-build-service.ts';
import { BuildOrchestration, buildSpecFromConfig, reviewPipelineActive } from './src/kb/build-orchestration.ts';
const spec = buildSpecFromConfig({ buildId: 'old', snapshotEntries: [], baseReleaseId: null,
  standardKb: { buildRoles: { writer: { modelPresetId: 'm' }, reviewer: { modelPresetId: '' } }, publishMode: 'auto' } });
const o = new BuildOrchestration(spec);
o.createTask({ taskId: 't:u1', revision: 0, role: 'write', unitId: 'u1',
  inputRefs: [], dependencies: [], allowedWritePaths: [], outputRequirements: 'legacy' });
o.updateExecState('t:u1', 'running');
const restored = BuildOrchestration.restore(o.serialize());
console.log(reviewPipelineActive(restored.spec)); // true，旧谓词应为 false
const svc = Object.create(KbBuildService.prototype);
try { await svc.runOrchestratedTaskOnWorker({ task: restored.task('t:u1') }, {}); }
catch (e) { console.log(e.code, e.message); } // kb_pipeline_invalid
```

## 验证可信度与接缝测试

### 本轮实际运行

1. `server/`：`npx vitest run tests/knowledge-seam.test.ts tests/knowledge-publish.test.ts tests/knowledge-schema.test.ts tests/kb-knowledge-tools.test.ts tests/kb-build-resume.test.ts tests/build-pipeline.test.ts tests/build-orchestration.test.ts` → **退出 0，7 文件 / 191 测试通过**。
2. 仓库根：`npm test -- src/components/settings/BuildOrchestrationSettings.test.tsx src/components/settings/BuildOrchestrationSettings.draft.test.tsx` → **退出 0，2 文件 / 16 测试通过**，存在 act 环境警告。
3. `git rev-parse --short HEAD`、`git status --short`、`git diff HEAD --stat`、`git diff HEAD --check`；check 退出 0。
4. 三次内联 Node 取证（F05；F02/F03/F04/F07；N01 执行器），均退出 0。N01 命令后曾误在 server cwd 调前端测试，得到 **No test files found / 退出 1**；定位为 cwd 错误后改在根目录运行，结果见第 2 项，不计作代码失败。

### seam 是否真实

`knowledge-seam.test.ts` 主闭环使用 `KbBuildService.createBuild/resumeBuild`，fake RPC 经 run token 调 **`AgentToolService.executeTool`** 的 raw_read、kb_write_doc、kb_submit_review；实际 SQLite/临时源文件、checkpoint、compiler、release/CURRENT、query 同链路，没有手工替换草稿登记来绕过工具。恢复后报告 ID、objectId、证据、发布坐标与查询 snippet 均有断言，属于有效接缝证据。

限制：RPC 与审查结论是 fixture，不能证明模型审查质量；seam 的 F04/F05 锚点本身只是 spec 级检查，真正 confirm 行为在 build-pipeline 用例，F05 参数及默认整合回归未覆盖。seam full 起始构建后只测后继 incremental，没有 full→full 场景。F02 exact/summary 额外取证是编译纯函数，不冒称这两类也经过了完整模型工具链。

## 遗留观察与盲区（不新增阻断）

- 围栏的 backtick info string 仍未遵循 CommonMark：`FenceTracker.visit('```bad`info')` 后 inside=true，实际这种 info 含反引号的行不应开栏。该语义在旧简化状态机也存在，未认定为 T7 回归；原 F07 四反引号失败已解决。本项建议后续处理，不改变本轮 F07 关闭结论。
- `workflow.md:65` 仍把“增量构建基线对象复制”列为未做，与 T7 新披露矛盾；建议同步清理该旧清单。F03b 的人审/人工决定缺口则披露准确且双处一致。
- checkpoint 仅保留当前/上一代成功快照，新产物数量有上限，未看到新引入的无限成功代堆积；但每次仍同步全量复制回执/报告，未做大库字节量、磁盘占用或延迟测量，不宣称解决性能上限。
- 未重跑全量 check/lint/typecheck，不把 T7 报告的全量通过当成本轮实测；未启动真实模型、浏览器/Electron，未碰真实数据根。旧配置全空+auto 仍走旧路径，相关兼容测试通过，但这不能覆盖 N01 的旧 writer-only 快照。
- F01 哈希验证是产物相对清单的完整性检查，不宣称能够抵御同 UID 攻击者同时改写清单及内容的认证攻击。
- 唯一人工写入为本报告；没有修改源码、测试、配置或提供修复 patch。回滚仅需由 Leader 移除本报告，无项目代码回滚动作。

VERDICT: FIX
