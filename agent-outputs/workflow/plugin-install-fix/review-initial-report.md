# 插件检测/安装修复集成审核

VERDICT: FIX

范围内发现 **1 Major、2 Minor**。默认安装 404、全局/私有版本混淆与 `.bin` 定位错误已修复；临时获取根的实体包含校验仍可被 symlink 绕过。结论仅针对本批修复，不重开已接受的 build-runtime-v2 整仓审核。

## 基线与输入

- 主树 HEAD：`e5bb904a8c9279323e880f7bd7f230c00594fb46`；审核当前未提交批次（15 源码/测试文件，以及 patch 内两份报告）。`git diff --check e5bb904` exit 0。
- 已完整读取 `/tmp/plugin-install-fix.patch`（2856 行，分段读取），并沿当前主树读取安装、发现、状态、路由、UI 和通用插件消费者。
- 上游：本目录 `research-report.md`、`implementation-report.md`、`browser-acceptance.md`、`native-probe-report-extload.md`。实施报告部分仍写 worktree 现场，实际审核以主树代码和本轮执行结果为准。
- 原生契约：本机 Pi 1.4.0 的 `docs/packages.md`、`docs/cli.md`；`dist/core/package-manager.js`、`settings-manager.js`、`dist/config.js` 的相关实现。没有读取 auth、模型凭据或输出完整用户配置。

## Findings（一次列全）

### F01｜Major｜获取根只做词法包含校验，实际包根可在临时容器外

- **定位**：`server/src/agent/build-runtime/amagi-package.ts:678-683`；后续 `installAmagiFromGit:745-755` / `installFromSource:469-472`。
- **触发条件**：正式 Pi Git install 完成后，SDK 解析出的获取路径本身或其祖先为指向临时获取根外的 symlink。实体仍有正确官方 HEAD 和 2.21.31 manifest。
- **实际影响**：`path.resolve` 不解析链接，词法检查通过；HEAD/manifest 检查也通过。后续 source 物化把根外内容复制并记录为默认 Git 获取结果，违背任务明确要求的“实体必须真在临时 root”。冻结函数只遍历根的子项，根自身为 symlink 并不会被现有子项 symlink 拒绝逻辑发现。
- **已复现**：使用真实 Pi CLI 从官方固定 commit 获取，真实 SDK list 解析；在 CLI 完成日志回调处仅做临时文件系统负例置换（把刚取得的仓库移到另一个本轮临时目录，再在原位建立 symlink；没有替换 CLI/SDK、伪造 HEAD 或修改生产插件）。`acquireAmagiFromGit` 仍成功，日志 `realInside:false`；继续调用实际 source 冻结链得到 `fresh:true, verified:true`。
- **证据**：`review-evidence/probe.mts`，`review-evidence/probe-complete.log` 的 `ACQUISITION_CONTAINER` / `OUTSIDE_MATERIALIZED`。实际目标为 `/private/tmp/plugin-install-fix-review-33MMxA/outside-acquisition`，不在 `.acquire-45764-40e91e` 内。
- **严重度边界**：这是明确获取来源门控的可复现违背，不宣称正常官方安装必然遇到此状态，也不宣称获得了无需前置条件的远程攻击。负例模拟安装副作用/同 uid 外部置换后的结果；文件围栏本就不是同 uid OS 沙箱，但已承诺的结果包含校验仍应拒绝它。
- **最小修复方向**：对获取根、`git` 容器和包实体做 realpath 归一，检查实际路径的严格包含关系；布局首段应精确等于 `git`，而非 `startsWith('git')`。在进入物化前保持同一解析依据并 fail-closed。正式回归测试交实施者补齐。
- **归因**：本批新增获取链引入。

### F02｜Minor｜合法的 `PI_CODING_AGENT_DIR=~/.pi/agent` 被当成工作目录下的字面路径

- **定位**：`server/src/agent/build-runtime/amagi-discovery.ts:60-63`。
- **触发条件**：用户按 Pi 支持的语义把环境覆盖值设为含 `~` 的字符串（例如 shell 中 `export PI_CODING_AGENT_DIR='~/.pi/agent'`）。
- **实际影响**：原生 `getAgentDir()` 展开 home；新发现函数却返回 `<cwd>/~/.pi/agent`。该错误路径不存在时扫描返回 `ok` 空候选，真实已登记的全局 amagi 不显示，且不提示检测失败。不会错误启用全局包，但本批检测修复在该合法配置下失效。
- **已复现**：临时 HOME 内登记真实本地 manifest=2.21.36 候选，真实 Pi SDK 对官方解析路径检出 1 项；应用路径检出 0 项、status=ok。未修改用户全局配置。
- **证据**：同一脚本/最终日志的 `TILDE_HOME`、`TILDE_SCAN`；Pi `dist/config.js:478-495` 明确经 `expandTildePath` 解析环境覆盖。
- **最小修复方向**：复用或准确实现原生 home 规范化语义（含 tilde），再作必要的绝对化；补该覆盖值的正式测试。
- **归因**：本批新增发现函数引入。

### F03｜Minor｜安装前挂起的 GET 可以清掉安装后的新错误

- **定位**：`src/components/settings/BuildOrchestrationSettings.tsx:328-350,811,828-844`。
- **触发条件**：挂载/刷新 GET A 挂起 → 用户安装很快失败（如坏路径 400）→ 显示新安装错误 → GET A 后到。
- **实际影响**：安装失败不触发新 GET，A 仍是最新 GET，序号守卫不会拒绝它；`status` 更新触发第 811 行 effect，无条件清除刚产生的安装错误，用户丢失失败原因。不会因此变成 fullyVerified，但诊断可见性退化。
- **证据类型**：静态调用链确认，未做浏览器时序复现。详见 `review-evidence/ui-race-trace.md`。现有 latest-request-wins 测试只覆盖成功安装产生第二个 GET，不能覆盖此负例。
- **最小修复方向**：清错限定在用户显式刷新、新安装动作和安装成功上；或引入跨 GET/安装的操作代次，避免安装前的 GET 清除安装后的错误。
- **归因**：本批新增 `[status]` 清错 effect 引入。

## 覆盖清单与原行为判定

| 直接影响边界 | 核验与判定 |
|---|---|
| 默认正式 Git / pin / 不 fallback npm/latest | 独立真实安装通过：2.21.31、完整 commit `929000ecbd8725e72b191493345d6abeef51c147`；重复 fresh=false、hash 一致。原 404 默认入口已修复。 |
| SDK list 只读、resources 兼容 | 读实际 SDK：list 调用只解析清单，不调用 resolve/工厂。真实缺失 npm/git 声明扫描后仅原 settings 文件，SHA 不变；坏 settings 显式错误；不存在 home 不创建。通用 PiPluginService 真实原生测试通过，助手缺省 resolve 分支保持旧行为。SDK 内部读 settings 会短暂取锁，未将“SHA 不变”扩大成“零文件系统调用”。 |
| 三项来源校验 | HEAD 是实际 `git rev-parse HEAD`，manifest name/version 实际核对；错误 HEAD/版本拒绝由针对性测试覆盖。容器校验未达标，见 F01。 |
| 全局 36 与私有 31 | 代码只收集候选 manifest，不加载/启用/默认采用候选；私有安装事实独立于 runtime 解析失败。全局 settings 本轮探针前后 SHA 一致。合法 tilde override 仍有 F02。 |
| source / verify / 409 / 清理 | 显式源保持原兼容语义、版本/hash 门未放松；已装走完整 verify，不假重装。相关测试覆盖漂移拒绝、版本拒绝、获取失败/清理、SDK 实体缺失、busy 409、状态独立；本轮另实际篡改临时包字节，返回 amagi_content_drift。 |
| 依赖与 `.bin` | 独立真实默认冻结包移至含空格、引号、反引号、`$HOME` 的新路径，真实 `typescript-language-server --version` 输出 6.0.0。另以合成本地包和真实 CLI 验证**相对目标名自身**含上述字符：目标原位置正确、参数字节保全；包外目标返回 amagi_symlink_in_source。没有 symlink 留在冻结结果、无 acquire 路径写入 launcher。原字节拷贝定位错误已修复。 |
| UI/DTO/错误折叠 | 36 项现有前端测试全部通过；目录选择成功/取消/无 bridge 手填、分栏、错误折叠、成功后刷新、GET-vs-GET 旧响应拒绝已覆盖。安装事实与 fullyVerified 分离不变。失败时序残留 F03。 |
| 权限/兼容/性能 | 无新增 shell 工具面、pin 升级、依赖清单或 DB 迁移；CLI execFile 参数化。发现每次启动两个受限 SDK 子进程，未做额外性能基准；本轮真实默认安装约数秒，无性能故障证据。 |

## 独立执行证据

工作目录均为主树；命令退出状态为工具实际返回值。

| 验证 | 结果 |
|---|---|
| server：`npx vitest run tests/build-runtime-package.test.ts tests/build-runtime-amagi-git.test.ts tests/build-runtime-amagi-discovery.test.ts tests/build-runtime-route.test.ts tests/build-runtime-amagi-live.test.ts tests/pi-plugin-service.test.ts` | exit 0；6 文件、53 用例通过，真实 Git live 非 skip（7.7s）。日志 `review-evidence/targeted-server.log`。 |
| 根：`npx vitest run src/components/settings/BuildOrchestrationSettings.test.tsx` | exit 0；36 用例通过。React act 环境警告保留在 `review-evidence/targeted-ui.log`，不冒充浏览器交互证据。 |
| 根：`node node_modules/tsx/dist/cli.mjs agent-outputs/workflow/plugin-install-fix/review-evidence/probe.mts` | 最终 exit 0；真实 CLI/SDK + 临时目录负例，见 `probe-complete.log`。最初临时 HOME 导致 Git 无认证失败，原始 `probe.log` 保留；之后保留正常 Git 环境、只隔离 Pi home/dataRoot，未读取 auth 文件或复制凭据。 |
| 主树全量日志抽核 | `/tmp/plugin-install-fix-check.log` 已出现最终摘要：lint 0 error/3 warnings；typecheck 三段；前端 77 文件/528 pass；server 198 pass/2 skipped、3113 pass/16 skipped。非“仍在跑”时提前签绿。 |
| 构建日志抽核 | `/tmp/plugin-install-fix-build.log` 已含 Vite 完成和 server tsc/assets 最后 CLI bundle 输出；chunk 大小 warning 保留。本轮未重新运行构建，也未独立取得后台 shell 的退出状态，故只确认这些已落盘完成输出。摘要存 `review-evidence/integration-summary.log`。 |

早期取证脚本的两个断言问题已纠正并保留原日志：`probe-r2.log` 的 target URL 比较漏掉 macOS `/tmp` realpath 归一；其“outside”链接其实仍指向 source 根内文件。两者都不算产品缺陷，最终 `probe-complete.log` 使用正确对照。没有以失败探针的文字标签制造 finding。

## 证据可信度、盲区与剩余风险

- **强证据**：当前代码 + 本轮真实 Git/CLI/SDK、哈希、移动后 bin 执行、临时恶意路径和包含关系负例。既有单测含 SDK/CLI 桩，仅用于其声明的分支覆盖，不当真实安装证据。
- **上游证据而非独立重跑**：浏览器安装/校验/错误折叠、全局36与私有31分栏，引用 `browser-acceptance.md`；真实 native probe 的 amagi_resource=true 与 36/0，引用 `native-probe-report-extload.md`。未把本地 fixture 模型当远程模型质量/性能；其“退出未确认”备注也不能用作清理已确认的证据。
- 本轮没有亲自进行浏览器/Electron交互或截图视觉审核；前端结论限静态路径、既有交互单测和明确标识的上游交互报告。Windows `.cmd/.ps1` 真机未测，不声称跨平台全绿。
- 显式手填 source 沿旧策略不拷 node_modules；本轮未擅自把它升级成默认 Git 依赖物化语义。上游已确认的 TypeScript omit=dev 行为不重开为本批 finding。
- 不审重新加载插件工厂的全仓运行权限体系，不穷举历史 findings；未触生产模型、KB正文、配置、用户插件或未知 PID。
- 写入仅本报告与 `review-evidence/`；临时探针目录保留在 `/tmp/plugin-install-fix-review-*` 供复核，无未知进程终止。回滚审核产物只需由 Leader 删除本报告/本轮 evidence 和确认归属的临时目录；本轮无源码 patch 可回滚。

**建议下一步**：回派实施者处理 F01，并一并修正 F02/F03；正式回归测试由实施者落地。无需重跑历史整仓审核，复核上述直接修复路径即可。
