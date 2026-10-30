# 阶段 C 独立 full 安全 / 生命周期首审

## 结论

**VERDICT: PASS**

本结论仅签发本轮 P5 实现及指定兼容增量的**代码审核门**：未发现能够按本轮证据标准成立的 Critical / Major / Minor finding，故无 C1…条目。不是发布批准，也不把尚未完成的 Electron GUI、独立 staging 打包及异机验收算作通过。

## 基线、输入与边界

- 审核主树：`/Users/run.mao/workpace/feishu-sync`；`git rev-parse HEAD` 实读为 `060c02f504682c4e44e9da946ed9d27a618957a2`。审查对象为该基线之后的工作区 tracked diff **以及指定范围内 untracked 实现、测试、文档**；不是仅看 `git diff` 的统计。
- 完整必读输入：`CLAUDE.md`；`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`；同目录 `stage-c-evidence.md`、`gateway-report.md`、`ui-report.md`、`client-compatibility-report.md`、`regression-fixes.md`。
- 已纳入 Leader steer：当前主树卡片的非 running 地址禁复制 / 排障提示，以及回环绑定不推荐、不可选 `.local` 的两处增量及新增组件用例。
- 覆盖：`server/src/kb-lan/` 全六文件、`mcp/kb-mcp-gateway.ts`、`routes/kb-lan-mcp.ts`；index 生命周期/DI；types/config-manager/routes-config/ops-command-table 的 kbLan 段；bundle 两脚本、bench、八个 kb-lan 测试文件；前端 App/SettingsView/client、新卡片/DTO/API测试/组件测试/DEV fixture；两份使用文档；`kb-mcp-tools.ts` 兼容增量与 MCP 测试；内置 grep literal-only 增量及测试。
- B 已审未改检索引擎不重复首审；仅回源核实 XOR、预算、游标与兼容补强的调用关系。两个旧测试改动经 diff 确认只涉及 macOS 路径断言、显式 Pi 后端及诊断，未改生产 path guard。范围外 `amagi.json`、其他任务报告不归入本轮变更。

## 对抗覆盖清单

以下为静态路径审核结论；运行证据的来源和可信度见下一节。

| 重要承诺 / 反例方向 | 核实结果与主要定位 |
|---|---|
| 默认打开、误将主 API 暴露到 LAN | `network.ts` 缺省 enabled=false、非法磁盘配置 fail-closed；`index.ts:690,855` 保留默认/standalone 回环；新增监听只在独立 child。未改 Electron 主监听策略。 |
| 伪造 Host/XFF、公网 CIDR、IPv4-mapped/IPv6 前缀逃逸 | `http-gateway.ts` 使用 socket 地址，忽略 XFF；`network.ts` BigInt 前缀比较、mapped /96 转换、子集校验；空列表可拒全部，不会扩回默认。绑定具体地址另经当前网卡核验。 |
| 浏览器跨域、猜令牌、超大/分块正文 | 入口按源地址→Origin→失败限速→Bearer→会话执行；Origin 存在即拒绝；10 次失败后封禁5分钟；声明长度与流式累计均为64KiB；HTTP timeout 显式设置。不是仅依赖 SDK 默认限制。 |
| Bearer 时序/长度信息、令牌域混用 | `token-store.ts` 对格式失配也计算摘要，逐一对32B摘要 timingSafeEqual，不早退；foreign desktop/CLI 头出现也拒绝。主域反向拒绝由既有 auth/CLI 守卫及真实集成断言支撑。 |
| CLI/app_command 绕开桌面开启、轮换、读取秘密 | `routes/kb-lan-mcp.ts` 七路由自带 desktop 摘要校验并拒 CLI actor/头，主挂载在 auth 后；通用 config PUT 对所有主体剔除整个段；共享 command-table 禁整段及任意子键，没有新增 LAN ops 命令。 |
| secrets 权限、链接、部分写入 | `token-store.ts` canonical data root，secrets/目标 lstat、O_NOFOLLOW、nlink 检查；0700/0600，独占随机临时文件、fsync、同目录 rename、失败清理；明文不进 config/argv，child 只接摘要及最小环境。没有把这些文件检查称为同 uid OS 沙箱。 |
| 轮换/停用返回后旧 child 或 session 仍可使用 | manager exclusive 串行管理；rotate 先等待旧 child close，再持久新秘密并启动；disable 先停 child 再可选 revoke；TERM 超时 KILL；session 身份随进程销毁，不做旧令牌宽限。 |
| 多会话串 notice、重复索引、无限会话/队列 | child 只有一个 QueryService/cache，各 session 独立 registration state；会话 UUID + 每请求 Bearer + socket IP 绑定；TTL/空闲淘汰/初始化预留；队列4/2/32、10秒超时，跳过饱和会话而不阻塞其他客户端；regex 全局串行。 |
| regex 卡死拖住 Electron、看门狗睡眠误杀、崩溃风暴、网卡消失 | regex 在 LAN child 执行并先发 metadata；父单调时钟、>5秒父漂移重置 deadline；指数退避/10分钟5次熔断、固定端口冲突不换端口；网卡周期核实与恢复；内置 kb_grep 在进入 query 前拒非 literal，不仅收窄 schema。 |
| 正常退出遗留监听/定时器/自动重启 | `index.ts:744–751` 启动与 close 接线；standalone 信号走 started.close，Electron 沿既有退出协调器；manager close 先标 closed、取消 timer/retry、回收 child。不外推为宿主被强杀后的 OS 级保证。 |
| child 写盘/SQLite/出站、父审计泄漏 query/token | gateway 只组装只读 QueryService/共用七工具与入站 HTTP；无自建数据库或主 API 转发。父 `audit.ts` 重建字段白名单、限制工具/event/session长度、认证失败按IP分钟聚合、5MiB单份轮转；child stderr只排空不落盘，fatal 使用固定诊断。 |
| UI 自动 reveal、迟到结果重新暴露、状态乐观造假 | 卡片 reveal 仅显式动作；secret generation 在 blur/visibility/unmount/停用/掩码变化/状态失败时失效；明文不进 Toast/logger/URL/配置；mutation 后重取 status/audit；设置子区/主区离开卸载；高级设置不走通用 PUT。 |
| 复制明文到配置、故障地址仍宣称可连接 | 配置只含 `${FEISHU_KB_TOKEN}`；最新增量禁非 running 地址/配置复制，回环禁 `.local` 配置选项和复制；未把该小修的组件测试当作 Electron 实测。 |
| Claude schema 修复放松服务端 XOR | 仅移除不兼容顶层组合 schema，仍有通用类型/未知字段校验；query service 的 findDoc/read、outline、bundle 分别校验二选一/三选一；缺参/多参不会获得任意文件能力。 |
| pi 小预算破坏分页、中文中段再次被截 | 按实际 `clientInfo.name=pi` 设置会话预算 min(原上限,6000)，未复制 service/index；预算经共享分页门面计算且游标继续参数绑定，不事后截断页文本；6000 UTF-16单位的 UTF-8 上界18000B，低于实测客户端阈值。正文逐行重组由专项测试及真实 CLI 续测支撑。 |
| 兼容迁移、维护性与范围膨胀 | 配置 additive、缺省仅内存补，不新增 DB/发布格式迁移；stdio/LAN 共用 registry；DEV fixture 未被生产入口导入且显式 DEV gate；没有放宽既有生产围栏。 |

## 验证证据与可信度

### 本审核实际执行

- cwd 主树：`git status --short`、`git diff 060c02f --stat`、相关完整 diff 与源码/测试逐项读取；据此区分 tracked/untracked、生产改动/旧测试修复。
- cwd 主树：`git rev-parse HEAD` 及目标范围 `git diff --check 060c02f -- …`，退出0。后者仅验证 tracked diff 空白，**不是 untracked 文件的语法/功能验证**。
- 直接检索下列原始全量和定向日志摘要，未重新运行全套，没有 build/install/rebuild、ABI 切换或生产写入。未发现必须另写最小证伪脚本的已成立失败假设，故没有新增复现文件或项目测试。

### 复核并引用的上游运行证据

| 证据 | 实际结果 / 限定 |
|---|---|
| `/Users/run.mao/.pi/agent/amagi/data/run-bg/bg-24eac70a.log:94–97,8594–8597` | 根 `npm run test:all`：前端65文件 / **423 passed**；server136 passed文件、1 skipped文件 / **1977 passed、8 skipped**。直接读到原日志汇总，不是本审核重跑，也不声称已包含之后所有兼容/UI增量。 |
| 同根 `bg-1c059f6f.log:208–211` | build后 P5/内置/config相关9文件 **89 passed**，3.77s；正式管理API→CJS→MCP、权限与生命周期相关证据。 |
| 同根 `bg-22e8d0be.log:106–109` | 兼容小修后4文件 **26 passed**，1.61s；覆盖 MCP、三端/网关、内置 grep。采用原日志26，不误用其他报告转述的25。 |
| `gateway-report.md#生产默认看门狗补测（最新）` | 真实恶性 grep regex→SIGKILL→新客户端 literal 返回 **13,029.46ms**；未注入 timing，2s tick/10s heartbeat/1s backoff。报告保留脱敏关键原始输出；临时专项脚本已回收，故本审核不能以持久脚本再次逐字复跑，该项可信度为上游有原始数值的单次实测，不是跨机器最坏时限证明。正式短时序回归脚本仍在 tests。 |
| `gateway-report.md` 最新集成/性能段 | 真三端响应比较、双会话独立 notice、旧Bearer401/旧session404、停用与审计；10/30MiB容量为单机回环合成样本。父 event-loop 数据来自 Node 测试父进程，不等于 Electron p99。 |
| `client-compatibility-report.md#本轮修复后复测（当前结论）` | 真实 pi1.4/Claude2.1.312 CLI + 产品bundle + 回环合成推理fixture；pi stdio/HTTP direct 8k/15k逐行2/4页恢复，单页未截断；Claude首次模型工具表七项、原缺三个工具均真实调用，15k/25k/40k正文逐字送达。不是实际 LLM、人工质量或第二设备验证。 |
| `ui-report.md#续接：主应用浏览器 + 隔离真实后端（2026-10-29）` | Chromium正式主应用+隔离Node/网关，真启停/保留与作废/轮换/reveal/审计/端口冲突已完成，最终测试令牌作废且回环端口无监听；最新两处UI修复有2文件17项定向测试，但报告明确其真实交互/视觉尚待合入后复验。 |
| `regression-fixes.md` + 实读两测试 diff | 仅环境路径/后端选择的测试修复，相关32项与typecheck通过；未修改生产路径围栏，不能以初次两项失败归咎于本轮检索网关。 |

证据文本存在历史状态：`stage-c-evidence.md` 仍列客户端复测/真实browser收口中，gateway/ui报告也保留早期 blocked/mock 段。此处采用各专项报告**最新续接段**，不把旧段当当前失败，也不把报告所引用的外部门槛全部改写为 PASS。

## 未覆盖、外部门槛与剩余风险

1. **独立 staging 打包及完整 Electron GUI 仍 pending**：RunAsNode 是 Node 模式产物证据，不是 Electron 动态主端口/原生剪贴板/blur/完整产品窗口 A6/A8 验收。没有改主树 better-sqlite3 ABI。
2. 最新两处 UI 小修的真实交互/视觉回归 pending；CIDR清空恢复默认已有源码路径和API测试，UI→真实API的该闭环仍未验证。截图视觉不由本审核重新签发，沿用洛神报告的范围与限制。
3. 第二设备/真实私网、防火墙、`.local`实际解析、真睡眠、24小时长跑、Windows权限与网卡行为均未完成。漂移/网卡/TTL机制测试不能替代这些实机门槛。
4. 无真实80条qrel、真实发布资料质量门、12问人工判分；本轮也未重审B引擎或发起P4/X/P5b。Claude项目批准流程和token门限没有被本机合成中文输出测量判定。
5. v1明文HTTP的嗅探风险、共享Bearer的只读全文暴露、同uid代码可读本机秘密为设计明确保留的风险；文件围栏/权限不是OS沙箱。父进程被强制终止与所有异常文件系统竞态不在现有正常退出证据保证内。
6. 本结论只对声明的冻结实现范围有效；后续生产代码变化需由Leader按因果影响补验，不能沿用本报告覆盖尚未读过的diff。最终lint/typecheck/check收口状态以Leader后续证据为准。

## 交付与回滚

本轮仅新增本报告，未写实现/测试、未提交Git、未触碰并行现场。撤销本轮产物仅涉及本报告本身；运行层回滚仍先通过桌面停用共享，再按实施者报告局部撤销P5，不清理或重建他人工作区。

**VERDICT: PASS（限定：阶段C代码安全/生命周期审核门；外部发布验收仍按上述 pending 项收口。）**
