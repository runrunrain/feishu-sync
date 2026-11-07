# Claude Code 运行时

Claude Code 是 Agent 基座的第二选项（`agent.runtime.backend = 'claude-code'`，缺省 `'pi'`），与 pi 运行时并列驱动对话、Work、任务子进程与 legacy 构建 worker。实现集中在 `server/src/agent/` 下五个文件：`claude-runtime.ts`（发现与提供商解析）、`claude-code-process.ts`（进程适配）、`claude-process-factory.ts`（组装）、`claude-connection-test.ts`（连接测试）、`claude-bridge.cjs`（stdio 工具桥），以及 `runtime-resolver.ts` / `session-service.ts` 的接入段。

## 适用范围

- 会话可逐个选基座（`agent_sessions.runtime_backend`；新建会话不指定则跟随应用配置，`server/src/agent/session-service.ts:196`）。
- pi-amagi 构建编排**不支持** Claude Code：`orchestrationMode='pi-amagi'` 需要 pi 基座，Claude Code 下创建即 400（`server/src/kb/kb-build-service.ts:791`）；`claude-native` 编排模式已废弃、显式传入即 400（`:786`）。legacy 编排的 worker 可用 Claude Code（`:4125`、`:4348`，ephemeral 进程）。

## 发现、校验与安装

发现顺序（`claude-runtime.ts` `resolveClaudeCodePath`）：配置的 `agent.runtime.claudeCliPath` → 应用自管安装 `<dataRoot>/agent/runtimes/claude-code/node_modules/@anthropic-ai/claude-code/bin/` → `~/.local/bin/` → Node 候选目录 → PATH。Windows 的 `.cmd` shim 不解析内容，直接定位同包 `claude.exe`。

可用性校验 `inspectClaudeCode`：`--version` 取版本，`--help` 必须包含 `--bare`、`--strict-mcp-config`、`--tools`、`--permission-mode`、`--output-format`、`--mcp-config`、`--system-prompt-snapshot` 与 `--append-system-prompt-file`——缺任一判定不支持，提示更新。

安装走 `RuntimeInstaller.install('claude-code')`（`server/src/agent/runtime-installer.ts`）：应用自管 npm 前缀安装 `@anthropic-ai/claude-code@latest`（`--ignore-scripts`，装后执行包内 `install.cjs` 完成收尾，再校验 supported），不改用户全局包；配置了自定义路径时拒绝代为更新。选择 Claude 基座后启动 `ensureMissing` 会同时确保 pi（构建插件仍依赖 pi）与 claude。手动触发：`POST /api/agent/runtime/update {backend}`（`server/src/routes/agent.ts`）。

## 模型要求

- 只用应用内提供商：模型 `source` 必须为 `app-llm`，协议必须 `anthropic-messages` 且已配置 API Key（`claude-process-factory.ts`；`routes/agent.ts:198-204` 同口径）。`resolveClaudeProvider` 先按 anthropic-messages 解析，退回通用解析（`claude-runtime.ts`）。
- 认证类型 `api-key`（`ANTHROPIC_API_KEY`）或 `auth-token`（`ANTHROPIC_AUTH_TOKEN`），随提供商配置（`claude-code-process.ts` `buildClaudeEnvironment`）。
- 思考档位不支持 `minimal`（创建即 400，`claude-process-factory.ts`）；可选档位由 `thinking-capabilities.ts` 对 claude-code 过滤 minimal 得出。

## 就绪码

`runtime-resolver.ts:411-426`（类型表 `server/src/types/agent-knowledge.ts` `ReadinessCode`）：

| 就绪码 | 含义 |
|---|---|
| `node_missing` | 工具桥需要 Node ≥22.19（桥进程由 Node 拉起） |
| `claude_missing` | 未找到可执行文件（安装或填写 `claudeCliPath`） |
| `claude_spawn_failed` | 无法运行，或版本缺安全运行所需参数 |
| `claude_protocol_unsupported` | 所选提供商不是 Anthropic Messages 兼容 |
| `model_unconfigured` / `model_auth_missing` | 未选应用内模型 / 提供商缺 Key |

连接测试 `POST /api/agent/claude/connection-test`：ephemeral 探针进程、无工具、固定提示词（"Reply with exactly OK"）、30 秒超时，返回延迟与脱敏错误（`claude-connection-test.ts`）。

## 进程模型与工具桥

**进程**（`claude-code-process.ts`，`ClaudeCodeProcess extends PiRpcProcess`）：每次 prompt spawn 一次 Claude Code，核心参数 `-p --bare --tools '' --strict-mcp-config --mcp-config <tmp>/mcp.json --permission-mode dontAsk --allowedTools mcp__feishu_sync__<工具名列表> --output-format stream-json --model <model>`。Claude 自身内置工具全部禁用，唯一工具面是本应用 MCP 桥。会话身份：首次 `--session-id <sha256 派生 UUID>`，此后按 marker 文件 `--resume`。`CLAUDE_CONFIG_DIR` 指向每会话独立 home（`<sessionDir>/claude/<hash>.home`；构建 worker 与探针用 `ephemeral` 独立目录）。环境变量白名单透传（PATH/HOME/代理/证书等），`ANTHROPIC_BASE_URL` 与 `ANTHROPIC_MODEL`、默认 haiku/sonnet/opus 与 subagent 模型统一指向所选预设（后台辅助请求不漂移到未配置模型）；遥测与自动更新全部关闭。prompt 超时 = `standardKb.promptTimeoutMinutes`（默认 15 分钟）或调用方显式值，兜底 900s。

**工具桥**（`claude-bridge.cjs`）：极简 stdio MCP server，把 `tools/list`/`tools/call` 转发到回环 `/api/agent-internal/*`，携带 `X-Agent-Run-Token`（构建链路优先 `FEISHU_SYNC_BUILD_MCP_*` 环境变量）。全部裁决权在服务端 `AgentToolService`（令牌 → `allowedTools` → PathGuard，见 [security-model.md](security-model.md)）；桥透传 Claude 的 `_meta['claudecode/toolUseId']` 作为 toolCallId（应用按消息链回溯身份）。桥声明 `tools.listChanged` 并在受信身份存在时两段式观测工具面变化（快窗 250ms×30s，之后自退避低频段），迟到确认仍可刷新，令牌失效即停止观测。

**权限映射**：Claude 侧固定 `--permission-mode dontAsk`，不使用 Claude 自身权限系统；`app_command` 的 mutate/destructive/remote_write 仍走应用内逐次批准流（会话 SSE `approval_request`），与 pi 基座一致。

## 与 pi 运行时差异

| 维度 | pi | Claude Code |
|---|---|---|
| 进程模型 | 常驻 JSONL RPC，多轮复用 | 每次 prompt 一个子进程，流式 JSON 输出 |
| 运行中插话 / 排队 | 支持 steer / follow_up | 不支持（提示等待本轮完成，`sendCommand` 明确拒绝） |
| 模型来源 | 应用内提供商或 pi 自身认证 | 仅应用内 anthropic-messages 提供商 |
| Work 会话 | 可不选工作目录；可开「本机资源」 | 必须选择工作目录；本机资源不可用（仅 Pi Work，`session-service.ts:294`） |
| 原生插件 | 注入（includeNative） | 不注入（快照 `includeNative:false`，`session-service.ts:512`） |
| 构建编排 | pi-amagi（默认）与 legacy | 仅 legacy worker；pi-amagi / claude-native 拒绝 |
| 思考档位 | off..max 全档 | 无 minimal 档 |
| 会话历史 | pi JSONL 树（真相源） | 应用侧 `<sessionDir>/claude/<hash>.jsonl`（user/assistant/toolResult 链）+ Claude 私有诊断 JSONL 只读监测 |

**历史与会话记录**：应用把用户消息、助手消息与工具结果摘要 append 到自有 history JSONL（0600），恢复经 `--resume`；`claudeFatalApiError` 周期读取 Claude 私有 projects JSONL，识别 400/401/403/404 `api_error` 提前终止本轮并给出脱敏错误（Key 与运行令牌替换为 `[redacted]`）。

## 相关文档

- [security-model.md](security-model.md)：运行令牌、工具裁决与批准流。
- [agent-knowledge.md](agent-knowledge.md)：会话与工作台使用说明。
- [troubleshooting.md](troubleshooting.md)：`claude_*` 就绪码与连接失败排查。
