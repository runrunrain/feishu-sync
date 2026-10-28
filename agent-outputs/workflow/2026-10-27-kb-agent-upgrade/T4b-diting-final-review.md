# T4b Phase 4 收口合并审核（full，静态取证）

## 结论与范围

**VERDICT: FIX**（仅对下述已读取静态范围有效）。发现 **10 Major，0 Critical，0 Minor**。不能据此签发整个 `git diff HEAD` 的收口完成结论：本节点没有 bash/git/测试执行工具，未取得 diff/status，未独立复跑集成测试。

- 工作目录：`/Users/run.mao/workpace/feishu-sync`。
- 只读取得 `.git/HEAD` → `refs/heads/feat/agent-knowledge-workbench`；对应 ref 内容为 `6295b27d6642cfa3c4d611d7af6d8de7712a58f2`。这是读取时的 ref，不是经 git 锁定的不可变审核快照。
- 归因：下列定位均在 Phase 4 新服务/新增接线内；无 git diff 证据，不能逐 hunk 证明相对 HEAD 的引入情况。不把 Phase 3 已收口问题重新计入 findings。
- 只写本报告；未改项目代码、未编写项目测试、未调用云端写命令。

## 上游输入

以下四份任务必读输入已分段读完：

1. `/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/迭代设计文档/lark-cli-newcaps-P0.md`（415 行，含 §10/§11 裁定）。
2. 同目录 `lark-cli-newcaps-P1.md`（408 行）。
3. 同目录 `lark-cli-newcaps-P2.md`（405 行）。
4. `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/workflow.md`（含 Phase 3 收口、Phase 4 批次）。

另读实施证据：同目录 `P1-S8-report.md`、`P2-S6-report.md`；项目约束按任务内提供的 `CLAUDE.md`。本报告不以实施者报告中的“通过”替代独立验证。

## Findings

所有 finding 的证据等级均为 **静态路径证实，未动态复现**。下列步骤是供实施者复核的最小触发序列，不是本节点已执行的命令或测试结果。

### T4b-01｜Major｜发布互斥存在异步准入窗口

- **定位**：`server/src/kb/publication-service.ts:708-730`（`execute`）；同文件 `:841-842`（释放与 release 在用标记）。
- **触发条件**：同一服务实例同时收到两个首次发布请求；两者都在 `publishRunning=false` 时进入，`buildPlan` 的 scope/云端读取尚未完成。
- **可失败行为/实际影响**：两者均通过 708 行检查；执行到异步 `buildPlan` 后才在 730 行置位，没有二次检查。两个已固定为 create 的计划均创建文档，同一路径生成重复云文档，后写映射覆盖前写 token。先结束者还会清掉另一个任务仍需的全局布尔值与 release Set 标记，放入第三个发布或允许清理在用 release。
- **证据**：检查与置位之间存在 `await this.buildPlan(options)`；计划读取发布行发生在写入 creating 之前。`server/tests/kb-publication.test.ts:313` 起覆盖顺序首次发布，不覆盖并发准入。
- **最小复核**：让两次 execute 的 buildPlan 尾部 scope 查询停在同一 barrier，确认两次已读到空映射后放行，统计同一 kbPath 的 create 次数及返回状态。
- **最小修复方向**：同步占用准入后再 await 建计划，整体 finally 释放；使用中标记应随真正持有者释放，避免并发任务互删。

### T4b-02｜Major｜第二遍互链回写可绕过云端冲突保护

- **定位**：`server/src/kb/publication-service.ts:551-569`（只检查 updateCandidates）；`:792-815`（第二遍包含 skip_unchanged）；`:967-987`（runUpdate 无时间门）。
- **触发条件**：已发布 A 引用尚未发布的 B；A 在云端被他人修改，但本地 release 中 A 正文不变。本次选择 A+B，B 首次创建成功。
- **可失败行为/实际影响**：第一遍 A 的 hash 未变，被判 skip_unchanged，不进入云端时间检查；B 创建后的 URL 使 A 第二遍渲染 hash 改变，直接 runUpdate 覆盖 A。他人的云端修改被静默覆盖，请求既无 force，也未使用 OVERWRITE_PUBLISHED。
- **证据**：第二遍明确遍历 create/update/skip_unchanged；只比较第二遍与第一遍 render hash，随后直接 overwrite。runUpdate 仅 fetch revision（项目实测已证明 revision 不防旧值），没有 obj_edit_time 比较。现有两遍测试 `server/tests/kb-publication.test.ts:313-350` 只验证正常互链，不覆盖“原本 skip 的 A 已被云端编辑”。
- **最小复核**：先仅发布 A（A→B 链接降级成文字），把 A 的云端 meta 时间推进，再发布包含同字节 A 与新 B 的 release；应拒绝覆盖 A，当前路径会调用 overwrite(A)。
- **最小修复方向**：每次实际 overwrite，包括第二遍，均重新执行 fail-closed 时间门；不能把新发现的冲突沿用原 PUBLISH 批准自动越过。第一遍批量读到的时间也不应作为长批次末尾写入的唯一复核。

### T4b-03｜Major｜发布根双向校验只挂专用设置入口，通用配置可绕过

- **定位**：`server/src/routes/config.ts:172-177,264`；`server/src/modules/config-manager.ts:1082,1142-1144,1744-1746,1776-1801`；`server/src/routes/kb-publications.ts:205-235`；`server/src/kb/publication-service.ts:423-434`。
- **触发条件**：①先合法设置 wiki 发布根，再通过 PUT /api/config 新增其祖先 watchedRoot；或②desktop 经 PUT /api/config 直接提交位于既有 watchedRoot 内的 `feishuPublish.target`（token 不等于根 token）。
- **可失败行为/实际影响**：通用配置只做结构校验，不解析祖先链，也没有 watchedRoots 变更的反向校验；保存成功。执行期 cheapTargetOverlapCheck 只查 token 等值，无法发现严格祖先关系。违反 P1 §4.1 的“配置时 + 反向变更”门控，允许向监听子树发布。
- **证据**：完整 `validatePublishTargetAgainstWatchedRoots` 调用只在专用 target 路由；config-manager 注释也明确把校验留给该专用路由。`kb-publication.test.ts:664-752` 的方向 B 是纯核心函数断言，不是修改 watchedRoots 的真实配置入口回归。
- **最小复核**：专用 target 路由设置 T（此时监听根不覆盖 T），再通用配置添加 T 的祖先 R，检查是否 409；当前没有此拒绝分支。
- **最小修复方向**：对配置候选态的 watchedRoots 与 target 统一校验，覆盖两个入口与反向变更；无法证明祖先链完整时拒绝，而非把“调用了专用入口”当长期前提。

### T4b-04｜Major｜发布 overwrite 未接入 P0 的写前历史锚点

- **定位**：`server/src/kb/publication-service.ts:967-1005`（runUpdate）；`:315-321`（deps 的 store 面）。设计：P1 §4.4“若 P0-A 已上线，先取历史锚点写 source_push_log”。
- **触发条件**：任何已有发布内容更新，或首次发布后的第二遍互链 overwrite。
- **可失败行为/实际影响**：直接 fetch revision→overwrite→parse 字符数，没有 listDocumentHistory、无锚阻断或 source_push_log 记录。P0-A 与发布已同时存在，但发布覆盖仍绕过这条安全网；overwrite 出错时应用没有该次操作可定位的写前回退记录。
- **证据**：整个发布服务无 insertSourcePushLog/listDocumentHistory 调用；deps 只声明发布映射访问器。正常测试仅断言 fetchRevision/overwrite，不要求历史锚点。
- **最小复核**：将 history-list 设为失败，执行一次内容变化发布：期望在 overwrite 前拒绝且不写云端，当前根本不会调用 history-list。
- **最小修复方向**：发布更新（含第二遍）复用锚点获取/精确性判定/先落日志后写的原语；不是复用 source_edits 状态机。缺少锚点或持久化失败须拒绝覆盖。

### T4b-05｜Major｜移出 unknown 即释放编辑/写回围栏

- **定位**：`server/src/modules/local-map-store.ts:3427-3448`；`server/src/sources/source-edit-service.ts:192-212`；`server/src/sources/feishu-write-service.ts:184-190`；`server/src/sources/cloud-history-service.ts:269-277`。设计：P2 §3.6 明确 unknown 期间按 cloud_move_running 处理。
- **触发条件**：移出请求超时、轮询达到十分钟上限，或重启把 pending/moving 无 task_id 对账成 unknown；尚未通过检测证实节点仍在树内。
- **可失败行为/实际影响**：getActiveCloudMove 仅查询 pending/moving，最新行 unknown 又不是 moved。edit/push/revert 三个消费方均失去阻断依据，允许在云端移出仍可能执行/已执行时产生新脏编辑或远端动作，破坏“移出后写回不可收敛”的保护。
- **证据**：只有 pending/moving 计入 active；编辑与写回的第二道门只认 latest.state==='moved'，不存在 unknown 的已核对解除条件。现有测试验证 unknown 状态迁移，但未把该终态再送入三消费方验收。
- **最小复核**：插入同 objToken 的 unknown 移出行，保持未核对状态，调用 edit/push/revert 的预览/执行门，检查应返回 cloud_move_running 而非可执行。
- **最小修复方向**：unknown 保持围栏；仅在权威检测或显式核对流程证明未移出后解除。三消费方共用同一状态解释，避免各自猜测。

### T4b-06｜Major｜非幂等写入响应不可解析被误记为明确失败

- **定位**：`server/src/sources/cloud-history-service.ts:651-656`；`server/src/sources/cloud-move-service.ts:444-453`；`server/src/kb/publication-service.ts:1075-1097`；`server/src/modules/lark-cli-client.ts:900-908`（创建已调用、响应缺 id 后抛普通 Error）。
- **触发条件**：云端已接受 create/revert/move，但 CLI 输出 JSON 损坏抛 `LarkCliError(code='parse')`；或 create 返回有效 JSON 却缺 document_id。
- **可失败行为/实际影响**：三个服务均只把 timeout 归 unknown，parse/缺字段落 failed。发布行无 token 且 failed，下一次普通发布直接 create，可生成重复云文档；回滚/移出以明确失败状态释放门，掩盖仍可能在运行的远端任务。
- **证据**：history/move catch 只检查 `code==='timeout'`；publication classifyError 其余落 failed。注释承诺“超时/不可解析→unknown”与实现不符。此处不重开既有 SourcePush 的错误分类，只报告 Phase 4 新服务。
- **最小复核**：使客户端在记录“写命令已发出”后抛 parse；检查落库与后续普通执行。对发布还可模拟 create 已成功但响应无 document_id。
- **最小修复方向**：区分写前校验失败、权威业务拒绝与发出后结果不确定；parse/写后必要字段缺失归 unknown，不允许普通重发冒充明确失败重试。

### T4b-07｜Major｜重新发布后旧云 token 退出快照排除集合

- **定位**：`server/src/kb/publication-service.ts:888-895,905-947,1000`；`server/src/modules/local-map-store.ts:3537-3543`；`server/src/kb/kb-build-service.ts:425-436`。
- **触发条件**：原 token A 的发布行进入 unknown/cloud_missing，用户明确 force 新建 B；A 实际仍存在，随后被移入监听树或快捷归档。
- **可失败行为/实际影响**：映射改指 B，A 只被记在 warnings_json.previousCloudTokens；listPublishedCloudTokens 仅返回当前 cloud_token，构建便将 A 当普通原始源。已发布内容重新成为构建输入，突破防自我喂养不变量。后续 runUpdate 还把 warningsJson 写为仅 warnings，进一步丢失旧 token 谱系。
- **证据**：排除集合 SQL 未读取 previousCloudTokens；构建只消费该集合。重新发布测试 `server/tests/kb-publication.test.ts:561-580` 验证旧 token 被归档，却未验证它仍被快照排除。
- **最小复核**：生成 A→B 的重发记录，再注册本地源 objToken=A，构建快照应排除 A；当前 provider 仅含 B。
- **最小修复方向**：发布产物身份作为持久谱系维护，排除所有历次已知产物 token；状态/警告更新不得抹掉谱系。

### T4b-08｜Major｜Leader 补的 history-content 仍未闭合“对比云端当前”消费链

- **定位**：`server/src/routes/feishu.ts:558-569`；`server/src/sources/cloud-history-service.ts:405-428`；`src/components/SourceEditControls.tsx:302-309,545-551,633-641`；`src/components/source-history/CloudDiffModal.tsx:1-11`。
- **触发条件**：写回发生 source_push_conflict，用户点击“对比云端与本地”，且云端正文实际上可读。
- **可失败行为/实际影响**：openCloudDiff 无网络读取，始终把 cloud.body 设为 null；因此永远只能显示不可读降级，而不能提供设计要求的当前云端差异供强推决策。新增历史 revision API 并不自动补上当前正文读取与前端接线。
- **证据**：对 `src/` 搜索 history-content/fetchCloudRevision 没有消费者；宿主固定 body:null。Leader 追加的 5 用例仅覆盖 service opts 透传/错误包装及 Hono 路由；其中“argv 语义”用的是 fetch stub，并没有执行真实 LarkCliClient。它们不能证明 UI 接入或真实 argv。
- **最小复核**：让服务端 fetch 返回可读正文并点击冲突对比，观察是否发出读取请求、是否出现两侧 diff；当前该 handler 不会发请求。
- **最小修复方向**：闭合“云端当前（不是 historyVersionId 冒充 revisionId）+ 本地基线/当前”的真实数据入口与 UI 调用；保留只有真实失败才进入的不可读态。补消费者级契约回归与真机交互证据。

### T4b-09｜Major｜回滚记录 anchorExact 的云端时间被错误除以 1000

- **定位**：`server/src/sources/cloud-history-service.ts:235-244,599-602`；对照 `server/src/sources/feishu-write-service.ts:327-332`。
- **触发条件**：为任意历史回滚生成新的 mode=revert 日志；最新历史早于当前云端 obj_edit_time。
- **可失败行为/实际影响**：Date.parse 的毫秒应除 1000；getDocumentMetas.latestModifyTime 已是秒，代码却又除 1000。现代时间几乎总被判精确。后续对该回滚记录进行“回到回滚前”时不出现 anchor_inexact 警告，隐瞒会同时撤销他人中间修改的风险。
- **证据**：例如 anchor 秒值 1,799,999,999、cloud 秒值 1,800,000,000，期望 false，当前比较变成 `1,799,999,999 >= 1,800,000`，得到 true。写回链 computeAnchorExact 对同一 meta 通道没有除该 1000。`cloud-history.test.ts:48` 也明确标注 CLOUD_TIME 为秒。
- **最小复核**：设置历史时间比 cloudTime 早 1 秒，执行回滚并查新日志 anchorExact，应为 false。
- **最小修复方向**：统一秒级口径，复用一处纯判定；为早一秒/相等/不可读添加边界回归。

### T4b-10｜Major｜回滚/移出的互斥状态更新被当作非关键日志吞错

- **定位**：`server/src/sources/cloud-history-service.ts:636-647,688-695`；`server/src/sources/cloud-move-service.ts:421-434,196-202`；门消费见 `source-edit-service.ts:166-212`。
- **触发条件**：云端已经返回 running，`updateSourcePushLogRevert(...running)` 或 `updateCloudMove(...moving,taskId)` 发生一次持久化错误（随后数据库恢复可读）。
- **可失败行为/实际影响**：safeUpdate 只打印控制台，继续返回 202 并在内存轮询。回滚日志仍 revert_state=NULL，编辑/写回/新回滚看不到 running，可同时执行；移出行虽可能仍 pending 暂时阻断，但 taskId 未落盘，重启只能 unknown，不能按承诺续查。此表字段不是可丢的审计，而是互斥与重启恢复真相。
- **证据**：两个 safeUpdate 均吞掉异常；调用方没有检查布尔返回/持久化结果。回滚 insertSourcePushLog 只初始化 outcome=started，不初始化 revert_state；可见 `local-map-store.ts:3130-3171`。本 finding 与 Phase 3 已记录的 SyncEngine DB fail-open 不是同一条路径。
- **最小复核**：仅对第一次写 running+taskId 的 store 方法注入异常，随后正常读取；检查 202 后 edit/revert 是否仍被围栏阻断，以及重启是否保有 taskId。
- **最小修复方向**：关键状态提交失败不得按成功已持久化处理；保留进程内 fail-closed 围栏并显式上报结果未知，提供可靠对账路径。纯审计追加可以 best-effort，互斥状态不可同等处理。

## Full 覆盖清单与测试可信度

| 审核面 | 已核对证据/结论 | 覆盖边界 |
|---|---|---|
| 写回锚点时序 | `feishu-write-service.ts:613-737`：时间门之后取锚；overwrite 无锚拒；日志先于远端写；成功后记结果；回拉锁外；P0-S3/S4/S9 追加路径可读且未见嵌套回拉死锁 | 未运行 source-push；锁外 push 快检与锁内复核的并发完整性未动态覆盖 |
| 回滚/移出/编辑共享锁 | `source-write-lock.ts:32-67` FIFO；edit/revert 在锁内查门；history/move 锁内重查，回拉/检测锁外 | DB 权威状态的吞错与 unknown 语义见 findings；不声称无其他时序缺陷 |
| Leader 历史正文直改 | routes/service/client opts 三段核对；client 未传 opts 时保持原 fetch argv，传值时附 `--revision-id` | 5 个新测试为 stub/Hono，未真 CLI；前端未消费见 T4b-08；空正文、空串 query、负/小数边界未运行 |
| 发布 | 全部 1099 行服务按段读取；双向校验核心/专用路由、两遍重渲染、冲突、使用中标记与快照接线 | T4b-01/02/03/04/07 阻断；wiki_node 真实创建未取证 |
| 不删云文档 | 发布服务不存在远端 delete；removed 路径只写 kb_removed | 静态限定于已读发布服务，不扩成全仓“无删除”断言 |
| 六新表 | `local-map-store.ts:279-402` 与 `:3844-3951` 两套 DDL 逐表对照：表、主键、列与索引一致，均 CREATE IF NOT EXISTS | 存量新建路径与 fresh DDL 静态满足；未实际执行旧库迁移/二次启动，不把幂等测试报告当亲验 |
| 引用/评论原子事务 | `sync-engine.ts:1078-1190`：文件提交后事务更新基线/边/评论；hook 抛错回滚 DB 与文件。`sync-references.test.ts:219-259` 真断言旧正文、旧边、旧基线；`source-comments.test.ts:408-435` 真断言旧评论与基线 | 测试代码有效性已读，未执行；评论该用例未额外断言正文，文件回滚证据由引用/既有引擎用例承载；归档链未全量深审 |
| CLI 追加与分类 | 读 fetch/history/revert/status/move/task_result/create/overwrite/screenshot 与 classifyError；D1 同时识别 131014/131005；D2 node-list 显式 page-limit 0；新码 10020/3380002/3380003/981003 分支存在 | 未取得原始 diff 与所有旧 argv 快照，不签发“35 旧调用点完全不变”；981004 未单独专用分类，未据此扩报风格 finding |
| 命令与确认 | `command-table.ts:556-615,776-1058`：发布按 preview 派生；revert 含目标 id；rename 有 planKey；move 三条均 false；`routes/cli.ts:183-243` 有确认门；`cloud-history.test.ts:935-1008` 批准执行/停止取消实测替身链覆盖存在 | 未复跑命令总数 38→41；CLI force 无冲突仍静态猜 OVERWRITE_PUBLISHED 的既知限制保留为观察（P1-S8 报告 §三已声明），不冒充本轮新回归 |
| 零凭据/header/基线 | 已读新增链资源 token 均为文档/节点身份而非飞书凭据；history/move/rename 不直接推进 synced；SyncEngine 原子提交顺序保持 | 无 diff，未对全仓做凭据扫描；header writer/parser 全套 round-trip 与所有前端新组件未完整复跑 |
| 性能/兼容 | history 分页有界、轮询有十分钟意图上限、DDL additive、fetch opts 缺省兼容 | 超慢 CLI 队列下轮询重入/真实性能、Windows/Electron ABI/打包未验证 |

### 指定已知项（不重开）

1. **P0-S7 vision 跳过裁定**：P0 §11 已明示修订。`kb-build-service.ts:570-572,889-892` 在旁路文字命中时跳过描述；`agent-tool-service.ts:866-897` 无 vision/未 ready 仍内联白板文字且命中时跳过 lookup；有效字数在 `kb-build-service.ts:639-642,2521-2534` 计入。静态与裁定一致，不报“应继续识图”。
2. **P1-S5 toMatchObject**：`p1-s5-slides-screenshot.test.ts:383-413` 只将外层附加默认段解耦，仍完整约束 slidesScreenshot.enabled 的缺省/非法/合法/回读；严格类型拒绝用例仍在，未见为过绿而去掉原语义。
3. **P2-S6 C-1～C-5**：报告 `P2-S6-report.md` 有完整表；客户端 `lark-cli-client.ts:2232-2236,2277-2279`、服务头 `cloud-move-service.ts:35-39`、测试头均保留“待 S5 实测校正”标签。C-1/C-2 输出/参数、C-3 未挂 feishuWrite/scope、C-4 等待参数、C-5 状态命名属于已声明 pending，不重开为新 finding。**这些标注不是 S5 已完成的证据，不能签移出生产就绪**；尤其 C-3 当前确实没有写开关门，当前 mock 测试 config 也未启用 feishuWrite。

### 验证运行账本

- **运行过**：仅 read/grep/find 工具的静态取证；未执行任何 shell/测试/浏览器或云端命令。两次 grep 正则参数错误已保留在工具记录，不影响已成功读取证据；没有把失败调用算作覆盖。
- **未运行**：`git diff HEAD`、`git status --short`、`npm run check`、server 108 文件/1659 用例、前端 345 用例、迁移执行、TestHooks 执行、确认门真实 CLI、Electron 交互。
- **上游声称**：任务书给出 server 1659 / 前端 345 全绿；本轮仅承认这是上游输入，不授予当前工作区复验通过。实施报告内的定向全绿同理。
- **证据可信度**：静态 finding 均有具体路径与触发序列；没有运行级复现。测试质量评估只限读取过的断言，不从“存在测试”推导“行为无误”。

## 收口仍缺的输入与下一步

1. Leader 提供本轮冻结的 `git diff HEAD`（含未跟踪文件清单、当前 HEAD/status），或以可用 guarded shell 续接本节点，才能完成严格差分归因、核对遗漏文件与最终合并态验证。
2. 实施者按原编号修复并作者侧补正式失败分支回归；复审重点为并发首次发布、skip→第二遍更新的云端编辑、通用配置反向校验、旧产物排除与非幂等未知结果。
3. 移出 S5 与 C-1～C-5 仍作为既知待校正项由 Leader 决策，不以 mock 全绿替代真实输出/授权契约。
4. 真机 UI/视觉及 Windows/打包属于未覆盖项；本节点未作视觉判断。原始文件正文与用户现场保持不动；本报告的回滚仅为删除本报告文件，不涉及项目或云端回滚。

**结论行：VERDICT: FIX（已审静态范围；完整 diff 收口与运行验证仍 blocked）。**

---
## 复验归因（带 guarded shell 续审，最终）

**VERDICT: FIX。原 10 项 Major 均未关闭；0 项撤销/降级，0 项独立新增。** 本节更新原文“未运行/缺 shell”的历史状态；前文静态段原样保留。

### 基线与归因范围
- 上游：本报告原静态段（任务唯一必读 artifact）。为独立核实锚点义务，另读外部 `迭代设计文档/lark-cli-newcaps-P1.md:236-296` 的 §4.1/§4.4 原文。
- 本轮 `git rev-parse HEAD`：`6295b27d6642cfa3c4d611d7af6d8de7712a58f2`，与前任读取的 ref 相同。
- 起始 `git diff HEAD --stat`：**66 tracked files，8089 insertions，164 deletions**；`git status --short` 还含 untracked 的新服务/路由/测试/组件/报告。stat 不含 untracked，不能拿 66 文件声称整个工作区已审。
- 针对涉及文件执行实际 diff/status/numstat。以下全部属于相对 HEAD 新增或暴露的 Phase 4 路径；没有中间切片冻结快照，不能据此给某位实施者分责或推断写入先后。
- 已辨认 D1/D2 diff：`lark-cli-client.ts` 的 `131014/131005 -> not_in_wiki` 与 node-list `--page-limit 0`。十项都不是这两项修复的回归，不重开 Phase 3。
- 本轮不是对全仓 8k+ tracked diff 与全部 untracked 的重新审计；VERDICT 范围为原十项及直接相关链路。

### 原编号逐项裁决
所有“运行复现”均调用当前真实服务和临时 SQLite；远端是明确的测试替身，不是实际写云端。原静态段的触发条件/影响/修复方向与本表合并消费。

| 原编号 / 严重度 | 当前定位 / 差分归因 | 证据与裁决 | 最小修复方向 |
|---|---|---|---|
| **T4b-01 Major 未关闭** | `kb/publication-service.ts:708-730,841-842`，整个服务为 untracked 新文件，HEAD 不存在 | 临时用例 01 在真实 buildPlan 尾部加 barrier，仅放大合法调度。同实例、同 kbPath、同 PUBLISH 两请求均 fulfilled，create **2 次**。**运行复现**；release 标记互删仍为同因果链静态推论，未动态运行清理并发 | await 建计划前同步占准入，失败也 finally 释放；使用中标记按实际持有者释放 |
| **T4b-02 Major 未关闭** | 同服务 `:551-569,792-815,967-987`，新增两遍发布 | 临时用例 02 先仅发布 A；完整计划中 A 为 skip_unchanged。在新 B 的 create 中把 A 云端时间推进 BASE_TIME+100 并设他人正文。执行仍只需 PUBLISH，第二遍 overwrite(A)，他人正文消失。**运行复现** | 每次实际 overwrite 前重新取时间，包括 skip 转 update/第二遍；新冲突阻断并重新派生批准，不能沿用 PUBLISH |
| **T4b-03 Major 未关闭** | `routes/config.ts:172-177,264`；`modules/config-manager.ts:1082,1142-1144,1744-1801`；`routes/kb-publications.ts:205-235` | diff 证实新增 feishuPublish 段及通用保存。通用入口仍直接 updateConfig，manager 仅结构校验；完整祖先链校验只挂专用 target 路由，watchedRoots 反向变更无接线。**静态路径证实**，未动态跑配置入口反例，不以纯核心函数断言冒充入口验证 | 候选配置联合校验，覆盖 target 和 watchedRoots 两个方向及两个入口，祖先链不可读 fail-closed |
| **T4b-04 Major 未关闭** | `kb/publication-service.ts:967-1005`；对照 `sources/feishu-write-service.ts:674-725` | 临时用例 04 提供 history-list 空列表替身，发布仍 overwrite **1 次**、history 读取 **0 次**、该 token 的 push-log **0 行**。独立 -t 复跑现有源写回“overwrite 无锚”**3 通过**。**运行复现且缩定归因**：不是 FeishuWriteService 无锚防护失败，而是新增发布链未接此原语 | 发布 update 含第二遍先取锚并落日志；无锚/落库失败拒绝覆盖；不套 source_edits 状态机 |
| **T4b-05 Major 未关闭** | `modules/local-map-store.ts:3427-3448`；`sources/cloud-move-service.ts:296-320,444-453`；`source-edit-service.ts:192-212`；`feishu-write-service.ts:184-190`；`cloud-history-service.ts:269-277` | 方法及消费者均为本轮新增。临时用例 05 由真实 move 超时得到 unknown，active=null；无检测核对即再次移出返回 moving，move **2 次**。**运行复现**。三消费方丢门为静态证实，未逐个动态写入。校正原文措辞：history 只查 active，不应把编辑/写回的 moved 第二道门也归给 history | unknown 持续围栏；只有权威核对证明未移出才解除，移出自身和三消费者共用解释 |
| **T4b-06 Major 未关闭** | `cloud-history-service.ts:651-656`；`cloud-move-service.ts:444-453`；`kb/publication-service.ts:1075-1097`；`modules/lark-cli-client.ts:900-908,1644-1657` | 三上层服务均新增；client create 缺 id 为新增写后普通 Error。临时 **3 用例**确认 parse 在 revert/move/create 都落 failed，create 普通重发再次执行（attempts=2）。客户端真实解析链能产生 parse。缺 id 分支仅静态核实，未独立动态注入 | 区分写前校验、权威业务拒绝与命令发出后未知；写后解析/必要字段缺失归 unknown，禁止普通重发 |
| **T4b-07 Major 未关闭** | `kb/publication-service.ts:888-895,905-947,1000`；`modules/local-map-store.ts:3537-3543`；`kb/kb-build-service.ts:425-436` | diff 证实 provider SQL 与构建过滤新增。临时用例 07 实际旧 token A→unknown→force 重发 B；A 在 previousCloudTokens，却不在 listPublishedCloudTokens，集合仅含 B。**provider 丢身份运行复现**；未跑 LLM 构建，A 流入快照后果由消费链静态证实。正常 update 还会覆盖 warningsJson 丢谱系 | 持久保留历次产物 token 并全量排除，状态/警告更新不得擦除谱系 |
| **T4b-08 Major 未关闭** | `src/components/SourceEditControls.tsx:302-309,545-551,633-641`；`server/src/sources/cloud-history-service.ts:405-428` | diff 明确新增 handler 固定 cloud.body=null，无 fetch；历史内容接口不等于当前正文。前端相关 **13 测试通过**，CloudDiffModal 为 SSR 手工喂两侧字符串，不能证明宿主发请求。**静态路径证实**，未做浏览器点击，不以 SSR 冒充交互验收 | 接当前云端正文只读 API 与宿主调用，真正失败才降级；补消费者级回归及真实交互 |
| **T4b-09 Major 未关闭** | `sources/cloud-history-service.ts:235-244,599-602`，新增服务 | 临时用例 09 metas 时间比锚点晚 **1 秒**，真实 revert 新日志 anchorExact 却 true。**运行复现**，秒值再除 1000 误判成立 | 统一秒级口径/复用判定，早一秒=false、相等=true、不可读=false |
| **T4b-10 Major 未关闭** | `cloud-history-service.ts:636-647,688-695`；`cloud-move-service.ts:421-434,196-202`，新增服务 | 临时用例 10 只对 running 写入注入瞬时 SQLite 异常，其余 DB 可读；返回 running，getRunningRevertPushLog=null。**回滚门丢失运行复现**；move taskId 丢失/重启 unknown 为静态证实，不冒称两支都动态跑过 | 关键互斥与任务 ID 持久化不能 best-effort；异常/false 返回都处理，保留 fail-closed 围栏并可靠对账 |

**归因结果**：原十项全属本工作区新增服务/新增接线引入或暴露，没有证据改判为 HEAD 既有问题。无“修复后又引入回归”的关闭项。05 再移出、06 三路分类是原 finding 的加强证据，不重复算新编号。没有撤销项，不为追求降级数量而稀释已复现问题。

### 运行账本（本轮亲跑）
| cwd | 实际入口 / 退出码 | 结果及边界 |
|---|---|---|
| 项目根 | `git diff HEAD --stat && git status --short`；`git rev-parse HEAD`；0 | 基线如上；含 untracked 清单，不把 stat 当新文件全文 diff |
| server/ | `npx vitest run tests/kb-publication.test.ts tests/cloud-history.test.ts tests/cloud-move.test.ts tests/source-push.test.ts tests/source-edit.test.ts tests/local-map-store.test.ts`；0 | **6 files / 229 passed**；SQLite ABI 正常，无安装/rebuild。错误分支预期 stderr 不是测试失败 |
| 项目根，runner 内 cwd=server/ | 从本报告附录展开临时夹具，调用本地 `vitest run --config <tmp>/vitest.config.mjs --reporter=verbose --silent`；0 | **3 files / 10 passed**：01/02/04/05/06×3/07/09/10。断言不安全行为，绿代表反例坐实，不是产品合约通过；finally 输出 `temporary files removed: True` |
| server/ | `npx vitest run tests/source-push.test.ts -t "overwrite 无锚" --silent`；0 | **3 passed / 61 skipped**，与 229 重合，不能重复当独立覆盖 |
| server/ | `npx vitest run tests/lark-cli-client.test.ts tests/ops-command-table.test.ts tests/reference-graph.test.ts tests/sync-references.test.ts tests/source-comments.test.ts --silent`；0 | **5 files / 136 passed**，直接 CLI/命令/原子引用评论回归 |
| 项目根 | `npx vitest run src/components/SourceEditControls.test.tsx src/components/source-history/CloudDiffModal.test.tsx --silent`；0 | **2 files / 13 passed**，SSR/单元不是浏览器交互或视觉验收 |
| 项目根 | 一次 git diff 与 grep 串联取证；1 | grep 无匹配致组合退出 1，不是 git/测试故障；按正确变量 publishedTokens 后取得 diff。不把该失败计成验证通过 |

首批测试完整工具日志：`/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/pi-bash-d95798077962f09b.log`（会话临时日志，不保证长期存在）。其他关键结果已在本表和可复跑附录保全。临时反例路径为 `/tmp/t4b-recheck-py61deq2/*.test.ts`，已按任务要求删除；源脚本持久保存在本报告附录。

实际反例执行入口：在项目根用 python3 读取本报告 `python t4b-recheck` fenced block 内容并 exec；脚本生成临时测试/config/依赖链接，调用 server 本地 vitest，finally 删除目录。重新运行时必须只提取附录代码块，不执行报告其他文本。

### Full 覆盖、可信度与盲区
- 正确性/边界/一致性并发：逐项核实，8 项有动态反例（06 三支），03/08 为静态路径证实；不声称穷尽所有时序。
- 安全权限：冲突确认、锚点、unknown 围栏、发布根、源排除均核对；无实际云端写入/凭据操作。正常 FeishuWriteService 无锚拒写是有效对照。
- 兼容迁移：实际 initialize/SQLite 和相关测试通过；未执行生产旧库迁移；D1/D2 diff 已辨认，CLI 直接回归通过。
- 性能/维护性：不新增无证据性能结论；修复方向只服务已证实门控与状态真相，不以偏好重构设 blocker。
- 复现可信度：复用既有 fixture 初始化前缀，但独立临时反例由审核方编写，不提交项目正式测试；调用真实源码/SQLite。01 barrier 只控制调度，02 在 B 创建时推进 A 时间；远端替身不能证明飞书真实结果。
- 共享树：并非隔离 worktree/冻结快照。定向测试无兄弟中间态故障，起末 tracked stat/numstat 一致；仍不能证明整个运行时段所有 untracked 字节完全不变。只对原十项当前已读路径签 FIX，不签全量集成绿或发布就绪。
- 未运行：全仓 check/typecheck、全量 server/front-end、真实 lark-cli 写云端、浏览器/Electron 交互、真实 S5 move 输出、Windows/打包。C-1～C-5 等既知待核项保留给 Leader，不自行扩报。
- 写入纪律：只完整重写本报告（原静态段原样保留），业务代码/既有测试零写入；临时测试/config/node_modules 链接均在 /tmp 并已清除。无 commit/stash/restore/reset/云端动作。

### 修复清单（供 Leader 按文件分批）
1. **server/src/kb/publication-service.ts**：01 同步准入/finally；02 每次 overwrite 时间/确认复核；04 写前锚点日志；06 写后未知分类；07 token 谱系保全。第一遍与第二遍必须共用安全门，避免补一处留一处。
2. **server/src/modules/local-map-store.ts + server/src/kb/kb-build-service.ts/provider 接线**：05 未解除 unknown 纳入围栏；07 历次产物 token 排除全集；10 支撑可靠互斥/任务恢复原语。
3. **server/src/routes/config.ts + server/src/routes/kb-publications.ts + server/src/modules/config-manager.ts**：03 候选态双向交叉验证，覆盖通用配置与 watchedRoots 反向修改。
4. **server/src/sources/cloud-move-service.ts + source-edit-service.ts + feishu-write-service.ts**：05 unknown 围栏与显式核对解除（含再次移出）；06 move 写后未知；10 moving/taskId 提交失败。保留已通过的源写回无锚拒写门。
5. **server/src/sources/cloud-history-service.ts**：05 unknown 移出阻断；06 revert 未知结果；09 时间单位；10 running 持久化不可吞错。
6. **server/src/modules/lark-cli-client.ts**：06 发出后缺必要响应字段与写前校验区分；不得重试非幂等写。
7. **src/components/SourceEditControls.tsx + src/api/client.ts + 只读正文服务/路由**：08 闭合当前云端正文消费链，补宿主回归/真实交互，不拿人工字符串 SSR 代替。
作者侧正式回归由实施者落地；本审核不提交项目测试或修复 patch。修复后按原编号逐条复审。

回滚：没有产品代码变更；若撤回本轮审核，只移除本节及 runner 附录，**保留原静态段**，不删除本报告或任何共享树现场。

**终审：VERDICT: FIX（原 10 Major 均未关闭；仅对上述声明范围有效）。**

### 附录：一次性反例 runner
此脚本是审核夹具，不是正式测试补丁。只复制初始化前缀至 /tmp，使用当前源码和 SQLite；远端为注明的 stub，finally 清理临时文件。

```python t4b-recheck
import pathlib, tempfile, subprocess, shutil, re, os
repo = pathlib.Path('/Users/run.mao/workpace/feishu-sync')
server = repo / 'server'
tmp = pathlib.Path(tempfile.mkdtemp(prefix='t4b-recheck-', dir='/tmp'))
cases = {}
cases['kb-publication'] = r'''
describe('T4b runtime counterexamples', () => {
 it('01 concurrent same-confirm creates duplicate cloud docs', async () => {
  const fx = makeFixture();
  try {
   const original = (fx.service as any).buildPlan.bind(fx.service);
   let n = 0; let release!: () => void;
   const barrier = new Promise<void>(r => release = r);
   (fx.service as any).buildPlan = async (o: any) => {
    const plan = await original(o); if (++n === 2) release(); await barrier; return plan;
   };
   const results = await Promise.allSettled([1,2].map(() => fx.service.execute({confirm:'PUBLISH',kbPaths:['b/b.md']})));
   expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
   expect(fx.lark.calls.filter(c => c.op === 'create')).toHaveLength(2);
   console.log('E01 both fulfilled; same kbPath create count=2');
  } finally { fx.cleanup(); }
 });
 it('02 cloud advances during B create; skipped A is overwritten in pass two', async () => {
  const fx = makeFixture();
  try {
   await fx.service.execute({confirm:'PUBLISH',kbPaths:['dirA/a.md']});
   const a = fx.store.getKbPublication('dirA/a.md')!;
   const before = await fx.service.plan({});
   expect(before.items.find(i=>i.kbPath==='dirA/a.md')?.action).toBe('skip_unchanged');
   const create = fx.lark.createDocumentMarkdown as any;
   fx.lark.createDocumentMarkdown = async (o:any) => {
    const result = await create(o); fx.lark.metaTimes.set(a.cloudToken!,BASE_TIME+100);
    fx.lark.createdDocs.set(a.cloudToken!, 'OTHER USER CLOUD EDIT'); return result;
   };
   fx.lark.calls.length=0;
   const result=await fx.service.execute({confirm:'PUBLISH'});
   expect(fx.lark.calls.some(c=>c.op==='overwrite' && c.args[0]===a.cloudToken)).toBe(true);
   expect(fx.lark.createdDocs.get(a.cloudToken!)).not.toBe('OTHER USER CLOUD EDIT');
   console.log('E02 secondPass='+result.counts.secondPass+'; A overwritten without force after cloud time advanced');
  } finally {fx.cleanup();}
 });
 it('04 publish overwrite does not read empty history or persist anchor', async () => {
  let reads=0;
  const fx=makeFixture({larkOverrides:{listDocumentHistory:async()=>{reads++;return {entries:[],hasMore:false,nextPageToken:null};}}});
  try {
   const result=await fx.service.execute({confirm:'PUBLISH'});
   expect(result.counts.secondPass).toBe(1); expect(reads).toBe(0);
   const a=fx.store.getKbPublication('dirA/a.md')!;
   expect(fx.store.listSourcePushLogs(a.cloudToken!)).toHaveLength(0);
   expect(fx.lark.calls.filter(c=>c.op==='overwrite')).toHaveLength(1);
   console.log('E04 empty-history stub never read; overwrite=1; push logs=0');
  } finally {fx.cleanup();}
 });
 it('06 create parse failure is failed and ordinary retry issues another create', async()=>{
  const fx=makeFixture();
  try {
   let attempts=0;
   fx.lark.createDocumentMarkdown=async()=>{attempts++;throw new LarkCliError('bad JSON','parse',false);};
   await fx.service.execute({confirm:'PUBLISH',kbPaths:['b/b.md']});
   expect(fx.store.getKbPublication('b/b.md')!.state).toBe('failed');
   await fx.service.execute({confirm:'PUBLISH',kbPaths:['b/b.md']});
   expect(attempts).toBe(2); console.log('E06 publication parse -> failed; normal retry attempts=2');
  } finally {fx.cleanup();}
 });
 it('07 force republish archives old token but excludes only new token',async()=>{
  const fx=makeFixture();
  try {
   await fx.service.execute({confirm:'PUBLISH',kbPaths:['b/b.md']});
   const old=fx.store.getKbPublication('b/b.md')!;
   fx.store.upsertKbPublication({...old,state:'unknown'});
   await fx.service.execute({confirm:'PUBLISH',force:true,kbPaths:['b/b.md']});
   const row=fx.store.getKbPublication('b/b.md')!;
   expect(JSON.parse(row.warningsJson!).previousCloudTokens).toContain(old.cloudToken);
   expect(fx.store.listPublishedCloudTokens()).not.toContain(old.cloudToken);
   expect(fx.store.listPublishedCloudTokens()).toContain(row.cloudToken);
   console.log('E07 old token in archive, missing from exclusion provider');
  } finally {fx.cleanup();}
 });
});
'''
cases['cloud-move'] = r'''
describe('T4b move counterexamples',()=>{
 it('05 unknown from timeout permits another move without authoritative reconciliation',async()=>{
  const fx=fixture({moveError:new LarkCliError('timeout','timeout',false)});
  const err=await expectMoveError(fx.service.moveToDrive(OBJ,{confirmValue:deriveMoveOutConfirmValue(NODE)}));
  expect(err.code).toBe('cloud_move_outcome_unknown');
  expect(fx.store.getLatestCloudMove(OBJ)?.state).toBe('unknown');
  expect(fx.store.getActiveCloudMove(OBJ)).toBeNull();
  fx.lark.moveWikiNodeToDrive=async()=>{fx.lark.calls.push({op:'move',args:[NODE]});return {state:'running',taskId:TASK};};
  const next=await fx.service.moveToDrive(OBJ,{confirmValue:deriveMoveOutConfirmValue(NODE)});
  expect(next.state).toBe('moving');
  expect(fx.lark.calls.filter(c=>c.op==='move')).toHaveLength(2);
  console.log('E05 timeout -> unknown -> second move accepted; move calls=2');
 });
 it('06 parse after move becomes failed not unknown',async()=>{
  const fx=fixture({moveError:new LarkCliError('bad JSON','parse',false)});
  await expectMoveError(fx.service.moveToDrive(OBJ,{confirmValue:deriveMoveOutConfirmValue(NODE)}));
  expect(fx.store.getLatestCloudMove(OBJ)?.state).toBe('failed'); console.log('E06 move parse -> failed');
 });
});
'''
cases['cloud-history'] = r'''
describe('T4b history counterexamples',()=>{
 it('09 preCloudTime one second newer than anchor still logged exact',async()=>{
  const fx=makeFixture({cloudTime:Math.floor(Date.parse('2026-10-28T02:00:00Z')/1000)+1});
  try {
   const result=await fx.service.revertToAnchor(OBJ,{historyVersionId:'2048'},{confirmValue:'REVERT_CLOUD:2048'});
   const row=fx.store.getSourcePushLog(result.pushLogId)!;
   expect(row.anchorExact).toBe(true);
   console.log('E09 anchor is older by 1 second but anchorExact=true');
  }finally {fx.service.stopPoller(); fx.store.close(); fx.cleanup();}
 });
 it('10 running state persistence failure is swallowed and running gate disappears',async()=>{
  const fx=makeFixture();
  try {
   const update=fx.store.updateSourcePushLogRevert.bind(fx.store);
   fx.store.updateSourcePushLogRevert=((id:any,patch:any)=>{if(patch.revertState==='running')throw new Error('INJECTED transient SQLite write failure'); return update(id,patch);}) as any;
   const result=await fx.service.revertToAnchor(OBJ,{historyVersionId:'2048'},{confirmValue:'REVERT_CLOUD:2048'});
   expect(result.state).toBe('running');
   expect(fx.store.getRunningRevertPushLog(OBJ)).toBeNull();
   console.log('E10 result running; DB running gate=null');
  }finally {fx.service.stopPoller(); fx.store.close(); fx.cleanup();}
 });
 it('06 parse after revert becomes failed not unknown',async()=>{
  const fx=makeFixture({revertError:new LarkCliError('bad JSON','parse',false)});
  try {
   await expectCloudError(fx.service.revertToAnchor(OBJ,{historyVersionId:'2048'},{confirmValue:'REVERT_CLOUD:2048'}));
   expect(fx.store.listSourcePushLogs(OBJ)[0].revertState).toBe('failed');console.log('E06 revert parse -> failed');
  }finally {fx.service.stopPoller(); fx.store.close(); fx.cleanup();}
 });
});
'''
try:
    (tmp/'node_modules').symlink_to(server/'node_modules',target_is_directory=True)
    for name, extra in cases.items():
        source=(server/'tests'/f'{name}.test.ts').read_text()
        prefix=source.split('\ndescribe(',1)[0]
        prefix=prefix.replace("from '../src/",f"from '{server}/src/")
        (tmp/f'{name}.test.ts').write_text(prefix+'\n'+extra)
    (tmp/'vitest.config.mjs').write_text('export default '+__import__('json').dumps({'root':str(tmp),'test':{'include':['*.test.ts'],'environment':'node','globalSetup':[str(server/'tests/global-setup.ts')]}}))
    print('T4b temporary harness:',tmp,flush=True)
    result=subprocess.run([str(server/'node_modules/.bin/vitest'),'run','--config',str(tmp/'vitest.config.mjs'),'--reporter=verbose','--silent'],cwd=server)
    print('T4b temporary vitest exit:',result.returncode,flush=True)
    raise SystemExit(result.returncode)
finally:
    shutil.rmtree(tmp)
    print('T4b temporary files removed:',not tmp.exists(),flush=True)
```
