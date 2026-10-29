# 集成回归：两项失败定位与修复

## 输入与范围
- 上游失败日志：`/Users/run.mao/.pi/agent/amagi/data/run-bg/bg-b5cb9d8a.log`，仅按两条失败定位；原日志没有输出 Pi 会话 lastError。
- 上游任务设计：`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`；本轮只处理任务书指定的直接回归，未复核整体设计实现。
- 读取 `CLAUDE.md`、两项测试、`server/src/agent/path-guard.ts`、`session-service.ts` 相关调用、`runtime-resolver.ts`、`pi-rpc-process.ts`、`pi-plugin-service.ts`。未修改生产代码或任何模型/认证配置。

## 根因与修改
1. **系统目录断言与 macOS 别名冲突**：当前机器 `/etc` 为 symlink，realpath 是 `/private/etc`；`validateWorkspacePath` 先 `lstat` 并拒绝最终路径为 symlink，故返回 `workspace_path_invalid`，与原测试对 `/etc` 必须返回 `workspace_path_forbidden` 不符。原失败在两文件隔离复现，不依赖全量并发。修改 `server/tests/path-guard.test.ts`：保留符号链接 invalid 断言，对真实系统目录及其确实存在的子目录分别断言 forbidden；不更改或放松生产围栏。原测试来源最近提交 `772e8fe`，不能仅凭本次集成日志推断检索改动引入。
2. **插件测试选错会话后端**：原测试创建会话未指定 backend；当前 `types/agent-knowledge.ts` 默认 `claude-code`，`SessionService.create` 沿用默认并写入会话，`configForSession` 按会话后端选择运行器。隔离复现相同 `releaseFirst` 等待失败，在测试失败信息中读取会话 lastError 得到 `agent_not_ready: Claude Code 需要可执行文件以及已配置密钥的 Anthropic 兼容模型`，因此没有发出本地 Pi fixture 的 HTTP 请求。原日志没有 lastError；该复现解释当前同条件失败，但不是从原日志独立证明当时的内部状态。测试文件最近提交 `59a76fa`，会话实现最近提交 `4229fa3`；不能归咎于检索/网关改动。修改 `server/tests/app-plugins-live.test.ts`：会话显式 `backend: 'pi'` 并断言后端，失败提示包含真实 lastError；不加 timeout、不 skip、不改模型或生产默认值。
3. **Pi/PATH/插件核验**：本机 `command -v pi`、`command -v node` 均可达，Node v24.21.0；修复后真实 Pi + 本地 HTTP 模型 fixture 的原测试通过（1 passed，非 skipped），包括本地原生扩展工具调用、插件快照变化、重启与复用。进程代码对 app-llm 使用应用私有 pi-home、`--no-extensions` 后显式加载应用扩展；本轮不读取或变更全局插件和凭据，也不据此断言其他 Pi 模式不受全局环境影响。

## 验证
- 修复前，cwd `server`：`FEISHU_SYNC_HOME="$(mktemp -d -t fs-regression-before)" npx vitest run tests/path-guard.test.ts tests/app-plugins-live.test.ts`，退出 1，21 passed、2 failed，复现原两项。
- 诊断阶段，同目录以临时 `FEISHU_SYNC_HOME` 运行同两文件：退出 1，22 passed、1 failed；失败信息明确上述 Claude 后端 lastError。
- 修复后，cwd `server`：`FEISHU_SYNC_HOME="$(mktemp -d -t fs-regression-after)" npx vitest run tests/path-guard.test.ts tests/app-plugins-live.test.ts tests/protected-workspace.test.ts`，退出 0，3 文件 / 32 测试全部通过（包括真实 Pi 运行和运行资源围栏直接回归）。
- cwd 项目根：`FEISHU_SYNC_HOME="$(mktemp -d -t fs-regression-typecheck)" npm run typecheck`，退出 0，根及 server 类型检查通过。
- cwd 项目根：`npx eslint server/tests/path-guard.test.ts server/tests/app-plugins-live.test.ts` 与 `git diff --check -- server/tests/path-guard.test.ts server/tests/app-plugins-live.test.ts` 均退出 0。

## 改动、未覆盖与回滚
- 改动：`server/tests/path-guard.test.ts`、`server/tests/app-plugins-live.test.ts`；报告为本文件。未改 `path-guard.ts` 或其他生产代码，未 commit。
- 未运行全量 `npm run check`，由 Leader 统一执行；未在 Windows/Linux 实机复核；也未验证真实远端模型或全局 Pi 插件配置。原日志不记录 Pi lastError，故对原轮内部原因的归因以同条件复现支撑而非原日志直接证明。
- 回滚：仅在两个测试文件局部撤销本报告描述的断言/诊断改动；删除本报告需遵循现场授权及文件管理规则。不使用 Git restore/reset，不触碰并行工作区改动。
