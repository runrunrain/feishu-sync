# 阶段 B 首审修复核销

上游：stage-b-review.md（F1 Major / F2 Minor）；stage-b-evidence.md。Leader直接处理：两项定位明确，默认实现角色模型不可派发，不另换模型。

| 编号 | 处理 | 修改范围 / 行为 | 验证 |
|---|---|---|---|
| F1 Major | 已修 | StandardKbStore.search保留旧UI top-k数组契约，在共享服务上排空所需预算页直到limit；HTTP继续返回兼容数组，不再把16条冒充请求20条。kb_search spec与执行层additive接收cursor，翻页不再用新CURRENT覆盖游标的版本锚定。没有另造排序器。 | kb-search-consistency新增24篇越预算真实Hono/Store/能力入口回归：首屏<20、有next；UI恰好20；内置下一页不重复；中间切CURRENT仍读取原版本；合并前20与UI一致。 |
| F2 Minor | 已修 | outline.splitAnchor新增可选knownPaths，精确文件优先→最长path#前缀→旧规则；公共门面与内置预查均复用该函数。 | kb-builtin-query新增C#指南.md、含多个#的更长文件路径与章节anchor的4次实际能力入口读取，metadata/body准确；原门面相关回归保留。 |

修复仅触及上述Store.search、outline.splitAnchor、Service.read的重复解析消除、AgentToolService的kb_search/kb_read及对应spec/两份测试。不改变ranker/数据格式/权限/网关实现。

## 实际增量验证

server cwd：`npm run build`（含stdio/网关真实CJS bundle）→0；`npx vitest run tests/kb-search-consistency.test.ts tests/kb-builtin-query.test.ts tests/kb-query-service.test.ts tests/mcp-kb.test.ts tests/kb-lan-integration.test.ts tests/config-routes.test.ts`→6文件49项通过，1.60s。strict tsc --allowJs显式覆盖kb-eval/kb-lan-bench和两份集成测试→0。run_bg日志 `/Users/run.mao/.pi/agent/amagi/data/run-bg/bg-4d46c406.log`。

其中网关/config两份是独立C阶段相关验证，不作为本轮复审扩范围理由。复审只核F1/F2修复及直接影响链路，未改区域不重复首审。真实80条/客户端人工问答等外部门槛仍未完成，不能以修复关闭推断通过。
