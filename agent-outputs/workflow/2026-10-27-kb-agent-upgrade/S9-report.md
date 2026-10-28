# S9 报告：CLI 客户端与 shim（对本地假 server 端到端）

上游输入：`docs/design/kb-agent-upgrade-design.md` §6.1/§6.4、`S8-report.md`（endpoint.json 格式/调用契约/退出码映射/命令表 25 条）、`server/src/ops/command-table.ts`（只读消费）。

## 一、产物清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `server/src/cli/main.ts` | 新增 | 进程入口（esbuild 打包入口；只设 exitCode 自然退出，防管道 stdout 截断） |
| `server/src/cli/cli-app.ts` | 新增 | 编排：发现→探活→confirm 预检→执行→退出码映射（`runCli` 可单测） |
| `server/src/cli/args.ts` | 新增 | argv 解析：命令词↔表内点号名、全局旗标任意位置、`--` 字面模式、位置参数、类型转换、别名 |
| `server/src/cli/client.ts` | 新增 | 发现（`--home`>`FEISHU_SYNC_HOME`>`~/.feishu-sync`）+ node:http JSON 客户端 |
| `server/src/cli/output.ts` | 新增 | `--json` 包络输出 + 人类模式递归渲染 |
| `server/src/routes/cli-admin.ts` | 新增 | `GET /api/cli/info` + `POST /api/cli/install-shim`（desktop token 域，守卫与 S8 enable/rotate 同语义） |
| `server/src/index.ts` | 追加 | cliAdminRoutes 挂载（cliRoutes **之前**，见 §三） |
| `server/scripts/lib/cli-bundle.mjs` | 新增 | esbuild 共享入口（与 mcp-bundle.mjs 同构：cjs/node20/单文件） |
| `server/scripts/build-agent-assets.mjs` | 追加 | 第 3 步 bundleCli（只追加条目） |
| `server/tests/cli-client.test.ts` | 新增 | 16 用例：startServer 真实例 + CLI 子进程端到端 + shim |
| `server/tests/cli-args.test.ts` | 新增 | 12 用例：解析纯函数 + runCli 本地路径 |
| `src/types/cli.ts`、`src/api/client.ts`（追加 4 函数）、`src/hooks/useCliInfo.ts`、`src/components/CliAccessSettingsCard.tsx`、`src/views/SettingsView.tsx`（追加 application tab 项）、`src/components/CliAccessSettingsCard.test.tsx`（6 用例） | 新增/追加 | 设置页「命令行访问」卡 |

**S8 服务器侧文件零改动**（cli-endpoint.ts / cli-auth.ts / command-table.ts / routes/cli.ts 只消费）。`electron/main.ts` 未改（退出链路 revoke 已内置于 server close()，S8 评估结论沿用）。

## 二、命令清单（对照 S8 命令表 25 条，共表消费）

CLI 命令面**不另立清单**：`server/src/cli/args.ts` 直接 import `OPS_COMMANDS`（点号名 ↔ 空格分层），参数类型/必填/confirm 全部来自表内 schema（U14 共表防漂移）。用法：`feishu-sync [--home <dir>] [--json] [--yes] <命令> [参数…]`。

| CLI 写法 | 表内名 | 风险 | confirm | 参数示例 |
|---|---|---|---|---|
| `status` | status | read | — | `--json` |
| `auth status` | auth.status | read | — | |
| `config get [path]` | config.get | read | — | `config get pollIntervalMinutes`（按 path 裁剪输出） |
| `config set <path> <json>` | config.set | mutate | — | `config set enableNotifications true` |
| `kb status / changes / builds / versions` | kb.* | read | — | `kb builds --limit 5` |
| `llm test` | llm.test | read | — | `llm test --llm '{"…":1}'` |
| `clean trash list` | clean.trash.list | read | — | |
| `auth login start / complete / cancel` | auth.login.* | mutate | — | `auth login start [--switch-account]`（别名→mode）；`auth login complete <deviceCode>`（long-poll 15min 超时档） |
| `lark install` | lark.install | mutate | — | |
| `lark config-init start / complete / cancel` | lark.config-init.* | mutate | — | complete 走 long-poll 档 |
| `kb build [--full]` | kb.build | mutate | confirm=BUILD | `kb build --full --yes`（`--full` 别名→mode:full） |
| `kb cancel <buildId>` | kb.cancel | mutate | — | 位置参数 |
| `kb sources include/exclude <token…>` | kb.sources.* | mutate | — | 位置参数聚合为数组 |
| `clean trash restore <objToken>` | clean.trash.restore | mutate | — | 位置参数 |
| `clean orphans [--apply]` | clean.orphans | destructive | confirmation=APPLY | 缺省 dry-run 免确认；`--apply --yes` 执行 |
| `clean trash purge <objToken>/--all` | clean.trash.purge | destructive | confirm=PURGE | 恒需 `--yes` |
| `kb sources cleanup --sources <json>` | kb.sources.cleanup | destructive | confirm=CLEANUP | `--sources '[{"objToken":…,"relPath":…}]'` |

旗标规则：kebab-case（`--build-id`→buildId）；number/boolean/object/array 按表内类型转换（object/array 取 JSON 字面量）；未知旗标/缺必填/多余位置参数 → 退出码 2；`--` 之后进入字面模式（字符串型参数可携带 `--` 前缀值；JSON 型参数仍须合法 JSON）。

### `--json` 形状（stdout 单个包络，供 agent 消费）

成功（直接透传 `/api/cli/:command` 响应包络）：

```json
{"ok":true,"data":{"health":{"status":"ok","timestamp":1769576…},"larkCli":{…},"agent":{…},"kb":{…}}}
```

失败（CLI 本地产生，同构）：

```json
{"ok":false,"error":{"code":"app_not_running","message":"未发现运行中的应用（/Users/x/.feishu-sync/run/endpoint.json 不存在）"}}
{"ok":false,"error":{"code":"confirmation_required","message":"命令 kb.build（mutate）需要确认后才会执行","details":{"field":"confirm","value":"BUILD"}}}
{"ok":false,"error":{"code":"usage_error","message":"未知命令 frobnicate（--help 查看全部命令）"}}
```

人类模式：数据走 stdout（递归键值/列表渲染），错误走 stderr（消息+错误码+引导）。流式命令（NDJSON）v1 未实现——S8 命令表未登记 SSE 命令，留待 S10 后统一评估（S8 报告 §八同款结论）。

## 三、退出码矩阵与执行链

| 退出码 | 语义 | 触发（实测锚定） |
|---|---|---|
| 0 | 成功 | status/config get/clean orphans dry-run 与 `--apply --yes`/shim 调起 |
| 1 | 业务错误 | 服务端 ok:false 且非下述（如 kb build --yes 在测试环境因 agent 未就绪失败） |
| 2 | 参数错误 | 本地：未知命令/未知旗标/缺必填/JSON 非法/表内 request() 抛 invalid_args·forbidden_path；服务端：HTTP 400 同族错误码 |
| 3 | 不可达或未开启 | endpoint.json 缺失（app_not_running）/损坏（app_not_running）；探活失败（app_not_reachable）；401 cli_token_invalid（令牌失效→引导设置开启/轮换） |
| 4 | confirm 缺失 | 表内有 confirm 且最终请求非 GET 且无 `--yes`：**本地预检直接退出**（用表内 request() 纯函数判定 GET/非 GET，`clean orphans` 缺省 dry-run 分支不受限）；服务端 422 confirmation_required 兜底 |

执行链：解析 → 读 `<home>/run/endpoint.json`（S8 六字段格式）→ `GET /api/health` 探活（5s）→ confirm 预检 → `POST <url>/api/cli/<command>`，body `{args, [confirmField]: confirmValue}`，头 `X-Cli-Token`（绝无 Origin）→ 包络输出。HTTP 用 node:http 而非 fetch：undici 默认 headersTimeout（5min）会截断 long-poll 命令（最长约 12min）。`auth login` 类命令只走命令表映射（`/api/cli/auth.login.*`），不直连 LarkCliManager。

## 四、shim 机制（§6.1 最小路径实现评估）

**选择：服务端生成（新增 `routes/cli-admin.ts`），非 CLI 自装。** 理由：任务书要求「应用内一键生成」（设置页按钮→desktop-guarded 端点）；CLI 自装需 CLI 拿到 dataRoot 写权限路径，且与「CLI 不能自我提权」域分离原则不必要地纠缠。S8 报告 §六.5 预告「S9 按需补服务端点」即此；因 `routes/cli.ts` 冻结，端点放新文件。

- `POST /api/cli/install-shim`（desktop token 域）写 `<dataRoot>/bin/feishu-sync`（POSIX sh，0755，writeFileSync+显式 chmod 收拢）与 `feishu-sync.cmd`（Windows，CRLF）；CLI 产物缺失 → 409 `cli_script_missing`。
- 脚本内容 = `export FEISHU_SYNC_HOME=<dataRoot>`（+打包版 `ELECTRON_RUN_AS_NODE=1`）+ `exec '<process.execPath>' '<server…/dist/cli/feishu-sync-cli.cjs>' "$@"`。开发版运行时=当前 Node；打包版=Electron 可执行（RunAsNode，与 kb-mcp 推荐配置同法）。
- 产物定位：编译模块上溯（dist）+ 兜底 `<serverRoot>/dist/cli/`（vitest/tsx 从 src 运行时命中后者）。
- 不改用户 PATH：`GET /api/cli/info`（含 enabled/endpointPublished/endpointFile/cliAvailable/shimInstalled/shimPath/command/args/env/pathHint）只返回追加提示。
- **挂载顺序关键**：`cliAdminRoutes` 必须挂在 `cliRoutes` 之前——cliRoutes 内 `use('/api/cli/*')` 的 CLI 令牌中间件按 Hono 注册顺序执行，本文件静态路由先注册先返回即不受其拦截（与 cliRoutes 内 enable/rotate 先注册再挂 use 同策略）。测试锚定：desktop token→200、CLI 令牌→403、无令牌→401。

## 五、S13 待登记：`source.*` 命令占位说明

S8 命令表刻意不含 `source.*`（依赖 S11/S12 新路由，设计切片表指定 S13 登记）。S13 追加登记后 **CLI 零改动即可用**——命令词匹配、参数类型、confirm 注入、`--yes` 门全部由表驱动。届时登记的命令（设计 §6.3）与 CLI 侧注意点：

| 待登记命令 | 风险/confirm | CLI 侧已就绪的能力 |
|---|---|---|
| `source show <objToken>` | read | 位置参数（string） |
| `source state [objToken]` | read | 可选位置参数 |
| `source edit <objToken> (--from-file f \| --replace old new) [--base-hash h]` | mutate | object 型旗标需 JSON（`--replace` 若做双位置参数需在 `POSITIONALS` 补映射） |
| `source revert <objToken>` | destructive / confirm=REVERT | `--yes` 门已就绪 |
| `source push <objToken> [--allow-overwrite] [--force]` | remote_write / confirm=PUSH·OVERWRITE_CLOUD | remote_write 恒需 `--yes`（本地预检覆盖） |

另：`llm set-key --key-stdin`（§6.3 表 mutate/不对 Agent 暴露）不在 S8 25 条内，未实现；登记时需同时设计 stdin 读取路径（秘密不进 argv）。

## 六、设置页「命令行」段

`CliAccessSettingsCard`（设置 → 应用 → 命令行访问）：开启/关闭（enable）、轮换令牌（rotate，仅开启态）、生成/重新生成 shim（install-shim，未开启禁用）、端点文件/CLI 产物路径展示、shim 路径与 PATH 提示、逐行复制按钮。秘密边界：cliToken 永不进 renderer（info DTO 无令牌字段）。组件测试 6 用例锚定状态分支（SSR+hook mock，AuthSettingsCard 同法）；操作链路由 server 侧端到端锚定。真机 Electron 交互验证未做（本切片窗口内无打包环境；视觉/交互项留待 S13 一并真机过卡，见 §九）。

## 七、验证证据

- `cd server && npx vitest run tests/cli-client.test.ts` → **16/16**（真实 startServer 127.0.0.1 随机端口 + esbuild 单文件产物子进程）：status --json 形状与四步聚合键、人类模式、config get/set 往返（改值+还原）、config get path 裁剪、kb build 无 confirm→4、`kb build --full --yes` 参数可达服务器（非 2/3/4）、clean orphans 三态（dry-run 0 / --apply 无 --yes 4 / --apply --yes 0 且 dryRun:false）、未知命令/非法参数→2、表内 request 校验→2、无 endpoint.json→3 app_not_running、坏令牌→3 cli_token_invalid、死端口→3 app_not_reachable、auth login complete 缺参本地拦截、install-shim 双域 401/403、shim 写盘 0755+内容断言、info 形状、**shim 真实调起**（execFile(shim) → status --json 出站成功）。
- `cd server && npx vitest run tests/cli-args.test.ts` → **12/12**（表 25 条全命中空格形式、`--` 字面模式、别名、类型转换、错误分支、runCli 本地路径）。
- 四 CLI 套件组合连跑 ×3 → **75/75 稳定**（修复了跨套件 config 竞态后，见 §八.2）。
- 构建链：`node scripts/build-agent-assets.mjs` → `bundled feishu-sync-cli.cjs (40.2 KB)`；外部 node 冒烟：`node dist/cli/feishu-sync-cli.cjs --version` → `v0.2.0`，`--help` 25 条清单，无 server 时 status → exit 3。
- `cd server && npm run typecheck` → exit 0；根 `npm run typecheck`（三段）→ exit 0；根 `npm test` → **173/173**（含新组件测试）；根 eslint（改动文件）→ 0 problem。
- 全量 `cd server && npm test`：1131/1150 通过；2 个失败文件 **均与本切片无关**：`tests/kb-version.test.ts`（16 失败）与 `tests/provider-protocol-live.test.ts`（3 失败）单独运行（无本切片代码参与）同样失败，错误面为 S4 并行构建在飞代码的 `kb_unit_failed`（agent_not_ready / 单元未调 kb_unit_done），git 归因干净（本切片零改动 kb/agent 域）。

## 八、偏差、发现与风险

1. **confirm 缺失的「打印预览」弱化**：设计 §6.3 说 destructive 无 `--yes` 时「打印预览并退出码 4」；实现为打印 confirm 要求 + 预览引导（如 `clean orphans` 先跑 dry-run）后退出 4，不代跑预览命令（避免 CLI 替用户猜测等价只读形式）。服务端 422 语义不变。
2. **测试基建发现（本切片触发，写法已规避）**：`ConfigManager` 的 `DEFAULT_CONFIG_PATH` 在**模块求值期**冻结（config-manager.ts:61），而 vitest 多套件并行时 `FEISHU_SYNC_HOME` 逐套件改写在同 worker 内存在竞态——两个 isolateHome 套件并发时 ConfigManager 可能读写他套件的 config.json（S8 报告曾记录同族竞态）。本切片测试已用显式 `configPath` 根治自身；基建级修复（resolveDataRoot 惰性化或 pool 隔离）建议 Leader 另行安排。【待反思】
3. **兄弟切片阻塞记录（已自行恢复）**：窗口内 S10 的 `agent-tool-service.ts` 曾因块注释内 `task_*/app_command` 的 `*/` 提前闭合导致整仓测试无法 collect（约 8 分钟后兄弟修复）；S6 任务工具文件亦有一次中间态。均未改动兄弟文件，仅等待重试。
4. **ELECTRON_RUN_AS_NODE 打包版冒烟未做**：无打包产物环境；shim 生成逻辑对 electron 分支有单测级断言（脚本内容含 `ELECTRON_RUN_AS_NODE=1`），实际启动计时（设计 §11 未知项）留待发版冒烟。
5. **`kb build --full --yes` e2e 断言为语义性**（非 2/3/4）：测试环境无 pi 运行时，构建必然业务失败——断言聚焦「参数与 confirm 正确送达」，不锚定构建成败。
6. CLI 人类模式为通用递归渲染（对齐 v1「人类可读」），未做逐命令定制表格；`status` 等聚合输出可读性可后续按需打磨。

## 九、回滚

纯追加式：删除 `server/src/cli/*`（5 文件）、`server/src/routes/cli-admin.ts`、`server/scripts/lib/cli-bundle.mjs`、两个测试文件、`src/types/cli.ts`、`src/hooks/useCliInfo.ts`、`src/components/CliAccessSettingsCard*.tsx`；还原 `server/src/index.ts`（cliAdminRoutes 挂载块）、`server/scripts/build-agent-assets.mjs`（第 3 步）、`src/api/client.ts`（CLI 段 4 函数+1 import）、`src/views/SettingsView.tsx`（application tab 一项+Terminal import）。无数据迁移；已生成的 `<dataRoot>/bin/feishu-sync` 与 `run/endpoint.json` 由「关闭命令行访问/重装应用」路径自然管理，无需手工清理。S8 服务器侧文件全程未动，无联动回滚。
