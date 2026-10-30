# P3 Discuss 真实会话检索闭环报告

## 结论与范围

新增 `server/tests/kb-discuss-integration.test.ts`：从 `SessionService` 显式创建 Discuss / Pi 会话，启动真实 Pi 进程，加载应用转发扩展，通过回环 Hono 内部工具 API 和真实 `AgentToolService` 查询合成的已发布 release。推理服务是回环 OpenAI-compatible SSE **合成 fixture，不是真实 LLM，也不是模型效果验收**；不访问远端模型、真实知识资料或真实凭据。未修改生产代码、共享依赖、ABI、共享模型配置，未提交。

上游输入：`CLAUDE.md`；`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md` §9、§11 P3；`server/tests/provider-protocol-live.test.ts`、`server/tests/app-plugins-live.test.ts`；合成 release 复用 `server/tests/helpers/kb-search-fixture.ts`。已有 `server/tests/kb-builtin-query.test.ts` 只直接调用能力入口，不等价于真实 Pi 转发。

## 验收映射

| 验收 | 证据 |
|---|---|
| 真实会话及转发 | Pi backend 明确为 `pi`、模式 `discuss`；一次提示驱动三次模型工具调用并完成。Hono 旁路观察真实内部 HTTP POST 的请求、状态与响应，不替代路由及执行器；后续推理请求的 tool message 与实际响应正文逐字相等。 |
| search 前缀及 hits | 合成 `战斗/伤害.md` 和同前缀但不同路径段的 `战斗系统/引用.md`；按 `pathPrefix=战斗` 搜索仅命中前者，验证 `fixture-release`、行 3、`战斗/伤害.md#暴击`。 |
| section 与行号 | 透传 `docId=damage, section=暴击 › 技能表, offset=1, limit=3`；服务响应 `releaseId=fixture-release`，正文行 5–7，含表头及 1001，不含引言和护甲。offset 非零同时验证节内分页参数未丢失。 |
| literal grep | 透传 literal、前缀等参数，命中唯一文件行 7，releaseId 一致。未运行 regex。 |
| 能力范围 | 此测试独立构造的工具服务，模型看到的工具列表精确等于 8 个只读 KB/raw 工具；不包含 shell、workspace 写、构建写工具。此 fixture 未注册生产可选 `app_command` 族，**不证明已注册 app_command 时的批准/权限语义**；`raw_read_image` 的缓存行为亦未执行。 |
| 隔离与清理 | `FEISHU_SYNC_HOME` 临时目录；临时 app-llm 配置仅在内存；`finally` 关闭 Pi 池、SQLite、两台回环服务器，恢复环境并删除 fixture 根。未依赖真实 release。 |

## 验证记录

- cwd `server`：`./node_modules/.bin/vitest run tests/kb-discuss-integration.test.ts tests/kb-builtin-query.test.ts`，退出 0；2 文件、10 测试通过，其中真实 Pi 会话 1 项通过。环境 Node v24.21.0，Pi 1.4.0。
- cwd `server`：`npm run typecheck`，退出 0；该项目 tsconfig 只包含 `src`。
- cwd `server`：`./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --esModuleInterop --resolveJsonModule tests/kb-discuss-integration.test.ts`，退出 0，单独覆盖新增测试的类型检查。
- 项目根：`./node_modules/.bin/eslint server/tests/kb-discuss-integration.test.ts`，退出 0。
- 开发中首次运行失败：观察中间件误将 GET tools 请求解析为 JSON，导致 Pi 扩展加载失败；改为只观察 POST。第二次运行失败：将 tool 消息数组 stringify 后匹配未转义 JSON 文本；改为按 tool_call_id 直接比较 content。上述两次是测试自身缺陷，最终针对性验证通过。

## 未覆盖和回滚

未执行全量 check、真实 LLM、真实生产资料、浏览器、regex 或生产完整 server 组装与 app_command 批准流；本测试仅证明所述真实会话链路和合成数据行为。若缺 Node/Pi，测试明确失败而非静默跳过。回滚本任务仅需删除新增测试和本报告；无数据迁移、共享配置或生产代码需回滚。
