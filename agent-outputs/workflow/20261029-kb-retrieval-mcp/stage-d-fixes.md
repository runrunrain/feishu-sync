# Stage D：Electron 两项缺陷修复及 CIDR 误报澄清

## 状态与上游

两项真实缺陷完成源码修复及定向验证：Electron 剪贴板写入和启动日志令牌泄露。CIDR 清空经旧候选权威链路核实为测试操作误报，不改业务实现，保留真实持久化回归。worktree 原入口定向测试、typecheck 与构建均通过；真实新包 GUI 尚待 Leader 重包后复验。未安装、重建依赖、重包、提交或触碰共享 ABI。

必读上游：`CLAUDE.md`、`agent-outputs/workflow/20261029-kb-retrieval-mcp/ui-report.md`（真实打包 Electron 段）、`stage-c-review.md`、`package-report.md`；续接证据为 `/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-retrieval-ui/agent-outputs/workflow/20261029-kb-retrieval-mcp/ui-report.md` 最新「旧候选 CIDR 原始链路鉴别」段。worktree HEAD `202f99b` 是以 `c2aca8d` 为父的 harness dirty-snapshot；没有把已存在的 `amagi.json` 等差异归入本轮。

## 产物 / 根因 / 验收映射

| 项目 | 实现与证据 | 当前状态 |
|---|---|---|
| clipboard | 原全局 permission handler 全拒导致文件页 Web Clipboard 写失败。`electron/clipboard-service.ts`、`main.ts`、`preload.ts`、`desktop-contracts.ts` 只加 write-only IPC：唯一当前主窗口 WebContents + mainFrame、string、UTF-8 ≤1 MiB、固定错误且无内容日志；未改 permission handler、未暴露 read/通用 IPC。`src/utils/clipboard.ts` 优先 bridge，缺失走浏览器，native 失败不静默降级。`KbLanMcpSettingsCard`、`AgentSettingsCard`、`CliAccessSettingsCard` 及同根因 `AuthSettingsCard`、`FeishuWriteSettingsCard`、`ChangeItem` 接入；CLI 复制失败显式提示。 | 实现及隔离单测通过；真实 Electron IPC 与系统剪贴板未测。 |
| CIDR 清空 | 不改 `gateway-manager.ts` 或 `ConfigManager`。保留 `KbLanMcpSettingsCard.test.tsx` 的清空提交/回读空框测试及 `server/tests/kb-lan-desktop-fixes.test.ts` 的真实 server→ConfigManager→磁盘→GET→重载→启用真实子进程→服务重启→显式 [] 回归。 | **旧候选误报已澄清**：上游实际 `fill ''` 未触发 React 状态更新，按钮 disabled、无 PUT，旧 toast 被误认成新提交；真实选中并 Backspace 后，PUT 省略 `allowCidrs`、HTTP 200、busy true→false，磁盘和 GET 均无字段，UI 空框，maxSessions=8 保留。`ConfigManager.updateConfig` 本来就对该段整段归一，不是先前假设的 nested merge。本轮曾尝试的 own-undefined 防御改动已局部撤回，不作为修复。 |
| 启动日志 | `server/src/index.ts` 将整份 options 日志改为仅两个显式布尔白名单字段；同一认证令牌日志根因还包括 standalone 直接打印 token，已移除，提示通过 `FEISHU_SYNC_DEV_TOKEN` 配置客户端访问。异常启动代码检查未发现同一 options 整体输出。`server/tests/kb-lan-desktop-fixes.test.ts` 实际启动监听并 spy info/warn/error/log，合成 desktop token 和未知 secret 均不在输出中。 | 原 worktree 入口与隔离源码副本测试均通过；真实新包启动日志待复验。 |

## 命令与实际结果

除特别标注，cwd 为本 worktree，退出码均为 0：

- `npx vitest run src/utils/clipboard.test.ts src/components/KbLanMcpSettingsCard.test.tsx src/components/CliAccessSettingsCard.test.tsx src/components/agent/AgentSettingsCard.test.tsx src/components/AuthSettingsCard.test.tsx src/components/FeishuWriteSettingsCard.test.tsx src/api/kb-lan-mcp.test.ts`：7 文件 51 项通过。bridge 测试涵盖信任帧、其他 WebContents、类型、UTF-8 字节上限、写入异常清洗、native 优先/失败、浏览器 fallback/失败。
- `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.node.json`：通过；对全部本轮 TS/TSX 文件及 server 测试定向 `npx eslint ...` 通过；`git diff --check` 通过。
- `npm run electron:build`：通过，仅 esbuild 编译，未打包。
- `npm run build:all`：**exit 2**；Vite 构建通过（既有 >500KB chunk warning），server tsc 找不到 `@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`、`csv-parser`、`exceljs`、`jszip`、`ssf` 等。该命令可能已刷新 worktree ignored `dist`、`server/dist`，没有把失败构建当可用产物。
- cwd `server/`：`npx vitest run tests/kb-lan-desktop-fixes.test.ts`：**exit 1**，收集阶段找不到 `exceljs`，0 tests。
- 为区分源码缺陷与依赖故障，在独立 `mktemp` 目录复制本 worktree `server/src`、`scripts`、目标测试及 helpers；仅在临时副本将 `node_modules` 链接到 `/Users/run.mao/workpace/feishu-sync/server/node_modules`（不修改该依赖），通过本机 Vitest 执行目标测试：**2 项通过**，真实 HTTP、SQLite、child、重启及 console spy；所有数据为临时 FEISHU_SYNC_HOME、合成内容，服务及临时目录已回收。另用相同复制与依赖链接执行临时副本 `npm run build`：通过，生成 gateway/MCP/CLI。**这两项不是原 worktree 入口通过的证据**。
- 前端 typecheck 初次失败：`ChangeItem` 旧 clipboard 检测在新 helper 下的 TS2774、测试桥类型断言；已改正后重跑通过。未运行全量 check。

### 续接：授权链接与原入口验证

- 仅在本 worktree `server/node_modules` 下创建六个缺失包的符号链接：`@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`、`csv-parser`、`exceljs`、`jszip`、`ssf`，目标分别为主树已有 `server/node_modules` 同名包；已有 `.vite` 未动，不覆盖任何已有项，不安装、不修改共享目标。
- 原 worktree 根目录 `npm run build:all && npm run electron:build`：exit 0；Vite 有既有 chunk >500KB warning，server tsc、资产复制和三个 bundle 均成功，Electron 仅编译未打包。`npm run typecheck`：exit 0（前端、根配置、server 三段）；定向 `npx eslint` 与 `git diff --check`：exit 0。
- clipboard 授权测试补充了精确 1 MiB、超限、非字符串、空 frame 与同一已销毁 WebContents；初次新增空 frame fixture 时 TS 类型断言不兼容，修正测试断言后 `npm run typecheck`、定向 eslint、clipboard 测试均 exit 0。前端七文件 51 项测试通过。
- 原 worktree `server/`：以独立 `mktemp` 作为 `FEISHU_SYNC_HOME`，运行 `npx vitest run --maxWorkers=1 --minWorkers=1 tests/kb-lan-desktop-fixes.test.ts tests/kb-lan-manager.test.ts tests/kb-lan-config-api.test.ts tests/kb-lan-server.test.ts tests/kb-lan-integration.test.ts`：exit 0，5 文件 19 项通过。包含真实监听、SQLite、gateway 子进程及重启、启动日志 spy；测试 fixture 与外层临时目录按各测试及 trap 回收。测试中的合成凭据未输出。

### 最终续接：撤回 CIDR 业务改动后的回归

- 局部撤销 `server/src/kb-lan/gateway-manager.ts` 的 own-undefined 改动，恢复原实现；没有更改 ConfigManager 或其他 CIDR 业务代码。
- 原 worktree `server/` 以临时 `FEISHU_SYNC_HOME` 重跑上一条五文件 Vitest 命令：exit 0，**19/19 通过**。包括原实现下实际 PUT、GET、落盘重载、启用/重启、显式空数组及日志回归；本轮测试临时状态与子进程按测试及 trap 清理。
- Leader 反馈主树已集成其余全部源码并构建成功（`bg-0924664c`）；这是 Leader 转述，不是本 worktree 独立重跑该主树命令的证据。本轮按指示未再执行全构建。

## 边界与建议

1. 原入口依赖阻断已按续接授权解决；六条本地链接留在 worktree 中，未改共享目标。失败记录保留作为历史证据。
2. 旧候选 CIDR 误报已由上游真实请求与持久化证据撤回；本轮没有因误报修改业务逻辑。测试不会替代新版 Electron 最终复验。
3. 此次没有运行新版真实 Electron GUI、未重包、未验证系统剪贴板读回或视觉；前端修改不能以单测代替真机交互。Leader 整合后重包、新版真实 Electron 复验三项，再做一次安全增量审核；阶段 C 旧 PASS 不覆盖此 diff。
4. standalone 开发模式不再在终端泄露随机 token；手动 API 客户端若需固定凭据应设置 `FEISHU_SYNC_DEV_TOKEN`，不要记录其值。未验证所有独立开发客户端使用方式。

## 回滚

只按本轮文件 diff 局部移除 clipboard bridge/helper 和对应调用、启动白名单日志与测试；CIDR manager 改动已撤回。不要对工作区做 reset/restore，不删除其他任务文件或共享依赖。ignored 编译输出可由 Leader 在适当环境重新构建；无提交。
