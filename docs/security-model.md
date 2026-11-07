# 安全模型

面向开发者与审计者，汇总应用的安全边界、令牌域、审批与审计机制。每条机制标注代码入口；行为以代码为准。用户侧的共享配置说明见 [kb-lan-mcp.md](kb-lan-mcp.md)，使用向导见 [agent-knowledge.md](agent-knowledge.md)。

## 边界声明（先读）

- **同 uid 信任域**：令牌文件与 config.json 中的明文 provider key 同属本用户信任域——同 uid 恶意进程两者皆可读。令牌阻断的是同机其他用户、浏览器页面与 DNS rebinding，不宣称更强（`server/src/cli-endpoint.ts` 模块头）。
- **文件围栏不是 OS 沙箱**：PathGuard/Workspace 校验约束的是本应用进程内的路径访问；显式添加的原生 Pi 插件是受用户信任的 Node 代码，以当前用户权限运行，不能用宿主工具围栏宣称它们具备 OS 沙箱（`server/src/agent/path-guard.ts`、`server/src/agent/pi-plugin-service.ts`）。
- **局域网 MCP 为明文 HTTP**：令牌与正文可能被同网段嗅探，只在可信内网开启（`docs/kb-lan-mcp.md`）。
- **零飞书 token 红线**：代码中不得出现任何飞书 token/app_id/app_secret；全部飞书访问委托 `lark-cli` 子进程的 user 认证态（`server/src/modules/lark-cli-client.ts` 模块头 "must NOT contain any Feishu token"；部署级逃生口为 `LARK_CLI_PATH` 环境变量）。已失效的请求 scope（如 `docs:document:read`）在读取时被剔除（`RETIRED_REQUEST_SCOPES`，`server/src/modules/config-manager.ts`）。

## 令牌域与隔离

四个令牌域互不接受对方令牌。desktop、CLI、LAN 三域校验用 `crypto.timingSafeEqual`（timing-safe）；Agent 运行令牌按内存上下文表精确查找（`AgentToolService.getContext`，查无有效上下文即拒）。

| 域 | 令牌 | 生成与存放 | 校验入口 | 保护对象 |
|---|---|---|---|---|
| Desktop | `X-Desktop-Token` | `crypto.randomBytes(32)` base64url；Electron 主进程生成（`electron/main.ts`），经消息端口注入 utilityProcess 业务 server（`electron/server-process.ts`、`server-process-entry.ts`）；渲染进程经 IPC 按需取用（preload `getApiHeaders` → `ipcMain 'desktop:get-api-headers'`） | `server/src/middleware/auth.ts`（仅 `desktopMode=true` 时挂载） | 全部业务 API |
| CLI | `X-Cli-Token` | 32 字节随机，发布到 `<dataRoot>/run/endpoint.json`（目录 0700 / 文件 0600，tmp+rename 原子写）；内存态由 `CliEndpoint` 持有（`server/src/cli-endpoint.ts`） | `server/src/middleware/cli-auth.ts` | `/api/cli/:command` 命令执行域 |
| LAN MCP | `Authorization: Bearer fskb_…` | 32 字节随机，存放 `<dataRoot>/secrets/kb-lan-mcp.json`（0700/0600，symlink/nlink 拒收，O_NOFOLLOW 打开）；子进程只经环境变量接收 sha256 摘要（`server/src/kb-lan/token-store.ts`、`gateway-manager.ts`） | `server/src/kb-lan/http-gateway.ts` `verifyBearer` | 独立网关的只读 20 工具 |
| Agent 运行 | `X-Agent-Run-Token` | `AgentToolService.createRunContext()` 逐会话/构建/任务发放；模式切换或会话删除即撤销（`server/src/agent/agent-tool-service.ts`） | `server/src/routes/agent-internal.ts` | `/api/agent-internal/*` 工具规格与执行 |

隔离规则与路由挂载顺序（`server/src/index.ts` `buildServer`）：

1. `/api/health` 永远 public，且最先注册。
2. `agent-internal` 挂在 desktop auth **之前**，自带三重校验，不接受 desktop/CLI 令牌。
3. CLI 管理面 `/api/cli/enable|token/rotate|info|install-shim|remove-shim|skill/*` 自带 desktop token 守卫且先于 CLI 令牌中间件注册（CLI 令牌不能自我提权，`server/src/routes/cli-admin.ts`、`server/src/routes/cli.ts:82-137`）。
4. CLI 命令域 `use('/api/cli/*')` 三重校验（见下节），desktop token 在该域**不被接受**。
5. LAN 网关对携带 `X-Desktop-Token`/`X-Cli-Token` 的请求记 `foreign_token_header` 审计并按认证失败处理（`http-gateway.ts`）。

Standalone 开发模式可用 `FEISHU_SYNC_DEV_TOKEN` 固定 desktop token，缺省每次随机（`server/src/index.ts` 文件尾）。

## 回环 / Host / Origin 校验

三处共用「回环 Host + 拒 Origin + 令牌」三重模式：

| 域 | 回环判定 | Origin | 令牌 | 代码 |
|---|---|---|---|---|
| CLI | Host ∈ {127.0.0.1, localhost, [::1]}（Host 头优先，回退请求 URL host） | 拒绝存在 Origin 的请求（浏览器不可达，防 CSRF/rebinding） | `X-Cli-Token` timing-safe | `middleware/cli-auth.ts` |
| Agent 内部 API | 同上 | 同上 | `X-Agent-Run-Token` 必须能换出有效运行上下文 | `routes/agent-internal.ts` |
| LAN MCP | 无回环要求（面向局域网），但来源 IP 必须命中私网 CIDR 白名单 | 拒绝 Origin（浏览器直连 403 `kb_lan_browser_forbidden`） | Bearer 摘要全量比对 | `kb-lan/http-gateway.ts`、`kb-lan/network.ts` |

Desktop 域的 CSRF 防线在 CORS origin gate：生产仅放行 `app://feishu-sync.local`；`corsDevMode`（显式参数，不由 desktopMode 决定）放行 loopback 任意端口的浏览器来源（`server/src/middleware/cors.ts`、`CreateServerOptions.corsDevMode` 注释）。

CLI 端点文件由 `startServer` 回调发布；`revoke()` 只在文件内 pid 与当前进程一致时删除，避免多实例误删（`cli-endpoint.ts`）。

## 批准流（app_command）

会话内模型执行 `app_command` 的裁决链（`server/src/agent/approvals/approval-service.ts`、`server/src/agent/tools/app-command-family.ts`、`server/src/index.ts` S10 段）：

- 命令按风险分级 `read | mutate | destructive | remote_write`（`server/src/ops/command-table.ts` `OpsRisk`）；read 直通，其余逐次挂起等待用户批准。
- 挂起产生 `approval_request` SSE 事件；用户经 `/api/agent/sessions/:id/approvals*` 批准或拒绝；10 分钟无人处理 → `approval_timeout`。
- **模型传入的 `confirm`/`confirmation` 字段一律剔除**（防提示注入自我批准）；确认值只在用户批准后由服务端注入（`CONFIRM_FIELDS` 剔除 + `confirmPlan` 复核）。
- 批准绑定服务端权威轮次：工具调用所属 runId 必须等于会话当前可执行轮，跨轮迟到请求拒绝；批准后、执行前再复核会话运行状态，会话停止（`session_abort`/`run_end`）即取消全部 pending 批准。
- 执行与 CLI 执行器同构：`app.request()` 携 desktop token 穿透目标路由，不走网络。
- CLI/app_command 主体改配置的禁改面：`config.set` 拒绝 `cli.*`、`kbLanMcp`、`llm` 密钥面、`agent.workspaces`、`feishuWrite`（`ops/command-table.ts`；`PUT /api/config` 对 CLI 主体丢弃 `feishuWrite`/`feishuPublish`，`routes/config.ts`）。

## PathGuard 与 Workspace 隔离

**PathGuard**（`server/src/agent/path-guard.ts`，server 内唯一权威实现）：所有 Agent 工具与 MCP 检索触达的文件路径必须经它裁决。

- 解析层拒绝：绝对路径、`..` 段、空段、NUL、Windows 盘符/冒号流（ADS）/UNC/保留设备名。
- containment 以 `realpath` 规范路径精确比较（POSIX 含 macOS 不做大小写折叠；Windows 按平台规则小写归一）。
- read：目标 realpath 必须在根内；write：父目录 realpath 在根内，目标存在时 lstat 不得为 symlink、nlink 必须为 1（拒绝硬链接逃逸）；mkdir 逐级创建、每级 realpath 复核。
- 写入走同目录临时文件 → fsync → rename（`atomicWriteFile`）。

**Workspace 授权**（同文件 `validateWorkspacePath` / `checkRootOverlap`）：

- 路径必须存在且为目录；拒绝文件系统根、用户主目录本身、系统目录（含 macOS `/var`/`/private` 根别名归一）。
- 与 `knowledgeBaseRoot`、`standardKb.outputRoot`、`dataRoot` 及受保护运行根（应用源码/node_modules/Electron 资源、pi/npm/Node 安装树与凭据根）双向重叠即拒绝——否则 `ws_write` 可改写 pi 插件或 node 二进制把「无 shell」变成任意代码执行。
- 配置保存与能力使用时都做重叠校验（R02 动态复核：目录可能在登记后被删除重建，`server/src/index.ts` `workspaceGuardsSnapshot`）。受保护根清单在 `server/src/agent/protected-roots.ts`（静态 + 运行时发现）。

## 原子写盘与 dry-run

- 同步引擎：`SyncOptions.apply` 默认 false（dry-run）；提交知识库文件需 `apply:true + confirmation:'APPLY'`。所有写入先进库外 staging 目录，校验后 rename 入位，失败从 rollback 快照恢复，`assertInsideRoot` 拒绝路径逃逸（`server/src/modules/atomic-commit.ts`、`sync-engine.ts`）。只有原子提交成功才推进 `synced_obj_edit_time` 并置 `synced`。move/delete/路径冲突/父链不完整/无权限保留为带 `reasonCode` 的 blocker，绝不自动覆盖。
- 标准库构建：staging 校验 → 生成不可变 release → 原子切 `CURRENT.json` 指针（`server/src/kb/standard-kb-store.ts`、`kb-build-service.ts`）。清理异常不得删除 current release。
- 配置与端点类小文件同样 tmp+rename（`cli-endpoint.ts`、`token-store.ts`、`path-guard.ts atomicWriteFile`）。

## 能力令牌与工具集裁决

工具集由 server 层单点裁决，客户端声明只是投影视图（`server/src/agent/agent-tool-service.ts`）：

1. `createRunContext({ runKind, … })` 发放运行令牌并计算 `allowedTools`：基线 = runKind 白名单 → 工具族 disable 剔除 → `allowedToolsOverride` 显式覆盖（仍须 ∩ 已知工具，且子任务禁拿 `task_*`/`app_command`）。
2. `/api/agent-internal/tools` 按令牌（及受信身份头）下发规格；读取类工具附 `annotations.readOnlyHint`。
3. `executeTool` 校验链：令牌有效 → 工具名在 `allowedTools` → 路径经 PathGuard → 族级执行器。
4. 令牌撤销面：`revokeToken`（探针/单次）、`revokeBySession`（模式切换、会话删除、进程退出）、`revokeByBuild`（构建收尾）；撤销后 in-flight 提交也被拒绝（F01 租约）。
5. amagi 构建子任务的受信身份经环境变量注入、随调用以 `X-Amagi-Task-Id`/`X-Amagi-Agent` 头透传——模型无法经工具参数改变身份（`server/src/agent/claude-bridge.cjs` 头注释、`routes/agent-internal.ts`）。

Claude Code 运行时把 Claude 自身工具全部禁用（`--tools '' --permission-mode dontAsk`），工具仅经 MCP 桥回到同一裁决链，见 [claude-runtime.md](claude-runtime.md)。

## 审计文件族

全部为 append-only JSONL，位于 `<dataRoot>/agent/audit/`；审计写入失败不阻断业务但记录告警，不记录正文与凭据。

| 文件 | 记录者 | 内容 |
|---|---|---|
| `cli.jsonl` | `middleware/cli-auth.ts` | CLI 非 GET 请求：时间、方法、路径、状态码（不记 body） |
| `<sessionId>.jsonl` | `agent-tool-service.ts` `auditWork`、`approval-service.ts` | Work 写操作（`ws_write`/`ws_edit`/`ws_mkdir`：工具、路径、字节数、结果）与 app_command 批准生命周期（`approval_requested`/`approved`/`rejected`/`timeout`/`cancelled`） |
| `kb-lan-mcp.jsonl` | `kb-lan/audit.ts` `LanAudit` | LAN 共享元数据：会话开关/驱逐、工具调用（来源、工具、release、状态、耗时）、认证失败（按 IP/分钟聚合）、封禁、watchdog 击杀、令牌轮换/显示；约 5MiB 轮转保留一份 `.1` |
| `source-edits.jsonl` | `sources/source-edit-service.ts` | 原始库正文受控编辑（第三写者） |
| `source-pushes.jsonl` | `sources/feishu-write-service.ts`、`source-title-service.ts`、`cloud-history-service.ts`、`cloud-move-service.ts` | 写回飞书、云端重命名、历史回滚、安全移出 |
| `kb-publish.jsonl` | `kb/publication-service.ts` | 标准库反向发布事件 |

原始库写者不变量：正文只由 SyncEngine（云端→本地）、源生命周期操作（只移动/删除）、SourceEditService 修改；`feishu_sync` 头部字节只由 SyncEngine 生成。非 pushed 的源编辑行令同步/清理一律 `local_edit_pending` blocker 拒绝，绝不覆盖（详见 [data-contract.md](data-contract.md)）。

## 相关文档

- [troubleshooting.md](troubleshooting.md)：用户/运维侧故障排查。
- [kb-retrieval.md](kb-retrieval.md)：检索子系统的只读围栏与限流。
- [architecture.md](architecture.md)：整体分层与进程契约。
