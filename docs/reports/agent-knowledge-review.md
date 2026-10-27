# R01 / R04 显式续接独立复审

**VERDICT: PASS（本地开发分支安全验收）**

日期：2026-10-26（America/Los_Angeles）。本轮由用户明确续接，并单独授权只读审查子 Agent `/root/residual_review`。R01 / R04 均关闭；旧增量复审关闭的其余9项保持。该结论不覆盖安装包/跨平台发版验收。

上轮 FIX 原文保存在 [上轮唯一增量复审](agent-knowledge-review-previous-incremental.md)，最初审核在 [初审历史](agent-knowledge-review-initial.md)。未改写历史失败为通过。本轮实施与全量验证见 [残留修复验证](agent-knowledge-residual-validation.md)，全过程见 [集成记录](agent-knowledge-integration.md)。

## 关闭矩阵

| 编号 | 最终结论 | 独立复核依据 |
|---|---|---|
| R01 Critical | 关闭 | `npm root -g` 及测试注入接口已删除，没有保留可执行回退；标准目录/PATH入口/显式pi路径发现保留。npm实际包根、Node/pi根通过同一生命周期保护集合供Workspace授权、配置反向、spawn和工具动态守卫使用。临时标准/外置npm symlink布局拒绝授权，普通资料允许；旧能力403、spawn前拒绝。 |
| R04 Major | 关闭 | SessionService running/settling状态与真实PiRpcProcess activeRun双守卫。活进程已settled、get_state延迟的窗口，以及await恢复前微任务窗口，两种delivery均409、不向旧队列发送命令。正常steer/followUp同run、不抹监听、模式切换409、收尾后新run均通过。 |
| R02/R03/R05–R11 | 保持关闭 | 沿用上轮独立关闭结论，本轮未重开无关设计。统一检查覆盖相关既有回归；不把本轮局部复审称为重新完整审计。 |

## 本轮审查发现、修正与复核

首个候选改为仅保护当前runtime配置，导致A→B切换后旧A进程仍存活，却释放了A安装根。审查员使用临时A/B安装、真实PiRpcProcess类运行无模型的无害协议fixture，确认：

| 同一反例 | 切换前A授权 | 切换到B | 切换后A授权 | 旧能力写A | 旧A仍存活 | 文件创建 |
|---|---|---|---|---|---|---|
| 首候选（FIX，未提交） | 400 | 200 | 201 | 200 | true | true |
| 最终候选（PASS） | 400 | 200 | 400 | 403 | true | false |

该写入仅为临时包中的无害说明文件，没有攻击载荷或宿主npm改写。修正为服务生命周期保留所有已发现的运行资源，不因配置切换或就绪invalidate撤销保护；所有消费者统一合并。正式回归加入 `protected-workspace.test.ts`。审查员原样重跑独立反例确认修复，未用新的弱fixture替换原失败输入。

原失败与最终日志：`/tmp/feishu-independent-live-root-repro.log`、`/tmp/feishu-independent-live-root-final.log`。临时日志不保证长期存在，上表与正式回归保存结论及输入。

## 独立实际执行

cwd=`server/`：

```bash
npx vitest run tests/runtime-resolver.test.ts tests/protected-workspace.test.ts tests/agent-session-concurrency.test.ts tests/agent-session.test.ts tests/agent-assets-cjs.test.ts
```

最终冻结代码 **5文件53例，exit0**；日志 `/tmp/feishu-independent-residual-final.log`。此外独立执行真实pi＋本地OpenAI SSE fixture两例通过（生命周期根最终补强前）；最终补强后主会话的全量check再次实际执行这两例通过。

审查员额外用 `node --import tsx --input-type=module` 加载真实PiRpcProcess类、stub成功命令响应，经真实 `handleLine` 注入message_end/agent_settled；同步观察hasActiveRun从true变false，再等待prompt返回completed。此项没有spawn，证明真实类内部同步状态，不冒充真实pi进程往返。

审查全程只读仓库；仅在临时安装/测试home写测试资料，未读真实凭据、未改宿主npm、未改用户配置或DB。

## 主会话最终检查与边界

主会话最终 `npm run check`：前端12文件95例、后端57文件750例；lint 0 errors（2既有hook warning），三段typecheck通过。`build:all`、`electron:build`、最终MCP CJS真实stdio四例及diff检查通过。保留Vite约529KB chunk提示。

本轮没有UI修改；采用此前已记录的真实浏览器/GLM/raw SHA证据，没有冒称重跑完整浏览器流程或真实远端app-llm Key。Electron GUI仍受既有dyld环境阻塞，Windows/安装包、Electron RunAsNode、真实远端Key、大库成本和全部OS退出时序未覆盖。不升级版本、不合main、不push/tag/release；允许按原目标提交本地功能分支。
