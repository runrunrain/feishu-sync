# UI 切片报告：设计 v2 前端配置 / 构建侧栏进度（c7e99841-UI · 增量适配版）

- 执行分支：`amagi/build-v2-ui`（dirty-snapshot worktree，未提交；主上要求每大阶段 Git 提交由 Leader 统一执行）
- 设计依据：`基于Agent基座与工作流插件的构建重构设计-v2.md`（§3/§5/§8/§9/§10/§12/§13.1/§13.5）
- **本轮增量（第三轮）**：主链契约再演进（c5936873 同树收敛中）——已按真实 API 消费：
  ① `LeaderRunProgressDto` 新增 `summary`（真实计数）与 `termination`/`skill`，`resumeCapability` 改回 `session|artifact|none`；② 新端点 `GET /api/kb/build-runtime`（真实 statusDto）与 `POST /api/kb/build-runtime/install`。前端不再永久 unknown 已有真实计数，设置卡接入真实探测/安装。

## 一、真实契约对齐（不再有前端拟定字段）

| 面 | 真实来源（已读最新树核实） | 前端消费 |
|---|---|---|
| 模式枚举 | `agent-knowledge.ts`：`KbBuildOrchestrationMode`（三值可存，`resolveOrchestrationMode` 归一回显）；`KbBuildDto.orchestrationMode` 仅 legacy\|pi-amagi | config 三值/构建回显镜像 |
| 运行进度 | `GET /api/kb/builds/:id/leader` → `LeaderRunProgressDto`（**含 summary 真实计数/termination/skill/publishRequest.status**）；404 `build_not_found` | `getKbBuildLeaderProgress()` + 镜像 DTO |
| summary 真实计数 | `acceptedDocumentCount`/`openBlockingCount`/`activeAssignments`（无可靠来源=null）；`queueReason`（null=准入内部不可观测）；`lastUsage`（末次非累计）；`cumulativeUsage` **恒 null**（父子去重后不可得，不假累加） | 汇总三格显示真实计数（null→「未知」不显示 0）；排队任务有 queueReason 时显示真实原因，null→「原因未细分」；Leader 行末次用量单独呈现+「累计未知」 |
| termination | `'none'|'cancelling'|'finished'|null`（无可靠来源=null 不虚构） | cancelling→取消后台终止中横幅（凭据已失效/仍在终止）；finished/endedReason→已收束 |
| 恢复能力 | `resumeCapability: session\|artifact\|none`（集成侧改回 artifact） | artifact=「成果级恢复（重建剩余工作）」明确映射 |
| 运行宿主 | `GET /api/kb/build-runtime` → `BuildRuntimeStatusDto`（runtime/amagi{pinnedVersion,installed…}/probe{staticOk,**fullyVerified**,checks}/error；宿主未接线 503）；`POST /api/kb/build-runtime/install`（sourceDir 可选绝对路径；校验 400） | 设置卡「构建运行宿主」区：真实状态+刷新+安装入口 |
| 能力门控 | 启动时校验：claude-native → 400；pi-amagi 未接线 → 503 不降级；**staticOk ≠ fullyVerified** | UI 分开展示「静态检查通过/完整验证未达」；claude-native 恒禁用；默认 legacy |

## 二、实现（写面内，additive；legacy 与既有用户 diff 未动）

| 文件 | 改动 |
|---|---|
| `src/types/agent.ts` | `KbLeaderRunProgressDto`（含 summary/termination/skill + `KbLeaderPublishRequestDto`）；`KbBuildRuntimeStatusDto`/`KbBuildRuntimeInstallResultDto`（宿主状态/安装镜像）；`StandardKbConfig.orchestrationMode?` |
| `src/api/client.ts` | `getKbBuildLeaderProgress`、`getKbBuildRuntimeStatus`、`installKbBuildRuntime({sourceDir?})` |
| `BuildOrchestrationSettings.tsx` | 编排模式三选一（legacy 默认/pi-amagi 实验·启动时校验/claude-native 恒禁用）；**新增「构建运行宿主」区**：真实探测状态（Pi/amagi 固定版本/已安装/staticOk 与 fullyVerified 分开展示/探测明细折叠·静态与实测分开判定/探测失败如实）、刷新按钮、安装入口（sourceDir 手输绝对路径 + 安装/重装按钮；成功刷新状态+提示「完整启用另需实测验收」）、可信提醒（插件为受信 Node 代码非 OS 沙箱；安装可用≠验收全过） |
| `BuildOrchestrationProgress.tsx` | v2 分支：取消终止中横幅（termination=cancelling）；汇总三格真实计数（已接受文档/未解决阻断（null→未知）/实际并发+活动分配）；Leader 行（代次/轮次启收/末次用量单独口径+累计未知不假累加/恢复能力 artifact=成果级重建/skill 哈希/发布申请含 status）；任务行（queueReason 有值显示真实原因，null→未细分）；B 案 legacy 视图整体保留 |
| `KbBuildPanel.tsx` | pi-amagi 构建显示编排模式徽标（legacy/缺省不显示） |
| fixture | mock 数据形状=最新契约快照（summary/termination/skill/publishRequest.status + 宿主状态四态与安装 mock 复刻服务端 400 校验） |

## 三、测试（vitest 全量通过；tsc/eslint 0 错误）

- Settings（27）：新增运行宿主 describe——503 未接线不渲染安装入口、正常状态 staticOk/fullyVerified 分开呈现+探测明细（静态/实测标注）、未安装安装入口+成功后刷新、sourceDir 透传与失败如实展示、探测失败错误行、可信提醒文案断言；模式用例同前（含 config 存 claude-native 回显禁用）。
- Progress（20）：新增 summary 真实计数（null→未知不显示 0）、lastUsage 末次口径+累计未知、termination=cancelling 横幅+queueReason 真实原因、skill 哈希、publishRequest status=pending；其余用例同前（404 降级/legacy 分流/终态定格/artifact 恢复）。
- KbBuildPanel（+1）与草稿链路原样通过。

## 四、真实后端请求测试（集成 worktree 临时 server，非 fixture）

环境同前（临时 `FEISHU_SYNC_HOME`、固定 dev token、`tsx src/index.ts`，只读其代码，运行数据只写临时 HOME，测毕停进程）。本轮新增实测：

| # | 请求 | 实际响应 | 结论 |
|---|---|---|---|
| 1 | `GET /api/kb/build-runtime` | 200 真实 statusDto：`runtime.piVersion="1.4.0"`、`amagi{pinnedVersion:"2.21.31", installed:false}`、`probe{staticOk:false, fullyVerified:false, checks:[pi-version:pass, amagi-package:fail…]}` | 与前端镜像/消费完全匹配（含未安装→staticOk false 的真实组合） |
| 2 | `POST /api/kb/build-runtime/install {sourceDir:"relative/path"}` | `400 invalid_request`「sourceDir 必须是指向本地 amagi-pi 包根的绝对路径」 | 前端失败展示路径一致（fixture 同文案复刻） |
| 3 | 同上 `{sourceDir:"/nonexistent/amagi-pi"}` | 同 400 | 服务端存在性校验确认 |

前轮已实测项（config 归一/三值存取/leader 404/启动门控 400·503）仍有效，不重放。**未做真实 npm 安装**（耗时且属主树验收面；安装成功路径经 fixture 交互验证，真实安装留给主树复验）。

## 五、真实浏览器交互验证（agent-browser + vite fixture；mock 数据形状=最新真实契约快照）

前轮已验证项不重放。本轮新增 states（截图 16–19）：

1. **宿主已安装**（16）：「构建运行宿主」区完整——Pi 1.4.0、amagi-pi 固定版本 2.21.31 已安装、「静态检查通过」与「完整验证未达」分开展示、探测明细展开（静态/实测标注，实测项「未实测」如实）、刷新按钮、可信提醒逐字一致。
2. **取消终止中**（17）：黄色横幅「已请求取消：凭据已失效，仍在终止后台任务…」；排队任务显示「排队（准入池满（writer 池 4））」（queueReason 真实原因）。
3. **宿主未安装**（18）：安装按钮「安装 amagi-pi 2.21.31」+ 占位「可选：本地 amagi-pi 包源绝对路径（仅限可信来源）」。
4. **安装交互**：相对路径 → 「安装失败：sourceDir 必须是指向本地 amagi-pi 包根的绝对路径」（与真实服务端 400 文案一致）；合法绝对路径 → 成功后状态刷新为「已安装 2.21.31」（19）+ toast「完整启用另需实测验收」。
5. **宿主未接线**：说明行「构建运行宿主未接线…配置可保存，启动时由服务端校验」，不渲染安装入口（快照断言）。
6. 汇总三格真实计数（已接受文档 5/未解决阻断 2/实际并发 2+活动分配 3）快照断言。

视觉核验（amagi-media-understanding 委托读图 16/17/18）：宿主区各状态与提醒逐字一致、横幅与带原因排队标签正确、无重叠；已知视效：侧栏滚动区底部半露（DOM 完整，滚动可见，与 B 案同模式）；注脚 10px ink-faint 为 KB 侧栏既有设计语言（与 B 案 spec 行同款），未单独调高对比度以保持一致性——如需提升可后续统一调侧栏注脚 token。

## 六、未覆盖 / 风险

1. **真实 pi-amagi 构建动态进度未复验**（主树最终验收面）：宿主接线+安装+真实构建后，需用真实成功构建的 leader 进度在主树浏览器复验（当前为契约快照 fixture 验证；不以 mock 冒充）。
2. **真实 npm 安装未执行**（耗时+属主树验收面）；安装成功路径经 fixture 交互+服务端 400 校验真实验证。
3. 主链 c5936873 仍在同树收敛：若 `LeaderRunProgressDto`/`BuildRuntimeStatusDto` 字段再演进，适配面仍集中在 `types/agent.ts` 镜像 + `client.ts` 两个函数。
4. v2 的 publicationPolicy（auto/confirm）确认交互待服务端契约（设计 §6）；publishRequest.status=not_wired 已有标签位。
5. Electron 真机未验证（浏览器 fixture + 真实后端 curl 已覆盖契约与交互）。
6. 桌面端安装入口的目录选择复用：当前统一为手输绝对路径文本框（不扩写面）；若主上需要桌面原生目录选择，需评估复用现有目录选择组件的接缝（未在本轮写面内）。

## 七、changed files（回滚：worktree 内 `git checkout -- <file>`；新增文件直接删除）

- M `src/types/agent.ts`、`src/api/client.ts`
- M `src/components/settings/BuildOrchestrationSettings.tsx` + `.test.tsx`
- M `src/components/knowledge/BuildOrchestrationProgress.tsx` + `.test.tsx`
- M `src/components/kb/KbBuildPanel.tsx` + `.test.tsx`
- A `src/test-fixtures/kb-build-orchestration.browser-fixture.tsx`、`.html`
- A 报告与截图（主树 `agent-outputs/workflow/build-runtime-v2/`：ui-report.md、ui-shots/01–15.png）
