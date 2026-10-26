# Agent 标准知识库设计调研报告（D1）

- 任务：D1 公共方向设计（设计态，只写设计 artifact）
- 产物：`docs/design/agent-knowledge-design.md`（公共契约）、本报告（证据与取舍）
- 上游输入：`docs/plans/agent-knowledge-workflow.md`、项目 `CLAUDE.md`、pi 1.4.0 安装包文档与类型声明、trade-wisdom 源码（只读）、`~/.agents/skills/planner-doc-style/SKILL.md`
- 写入范围：仅上述两个文件；未改业务代码、配置、依赖；未读取任何凭据文件内容；未运行或修改 trade-wisdom。

## 1. 环境事实（实测）

| 项 | 结果 | 证据 |
|---|---|---|
| 本机 Node | v24.21.0（fnm） | `ls ~/.local/share/fnm/node-versions` |
| pi 版本 | 1.4.0 | `node <pi>/dist/cli.js --version` → `1.4.0` |
| pi engines | `node >=22.19.0`；依赖 pi-ai / pi-agent-core / pi-mcp 1.4.0 | pi `package.json` |
| `pi` 命令 | 指向 `.../pi-coding-agent/dist/bundle/cli.js`，shebang `#!/usr/bin/env node` | `ls -la $(command -v pi)` |
| feishu-sync Electron | 31.7.7（`node_modules/electron/dist/version`），内置 Node 20.18，modules 125 | 文件实读 + Electron 发布表 |
| server 运行位置 | Electron 主进程内 `import()` `server/dist/index.js` | `electron/main.ts` |
| 打包 | `asarUnpack: server/**`；`npmRebuild:false`；未配置 Electron fuses | `electron-builder.config.cjs`（grep `fuse/RunAsNode` 无命中） |
| MCP SDK | `@modelcontextprotocol/sdk` 1.32.2，`engines.node >=18` | `npm view` |

推论：pi 无法在当前 Electron 内嵌 server 中 import；需外部 Node ≥22.19 进程。

## 2. pi RPC 侧车冒烟（隔离目录，未触碰用户凭据）

环境：`/tmp/fs-pi-smoke.M0x4`，`PI_CODING_AGENT_DIR` 指向其中空的 `agent/`（pi 自建空 `auth.json`、`models-store.json`），`PI_OFFLINE=1`；启动参数 `--mode rpc --offline --no-approve --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --no-mcp -e <ext> --tools <list> --session-dir <dir> --session-id <id>`，由 Node 驱动脚本 `spawn(node, [pi/dist/cli.js, ...])` 并按 JSONL 收发。

| 实验 | 结果 | 设计结论 |
|---|---|---|
| E1 无凭据 + 自定义工具扩展：`get_state` / `get_available_models` / `prompt` | `get_state` 成功（model `unknown/unknown`，含 sessionFile/sessionId 等 11 个字段）；可用模型 0；`prompt` 返回 `success:false`，错误 `No API key found for the selected model.` | 无模型可在不调用模型的情况下诊断；失败路径诚实 |
| E1 附带 | `--session-id` 新建时 stderr 警告"No project session found…creating"；sessionFile 路径已给出但文件在首条消息前未落盘 | 首条消息后再回填 `pi_session_file` |
| E2 扩展在 `session_start` 写出 `pi.getAllTools()` / `getActiveTools()` | `node: v24.21.0`，`all: ["ws_read","ws_edit"]`，`active` 同；扩展从 `/tmp` 用 `import ... from "@earendil-works/pi-coding-agent"` 成功（pi 的 jiti 别名生效） | `--no-extensions` + `-e` + `--tools` 下进程内不存在内置工具 |
| E3 扩展 `registerProvider`（`apiKey: "$FS_PI_TEST_KEY"`，baseUrl 指向不可达端口），`--model feishu-sync-llm/glm-test --no-tools --no-session` | 无该环境变量：可用模型为空，`prompt` 失败 `No API key found for feishu-sync-llm.`；有变量：模型可用，`prompt` 返回 `success:true`，随后事件 `agent_start … agent_end auto_retry_start …` 循环重试 | app-llm 方案可行且 key 只走环境变量；`prompt` 成功仅表示已接受，完成判定须看 `agent_settled` 与 stopReason，并限制重试次数 |

未覆盖：真实模型下的工具调用往返（无可用凭据，按纪律未读取 `~/.pi/agent/auth.json`）；纯 JSON Schema 工具参数的执行期校验（已从 `pi-ai/dist/utils/validation.js` 看到按 JSON Schema `type` 校验、TypeBox Kind 可选，结论为"预期可用"，列为 F1 首个验证项）。

临时目录 `/tmp/fs-pi-smoke.M0x4` 为本任务自建测试文件（驱动脚本、测试扩展、空 agentDir），删除被守卫拦截后保留，可由 Leader 处置。

## 3. pi 文档要点（1.4.0 安装包）

- `docs/security.md`：pi 以启动用户的系统权限运行，无内置沙箱；项目信任不限制工具访问 → 内置工具不暴露给任何会话。
- `docs/cli.md`：`--tools` 白名单、`--no-tools`、`--no-builtin-tools`、`-ne` 后显式 `-e` 仍加载、`--no-context-files`、`--no-approve`、`--offline`、`--session-dir/--session-id`。
- `docs/rpc.md` / `rpc-commands.md`：命令集合含 `bash`（可直接执行 shell，绕过工具白名单）→ 宿主必须做命令白名单。`RpcClient` 类存在，但需要 `cliPath`，且由 server（Node 20）import 会触发 pi 包的 engines 问题，因此自行实现 JSONL 客户端（协议简单：一行一个 JSON，`response` 带 `id`）。
- `docs/rpc-extension-ui.md`：对话类 UI 请求会阻塞直到客户端响应 → 宿主统一回 `cancelled`。
- `docs/json.md`：事件 `message_update.assistantMessageEvent.text_delta`、`tool_execution_start/end`、`agent_settled`、`auto_retry_*`、`extension_error`。
- `docs/extensions.md`：factory 可异步且 pi 等待；`tool_call` 可 `{block:true}`，handler 异常即阻断（fail closed）；`agent_end` 不是最终空闲信号。
- `docs/session-format.md`：JSONL v3，首行 header，entry 带 `id/parentId` 树结构；工具装载变化以 system 消息持久化 → 模式切换天然可审计。
- `docs/models.md` / `custom-provider.md`：`registerProvider` / `models.json` 的 `apiKey` 支持 `$ENV` 插值。
- `docs/environment-variables.md`：`PI_CODING_AGENT_DIR`、`PI_OFFLINE`、`PI_SKIP_VERSION_CHECK`、`PI_TELEMETRY`。
- 类型声明：`createRead/Write/Edit/Grep/Find/LsToolDefinition` 接受 Operations 注入；但 grep/find 仍调用 ripgrep/fd 自行遍历，Operations 只覆盖部分文件访问 → 不用它们做路径围栏，Work 工具全部由 server 实现。

## 4. trade-wisdom 参考（只读）与差异

| trade-wisdom 做法 | 本设计 | 原因 |
|---|---|---|
| `piLoader.ts` 运行时从全局 npm 安装 import pi SDK（`TW_PI_PATH`、npm root -g 等） | 同样的发现思路，但以 RPC 子进程运行 | trade-wisdom 后端运行于 Node ≥22（Tauri 外置 Node）；feishu-sync server 运行在 Electron Node 20 |
| `runtime.ts` 复用 `~/.pi/agent` 凭据，不加载用户扩展/skills/AGENTS.md，禁用全部内置工具，只给自定义 KB 工具 | 采用同一隔离原则；凭据默认走应用已有 LLM 配置，复用 pi 凭据为显式 opt-in | feishu-sync 已有用户配置的 provider；避免默认读写用户 pi 目录 |
| `archiver.ts` 单并发队列 + 工具 `search/get/update/create/link_knowledge`、`finish_archive` | Build 运行类型的工具集（`raw_*`、`draft_*`、`kb_write_doc`、`kb_finish`）+ 全局单构建 | 增加 staging/校验/原子发布与来源快照，满足"失败不发布半成品" |
| `index.ts` 回环 Host 校验 + 非 GET 的 Origin 同源校验；`streamSSE` 推送；前端 `getReader` 读流 | 内部工具 API 采用回环 + 令牌 + 拒绝 Origin；SSE 用 `streamSSE` + fetch 读流 | feishu-sync 已有 desktop token，EventSource 无法带头 |
| thinking 级别按模型能力钳制 | `--thinking` 由 pi 自行钳制（cli.md 写明会 clamp） | 无需重复实现 |

## 5. feishu-sync 现状与接入点

- `server/src/index.ts`：DI 中间件把模块挂到 `c` 上（实际写法为 `(c as any).x = ...`，非 `c.env`；CLAUDE.md 描述有偏差，新模块沿用实际写法）；health 在 auth 之前；错误体 `{ error, message }`。
- `routes/*`：既有路由清单已核对（config/detect/sync/feishu/mapping/content/trash/custom-folders/orphan-files/llm/health），新路由 `/api/agent/*`、`/api/kb/*`、`/api/agent-internal/*` 无冲突。
- `types/index.ts`：`Config`、`LlmConfig`（providers / activeProviderId / activeModelId / openAiCompatBaseUrl）——app-llm 模型来源直接复用。
- `modules/data-root.ts`：所有落盘路径经 `resolveDataRoot()`。
- `modules/lark-cli-client.ts`：`getNodeRuntimeCandidateDirectories()` / `findExecutableOnPath()` 已导出，覆盖桌面启动缺 PATH 的问题，可直接复用于发现 Node。
- 前端：`src/api/client.ts` 单一出口；`MainArea = 'overview' | 'sync' | 'settings'`；`components/preview/MarkdownView.tsx` 可复用；preload 无目录选择 API（需 F2 新增）。

## 6. 关键取舍记录

1. **RPC 侧车 vs 升级 Electron**：升级到 38+ 才满足 Node ≥22.19，会连带 better-sqlite3 ABI、更新器与打包链回归；侧车方案隔离崩溃、不动现有 ABI。代价为依赖用户安装 Node 22.19+ 与 pi，用就绪码显式呈现。
2. **工具在 server 实现**：扩展运行于外部 Node，无法加载 Electron ABI 的 better-sqlite3；权限裁决集中在 server 便于用 vitest 覆盖，扩展只转发，不依赖 pi 运行时 import（server tsc 不需安装 pi）。
3. **Work 不给 shell**：pi bash 不是文件系统沙箱，cwd 不构成围栏；开放即与"原始库只读"承诺冲突。第一阶段只给受守卫的文件工具。
4. **发布用指针文件**：Windows 下 symlink 需特权，目录替换非原子；不可变 release 目录 + `CURRENT.json` rename 在两平台同卷原子。
5. **MCP 不依赖 SQLite**：外部 Node ABI 与打包的 Electron ABI 不同，stdio 进程加载 better-sqlite3 会崩；只读 manifest/Markdown 即可满足查询，且与发布原子性一致。默认用应用自带 Electron 可执行 + `ELECTRON_RUN_AS_NODE`，避免要求用户另装 Node。
6. **文风规范内置**：planner-doc-style 提炼为随应用发布的 prompt 资产，运行时不依赖个人 skills 目录。

## 7. 未覆盖与风险

- 真实模型调用下的工具往返、GLM 等 OpenAI 兼容端点的工具调用兼容性：未验证（无可用凭据，按纪律不读凭据）。
- 打包后 `ELECTRON_RUN_AS_NODE` 可用性（签名/公证后）：未验证。
- Windows 上 Node/pi 发现与进程树终止：仅设计，未实测。
- 大库构建耗时与成本：未知，需首次真实构建记录。

【待反思】pi RPC `prompt` 响应 `success:true` 只表示命令被接受；端点不可达时进入 `auto_retry` 循环而非失败返回。宿主须以 `agent_settled` + 最终 stopReason 判定完成并限制重试次数（证据：§2 E3）。
