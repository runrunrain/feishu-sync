# R01 / R04 残留修复验证

日期：2026-10-26（America/Los_Angeles）。用户明确续接残留修复，并授权只读审查子 Agent 独立验收。

## 修复范围

- **R01**：彻底删除 `npm root -g` 可执行发现及测试注入接口。pi 保留常见目录、PATH 入口 realpath、显式包根/CLI 路径定位；非标准 npm prefix 未暴露 pi 时须配置 `piCliPath`。发现不执行 npm shim，也不读取 npm 配置求 prefix。
- 统一运行根策略额外保护 Node 字面/实际目录旁 npm 包目录，以及 `bin/npm` realpath 回溯出的 npm 包根。真实 Workspace 路由、配置反向检查、spawn 和文件工具共用此函数。所有消费者使用 resolver 在本服务生命周期内发现过的运行资源集合，切换配置后仍保护存活旧进程的安装根；就绪缓存失效不会清掉保护集合。
- **R04**：内部 ActiveRun 区分 starting/running/settling；投递要求 running 且 RPC `hasActiveRun()`。RPC 完成同步清除 activeRun，覆盖 await continuation 前的微任务窗口；SessionService 在 run_end 和 get_state 前进入 settling。收尾期间保留运行所有权和池 busy 状态，拒绝插话/排队/切模式；完成后才回 idle。
- 不改 UI、本轮不改原同步流水线、版本与 Electron；无真实用户配置/DB或宿主 npm 写入。

## 修前反例

先加入回归测试，再在未修实现上运行：

```bash
cd server
npx vitest run tests/runtime-resolver.test.ts tests/agent-session-concurrency.test.ts
```

结果：2 文件，3 失败 / 23 通过。临时 npm symlink 入口确实生成了仅位于临时目录内的执行 sentinel；两种 delivery 在活进程已完成、get_state 阻塞时均错误返回 accepted + 旧 runId。未修改或攻击真实 npm。

原始临时日志：`/tmp/feishu-residual-before.log`。此日志可能被清理，以上输入、断言和结果在正式测试与本报告保留。

## 修后消费链验证

`server/tests/helpers/runtime-installation.ts` 在临时目录构造 `<prefix>/bin/node`、`bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js`、npm/lib 和 pi 包元数据。Node 为宿主可执行文件的 symlink，只读执行 --version；npm 若被误执行仅在临时目录写 sentinel。

- resolver：标准布局、找不到 pi 的回退及显式 pi 均不执行 npm；自定义安装位置仍可显式定位。
- 实际 buildServer/Hono Workspace 路由：普通 npm 布局及指向外置包的 symlink 布局都拒绝 npm 包根和 lib 子目录（400），独立文档目录允许（201）。
- 配置反向检查：已授权 npm 目录时改选该 Node 安装被拒绝（400），原 runtime 未落盘改变。
- 内部工具 API：切换安装后，旧 Work 能力对 npm `lib/cli.js` 写入返回 403，原文件逐字节不变，npm sentinel 不存在。
- spawn：旧 Work 绑定在 npm 包内时，resolve 后动态检查拒绝，池中没有新进程或预留。
- settling：延迟 get_state 并保持 fake 进程存活，两种 delivery 均 409、不向旧进程发 steer/follow_up；切模式仍 409。收尾后新消息获得新 runId，确实调用新 prompt。
- 微任务窗口：RPC 已完成但 executeRun 尚未从 await 恢复时，两种 delivery 仍 409。
- 正常运行：steer/followUp 保持同一 run、不抹监听器；无 delivery、模式切换和已退出进程仍按原契约拒绝。

最初三文件针对性验证为34项通过；随后新增微任务两例、spawn一例和A→B活进程一例，最终三文件38项通过。相对交接新增9项。

## 独立审查发现的直接回归及有限修正

首个候选修复只按当前runtime配置更新保护集合。独立审查用临时A/B安装与真实PiRpcProcess无害协议进程复现：切到B后A仍存活，但A.piRoot被授权201、内部写无害说明文件200。该候选未被接受或提交。

本轮改为保留整个服务生命周期的已发现运行根，授权、配置反向检查、spawn和工具动态守卫统一使用同一集合。正式回归保持A进程存活，切B后A的Node/pi/npm目录均400、旧能力写入403且文件不存在；两份npm sentinel都未生成。保护集合在重新检测时保留，到服务重启后才重新建立。

## 最终自动检查

| 命令 | 实际结果 |
|---|---|
| `npm run check` | exit 0；lint 0 error / 2 个既有 hook warning；前端/根配置/server 三段 typecheck；前端 12 文件 95 项、后端 57 文件 750 项全部通过 |
| `npm run build:all` | exit 0；前端、server、扩展/prompts复制及独立 MCP CJS 构建通过；保留 Vite 约529KB单chunk提示 |
| `npm run electron:build` | exit 0；main/preload CJS 构建通过，无 import.meta 警告；不证明 Electron GUI 可运行 |
| 最终构建后 `cd server && npx vitest run tests/mcp-kb.test.ts` | exit 0；4 项，真实 Node stdio 调最终 CJS 的四个只读工具及 CURRENT 换版通过 |

完整 check 包含真实 pi + 本地 OpenAI 兼容 SSE fixture：provider 注册/鉴权传递、正常流式工具轮 steer 同一 run 均通过；真实 pi RPC 探测 5 项通过。它们没有使用真实远程 Key 或请求真实远程模型。

临时日志：`/tmp/feishu-residual-final-check.log`、`/tmp/feishu-residual-final-build.log`、`/tmp/feishu-residual-final-mcp.log`。历史真实 GLM、浏览器及 raw SHA 证据仍在 integration 报告；本轮未改 UI，不冒称重跑全部历史浏览器流程。

## 验收与限制

独立只读复审最终PASS，R01/R04均关闭；审查最终5文件53例、原样A→B反例及真实类同步activeRun检查通过。详见当前 `agent-knowledge-review.md`。上轮唯一增量复审原文保存在 `agent-knowledge-review-previous-incremental.md`，其FIX历史不变。允许按原目标完成本地功能分支提交。

Electron 本机 dyld、Windows/实际安装包、Electron RunAsNode MCP、真实远端 app-llm Key、超大库成本和所有 OS 退出时序仍未覆盖。此次目标为本地开发分支交付，不包含发版；不 push/tag/release，不合 main。
