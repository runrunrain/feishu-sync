# S8 报告：命令表 + CLI 认证（服务器侧）

上游输入：`docs/design/kb-agent-upgrade-design.md` §6.2-6.5、`docs/design/agent-knowledge-design.md` §9.6（回环+无 Origin+令牌模式基线）、`server/src/index.ts`、`server/src/middleware/*`、`electron/main.ts`（只读评估）。

## 一、产物清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `server/src/cli-endpoint.ts` | 新增 | `CliEndpoint`：endpoint.json 发布/撤销/轮换/timing-safe 校验 |
| `server/src/middleware/cli-auth.ts` | 新增 | `/api/cli/*` 三重校验（回环 Host + 拒 Origin + `X-Cli-Token`）+ 审计 |
| `server/src/ops/command-table.ts` | 新增 | `OPS_COMMANDS` 纯数据命令表（25 条，仅既有路由） |
| `server/src/routes/cli.ts` | 新增 | enable/rotate 管理面 + `POST /api/cli/:command` 执行器 + `GET /api/cli/commands` |
| `server/src/types/index.ts` | 追加 | `CliConfig { enabled: boolean }`；`Config.cli?`（可选，旧配置内存补默认） |
| `server/src/modules/config-manager.ts` | 追加 | `DEFAULT_CONFIG.cli`、`normalizeCliConfigLoose`（load 宽容）、`validateCliConfig`（PUT 严格）、migrateConfig 归一、updateConfig 合并分支 |
| `server/src/index.ts` | 追加 | import、CliEndpoint 构造、pre-auth 挂载、`__cliEndpoint`、startServer `onServerStarted`、close `revoke` |
| `server/tests/cli-endpoint.test.ts` | 新增 | 26 用例（单元 + buildServer 集成四态） |
| `server/tests/ops-command-table.test.ts` | 新增 | 21 用例（表不变量 + request/fillDefaults 纯函数） |

`electron/main.ts` **未改**（评估结论见 §五.3）。

## 二、endpoint.json 格式（S9 发现契约）

文件：`<dataRoot>/run/endpoint.json`（目录 0700、文件 0600、tmp+rename 原子写）：

```json
{
  "schemaVersion": 1,
  "url": "http://127.0.0.1:3001",
  "pid": 12345,
  "startedAt": "2026-10-27T08:00:00.000Z",
  "appVersion": "0.2.0",
  "cliToken": "<32字节 base64url>"
}
```

任务书最小描述 `{url, token}` 的超集（设计 §6.2 接口逐字段落实）。生命周期：
- 开启（`POST /api/cli/enable {enabled:true}`，desktop token）→ publish；关闭 → revoke（**仅 pid 匹配才删文件**，防多实例误删；崩溃残留由下次 publish 覆盖，不启动时隐式清理）
- `POST /api/cli/token/rotate`（desktop token，需已开启）→ 重新生成令牌重写文件，旧令牌立即失效
- server `close()` 在 HTTP 关闭后 revoke；关闭后原令牌全部 401（测试锚定）

## 三、中间件挂载位置图（index.ts 顺序）

```
① corsMiddleware('*')                 （既有，不变）
② 依赖注入中间件('*')                  （既有，不变）
③ healthRoutes                        （既有契约：最先注册，public）
④ agentInternalRoutes                 （既有契约：desktop auth 之前，三重校验）
⑤ cliRoutes                           ★S8 追加（仍在前）
   ├─ POST /api/cli/enable        ← desktopGuard（注册在 ⑥ 之前，不经过 CLI 校验）
   ├─ POST /api/cli/token/rotate  ← desktopGuard
   ├─ use /api/cli/*  → cliAuthMiddleware（回环+拒Origin+X-Cli-Token timing-safe+审计）
   ├─ GET  /api/cli/commands      （CLI 域）
   └─ POST /api/cli/:command      （CLI 域，命令执行）
⑥ authMiddleware('*')（desktopMode 时）  （既有，不变；不覆盖 ⑤——pre-auth 挂载）
⑦ 其余保护路由                        （既有，不变）
```

- `/api/cli/enable`、`/api/cli/token/rotate` 只接受 desktop token；带 `X-Cli-Token` 访问 → 403 `cli_forbidden_route`（设计 §8），CLI 不能自我提权。
- 其余 `/api/cli/*` 只接受 CLI 令牌；desktop token → 401 `cli_token_invalid`（分离域）。安全四态（正确/错误令牌、带 Origin、非回环 Host）统一 401 `cli_token_invalid`，message 区分（§8 约定）。
- 请求头名为 `X-Cli-Token`（任务书指定；设计 §6.2 原文 `X-Feishu-Sync-Cli-Token`，以本实现与任务书为准）。

## 四、命令表清单（S9/S10 直接消费）

`GET /api/cli/commands`（CLI 令牌）返回同构元数据。首批 25 条，**全部对照既有路由登记**（未发明 API）：

| 命令 | risk | confirm | HTTP 映射（既有路由） |
|---|---|---|---|
| `status` | read | — | GET `/api/health`+`/api/feishu/lark-cli/status`+`/api/agent/status`+`/api/kb/status`（四步聚合 key: health/larkCli/agent/kb） |
| `auth.status` | read | — | GET `/api/feishu/auth-status` |
| `config.get` | read | — | GET `/api/config`（脱敏） |
| `kb.status` / `kb.changes` / `kb.builds` / `kb.versions` | read | — | GET `/api/kb/status|changes|builds?limit|versions` |
| `llm.test` | read | — | POST `/api/llm/test-channel`（fillDefaults 注入当前 llm 配置） |
| `clean.trash.list` | read | — | GET `/api/trash` |
| `config.set` | mutate | — | PUT `/api/config` 窄 patch；拒 `cli.*`、`llm`/`llm.apiKey`/`llm.providers*`、`agent.workspaces*`（→400 `forbidden_path`） |
| `auth.login.start` / `.complete` / `.cancel` | mutate | — | POST `/api/feishu/auth/device/start|complete|cancel`（complete 标 `stream:'long-poll'`） |
| `lark.install` | mutate | — | POST `/api/feishu/lark-cli/install` |
| `lark.config-init.start` / `.complete` / `.cancel` | mutate | — | POST `/api/feishu/lark-cli/config-init/start|complete|cancel` |
| `kb.build` | mutate | `confirm=BUILD` | POST `/api/kb/builds` `{mode: incremental|full, confirm}`（mode 缺省 incremental） |
| `kb.cancel` | mutate | — | POST `/api/kb/builds/:buildId/cancel` |
| `kb.sources.include` / `.exclude` | mutate | — | POST `/api/kb/sources/selection`（fillDefaults 注入当前 `root`） |
| `clean.trash.restore` | mutate | — | POST `/api/trash/restore` `{obj_token}` |
| `clean.orphans` | destructive | `confirmation=APPLY` | 缺省/`apply:false` → GET `/api/orphan-files`（dry-run 无需确认）；`apply:true` → POST `/api/orphan-files/cleanup` |
| `clean.trash.purge` | destructive | `confirm=PURGE` | DELETE `/api/trash/purge?obj_token=|all=1` |
| `kb.sources.cleanup` | destructive | `confirm=CLEANUP` | POST `/api/kb/sources/cleanup`（fillDefaults 注入 `root`） |

表级不变量（测试锚定）：名称唯一；risk ∈ 4 值；destructive/remote_write 必带 confirm；无 `source.*`（S13 追加）；`agentExposed` 逐条登记。

## 五、实现选择与设计偏差说明

1. **命令执行 = 进程内直调（`app.request()`）**：执行器以父 app 的 `request()` 携 desktop token 转发 spec（不走网络回环），复用既有路由全部校验/错误语义；S10 `app_command` 同构。多步命令（`status`）逐步执行、按 key 聚合，单步失败不中断其余步。
2. **confirm 门**：`def.confirm` 存在且最终请求非 GET 时，外层 body 必须 `body[confirm.field] === confirm.value`，否则 422 `confirmation_required`（details 带 field/value）。GET dry-run 分支（`clean.orphans` 预览）不受限。`kb.build` 为 mutate 级但登记 confirm（后端 createBuild 自身也校验 BUILD，双保险）。
3. **electron/main.ts 未加退出钩子（评估结论）**：Electron 退出唯一路径 QuitCoordinator → `started.close()`，revoke 已内置于 `close()`（HTTP 关闭后执行）；强杀场景由 revoke 的 pid 所有权判定 + 下次 publish 覆盖 + S9 `app_not_reachable` 语义兜底。追加第二处钩子需跨进程导出或重复实现，无净收益。
4. **审计路径**：`<dataRoot>/agent/audit/cli.jsonl`（任务书指定；设计 §6.2 原文 `<dataRoot>/audit/cli.jsonl`）。行格式 `{time, method, path, status}`，仅非 GET，不记 body。
5. **响应包络**＝设计 §6.4 CLI stdout 契约：成功 `{ok:true, data}`；失败 `{ok:false, error:{code, message, httpStatus?, details?}}`，S9 `--json` 模式可直接透传。命令级错误码：404 `unknown_command`、400 `invalid_args`/`forbidden_path`/`invalid_json`、422 `confirmation_required`、401 `cli_token_invalid`、403 `cli_forbidden_route`。

## 六、给 S9 的调用契约

1. 发现：`--home`/`FEISHU_SYNC_HOME`/`~/.feishu-sync` → `run/endpoint.json`（§二格式）。缺失 → exit 3 `app_not_running`；health 不通 → exit 3 `app_not_reachable`。
2. 认证：`X-Cli-Token: <cliToken>`，回环 Host，绝不带 Origin。401 `cli_token_invalid` 时提示「设置 → 命令行访问」。
3. 执行：`POST http://<url>/api/cli/<command>`，body `{ args: {...}, [confirmField]?: confirmValue }`（confirm 字段见命令表，如 `{"args":{"mode":"full"},"confirm":"BUILD"}`）。命令清单 `GET /api/cli/commands`。
4. 退出码映射：200→0；`ok:false` 4xx 业务→1（`confirmation_required`→4）；用法错→2；不可达→3。
5. shim/install-shim、`GET /api/cli/info` 未在本切片实现（S9 按需补服务端点，设计 §6.1 全量字段见彼处）。

## 七、验证证据

- `cd server && npx vitest run tests/cli-endpoint.test.ts tests/ops-command-table.test.ts` → **47/47 全绿**（四态、双向隔离、0600/0700、关闭失效、pid 所有权、rotate、confirm 分支、禁止路径、审计行、unknown_command、参数校验）。
- 全量 `cd server && npm test` → **77/78 文件、992/999 tests 绿**；唯一失败文件 `tests/source-edit.test.ts` 为兄弟切片 S11 在飞产物（任务窗口内实时变化 12→7 failures，其 `source-edit-service.ts` 的 5 个 tsc 中间态错误随后被兄弟自行修复；与 S8 写面零交集，git 归因干净）。测试竞态注意：vitest 文件并行共享 `FEISHU_SYNC_HOME`，本套件已自占隔离根（`tests/cli-endpoint.test.ts` `isolateHome()`），修复了首轮对 vision-routes 套件共享 config.json 的写竞态。
- `cd server && npm run typecheck` → **exit 0**。
- 集成测试发现并修复 1 个真实缺陷：执行器 `getApp` 误回 CLI 子 app 导致转发 404（已改为父 app，测试覆盖）。

## 八、未覆盖 / 风险

- SSE 流式命令（设计表 `kb events --follow`）未登记：`POST /api/cli/:command` 为非流式语义，NDJSON 流转发留给 S9/S10 评估（客户端可直接 GET SSE 端点但需 CLI 域方案，建议 S10 后统一）。
- `app_command`（S10）的批准流/`agentExposed` 过滤未实现（本切片仅提供数据面）。
- Windows ACL 未实测（§11 已列未知项；POSIX 权限断言在测试中跳过 win32）。
- 真机 Electron 退出链路的 revoke 行为以代码路径推演 + 单测锚定，未打包实测（与 electron/main.ts 未改的评估结论配套）。
- 回滚：删除 4 个新源文件 + 2 个测试文件，还原 `types/index.ts`/`config-manager.ts`/`index.ts` 的 S8 标注区段（均为追加式，无交织改动）。
