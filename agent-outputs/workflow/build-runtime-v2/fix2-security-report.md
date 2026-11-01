# fix2-security：F12-R1 修复——真实 child 祖先递归 grep 跨 deny 泄漏 sentinel（含二段根约束与 Leader 边界①②收口）

状态：**已完成**（含 Leader 审 diff 两处边界收口；实现 + 正负/并发/真实消费链验证闭环）。基线 = 主树 dirty-snapshot（a776971 = 25cc0b4 + 统一修复 + 用户 WIP），未复用旧 worktree 代码、未采纳 046 queued 放宽补丁、未改 amagi 上游、未动 adapter、未改 pin。

## 〇、结论速览

**一段（递归工具面收窄）**：`child-policy` 禁用名单 `codemode/tool_search` → `+grep/find/ls`（面过滤 + 调用阻断同一份名单）。构建子任务工具面整体移除递归/目录工具；检索改走 mcp_call 桥受控工具（raw_search/draft_search/raw_list/manifest）。

**二段（steer 补做：child native 根约束）**：上游 deny 是黑名单，不阻 `/proc/self/environ` 等未枚举路径；裁决「知识仅经 MCP，native read 无需任意外部文件」——
- **read 白名单** = 冻结信封根：skill 同目录协议（`dirname(spec.workflowSkillPath)`）+ 任务工作区（`dirs.workDir`）；
- **write/edit 白名单** = 仅报告根（`workDir/agent-outputs`，与 `freezeGuardConfig` 默认 reportRoot 同源——上游 ev-20260919 已把 write 授予面执法退役为声明性，本层补执法）；
- 元数据经 `PI_BUILD_CHILD_ROOTS_JSON` 注入（`environment.ts buildLeaderEnv`，数据源=冻结 spec+dirs；PI_\* 前缀经 amagi `buildMinimalEnv` 全量透传子任务）；**缺元数据/非法 → read/write/edit 全部 fail-closed 阻断**；
- 词法与 symlink 真实落点双判（见下「Leader 边界①」的最近既存祖先解析）；白名单根**双形态归一**（词法+realpath——macOS `/var→/private/var` 前缀下正例不误拒，symlink 别名指向白名单外仍拒）；
- **路径语义 = node:path 宿主/标准库**（见下「Leader 边界②」：动态 import builtin，Windows 盘符/UNC/分隔符由平台标准库处理，不手写 POSIX 解析）；
- 报告 read/write/edit 正例与 skill 读取保留；递归 5 名过滤保持；shell deny/codemode/tool_search/续传阻断保持。

### Leader 边界①（落点解析）：最近既存祖先 + fail-closed 分级

旧实现 `realpathOf(target)` 遇任意错误返回 null 后放行——父目录 symlink→外部时目标 new.md 不存在，realpath ENOENT 放行，底层 write 经父 symlink 新建到外部（写入面泄漏）；dangling leaf 同理。修复：`resolveRealLanding` 逐级向上找**最近既存条目**（lstatSync 判存在——dangling symlink 算既存），realpathSync 该条目得真实前缀后**重拼剩余未存在段**作为落点判定：
- 普通未建文件/新目录：最近既存 = 真实目录，落点可证 → 正常放行（嵌套首次 write 正例）；
- 父 symlink→外部：最近既存 = symlink 目录，realpath=外部 → 重拼后白名单外 → 拒；
- dangling leaf/parent：既存但 realpath 失败（目标不存在）→ **fail-closed 拒**（理由含错误码）；
- EACCES/其它 fs 异常（非 ENOENT/ENOTDIR）：lstat 即 fail-closed，不把所有异常等同未建文件。

### Leader 边界②（路径语义）：node:path 标准库取代手写 POSIX

旧 normAbs/okList 手写 `startsWith('/')+split('/')`：Windows 盘符/UNC 必败（重引 F13 已关的代码级回归），且 `includes('..')` 误禁合法目录名（如 `a..b`）。修复：动态 `import('node:path')` 取宿主默认——`resolve`（~展开+相对锚 AMAGI_PERMISSION_CWD+./.. 归一）、`relative`+`isAbsolute`+`sep` 做白名单判定（跨盘符/跨 UNC=不同根；`rel.split(sep)[0]==='..'` 精确父级逃逸，不误伤 `a..b`）；okList 用 `path.isAbsolute`。`PI_BUILD_CHILD_PATH_FLAVOR` 仅为单测在非 Windows 宿主覆盖 win32/posix 词法的接缝（生产无此 env，恒宿主语义）。真实 Windows 整链仍标未实测；词法层盘符/UNC/相对/父级逃逸正反例已测（见 §四）。

## 一、一段：根因与修复机理（要点）

- 上游 amagi-pi 2.21.31 `guards.ts` 只校验搜索根、`checkRead` 只判请求路径本身；`task-permission.ts deriveTools:414` 从 read 无条件派生 grep/find 进 `--tools`。祖先目录搜索根合法放行 → 递归读出 deny 子树内容（增量复审 recursive-sentinel-probe 真实复现）。
- 应用侧唯一自有执法点 = child-policy 面过滤 + 调用阻断；机制（内容寻址物化→settings 绑定→agentDirConfigHash→integrity refs→启动/每次派发核验 fail-closed）不变，改名单即全链自动跟随。
- `ls` 防御纵深（当前不经 amagi 授权）；powershell 未列入（需 shell 通道且从不进授权面）。真实 SDK 工具名核验：pi 1.4.0 `ToolName = read|bash|powershell|edit|write|grep|find|ls`，无别名机制；八锚点对重激活面独立清回（单测逐锚点验证）。

## 二、二段：实现与接口

| 改动 | 内容 |
|---|---|
| `environment.ts` | `BUILD_CHILD_ROOTS_ENV = 'PI_BUILD_CHILD_ROOTS_JSON'`；`buildLeaderEnv` 注入 `{readRoots:[skillDir, workDir], writeRoots:[workDir/agent-outputs]}`（数据源 = `spec.workflowSkillPath` + `dirs.workDir`，均在冻结链内；写入面与 freezeGuardConfig 默认 reportRoot 同源）。`envAuditIssues` 不误伤（非凭据名）。 |
| `child-policy.ts`（渲染源码） | tool_call 钩子（async）对 read/write/edit 做根复核：`normAbs` POSIX 归一（~/展开、相对锚 `AMAGI_PERMISSION_CWD`、./.. 消解）→ 词法白名单判 → `realpathSync` 落点白名单判；根列表解析时双形态归一（词法+realpath）。缺 env/非法 → fail-closed 全阻断。动态 `await import('node:fs')` 仅做 realpath 元数据解析，不读内容；无静态 import/require（语法断言保持）。 |

**最小接口说明（供 Runtime 知悉，非阻塞）**：reportRoot 当前恒为 freezeGuardConfig 默认值 `'agent-outputs'`（adapter 从不传自定义值），policy 与 buildLeaderEnv 与之同源硬编码；若未来 `FrozenDispatchConfig.reportRoot` 可自定义，需同步 `environment.ts` 与 `child-policy.ts` 两处（或经 env 下发），属最小接口变更。

**Windows**：盘符路径不匹配 POSIX 白名单 → fail-closed 拒（平台未测，从严）。

## 三、正式反例与正例（真实 native probe，两轮全绿）

环境（steer 指定冻结源）：`/tmp/feishu-build-v2-r2/amagi-pi-2.21.31`（与原受信缓存同 hash 9485dd95…，3545 文件）；pi 1.4.0 **bin 入口** `dist/bundle/cli.js`（见 §五根因）；临时 HOME/FEISHU_SYNC_HOME/TMPDIR；fixture 模型（非真实模型质量证据）。

**W1 真实 child 会话 23 步反例/正例序列 + resume 续轮**，`p0-sentinel-deny` PASS 全文：

> read 禁区（deny+根约束）=拒；grep 禁区根=拒；grep 祖先目录（主反例）=拒；grep 相对路径=拒；grep symlink 别名=拒；find 祖先目录=拒；ls 祖先目录=拒；read 合成外部文件（绝对）=拒；（相对）=拒；（symlink 别名）=拒；read skill 正文（白名单正例）=过；read 工作区文件（白名单正例）=过；write 越报告根（工作区根）=拒；**write 经父 symlink 新建到外部（Leader 边界①）=拒；write dangling leaf（fail-closed 落点不可证）=拒；edit 经 symlink 指向外部既有文件=拒；write 报告根嵌套新建（落点正例）=过**；task_resume 续轮 grep 祖先=拒、read 外部相对=拒；敏感内容泄漏（sentinel+合成外部，首/续轮全量）=false；**外部目录未产生新文件/未篡改=true；报告嵌套新建落盘=true**

强断言（不弱化）：每个反例必须有明确拒绝证据（child-policy 理由/工具不存在/not in active tool set 类文案），空文本或静默成功判 fail；正例必须读到实际内容标记或落盘事实；W1+resume 全量消息零 `SENTINEL-SECRET` 与零 `SYNTHETIC-OUTSIDE-PROBE`（合成外部文件，不读真凭据）。**落点反例另有磁盘物理断言**：外部目录条目恒定（new.md/never-exists.md 未产生）、外部既有 edit-target.md 内容未改、报告嵌套新建真实落盘——拒绝理由之外补「未发生写入副作用」的磁盘事实。工具面断言：全部子任务请求（首/续轮/resume 会话）零 5 禁名。

**正例不丢**（同轮 PASS）：mcp-precise-authz（只读 200/分配内写入 200/未分配 409/审查越权拒/续接写入 200）、write-surface（配置面写拒/报告写成功）、child-tools-surface（read/write/mcp_call/mcp_list_tools/amagi_resource 保留）、role-skill-load、guard-freeze-scope（shell=deny、deny 含原始库/配置面）、leader-tools-whitelist、identity-uplink、codemode-facet、cancel-no-residue、resume-parent-chain、completion-self-round。

**执行记录**（cwd=worktree 根）：

| 轮次 | 结果 | 报告 |
|---|---|---|
| 一段修复后（演进 2.21.32 源 + dist/cli.js） | 36 pass/0 fail；35 pass/0 fail | `/tmp/fix2-probe/fix2-probe-report*.md`（**兼容探索记录，非正式交付证据**——环境不符 steer 冻结要求，且 bin 入口未用） |
| 二段修复后（冻结 2.21.31 + bin 入口） | 35 pass / 0 fail ×2（含 symlink 前缀修复后复跑） | `/tmp/fix2-probe-r3/probe-report-final.md` |
| **Leader 边界①②收口后（正式终版）** | **36 pass / 0 fail，EXIT=0** | `/tmp/fix2-probe-r4/report-final.md`（证据 `live-probe-evidence.json`、`run-final.log`） |

## 四、测试矩阵（冻结 2.21.31 环境）

| 验证 | 结果 |
|---|---|
| child-policy 单测+配置层 | **38/38**（含新增：根约束 fail-closed、白名单正反例、symlink 前缀回归、**Leader 边界①落点解析专项**〔父 symlink 新建拒+外部未产生/dangling leaf·parent fail-closed/edit 经 symlink 不改外部/嵌套新建放行/既有文件正例〕、**Leader 边界②win32 词法专项**〔跨盘符·白名单外盘符·UNC 外部·相对/绝对父级逃逸全拒；UNC 同 share·盘符白名单内·`a..b` 合法目录名·write 报告根内均词法放行——非 Windows 宿主下进入落点 fail-closed，真实 Windows 落点链未实测〕） |
| child-policy live（真实 pi 1.4.0 bin 入口 + amagi 2.21.31 子进程） | **38/38 全部通过**：对照组缺口复现；实验组：面零 5 禁名 + read outside 三形态拒 + read skill/workFile 正例 + write outside 拒（未落盘）+ **write 父 symlink 新建拒且外部目录零新增 + dangling leaf 拒 + edit 经 symlink 外部未改 + 报告嵌套新建真实落盘** + 报告写正例 + 零泄漏；「续传与直连」：toolcall_continue 不能续接被禁工具、直连 mcp__ 不可绕过、授权 mcp_call 正常 |
| integrity（fail-closed 链，含 live） | 25/25（新 policy hash 全链跟随） |
| e2e 主链 + fix-e2e（pinned 2.21.31 = 冻结源匹配，install 真实安装） | **9/9**：published 主链、F10 硬 SIGKILL 对账、F09 续接/重建 |
| environment/agent-dir-config/dispatch-guard（含 environment roots 注入同源断言） | 92 pass |
| server tsc / eslint（改动文件） | EXIT=0 / 0 errors |

### e2e 发现并修复的真实缺陷（如实记录）

首轮 e2e 主链卡 running：writer 子任务 read skill 被**误拒**——macOS `/var → /private/var` symlink 前缀下，目标 realpath 落点与词法注入根前缀不一致，落点判失败（词法过、落点拒）。修复 = 白名单根双形态归一（词法+realpath 都认；symlink 别名指向白名单外仍拒——落点不在任何形态根内）。新增专项单测（os.tmpdir 原始形态路径）+ e2e 9/9 + native probe 复跑全绿闭环。这证明根约束在真实生产链（非 fixture 单测）被实际执行且误拒可被发现——不是只有反例绿。

## 五、toolcall_continue 断言基线（steer 要求恢复，已恢复）

- **根因（新发现，测试基建层）**：此前测试/probe 以 `dist/cli.js` 启动 pi；amagi 2.21.31 `detectRunningHostVersion` 要求 argv[1] realpath 与包 `bin`（`dist/bundle/cli.js`）一致才认宿主版本，否则版本未知 → `capabilityEnabledByVersion` fail-closed → length-continuation 不注册。**与 amagi 版本无关**（2.21.31/2.21.32 同行为）。
- 修正：正式 live/native/e2e 一律用 **bin 入口** `dist/bundle/cli.js`；`toolcall_continue` 恢复为 live 实验组首面必需断言（**已验证通过**——受支持 2.21.31 + bin 入口下注册且在面）。不因任何「当前不支持」降低旧必需断言；policy 面本身不禁它（续传机制保留），「续传不能绕过禁面」由专用用例独立验证（截断→续传被拒，通过）。
- 此前在演进中 2.21.32 工作树 + 非 bin 入口下「toolcall_continue 未注册」的观测**仅作兼容探索记录**，不作为正式交付证据，也不作为降断言依据。

## 六、未测边界（不冒充通过）

- **Windows**：整链未实测（无机）；词法层盘符/UNC/相对/父级逃逸正反例已按 node:path win32 语义单测覆盖（PI_BUILD_CHILD_PATH_FLAVOR 测试接缝），真实 Windows 上 resolve/relative/lstat/realpath 的宿主行为与子任务环境注入链未验证。
- **Linux `/proc/self/environ` 等真实系统路径**：未在真 Linux 实测（本机 macOS）；等价语义由合成 outside 文件（绝对/相对/symlink 别名三形态）覆盖——白名单外任意路径一律拒。
- **真实模型质量/性能**：全部 fixture 模型驱动真实链路，不构成 LLM 质量证据。
- **read 图片附件**：read 图片走附件通道，目标仍在白名单内才放行；图片内容语义未专项测试（上游图片三态守卫保留）。
- **amagi 后续版本**：若上游修复递归根-only 缺口，工具面收窄可由 Leader 决策是否放宽（名单纯数据）；根约束与递归收窄相互独立。
- **PI_BUILD_CHILD_ROOTS_JSON 信任面**：值由应用 buildLeaderEnv 构造（Leader env 由应用控制，无模型注入面；amagi PI_\* 透传不改值）；policy 不校验其与磁盘再一致性（元数据与信封同源由 environment 单测锁定）。

## 七、改动清单与回滚

| 文件 | 改动 |
|---|---|
| `server/src/agent/build-runtime/child-policy.ts` | 禁用名单 +3；F12-R1 一段+二段+边界①②注释；阻断理由文案；read/write/edit 根复核（node:path 宿主语义 resolve/relative/isAbsolute、最近既存祖先落点解析 fail-closed 分级、双形态根归一） |
| `server/src/agent/build-runtime/environment.ts` | `BUILD_CHILD_ROOTS_ENV` 注入冻结信封根（readRoots/writeRoots 与 spec/dirs 同源） |
| `server/tests/build-runtime-child-policy.test.ts` | 名单/面过滤/重激活断言；根约束与落点解析专项用例（fail-closed/正反例/symlink 前缀/父 symlink·dangling·嵌套新建/win32 词法）；live 对照+实验组扩展；toolcall_continue 必需断言恢复（bin 入口） |
| `server/tests/build-runtime-environment.test.ts` | roots 注入同源断言 + 审计不误伤 |
| `server/tests/fixtures/build-runtime/probe-support.ts` | ancestorDir/aliasDir/outsideFile fixture |
| `server/scripts/probe-build-runtime.ts` | W1 19 步反例/正例序列 + resume 反例 + 强断言重写 + workDir 预置（epoch 对齐 adapter） |

未动：adapter.ts、dispatch-guard.ts、runtime-integrity.ts、contracts、amagi 上游、amagi.json、用户 12+2 WIP；未提交。回滚：git checkout 还原 6 文件（无数据迁移/配置变更）。

**接口变化**：无 HTTP/DTO/信封结构变化。新 env `PI_BUILD_CHILD_ROOTS_JSON`（应用内部契约，child-policy 消费）。对外可观察变化 = 子任务模型工具面收窄（grep/find/ls 消失）+ native 文件工具限定信封根（阻断理由含替代指引）。前端/CLI/Runtime 无需适配；reportRoot 自定义化需 §二所述两处同步（最小接口）。

**2.21.32 兼容探索记录（非正式证据）**：一段修复曾在演进中 2.21.32 工作树（非冻结副本）+ `dist/cli.js` 入口下全绿（36/35 pass），证明收窄机制对 2.21.32 兼容；因环境不符冻结要求（且 bin 入口未用、toolcall_continue 未注册），该轮结果仅作兼容性参考，正式交付证据以 §三/§四 冻结 2.21.31 轮次为准。
