# Agent 标准知识库集成记录

状态：本轮R01/R04残留修复与独立复审PASS，本地开发分支验收通过，按原目标本地提交；未合main、未推送或发版。上一轮 FIX 与现场见本文历史记录和 [上轮增量复审原文](agent-knowledge-review-previous-incremental.md)。本轮证据见 [残留修复验证](agent-knowledge-residual-validation.md)。

## 基线
- 工程治理 main：`2c2a6dd`，v0.3.47，不推送、不发版。
- 功能分支：`feat/agent-knowledge-workbench`；公共契约提交 `104ba2f`。
- F1 后端 worktree：`agent-knowledge-backend`，任务 ca201dd8。
- F2 UI worktree：`agent-knowledge-ui`，任务 a8c7fb5b。
- 兼容边界：Electron31 本机最小程序卡 dyld，原生 headers 重编译成功≠运行成功；详见治理报告。

## pi 真实能力预检（Leader）

所有测试 cwd 为自建临时目录，`--no-session --no-tools --no-extensions --no-skills --no-context-files --no-mcp --no-approve --offline`。显式使用 pi-agent-dir 模式，由 pi 自行加载既有凭据；未直接读取/打印 auth/key 文件，未发送任何用户知识库或私人内容，未修改用户应用配置。输出只包含模型名、结束状态及固定 smoke 回复。

| 项目 | 实际结果 |
|---|---|
| Node / pi | Node24.21.0，pi1.4.0 |
| 只读 RPC `get_available_models` | 返回504可用模型（不等于全部端点均兼容/可调用） |
| `anthropic/claude-haiku-4-5` 实际请求 | prompt被接受后 assistant error，HTTP400，未产生回复；追加状态码分类后同样复现，未打印原始错误或秘密 |
| 注册模型 metadata | `amagi-glm/glm-5.3`、`amagi-glm/glm-5.3-flash`，origin为 open.bigmodel.cn |
| `amagi-glm/glm-5.3-flash` 最小真实调用 | 关闭自动retry、thinking off；agent_settled，stopReason=stop，返回精确 `FEISHU_PI_SMOKE_OK`，exit0，约2s；bg-8ed04bae |

这只证明真实 pi/模型通道可用，**尚不证明新应用的工具往返、会话、Work或标准库构建可用**；后续必须从新应用真实 API/UI 入口验证。F1已收到这条可用模型路由，不能用隔离目录无key作为跳过真实验证的理由。

临时探测脚本：`/tmp/feishu-pi-model-readiness.mjs`、`/tmp/feishu-pi-live-model-smoke.mjs`；原始输出日志由 run_bg 持久保存，不能作为产品运行时依赖。

## 集成与验收范围（实际证据见下文）

- 后端/UI回流后核对并合并（不可把各自fixture UI测试说成真实后端联调）。
- 原始库hash保护、成功/失败/取消/中断恢复与CURRENT发布不变量。
- 真正 pi 工具调用、Discuss/Work权限、会话持久化与流式错误。
- 真实MCP stdio客户端四工具。
- 真实浏览器阅读/来源/构建/会话/模式/设置链路。
- 集成全套检查与高风险独立审核。

## F3 已执行证据（持续更新）

- 后端35个新文件与7个既有文件改动已整合，保留UI现场。`bg-1ebdb56d`：`npm ci --prefix server && npm run check && npm run build:all && npm run electron:build` exit0；server 53文件/704例通过，前端11文件/91例；2个既有hook warning及Vite单chunk超过500KB警告未吞掉。
- `bg-97979d3a`：从主树真实startServer入口，临时FEISHU_SYNC_HOME，pi-agent-dir委托既有认证，GLM真实调用；Discuss raw_read+公式复述、Work ws_write+审计、2源构建发布均PASS，83s。未读取/打印认证文件。该脚本的rawUnchanged只检查标记，不能当完整hash证据；完整hash保护另见下条。
- 独立浏览器（非fixture backend）http://127.0.0.1:5178 → 本应用127.0.0.1:3191，数据根/tmp/feishu-f3-browser.e5Pew8。通过真实POST /api/index/rebuild识别2份临时Markdown源，pending added=2；UI确认全量构建，发布r_20261026T222006_b9d4da，2文档/2来源，pending归零；目录阅读与原始来源抽屉可用。
- 同一浏览器发起第二次全量构建b_20261026222113_469654，确认状态running后点击取消，终态cancelled；Node assert验证CURRENT对象与基线完全一致，2份raw文件逐字节SHA256保持一致。
- 真实MCP SDK Client启动server/dist/mcp/kb-mcp.cjs --kb-root <临时标准库>：四工具search_knowledge/get_knowledge/list_knowledge/get_release_info全通过，返回实际发布内容及releaseId；write_knowledge不存在且调用被拒。无需SQLite或桌面HTTP token。
- UI Discuss真实kb_search/kb_read往返与末尾标记成功。关停并重启本应用server后，历史JSONL仍可读取；下一轮不提供标记值、不调用工具，模型准确复述上一轮F3_BROWSER_REAL，证明恢复了上下文，而非只在列表显示旧历史。
- 联调修复：空会话SSE游标0原先被当过期游标，导致先连接再发消息后UI永远只见用户行（后端已完成）。修正0边界、缓冲快照复制、HTTP resync后推进游标及写流时的漏唤醒；新增空连接/旧游标/1100事件溢出后继续的真实Hono响应流回归。重启server、刷新浏览器后回答及工具结果正常显示。
- 原始源契约补强：旧lastSyncedAt成功版本、cloudDeleted仅观测仍保留；CSV附件同原始库realpath围栏，支持绝对/根相对路径并归一macOS /var与/private/var，拒绝越界/symlink替换与缺失附件（不静默丢源）。agent-session 10例+kb-build 21例共31例通过，server build通过。一次附件绝对路径回归暴露macOS根别名差异，已修正而非弱化断言。

截图：/Users/run.mao/.pi/agent/amagi/artifacts/f3-agent-knowledge-live-shots/（含失败现场，文件名不代替实际图像判断）。

### 后续真实多轮与视觉复核

- Work授权弹窗→登记临时独立目录→确认写权限→真实ws_write完成；实际文件f3-browser-proof.md精确含F3_BROWSER_WORK_OK，审计含ws_write且不含正文。
- message_end原先返回Partial缺id/role/at，后续轮触发startsWith(undefined)崩溃。Leader修完整DTO（live独立id、assistant、at），历史解析仍保留entry id/原at；前端校验必需字段并显示异常，工具中间消息不丢run草稿锚点。前端13例、会话11例与server build通过；真实两源多工具轮完成后再发下一轮得到F3_NEXT_TURN_OK，UI未崩溃。
- 真实停止暴露第二个竞态：后端已idle，但迟到的abort HTTP快照streaming把较新的SSE idle覆盖，UI永久生成中。Leader只await停止请求、不用ACK伪造/覆盖运行状态，失败可见提示；再次真实生成→停止后，页面不再显示停止按钮、恢复发送，后端idle。图11为修正后的稳定态；图09/10保留修正前的状态冲突。
- 视觉委托bg-7e8c8405（8张真实截图）成功。图07实际为DTO崩溃页，不能按其文件名认作Work完成图；图09显示停止通知但仍生成中，正是后来确认的ACK竞态，不能当已稳定idle的证据。其他图的常规阅读/三栏/授权层次可用。关于底部滚动窗口小字切边只标为待坐标/放大核实，不据缩略图断言布局缺陷。原视觉输出/tmp/feishu-f3-visual-review.txt保留。

最新主树前端/文档校验bg-7d9eba52：lint 0 error/2既有warning，三段typecheck、前端11文件/92例、git diff --check、27条本地文档链接及metadata JSON均通过。此结果不代替待硬化后server全量回归。

### 高风险阶段 Gate

06b9041e full审核返回FIX：1 Critical、10 Major。完整报告docs/reports/agent-knowledge-review.md已接受，功能尚未通过。主要问题是完整应用运行树/配置逆向隔离、默认app-llm会话注册、插话排队所有权、进程与能力回收、busy/idle、full及removed工作集、源变化不可绕过、已存在build的对账、指针后清理和JSONL父链。全部一批续接04a0416b在原后端worktree修复。

续接前已回填Leader5个后端修正，验证190个server文件及backend报告与主树逐字节一致；硬化前快照/tmp/feishu-f1-hardening-baseline-4GFLxX。主树前端DTO/abort修正独立保留。临时浏览器及3191/5178服务已主动关闭，数据/截图保留供修后复测。最终统一检查、增量复审及功能分支提交未完成，不提前宣称最终验收。

## 集中修复回流与最终增量验证

- 04a0416b完成R01–R11：18文件净增量回流，经硬化前快照逐项确认主树没有独立冲突再复制；不覆盖前端。新增29例，主树bg-8fbcf795 check/build:all/electron:build通过（server738例、前端92例）。初审原文另存agent-knowledge-review-initial.md。
- Leader进一步补齐R01应用整棵代码树（含前端和构建配置，不能仅列node_modules子树），真实workspace路由对src、server/node_modules/hono、electron均400，现有独立Workspace仍可用；反向raw-root重叠PUT同样400。
- Electron CJS打包暴露ConfigManager新依赖链中的import.meta.url问题：增加dist-electron布局专用资产路径分支与构建define，并新增隔离的真实CJS bundle加载/有Workspace配置更新回归。修后server/前端/Electron构建通过，原import.meta警告消失。该CJS格式回归不是Electron GUI运行验证。
- R08最终复核移到异步staging校验之后、发布点之前；复核当前本地源集合/hash（云端observed变化不误报），主文件再次realpath围栏。新增源加入、主文件symlink越界反例通过；kb-build共30例、CJS1例通过。
- bg-dd819b81：整改后主树真实pi GLM Discuss raw_read、Work写入/审计、标准库发布均再次通过（80s，临时目录）；app-llm由真实pi+本地OpenAI SSE协议fixture证明注册/鉴权传递，不冒充真实远程app-llm Key调用。
- 复用已有真实发布再次UI全量构建，在源未变时仍产出非空、两源覆盖且raw完整SHA不变。此轮又发现新树已发布但阅读区保留旧docId正文；Leader修正换树选择、按release重新读正文、异步迟到响应及版本不一致拒绝、重试实际触发。新增3个选择回归通过。
- bg-06a78e98：不刷新页面的实际发布转换后，DOM正文构建标记与新current buildId完全一致，release=r_20261027T000316_4db544，1篇/2源，raw完整SHA仍不变。截图13为换版后正确阅读态；截图12保留修正前旧正文混版现场，不能按文件名误当完整UI通过。

代码已冻结，接下来仅一次R01–R11及上述接线修正增量复审；全部通过前不接受后端、不提交功能分支。

最终冻结代码统一检查bg-03556463 exit0：前端12文件/95例、server57文件/741例，lint 0 error（2个既有hook warning）、三段typecheck、build:all、electron:build与git diff --check均通过。Electron构建无import.meta警告；Vite仍有529KB单chunk体积提示，未隐藏。最终生成MCP CJS的四工具已再次真实stdio调用通过，指向r_20261027T000316_4db544。此处只表示已执行检查通过，不代表安全阶段通过。

## 上轮交接（历史）：唯一增量复审仍未通过

c478ffaf已接受为审核产物，当前唯一结论为FIX（docs/reports/agent-knowledge-review.md）。R02/R03/R05–R11关闭；以下仍阻断功能验收：

1. **R01 Critical**：Node自动发现调用npm root -g；只保护bin与pi包，未覆盖npm symlink实际加载的包代码树。该树仍可被授权Work写入，随后重新发现会执行改写后的代码。尚未实施攻击载荷；报告给出真实安装布局与精确静态链路。
2. **R04 Major**：agent_settled后、get_state回填结束前，进程仍存活而runs未删除；此窗口steer/followUp会返回accepted旧runId，但消息排进无人消费的旧队列。现有收尾409测试只模拟exited，没有覆盖活进程settling。

04a0416b的‘11项全部关闭’交付已拒绝；有效修复和Leader整合保留，不把拒绝解释为回滚。按一次增量复审上限停止自动迭代并向主上上报；不派下一轮、不提交功能分支、不push/tag/release。治理main仍为2c2a6dd，功能分支HEAD仍为104ba2f（实现与文档待验收改动留在工作区）。

后续如获准继续，最小工作面是：保护/取消实际npm可执行发现链，并用无宿主改写的symlink布局做真实路由回归；在prompt settled同步入口关闭delivery接受窗口，延迟get_state且保持进程活着复现409。修复后仍需相应验证，不可只改报告。

临时浏览器与3191/5178服务已关闭；临时资料/截图保留。Electron dyld、Windows/安装包、真实远端app-llm Key及大库成本边界不变。当前代码快照不可视为可发版安全版本。

## 显式续接：R01/R04 残留修复（2026-10-26，America/Los_Angeles）

用户在新会话明确要求继续交接任务，并授权只读子 Agent 独立验收。旧增量复审失败记录保持。本轮移除 npm 可执行发现路径，补 npm 实际包根保护和动态守卫；以 run phase 与 RPC activeRun 双守卫封住收尾窗口。已有 Leader 补强均保留。

修前反例复现了临时 npm 执行和两种 delivery 错误 accepted；修后增加路由、配置、能力、spawn、活进程延迟 get_state 和微任务窗口回归，详见残留修复验证报告。全量check实际为前端95、后端749例通过；build:all和electron:build通过；最终MCP CJS真实stdio四例通过。真实pi本地fixture及RPC探测已重跑，本轮未改前端，没有冒称重跑历史浏览器与远端GLM。

独立复审在首候选发现运行时A→B后释放旧活进程安装根；该候选未提交，已改为服务生命周期运行根集合，正式回归与独立原样反例均通过。最终复审PASS，R01/R04关闭；最终全量为前端95、后端750例，build:all/electron:build和最终MCP CJS四例均exit0。独立最终5文件53例通过，报告见当前review。按原目标完成本地功能分支提交。Electron dyld、Windows/安装包、RunAsNode、真实远端app-llm Key、大库成本和OS退出时序边界不变。
