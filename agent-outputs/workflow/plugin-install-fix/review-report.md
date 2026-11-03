# 插件安装修复：F01–F03 增量复核

VERDICT: PASS

原 F01（Major）、F02/F03（Minor）均已关闭；本轮修复的直接影响路径未发现新增实质回归。本结论限原插件检测/安装批次及这三个修复，不构成 build-runtime-v2 整仓或桌面发布 Gate。

## 范围与基线

- Git 基线仍为 `e5bb904a8c9279323e880f7bd7f230c00594fb46`，审核主树当前未提交产物。
- 增量输入：`review-fixes.md`；三个源文件 `amagi-package.ts`、`amagi-discovery.ts`、`BuildOrchestrationSettings.tsx`，及对应三份测试的修订。原审核未变部分沿用，不重新穷举历史 findings。
- 上轮完整报告：`review-initial-report.md`。覆写主报告前已核对二者 SHA256 完全一致：`c6ae08b2581920f544cb74cbef0b17ef0c5c0eb96258c1291a9780f0e5aab77e`。原证据未覆盖；本轮新增证据均以 `r2-` 命名。
- 上游引用：本目录 `review-fixes.md`、`review-initial-report.md`、`implementation-report.md`、`browser-acceptance.md`、`native-probe-report-extload.md`。

## 原编号逐项结论

### F01｜原 Major｜已关闭

**定位**：`server/src/agent/build-runtime/amagi-package.ts:678-717`。

核对修复：获取根自身用 lstat 拒绝 symlink；获取根、git 容器和 SDK 路径分别 realpath 归一；git 容器相对获取根必须精确等于 `git`，包实体必须严格位于真实 git 容器内；返回 canonical 包实体。等待真实 `git rev-parse HEAD` 后，再从同一 SDK 路径复核包含关系和实体路径一致性。

**独立真实反例复跑**：保留上轮方式——正式 Pi CLI 从官方固定 commit 安装，CLI 完成后、SDK 检测前，在日志回调处仅对本轮临时文件系统做负例置换；不替换 CLI/SDK，不伪造 HEAD/manifest。分别把 package、git 容器、获取根移到容器外并原位建立链接。三者均返回 `amagi_acquisition_incomplete`，且最终 `install-record.json` 均不存在。原“根外实体成功获取并冻结”的反例不再成立。

正式测试另覆盖 `git-extra` 相近前缀拒绝。针对这种 SDK 假清单分支，实施者测试使用了明确标识的 SDK 桩；本轮三个 symlink 反例则确实使用真实 CLI/SDK。

**正例与回归**：实际正常默认 Git 安装成功，commit=`929000ecbd8725e72b191493345d6abeef51c147`、version=2.21.31；记录返回 `/private/tmp/...` canonical 获取路径，兼容本机 `/tmp` 别名。重复安装 fresh=false 且完整 hash 一致。随后把冻结目录移至含空格、引号、反引号、`$HOME` 的位置，非 symlink `.bin/typescript-language-server --version` 仍输出 `6.0.0`，launcher 不含 `.acquire-` 路径。

证据：`review-evidence/r2-probe.mts`、`r2-probe.log` 的 `REAL_SYMLINK_REJECT`、`DEFAULT_REPEAT_MOVED_BIN_PASS`；`r2-server.log`。

边界：这关闭的是实际容器包含检查缺口，不把再次核验描述为抵御所有同 uid 任意时间文件替换的 OS 沙箱。

### F02｜原 Minor｜已关闭

**定位**：`server/src/agent/build-runtime/amagi-discovery.ts:60-67`。

核对修复：覆盖值 `~` 和 `~/...` 展开为实际 home；Windows 分支支持 `~\\...`，之后按宿主路径规则绝对化。

**独立复跑**：在临时 HOME 内登记本地 manifest=2.21.36 的候选；环境覆盖为字面的 `~/.pi/agent`。原生 Pi `getAgentDir()` 与应用解析结果相等，真实 SDK 扫描检出 1 项，版本=2.21.36、matchesPin=false。与私有固定31仍不混用。正式 tilde 断言也通过。

证据：`r2-probe.log` 的 `TILDE_REAL_SDK_PASS`；`r2-server.log`。Windows 分支仅静态检查，本轮没有 Windows 真机验证。

### F03｜原 Minor｜已关闭

**定位**：`src/components/settings/BuildOrchestrationSettings.tsx:810-842`；对应测试文件新增“安装前挂起GET不能清掉其后新安装错误，显式刷新才清错”。

核对修复：删除任意 status 更新就清空安装错误的 effect；清错留在新安装动作和显式刷新动作。安装成功前也经过新安装清错，因此成功链不遗留旧错误；既有 GET latest-request-wins 序号保护不变。

**独立执行实施者新增正式测试**：挂起旧 GET → 安装失败 → 显示本轮错误 → 旧 GET 后到 → 错误仍保留 → 显式刷新 → 错误清除，断言均通过。原“安装成功、新 GET 先到、旧 GET 后到不覆盖已装状态”测试继续通过。

证据：`review-evidence/r2-ui.log`（37 项通过）；已读实际 deferred 时序与组件状态写入链。此项是组件交互测试及静态调用证据，不冒充真实浏览器/Electron复现。

## 本轮独立执行与可信度

| 验证（cwd=主树或其 server 子目录） | 实际结果 |
|---|---|
| `npx vitest run tests/build-runtime-amagi-git.test.ts tests/build-runtime-amagi-discovery.test.ts tests/build-runtime-amagi-live.test.ts`（server） | exit 0；3 文件30项通过；真实官方 Git live 非 skip（7.1s）。`review-evidence/r2-server.log`。 |
| `npx vitest run src/components/settings/BuildOrchestrationSettings.test.tsx`（根） | exit 0；37项通过。React act 环境 warnings 原样保留在 `review-evidence/r2-ui.log`。 |
| `node node_modules/tsx/dist/cli.mjs agent-outputs/workflow/plugin-install-fix/review-evidence/r2-probe.mts`（根） | exit 0，`R2_PROBE_PASS`。真实 CLI/SDK 安装、三种根外置换拒绝、tilde 原生对照、重复 hash、迁移后 bin 均有实际断言。临时根 `/tmp/plugin-install-fix-review-r2-SBN9Od`。 |
| 全局保护 | 独立探针前后用户全局 settings SHA 相同；未读取 auth、复制凭据、加载/改写全局36或触碰生产资料。安装只使用正常 Git 运行环境与临时 Pi home/dataRoot。 |
| `git diff --check e5bb904` | exit 0。本轮未改源码、项目测试或 index。 |

另外抽读 Leader `/tmp/plugin-install-fix-r2-types.log` 和 `...-lint.log`：typecheck 三段输出无错误；lint 为0 error、3个原有 warnings。其 exit0 由上游回执提供，不冒称本轮独立执行。当前源文件相对 HEAD 快照位于 `review-evidence/r2-source-vs-head.patch`（含原批次改动，不是纯本轮增量 patch）。

## 未覆盖与交付边界

- 新一轮全量仍由 Leader 管理，本轮没有等待、重跑或拿待完成日志替代独立验证；此前528/3113及 build 结果保留在初审记录，不冒充本轮全量结果。
- 不重复执行 native probe 的模型/子任务权限全链路，不进行新的远程模型质量或性能验收。未变原生扩展加载证据沿用上游，未改其覆盖边界。
- 没有亲自做本轮浏览器、Electron打包态或Windows真机复测；没有新增视觉结论。
- 未发现与 F01–F03 修复有因果关系的新缺陷；无新增阻断 findings，也不为无关未改代码另开 Gate。
- 本轮写面仅主报告和 `review-evidence/r2-*`；原报告/证据保留，临时目录留供取证。审核产物的回滚仅为按需删除本轮报告/证据及确认归属的临时目录，无源码 patch 可回滚。

结论：F01/F02/F03 全部关闭，原插件修复批次在本轮声明范围内通过增量复核。
