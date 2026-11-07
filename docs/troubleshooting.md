# 故障排查

面向用户与运维的 FAQ。条目按「症状 → 原因 → 处置」组织；构建链路的深入排障见 [build-operations.md](build-operations.md)，局域网共享的完整排查表见 [kb-lan-mcp.md](kb-lan-mcp.md#常见问题)，Agent 工作台的验证边界见 [agent-knowledge.md](agent-knowledge.md#故障与验证范围)。

## 安装与启动

| 症状 | 原因 | 处置 |
|---|---|---|
| 安装依赖或启动脚本报 Node 版本错误 | 运行环境要求 Node `^22.19.0 \|\| ^24.0.0`（package.json `engines`） | 安装 Node 22.19+ 或 24 LTS 后重试；不要用 Node 18 |
| `npm run dev:all` 时 server 报 `EADDRINUSE 127.0.0.1:3001` | standalone server 固定监听 3001，本机其他服务占用 | **同时**设置 `FEISHU_SYNC_PORT`（server 监听）与 `BACKEND_PORT`（vite 代理目标，缺省也是 3001，`vite.config.ts`）为同一端口；只改 server 侧代理仍指向 3001。打包应用的 server 运行在 utilityProcess 子进程、端口 0 自动分配（`electron/server-process.ts`），不受此影响 |
| 浏览器（dev:all）调 API 全部 401 | standalone 也启用鉴权，desktop token 每次随机（控制台只提示配置环境变量，不打印令牌） | 服务端与 vite 两侧设置同一 `FEISHU_SYNC_DEV_TOKEN`（vite 代理自动注入该令牌，`vite.config.ts`） |
| 提示找不到 lark-cli | lark-cli 未安装或不在 PATH | 在应用「设置 → 认证与授权」内安装/更新（应用内托管，`server/src/modules/lark-cli-manager.ts`）；部署级逃生口为 `LARK_CLI_PATH` 环境变量 |

## 飞书授权与同步

| 症状 | 原因 | 处置 |
|---|---|---|
| 授权状态显示未就绪 | lark-cli 未登录或 user 认证态失效 | 在设置页走设备授权引导；应用启动时会做 version + auth + scopes 三段校验（`LarkCliClient.checkAuthReady`） |
| 报 `missing_scope`（如幻灯片截图、写回飞书） | 当前授权缺少对应 scope | 按应用内增量授权提示补授权；例如写回需要 `docx:document:write_only`（`feishuWrite` 默认关闭） |
| 同步列表出现带 `reasonCode` 的 blocker（路径冲突、父链不完整、无权限等） | 引擎拒绝自动覆盖，保留人工裁决 | 按列表提示逐项处理；blocker 不会自行消失，也不会推进 `synced` 基线 |
| 文档停在 `local_edit_pending`，同步不覆盖 | 本地正文被受控编辑（编辑器或经批准的 `app_command source.*`）且尚未写回 | 先「写回飞书」或「放弃修改」（用备份恢复），状态清除后恢复常规同步 |
| 飞书请求间歇性失败后自愈 | 命中飞书限流（错误码 99991400） | 无需处理：客户端按 QPS 节流 + 指数退避自动恢复（`server/src/modules/lark-cli-client.ts`） |

## 标准库构建

构建失败不破坏已发布版本：staging 校验未通过、源变化阻断等情况一律保持旧 release 与 `CURRENT` 指针不动。

| 症状 | 原因 | 处置 |
|---|---|---|
| 构建启动报 `agent_not_ready`（503） | Agent 运行时未就绪（Node/pi 缺失或版本不符） | 见下节「Agent 工作台」就绪码；不要为运行时问题升级 Electron |
| 构建启动报 `build_runtime_unavailable`（503） | Pi 构建运行宿主未接线（pi-amagi 编排依赖 pi 基座） | 修复 pi 运行环境后重试；Claude Code 基座不能跑 pi-amagi 编排 |
| 构建启动报 `kb_build_running`（409） | 已有构建在跑（单构建串行不变量） | 等待或停止当前构建后再发起 |
| 应用重启后构建显示 interrupted | 上次进程退出时未终态，启动对账如实标记（`reconcileOnStartup`，以 `CURRENT` 指针为准补 DB） | 重新发起构建；已发布版本不受影响 |
| 构建中途报源变化被阻断 | 源在构建期间被同步更新，本轮按失败处理并保持旧发布 | 等同步稳定后重试；按变更更新会基于新源重算 |
| 构建结果与源不符 / 想核对过程 | — | 构建度量、检查点与恢复细节见 [build-operations.md](build-operations.md) |

## Agent 工作台

就绪码来自运行时探测（`server/src/agent/runtime-resolver.ts`；类型表 `server/src/types/agent-knowledge.ts` `ReadinessCode`）。正常结果缓存 5 分钟、失败缓存 30 秒；点「检查运行时与模型」可强制重检。

| 就绪码 / 症状 | 原因 | 处置 |
|---|---|---|
| `node_missing` / `node_too_old` | 未发现 Node ≥22.19，或版本过旧 | 安装 Node 22.19+/24；或在设置中指定 nodePath。Claude Code 桥同样需要 Node ≥22.19 |
| `pi_missing` / `pi_version_unsupported` / `pi_spawn_failed` | pi 未安装 / 版本不在 `>=1.4.0 <2.0.0` / 无法启动 | 应用内可自动安装自管副本（`RuntimeInstaller`），或在设置填写 piCliPath |
| `claude_missing` / `claude_spawn_failed` / `claude_protocol_unsupported` | Claude Code 未找到 / 版本缺安全参数或无法运行 / 提供商不是 Anthropic Messages 协议 | 安装或更新 Claude Code、填写 claudeCliPath；模型侧配置见 [claude-runtime.md](claude-runtime.md) |
| `model_unconfigured` / `model_auth_missing` | 未选模型或提供商缺 API Key | 在「服务提供商与模型」补齐；可用列表不保证实际请求成功，用连接测试验证 |
| 会话报 409 `agent_busy` | 进程池满：会话是立即语义，后台任务合计上限 `agent.maxConcurrentProcesses` | 等空闲或调大上限（1..6）；后台排队会自动放行 |
| 停止后界面状态与实际不符 | 「已请求停止」不等于完成 | 以最终状态、真实文件、审计与发布指针为准；会话历史真相在进程 JSONL，不截断回溯 |

## CLI（命令行）

退出码契约：0 成功、1 业务错误、2 用法错误、**3 应用未运行或不可达**、4 需要确认（`server/src/cli/cli-app.ts`、使用说明 [agent-knowledge.md](agent-knowledge.md#命令行访问)）。

| 症状 | 原因 | 处置 |
|---|---|---|
| 退出码 3（`app_not_running` / `app_not_reachable`） | 应用未启动、未开启命令行访问，或 `<dataRoot>/run/endpoint.json` 为陈旧残留 | 启动桌面应用（命令行访问默认开启）；仍失败时在设置中重新生成 shim 与端点 |
| 401 `cli_token_invalid` | 令牌被轮换或缺失 | CLI 令牌从 `endpoint.json` 自动发现；轮换后旧令牌立即失效，重启 CLI 让其重读端点 |
| destructive/remote_write 命令只打印预览 | 该级命令必须显式确认 | 加 `--yes`；确认值由服务端注入，模型与脚本不能代答 |
| `config.set` 报禁改 | `cli.*`、`kbLanMcp`、`llm` 密钥面、`agent.workspaces`、`feishuWrite` 不接受 CLI 通道修改 | 在应用设置（desktop 域）中修改这些项 |

## 局域网 MCP（知识库共享）

完整排查表（端口占用、防火墙、401/403/429/503、会话过期、`kb_busy`、中文截断等）见 [kb-lan-mcp.md](kb-lan-mcp.md#常见问题)。速查：

- **401**：Bearer 缺失/失效，重新复制最新令牌（轮换后无旧令牌宽限期）。
- **403**：来源 IP 不在允许网段，或请求带 Origin（浏览器直连被拒）。
- **429**：同 IP 认证失败过多（10 次/分钟触发），封禁约 5 分钟。
- **503 `kb_sessions_full`**：会话满（默认 16，可设 1–64），关闭空闲客户端。
- **`kb_busy`**：在途排队满（全局 4 / 会话 2 / 队列 32 / 等待 10s），按 `retryAfterMs` 重试。

## 原生模块 ABI（better-sqlite3）

better-sqlite3 是原生模块，`.node` 二进制的 ABI 必须与运行它的 Node/Electron ABI 一致，否则启动即崩。

| 症状 | 原因 | 处置 |
|---|---|---|
| 跑 vitest 报 `NODE_MODULE_VERSION` 不匹配 | node_modules 已被 `@electron/rebuild` 编译成 Electron ABI（桌面构建后常见） | `cd server && npm rebuild better-sqlite3` 切回系统 Node ABI；跑桌面构建前再让构建脚本重编译。验证用 `node scripts/verify-abi.cjs` |
| 测试 worker 静默退出、用例大量丢失 | better-sqlite3 旧版在 Node 24 上 worker teardown 时序缺陷 | 保持 better-sqlite3 ^12.11.1+（依赖已固定）；再遇先核对原生模块版本矩阵 |
| 打包应用启动即崩（ABI 相关） | 打包产物内 better-sqlite3 与 Electron ABI 不符 | 用桌面打包入口 `npm run desktop:dist:*`：`scripts/build-desktop-target.cjs` 在 `build:all` 之后单独执行 `@electron/rebuild`（server 与根两份 node_modules）。`build:all` 本身只做前端与 server 编译，不重编译原生模块 |

## 相关文档

- [security-model.md](security-model.md)：令牌域、批准流与审计文件（排障时核对权限问题）。
- [kb-retrieval.md](kb-retrieval.md)：检索与 MCP 的索引、限流机制。
- [architecture.md](architecture.md)：进程契约与启动链路。
