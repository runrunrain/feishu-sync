# plugin-install-fix 实施报告

任务：修复「插件安装检测不准确（全局 36 被报未装、与构建固定 31 混淆）+ 应用内默认安装不可用（已知 npm 404）」并闭环。

> **修订 2（同批小修）**：Leader 真机复测证实默认 Git 安装链成功，但发现新增根因 4（.bin 字节拷贝 shim 破坏 CLI 相对定位）——本批已修并补齐「真实 amagi 扩展加载」证据（见 §四之二）。前次失败如实留档，未就地修改旧冻结 fixture，全部用新临时 root 重测。

## 一、根因（4 条，均有代码/实测锚点）

1. **检测不区分安装域**：`build-runtime-host.statusDto` 只读私有 runtime-packages 的安装记录；用户全局 Pi home（`~/.pi/agent`，实际声明本地 `/Users/run.mao/workpace/amagi-pi` = 2.21.36）与应用插件目录从不在视野内。探测失败时 DTO 还把 `installed` 硬编码为 false——已装事实被探测失败抹掉（谎报）。
2. **默认安装走已知 404 的 npm**：`installAmagi` 无 sourceDir 时缺省 `pi install npm:amagi-pi@2.21.31`（上游注释已实测 404）；capability-probe 的失败提示还指引用户去装这条必败路径。npm:2.21.31 未发布、官方 Git 远端无 tag——正确确定来源只有完整 commit `929000ecbd8725e72b191493345d6abeef51c147`（该 commit manifest=2.21.31；本机 /Users/run.mao/workpace/amagi-pi 的 2.21.36 是用户维护内容，禁止冒认/修改）。
3. **source 冻结链两个缺陷（Leader 真机 UI 复测证实）**：
   - `copyTreeFiltered` 拒绝一切 symlink；pi git install 真实落盘的 `node_modules/.bin/typescript-language-server` 是**包内相对 symlink**，containment 用未归一的包根比较，macOS `/tmp`→`/private/tmp` realpath 差异导致同源判定为「包外」→ `amagi_symlink_in_source` 物化失败（Leader 调整 #6 实测）。
   - 旧 `copyTreeFiltered` 一律排除 `node_modules`；amagi LSP 依赖包内 `node_modules/.bin`（amagi lsp-config `extensionOwnBinDirs`），依赖误丢会让「已装绿灯」但运行资源残缺（调整 #1）。
4. **【修订 2 新增】.bin 字节拷贝 shim 破坏 CLI 相对定位**：首版物化把 symlink 目标**字节**复制进 `.bin`——目标脚本以自身文件位置做相对定位（实测 typescript-language-server 用 findUpSync 找 package.json；ESM `import.meta.url`/CJS `require.main` 同理），拷到 `.bin` 后 `../package.json` 变成 `node_modules/package.json` → ENOENT exit 1（Leader 真机临时冻结包实测 + 本会话 /tmp 复现：`Error: ENOENT: no such file or directory, open '<pkg>/node_modules/package.json'`，exit 1）。可执行位+文件存在不能冒充依赖可用。

## 二、方法级改动（9 改 6 新增）

### server/src/agent/build-runtime/amagi-package.ts（+Git 获取链）
- 常量 `AMAGI_PI_GIT_REPO_URL`/`AMAGI_PI_GIT_COMMIT` + `amagiGitSourceSpec()`（强校验完整 40 位 commit，拒绝 tag/branch/latest）。
- `acquireAmagiFromGit()`：临时获取 home（`runtime-packages/.acquire-<pid>-<hex>`，0700）→ 真实 `pi install git:github.com/runrunrain/amagi-pi@<commit>`（execFile 参数化，无 shell）→ 复用 inspect-packages.mjs **list 只读模式**经正式 SDK 解析真实实体包根 → 三重校验：实体在获取 root 的 `git/` 布局内（resolve 后前缀断言）、`git rev-parse HEAD` === 期望 commit、manifest name=amagi-pi 且 version===pin（全局 36 拒绝，`amagi_version_mismatch`）。失败自清理临时 root（修：初版获取阶段失败会泄漏 .acquire-*，单测抓出后改为内部 try/catch rm+rethrow）。
- `installAmagiFromGit()`：已装 → 完整校验复用（fresh=false）；否则获取 → `installAmagiPackage(sourceDir=实体, includeDependencies:true, acquisition=溯源)` → finally 清理获取 root。默认链**不再出现 npm: 参数**（单测锚定两次 pi 调用=git 获取+local 登记）。
- `copyTreeFiltered`：`includeNodeModules` 模式连带冻结依赖；`node_modules/.bin` 内指向**包内**的 symlink 物化为**稳定转发 launcher shim**（修订 2）：`#!/bin/sh` + `exec "$(dirname "$0")/<相对目标>" "$@"`——exec 目标于其**原包内位置**运行，ESM/CJS 相对语义零漂移；相对目标在源树内两侧 realpath 归一计算（随冻结包移动成立，不残留 .acquire- 绝对路径）；路径经双引号安全转义（空格/引号/反引号/$ 不注入不断链）；指向包外/非文件目标仍拒绝；其余位置 symlink 仍拒绝；Windows npm .bin 为常规 .cmd/.ps1 文件不走本分支。containment 两侧 realpath 归一（根因 3-a 修复）。
- 记录新增 `dependenciesIncluded`、`acquisition{via,gitSource,repoUrl,commit,acquiredAt,acquiredPackageRoot,piInstallArgs}`（真实获取+最终登记双溯源；不含密钥，单测锚定）。
- `buildInstallEnv`：显式 `delete PI_OFFLINE`（安装是显式联网动作，防父环境残留 offline 静默降级）+ 关遥测/版本检查；凭据剔除不变（单测回显 env 断言）。

### server/src/agent/build-runtime/amagi-discovery.ts（新增）
- 只读发现：`scanAmagiHome` 经 inspect-packages.mjs **list 模式**（`listConfiguredPackages` 只读 settings+existsSync，**不调 resolve()**——已核实真实 SDK `resolvePackageSources` 对缺失 npm/git 声明会自动补装，PI_OFFLINE 仅兜底而非依据，调整 #3）；候选按 manifest name=amagi-pi 收录（实体缺失 → packagePath=null 如实保留）；`resolveGlobalPiAgentDir`（官方 `getAgentDir` 语义：`PI_CODING_AGENT_DIR` 覆盖否则 `~/.pi/agent`）+ `resolveAppPiAgentDir`（dataRoot/agent/pi-home）；home 不存在=空候选（绝不创建目录）；settings 损坏 → settingsErrors 透出不吞。

### server/src/agent/pi-extension/inspect-packages.mjs
- 新增第 3 参 `mode='list'`：只输出 `listConfiguredPackages()`+settings 载入错误；缺省/resources 模式行为不变（PiPluginService 无感）。

### server/src/kb/build-runtime-host.ts
- `statusDto` 重构：`installedFact()`（不依赖 Pi 运行时的快速事实）先行，探测失败路径也如实报 installed/installState/version/hash/layout；`discoverAmagi`（全局+应用，SDK 不可用=unavailable 单独表达）；DTO 新增 `installState/installed/installDetail`、`gitSource/commit/repoUrl`、`candidates`、`discoveryIssues`；`layout` 从记录补真值（旧恒 null）。
- `installAmagi`：默认无 sourceDir → `installAmagiFromGit`；显式 sourceDir 语义不变；`installInFlight` 串行门（并发 409 `amagi_install_busy`）。`runtimeFacts`/`probeReport` 补 `piPackageRoot`。

### server/src/routes/kb.ts + capability-probe.ts
- 安装路由响应带 `layout/dependenciesIncluded/acquisition`；错误状态含 409。probe 失败提示改为「设置『构建编排』卡安装：默认官方 Git 固定 commit 获取，或填本地目录」（不再指向 404 npm；对应旧断言按新指引更新，测试意图不变）。

### 前端 src/types/agent.ts + BuildOrchestrationSettings.tsx
- 「构建专用 amagi-pi（固定 2.21.31）」与「检测到的其他 amagi-pi（只读发现，不用于构建）」分栏：全局 36 展示版本/来源/路径 + `≠ 固定版本 2.21.31，不用于构建`；精确匹配 pin 的本地候选给「与固定版本一致」+「用作安装来源」回填。
- 已装 → 按钮「校验固定版本 2.21.31」（完整哈希复用核对，不假装重装）；未装 → 「安装 amagi-pi 2.21.31（官方 Git · 929000e）」+ 来源提示（不回退 npm/latest）。
- `desktop.selectDirectory` 目录挑选（无桥不渲染、手填常在；取消 null 保持原值）；`splitInstallErrorMessage` 长 stderr 折叠（主提示首行 ≤180 字符 + 可展开详情）；刷新点击即清旧错误；`loadRuntime` latest-request-wins 序号（迟到 GET 丢弃，调整 #5）；fullyVerified 语义不动。

## 三、测试（全部真实命令与结果）

| 命令（cwd=worktree） | 结果 |
|---|---|
| `npm run typecheck`（根 src+配置+server 三段） | ✅ 0 错 |
| `npm run lint` | ✅ 0 error（3 个预存 warning：useSyncStatus 等，非本次改动） |
| `npm test`（前端 77 文件） | ✅ 528 passed |
| server 全量（分批 `npx vitest run tests/<a..z>*.test.ts`，共 200 文件） | ✅ 除下述 1 个环境项外全绿 |
| `server: npx vitest run tests/build-runtime-amagi-git.test.ts` | ✅ 14 passed（成功链含 **shim 真实执行 fixture-lsp/6.0.0 + 相对目标断言**/无 npm/凭据/版本拒绝/CLI 失败/SDK 缺失/commit 不符/.bin 外指拒绝/**敌意路径空格·引号·反引号·$ 负对照**/source 直装含依赖同生成 shim/幂等+漂移/409 busy/状态诚实/全局 36 候选） |
| `server: npx vitest run tests/build-runtime-amagi-discovery.test.ts` | ✅ 11 passed（36≠pin/实体缺失/broken settings/unavailable≠未装/只读正控=假 SDK resolve 抛错/官方 home 解析） |
| `server: npx vitest run tests/build-runtime-route.test.ts` | ✅ 7 passed（默认空体=Git 链/sourceDir 校验透传/409/400/503/DTO 直通） |
| `server: npx vitest run tests/build-runtime-amagi-live.test.ts`（**真实网络 Git+正式 Pi**） | ✅ 1 passed（修订 2 后 8.4s，含真实冻结包 `.bin/typescript-language-server --version` → `6.0.0` exit 0） |
| 回归：build-runtime-package/capability-probe/integration/e2e/integrity/adapter/pi-plugin-service/app-plugins | ✅ 全过（probe 提示断言按新指引更新） |

**环境项（非本次改动）**：`tests/protected-workspace.test.ts` R01「server/node_modules → forbidden」在本 worktree 失败（得 `workspace_path_invalid`）：本 worktree 的 `server/node_modules` 是 portable 依赖**符号链接**，workspace 守卫对该路径分类不同；同用例在主树（真实目录）运行通过。与本次 diff（不触 workspace 守卫）无关，已在报告留档。另首次批量跑 a/b/c 出现过 1 例偶发失败，两次重跑全绿（1277 passed），未复现、未改任何断言。

**修订 2 回归口径**（按反馈要求：只跑针对性回归，不全量重跑 200 文件）：`typecheck` ✅、`lint` ✅ 0 error、目标五文件（package/git/discovery/route/live）52+2 用例全过、前端 BuildOrchestrationSettings 36 用例全过（UI 未改动）；真实命令见 §四之二。前次全量结果（修订 1）保留如下不动。

**fixture 取舍**（如实）：单测用假 Pi SDK 桩（实现被消费的 list 契约 + `resolve()` 抛错正控）+ 假 pi CLI + 真实 git 仓库模板（node_modules/.bin symlink 结构按 pi git install 实测落盘）；无 git 环境跳过该文件。真实 SDK/网络/Pi 链由 live 用例覆盖（上表）。

## 四、真实原生安装取证（临时 FEISHU_SYNC_HOME，脚本已清理）

真实 resolver 解析本机 node 24 + pi 1.4.0 → `host.installAmagi({})` 默认链一次成功，**6.7s**：

```
version=2.21.31 fresh=true（重复调用 fresh=false，全量哈希校验通过）
contentHash=9d9ceeb70ff4d4d7…（完整 64 位入记录） hashedFiles=1063 hashedBytes=24879152
layout=source dependenciesIncluded=true
acquisition.commit=929000ecbd8725e72b191493345d6abeef51c147
acquiredPackageRoot=<tmp>/.acquire-*/git/github.com/runrunrain/amagi-pi（获取后已清理，无残留）
statusDto: installed=true installState=installed；
全局候选=[{origin:global-pi-home, /Users/run.mao/workpace/amagi-pi, version 2.21.36, matchesPin:false}]，discoveryIssues=[]
冻结包含 extensions/amagi-core、agents/*.md、node_modules/typescript-language-server、node_modules/.bin/typescript-language-server（真实文件、可执行位保留）
```

### 之四（修订 2）：.bin 转发 shim 与真实 amagi 扩展加载取证

**失败复现（前次字节拷贝方案，如实留档）**：
```
cp <真实冻结包>/node_modules/typescript-language-server/lib/cli.mjs <pkg>/node_modules/.bin/typescript-language-server
$ <pkg>/node_modules/.bin/typescript-language-server --version
Error: ENOENT: no such file or directory, open '<pkg>/node_modules/package.json'   # exit 1
# 对照：原 symlink 位置执行 → 6.0.0 exit 0
```

**修复后真实命令与结果**（全部新临时 root，未动旧 fixture）：
```
# 新冻结（官方 commit 929000e → 2.21.31，hash 10db622488d3，deps=true）：
npx tsx /tmp/amagi-freeze-for-probe.mts → frozen /tmp/amagi-ext-load-evidence/.../amagi-pi@2.21.31/package
$ <frozen>/node_modules/.bin/typescript-language-server --version → 6.0.0（FROZEN_BIN_EXIT=0）
# shim 内容（80 字节常规文件，非 symlink，0755）：
#!/bin/sh
exec "$(dirname "$0")/../typescript-language-server/lib/cli.mjs" "$@"
```

**真实 amagi 扩展加载（已有 Native e2e，最小无远程模型：本地 fixture 模型，零凭据）**：
```
cd server && node ../node_modules/tsx/dist/cli.mjs scripts/probe-build-runtime.ts \
  --piCli $(which pi) \
  --sourceAmagi /tmp/amagi-ext-load-evidence/agent/runtime-packages/amagi-pi@2.21.31/package \
  --report <见下> --timeoutSec 420        → 退出码 0；36 项 pass，0 fail/unavailable
```
关键行（完整报告：`agent-outputs/workflow/plugin-install-fix/native-probe-report-extload.md`）：
- `package-install` pass（installAmagiPackage(source) 以新冻结包为源真实安装）
- `leader-start` pass（真实 Leader RPC 启动，session=build-b_mvyjdyrt_probe01-e1）
- `same-package` pass：**settings 唯一包=安装根一致；子进程工具面含 amagi_resource=true（amagi-core 已随包加载）**
- `leader-system-rules`/`role-skill-load`/`child-tools-surface`/`codemode-facet` 全 pass（冻结规则进系统提示、角色 skill 加载、子任务工具面收窄）

## 五、风险 / 回滚 / 剩余边界

- **回滚**：改动全部在 worktree 未提交（9 改 + amagi-discovery.ts 等 6 新增，`git diff HEAD` 一览）；回滚须先核对本批diff并在用户明确授权后处理；受管包目录若可能被活跃构建使用不可直接删除，应先正常停机确认无使用并备份；全局 Pi home、`~/.feishu-sync`、用户 amagi-pi 仓库零写入。
- **剩余边界（如实）**：
  1. ~~扩展真实加载留 Leader 盲区~~（修订 2 已闭）：native probe 以新冻结包实测 amagi-core 随包加载（amagi_resource=true + leader-start/规则注入全过）；最终 Electron/浏览器交互验证仍归 Leader。
  2. live 用例依赖本机网络/GitHub 可达与真实 Pi 安装；CI 无环境时 skip（不 mock 冒充）。
  3. `typescript`（amagi 声明的 dep，同时也在 devDependencies）被 npm `--omit=dev` 归为 dev 不落盘——pi 官方 git install 固有行为，冻结链如实镜像，无需改上游（反馈已确认）。
  4. 转发 shim 为 POSIX `#!/bin/sh`（Windows npm .bin 本就是常规 .cmd/.ps1 文件不走该分支）；Windows 真机链路整体未实测（沿用 F13 留档）。
  4. protected-workspace R01 为 worktree symlink 环境项（见上），主树通过。
- 上游输入：主树 `agent-outputs/workflow/plugin-install-fix/research-report.md`（只读，按调整 #2 摘取「不改通用插件隔离」边界）；Pi docs packages.md/cli.md 全文与 dist 源码（resolve 自动补装、git install 布局、getAgentDir 语义）均本会话实读。
