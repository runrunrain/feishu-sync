# CLI 命令参考

`feishu-sync` 命令行客户端面向用户与 Agent，提供状态查询、配置读写、标准库构建、源文档编辑与写回、反向发布等能力。命令面由 `server/src/ops/command-table.ts` 唯一定义，CLI 与应用内 Agent 工具 `app_command` 共用同一张表；本文全部命令与代码实读一致（共 40 条）。

命令行只调用运行中的桌面应用（HTTP 内部转发），不直接读写本地数据；应用未运行时命令不可用。日常用法与工作流示例另见 [Agent 工作台说明](agent-knowledge.md)。

## 获取与启用

- 桌面应用默认开启命令行访问（配置段 `cli.enabled` 默认 `true`），首次启动即在数据根 `bin/` 下生成命令入口，并把内置 Skill 安装到 `~/.agents/skills/feishu-sync`。
- 命令入口（shim）路径：macOS/Linux 为 `<数据根>/bin/feishu-sync`，Windows 为 `<数据根>\bin\feishu-sync.cmd`。数据根默认 `~/.feishu-sync`，可用环境变量 `FEISHU_SYNC_HOME` 整体改根。直接用完整路径调用，或把 `bin` 加入 `PATH`。
- 管理入口在应用内「设置 → 应用 → 命令行访问」：开启/关闭、轮换令牌、安装与清理 shim、按目标（agents / claude / codex）管理内置 Skill。清理 shim 或默认 Skill 后应用会记住选择（`<数据根>/cli-local-install.json`）。
- 开启命令行访问时，应用把端点信息发布到 `<数据根>/run/endpoint.json`（目录 0700、文件 0600，tmp+rename 原子写）：`{ schemaVersion, url, pid, startedAt, appVersion, cliToken }`。CLI 每次执行时读取该文件发现服务地址与令牌；应用退出后文件不自动删除，CLI 按不可达处理（退出码 3）。
- CLI 令牌是独立随机令牌（32 字节 base64url），请求头 `X-Cli-Token`，与前端使用的 desktop token **双向隔离**：
  - CLI 命令域只接受 CLI 令牌，且强制三重校验——仅回环来源（Host 为 127.0.0.1/localhost/[::1]）、拒绝带 Origin 头的浏览器请求、令牌 timing-safe 比对；
  - 管理面（`/api/cli/enable`、`/api/cli/token/rotate`、`/api/cli/info`、`/api/cli/install-shim` 等）只接受 desktop token，携带 CLI 令牌访问返回 403 `cli_forbidden_route`——CLI 不能自我提权；
  - 关闭命令行访问即撤销端点与令牌；轮换令牌后旧令牌立即失效。
- CLI 客户端是零原生依赖的单文件打包产物（`server/dist/cli/feishu-sync-cli.cjs`，随应用分发），需要 Node ≥20；打包版应用经 Electron 的 Node 模式调起，不依赖外部 Node。

令牌文件与配置文件同属本机用户信任域，令牌阻断的是同机其他用户、浏览器页面与 DNS rebinding，不是同 uid 恶意进程（边界说明见 [安全模型](security-model.md)）。不要把 endpoint.json 内容或令牌写入日志。

## 通用约定

```
feishu-sync [--home <dir>] [--json] [--yes] <命令> [参数…]
```

| 旗标 | 作用 |
|---|---|
| `--home <dir>` | 指定数据根；缺省依次取 `FEISHU_SYNC_HOME`、`~/.feishu-sync` |
| `--json` | 结构化输出：stdout 单个 `{ok, data\|error}` 包络 |
| `--yes` / `-y` | 确认执行：注入命令表登记的确认值（见下） |
| `--help` / `-h` | 帮助；`help <命令>` / `<命令> --help` 查看单命令用法（用法行、参数表、位置参数顺序与示例），`<组> --help` / `help <组>` / 裸组名列出该组全部子命令 |
| `--timeout <秒>` | 覆盖本次命令 HTTP 超时（正数秒；缺省 120 秒 / long-poll 15 分钟） |
| `--version` | 版本 |

- 命令用空格分层（`kb build` ↔ `kb.build`）；参数用 `--kebab-case` 旗标（`--build-id` → `buildId`）或位置参数；object/array 类型传 JSON 字面量（`--sources '[{"objToken":"…"}]'`）；`--` 之后一律按位置参数处理。
- 位置参数：命令表登记或按必填参数顺序自动推导（如 `config set <path> <value>`、`source edit-status <objToken>`；array 参数收尾位全量收集，如 `kb sources include <tok1> <tok2> …`）。同一参数同时以位置形态与旗标形态给出会被拒绝，需二选一。
- 风险级四级：`read`（读取）/ `mutate`（修改）/ `destructive`（破坏性）/ `remote_write`（远端写）。destructive 与 remote_write 命令在命令表层强制登记确认值；带确认值的命令缺 `--yes` 时返回退出码 4、不发送业务命令。
- 参数解析、表内 request 校验与 confirm 预检全部在端点发现与探活**之前**完成：应用未运行时，参数/用法错误仍返回 2、缺 `--yes` 返回 4；本地预检通过后才读取端点文件并探活（失败 3）。
- 人类可读模式（默认）：列表类数据（对象数组，如 `kb builds`、`clean trash list` 的返回）渲染为对齐表格，单元格截断、嵌套值显示 `{…}`/`[n项]`，末尾提示 `--json` 查看完整字段；其余形态沿用键值缩进渲染。`--json` 输出不受影响。
- 退出码：

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 业务错误（上游路由返回错误） |
| 2 | 参数/用法错误（含命令表拒绝的禁止路径） |
| 3 | 应用不可达、命令行访问未开启或令牌无效 |
| 4 | 需要确认（补 `--yes` 重试） |

- 超时：探活 5 秒，普通命令 120 秒；long-poll 命令（`auth login complete`、`lark config-init complete`）15 分钟；`--timeout <秒>` 可覆盖本次命令超时（非法值按用法错误返回 2）。
- 补全：本地命令 `feishu-sync completion bash|zsh|fish` 生成 shell 补全脚本（不经命令表、不连服务器），覆盖命令词分层、各命令 `--参数` 与全局旗标。安装：`source <(feishu-sync completion bash)`（写入 `~/.bashrc`）；zsh 需已加载 compinit 后 `source <(feishu-sync completion zsh)`；fish 写入 `~/.config/fish/completions/feishu-sync.fish`。
- 常见坑：`kb publish --force --yes` 注入的是升级确认值 `OVERWRITE_PUBLISHED`；若实际计划没有云端冲突，服务端要求 `PUBLISH` 并返回 `confirmation_required`（退出码 4），按提示去掉 `--force` 重试即可。`source push --allow-overwrite` 同理：计划为追加时服务端要求 `PUSH`。`config set` 只接受顶层键，点号路径会被拒绝（见下节）。

## 命令表

下表与 `server/src/ops/command-table.ts` 一一对应。参数列标 `*` 为必填；必填参数与显式登记的参数可按位置传入（表中以 `<…>` 示意，其余可选参数也可用同名旗标），其余一律用 `--kebab-case` 旗标（如 `--page-token`）；「确认」列为 `--yes` 注入的值。HTTP 路由列是命令的进程内转发目标（路径参数以 `{…}` 表示），供 API 调用方对照；多步命令逐项列出。

### 状态与读取（read）

| 命令 | 作用 | 确认 | 主要参数 | HTTP 路由 |
|---|---|---|---|---|
| `status` | 应用总览：健康、lark-cli、Agent 运行时与标准库状态 | — | — | GET /api/health、/api/feishu/lark-cli/status、/api/agent/status、/api/kb/status |
| `auth status` | 飞书认证就绪状态（版本/scope/身份） | — | — | GET /api/feishu/auth-status |
| `config get [path]` | 读取应用配置（已脱敏；path 供输出裁剪） | — | path | GET /api/config |
| `kb status` | 标准库当前发布与待构建状态 | — | — | GET /api/kb/status |
| `kb changes` | 相对当前 release 的源变更列表 | — | — | GET /api/kb/changes |
| `kb builds [limit]` | 构建历史（1-100，默认 20；limit 可作位置参数） | — | limit | GET /api/kb/builds |
| `kb versions` | 标准库发布版本列表 | — | — | GET /api/kb/versions |
| `kb publish-preview` | 预览标准库发布计划（见[反向发布](feishu-publish.md)） | — | --release-id, --kb-paths, --force | POST /api/kb/publish/preview |
| `kb publications` | 已发布云文档映射与状态 | — | — | GET /api/kb/publications |
| `llm test` | 对已保存 LLM 提供商发起连通性测试（只能引用已保存配置） | — | --provider-id, --model-id, --timeout-ms | POST /api/llm/test-channel |
| `clean trash list` | 回收站文档列表 | — | — | GET /api/trash |
| `source edit-status <objToken>` | 源文档编辑状态与正文 hash（编辑 OCC baseHash 入口） | — | objToken* | GET /api/sources/{objToken}/edit-status |
| `source push-preview <objToken>` | 预览写回飞书计划（追加/覆盖/阻止原因） | — | objToken* | POST /api/sources/{objToken}/push/preview |
| `cloud history_list <objToken>` | 云端历史版本列表（分页聚合，上限 3 页） | — | objToken*, --page-token | GET /api/sources/{objToken}/history |
| `cloud move_status <moveId>` | 查询单次移出记录状态（仅人工，不暴露给 Agent） | — | moveId* | GET /api/sources/moves/{moveId} |
| `cloud moves [objToken]` | 移出记录列表（可按文档过滤，缺省 50 条；仅人工） | — | objToken, --limit | GET /api/sources/moves |

### 修改（mutate）

| 命令 | 作用 | 确认 | 主要参数 | HTTP 路由 |
|---|---|---|---|---|
| `config set <path> <value>` | 窄 patch 写入单个顶层配置键（禁改面见下） | — | path*, value* | PUT /api/config |
| `auth login start` | 发起设备授权登录，返回 verificationUrl 与 deviceCode | — | --mode（reauthorize 默认）/ --switch-account | POST /api/feishu/auth/device/start |
| `auth login complete <deviceCode>` | 阻塞等待浏览器授权完成（最长约 11 分钟） | — | deviceCode* | POST /api/feishu/auth/device/complete |
| `auth login cancel <deviceCode>` | 取消进行中的设备授权流程 | — | deviceCode* | POST /api/feishu/auth/device/cancel |
| `lark install` | 安装/更新应用内 lark-cli | — | — | POST /api/feishu/lark-cli/install |
| `lark config-init start` | 发起 lark-cli 初始化配置（全新安装必经步骤） | — | — | POST /api/feishu/lark-cli/config-init/start |
| `lark config-init complete` | 阻塞等待初始化配置完成（最长约 12 分钟） | — | — | POST /api/feishu/lark-cli/config-init/complete |
| `lark config-init cancel` | 取消进行中的初始化配置 | — | — | POST /api/feishu/lark-cli/config-init/cancel |
| `kb build [--full]` | 发起标准库构建（incremental 默认 / full） | BUILD | --full, --rebuild-selected, --refresh-images | POST /api/kb/builds |
| `kb cancel <buildId>` | 取消进行中的构建 | — | buildId* | POST /api/kb/builds/{buildId}/cancel |
| `kb sources include <tokens…>` | 把源文档纳入标准库构建 | — | tokens*（位置参数：多个 token 或 JSON 数组） | POST /api/kb/sources/selection |
| `kb sources exclude <tokens…>` | 把源文档排除出标准库构建 | — | tokens*（位置参数：多个 token 或 JSON 数组） | POST /api/kb/sources/selection |
| `clean trash restore <objToken>` | 从回收站恢复一篇文档 | — | objToken* | POST /api/trash/restore |
| `source edit <objToken>` | 编辑源文档正文（op/newText 二选一；见[源文档云端操作](source-cloud-operations.md)） | EDIT | objToken*, --base-hash*, --op 或 --new-text | POST /api/sources/{objToken}/edit |
| `source revert <objToken>` | 放弃本地修改（恢复上次同步正文并清脏状态） | REVERT | objToken* | POST /api/sources/{objToken}/revert |
| `sync whiteboard_backfill [docTokens…]` | 存量补齐白板旁路文件（只新增 .wb.svg/.wb.raw.json，不改 md 与同步基线；脏文档跳过） | BACKFILL | docTokens（缺省全量 synced 文档） | POST /api/sync/whiteboard-backfill |
| `sources references-rebuild` | 全量重建引用边索引（只读本地 md 重算 body 边，零云端调用；仅人工，不暴露给 Agent） | REBUILD | — | POST /api/sources/references-rebuild |

### 破坏性（destructive）

| 命令 | 作用 | 确认 | 主要参数 | HTTP 路由 |
|---|---|---|---|---|
| `clean orphans [--apply]` | 孤立文件清理：缺省预览（dry-run）；`--apply` 执行 | confirmation=APPLY | --apply, --items | GET /api/orphan-files（预览）/ POST /api/orphan-files/cleanup（执行） |
| `clean trash purge` | 彻底清除回收站条目（objToken 或 all 二选一） | PURGE | objToken（位置参数）或 --all | DELETE /api/trash/purge |
| `kb sources cleanup` | 从标准库移除源文档登记（本地文件移入回收区） | CLEANUP | --sources '<json>'*（`[{objToken,relPath}]`） | POST /api/kb/sources/cleanup |
| `cloud revert <objToken> <historyVersionId>` | 回滚云端文档到指定历史版本（确认值实际为 `REVERT_CLOUD:<版本id>`） | REVERT_CLOUD | objToken*, historyVersionId* | POST /api/sources/{objToken}/history-revert |

### 远端写（remote_write）

| 命令 | 作用 | 确认 | 主要参数 | HTTP 路由 |
|---|---|---|---|---|
| `kb publish` | 发布标准库到飞书（新建/更新云文档；见[反向发布](feishu-publish.md)） | PUBLISH（force 解除冲突时 OVERWRITE_PUBLISHED） | --release-id, --kb-paths, --force | POST /api/kb/publish |
| `source push <objToken>` | 把本地源文档修改写回飞书（追加 → PUSH；覆盖/强制 → OVERWRITE_CLOUD） | PUSH | objToken*, --allow-overwrite, --force | POST /api/sources/{objToken}/push |
| `cloud rename_title <objToken> <title>` | 在飞书重命名文档标题（wiki 成员传 node token；本地文件名不变） | RENAME | objToken*, title* | POST /api/sources/{objToken}/title |

注：`cloud revert` 的 `--yes` 注入基线值 `REVERT_CLOUD`，实际执行体由命令按参数构造为 `REVERT_CLOUD:<historyVersionId>`（目标版本 id 必须出现在确认值中）。

## config.set 禁改面

`config set` 对 CLI 主体维护以下禁止路径（`PUT /api/config` 对 CLI 转发主体同语义，命中即 400 `forbidden_path`）：

| 前缀 | 原因 |
|---|---|
| `cli` | CLI 不能改写命令行访问开关（自我提权）；请在应用设置操作 |
| `kbLanMcp` | 知识库内网共享只能由桌面设置管理 |
| `llm`（含 `llm.apiKey`、`llm.providers`） | LLM 整段与明文密钥面不接受 CLI 直写 |
| `agent.workspaces` | Workspace 增删只走专用路由（路径校验） |
| `feishuWrite` | 飞书写回开关只接受应用设置（desktop）修改 |
| `feishuPublish` | 反向发布段（含发布根）只接受应用设置（desktop）修改 |

此外 `path` 只接受顶层配置键：点号路径会被服务端当未知键静默忽略，命令层前置拒绝并提示嵌套修改需传整段对象（如 `config set standardKb '{…含修改后的 buildConcurrency…}'`）。

## 与 app_command 批准流的关系

同一张命令表同时驱动两个消费方，差异只在「谁确认」：

| | CLI | 应用内 Agent（`app_command` 工具） |
|---|---|---|
| 确认来源 | `--yes` 旗标（人工在终端输入） | 会话内批准卡：mutate/destructive/remote_write 挂起等待用户批准（SSE `approval_request`），10 分钟无人处理或会话结束即取消 |
| 确认值注入 | CLI 按 `--force` 等参数注入表内静态值 | 服务端剔除模型传入的 confirm 字段后，在批准前经真实 preview 派生权威确认值（`kb publish`/`source push`/`cloud revert`/`cloud rename_title` 挂 `confirmPlan`） |
| 命令可见性 | 全部 40 条 | 仅 `agentExposed=true` 的 37 条；`cloud move_status`、`cloud moves`、`sources references-rebuild` 三条只允许人工执行 |
| 会话模式限制 | — | Discuss 会话只见 read 级，非 read 直接拒绝 |
| 审计 | `<数据根>/agent/audit/cli.jsonl`（非 GET 请求记时间/方法/路径/状态码） | 会话审计文件（批准生命周期逐条记录） |

两个通道都不直接实现业务：执行层按命令表把请求进程内转发到上表 HTTP 路由（复用既有路由的全部校验与错误语义），CLI 主体转发时会被目标路由识别并应用与 `config set` 相同的禁改面。

## 排查

退出码 3 的常见原因：应用未启动、命令行访问已关闭、`--home` 指向的数据根与运行中应用不一致、令牌已轮换（endpoint.json 过期）。应用退出后 endpoint.json 可能残留，属预期；启动应用后重试即可。更多内容见[故障排查](troubleshooting.md)。
