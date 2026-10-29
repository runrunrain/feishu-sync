# C4 / P5 知识库共享设置卡交付

> 续接更新：下方新增「真实浏览器 + 隔离后端」记录，原 mock 记录保留为历史证据。真实 Electron 尚待成品补验；原文中“本轮未连接后端”等语句仅描述第一轮。

## 结论

前端实现与本轮 L1/L2、真实 Chromium 的**模拟 API**交互走查完成。新增完整「知识库共享（内网 MCP）」卡，入口为 **设置 → Agent 标准库 → 知识库共享**。没有修改 server，没有提交 Git。

**这不是最终 P5 A6 验收**：本轮未连接 C3 后端、未运行真实 Electron 网关，所有浏览器业务响应来自隔离 fixture。真实 Electron / 后端 / 两台设备接入验证须在集成后 resume；下方列出清单。

## 上游输入与既有规范

- 完整实读：`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`（1234 行，分三段读完；重点 §13.4、§13.8.2、§13.8.3）。
- 完整实读：本 worktree `CLAUDE.md`、`src/views/SettingsView.tsx`、`src/components/CliAccessSettingsCard.tsx`、`src/api/client.ts`（后者分段读完）。
- 实读并沿用：`common/Button.tsx`、`Modal.tsx`、`StatusBadge.tsx`、`Toast.tsx`、现有组件测试与 API 测试模式。已读 agent-browser skill 并加载 CLI `skills get core`、`skills get electron`。
- 视觉沿用现有 `bg-paper` / `bg-card-bg` / `border-line` / `text-ink` / `text-ink-soft` / `seal` / `font-kai`，没有修改全局 token 或通用组件。
- 独立敏感管理面，不挂 SettingsDraft；沿用已有设置两层导航。顶部保存不承诺管理本卡，本卡文字明确「立即生效」。

## Changed files / 树路径

```text
src/
├── App.tsx                                      修改：传递设置主区 active
├── api/
│   ├── client.ts                                修改：专用管理 API；沿用鉴权/动态主端口
│   └── kb-lan-mcp.test.ts                        新增：冻结请求契约测试
├── components/
│   ├── KbLanMcpSettingsCard.tsx                   新增：完整共享管理卡
│   └── KbLanMcpSettingsCard.test.tsx              新增：挂载后的真实 DOM 交互测试
├── types/kb-lan-mcp.ts                           新增：独立 DTO / 默认参数
├── views/SettingsView.tsx                        修改：入口、敏感卡离开即卸载
└── test-fixtures/
    ├── kb-lan-mcp.html                           新增：隔离浏览器验证入口
    └── kb-lan-mcp.browser-fixture.tsx             新增：开发态、全模拟 fetch 的验证页
```

9 个源文件：3 修改、6 新增。fixture 不被生产入口导入，且有 DEV 限制；页面明确标注「全部 API 为模拟」。它渲染真实 SettingsView 和真实卡片，不是静态 UI 复制品。它不启用监听、不访问真实知识库或真实凭据，其它设置卡业务 API 明确返回 503，不能作为那些功能的验收。

预检已有 `?? node_modules` portable 外链；本轮未修改依赖。结束时额外观察到范围外 `amagi.json` 修改，未触碰、未归入交付。报告与截图位于任务机器声明的 **worktree 路径**，没有写到正文中另一项目根同名目录。

## 用户可见变化 / 规格映射

| 设计要求 | 实现与依据 |
|---|---|
| 默认关闭、启用风险确认 | 状态必须来自 API，不乐观写成已开启；确认框说明 HTTP 明文、可信网络、只读发布库边界、停用与泄露处置 |
| 中文状态与会话负载 | 覆盖全部 8 个冻结 state；显示会话/在途/排队/内存；失败状态给对应行动；刷新失败明确标为未知，旧负载标「上次读数」 |
| URL | 逐条使用服务返回 urls，可复制；不自行构造 .local；客户端配置可选服务返回的地址；IP/DHCP 提醒 |
| 令牌 | 默认仅掩码；显示与复制才显式 POST reveal；轮换先确认全部设备断开，不自动 reveal；停用可选 revokeToken |
| 清除敏感状态 | 隐藏、窗口 blur、visibilitychange、停用、掩码改变、状态读取失败时清除；子导航和整个设置主区离开时卸载；迟到 reveal 用版本号拦截 |
| 客户端配置 | pi / Claude Code 的可选可复制 JSON 文件片段与合并说明；仅 `${FEISHU_KB_TOKEN}` 引用，pi 包含 description/timeout；不生成含明文的 --header 命令 |
| 高级配置 | 折叠网卡 auto / 每个服务端网卡 IP / 127.0.0.1 / 0.0.0.0 / ::；所有网卡选择二次确认；端口、会话数整型范围；CIDR 文本、默认段、收窄与公网拒绝说明 |
| 独立保存 | 高级配置只走 settings PUT；轮询不覆盖本地未应用编辑；失败保留编辑；成功刷新 status 和持久化配置 |
| 审计 | 请求 limit=20，界面再次限制最多 20；时间/来源/工具或中文事件/状态；loading、empty、error、重试 |
| 排障 | 同网段/访客隔离、nc 检测、macOS / Windows 防火墙、DHCP、令牌/会话/容量错误、禁止浏览器直连与公网转发 |
| 可用性 | 所有操作 loading/disabled/error/success 有反馈；剪贴板失败不吞错；模态初始焦点、Tab 圈定、Escape、返回焦点；输入有标签；按钮本地补显式焦点环 |

视觉取舍：第一焦点是运行状态与开启/停用动作；地址、令牌、配置依使用步骤排列；高级网卡和排障折叠，避免把初次接入变成网络参数问卷。启用前不铺陈不可用配置。没有引入额外装饰或平行组件体系。

## API 对齐与需要 Leader 协调的两处形态

全部经 `src/api/client.ts` 的既有 desktop headers / getBaseUrl / request；未新建直连出口，也未改共享 Config 类型。

- enable 只发 `{bindAddress?,port?}`，本卡正常开启发 `{}`，使用已保存配置；客户端白名单会丢弃意外传入的 maxSessions 等字段。
- settings 只发 `{bindAddress,port,maxSessions,allowCidrs?}`，明确白名单裁剪，GET config 中额外的 enabled 不能被夹带写回。
- disable 发 `{revokeToken}`；rotate 与 reveal 是 POST；reveal 加 `cache:'no-store'`。
- 状态/审计每 4 秒轮询，document.hidden 时跳过；不轮询 reveal；卸载 abort 只读请求并清定时器。
- mutation 成功后重读 status/audit，不把 POST 回包当长期状态真相；高级保存再读配置。
- **冻结 status 未包含 maxSessions / allowCidrs**：从既有 `GET /api/config` 的可选 kbLanMcp 段读取；段缺省才采用设计默认值，读取失败不伪装成默认成功。通用 `PUT /api/config` 不参与本功能。
- **§13.8.2 未写明 audit 的响应包裹形态、lastError 的精确类型**：本轮独立 DTO 采用审计条目数组与 `lastError: string | null`。这是前端契约解释，不是已经观测到的 C3 后端事实。集成第一步请与 C3 对齐，若其实现用了 envelope 或结构化 lastError，应由 Leader 统一，不能以 mock 通过替代接线。
- allowCidrs 留空会省略该字段，按设计表示默认私网段；需真实后端确认该 PUT 能从自定义段恢复默认，而非保留旧列表。

秘密边界：没有将 reveal 值交给 Toast（Toast 会记日志）、appLogger、console、持久化、URL 或配置 JSON；copy 错误仅给固定文字。API 诊断文字对令牌前缀匹配做掩蔽。截图只在掩码/无令牌状态拍摄；报告不记录明文或模拟明文。

## 验证记录

工作目录统一为 `/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-retrieval-ui`。

### L1 / 静态与构建

| 命令 | 退出 | 结果 |
|---|---:|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 | 前端与测试通过 |
| `npx tsc --noEmit -p tsconfig.node.json` | 0 | 根配置通过 |
| `npm run build` | 0 | Vite 1876 modules 构建成功；保留单块 >500KB 警告，未为局部任务扩大做分包 |
| `npx eslint`（本次 8 个 TS/TSX 变更目标，含 client/App/SettingsView） | 0 | 无错误、无警告 |
| `git diff --check -- src/App.tsx src/views/SettingsView.tsx src/api/client.ts` | 0 | tracked diff 无空白错误 |

未自行执行全量回归，也没有执行 server 构建/typecheck；依任务授权仅验证前端与直接相关行为。

### L2 / 定向测试

`npx vitest run src/components/KbLanMcpSettingsCard.test.tsx src/api/kb-lan-mcp.test.ts src/components/CliAccessSettingsCard.test.tsx src/api/client.test.ts`

退出 0：**4 文件、28 项全通过**（新增卡片 14 + 新增 API 2 + 相邻回归 12）。包含：

- 加载禁用、网络失败与恢复、启用确认/取消与权威状态刷新。
- 显式 reveal / 隐藏 / blur 清除、迟到 reveal 与卸载、轮询不 reveal、外部轮换掩码清除。
- 轮换/停用作废确认、.local 复制、两种 JSON 环境引用、复制错误不泄漏返回内容。
- 高级网卡二次确认、settings PUT 精确字段、轮询不覆盖草稿、配置读取/保存失败保留语义。
- 审计空/错误/20 条约束、全部异常状态中文文案、模态键盘与焦点返回。
- API 方法、路径、enable/settings 字段白名单、显式不可缓存 reveal。

测试是模拟 API 的组件/客户端测试，不是网关集成证据。

### 实际浏览器交互（模拟 API，不是 Electron）

运行 `npm run dev -- --host 127.0.0.1 --port 5187 --strictPort`；独立 agent-browser session `kb-lan-ui-845709126bdf` 打开 `http://127.0.0.1:5187/src/test-fixtures/kb-lan-mcp.html`。结束已关闭该浏览器 session，并停止本任务的 npm/Vite 两个进程。

实际完成路径：

1. 真实 SettingsView 导航进入共享 → 确认明文风险 → 开启 → 显示运行状态与 3 会话/排队 2（均为 fixture 合成读数）。
2. URL 与 pi 配置复制有成功反馈；Claude 选择 .local 后复制；在写剪贴板时只保留布尔检查结果：`validJson/envReference/localUrl/noPlaintext` 全 true。系统剪贴板 readText 曾被权限拒绝，因此未声称读取回验；写入反馈与测试内精确值断言分开记录。
3. 显示令牌不拍照、不 snapshot 内容；仅检查 DOM 节点存在；切换子导航后 `secretRemoved/cardUnmounted` 全 true。另验证「离开设置主区」同样卸载。
4. 轮换确认 → 成功 → 没有自动出现明文；全部网卡选择确认/取消 → 单 IP/端口/最大会话/CIDR 提交 → 刷新。
5. 模拟复制拒绝 → 明确失败文字；模拟 status 503 → 状态未知、相关动作禁用；取消失败模拟后恢复。
6. 逐个等待并核验 starting / port_in_use / bind_unavailable / no_private_interface / artifact_missing / failed 的中文状态。
7. 停用并作废 → 已停用、连接区移除，审计可见。
8. 在 **1280×960** 和 **375×812** 查看；375px 的 `documentElement.scrollWidth === innerWidth === 375`，未发生页面级横溢。配置自然换行，高级表单双列退为单列；审计表允许自身水平滚动。
9. `agent-browser … a11y --selector 'section[aria-label="知识库共享（内网 MCP）"]' --tags wcag2a,wcag2aa`：axe 4.12.1，**0 violations、0 incomplete、17 passes**。初查的 code/pre 命名语义问题已修复后重跑。不是屏幕阅读器人工验收。

### 截图与实读视觉检查

截图目录：`agent-outputs/workflow/20261029-kb-retrieval-mcp/screenshots/`。以下均已用 read 实际打开查看，不是只保存未看：

| 图 | 用途 / 检查 |
|---|---|
| `ui-disabled.png` / `ui-final-disabled.png` | 初始关闭与最终停用；状态/动作层级清晰，停用后不留连接/令牌区域 |
| `ui-enable-confirm.png` | 明文风险第一视觉重点，范围与停用文字完整 |
| `ui-all-interfaces-confirm.png` | 全网卡暴露风险及「仍需应用」明确 |
| `ui-advanced.png` | 网卡/端口/会话/CIDR 可编辑，保存后按钮恢复 disabled |
| `ui-status-error.png` | 失败反馈与禁用动作明确，不伪装在线 |
| `ui-narrow.png` / `ui-narrow-advanced.png` / `ui-narrow-port-error.png` | 375px 正常/长状态/高级参数不出页面边界 |
| `ui-final-running.png` / `ui-final-config.png` | 最终版：标签不碎行、令牌保持掩码、.local 配置与环境引用可读、中文审计 |

另有早轮 `ui-running.png` / `ui-running-tall.png`，也已实读；早轮走查发现客户端字段标签碎行，后以不收缩标签修复，最终版见 `ui-final-*`。静态截图不能代替上述实际操作链。

## 待真实后端 / Electron 验证清单（未完成，不计 PASS）

- [ ] 集成 C3：核对 audit array/envelope、lastError 类型、GET config 默认段，以及空 CIDR 恢复默认的含义。
- [ ] 真实 Electron 动态主端口：desktop token 获取、专用管理 API、GET config、status/audit 轮询全部可达；主监听保持回环。
- [ ] 真实默认关闭 → 启用确认 → 网关 starting/running → 停用（保留令牌/作废令牌各一次），确认监听与状态实际收敛。
- [ ] 真实令牌显示/复制/隐藏/轮换，核对查看审计、轮换断开、旧令牌/旧会话失效；仍禁止截图/日志保存明文。
- [ ] Electron 剪贴板：IP/.local/令牌/pi/Claude 配置复制成功；OS 权限失败提示；原生窗口 blur、切主区/子项均清明文。
- [ ] 网卡真实列表、DHCP/VPN 变化、全网卡二次确认；端口冲突、无私网、产物缺失等后端真实失败语义。
- [ ] settings 保存的重启时序、maxSessions/CIDR 实际作用、应用重启后的配置/令牌持久性。
- [ ] 真实 20 条审计顺序、字段与轮转边界；真实多客户端会话/排队读数。
- [ ] 第二台设备 pi/Claude Code 使用复制 JSON + 环境变量真实挂载；401/404/503 提示；.local 的系统解析与防火墙行为。
- [ ] 完整产品窗口（而非 fixture 页）、目标 Electron 版本与 macOS/Windows 原生确认环境，以及桌面缩放/高 DPI/屏幕阅读器。

## 盲区、风险与回滚

- 当前无真实后端或 Electron A6 证据；浏览器 mock 无法证明监听、安全矩阵、令牌域、实际会话、系统防火墙和客户端兼容性。
- 只测上述两个视口；极长服务错误、成千 CIDR、200% 桌面缩放、Windows 字体与真机键盘/读屏器未测。没有为局部卡改全局样式或依赖。
- P5 明文 HTTP 本身的同网嗅探风险按设计保留，UI 只能明确告知并建议覆盖网络，不能宣称传输加密。
- 无 commit。回滚仅需按本次 diff 移除 App active 传递、SettingsView 新入口/敏感卸载分支和 client 新 API，再移除本任务新建的 6 个源文件；不改 `amagi.json` 或 portable 外链，不使用全树 reset/restore。运行层撤销以真实后端的「停用共享」为准，本轮没有启用任何真实监听。

## 续接：主应用浏览器 + 隔离真实后端（2026-10-29）

### 输入与边界

- 实读 `/Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/20261029-kb-retrieval-mcp/gateway-report.md` 与本报告。该上游报告正文仍是早期 blocked 快照；Leader 随后明确告知 C3 集成/build 通过，`server/tests/kb-lan-integration.test.ts` 两项真实管理 API→子进程→七工具/轮换/双会话测试通过；全量前端 423、server 1977（8 skip）及正式看门狗恢复通过。**这些是 Leader 转述，不是本轮重跑结果**。
- 使用 Leader 提供的主树 Vite `http://127.0.0.1:5173`、代理的真实 Node API `127.0.0.1:62492`、隔离数据根 `/tmp/feishu-kb-live.MH6HuA/data`、合成 `r_browser` 库。全程无 fixture；真实进程及子进程是 Leader 已启动的隔离环境，不读不改真实用户状态。
- 独立 session `kb-lan-real-ui-845709126bdf`，未使用 Leader 的 session。初始从高级设置确认绑定 `127.0.0.1`、端口 `62493`；全程只绑定回环。选择 `0.0.0.0` 仅查看二次确认并取消，未保存/启用。没有重建、打包、重编译依赖或停止 Leader 服务；结束只关闭自己的 browser session。
- 没有在明文显示期间执行 snapshot、截图或输出 DOM 文本；DOM 只输出存在性布尔值。测试结束后令牌剪贴板用回环 URL 覆盖；报告不写令牌或掩码。

### 真实链结果

| 验收 | 实际证据 | 状态 |
|---|---|---|
| 正式 UI 与启用 | 主应用「伍 设置 → Agent 标准库 → 知识库共享」；高级保存 maxSessions=8 后 `GET /api/config` 实读 enabled=false、bind=127.0.0.1、port=62493、maxSessions=8。开启风险确认后服务 status 收敛 enabled=true/state=running/resolvedHost=127.0.0.1/port=62493 | PASS |
| URL 与客户端配置复制 | 服务真实返回回环 URL 和系统 `.local` URL；点击地址、pi、Claude 复制，浏览器反馈成功。复制 wrapper 只检查布尔：pi/Claude JSON 有效、含环境引用、所选 `.local` 出现、无令牌明文。实际 `.local` 在回环监听下可能不可达，见下方新增 UI 修复 | PASS（剪贴板写入反馈与内容拦截检查；非第二台设备连接） |
| reveal / hide / blur | 用户点击显示，DOM 只检 `visible=true`；隐藏后 `hidden=true/masked=true`。再次显示后新开浏览器标签，再回原标签 `hidden=true/masked=true`，同时实测真实标签切换引发的可见性清除；另有合成 blur 事件测试 | PASS（非 Electron 原生失焦） |
| 复制令牌 | 点击后 UI 显示已复制；随即点击复制回环 URL 覆盖剪贴板。未读取/输出令牌 | PASS（操作反馈；未从系统剪贴板回读） |
| 轮换与审计 | 确认轮换后 UI 报成功、status 再次 running；未自动 reveal。真实 audit 数组含 `enabled`、`token_revealed`、`token_rotated`、`disabled`，最终读取共 9 条；无请求正文或明文写入报告 | PASS（旧令牌/旧会话实际拒绝由 Leader 上游集成测试覆盖，本轮不复验） |
| settings / 端口冲突 | 启用期间设置回环端口为已占用的隔离 API 端口 62492，真实 status=`port_in_use`，UI 显示「端口 62492 已被占用，请换一个端口」；不停止占用进程。再改回 62493，真实 status=running。均为 127.0.0.1 | PASS |
| CIDR | 实际设置 `127.0.0.0/8` 后 GET config 回读此列表。随后多次清空提交期间主树 Vite 页面反复重载，等待成功提示超时，最终 GET config 仍为该列表；没有足够证据判断请求是否到达或后端重置失败 | 自定义保存 PASS；恢复默认 **未验证**，Leader 已确认设计契约但仍需真实 UI 补测 |
| 停用保留 / 作废 | 先 UI 停用（默认保留）后 status disabled 且掩码与停用前相等；重新启用同一掩码。后 UI 勾选「停用并作废令牌」并确认，最终 status disabled、enabled=false、tokenMasked=null、bind=127.0.0.1/port=62493；`lsof -nP -iTCP:62493 -sTCP:LISTEN` 无输出、退出 1 | PASS；隔离令牌已作废、监听已停止 |
| 失败 / loading | 实际端口冲突为真实失败，服务返回 `lastError: port_in_use`，UI 出中文状态。启用过程最终收敛 running；未稳定捕获真实 starting/loading 中间态或真实 status 503 | 失败 PASS；loading/503 本轮未覆盖，原 mock 测试证据保留 |

Vite 页面多次回到总览，导致 locator 失效/等待超时；有界重新导航后完成重点启停、轮换、审计、端口故障和最终作废。未擅自对 Leader 的服务做停止或重启，也未把等待超时说成网络故障。

### 本轮发现并修复的前端接线问题（待 Leader 集成）

真实 C3 status 在 `port_in_use` 时仍返回带端口的 `urls[]`，旧 UI 把这些地址当可复制连接地址；而网关绑定 `127.0.0.1` 时服务也返回系统 `.local` URL，旧 UI 一律推荐并允许选 `.local`，但它通常解析到非回环网卡，网关仅在回环监听，不能承诺该地址可达。这两个现象在真实状态和截图上观察到；**是否在特定主机上解析到回环未实测**。

增量仅在本任务 worktree：
- `src/components/KbLanMcpSettingsCard.tsx`：非 running 时说明地址仅供排障并禁用地址复制；resolvedHost/bindAddress 为回环时说明只可本机连接，禁用 `.local` 地址复制与配置选择、默认选回环 URL；非回环场景继续使用服务返回的 `.local`。
- `src/components/KbLanMcpSettingsCard.test.tsx`：新增一项真实接线回归的模拟组件测试，检查回环 `.local` 不可选/不可复制、端口冲突时地址和配置不可复制；原非回环 `.local` 复制测试仍通过。

此修复**没有直接改主树**；上面的真实浏览器截图针对集成前 UI，不能冒充增量修复的真实视觉验证。请 Leader 合并这两个文件的**本轮增量**后在真实产品/Electron 回归。回滚增量只需局部撤掉这两文件中新增回环/非 running 条件及新增测试，不动此前已集成部分。

### 续接验证与视觉证据

cwd：本 worktree。`npx vitest run src/components/KbLanMcpSettingsCard.test.tsx src/api/kb-lan-mcp.test.ts` 退出 0：**2 文件 17 项通过**（组件 15、API 2）；`npx tsc --noEmit -p tsconfig.json`、`npx eslint src/components/KbLanMcpSettingsCard.tsx src/components/KbLanMcpSettingsCard.test.tsx`、`git diff --check -- ...` 均退出 0。未自行全量回归，未 rebuild。

本轮截图均未展示明文令牌，实际用 read 打开检查：
- `screenshots/live-enable-confirm.png`：真实设置页的安全确认，风险、只读边界和停用路径可辨；背景为真实高级设置。
- `screenshots/live-running.png`：真实运行状态、回环 IP 与 `.local` 均呈现；暴露了回环时 `.local` 推荐不准确的问题，已在 worktree 修复。
- `screenshots/live-port-in-use.png`：真实端口冲突中文状态可见，但同屏仍把故障端口作为可复制地址，已在 worktree 修复。

### 剩余待测

- 此次是**真实 Chromium 主应用 + 实际 Node 后端/网关子进程**，不是 Electron 产品 runtime；无需 mock 冒充。Leader 提供打包成品后，继续测 Electron 动态端口/原生剪贴板/blur/缩放与新修复视觉、回环和实际私网网卡路径。
- 清空 CIDR 恢复默认的 UI→真实 API 闭环、真实状态 503/loading、两个设备的真实 pi/Claude 挂载、外网卡/防火墙和 `.local` 解析未完成。
- 新增回环修复的视觉与真实后端交互还未验证；仅定向组件测试/typecheck/lint 通过。主树服务提供的旧 UI 在本轮观测期间未直接修改。
- 本轮代码增量无提交；`amagi.json`、依赖外链与其他会话修改未触碰。
