# Work「本机插件」独立审核（full）

结论：**needs_revision**。发现 3 条 Major；现有测试通过不能覆盖这些反例。没有发现本轮会写用户 agentDir 的常规 SettingsManager/图片设置路径，也未将已接受的 OAuth 写回视为缺陷。

VERDICT: FIX

## 基线、范围与输入

- 基线：`89b5ee6ed77c78470fd2b0579c3e09b18e9e382d`；对象为主树 `git diff` 的全部 17 个文件（450 additions / 21 deletions），不是全仓安全审计。
- 上游：`agent-outputs/workflow/work-local-resources-toggle/implementation-report.md`；已读 `CLAUDE.md`。
- 对照当前安装 Pi 的 `docs/{cli,security,skills,mcp,packages}.md`，并补读 `configuration.md`、`settings.md`；按相关执行路径检查 `dist/core/{package-manager,settings-manager,resource-loader}.js`、`dist/extensions/index.js`、`dist/extensions/mcp/{index,config}.js` 及 RPC 命令实现。实现报告中的全量/浏览器结果属于上游证据，不冒充本审核重跑结果。
- 未修改项目源码或正式测试；新增独立取证脚本 `agent-outputs/workflow/work-local-resources-toggle/review-probe.mts`。临时 fixture 只在系统临时目录创建并清理，未访问真实 MCP 凭据。

## Findings

### F1｜Major｜本机 `!builtin:` 禁用规则在覆盖目录中丢失

- **定位**：`server/src/agent/pi-plugin-service.ts:278–282`。
- **触发条件**：本机 settings 使用合法资源排除，例如 `extensions: ["!builtin:mcp"]`（或 `!builtin:*`），会话开启本机插件。
- **实际影响**：覆盖生成器只识别 `+` / `-` 前缀，且 builtin 保留正则不接受 `!`，将上述设置变成 `<user-agent-dir>/!builtin:mcp`。Pi 不再把它识别为 builtin 排除规则，MCP 被重新启用；存在 MCP 配置时可连接用户原本禁用的服务、启动其 stdio 进程。这违背“builtin token 保留”和本机资源筛选语义。
- **证据（已复现）**：独立 probe 输出 overlay 的 `extensions` 为 `["…/user/!builtin:mcp"]`，随后用真实 `DefaultPackageManager.resolve()` 得到 `builtin:mcp, enabled: true`。Pi `package-manager.js:520–527` 明确把 `!` 归为 override/exclude；`settings.md#Resources` 也声明 `!pattern` 支持。不是只按字符串猜测。
- **最小修复方向**：保留 `!` 操作符及 builtin pattern；对资源路径只解析去除操作符后的路径部分，并验证排除规则在覆盖前后行为等价。让实施者补 `!builtin:mcp`、`!builtin:*` 与文件 glob 排除回归；现有测试只断言 `-builtin:codemode`，未覆盖此分支。
- **复核脚本**：`review-probe.mts` 的 `OVERLAY` / `ENABLED_MCP` 输出。该脚本同时观察到普通 skill glob 的实际结果，不能把本 finding 泛化成“所有 !skill 排除都会启用”。

### F2｜Major｜manifest 去重只用于删除应用包，没有约束完整本机集合

- **定位**：`server/src/agent/pi-plugin-service.ts:258–274`（尤其 261、268、274）；项目资源通过 `server/src/agent/pi-rpc-process.ts:208–209` 的 `--approve` 另行进入 Pi。
- **触发条件**：① 用户 settings 中有两个不同本地路径、manifest `name` 相同的已安装包；或 ② 项目 `.pi/settings.json` 声明与应用内 amagi-pi 同名、但路径不同的本地包。
- **实际影响**：① `local` 原样全部拼入 settings，没有按 manifest name 合并；② 本机名称收集只读取用户 agentDir，不读取项目 packages，因此应用包不会为同名项目包让位。Pi 自身按本地绝对路径而非 manifest name 判重，两个副本都会加载，可重复执行初始化/注册工具或产生工具冲突。与 Leader 的“按 manifest 名去重且本机优先”“同名 amagi-pi 只一份”不一致。
- **证据**：① **已复现**：probe 创建 `user/a`、`user/b`，二者 manifest 均为 `same-name`。overlay 保留两个路径；真实 Pi resolver 输出两个 `enabled: true` 的 `extension.mjs`（不同 packageRoot）。② **静态路径证实**：`localPackages()` 只读 `agentDir/settings.json`；`prepareLocalWorkHome()` 没有 cwd 参数；Pi `package-manager.js:702–717` 收集受信项目包后再收集用户包，而 `packages.md#Understand scope and identity` 明示本地包以绝对路径为身份。故项目同名、不同路径不会替换 overlay 的应用副本。
- **最小修复方向**：明确并实现整个待加载集合的 manifest-name 优先级，包括受信项目包与用户包；保留所选声明的 filter 对象，不能靠删掉 filter 达成去重。对于本机内部重复项确定稳定优先级或显式报冲突，不能全部传入。
- **复核脚本**：`review-probe.mts` 的 `SAME_NAME_EXTENSIONS`；项目同名 amagi 尚未做完整会话启动复现，正式回归应由实施者补充。现有真实 fixture 仅覆盖“一个用户包对一个应用包”，不能证明全局唯一。

### F3｜Major｜关闭态把应用扩展注册的 MCP 与 mcp.json 文件错误绑定

- **定位**：`server/src/agent/pi-rpc-process.ts:210–212`。
- **触发条件**：一个启用的应用 Pi 插件通过正式扩展 API `pi.registerMcpServer()` 注册服务，应用 pi-home 没有 `mcp.json`（纯扩展注册无需该文件）；会话保持默认关闭本机插件。
- **实际影响**：应用扩展本身虽然被显式注入，但 `--no-extensions` 禁用了 builtin MCP，代码又只在存在应用 `mcp.json` 时补 `-e builtin:mcp`。没有 MCP 扩展来连接注册的服务，应用内插件的这部分能力在默认关闭态失效。关闭本机来源不应同时关掉应用插件依赖的 MCP 支持。
- **证据（静态路径证实 + loader 抽检）**：`docs/mcp.md#Add servers from extensions` 明确注册服务由内置 MCP 扩展连接；`dist/extensions/mcp/index.js` 负责处理注册服务。`dist/core/resource-loader.js:409` 在 `noExtensions` 时只留下显式 CLI 扩展，`dist/extensions/index.js:9–11` 中 MCP/codemode/tool-search 为独立 builtin。probe 的 `CLOSED_BUILTINS` 进一步确认显式 `builtin:mcp` 仅加载该项，不会隐式恢复其余 builtin。本条没有执行真实注册服务器的完整会话复现；条件分支与消费链可直接复核。
- **相关边界**：即使存在 mcp.json，默认 `codemode` / `deferred` MCP 也需要可达的 discovery 工具；内置 amagi 可提供 codemode，不能把这一点误写成默认配置必然不可用。但停用相应应用工具提供者时，仅补 builtin:mcp 并不自动补回 builtin codemode/tool-search。当前测试的所有 MCP fixture 都用 `exposure: direct`，覆盖不到此依赖。
- **最小修复方向**：在关闭态仍保留应用扩展所需的 builtin MCP 支持，同时用私有 agentDir + `--no-approve` 维持本机配置隔离；不要用 mcp.json 是否存在代替“应用扩展是否可注册 MCP”的判据。补注册式 MCP 与无 amagi discovery provider 的针对性回归。

## 清单覆盖与核实结果

| 审核项 | 覆盖 / 判断 |
|---|---|
| 默认关闭；用户/项目来源隔离 | argv 与真实 Pi fixture 已复跑。私有 home + no-* + no-approve 阻断常规用户/项目资源；保留 AGENTS。Pi 仍提前读取项目 settings 属裁决允许项。项目 packages 安装行为由 trust gate 阻断；不将“读到文件”报成启用。 |
| 应用包显式资源 | nativeWorkPackages 收集扩展/skills/prompts/themes；资源入口去重扩展使用 Set。应用 MCP 功能缺口见 F3；prompts/themes 未单独完整模型请求复现。 |
| 用户目录写入 | 本机查询使用 SettingsManager.inMemory；getInstalledPath 的 local/git/托管 npm 分支无 resolve/install。legacy npm fallback 会执行 npm 查询而非纯 FS 查找，未验证自定义 npm 命令的副作用。图片设置写选定私有 home。 |
| 符号链接 | lstat 后拒绝真实文件，unlink 仅移除 overlay 中链接，不删除链接目标；同步部分无 await，因此同进程 link 检查/替换没有常规异步交错。OAuth 经链接写回为已接受例外，未执行真实刷新。 |
| 并发覆盖生成 | settings 原子 rename，shared overlay 为 0700；生成前后检查用户 revision。未复现破坏性竞争。跨进程、配置在检查之后继续变化的时序未做压力验证，不据此宣称无竞态。 |
| manifest/filter | filter 对象经 spread 保留，单用户对应用去重测试有效；完整集合去重不成立，见 F2。builtin token 排除见 F1。 |
| 环境变量剔除 | AMAGI_SUBAGENT / AMAGI_DISPATCH_MODEL 删除仅在 nativeWork 分支。源码调用链显示仅交互 Pi Work 传 true；Discuss、构建/任务子进程未扩展到该分支。 |
| 进程复用 / busy | 开关进入 pluginRevision；新测试验证开关变更后终止旧进程；setLocalResources 同步检查 isRunning/pool.isBusy，busy 返回 409。 |
| Claude / Discuss | 后端与模式守卫有效；本机开关不用于这些路径；非 native pluginRevision 仍经 nativeOptions 参数保存，未发现该改动导致非 Work 每轮重启。 |
| DTO / 存储 | 双端 DTO、新路由、默认 false、DDL 与 additive 双登记均核对；迁移持久化测试已复跑。 |
| UI | 仅 Pi Work、running/sending/localSaving 禁用、失败 alert、成功回调刷新；组件测试已复跑。本审核没有独立浏览器/视觉验证，不以组件测试替代真机结果。 |
| 测试有效性 | 未见本轮删断言或新增 skip；旧真实 Pi 测试仍有原有 runtime skip，新增隔离 fixture 强制断言 runtime 可用。本轮复跑未跳过。并发 mock 手工写 revision 仅支持其受控场景，不能当真实 spawn 全链路证明。 |

## 独立验证记录

1. 主树：`git diff --name-only | while IFS= read -r p; do cmp "$p" ".amagi-worktrees/work-local-resources/$p" || exit 1; done`，退出 **0**，全部 17 文件与隔离树一致，之后才运行 SQLite 测试；没有 rebuild。
2. cwd `.amagi-worktrees/work-local-resources/server`：
   `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/pi-native-work.test.ts tests/pi-plugin-service.test.ts tests/pi-plugin-isolation.test.ts tests/session-model-routes.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/local-map-store.test.ts --silent --reporter=dot`
   退出 **0**：7 文件、71 测试通过，无 skip（约 3 秒）。真实 Pi fixture 为本地模型服务，不调用真实远程模型。
3. 同 cwd：`node --import tsx /Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/work-local-resources-toggle/review-probe.mts`，退出 **0**。取得 F1/F2 的实际 resolver 输出及 F3 loader 取证；日志标签 `toggle-probe`。
4. 主树：`npm test -- --run src/components/agent/AgentComposer.attachments.test.tsx --reporter=dot`，退出 **0**：1 文件、4 测试通过。
5. 未重跑全量 lint/typecheck/server/frontend 测试；上游报告的全量两个失败及基线对照未独立复现，故不在本审核内认证为通过或新增回归。

## 额外观察与盲区（不计 finding）

- `localWorkRevision()` 目前只 hash 用户 settings.json / mcp.json 与应用包 revision，不含项目 settings/MCP。probe 创建项目 settings 前后 hash 相同。若“本机配置 hash”承诺包含项目配置，则当前进程下一轮仍可能沿用修改前项目配置，需 Leader 明确覆盖范围并补复用验证；本审核不把含义尚未明确的热更新契约另计阻断项。
- localPackages 传给内存 SettingsManager 的是 `packageManager` 字段，而当前 Pi legacy npm 查询读取 `npmCommand`。自定义 pnpm/bun 全局安装回退未专项验证，应补验证，不将当前 PATH 下 npm  fixture 通过推广到所有安装方式。
- Windows symlink 权限、真实 OAuth 刷新与跨独立 Pi 进程锁竞争、配置编辑压力场景、真实生产插件集合均未验证。没有发现并不等于证明这些场景安全。
- 回滚本审核产物：只需删除本报告及相邻 `review-probe.mts`，不涉及应用代码/数据库。实现改动的修复与撤回交由 Leader / 实施者；本审核不提供 patch。

**最终结论：needs_revision；F1–F3 修复并补相应回归后再复审。VERDICT: FIX**


## 增量复审

结论：**needs_revision**。F1–F3 原反例均已关闭；新增 **F4 Major**（异步 revision 的校验窗口）和 **F5 Minor**（builtin 查询越出私有目录进行发现）。本结论仅覆盖本轮指定修复与裁决，不重新审核未改链路。

### 基线与证据边界

- 基线仍为 `89b5ee6`；复审主树当前 17 文件 diff（700 additions / 23 deletions），重点为 `pi-plugin-service.ts`、`pi-rpc-process.ts`、`session-service.ts` 及相关测试。上游为本报告原审核与 `implementation-report.md` 的「审核修复」「裁决续修」。
- SQLite 测试前执行 `git diff --name-only | while IFS= read -r p; do cmp "$p" ".amagi-worktrees/work-local-resources/$p" || exit 1; done`，退出 0。所有测试在隔离树 server 运行，未 rebuild、未改主树源码或正式测试。
- 当前 resolver 返回 Pi 1.4.0（全局 `@earendil-works/pi-coding-agent`），不是外部 amagi-pi 源码树；后者为插件来源，不能把其不存在的 `dist/core` 当运行时。复核了真实运行时 settings/package-manager/builtin 消费路径。

### 原 findings 状态

| 编号 | 状态 | 复核结果与测试可信度 |
|---|---|---|
| F1 | **closed** | `pi-plugin-service.ts:318–323` 保留 `!/+/-` 与 builtin pattern。`pi-plugin-service.test.ts` 的「Pi resolver 对用户资源过滤与覆盖后的启用结果一致」使用真实 `DefaultPackageManager.resolve()` 比较前后，并明确断言 MCP/codemode disabled、tool-search enabled；skill glob 也比较真实输出，不是仅检查拼接字符串。 |
| F2 | **closed** | `pi-plugin-service.ts:292–312` 项目 manifest 名先占位，本机重复保留首项，再过滤应用包；对象过滤字段保留。真实 Pi fixture 分别验证本机压过应用、项目压过两者，工具只注册一次且仅赢家扩展产生加载标记。npm/git 与缺包收敛另有真实 SDK 路径 fixture。尚未安装项目包首轮可能重复已属主上接受的行为，不作为未修复。 |
| F3 | **closed** | `pi-plugin-service.ts:365–379` 计算 builtin 集合，`session-service.ts:698,817` / `pi-rpc-process.ts:212–213` 显式传入；不再依赖 mcp.json。真实 fixture 无应用 mcp.json、由应用扩展 `registerMcpServer()` 注册 MCP，模型请求实际包含 appfixture 工具；`-builtin:codemode` 生效，用户/项目资源仍缺席。新辅助函数的独立副作用见 F5，不重开原 F3。 |

### 新 findings（修复因果相关）

#### F4｜Major｜最终 revision 校验会把 await 期间的配置更改判为未更改

- **定位**：`server/src/agent/pi-plugin-service.ts:261–282`，消费点 `:350,359` 与 `server/src/agent/session-service.ts:701`。
- **触发条件**：本机或项目 settings/MCP 在 `localWorkRevision()` 已读取原始字节后、等待 `localPackages()` 的 runtime/子进程查询时改变；包路径和 manifest 名保持不变。该等待可能包含 legacy npm 查询（最长 30 秒），不是仅最后一次同步检查之后的不可消除微小窗口。
- **实际影响**：revision 返回旧值，已有的「生成前后」「spawn 前」比较都可能误通过。例如用户在最终检查等待期间新增 `!builtin:mcp`，会话仍可使用旧覆盖设置启用 MCP。也可把旧配置误标为当前进程 revision。下一轮可能收敛，不能撤回本轮已经加载的扩展/MCP。
- **证据（已复现 + 静态消费链）**：`review-incremental-probe.mts` 通过真实 `getInstalledPath()` 的 legacy `npmCommand` 子进程，在 revision 等待期间修改临时 settings；没有 mock hash、SDK 或被审方法。输出 `REVISION_RACE` 中 `before === during`、`during !== after`、`missedChange: true`。再将编辑精确落到 prepare 的末次校验，输出 `PREPARE_ACCEPTED_STALE {user:["!builtin:mcp"],overlay:[],returned:true}`。SessionService 在 :701 使用同一有缺陷的方法；把同一编辑时序放到此次末次 await，即会通过旧 workRevision 比较，后续直到 `rpc.start()` 没有另一次同步源快照复核。**完整 SessionService spawn 竞态未动态重放**，这段影响由实际控制流证实；prepare 接受旧设置已动态重放。现有并发目录测试与顺序编辑后换进程测试没有覆盖 await 内编辑。
- **最小修复方向**：把源配置与安装状态作为同一稳定快照处理；异步查询完成后，在无额外 await 的尾部同步重读并比较原始源配置/应用 revision，变化返回 409 或重新取快照，不能直接返回 await 前累计的 hash。prepare 与最终 spawn 检查应使用同一稳定性规则；由实施者补末次校验查询期间编辑的回归。这里只要求封住自身异步窗口，不要求对任意同 uid 外部写者建立 OS 沙箱。

#### F5｜Minor｜builtin 集合计算仍会递归发现真实 cwd 祖先的 `.agents/skills`

- **定位**：`server/src/agent/pi-plugin-service.ts:373–376`。
- **触发条件**：应用 pi-home 的祖先含 `.agents/skills`，典型为默认数据根位于用户 HOME 下，且到用户 HOME 之间没有 Git 根截断。尽管子进程 HOME 改成私有 pi-home，resolver cwd 仍在真实用户目录的后代。
- **实际影响**：只求 builtin 名称却枚举用户 skill 目录、读取其中 ignore 规则，可能带来与用户技能树大小相关的无谓耗时；“HOME 重定向即可不读用户资源”的隔离说明不成立。**未观察到这些 skills 被加载、用户文件被写或包被安装**，所以不把它夸大为插件执行/权限绕过。
- **证据（已复现）**：同一 probe 调用真实 `enabledWorkBuiltins()`，仅用 Node preload 记录 fs 调用（原调用照常执行）。临时数据根祖先放置 `.agents/skills/fixture` 后，`ANCESTOR_USER_READS` 记录祖先目录及 fixture 的 `readdirSync`；HOME 已由被审函数自行改写。Pi `package-manager.js:2024–2049` 在 inMemory settings 默认 `projectTrusted=true` 时遍历 cwd 祖先；修改 HOME 只改变 userAgentsSkillsDir，不禁止该祖先扫描。probe 全程只用临时目录，不读取真实用户 skill 树。
- **最小修复方向**：计算 builtin 时显式禁用 project discovery（例如内存 settings 的 projectTrusted=false，并核对不会改变空 project settings 下的 builtin 过滤结果），或使用只计算 builtin 过滤的 SDK 路径。保留 HOME 子进程局部覆盖，不修改宿主 HOME。

### 裁决及安全面复核

| 项目 | 结果 |
|---|---|
| 仅 cwd `.pi/settings.json` | 符合裁决。真实 SettingsManager fixture 证明父目录 settings 不参与；不再按祖先包删除应用副本。 |
| `hash(realpath(cwd), revision)`、tmp→rename、复用 | 已实现。真实服务 fixture 验证两 cwd、同名并发、不同 revision、旧设置不变、0700、链接目标与临时目录清理。已有目录使用 lstat 拒绝目录/设置文件符号链接；损坏设置返回 409 且不覆盖。revision 稳定性缺口见 F4。 |
| 不清理已发布目录 | 符合裁决；只清本次 mkdtemp 临时目录。长期积累是明确接受的空间风险，不另计 finding。 |
| 项目缺包仅告警并放行 | 已实现；缺失项目声明仍由 Pi 项目配置处理，安装状态和 manifest 名进入 revision；fixture 模拟安装落盘后 revision/覆盖目录换代并剔除同名本机包。没有联网安装验证，不冒称已经验证真实网络安装。 |
| builtin 查询与 HOME | 无 packages 输入、PI_OFFLINE=1、SettingsManager.inMemory；未发现 resolve/install 写用户 agentDir 路径。HOME/USERPROFILE 只覆盖 execFile env，不修改宿主。但祖先发现仍会读用户目录，见 F5。 |
| 用户 agentDir 写入 | 本轮代码通过内存 settings/getInstalledPath 只读推导；图片设置写应用目录/已生成 autoResize=false 的 overlay，不改用户 settings。OAuth 经 mcp-auth 链接写回仍为接受例外。自定义 npmCommand 是用户指定可执行代码，不能宣称其本身无副作用或受 OS 沙箱约束。 |
| 符号链接 | 发布目录与 settings 拒绝符号链接，MCP 项要求是指向预期用户路径的符号链接；unlink/rm 只清自身临时目录。链接目标后续仍可由用户修改，OAuth 写回/跨独立进程锁风险沿用接受边界。未做恶意同 uid 进程在 lstat/rename 间替换目录的 OS 级隔离证明。 |

### 独立验证与盲区

1. 上述 17 文件 `cmp` 退出 **0**。
2. cwd `.amagi-worktrees/work-local-resources/server`：
   `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/pi-native-work.test.ts tests/pi-plugin-service.test.ts tests/pi-plugin-isolation.test.ts tests/app-plugins-live.test.ts tests/session-model-routes.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/local-map-store.test.ts --silent --reporter=dot`
   退出 **0**：8 文件、78 测试通过，无 skip；调试标签 `toggle-rereview`。这支持原 F1–F3 关闭，不证明 F4 时序安全。
3. 同 cwd：`node --import tsx /Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/work-local-resources-toggle/review-incremental-probe.mts`，退出 **0**；最终日志标签 `toggle-incremental-final`，确认 F4/F5。旧 probe 未重跑；没有把其旧 revision 签名或手写 CLOSED_BUILTINS 当新证据。
4. 抽查 `/tmp/work-local-server-post-review.log`：确有 3372 passed / 4 failed；其中缺 Electron、版本不符、psBridgeCount 与其后继断言失败与报告一致。未重跑全量，也未独立认证基线全量的运行环境与每个归因；本次不以这些范围外失败签发回归通过。
5. 未覆盖：Windows、真实 OAuth 刷新、外部编辑压力/完整 SessionService 竞态复现、真实 Pi 双 cwd 并发 reload、网络安装及生产插件集合。未新增项目测试或修复 patch。审核产物回滚只需移除本「增量复审」节与新增 `review-incremental-probe.mts`，原审核历史不变。

**复审结论：needs_revision（F1–F3 closed；F4 Major、F5 Minor 待处理）。VERDICT: FIX**
