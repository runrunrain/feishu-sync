# UI 真实 API 验收报告（ui-real-api-acceptance · 临时 Hono 后端 + 主树 Vite 前端）

- 执行方式：临时 hold 服务器（`/tmp/feishu-build-v2-ui/hold-server.ts`，复用 e2e fixture 状态机 + 真实 `buildServer({desktopMode, corsDevMode:true})`）+ 主树 `npx vite --port 5173`（`BACKEND_PORT`/`FEISHU_SYNC_DEV_TOKEN` proxy 注入）。**非真人 Electron，浏览器为 agent-browser 自动化**。
- 环境：`FEISHU_SYNC_HOME/HOME/PI_AGENT_DIR` 全临时（`/tmp/feishu-build-v2-ui/`）、假密钥 `fixture-key`；模型为本地 fixture（确定性三态机，非真实 LLM 质量）；生产 `~/.feishu-sync` 未触碰（config.json mtime Oct 31 不变）。
- 真实点击 vs 预置：**真实点击**＝编排模式选 pi-amagi+保存、宿主刷新/安装（source 模式真实 pi CLI）、两次（后三次）「构建所选文档」→确认构建；**预置**＝hold 脚本写入 config（fixture provider/源文档 tok1 登记）。构建由 UI 按钮真实 POST 触发，非脚本直调。

## 一、ACHIEVEMENT

| 验收 | 证据 | 状态 |
|---|---|---|
| 真实 API 读新模式（点选 pi-amagi 保存） | 浏览器点选 → `GET /api/config` 返回 `orchestrationMode=pi-amagi`（curl 复核落库） | ✅ |
| 安装探测（未安装→已安装） | shot-02（未安装+静态未过+14 项明细含真实失败原因）→ 点击安装 → shot-03（已安装 2.21.31+静态通过 15 项+完整验证未达）；install-record.json（layout:source，真实 pi CLI） | ✅ |
| 一次构建运行+published 终局 | 3 次真实构建全 published（r_…bab6f2 / r_…0476b2 / 第三次同链）；shot-04/05/07/08；发布产物真实渲染（shot-10 目录树+正文、shot-11 版本记录两 release） | ✅ |
| 非百分比进度 | 视觉证据：阶段流水（排队/预检/生成/校验/发布）+汇总三格，视觉模型确认「不存在任何百分比」 | ✅ |
| 未知 usage 不伪造 | 「末次轮次用量：入 10/出 5（累计未知：父子去重后不可得，不假累加）」「子任务用量不经 Leader 事件（未知）」逐字转写 | ✅ |
| pending/confirmed 与 native execState 区分 | 子任务行两枚分开标签（视觉证据：「异常+已确认」「已停止+已确认」；单测覆盖 pending=身份待确认） | ✅ |
| published 时 task 仍 running → 最后观测标记 | 终局后 11/12 条 running →「已停止」（非活跃标记，视觉转写 shot-16） | ✅ |
| termination/publishRequest/报告/恢复级别真字段不崩 | `已结束（publish-accepted）`、发布申请 `…全部成果通过审查（fixture e2e） 已接受`、恢复能力「可原会话续接」、skill 哈希、版本记录真字段全渲染无崩溃 | ✅ |
| 发现后端问题只报告不绕过 | 见 §二（orchestrationMode 终局丢失）；未改后端源 | ✅ |
| 截图+DOM/请求证据 | `/tmp/feishu-build-v2-ui/shot-01..16.png` + a11y snapshot 文本 + curl DTO；关键截图经视觉模型委托核验（本模型无视觉，未看过的不声称看过） | ✅ |
| 复测单测/typecheck | `vitest run` 3 文件 **62/62**（EXIT=0）；`tsc --noEmit -p tsconfig.json` EXIT=0；eslint 改动面 EXIT=0 | ✅ |
| 清理无残留 | vite/hold-server（SIGTERM→`[hold] closed`）/浏览器全关；端口 5173/50081/50080 无监听；无本任务 pi/amagi 子进程（ps 复核；命中的均为其他会话宿主） | ✅ |

## 二、发现的后端契约缺口（原错 + 最小建议，未绕过）

**终局构建 DTO 丢失 `orchestrationMode`**：`kb-build-service.toDto()` 仅在内存 entry 存活时附加该字段（`entry?.orchestrationMode === 'pi-amagi'`）；构建结束/重启后从 DB row 恢复，而 `kb_builds` 行与检查点 `state.json` 均未持久化 orchestrationMode（实测 `cp_…/state.json` keys 无此字段）。后果：POST 响应与构建中 DTO 带 pi-amagi，published 后 SSE/GET 推送的 DB DTO 丢字段 → 前端 `BuildOrchestrationProgress` 按 `?? 'legacy'` 安全降级为旧式视图（shot-08「旧式构建…」说明行，不崩、不伪造，但终局看不到 Leader 监督进度与任务行）。
最小建议：检查点 `state` 持久化 `orchestrationMode`（additive），或 `toDto()` 在 entry 缺失时回退检查点（恢复路径 691 行已有 `checkpoint.leaderRun ? 'pi-amagi' : 'legacy'` 同语义，可复用 leaderRun 判定）。

## 三、本轮前端修复（写面内，叠加在 87ca4440 未提交改动之上）

1. `BuildOrchestrationProgress.tsx`：leader 404 降级改为**终态才定格**——构建启动窗口 leaderRun 未建立会短暂 404（真实实测：POST 返回即拉 404，数秒后 200），原实现首轮 404 即永久 `unavailable`，数据就绪后不再轮询（shot-05 复现、构建二「运行进度加载中…→真实渲染」验证修复）。
2. `LEADER_EXEC_STATE_LABEL`/`stateTone` 补 `error: '异常'`（bad tone）：真实链路实测 amagi native execState 出现 `error` 值（此前显示原文）。
3. 测试：`BuildOrchestrationProgress.test.tsx` 新增「非终态 404 不定格、后续就绪恢复渲染」「execState=error 异常标签+bad tone」两用例；原 404 用例改为终态语义（21 用例全绿）。
回滚：`git checkout -- src/components/knowledge/BuildOrchestrationProgress.tsx src/components/knowledge/BuildOrchestrationProgress.test.tsx`（会连带丢弃 87ca4440 同文件未提交改动，操作前先确认）。

## 四、截图清单（/tmp/feishu-build-v2-ui/，均为真实浏览器会话）

01 设置-构建编排初始 · 02 宿主未安装+探测明细 · 03 宿主已安装 · 04 构建一启动 · 05 构建一 404 卡死复现（修复前）· 06 构建二启动（加载中）· 07 构建二 v2 进度真实渲染 · 08 构建二终局 legacy 降级（后端缺口）· 09/10 发布文档渲染 · 11 版本记录 · 12/13 构建三全页 · 16 子任务行展开取证（**运行时放开容器 max-height 取证，内容未改动**）。视觉委托核验：03/07/10/11（整体）、12/13（布局）、14/15（滚动尝试）、16（子任务行逐字）。

## 五、未覆盖 / 盲区（如实）

- fixture 模型非真实 LLM 质量；构建 ~5-8s 完成，「执行中/排队/身份待确认」中间态未在真实链路逐帧截到（单测覆盖 + shot-06/07 捕到加载中与终局帧）。
- Electron 真机 preload 通道未验证（本验收走 vite proxy 注入 token，与 dev:all 同链路）。
- 取消/恢复链路未在浏览器复验（未触发）；本轮后端 orchestrationMode 修复后的终局 v2 视图已复验（见 §六）。
- 视觉模型对视口级截断（侧栏内部滚动区半露、事件日志首行削顶）已记录：DOM 完整、滚动可见，与既有 KB 侧栏设计语言一致，非布局破损。

## 六、追加轮：后端 orchestrationMode 修复后的终局 v2 视图复验（同任务范围，Leader 已修 root）

后端修复确认（只读观察）：`kb_builds.orchestration_mode TEXT DEFAULT 'legacy'`（additive 迁移）+ create/patch 持久化 + `toDto` 无 entry 回退 `row.orchestration_mode` + checkpoint 记录 mode。复用 `/tmp/feishu-build-v2-ui/hold-server.ts`（新临时 HOME，fixture 模型）重新走全链：

| 验收 | 证据 | 状态 |
|---|---|---|
| 真实 POST→published 后 GET DTO 保持 pi-amagi | 构建 `b_20261101121557_9a680c` published（r_20261101T121600_44438e）；`GET /api/kb/builds/:id` 与列表 DTO 均带 `orchestrationMode=pi-amagi`（curl 实录） | ✅ |
| 终局不降级 legacy，原生 Leader/任务/termination 真字段渲染 | shot-17/18 + 视觉委托确认：pi-amagi 徽标、汇总三格（1/0/12）、Leader 卡（已结束（publish-accepted）、代次 2、末次用量、恢复能力、skill 哈希）、发布申请已接受；**无「旧式构建」降级说明、无百分比、无布局破损** | ✅ |
| task 最后 execState=running 而 runtime 已停→不伪造 done | DOM `data-exec="stopped"`+「已停止」标签（14 项中 12 项）；本轮小修：stopped 标签 title=「运行时已结束；这是最后观测到的执行状态（未观测到 native 终态，不虚构 done）」（浏览器 eval 实取验证） | ✅ |
| 未知指标不伪造 | 「末次轮次用量：入 10/出 5（累计未知…）」「子任务用量不经 Leader 事件（未知）」维持如实呈现 | ✅ |
| 针对性复测（不重做安装三遍/全广回归） | 安装仅 curl 一次（fresh=true, hash 9485dd95…）；`BuildOrchestrationProgress.test.tsx` **21/21**（含新增 title 断言）、`tsc -p tsconfig.json` EXIT=0、eslint 2 文件 EXIT=0 | ✅ |
| 进程收尾/临时数据 | 浏览器/vite/hold（SIGTERM→closed）全停；端口 5173/54643/54642 无监听；pi/amagi 子进程 0 残留；~/.feishu-sync mtime 不变 | ✅ |

本轮新增前端小修（叠加写面）：`RuntimeTaskRow` stopped 标签补「最后观测」title（§三回滚说明同样适用）。附带真实观察：忘选模式时 legacy 构建走 fixture 不适配的 prompt 会 failed，UI 恢复提示（recovery.canResume=true）如实渲染（顺带验证恢复提示真字段，legacy 路径）。新增截图：shot-17/18（终局 v2 持久视图）。

## 七、追加轮 2：F15 终审修复后的最终真实浏览器增量验证（同任务范围）

F15 前端已由 Leader 修入主树（末次观测并发/历史 epoch 过滤/rounds null→未知/新 DTO runtimeEpoch·task.generation·task.runtimeEpoch·processTermination/termination-unconfirmed）。本轮零前端改动、零后端改动，纯真实验证。复用 hold-server.ts（新临时 HOME，fixture 模型），构建 `b_20261101144714_39f7a0` 真实 published（r_20261101T144718_3807ee）。

**关键真实事件：正常 published 链路收尾对账真实输出 `termination-unconfirmed`**（processTermination：state=unconfirmed，note「存在 4 个未确认项（含 pid 未知项），阻断新 Leader」，unconfirmedPids=[0,0,0,0]——v2-store 活跃意图无锚点覆盖，个体不可发现）。**未做任何故障注入即获得真实 unconfirmed 场景**（反馈原计划的 kill -9 + 破坏 launch-anchor 注入未启用；不假造 DTO）；构建域残留进程实测 0（unconfirmedPids 全 0=不可发现而非已知活 PID）。

| 验收 | 证据 | 状态 |
|---|---|---|
| 1) published 终局：模式 pi-amagi、无伪百分比 | GET DTO `status=published \| orchestrationMode=pi-amagi`；shot-19 视觉确认无百分比、步骰离散节点 | ✅ |
| 终局并发为历史口径 | Metric 标签「末次观测并发=5」+注脚「历史观测，非当前活跃；后台残留以终止核验为准」（视觉逐字）；DTO 当前 epoch 7 任务中 5 running | ✅ |
| 轮次真值 | 「轮次 1/0（启/收）」（DTO rounds.started=1/ended=0 真值；whole-null/field-null→未知由 F15 单测覆盖，真实数据无 null 不假造） | ✅ |
| 历史 epoch/代次不计当前计划 | DTO 全 7 任务 gen=2/epoch=1（当前），「当前计划 7 项」；过滤逻辑（task.runtimeEpoch≠data.runtimeEpoch 或 task.generation≠data.generation）单测覆盖 | ✅ |
| 2) 真实 processTermination.unconfirmed → UI 警示 | 横幅逐字：「后台终止未确认：凭据已撤销，但尚未确认所有进程退出；恢复会先重新对账，未确认前不启动新 Leader」+ note「存在 4 个未确认项（含 pid 未知项），阻断新 Leader」（shot-19 视觉逐字） | ✅ |
| 任务不显示已停止/完成 | 任务行标签「终止未确认」（warn tone，视觉逐字 shot-20）+ DOM `data-exec="termination-unconfirmed"`；error 任务仍真「异常」；无「已停止」「完成」冒充 | ✅ |
| 未知轮次不变 0 | rounds 真值 1/0 原样；恢复能力「需先确认后台终止（重新对账前不承诺可续接）」（DOM 逐字） | ✅ |
| 复测 | `BuildOrchestrationProgress.test.tsx` **25/25**（F15 新增用例含 termination-unconfirmed）、tsc EXIT=0；本轮零代码改动 | ✅ |
| 收尾 | 仅 kill 本任务 PID（vite 54400/hold 54321）；浏览器会话关闭；端口 0 监听；build 子进程 0；~/.feishu-sync mtime 不变；未 pkill 任何通用进程 | ✅ |

**给 Leader 的后端/amagi 侧观察（不修，仅报告）**：正常成功链路（fixture 模型，~4s 完成）在 Leader 收尾 terminate 对账时即报 4 个 v2-store 未确认项——怀疑 amagi 子任务完成后 v2-store current.json 的 execution 状态翻转为非活跃的时机晚于应用侧收尾对账扫描，或任务完成时 process-audits 锚点目录被清理；影响：published 构建检查点持久化 termination=unconfirmed，若该构建后续可 resume 将被先拒绝重试对账。建议后端复核收尾对账与 amagi v2-store 状态更新的时序。

新增截图：shot-19（真实 unconfirmed 终局全视口）、shot-20（子任务行「终止未确认」/「异常」+「已确认」组合）。
