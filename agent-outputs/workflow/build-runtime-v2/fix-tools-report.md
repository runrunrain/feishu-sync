# build-runtime-v2 统一修复批·工具写入正确性/权限切片（F01/F03/F04/F05/F06）

执行者：luban（worktree `amagi/build-v2-fix-tools`，base = dirty-snapshot 8b02ccb = 25cc0b4 + 初始用户改动）。改动未提交，留工作区由 Leader 统一合并。**v2（Leader 复审补丁轮）**：F06 calls 账本载荷哈希核验收口（含 write 侧同类缺口）+ F01 异步准备窗口无部分提交核实。
输入：`agent-outputs/workflow/build-runtime-v2/review-report.md`（完整读取）；原复现 `/tmp/feishu-build-v2-review/{behavior-probe,object-ownership-probe}.ts/.log` 只读复用。
写面（严格在任务边界内）：

- `server/src/agent/agent-tool-service.ts`：revokeToken/revokeBySession/revokeByBuild/createRunContext/InternalRunContext（F01 租约）；assertRunLeaseActive（新，最终落盘前终检）；buildKnowledgeDeclaration 签名+对象影响面守卫（F03）；v2DeclarationAuth（新）；toolKbEditDoc exact_text 字符区间替换（F04）与幂等/稳定键/崩溃重放（F06）；toolKbReadBatch 游标（F05）；stableV2CallKey（新，纯 helper）。
- `server/src/agent/tool-specs.ts`：仅 KB_READ_BATCH_SPEC（requests/cursor 二选一）与 KB_EDIT_DOC oldText 描述。
- `server/src/kb/build-actors.ts`：assignOutputs 冲突探测归一化、activeFamilyAssignmentFor/authorizedForDeclarationTarget（新）。
- 新增测试 `server/tests/build-runtime-toolfix-regressions.test.ts`（26 用例：22 原反例正式回归化 + 4 例 Leader 复审要求场景）。

未触碰：审查提交/发布候选/对象 machine-review 方法（F07/F08/F11 归 22c29fc4）、runtime/host/supervisor/claude-bridge/UI、probe 原件（只读；副本仅改 import 路径与数据根隔离）。

## F01｜取消只撤 token，在途写入仍能提交 — 已修复

- **根因**：`revokeToken` 仅从 `contexts` 表删除（只拦后续 `executeTool`）；已持 ctx 引用的在途调用（声明锁排队/异步证据装配）不再复查令牌，`assertV2WriteWindow` 只查 actor/代次/分配/发布窗口，生产取消链（`revokeToken`，见 `build-runtime-host.ts:996/1010`、`kb-build-service.ts` 多处）不动这些面。
- **改动**：`InternalRunContext` 增加可变撤销租约 `revokedAt/revokedScope`；`revokeToken/revokeBySession/revokeByBuild` 删除前先标记（生产入口原样复用，无调用方改动）；新增 `assertRunLeaseActive`，在 `writeDocCore` 最终落盘点（`atomicWriteFile` 前、v2 recheck 前）终检——v2 与旧模式共用该检查点，`kb_write_doc`/`kb_edit_doc` 都经此（edit 走 writeDocCore lockHeld）。
- **异步准备窗口无部分提交（Leader 核实项，代码证据）**：`buildKnowledgeDeclaration` 入口即深克隆（`JSON.parse(JSON.stringify(base))`，agent-tool-service.ts:2402），异步证据装配（`await resourcesFor`）期间的全部变更只落在私有克隆上；共享面唯一的持久化点是 `saveKnowledgeDraft`（writeDocCore 内、租约终检与 `atomicWriteFile` 之后才调用）；`loadKnowledgeDraft/loadOrganizationPlan/loadReadReceipts` 均只读缓存不落盘。租约拒绝时克隆整体丢弃。本轮并补强：深路径父目录的 mkdir intent 原先在终检前执行（撤销会残留空目录），已移到租约终检之后（mkdir/目标解析/写入/记账全程同步段，无再让出窗口）。残余面如实说明：源快照漂移时 `readVerified` 可能在异步窗口内置 `state.poisoned`（fail-closed 安全标记，非共享声明的部分写入，构建按同码终止）。
- **原反例关闭**：behavior-probe CANCEL 由 `{fileWritten:true, receipts:1, 成功回执}` → `{fileWritten:false, receipts:0, "run_token_revoked"}`（401）。新增 3 个正式回归：revokeToken 锁排队窗口（含新调用 `run_token_invalid`、文件字节/revision/回执不变）、revokeByBuild、kb_edit_doc 在途链。
- **未覆盖**：异步证据装配窗口无独立 fixture（工作簿/图片资源装配链）；该窗口与锁排队窗口共用同一终检点（落盘前单点），由检查点语义覆盖。发布提交点的 Leader context 校验归 Publish 切片（P 可经 `getContext(token)` + 新增的 `revokedAt` 读取同一租约）。

## F03｜文档分配不能阻止跨作者夺取对象身份/主定义 — 已修复

- **根因**：`buildKnowledgeDeclaration` 的 priorId 决策（clientKey/family 三元组命中沿用 objectId）不检查写者对旧主定义路径/对象族的授权；`assertOutputAssignment` 只看目标 docPath。另：`assignOutputs` 冲突探测用剥前缀 family key，而 `activeAssignmentFor` 只认 `family:` 前缀，同族分配互相不冲突。
- **改动**：
  1. 跨路径重申守卫：prior 对象 canonical 在他人文档且写者既无该文档分配、也无 `family:<familyKey>` 分配 → `kb_object_not_authorized`（403）。两条显式授权通道任一命中即放行——**合法跨路径迁移机制完整保留**（objectId 沿用、canonical 迁移、locationRevision 递增不变；旧模式不设防）。
  2. 族排他守卫：声明的 familyKey 已被其他活动任务独占分配时，该族的新对象入族与既有对象重申（含 edit 继承声明）都被拒。
  3. family 归一化：冲突探测改按 `family:<key>` 归一化（`activeFamilyAssignmentFor` 单点收口），两个任务不能再同时持有同族。
- **原反例关闭**：object-ownership-probe 由「B 两次写成功、objectMap 同一 ko_、canonical=b.md revision=2」→ B 的重申抛 `kb_object_not_authorized`，登记/a.md 正文原样、b.md 无部分写入。
- **新增回归（7 例）**：clientKey 夺取拒绝、三元组夺取拒绝、family 显式授权后迁移成功（objectId 稳定）、旧路径显式授权后迁移成功、族排他（新对象入族+同路径编辑重申）、family 分配冲突归一化、旧模式迁移不回归。
- **未覆盖**：`relations/presentations/coverageUpdates` 引用他人对象的影响面未纳入授权面（审核原文即以对象身份/主定义为界，本切片同界）；F08 的对象级审查凭据接缝归 Publish 切片。

## F04｜exact_text 替换把同行未选中内容一起删除 — 已修复

- **根因**：字符偏移只用于推导起止行号，随后按整行 splice，行内 prefix/suffix 与跨行边界残余被静默删除。
- **改动**：exact_text 改为精确字符区间替换（`before + newText + after` 全文重组），`applied` 坐标按「命中首行..命中末行 → 前缀+newText+后缀行数」推导，声明平移（shiftBodyRange）沿用该坐标；heading_body/line_range 语义不变；工具描述补「只替换命中的精确字符区间，同行前后内容保留」。
- **原反例关闭**：behavior-probe EDIT 由 `prefix OLD suffix\nnext line` → `NEW\nnext line` 修复为 `prefix NEW suffix\nnext line`。
- **新增回归（4 例）**：行内前后缀保全、跨行边界保全（applied={2,3,1}）、newText 多行展开并入首尾行（applied={1,1,2}）、对象 bodyRange 随行内加行正确 +1。
- **未覆盖**：无（定位三态其余两态由既有 28 用例覆盖，未动）。

## F05｜批量读取 nextCursor 到达预算后永不前进 — 已修复

- **根因**：cursor 携带 `linesUsed` 并在续页原样恢复，`while (linesUsed < maxLines)` 恒假 → 空结果 + 相同 cursor 死循环；schema `required:['requests']` 又使「单独 cursor 续页」在真实 MCP 端先被拒。
- **改动**：每请求预算重置（cursor 只携带剩余队列与位置 `{queue}`，解码时忽略旧版 linesUsed 字段）；队列项经统一 `normalizeRequest` 校验（kind/objToken/path/offset/limit；长度 1..50，伪造/损坏 cursor → invalid_request）；schema 改 `anyOf:[{required:['requests']},{required:['cursor']}]`（同时携带时 cursor 优先、requests 被忽略，与服务端一致），maxLines/requests/cursor 描述同步。
- **原反例关闭**：behavior-probe BATCH 由 `{secondCount:0,secondUsed:3,sameCursor:true}` → `{secondCount:1,secondUsed:3,sameCursor:false}`。
- **新增回归（4 例）**：20 行源 maxLines=3 全量遍历（每页推进、游标无重复、终页 nextCursor=null、行序恰好一次）、cursor-only 续页（schema 断言 + 服务端实调 + requests 忽略）、draft 请求跨页全量重组、三类坏 cursor 拒绝。
- **未覆盖**：真实 MCP 客户端对 anyOf 的呈现（schema 为标准 JSON Schema；服务端行为已实测）。

## F06｜kb_edit_doc 并发重放不幂等、回执丢失重试缺稳定键 — 已修复（含 Leader 复审缺口收口）

- **根因**：`v2Replay` 在锁外执行，并发同键双双通过后第二个持锁者不重查（重复改/`kb_edit_anchor_not_found`）；`editMeta.toolCallId` 优先采用桥接随机 toolCallId，calls 账本不是稳定 v2 键；回执丢失后的重试先撞 `expectedContentHash`/锚点校验，永远到不了 calls 回放。
- **改动（第一轮）**：幂等预检移入锁内（editOperation 首步，与 kb_write_doc 对齐）；锁内新增崩溃重放第二层——v2 回执丢失时按 `stableV2CallKey(task, operationId)` 查 calls 账本，命中即重放原结果（置于 expectedContentHash 校验之前，避免误报冲突）；v2 editMeta 固定稳定键（非 v2 语义不变：调用侧 toolCallId 优先、缺省 `edit_<operationId>`）。
- **Leader 复审缺口（已收口）**：第一轮的 priorCall 重放只查键存在、不比较载荷——回执丢失后同 operationId 异载荷会假成功返回原结果。本轮修复：
  1. **calls 账本记录可核验语义载荷哈希**：writeDocCore 原子落盘时随 calls 条目记录 `payloadHash`（与 v2 回执同口径，由 v2 调用方经 `options.idempotency.payloadHash` 传入；kb_write_doc/kb_edit_doc 两链都接）。
  2. **崩溃重放前核验**（`verifyCallsLedgerPayload`，edit 预检与 writeDocCore calls 检查两点共用）：同载荷才重放；异载荷 → `kb_idempotency_conflict`（同键不可假成功）；旧代次账本缺哈希 → `kb_idempotency_unverifiable`（409，明确拒绝盲重放，指引换 operationId 重提、原结果以 knowledge-draft/docs 为准）。非 v2 调用侧键重试旧语义不变。
  3. **write 侧同类缺口一并收口**：writeDocCore 的 calls 幂等检查原先同样只查键不比载荷，回执丢失后同键异载荷的 kb_write_doc 也会假重放——同样接入核验。
- **原反例关闭**：behavior-probe EDIT_DUP 由 `{ok:true} + {ok:false, kb_edit_anchor_not_found}` → 双 ok、恰一份 `idempotentReplay:true`。
- **回归（共 9 例，含 Leader 要求的新场景）**：并发同键同载荷（桥接随机 toolCallId 不影响；正文只改一次、一条回执、revision 只 +1）；并发同键异载荷（回执仍在 → `kb_idempotency_conflict`）；顺序不同 operationId 非幂等补丁都生效；**回执丢失后同键异载荷·改 patch**（冲突且正文/声明账本 JSON/revision 逐字节不变、无新回执）；**回执丢失后同键异载荷·改 path**（同样冲突，目标文档未被夺取）；**旧账本缺 payloadHash**（手工剥离字段模拟旧代次 → `kb_idempotency_unverifiable` 明确拒绝，正文/revision 不变）；同载荷崩溃重试仍安全重放（calls 条目携带 payloadHash 断言 + 内容/revision 不变）；**write 侧：回执丢失后同键异载荷冲突 + 同载荷安全重放**（正文/revision 不变）。
- **未覆盖**：无（三层幂等——锁内回执、calls 账本（含哈希核验）、并发互斥——均有断言）。

## 验证证据（cwd=worktree，真实执行）

| 执行 | 结果 |
|---|---|
| `npx tsc --noEmit`（server） | EXIT=0 |
| `npx eslint` 4 个改动/新增文件 | 无输出（0 问题） |
| `npx vitest run tests/build-runtime-toolfix-regressions.test.ts` | 26/26 通过（含回执丢失后同键异载荷改 patch/改 path 冲突、旧账本缺哈希明确拒绝、write 侧同类缺口） |
| 关联回归 14 文件（agent-tool-families/build-actors/build-runtime-bridge/build-runtime-tools/build-runtime-persisted-mode/build-scheduling-supplement/kb-knowledge-tools/kb-lan-config-api/kb-lan-integration/kb-mcp-feedback/kb-search-consistency/knowledge-query/raw-mcp + 新回归） | 205/205 通过 |
| 原反例复跑（behavior-probe / object-ownership-probe 副本指向本 worktree，隔离数据根） | 全部按修复方向关闭（见各 F 节） |

**环境注记**：`tests/protected-workspace.test.ts` 1 例失败（`server/node_modules` 期望 `workspace_path_forbidden` 实得 `workspace_path_invalid`）——已用干净基线 8b02ccb 临时 checkout 复现同一失败，确认为 worktree 可移植符号链接布局（node_modules realpath 逃出 repoRoot）的既有环境现象，与本批改动无关；主树（真实目录布局）不受影响。

## 未覆盖与移交

- `tests/build-runtime-e2e.test.ts` 3 例按前置明确 skip（需 PATH 中的 pi + `AMAGI_PI_SOURCE_DIR`；任务约定不重复安装）。其主链价值在 F07/F08/publish 面与 Leader 主链接线，本切片行为已由直调回归 + 原反例覆盖。
- F01 发布提交点的 Leader context 校验、F03 的对象级审查凭据（F08）归 Publish 切片（22c29fc4）。
- 新增公共签名（供并行切片早知，避免整文件覆盖冲突）：
  - `InternalRunContext.revokedAt?: number | null`、`revokedScope?: string | null`（revokeToken/BySession/ByBuild 置位；发布提交点可用 `getContext(token)` 后读同字段复核）。
  - `BuildActorStore.activeFamilyAssignmentFor(familyKey)`、`BuildActorStore.authorizedForDeclarationTarget(nativeTaskId, {docPath?, familyKey?})`。
  - 新错误码：`run_token_revoked`（401）、`kb_object_not_authorized`（403）、`kb_idempotency_unverifiable`（409，旧代次 calls 账本缺哈希时明确拒绝）。
  - `KnowledgeDraftFile.calls` 条目新增可选 `payloadHash`（v2 写入链原子落盘时记录，崩溃重放核验用；旧条目无此字段触发明确拒绝而非盲重放）。
  - `buildKnowledgeDeclaration` 私有签名 +1 可选参数 `meta`；`writeDocCore` 私有 options 新增 `idempotency?.payloadHash`（内部方法，非对外契约）。

回滚：`git checkout -- server/src/agent/agent-tool-service.ts server/src/agent/tool-specs.ts server/src/kb/build-actors.ts && rm server/tests/build-runtime-toolfix-regressions.test.ts`（仅限本批三文件 + 新测试；不含他人改动）。
