# F2 标准知识库与 Agent 会话 UI — 实现与验证报告

> 切片：F2（UI 完整切片，主特色审美实现 + 轻工程闭环）。基线 104ba2f（main 治理 2c2a6dd）。
> 契约：`docs/design/agent-knowledge-design.md` §9（API）+ §11（UI）+ §12.2（验收）。
> F1 后端并行开发中：本切片按公共契约实现 UI，新端点以 **fixture backend 驱动验证**，
> 真实 F1 接口联调由 Leader 在 F3 集成阶段完成（见 §5 边界声明）。

## 1. 需求 → 实现 → 测试 映射

| 需求（任务书接线项） | 实现 | 验证 |
|---|---|---|
| MainArea+TopBar 增「标准库」「对话」并实际挂载 | `TopBar.tsx`（壹总览/贰同步/叁标准库/肆对话/伍设置）；`App.tsx` 常驻挂载两视图（`active` 门控轮询与订阅） | 浏览器点击导航往返，运行中构建/会话状态保留（截图 07→08） |
| KnowledgeView 树/搜索/阅读/来源/原始 drawer | `views/KnowledgeView.tsx` + `components/kb/{KbTreePanel,KbSourcePanel,RawSourceDrawer,KbBuildPanel}.tsx`；阅读复用 `MarkdownView` | 树选中文档、搜索「经济」1 条结果、来源点击开 drawer（截图 02/03/04/05） |
| 构建状态/增量/全量确认/取消/实时进度/失败 issues/旧发布未变提示 | 状态条（发布版本/时间/文档数/pending 徽标/就绪徽标）+ 确认弹窗（全量二次确认文案）+ 底部构建面板（阶段 stepper、批次 x/y、build_log/tool/assistant_delta 日志流、取消、失败 issues +「当前发布版本未受影响」） | 全流程真实操作（截图 06/07/08/09）；发布后状态条刷新为新 releaseId |
| AgentView 会话增删改/历史/消息流/工具日志/输入/steer/停止/重连 resync | `views/AgentView.tsx` + `components/agent/{SessionListPanel,MessageStream,AgentComposer,AgentModePanel}.tsx` + `hooks/useAgentSessions.ts` | 新建/重命名（战斗规则讨论）/删除；流式输出（截图 12/13）；steer 实证 `busy=true, delivery=steer`；停止→`aborted` 错误行（截图 18）；断线 4 次自动重连且内容零丢失（截图 19） |
| Discuss/Work 显式确认 + Workspace + 常驻风险提示 + 无 shell 承诺 + 不称沙箱 | Work 切换 Modal（Workspace 单选 + 内联新增 + 风险文案 + `confirm:'WORK'`）；Work 顶部常驻 amber 风险条（截图 15）；文案均为「可在该目录内创建、修改文件；不能执行命令」，全文无「沙箱」表述 | 切换流程 + 写入记录（`/ws/战斗要点.md (ws_write)`）实证（截图 16） |
| 设置 Agent 段：runtime/model source/路径覆盖/标准库目录/Workspace 增删/MCP 复制 | `components/agent/AgentSettingsCard.tsx`（两个子卡）挂入 SettingsView 新「Agent 标准库」页签 | 截图 20/21；Workspace 新增 + 非法路径（`/Users/...`）后端 400 → toast 展示；MCP 片段复制按钮（headless 剪贴板读权限受限，写入调用成功、按钮态翻转，内容读取未验证——盲区） |
| preload bridge + 主进程 dialog + window.d.ts 四端同步 | `electron/main.ts`（`desktop:select-directory`，`dialog.showOpenDialog`，返回 `string\|null`）、`electron/preload.ts`、`electron/desktop-contracts.ts`、`src/types/index.ts` `DesktopAPI.selectDirectory` | `tsc -p tsconfig.node.json` + `npm run electron:build` 通过；浏览器降级为手填路径（无 `window.desktop` 时提示） |
| SSE 带认证 fetch 读取器（不能 EventSource） | `utils/sseStream.ts`：`SseParser`（WHATWG 规范：CRLF/CR、多行 data、注释、id 游标）+ `SseConnection`（fetch+ReadableStream、退避重连 1s→8s、`Last-Event-ID` 续传、`resync` 回调） | 单测 9 例 + 浏览器断线重连实测 |
| 加载/空/未发布/未配置模型/不可达/错误/运行中/断线/重连全覆盖 | 各视图分级空态（骨架/EmptyCard/未就绪卡）；Agent 未就绪 → 输入禁用 + 原因 + 重新检测/前往设置（截图 10/11）；kb 不可达 → 重试卡 | 逐状态浏览器实操，见 §3 证据表 |
| 无假成功/无 demo 静态内容 | 所有数据来自 API（真实 server 或标注 fixture）；无硬编码内容；错误码如实展示 | 代码走查 + fixture 503/409 路径实测 |

## 2. 安全与状态约束（任务书 + Leader steer）

| 约束 | 落实 |
|---|---|
| renderer 不持有/显示 run token 或 apiKey | UI 仅消费 DTO；设置卡不显示任何密钥（provider key 归「模型与整理」卡）；无 token 出现在任何界面/日志 |
| 源 Markdown 不执行 HTML/脚本 | 全部经 `MarkdownView` 受控渲染（无 dangerouslySetInnerHTML；HTML 表格走白名单解析） |
| **steer#1 链接协议白名单** | 新增 `sanitizeHref`：实体解码 + 空白命名实体（`&Tab;` 等）+ 控制字符剥离 → scheme 白名单（http/https/mailto；相对路径/锚点放行；`//` 协议相对拒绝）；拒绝降级为不可点击文本。Markdown 与 HTML `<a>` 两分支同批修复。HTML 分支旧的「仅拦 `^javascript:` 字面量」已移除 |
| **steer#1 AuthImage 凭据边界核查** | 核查结论：远程 URL 直接交 `<img src>`（不 fetch、不带 headers）；仅本地相对路径走 `getMediaBlobUrl`（唯一 API 出口 + token 只发本机 server）。已在代码注释固化该不变量 |
| **steer#2 不可信内容不自动加载外部图片** | `MarkdownView` 新增 `remoteImages?: 'auto'\|'confirm'`（默认 auto 保旧行为）；`confirm` 下远程图片渲染占位卡「外部图片（域名）不会自动加载 · 点击加载」，点击后显式授权加载。标准库文档、RawSourceDrawer、既有 DocPreviewPanel（同类原始内容）三处均已传 `confirm` |
| 请求竞态/切会话不串流 | SSE 订阅按 sessionId 闭包 + `activeIdRef` 比对，迟到事件丢弃；切换先 `stop()` 旧连接；文档加载带请求序号。实测：会话 A 运行中切 B（B 空）再切回 A（A 自己的历史） |
| 隐藏页面无全局键盘误触 | 两视图均不注册 window 级键盘监听（Drawer 的 Esc 仅在自身 open 时挂载）；`active=false` 停轮询/订阅 |
| 有配置模型但远端失败准确反馈 | run_end failed → 错误行（code+message）+ toast；发送失败 → 乐观行撤回 + streamErrors 行；不编造助手回复 |

## 3. 真实浏览器验证证据（§12.2）

环境：本机 Chrome（agent-browser，1440×900 为主），vite:5173 → **fixture backend:3102** → 真实 server:3101（`FEISHU_SYNC_HOME=/tmp/f2-fixture/home` 临时目录）。
截图存档：`/Users/run.mao/.pi/agent/amagi/artifacts/f2-agent-knowledge-ui-shots/`（24 张；正文中编号对应文件名）。

| §12.2 验收项 | 操作证据 | 截图 |
|---|---|---|
| 标准库空状态（未就绪分支） | fixture readiness=model_unconfigured → 徽标「Agent 未就绪」+ 构建按钮禁用（title 含原因/动作） | 10 |
| 未就绪会话输入禁用 | 同上进对话页：textarea disabled + 原因 + [重新检测][前往设置]；recheck 后恢复 | 11 |
| 已发布阅读 | 树自动选首篇《战斗结算规则》；表格/引用/公式渲染；来源 2 条（当前/已变更徽标） | 02 |
| 搜索 | 输入「经济」300ms 防抖 → 1 条结果（路径+摘要），点击打开 | 03 |
| 来源跳转 | 缺失源 → drawer「该文档本地无 Markdown 内容」；sheet 源 → 自动切 CSV 子表页签 | 04/05 |
| 构建进度 | 增量构建确认 → 面板：排队→预检→生成(批次1/2)→…→已发布；状态条刷新为 `r_..._fix002` | 06/07/08 |
| 构建失败 | fixture fail 模式全量构建 → `kb_validation_failed` + 2 条 issues +「当前发布版本未受影响」 | 09 |
| 会话新建/流式 | 新建 → 发送 → text_delta 流式 + 工具行 + 最终消息（model 标签） | 12/13 |
| Work 确认流程 | 切换 Modal → 内联新增 Workspace → 单选 → 确认 → 常驻风险条 + 权限面板写入记录 | 14/15/16 |
| 运行中 composer | 生成中：发送变为 插话/排队 + 停止；steer 实证（fixture 日志 `delivery=steer`） | 17 |
| 停止 | 点击停止 → `aborted` 错误行「本次生成已被停止」 | 18 |
| 断线重连 | fixture flaky（3 事件断流）：头部「连接中断，正在重连」胶囊；4 次重连期间 Last-Event-ID 续传，最终回复完整零丢失 | 19 |
| 安全拦截（steer 回归） | 文档内 5 种恶意链接（javascript:/data:/vbscript:/`&#106;avascript:`/`java&Tab;script:`）全部降级为不可点击文本；远程图片占位不自动加载，点击授权后才请求 | 23 |
| 窄视口 | 1000×680：三栏 minmax(0,1fr) 无物理裁切（内部滚动 scrollH 791/clientH 381），状态条换行不重叠 | 24-v2 |
| 设置页 | 运行时就绪卡（真实 config 的 provider 下拉「智谱 GLM」）+ 标准库/Workspace/MCP 卡 | 20/21/22 |

视觉走查：当前模型无视觉能力，全部截图经 amagi-media-understanding（GLM 视觉模型）三批委托审阅；发现的 4 项问题（重连指示对比度、工具行缺终态图标、`1fr` 溢出裁切、文案措辞）均已修复并复验（截图 24-v2 + 工具行 hasCheck 实测）。

## 4. 测试与静态检查

- `npx eslint .`：0 error（2 warning 为 docs/testing.md 记录的既有遗留：NodeTreeView roots / useSyncStatus）。
- `npx tsc --noEmit -p tsconfig.json` + `-p tsconfig.node.json`：通过。
- `npx vitest run`（根）：**10 文件 86 用例全绿**（新增 33：SseParser 9、readiness/合并/写入记录 12、sanitizeHref+链接拦截+图片策略 12）。
- `npm run electron:build`：通过（selectDirectory IPC 四端同步编译验证）。
- 未跑 server 测试（本切片未改 server/**）；未 commit/push/发版。

## 5. fixture / 真实边界（重要）

- **fixture backend**：`/tmp/f2-fixture/server.mjs`（非仓库产物）。`/api/agent/*`、`/api/kb/*`、`/api/mapping/content/fixture_*` 为契约模拟（含 SSE、409/503/400 错误路径、flaky 断流、就绪码切换）；**不声称真实 F1 接口已验证**。
- **真实集成面**：config（含 provider 列表）、auth-status、health、同步状态、404 代理路径等经真实 server（临时 home）验证。
- 已知 fixture 修正记录（不影响 UI 结论）：① 终态构建未释放并发位；② SSE buffer 懒初始化导致空 buffer 订阅收不到事件（UI 侧 SseConnection 类经直连单测证明无此问题）；③ `res.destroy()` 不被 vite 代理传播，改 `res.end()`。

## 6. 未覆盖与盲区

1. **真实 F1 API 联调**：全部新端点为 fixture 驱动；字段名/错误码以契约为准，F1 实现若有出入需在 F3 调整（风险低：类型层共享契约）。
2. **Electron 真机**：本机 Electron 31 最小启动卡 dyld（任务书已知），selectDirectory 的原生对话框未在 Electron 内实测（IPC 链路编译验证 + 浏览器降级路径实测）。
3. **MCP 复制内容**：headless 剪贴板读取被拒，仅验证按钮态与写入调用，未验证粘贴内容。
4. **超长内容/极端输入**：>1MB 文档、20000 字符消息上限、极深目录树未做专门测试（渲染器既有分页/截断约定未变）。
5. agent-browser a11y 文本偶发多字节损坏（重启浏览器会话恢复）——工具摩擦，不影响产物。

## 7. 回滚方式

全部为前端/渲染层新增与局部修改；回滚只逆向本切片具体差异并移除本切片新增文件，不可 checkout 整个 src/electron 目录覆盖并行现场。无数据迁移、无 server/构建脚本改动、无依赖变更。

## 8. 变更清单

修改：`src/App.tsx`、`src/components/TopBar.tsx`、`src/api/client.ts`（新增 agent/kb API + `getSseAuth`，既有函数未动）、`src/types/index.ts`（Config 增 agent/standardKb 可选段 + DesktopAPI.selectDirectory）、`src/views/SettingsView.tsx`（新页签）、`src/components/DocPreviewPanel.tsx`（remoteImages=confirm）、`src/components/preview/MarkdownView.tsx` + `.test.tsx`（安全修复）、`electron/{main,preload,desktop-contracts}.ts`（目录选择 IPC）。
新增：`src/types/agent.ts`、`src/utils/{sseStream,agentReadiness}.ts` + 两个 `.test`、`src/hooks/{useAgentStatus,useAgentSessions}.ts`、`src/views/{KnowledgeView,AgentView}.tsx`、`src/components/kb/*`（4）、`src/components/agent/*`（5）、本报告。

## 9. Leader 整合补充

- 主工作区整合 F2 后，`npm run check && npm run electron:build` exit0（bg-f6a6c4de），保留原fixture/真实边界，未提前接受为最终联调成功。
- 外部图片授权改为绑定具体 URL：组件复用/切文档/查询串变化必须重新确认，不能复用先前布尔授权。新增 `remoteImageConsent.test.ts` 4项决策回归。
- 链接净化仅去掉控制字符/首尾空白，保留 CSV 等本地文件名内部空格；协议探测仍拦 `java script:`，拒绝反斜杠混合协议相对URL。新增文件名兼容回归，避免安全修复误改链接目标。
- 这些是Leader整合后的差异，原UI worktree保留原交付；最终真实F1联调与风险审核仍在F3完成。
