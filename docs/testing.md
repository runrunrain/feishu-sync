# 测试指南

## 布局与运行器

| 测试面 | 位置 | 运行器 | 入口 |
|--------|------|--------|------|
| 前端单元 | `src/**/*.test.{ts,tsx}` | vitest（根，`vitest.config.ts`，约 85 个文件） | `npm test` |
| server 单元 | `server/tests/*.test.ts` | vitest（server，`server/vitest.config.ts`，约 237 个文件） | `npm run test:server` |
| 全部 | — | — | `npm run test:all` |

文件数为 2026-11 实测（`find src -name '*.test.*'` / `find server/tests -name '*.test.ts'`），随开发滚动，以目录为准。双 vitest 配置显式声明各自 include 范围：根配置只扫 `src/`，server 配置只扫 `server/tests/`——避免 server 测试误解析根 `node_modules` 的 better-sqlite3（Electron ABI 场景）。

## 环境注意

1. **自动隔离数据目录**：`server/vitest.config.ts` 的 globalSetup 在测试模块装载前创建临时 `FEISHU_SYNC_HOME`，结束后清理；普通 `npm test` 与 `npx vitest run` 均不会使用真实 `~/.feishu-sync`。由 `test-environment.test.ts` 守护，单个测试另建 fixture 时也必须只用临时目录。
2. **ABI 切换**：跑过桌面构建（`@electron/rebuild`）后需 `cd server && npm rebuild better-sqlite3` 恢复 Node ABI，否则直连 better-sqlite3 的用例报 `NODE_MODULE_VERSION` 不匹配。
3. **Node 24**：better-sqlite3 必须 ^12（11.x 在 Node 24 worker teardown 时崩溃，见 docs/development.md）。

## 编写约定（既有模式，沿用）

- **算法层 + in-memory mock**：server 测试倾向 mock LarkCliClient/LocalMapStore 接口（参考 `change-detector.test.ts` / `sync-engine.test.ts` 的 mock 模式），不依赖真实飞书凭据与网络。
- **round-trip 用例**：Markdown header 契约（`generateHtmlHeader` ↔ `parseMetadata`）必须有 round-trip 验证（`sync-engine.test.ts` (d) 项用例模式）。
- **类型即检查**：前端测试文件已纳入根 `tsc --noEmit`（`tsconfig.json` include `src` 不再排除 `*.test.*`）；测试断言要与受测类型同步演进。
- **hook 依赖**：`react-hooks/exhaustive-deps` 以 warning 运行；源码中存在多处已知 `eslint-disable react-hooks/exhaustive-deps`（以 `grep -rn 'exhaustive-deps' src/` 为准），改动相关组件时人工确认依赖数组。
- **ESM interop 遗留**：`server/tests` 少量文件用 `const { x } = require('...')`（依赖 vitest SSR transform 的 CJS interop，运行合法）；新测试请用 `import`。

## 验证层级与 CI 拆分

- 提交前：`npm run check`（lint → typecheck → 双包测试，与 CI 同项目集）。
- CI（`.github/workflows/ci.yml`）分两步执行测试，且均套 `xvfb-run`：
  1. **Test (frontend + server)**：根测试 + server 测试，但 **排除 `tests/pi-plugin-service.test.ts` 与 `tests/pi-native-work.test.ts`**（需要真实 pi 包，不进依赖树）；
  2. **Test Pi integration**：单独在临时目录安装 `@earendil-works/pi-coding-agent@1.4.0`，以 `FEISHU_SYNC_PI_CLI` 指向该安装运行上述两个文件。
  本地复现：`npm install --no-save --no-package-lock @earendil-works/pi-coding-agent@1.4.0`（或任一 ≥1.4/<2 的 pi 安装）后设 `FEISHU_SYNC_PI_CLI` 指向其 bin，再单跑这两个文件。
- 前端 UI 改动：测试之外必须真机浏览器/Electron 交互验证（项目安全红线）。
- 桌面打包链：仅 release workflow 覆盖（tag 触发），日常 CI 不打包。

## Agent 工作台的证据分层

| 层 | 能证明什么 | 不能替代什么 |
|---|---|---|
| 算法/内存单测 | 路径、集合、覆盖、状态分支和边界输入 | 实际路由派生的保护根、进程回收、UI接线 |
| 本地协议fixture | provider注册、环境变量、请求/流格式及受控并发 | 真实模型可调用、真实内容质量 |
| 真实pi RPC | 扩展装载、命令白名单、JSONL和工具规格 | 未发prompt时不能证明模型生成成功 |
| 临时资料的真实模型往返 | 本应用工具确实读取/写入及实际构建发布 | 生产知识库、大库性能或全部提供商兼容性 |
| 真实浏览器/桌面 | 实际UI、fetch SSE、权限确认与失败反馈 | 不能凭绿色状态或截图文字断言文件/DB已正确提交 |

### 回归入口（按域分层；清单滚动，以 `ls server/tests/` 为准）

237 个测试文件不逐个罗列；改动某域时按前缀聚合运行该域（`npx vitest run tests/<前缀>*`），全量回归仍走 `npm run check`：

| 域 | 文件名前缀（节选） | 说明 |
|---|---|---|
| 同步核心 | `sync-engine`、`change-detector`、`layout-reconstructor`、`atomic-commit`、`custom-folders`、`lark-cli-*`、`content-backend`/`direct-channel` | 含 header round-trip（sync-engine (d) 项） |
| Agent 运行时 | `agent-session`、`agent-config`、`agent-status-regression`、`agent-process-pool`、`agent-internal-auth`、`path-guard`、`session-*`、`sse-*` | 会话/SSE/进程池/围栏 |
| 任务与工具 | `agent-tasks`、`agent-approvals-routes`、`agent-tool-families`、`app-command-family`、`ops-command-table` | 任务编排与批准流 |
| 构建编排 v2 | `build-runtime-*`（dispatch-guard、dispatch-inflight、checkpoint、automatic-recovery、integrity、e2e 等 20+ 文件）、`build-orchestration`、`build-actors`、`build-metrics*`、`publish-readiness`、`publish-render`、`kb-build*`、`kb-path-claims`、`kb-build-units` | 见 [build-orchestration.md](./build-orchestration.md) |
| Claude 运行时 | `claude-*`、`anthropic-auth`、`thinking-capabilities`、`session-model-routes` | 见 [claude-runtime.md](./claude-runtime.md) |
| 检索与 MCP | `kb-search`、`kb-lan-*`（http/security/manager/watchdog/performance 等）、`mcp-kb`、`portable-kb-service`、`kb-discuss-integration` | LAN MCP 见 [kb-lan-mcp.md](./kb-lan-mcp.md) |
| 源操作 | `source-edit`、`source-push`、`trash-llm-routes`、`cloud-*` | 源受控写与云端操作 |
| 视觉/描述 | `vision-*` | 图片理解通道 |
| 前端 | `agentReadiness`、`sseStream`、`MarkdownView*`（含 defects 导出形态回归）、`remoteImageConsent` | 根 `src/` 下 vitest |

实际测试文件以目录和统一入口为准，不以此表数量为门禁。

### 专项测试要诀（沿用）

- 权限测试要调用实际Workspace/配置路由，覆盖授权后再改raw/std/Node/pi根；只测`isPathInside`不足以证明真实保护根完整。
- 生命周期测试要覆盖未spawn前的容量限制、失败/自然exit/idle/close后的能力撤销，以及busy期间不会按idle回收。
- 发布测试须用已有相同buildId复现指针后DB失败，注入指针后的清理故障；不能用空库对账冒充真实恢复。
- SSE须先连接空会话再发消息，覆盖0游标、过期游标、缓冲溢出、完整DTO、多工具轮及下一轮、停止ACK乱序。普通事件解析通过不等于HTTP消费者可用。
- 对比完整raw字节hash、CURRENT与已发布文件；脚本仅检查某个内容标记时，报告必须明示它不是完整hash保护证明。
- 截图保留错误现场；文件名不是视觉证据。停止请求、aborted文本和最终idle要分别核对，不把中间截图当最终状态。

真实模型smoke按[运维指南](operations.md)显式使用临时目录。未安装pi、模型无认证或平台运行受阻时保留准确跳过/未覆盖，不用fixture、可用列表数量或SQLite编译成功冒充端到端成功。
