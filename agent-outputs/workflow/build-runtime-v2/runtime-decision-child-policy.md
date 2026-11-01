# 真实能力核查增补：子任务防御扩展

## 实测差异
设计v2 §3.3/13.1要求子任务模型实际工具面没有自动启用的codemode/tool_search。真实Pi+amagi2.21.31（929000e）探测发现：即使MCP autoEnableCodemode=false，child仍包含codemode。

源码核实：
- amagi `task-permission.ts:690`：backend.codemodeComposition=true时，grant.tools加入codemode。
- `task-run.ts:resolveSpawnPermissionDelivery`：最终派发工具再次加入codemode与toolcall_continue。
- 这是amagi本身的普通组合工具面，不是MCP的自动激活。删除scope.codemode或修改MCP开关不能解决。
- 真实probe run4已验证临时敏感sentinel的read/grep被deny、内容未泄漏；该证据不等于所有MCP/取消/恢复能力均通过。

## 选择
采用应用owned child-policy扩展，不修改amagi上游、不新增调度器。构建home的settings.packages仍只声明固定amagi；settings.extensions显式声明应用物化的防御扩展。

该扩展只过滤子任务的实际active工具声明并在tool_call拒绝禁用调用，不注册业务工具、不激活额外权限、不引入shell、不接管派发，知识读写仍走应用MCP。Leader显式--no-extensions不自动发现它；子任务通过同一专用agentDir正常加载。

它是新增受信执行组件，必须纳入内容hash、配置冻结、加载前核验与禁改保护。不能称“卸载工具”，交付口径为“active工具面过滤+调用拒绝”。

## 未采用
- 保留codemode并直接标探测通过：工具面明确偏离，拒绝静默降低验收。
- 只因codemode存在即宣称OS权限逃逸：codemode继承同一grant，并无该证据。
- 修改amagi源或派发外层调度器：违反本方案核心约束。
- 永久只保留不可启动入口：不满足主上完整实现目标；若防御扩展不能失效关闭，仍需禁用新模式而非假通过。

## 专家依据与落实
Advisor `advisor-b5bf6677-ff2c-4c3f-bcfa-30a81bc1e2b1` 建议C可执行，不破坏单Leader/固定amagi/无shell/知识MCP不变量，但必须验证实际child而非UI隐藏。首个咨询因isolated带contextRefs失败已取消，未视为有效建议。

任务20d7aaeb（build-v2-child-policy）负责实现，独占child-policy.ts/agent-dir-config.ts与对应测试。主链与probe继续并行，不在验证通过前标完成。

## 必须验证
1. Leader未加载、每个真实child加载预期hash；首轮与后续轮模型definitions无禁用工具。
2. 强制调用、动态重激活、toolcall_continue续接路径无绕过或副作用。
3. MCP正常知识任务、角色权限与报告读写仍工作；不同child/恢复轮维持同一策略。
4. policy缺失、hash错误、加载异常、settings资源字段被篡改，执行前fail-closed。
5. 不允许任务改变policy与加载配置；文件围栏仍不是OS沙箱，不宣称同uid外部代码被隔离。
