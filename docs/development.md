# 开发指南

## 环境要求

- Node.js **22.19+（22.x）或 24.x LTS**（实测 v24；CI 用最新22；根 engines 与锁定工具链一致）。此处是开发/打包宿主要求，不改变 Electron31 内置 Node20。
- lark-cli 1.0.89+（全局安装 `npm install -g lark-cli`，用于飞书认证/读取，工具本身零 token）
- 依赖装两份：根目录（前端 + electron + 工具链）和 `server/`（业务 + 测试）

```bash
npm install && cd server && npm install && cd ..
```

## 双包结构（本阶段不迁移 monorepo）

| 包 | 职责 | 测试 |
|----|------|------|
| 根 | React 前端 `src/`、Electron `electron/`、构建脚本 | vitest（`src/**/*.test.{ts,tsx}`，27 文件） |
| `server/` | Hono server、业务模块、运维脚本 | vitest（`tests/**/*.test.ts`，90 文件） |

根 `dependencies` 为空、运行库全在 devDependencies——这是既定结构（打包只收 `server/node_modules/**`，见 `electron-builder.config.cjs` files 列表），不是错误。

## 常用命令（根目录）

```bash
# 开发
npm run dev            # 仅前端 (vite, :5173)
npm run server:dev     # 仅 server (tsx watch, :3001, standalone)
npm run dev:all        # 前端 + server 并行（浏览器调，非 Electron）
npm run dev:desktop    # 编译 server/dist + dist-electron 后并行 vite + electron

# 质量门禁（CI 同口径，提交前必跑）
npm run check          # lint + typecheck + 前端/server 全部测试
npm run lint           # eslint
npm run typecheck      # 根 src（含测试）+ 根配置 + server 三段
npm run test:all       # 双包全部测试

# 构建
npm run build:all      # vite build + server tsc（含 build-agent-assets：prompts/MCP/CLI 产物）
npm run electron:build # esbuild main/preload → dist-electron/*.cjs
```

`build:all` 中的 server build 会同步生成 Agent 工作台资产：内置 prompts/转发扩展复制、独立 MCP CJS（`server/dist/mcp/kb-mcp.cjs`）与 CLI 客户端（`server/dist/cli/feishu-sync-cli.cjs`，esbuild 单文件、零原生依赖）。CLI 的使用与认证见 [agent-knowledge.md](./agent-knowledge.md)「命令行访问」。

单跑 server 测试/用例：

```bash
cd server
npx vitest run tests/sync-engine.test.ts   # 单文件
npx vitest run -t "sheet header"           # 单用例名
```

## 原生模块 ABI（better-sqlite3，最大的环境坑）

better-sqlite3 是原生模块，其 `.node` 二进制 ABI 必须与运行它的运行时一致：

- **桌面打包/跑 Electron**：`scripts/build-desktop-target.cjs` 在构建后跑 `@electron/rebuild` 编成 Electron ABI；验证用 `scripts/verify-abi.cjs`。
- **切回跑测试**：`cd server && npm rebuild better-sqlite3`（恢复 Node ABI）。跑完桌面构建再跑 vitest 时按此切换，否则报 `NODE_MODULE_VERSION` 不匹配。
- **Node 24 teardown 崩溃**：better-sqlite3 11.x 在 Node 24 有 worker teardown 时序缺陷（GC 触发 `Statement::~Statement` 时 env 已销毁，断言崩溃、worker 静默退出）。已升级 ^12 修复；遇类似 worker 崩溃先查原生模块版本矩阵。

## 数据目录与隔离

- 运行时数据：`~/.feishu-sync/`（SQLite + config.json）；`FEISHU_SYNC_HOME` 环境变量可整体改根（server 与 desktop 共享，**不是** Electron userData）。
- 跑测试/调试时建议设 `FEISHU_SYNC_HOME` 指向临时目录，避免污染真实用户数据。

标准库构建的体积校验按有效源文本（主文档、CSV 附件、成功的图片描述和白板文字）计算，产出只计知识正文，不计服务端生成的来源头。正文上限为 `max(有效源文本字节数 × 3, 源数量 × 4 KiB)`，单文件仍最多 1 MiB；短图文源不会再因 Markdown 只有图片链接而误报 `total_too_large`。此规则由 Pi 和 Claude Code 共用。

## 同步性能与诊断

同步页批量提交最多同时推进两篇文档；服务端也设两篇准入上限。同一文档及同一目标路径互斥，拉取期间本地正文有变化则拒绝覆盖。CLI 只允许明确列出的只读命令使用两个进程槽，写入、认证及未知命令独占执行；共享全局 3 QPS、表格 2 QPS 上限，遇到限流后暂停后续准入 3 秒。

只读 Excel 重建从 256 行 × 32 列读取窗口开始；响应截断时二分缩小，并继续验证完整行列坐标、公式和版本。重建成功后从已验证 XLSX 派生 CSV；原件导出模式仍使用原有 CSV 接口。单篇同步中的工作簿元信息、浮动图片清单和图片字节可复用，图片字节内存上限为 32 MiB；结束时释放。

表格单元格页按文档、子表、范围、值/公式模式和云端 revision 缓存在 `<数据目录>/sync-cache/`，有效期 7 天、总量上限 128 MiB，单条上限 1 MiB。缓存损坏或不完整时重新读取；每轮仍查询实时版本，结束时再次校验，权限失败不会使用缓存冒充同步成功。可在应用关闭后删除该缓存目录，下次自动重建。

每篇同步（含失败）会追加 `<数据目录>/sync-performance.jsonl`，记录总耗时、各阶段耗时、CLI 调用数、排队/节流/执行耗时及缓存命中数；日志超过 5 MiB 时保留一份 `.previous`。阶段可能嵌套，不能直接相加作为总耗时。正常同步结果也包含 `performance` 字段。批量同步结束后合并生成一次 `_index.json`；批次中断则在最后一次成功提交后约 60 秒补刷。

固定 1024 行测试中，完整值与公式读取从原先的 32 次降为 8 次。该数字反映请求量；实际耗时还受表格内容密度、截断、图片量、CLI 启动和飞书响应影响，应通过诊断日志对比真实批次。

## 安全红线

- 零飞书 token：全部委托 lark-cli user 认证态；禁止 app_id/app_secret/硬编码 token。
- LLM apiKey 当前明文存 config.json（架构决策，含 `_warning` 字段；加密 deferred）——不要提交任何真实 config。
- 前端改动必须真机浏览器/Electron 交互验证，不能只靠 API 测试。

## Lint / Format

- ESLint（flat config `eslint.config.js`）：只抓代码质量不做格式检查；历史违规已清零，CI 强制。
- Prettier（`.prettierrc.json`）：**渐进采纳**——不做全仓一次性 format（避免无语义大 diff）；新文件建议 `npx prettier --write <file>`。历史遗留的格式差异是已知状态，不算违规。

## 已知技术债（改动时注意）

- `server/scripts/e2e-integration-test.ts` 端口硬编码 `4123`（应为环境变量读取）。
- `electron-builder.config.cjs` 的 appId 仍为 `com.yourcompany.feishu-sync` 占位——**不可随手改**：改 appId 会破坏已发布安装包的更新识别（见 docs/operations.md 发布约束）。
