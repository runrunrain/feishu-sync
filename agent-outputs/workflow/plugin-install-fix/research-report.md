# 只读调查报告：amagi-pi 安装检测/应用内安装 404（构建编排）

日期：2026-11-01（America/Los_Angeles）。只读调查，未改任何源码/配置/生产插件/真实数据；shell 仅只读探测（git 查询、目录结构枚举、npm view 只读 registry 查询、node -e 读 package.json/特定非敏感字段）。

> 修订 1（2026-11-01，反馈回执）：① §六 纠正 WIP 现场描述——原句"feishu-sync 工作树实测 clean"与派发快照的 14 个用户 WIP 不符，已改为真实现场（WIP 已被用户提交为 e5bb904，非从未存在）；② §三/§四/结论索引 补裁定边界：**手工源可安装 ≠ 用户默认按钮可用**；默认按钮已知 404 与 UI 可观测性**已裁定必修**，手工 worktree 仅为取证/应急通道，不作为交付方案。其余事实未改动。

## 结论索引

| # | 主张 | 状态 | 关键锚点 | 适用边界 |
|---|------|------|----------|----------|
| 1 | 应用内安装 404 根因：npm 模式请求公共 registry 中**不存在的包名**（`amagi-pi` 整包 404，非仅 2.21.31 缺失）；安装按钮默认无 sourceDir 必然走 npm 模式 | 观察 | npm view 实测 E404；amagi-package.ts:278-286；BuildOrchestrationSettings.tsx:769-788 | 公共 registry.npmjs.org；若上游发布包后 npm 模式自动可用 |
| 2 | "固定 amagi 2.21.31 未安装"是**准确检测**，不是检测错误：检测只认 `<dataRoot>/agent/runtime-packages/amagi-pi@2.21.31/install-record.json`；现网该目录是失败 npm 安装残骸（仅 npm/.gitignore+package.json，无 record） | 观察 | amagi-package.ts:180-215（verify）；实测目录内容；capability-probe.ts:88-113 | 构建运行时通道（v2 §3.1/§11 版本化冻结设计） |
| 3 | "无法检测已安装插件"= 通道/位置错配，非 bug：用户 amagi-pi 装在**全局 pi home**（~/.pi/agent，本地目录 2.21.36 WIP）；通用插件通道按设计只用应用专属 pi-home；构建运行时通道只认版本化目录——三者互不可见 | 观察 | ~/.pi/agent/settings.json packages（仅读字段值）；pi-plugin-service.ts:32；docs/reports/pi-native-plugin-management.md"按用户要求改为专属agent/pi-home" | 本机现场快照 |
| 4 | source 模式安装链完整存在且实测过（临时 home live-probe pass），但 sourceDir 直指本地仓库工作树会因版本守卫拒绝（工作树 2.21.36 ≠ pin 2.21.31）；pin 2.21.31 的精确来源 = 本地仓库 Git HEAD 929000e（package.json=2.21.31，无 v2.21.31 tag） | 观察 | amagi-package.ts:296-306；git show 929000e:package.json 实测；live-probe-report.md:23-24（hash 9485dd95c004/3545 文件） | 本地仓库当前 HEAD=远端 main（Leader steer 核实） |
| 5 | **手工 source 路径**不改代码即可走通：既有入口 POST /api/kb/build-runtime/install + sourceDir 指向 929000e 的干净检出（git worktree/clone）→ 物化→pi install 登记→哈希冻结。**≠ 用户默认按钮可用**：默认按钮在包发布 npm 前必然 404，该已知缺陷已裁定必修（§四） | 观察（链路推断，依据实测过的 live-probe + 单测） | routes/kb.ts:552-577；build-runtime-host.ts:313-329 | pi 1.4.0 本机实测在支持范围 |
| 6 | 改进点分档（裁定更新）：**默认已知 404 修复与 UI 可观测性已裁定必修**（含失败提示误导、错误不可区分、layout 恒 null、全局 2.21.36 与固定 2.21.31 分栏）；残骸清理仍交裁决。均不阻塞手工安装路径 | 观察（裁定为 Leader 反馈；条目映射含推断） | capability-probe.ts:113；statusDto layout:null（build-runtime-host.ts:305）；preload selectDirectory 已存在未接入本卡 | 具体修复方案由实现轮定 |

## 一、两条通道 + 三个位置（核心区分）

**通道 A：通用 Pi 插件管理**（用户可见"Packages"卡，AgentPluginsCard）
- `PiPluginService`（server/src/agent/pi-plugin-service.ts:21+）：agentDir=`<dataRoot>/agent/pi-home`，登记表=该目录 settings.json 的 packages。
- 安装/更新/移除 = 正式 pi CLI（`node <piCli> install/update/remove <source>`，env `PI_CODING_AGENT_DIR`=应用 pi-home）；检测 = Pi 原生 SDK `dist/core/package-manager.js` 经 `server/src/agent/pi-extension/inspect-packages.mjs`（`listConfiguredPackages()+resolve()`，只解析不加载工厂）。API：`GET /api/agent/plugins`、`POST /api/agent/plugins/:action`（server/src/routes/pi-plugins.ts:9-10）。
- 支持 source 形态：`npm:` / `git:`/`https:`/`git@` / 本地绝对路径（validSource，pi-plugin-service.ts:142-147）。
- 隔离是设计决定：docs/reports/pi-native-plugin-management.md 明确"CodeBox 使用通用 Pi 目录，本应用**按用户要求**改为专属 agent/pi-home"；界面文案同口径（AgentPluginsCard.tsx:74）。

**通道 B：构建运行时固定版本**（"构建运行宿主"状态卡，BuildOrchestrationSettings）
- `BuildRuntimeHost` + `amagi-package.ts`：版本化目录 `<dataRoot>/agent/runtime-packages/amagi-pi@<pin>/` + install-record.json（schemaVersion/layout/installedVia/contentHash/文件数字节数）。安装 home=版本化目录本身（`PI_CODING_AGENT_DIR=installDir`），与通道 A 的 pi-home 不同。
- 检测=`verifyAmagiPackage` 只查该目录：record 存在→版本核对→（缺省）内容哈希全量重算（amagi-package.ts:180-215）。probe 展示 amagi-package / amagi-package-hash 两项（capability-probe.ts:88-113）。
- npm 模式 `pi install npm:amagi-pi@<pin>`（amagi-package.ts:278-286）；source 模式：源版本守卫→staging 物化→完整哈希→rename 入位（残留 aside）→`pi install <绝对物化路径>`→settings.json 包来源核对→写 record（amagi-package.ts:290-383）。

**第三个位置：全局 pi home（~/.pi/agent）**——用户本机真实安装处（packages 含 `/Users/run.mao/workpace/amagi-pi` 与 pi-black git 包；仅读取该字段）。两条应用通道都不读它；通道 A 检测读的是应用 pi-home 的 packages（实测当前仅 builtin knowledge-workbench 一项）。

## 二、对截图的准确解释

1. "Pi 1.4.0"：来自 PiRuntimeResolver 对全局 pi 的发现（本机 fnm v24.21.0 下 `@earendil-works/pi-coding-agent` 1.4.0，bin=dist/bundle/cli.js，`dist/core/package-manager.js` 存在——通道 A 检测前置健康）。1.4.0 在支持范围 `>=1.4.0 <2.0.0` → pi-version check pass。
2. "固定 amagi 2.21.31 未安装"：`AMAGI_PI_PINNED_VERSION='2.21.31'`（build-runtime-host.ts:68）；检测只认版本化目录。实测 `~/.feishu-sync/agent/runtime-packages/amagi-pi@2.21.31/` 仅有 `npm/.gitignore`+`npm/package.json`（pi 底层 `npm install --prefix` 失败后的前缀骨架），无 install-record.json → `amagi_record_missing` → installed:false。**结论正确**；用户在全局 pi home/本地仓库的安装不属于该通道，被排除是设计而非漏检。
3. "点应用内安装 → npm 404"：安装按钮（BuildOrchestrationSettings.tsx:769-788）在 sourceDir 输入框留空时 POST 空 body → npm 模式 → registry E404（`amagi-pi` 包名整体不存在：`npm view amagi-pi versions` 返回 Not Found，实测 2026-11-01）。代码注释已自知（amagi-package.ts:16"实测 404：2.21.31 未发布公共 npm，包发布后可用"）。错误经 `amagi_install_failed` 400 回显（routes/kb.ts:570-576）。
4. 若用户在 sourceDir 填 `/Users/run.mao/workpace/amagi-pi`：源版本守卫拒绝（工作树 package.json=2.21.36 未提交 bump，≠ pin 2.21.31 → `amagi_version_mismatch`）。该仓库 HEAD 929000e 的 package.json 恰为 2.21.31（`git show 929000e:package.json` 实测；v2 研究报告 line 7 亦锚定此基线），但工作树已超前且无 v2.21.31 tag 可检出。

## 三、现有可复用入口（手工/取证路径；**≠ 用户默认按钮可用**）

> **边界声明（裁定回执）**：本节是"不改代码即可走通"的手工通道。**手工源可安装 ≠ 默认按钮可用**：默认按钮（sourceDir 留空）在 amagi-pi 发布 npm 前必然 404——这是面向用户的已知缺陷，**已裁定必修**（默认已知 404 处置 + UI 可观测性，见 §四）；手工 worktree 不是给用户的交付方案，仅取证/应急。可复用基建（CLI+SDK）同时是修复轮的落点。

沿 steer 方向"原生 pi CLI Git 取 commit → 现有 source 物化冻结 → 本地 CLI 登记"，全部已有基建，无需新增插件调度器、无需改 pin：

1. 取 2.21.31 稳定源：`git worktree add <tmp> 929000e`（或 clone 后 checkout 该完整 commit；不用 latest/tag——远端无 v2.21.31 tag，steer 已核实）。
2. `POST /api/kb/build-runtime/install` body `{"sourceDir":"<该检出绝对路径>"}`（routes/kb.ts:552；前端输入框已支持手输绝对路径，BuildOrchestrationSettings.test.tsx:400-414 已测透传）。
3. 服务端自动完成：staging 物化（排除 node_modules/.git 等，SOURCE_COPY_EXCLUDE）→ 版本+全量哈希验证 → rename → `pi install <绝对路径>`（专用 home）→ settings 包来源核对 → install-record.json 冻结。幂等复用默认全量哈希校验。
4. 验证：`GET /api/kb/build-runtime` → amagi.installed=true、amagi-package/amagi-package-hash pass（live-probe 同链路实测锚点：hash 9485dd95c004、3545 文件/83553 KiB，agent-outputs/workflow/build-runtime-v2/live-probe-report.md:23-24）。

相关既有能力（修复轮可直接复用）：`window.desktop.selectDirectory()`（electron/preload.ts:66，AgentModePanel/AgentView 已用）可做 sourceDir 目录选择器；`inspect-packages.mjs` 可复用于任何"列出 pi 已配置包"的分栏展示需求。

## 四、改进点分档（裁定更新：默认已知 404 与 UI 可观测性**已裁定必修**）

反馈裁定：**需修默认按钮已知 404 与 UI 可观测性，不是给用户仅手工 worktree 绕过**。分档如下（条目→档位映射为推断，具体方案由实现轮定）：

| # | 观察 | 锚点 | 档位（本轮裁定口径） |
|---|------|------|----------|
| 1 | 探测失败提示"先经 pi CLI 安装 npm:amagi-pi@2.21.31"在包未发布期间误导（npm 模式必然 404） | capability-probe.ts:113 | **必修**（默认已知 404 处置面） |
| 2 | sourceDir 仅手输，无 selectDirectory、无本地仓库/commit 自动发现 | BuildOrchestrationSettings.tsx:874-883 | **必修**（默认入口可用性；preload selectDirectory 已有） |
| 3 | statusDto 的 amagi.layout 恒 null（record.layout 有值但未透出），npm/source 布局不可观测 | build-runtime-host.ts:305 | **必修**（UI 可观测性） |
| 4 | 全局安装（2.21.36）与私有固定（2.21.31）无分栏：DTO 无全局安装字段，resolver 不读全局 packages——须"分栏、不混作已满足" | build-runtime-host.ts:130（DTO 定义） | **必修**（UI 可观测性） |
| 5 | npm 失败残骸（npm/ 骨架）留存不清理（无害：source 模式会移 aside；npm 重装 mkdir recursive 可容） | amagi-package.ts:280-282 | 仍交裁决 |
| 6 | npm 模式对"包整体不存在"与"版本不存在"错误同码（amagi_install_failed），用户无法区分 | amagi-package.ts:289-300 | **必修**（默认已知 404 处置面，错误可区分） |

版本 pin 策略事实：pin 是编译期常量（build-runtime-host.ts:68 注释"升级须重核能力探测后修改"），不读 config；静态 PROVIDER_KEY_MAP 等表"源自 amagi-pi 源码，升版须重核"（capability-probe.ts:137）。升 pin 至 2.21.36 须走完整能力重核流程，本轮未评估两版行为差异。

## 五、回归矩阵（供下游验证用）

| 层级 | 用例 | 既有资产 |
|------|------|----------|
| L1 冒烟 | GET /api/kb/build-runtime：pi-version pass、amagi-package/-hash pass、installed=true；POST install 幂等 fresh=false | 手工/curl；ui-report.md:43 同 DTO 组合 |
| L2 针对性（改 amagi-package/probe 时） | 哈希冻结/symlink 拒绝/预算、npm+source 双模式、幂等篡改拒绝、record 删除拒绝、版本守卫、包含关系守卫、残留 aside、settings 来源核对、env 凭据剔除 | `npx vitest run tests/build-runtime-package.test.ts tests/build-runtime-capability-probe.test.ts`（server/，单测名全覆盖上列） |
| L2 针对性（涉及通道 A/resolver 时） | 通用插件通道安装/启停/隔离、运行时发现 | `tests/pi-plugin-service.test.ts tests/pi-plugin-isolation.test.ts tests/runtime-resolver.test.ts` |
| L2 前端 | sourceDir 透传、失败如实展示、安装成功刷新状态（修复轮需按新裁定扩展：默认按钮行为/分栏/layout 展示） | `src/components/settings/BuildOrchestrationSettings.test.tsx:345-424` |
| L3 全量 | CI 口径 | `npm run check`（lint+typecheck+全部测试） |
| 真实链路 | 真实 pi+amagi live probe（需真实环境，非 CI） | `tests/build-runtime-live-probe.test.ts` + agent-outputs/workflow/build-runtime-v2/live-probe*.md |

## 六、敏感面与边界

- 只读取的字段：app pi-home 与全局 ~/.pi/agent 的 settings.json `packages` 字段及键名结构；未读 auth.json/models.json/任何密钥值；未输出完整配置。
- 未触碰：WIP 文件与用户现场，全程只读。**现场纠正（反馈指正，复核于 2026-11-01 16:04 PST）**：
  - 派发时快照记录 feishu-sync 存在 **14 个用户 WIP 文件**；
  - 复核（观察）：该批 WIP 已由用户于 **2026-11-01 15:59:17 -0800 提交为 e5bb904**"fix(知识库): 加固修订对象身份并提升模型输出上限"（git show --stat 实测：16 路径 = **14 个源码/测试文件** + 2 个 agent-outputs 报告文件，14 与派发快照吻合）；
  - 本轮首查 git status 在提交后约 30 秒（~15:59:50 PST），tracked 区因此显示 clean——原句"工作树实测 clean"仅反映该瞬间、未对照派发快照，属**记录不全**，特此纠正为上列真实现场；
  - 当前（16:04 PST 复核）git status 仅 1 条未跟踪项：`agent-outputs/workflow/plugin-install-fix/`（本报告自身目录）；无 stash、无已修改跟踪文件；agent-outputs/ 未被 .gitignore 覆盖（.gitignore:61-63 仅忽略 .amagi-reports/、.amagi-worktrees/、amagi-task/）；
  - amagi-pi 仓库工作树仍有用户 WIP（含未提交版本 bump 2.21.36），全程只读。
- npm view 为只读 registry 元数据查询。

## 七、待核验项

1. `amagi-pi` 是否计划发布公共 npm（决定 npm 模式何时可用）——仓库内无证据，属上游决策。
2. Electron 生产（打包态）下 statusDto/install 链路未实测（本轮仅源码+开发态数据目录取证；CLAUDE.md 声明 FEISHU_SYNC_HOME 共享）。
3. Windows npm 布局安装链路未实测（routes/kb.ts F13 注释自认）。
4. 升 pin 至 2.21.36 的能力重核矩阵未评估（不在本轮范围）。
5. 通道 A 在本机的端到端刷新（GET /api/agent/plugins）未实跑——前置条件（pi 1.4.0 + package-manager.js）实测健康，但未启动应用验证运行时行为。
6. 修复轮方案（默认 404 处置、分栏、layout 透出）的取舍与验收由实现轮定；本报告仅提供落点与约束证据。
