# T4 文档全面更新报告

> 任务：把 2026-10 kb-agent-upgrade（S0–S14 + T3 系列修复，含 a5d2eaf）的事实并入八份项目文档。
> 代码基准：`feat/agent-knowledge-workbench` @ a5d2af（T3e 修复已提交，工作区 clean）；所有事实以工作区当前代码为准，写作前逐项 grep/read 验证。
> 纯文档任务：未改任何代码，未运行测试（仅 layout-reconstructor 单文件 `npx vitest run` 用于核实用例数，6 passed）。

## 一、逐文档改动点

### 1. CLAUDE.md
- **Commands/构建节**：注明 `build:all` 内含 `build-agent-assets.mjs`，产物含独立 MCP（`server/dist/mcp/kb-mcp.cjs`）与 CLI 客户端（`server/dist/cli/feishu-sync-cli.cjs`）。
- **Agent 标准知识库工作台节**：
  - 首条：补读 `docs/design/kb-agent-upgrade-design.md`（升级增补）；目录清单扩为 `agent/ kb/ mcp/ sources/ ops/ cli/`。
  - 插件条：knowledge-workbench 内置包配置项增「任务编排」。
  - 新增子节「2026-10 升级增补（kb-agent-upgrade S0–S14 已合入）」七条：双模型与并行构建（vision/build-units/path-claims/source-images/mediaHash/buildParallelism）、进程池准入（acquire FIFO、后台 ≤ M−1、默认 3）、任务编排（tasks/+roles/+agent_tasks+角色卡+工具交集）、CLI 与运维命令面（command-table 30 条、endpoint.json、X-Cli-Token 三重校验、令牌双向隔离、退出码、config.set 禁改面）、app_command 批准流（confirm 剔除+运行轮次绑定）、源库受控写与写回（SourceEditService/FeishuWriteService 三段式/local_edit_pending/不推进 synced 基线/scopeSet write）、原始库写者不变量修订（基线 §13.1）。
- **数据层节**：补 agent_tasks/source_edits 两新表、kb_builds 增列（parallelism/unit_total/vision_model/warnings_json）、additive 双登记、config 工作台段（agent.vision/orchestration、standardKb.buildParallelism、cli/feishuWrite 可选段）。

### 2. docs/architecture.md
- 锚点声明补「feat/agent-knowledge-workbench 工作台升级」。
- **模块地图**：`agent/` 条目扩（进程池 acquire/工具族注册/tasks+roles/vision/approvals）；`kb/` 条目扩（build-units/path-claims/source-images、buildParallelism）；新增 `sources/`（四文件职责）、`ops/`（30 条命令表）、`cli/`（CLI 源码+cli-endpoint+cli-auth）三条目。
- **Agent 侧车与标准库节**：新增四条要点（app_command 批准面、并行构建语义、CLI 边界、源编辑与写回边界）；尾条链接补升级增补设计。
- **关键不变量**：#4 增写回飞书凭据形态句；新增 #6「原始库受控写者清单」（SyncEngine/源生命周期/SourceEditService、feishu_sync 头只由 SyncEngine 生成、local_edit_pending、写回不推进 synced 基线）。

### 3. docs/data-contract.md
- **Agent 与标准库节表**：新增 7 行（agent_tasks、source_edits、vision-cache、source-edits 备份、agent/audit/{cli,source-edits,source-pushes}.jsonl、run/endpoint.json）；kb_builds 与 releases 行补增列与 mediaHash。
- 表后段落：补 additive 双登记提醒；配置段扩为 agent（vision/orchestration）/standardKb（buildParallelism）/cli/feishuWrite（默认关、只接受 desktop token）/supportsImages；maxConcurrentProcesses 与 buildParallelism 默认值。
- **写盘安全节**：补 local_edit_pending blocker；新增「源编辑写入（SourceEditService，另序）」条目（写锁→OCC→原 header 字节+新 body→fsync+rename→写后 parseMetadata 复核→失配恢复）。

### 4. docs/development.md
- 双包测试计数更新：前端 8→27 文件、server 43→90 文件（实测 `find src -name "*.test.*"`=27、`server/tests/*.test.ts`=90）。
- 构建命令注释补 build-agent-assets 产物说明与 CLI 文档指引。

### 5. docs/operations.md
- Agent 工作台验证与打包节：build-agent-assets 产物增 CLI CJS；asarUnpack 核对清单加 CLI；新增 CLI 打包形态条目（install-shim → `<dataRoot>/bin/feishu-sync` + `.cmd`、打包版 ELECTRON_RUN_AS_NODE、退出码 3 语义、无离线直写）。

### 6. docs/testing.md
- 重点回归入口清单扩：server 侧补 agent-process-pool/agent-tasks/agent-approvals-routes/agent-tool-families/app-command-family/ops-command-table/kb-build-parallel/kb-build-units/kb-path-claims/kb-source-images，升级新增面（vision-*、cli-*、source-edit/source-push、layout-reconstructor 6 用例）与前端 MarkdownView.defects。

### 7. docs/README.md
- 索引表：agent-knowledge.md 行描述补任务编排/CLI/源编辑写回；agent-knowledge-design.md 行标注「基线，含 §18 升级增补索引」；新增 design/kb-agent-upgrade-design.md 行。

### 8. README.md（根）
- 开发分支预览块：功能清单扩（双模型图片理解/并行构建/任务编排/CLI/源编辑写回）；安全复审状态改为「残留修复已通过独立安全复审」，保留未发版与验证边界警示（对齐 agent-knowledge.md 现状）。
- 技术栈：lark-cli 行补「1.0.97 的 config init 双形态 URL 已兼容」与写回入口；Agent 行补 CLI 产物。

## 二、grep 一致性核对清单（文档声明 → 代码证据）

| 文档声明 | 核对证据 | 结果 |
|---|---|---|
| `server/src/sources/` 四文件 | ls：source-edit-service/feishu-write-service/push-planner/source-write-lock.ts | ✓ |
| `ops/command-table.ts` 30 条命令 | `grep -c "name: '"` = 30（status…source.push） | ✓ |
| `server/src/cli/` 源码 + `dist/cli/feishu-sync-cli.cjs` | ls cli/{args,cli-app,client,main,output}.ts；ls dist/cli | ✓ |
| `<dataRoot>/run/endpoint.json`（0700/0600、tmp+rename、pid revoke） | cli-endpoint.ts（writeEndpointFile/revoke） | ✓ |
| `X-Cli-Token` 三重校验（回环+无 Origin+timing-safe）、审计 `agent/audit/cli.jsonl` | middleware/cli-auth.ts（CLI_TOKEN_HEADER/appendAudit） | ✓ |
| `/api/cli/enable`、`/api/cli/token/rotate`（desktop 域）、`/api/cli/commands`、`/api/cli/:command`、`/api/cli/info`、`/api/cli/install-shim` | routes/cli.ts:82,116,139,143；routes/cli-admin.ts:149,169 | ✓ |
| `/api/agent/vision/status|test`、`/api/agent/tasks*`、`/api/agent/sessions/:id/approvals*`（decide） | routes/agent.ts:476,494,548-597,290,305 | ✓ |
| `/api/sources/edits[/:objToken]`、`/api/sources/:objToken/edit-status|edit|revert`、`/api/sources/:objToken/push/preview|push` | routes/sources.ts、routes/feishu.ts:365,388 | ✓ |
| auth device/start `scopeSet`、`WRITE_SCOPES=['docx:document:write_only']`、`writeScopesGranted` | routes/feishu.ts:128-152；lark-cli-manager.ts:94 | ✓ |
| CLI shim `<dataRoot>/bin/feishu-sync`（0755）+ `.cmd`、`--json/--home/--yes/-y`、退出码 0/1/2/3/4 | cli-admin.ts:147；cli/args.ts:99-111；cli/main.ts（exitCode）、cli-app.ts（帮助文本） | ✓ |
| `acquire('session'|'background')` FIFO、后台 ≤ M−1、maxConcurrentProcesses 1..6 默认 3 | agent-process-pool.ts（PoolAcquireKind/backgroundLimit）；types/agent-knowledge.ts:131；config-manager.ts:310-318 | ✓ |
| `standardKb.buildParallelism` 1..6 默认 2 | types:144、config-manager.ts:379-386,482-486 | ✓ |
| `agent.vision`（缺省 disabled）、`agent.orchestration`、`cli?`/`feishuWrite?`、`supportsImages` | types/agent-knowledge.ts（AgentVisionConfig/buildDefaultAgentConfig）；types/index.ts:55,57,111；config-manager.ts:612,692 | ✓ |
| `agent_tasks`/`source_edits` 新表 + idx；kb_builds 增列 4 项 | local-map-store.ts:100-103,236-266,2442-2658 | ✓ |
| `source_edits` 状态 dirty/pushing/pushed/conflict、启动 pushing→conflict | source-edit-service.ts / local-map-store（状态机注释） | ✓ |
| `local_edit_pending` blocker 贯穿 sync-engine/trash/source-cleanup/orphan-files | grep 四文件命中（sync-engine.ts:286 等） | ✓ |
| 审计 `agent/audit/source-edits.jsonl`、`source-pushes.jsonl`；备份 `source-edits/<objToken>/base.md`+近 20 份 | source-edit-service.ts:14-15,39,307；feishu-write-service.ts:33 | ✓ |
| `mediaHash`/`imageCount` 快照条目、vision-cache 路径形态 | kb-build-service.ts、source-images.ts；vision-describer.ts:9,97 | ✓ |
| `kb_unit_done`、`kb_finish` 收尾轮、`kb_path_owned_by_other_unit`、`raw_read_image`、`task_submit` 系 | tool-specs.ts:224；agent-tool-service.ts、task-tools.ts | ✓ |
| `registerToolFamily()` 工具族注册 | agent-tool-service.ts:230,275-286；tools/app-command-family.ts:194 | ✓ |
| 三张角色卡 analyst/converter/reviewer | agent/roles/{kb-analyst,kb-converter,kb-reviewer}.md | ✓ |
| 批准流 confirm 剔除 + 运行轮次绑定 + 跨会话任务归属校验 | a5d2eaf 提交说明 + app-command-family.ts/approval-service.ts/task-service.ts | ✓ |
| `config.set` 禁改面（cli/llm/llm.apiKey/llm.providers/agent.workspaces/feishuWrite）、PUT /api/config 对 CLI 主体丢弃 feishuWrite | ops/command-table.ts:107-125；routes/config.ts:163-175 | ✓ |
| 测试计数 27/90、testing.md 新测试文件名 | find/find 实测；ls server/tests（vision-*、cli-*、source-edit/push、kb-build-units/path-claims/source-images、agent-tasks、approval*、ops-command-table、layout-reconstructor） | ✓ |
| layout-reconstructor 专项 6 用例 | `npx vitest run tests/layout-reconstructor.test.ts` → 6 passed | ✓（任务书称 8，实测 6，见出入记录） |
| CONFIG_INIT_URL_RE 双形态（1.0.97 config init） | lark-cli-manager.ts:72-79,881 | ✓ |
| 错误码引用（~31 个，设计 §8/基线 §8 已登记） | 两份设计文档 §8 表；文档仅引用不重抄 | ✓ |

未写入文档的遗留项（按任务书要求不写成已实现）：CLI 不支持 scopeSet 写授权、kb events 未登记 CLI 命令表。

## 三、三份未动文档与代码的出入记录（仅记录，未修改）

### docs/design/kb-agent-upgrade-design.md
1. §6.2 令牌头名 `X-Feishu-Sync-Cli-Token` → 实现为 `X-Cli-Token`。实现文件 cli-auth.ts 已注明「任务书指定；S9 报告契约以本文件为准」，即差异由实现裁定，设计正文保留原文。
2. §6.2/§7.2 审计路径 `<dataRoot>/audit/cli.jsonl` 与 `<dataRoot>/audit/source-writes.jsonl` → 实现统一在 `<dataRoot>/agent/audit/` 下，且文件名为 `cli.jsonl`、`source-edits.jsonl`、`source-pushes.jsonl`（写回审计独立成文件而非统一 source-writes）。
3. §6.2「与 desktop auth 组合为『desktop token 或 CLI token』」→ 实现为完全分离域：desktop auth 中间件不接受 CLI 令牌（auth.ts 无 X-Cli-Token 分支），CLI 令牌只在 `/api/cli/*` 域有效。
4. §6.5 批准决定路径 `POST /api/agent/sessions/:id/approvals/:approvalId {decision}` → 实现为 `POST /api/agent/sessions/:id/approvals/:approvalId/decide`。
5. §4.7 进程池 acquire kind 枚举 `'build-worker'|'build-final'|'task'` → 实现归并为 `'session'|'background'` 两类（后台统一配额 M−1，key 仍按用途区分）。

### docs/design/agent-knowledge-design.md（基线）
6. §4.5 仍写「`agent.maxConcurrentProcesses` 默认 2（构建占 1，会话占其余）」→ 与 §5.2（默认 3，范围 1..6）及代码默认 3 不一致；§4.5 属 S14 未回改的陈旧段。
7. 其余（§5.2 配置、§7.1 工具表、§8 错误码、§13 不变量、§18 索引）与代码一致。

### docs/agent-knowledge.md
8. 抽查（CLI 命令示例/退出码/设置入口名「设置 → 应用 → 命令行访问」/MCP 四工具/任务编排/图片理解/源编辑写回流程）与代码一致，未发现出入。

### 附带代码内注释瑕疵（非文档，仅记录）
- `server/src/types/agent-knowledge.ts` 中 `buildParallelism` 注释「缺省/旧配置无此字段 → 1」与实际不符：config-manager 归一回落 `base.buildParallelism`，而 `buildDefaultStandardKbConfig` 默认 2（旧配置缺字段实际得 2，不是 1；「=1 等价旧行为」的回退语义仍成立）。
- 任务书称 layout-reconstructor 专项测试「从零到 8 用例」，实测 6 用例（3 个 describe、6 个 it，vitest 实跑 6 passed）。

## 四、验证与自检

- 纯文档任务：八份文档全部经 edit 精确修改，未触碰代码与三份冻结文档。
- 全部新增声明按上表 grep/read 核对；tsc --noEmit（server）通过（文档改动不影响的 sanity 检查）。
- 篇幅策略：增量并入，未重写既有章节；各文档保持原受众与风格（CLAUDE.md 指导密度、README 用户向、docs/* 开发/运维向）。
- 未覆盖/风险：文档中「约 31 个新错误码」以设计文档 §8 登记为准未逐一重抄；Electron 打包态 CLI/ELECTRON_RUN_AS_NODE 冒烟属 operations.md 既有验证边界条目，本次未新增运行证据。
