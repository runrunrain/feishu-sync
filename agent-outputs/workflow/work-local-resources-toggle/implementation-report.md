# Work 本机资源开关：实现与验证报告

## 结果与输入

实现了会话级 `localResources` 开关，默认关闭；浏览器在隔离数据目录中完成 Work 会话勾选/取消操作。上游为任务书、`CLAUDE.md`、指定 Pi 文档、项目源码，以及审核产物 `agent-outputs/workflow/work-local-resources-toggle/review-report.md`、`review-probe.mts`。审核修复及待裁决冲突见文末。本报告保留回归失败、风险和未覆盖项，不将全量测试称为通过。

## 规格到产物

- 存储与接口：`server/src/modules/local-map-store.ts` 为 `agent_sessions.local_resources` 双登记建表和 additive 迁移；`session-service.ts` 返回开关、拒绝非 Pi Work 和 busy 切换；`server/src/routes/agent.ts` 提供 `PUT /api/agent/sessions/:id/local-resources`；前后端 DTO、`src/api/client.ts` 和 `src/components/agent/AgentComposer.tsx` 接入。UI 仅 Pi Work 显示，成功刷新会话，运行中禁用，失败显示 alert。
- 关闭态：`pi-rpc-process.ts` 启动传 `--no-extensions --no-skills --no-prompt-templates --no-themes --no-approve`，保留上下文文件。`session-service.ts` 显式注入 `nativeWorkPackages()` 中启用的应用扩展、skills、prompts、themes 与桥接扩展。对应用 pi-home 的内置扩展过滤规则运行 Pi 内存 resolver，将实际启用的每个 builtin 显式以 `-e` 加回；不以 mcp.json 是否存在决定 MCP builtin。按主上澄清，Pi 启动前可能读取项目 `.pi/settings.json`；不把其读取等同于生效，且显式使用应用 session-dir。
- 开启态：`pi-plugin-service.ts` 只读解析本机 JSONC settings，使用当前 Pi 的 `getInstalledPath()` 和内存 SettingsManager 推导已安装路径，不用文件型 SettingsManager 的锁、不对本机目录调用 resolve/install。将本机包改写绝对路径，保留过滤字段；按 manifest name 以项目 > 本机 > 应用去重，同层本机重复保留首项并告警；未安装的本机包跳过并警告；未安装项目包发出首轮可能重复的警告，放行 Pi 自动安装，并在安装状态改变后下一轮重建去重；本机资源数组和约定目录转为绝对路径，builtin token 保留。覆盖目录位于应用私有 `agent/pi-home-local/<hash>`（0700）；按规范化 cwd 和 revision 内容寻址，在临时子目录完整校验后整体 rename，来自应用 settings 的其余字段保留。启动传 `--approve`，项目资源由 Pi 正常发现；原生 Work 的应用进程不是宿主调度子任务，故剔除继承的 `AMAGI_SUBAGENT` 和 `AMAGI_DISPATCH_MODEL`，避免插件错误地校验宿主任务模型。
- MCP 与图片：开启态 mcp.json、mcp-auth.json 存在时链接至本机文件，不复制凭据；缺失时移除覆盖目录中的旧链接，非符号链接则拒绝覆盖。按此次明确裁决，**OAuth 刷新可经 mcp-auth 符号链接写回用户凭据**；同时 Pi 锁位于覆盖目录，不能宣称与用户独立 Pi 进程的 OAuth 刷新具备跨目录互斥。`preserveUploadedImages` 只写选定的应用私有 pi-home 或覆盖目录。开启态若本机有 MCP 配置，覆盖目录链接本机 MCP；应用 pi-home 自身的 MCP 配置不会与该链接合并。
- 进程复用：`session-service.ts` 将开关、应用包 revision、本机及项目 cwd 的 settings/mcp.json 内容 hash 合入进程比较；变化时停旧进程、重新发令牌并创建。生成覆盖目录前后比较本机 revision，变化则拒绝启动。`app-plugin-store.ts` 按开关调整默认 Work 上下文说明。构建、Discuss 和 Claude Code 沿用原来的参数及工具路径。开启态未安装的本机包不传给 Pi；缺失项目包不阻断，沿用 Pi `--approve` 原生行为，首轮无法确定名称可能重复，安装状态变化后下一轮进程重建并去重。

## 验证

| 入口 / cwd | 操作及实际结果 |
|---|---|
| 主树 | `npm run lint && npm run typecheck`：退出 0；lint 有 3 条未修改文件的 React Hooks warnings |
| 主树 | `npm test -- --reporter=dot`：退出 0，85 文件、563 测试通过；存在既有 React act warnings |
| 隔离工作树 server | `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/pi-native-work.test.ts tests/pi-plugin-service.test.ts tests/pi-plugin-isolation.test.ts tests/app-plugins-live.test.ts tests/session-model-routes.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/local-map-store.test.ts --silent --reporter=dot`：退出 0，8 文件 72 测试通过 |
| 隔离工作树 server | 最终 `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npm test -- --reporter=dot --silent`：退出 1；225 文件通过、1 跳过、2 失败；3368 通过、12 跳过、2 失败。完整输出 `/tmp/work-local-server-regression.log` |
| 基线源码 `89b5ee6` | 在隔离工作树 `.baseline-89/server` 分别运行上述两个失败测试（固定版本测试仅选失败用例），两者分别以相同版本不匹配和缺 Electron 原因失败，退出均为 1；这是定向基线对照，非基线全量运行 |
| 真实 Pi fixture | `pi-native-work.test.ts` 以临时 HOME 验证关闭时项目 `.pi` / `.agents` 与用户 `.agents` skill、项目工具/MCP 不出现，显式应用包、skill、应用 MCP 和 AGENTS.md 出现；开启时用户/项目 skill、项目工具、用户与项目 MCP 出现；同名应用/本机包仅本机扩展加载。另用受控进程检查两态 argv、目录及图片设置不改用户 settings |
| 覆盖目录与路由 | `pi-plugin-service.test.ts` 检查路径改写、builtin token、同名去重、链接、0700、用户目录递归文件/内容不变及 MCP revision；`session-model-routes.test.ts` 检查模式、后端、布尔值及 busy 拒绝；并发测试覆盖开关变化后旧进程失效 |
| 浏览器真实交互 | 隔离工作树 server 使用 `FEISHU_SYNC_HOME=<worktree>/.browser-home`、`NODE_ENV=test`、端口 33071；主树 Vite 端口 5173。agent-browser 新建 Pi 会话→切 Work→本机插件默认未选→勾选呈已选→取消后呈未选。未配置模型，因此未从 UI 发起模型请求；浏览器和服务进程已关闭 |

首次真实 Pi 关闭态 fixture 的本地 HTTP 测试服务误将桥接 GET 请求当 JSON，导致失败；修正测试服务后通过。首次全量中的 `app-plugins-live.test.ts` 因继承 `AMAGI_SUBAGENT` 导致内置 amagi 检查错误模型、Work 启动退出；修复后单文件及上述 72 项重跑通过。并发测试的受控假进程原先未注入新增 revision；同步 fixture 后通过。

全量其余两项：
1. `desktop-server-process.test.ts` 报 Electron runtime 不存在；隔离工作树根未安装 Electron，属于任务列出的已知失败类别。
2. `build-runtime-fix-e2e.test.ts` 硬断言版本 `2.21.31`，本次任务指定的外部 `/Users/run.mao/workpace/amagi-pi/package.json` 为 `2.21.36`，实际安装结果为 `2.21.36`。该失败并非任务书列出的七项之一，但在原始基线相同环境定向复现。该次（审核修复前）全量仅这两项失败；当时未对基线运行完整测试集，续轮基线全量结果见文末。

## 未覆盖与风险

- 审核修复前全量有上述两项已定向复现的基线/环境失败；续轮全量及基线对照见文末。真实 Pi fixture 使用本地模型/工具 fixture，不证明真实远程模型质量。
- 用户未安装的 npm/git 包被跳过；无法读取 manifest 时保留路径但无法按名称去重，记录警告，仍可能因重复资源失败。legacy 全局 npm 自定义命令经临时 fixture 验证；Windows 路径/符号链接权限未专项验证；依赖当前安装 Pi 的内部 `getInstalledPath`，跨 Pi 版本兼容需持续验证。
- 受信本机插件是与当前用户同权限运行的 Node 代码，文件围栏不是 OS 沙箱。OAuth 的本机凭据写回及并发锁风险如上；未执行真实 OAuth 刷新。浏览器测试未覆盖真实云端认证及工作模型。
- npm ci 在隔离工作树报告 10 项依赖漏洞（4 moderate、4 high、2 critical），未运行修复。主树原生依赖未 rebuild。

## 文件与回滚

代码：`server/src/agent/{app-plugin-store,pi-plugin-service,pi-rpc-process,session-service}.ts`、`server/src/modules/local-map-store.ts`、`server/src/routes/agent.ts`、`server/src/types/agent-knowledge.ts`、`src/types/agent.ts`、`src/api/client.ts`、`src/components/agent/AgentComposer.tsx`。测试：`server/tests/{agent-session-concurrency,app-plugins-live,local-map-store,pi-native-work,pi-plugin-service,session-model-routes}.test.ts`、`src/components/agent/AgentComposer.attachments.test.tsx`。

未提交或打包。隔离工作树 `.amagi-worktrees/work-local-resources`（基线 89b5ee6）、其中基线源码副本 `.baseline-89` 及浏览器临时数据依授权保留；SQLite 测试前同步改动并用 `cmp` 逐文件校验。回滚时局部撤销以上改动，注意 `pi-plugin-service.ts` 含本任务开始前的 Leader 草稿，不应整体覆盖；已迁移数据库的 additive 列可保留为默认 0，删除数据库列须单独评估和授权。

## 审核修复

输入：`agent-outputs/workflow/work-local-resources-toggle/review-report.md` 和 `agent-outputs/workflow/work-local-resources-toggle/review-probe.mts`。本轮没有提交、打包或 rebuild 主树原生依赖。以下保留审核修复与当时待裁决证据；主上随后已裁决，最终结果与验证见文末「裁决续修」。

### F1：覆盖目录过滤操作符

`server/src/agent/pi-plugin-service.ts` 的资源数组重写保留 `+`、`-`、`!`，builtin token（包括 glob）原样保留，路径部分相对于用户 settings 目录绝对化。`server/tests/pi-plugin-service.test.ts` 使用真实 Pi `DefaultPackageManager.resolve()` 对比改写前后结果，覆盖 `!builtin:mcp`、`!builtin:*`、`-builtin:codemode`、`+builtin:tool-search`、`!skills/secret/**` 和 `+skills/visible/SKILL.md`。审核 probe 实测 MCP 与 secret skill 均 `enabled: false`，此前误启用已消失。

### F2：同名包优先级

已对当前 cwd 的 `.pi/settings.json` 做只读 JSONC 解析，本地路径按该文件目录解析，npm/git 用 Pi 的 project-scope `getInstalledPath()`；项目 manifest 名称优先于用户与应用，同名用户包保留首个并警告，同名应用包仅保留首个，保留用户被选声明的过滤对象。没有 manifest 名不能按名称去重。真实 Pi fixture 验证同名 `amagi-pi` 在项目、用户和应用均存在时只加载项目扩展；额外 fixture 验证 project-scope npm/git、用户重复和过滤对象。

**祖先查找待裁决**：任务要求「遵循 Pi 项目设置查找规则含祖先查找」，但安装的 Pi `dist/core/settings-manager.js` 的 `FileSettingsStorage` 构造函数第 120–124 行将项目设置直接定为 `join(resolvedCwd, CONFIG_DIR_NAME, "settings.json")`，并没有查找祖先。`pi-plugin-service.test.ts` 在隔离临时目录实际调用 Pi `SettingsManager.create(child, user).getProjectSettings()`，父目录 settings 中声明的包没有被读取；测试同时确认覆盖目录保留了同名应用包。如果宿主自行把父级包视为赢家并剔除应用副本，Pi 又不会加载父级包，将导致该包两边都不加载。主上已裁决以实际 Pi 行为为准：当前实现仅读 cwd。

缺失项目包：项目 npm/git 未安装时，单靠只读路径无法得知其 manifest 名；若放行，Pi `--approve` 可能自行安装，安装后与同名用户/应用扩展重复。主上已否决 409；现已改为警告并放行 Pi 自行安装，安装状态纳入 revision，测试见文末。

**多项目覆盖目录风险**：项目差异已进入同一个 `agent/pi-home-local/settings.json`，不同 cwd 的会话仍共用该文件；后来的 prepare 会替换前一项目的包列表，且 Pi `dist/core/resource-loader.js` 的 `reload()` 会重新读取 settings。并发启动或运行中 reload 时，前一会话可能读到后一项目的去重结果。主上已授权隔离子目录；现已按 cwd + revision 隔离，测试及仍未覆盖的真实 Pi 并发 reload 边界见文末。

### F3：关闭态 builtin 与扩展注册 MCP

`enabledWorkBuiltins()` 用当前 Pi 的 `builtInExtensions` 和 `DefaultPackageManager.resolve()`，在 `HOME` 指向应用私有 pi-home、`PI_OFFLINE=1`、内存 settings 仅含应用 builtin 过滤项的隔离条件下计算启用集合；不加载用户包、不安装资源。`session-service.ts` 将结果交给 `pi-rpc-process.ts` 逐个以 `-e builtin:...` 显式注入。真实 Pi fixture 未创建应用 mcp.json，应用扩展调用 `pi.registerMcpServer()` 后仍能连接本地 MCP fixture；同时应用 settings 中 `-builtin:codemode` 生效。关闭态项目/用户资源缺席的既有真实断言继续通过。

### 额外两项

- `localWorkRevision(dir, cwd)` 纳入 `<cwd>/.pi/settings.json` 与 `<cwd>/.pi/mcp.json` 的内容或缺失标记；`session-service.ts` 计算 revision 及覆盖生成前后核对均传入真实 spawn cwd。`app-plugins-live.test.ts` 使用真实 Pi 连续修改两项，分别断言进程 ID 改变。
- `localPackages()` 传内存 `SettingsManager` 的字段改为 `npmCommand`；已核对当前 Pi `settings-manager.js` 的 `getNpmCommand()` 读取该字段。旧 `packageManager` 并非该 Pi 消费字段，未做无依据的兼容别名。测试用自定义 npm 命令和临时 legacy 全局包根验证实际回退解析，且用户 fixture 文件字节不变。

### 本轮验证记录

| cwd / 命令 | 实际结果 |
|---|---|
| 主树：`npm run typecheck && npm run lint` | 退出 0；lint 仍为 0 error、3 条既有 Hooks warnings。 |
| 主树：`npm test -- --run src/components/agent/AgentComposer.attachments.test.tsx --reporter=dot` | 退出 0，1 文件 4 项通过。 |
| 主树 → `.amagi-worktrees/work-local-resources` | 17 个改动源码/测试文件逐个同步，`cmp` 全部一致；没有覆盖其他路径。 |
| 隔离树 `server/`：`AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/pi-native-work.test.ts tests/pi-plugin-service.test.ts tests/pi-plugin-isolation.test.ts tests/app-plugins-live.test.ts tests/session-model-routes.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/local-map-store.test.ts --silent --reporter=dot` | 退出 0，8 文件 76 测试通过；包括真实 Pi MCP 和两次项目配置变化触发重建。 |
| 隔离树 `server/`：`node --import tsx /Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/work-local-resources-toggle/review-probe.mts` | 退出 0；MCP、secret skill 均 disabled，同名用户扩展仅首个。probe 的 `CLOSED_BUILTINS` 为其手写固定 argv，不能证明新关闭态实现；probe 调用旧签名 `localWorkRevision(user)` 未提供 cwd，因此打印项目配置前后 hash 不变，不能作为新版项目 revision 验证；新行为由上述真实会话测试验证。 |

上述为审核修复首轮验证；续轮已重跑全量 server，结果见下节。真实 OAuth、Windows 和真实 Pi 并发 reload 仍未专项复核。回滚仅局部撤销审核修复涉及的 `server/src/agent/{app-plugin-store,pi-plugin-service,pi-rpc-process,session-service}.ts` 及 `server/tests/{app-plugins-live,pi-native-work,pi-plugin-service}.test.ts` 增量，勿整体覆盖此前实现或 Leader 草稿。

## 裁决续修

### 规格与产物

1. **项目设置查找**：主上确认以现装 Pi 实际行为为准，仅解析 cwd 的 `.pi/settings.json`。`server/src/agent/pi-plugin-service.ts` 内注释及 `server/tests/pi-plugin-service.test.ts` 的父目录 fixture 记录实测依据：当前 Pi `FileSettingsStorage` 固定读取 `join(cwd, '.pi', 'settings.json')`，实测 `SettingsManager.create(child, user)` 不读取祖先 settings。
2. **内容寻址覆盖目录**：`prepareLocalWorkHome()` 将用户和应用配置组装到 `<dataRoot>/agent/pi-home-local/<sha256(JSON([realpath(cwd), revision]))>`，先在私有 0700 临时子目录写 settings 和指向本机的 MCP 符号链接，校验后整体 rename；同名目录已存在时检查设置字节、链接目标和权限，完整才复用，不完整则报错、不覆盖。并发创建同名目录时校验胜出目录并复用。`images.autoResize=false` 在创建前写入，避免会话启动后由宿主改写已发布 settings；真实 Pi fixture 在进程退出后核对文件字节不变。Pi 或受信插件仍以用户权限运行，不能宣称 OS 层禁止它们主动改写自己的 home；MCP OAuth 通过授权的符号链接写回仍是例外。
3. **清理**：进程池无法可靠判断所有跨进程及退出竞态下的目录使用状态，因此按主上允许的保守分支**不清理任何已发布目录**，不宣称做到每 cwd 最近三份的空间上限。临时目录仅清理由本次调用自身创建的目录。长期使用可能累积，待有可靠跨进程持有证明后再做安全回收。
4. **项目缺包收敛**：项目包已安装路径不存在时仅告警，保留项目原始设置由 Pi `--approve` 自行处理；首轮可能发生同名加载。`localWorkRevision()` 异步只读查询 Pi `getInstalledPath()`，将项目包的路径存在状态和已安装 manifest 名纳入 revision，`session-service.ts` 在每轮检查并据此终止旧进程重建。临时 fixture 从未安装模拟为已安装，断言 revision 改变、目录换代、同名用户包被剔除且旧目录不变；此前真实会话 fixture 验证了 revision 变化触发实际进程换代。测试没有实际访问网络安装项目包。
5. **并发/失败**：服务级 fixture 并发准备两个 cwd 与同一 cwd 的重复请求，再生成同 cwd 第二个 revision；断言隔离、并发同名复用、旧设置不变、0700、MCP 符号链接及无临时目录残留。故意损坏既有目录后验证 409 且文件不被覆盖。真实 Pi 的并发双工作区 reload 尚未单独实测；真实 Pi 单工作区启动及资源隔离测试通过。

### 本轮执行证据

| cwd / 命令 | 退出码与结果 |
|---|---|
| 主树 `npm run typecheck && npm run lint` | 0；typecheck 通过，lint 0 error、3 条既有 Hooks warning。 |
| 主树 `npm test -- --reporter=dot` | 0；前端全量 85 文件、563 测试通过，存在 React act warning。 |
| 主树 → 隔离树 | 17 个本任务源码/测试文件同步并逐一 `cmp`，全部一致；未 rebuild 主树 better-sqlite3。 |
| 隔离树 `server/`：`AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/pi-native-work.test.ts tests/pi-plugin-service.test.ts tests/pi-plugin-isolation.test.ts tests/app-plugins-live.test.ts tests/session-model-routes.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/local-map-store.test.ts --silent --reporter=dot` | 0；8 文件、78 测试通过。 |
| 隔离树 `server/`：`AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npm test -- --reporter=dot --silent` | 1；225 文件通过、1 跳过、2 失败；3372 项通过、12 跳过、4 失败。原始日志 `/tmp/work-local-server-post-review.log`。 |
| 隔离树 `server/`：`AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/build-runtime-fix-e2e.test.ts --silent --reporter=dot` | 1；5 通过、1 失败。全量中的 F10/F09 在单文件重跑均通过，版本硬断言仍失败；日志 `/tmp/work-local-f09-isolated.log`。 |
| 隔离树 `.baseline-89/server`：同环境 `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npm test -- --reporter=dot --silent` | 1；224 文件通过、1 跳过、3 失败；3358 项通过、12 跳过、5 失败。修复后全量的 4 个失败均在基线全量以相同断言复现；基线另有 `app-plugins-live` 失败，修复后通过。日志 `/tmp/work-local-baseline-server-full.log`。 |

全量失败归因及边界：`desktop-server-process.test.ts` 因隔离树缺 Electron 失败；`build-runtime-fix-e2e` 版本用例期待 2.21.31 而指定外部 amagi 是 2.21.36，两者均已在 89b5ee6 基线复现。另有 F10 的全局 `psBridgeCount()` 检测到 1 个 `claude-bridge.cjs`，造成其后才设置的 `killLeaderBuildId` 为空、F09 连带失败；单文件重跑这两项通过，且同环境基线全量以相同断言复现两个失败。全量时该桥具体归属未捕获，不能断言由哪个并行任务造成，也不能宣称全量通过。无需修改范围外构建测试。未提交、未打包；最终验收仍应审阅基线/环境失败与跨进程现象。

## 复审修复（F4/F5）

上游：本目录 `review-report.md` 的「增量复审」和 `review-incremental-probe.mts`。本轮仅修改 `server/src/agent/pi-plugin-service.ts`、`server/src/agent/session-service.ts` 和 `server/tests/pi-plugin-service.test.ts`，未重开已 closed 的 F1–F3。

- **F4｜稳定 revision**：`localWorkRevision()` 在每次尝试开始时快照用户和项目各自的 settings.json、mcp.json 原始字节（缺失单独编码），以及应用包资源 revision、应用设置和本机资源目录存在状态；完成异步包路径查询后同步重取并比较，比较至返回 hash 之间没有 await。变化后最多重试两次，仍持续变化返回 `plugin_config_changing` 409。覆盖目录末次校验和会话 spawn 前校验均调用同一方法；覆盖生成期间发生变化时重做生成，最多三次，不能发布旧设置。`session-service.ts` 标注最终比较后至原生 Pi `rpc.start()` 不得插入 await；Claude 分支互斥。
- **F4 验证**：`pi-plugin-service.test.ts` 通过真实 Pi `getInstalledPath()` 和临时 legacy `npmCommand` 子进程，在查询等待期间分别修改用户 settings、用户 MCP、项目 settings 和项目 MCP；每项实际 revision 均与修改后的稳定结果一致且不同于旧值。另在 prepare 末次查询期间修改设置，断言结果使用新设置；连续变更三次断言 `plugin_config_changing` 409。该测试不是完整 SessionService spawn 竞态重放；后者最终调用链已静态核查。
- **F5｜禁止 project discovery**：`enabledWorkBuiltins()` 使用 `SettingsManager.inMemory(..., {projectTrusted:false})`；仍采用真实 Pi builtin resolver、应用扩展过滤和子进程私有 HOME。临时祖先 `.agents/skills` fixture 经 Node fs preload 追踪，断言该祖先目录零读取，同时 `-builtin:codemode` / `!builtin:mcp` 生效、`builtin:tool-search` 仍启用。

| cwd / 命令 | 实际结果 |
|---|---|
| 主树 `npm run typecheck && npm run lint` | 退出 0；typecheck 通过，lint 0 error、3 条既有 Hooks warnings。 |
| 主树与隔离树 | 本轮 3 个源码/测试文件同步；全部 17 个本任务源码/测试文件 `cmp` 一致。 |
| 隔离树 `server/`：`AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/pi-native-work.test.ts tests/pi-plugin-service.test.ts tests/pi-plugin-isolation.test.ts tests/app-plugins-live.test.ts tests/session-model-routes.test.ts tests/agent-session.test.ts tests/agent-session-concurrency.test.ts tests/local-map-store.test.ts --silent --reporter=dot` | 退出 0；8 文件、80 测试通过，无 skip。 |
| 隔离树 `server/`：`node --import tsx /Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/work-local-resources-toggle/review-incremental-probe.mts` | 退出 0；`REVISION_RACE.missedChange=false` 且 during=after≠before；`PREPARE_ACCEPTED_STALE` 的 user 与 overlay 均为 `!builtin:mcp`。`ANCESTOR_USER_READS` 仅记录应用私有 pi-home 内 `.agents/skills` 的 existsSync，未记录 fixture 祖先 `.agents` 访问。 |

本轮未重跑全量 server 或前端；上节全量是本轮修改前证据，不能充作本轮全量通过。稳定快照封闭被审方法自身异步等待窗口，不提供对外部同 uid 写者的 OS 级互斥或 ABA 检测；真实 OAuth、Windows、真实 SessionService 竞态重放仍未覆盖。用户自定义 npmCommand 是受信可执行代码，不能保证其无副作用。未提交、未打包；回滚本轮仅局部撤销上述 3 文件中的 F4/F5 增量，保留先前用户及 Leader 草稿。
