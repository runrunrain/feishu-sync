# fix3：R2-F03-01 完整授权影响面修复（build-runtime-v2）

**结论：FIX 完成。** 同路径移出旧族、objects:[] 删除（含部分删除/clientKey 重绑定）、kb_delete_doc 全部纳入同一族排他判据；装配期与最终同步提交前复核**同一完整冻结集合**（旧族+新族+旧 canonical），并按 Leader steer 补强**基线漂移守卫**（提交前证明旧声明/索引基线未在 await 期间漂移，漂移即拒绝、不覆盖他人登记）；最后核权→落盘无 await。显式授权的合法移族/删除/迁移/重绑定正例全部保留，未禁用任何功能。

## 一、上游输入（均已完整读取）

- `agent-outputs/workflow/build-runtime-v2/r2-review-report.md`（R2 full Gate；§3 R2-F03-01 Major：授权影响面只收新族，旧族移出/删除可绕过族排他）
- `agent-outputs/workflow/build-runtime-v2/fix2-integration-report.md`（F03-R1 既有防线：装配期检查+提交段重核，但影响面不完整）
- 原反例：`r2-review-evidence/authority-probe.mts`（change-prior-family）/ `authority-delete-probe.mts`（remove-objects，独立初始场景）——只读转正式回归并回放（见 §五）
- 回源：`server/src/agent/agent-tool-service.ts`（模块头/方法注释契约）、`server/src/kb/build-actors.ts`（assignOutputs/activeFamilyAssignmentFor/authorizedForDeclarationTarget）；未改 amagi 上游、未触 kb-build-service/adapter/process-residual。

## 二、缺陷回顾（R2-F03-01）

A 持 a.md 并登记对象 O（族 F）；Leader 把 F 独占分配给 B（a.md 仍归 A）。此前：
1. A 重申 O 但 familyKey 改为未分配的 G → **成功**，O 从 B 的族 F 移到 G（旧族无人核权）；
2. A 直接提交 `objects:[]` → **成功**，属于 F 的 O/clientKey 被删除（removedIds 路径完全不进影响面）；
3. `kb_delete_doc` 删除登记对象的文档，同样不核族授权（Doc 写权事实上覆盖了 Family 排他）。

## 三、修复设计（写面：agent-tool-service.ts，共 10 处编辑）

影响面计算改为**以提交旧基线 → 新状态的实际改写影响**为准：

| 改写形态 | 影响面收集 | 装配期判据（同步段，任何证据 await 之前） | 提交段（assertDeclarationImpactAuthorized，同一冻结集合） |
|---|---|---|---|
| 新对象入族 / 同族重申（含 edit 继承、正文改写对象载荷） | 新族（原有） | 族活动持有人为空或本人（原有） | 同判重核（原有） |
| 同路径重申移出旧族（familyKey 变更，objectId 保留） | **旧族（新）** | **旧族活动持有人为空或本人（新）** | **同判重核（新）** |
| objects:[] 整体删除 / 部分遗漏重申删除 / clientKey 重绑定弃旧对象 | **被删对象旧族（新）** | **同上（新）** | **同判重核（新）** |
| 跨路径重申/迁移（含同时改族） | 旧 canonical+旧族（crossPathMigrations，原有） | 写者持旧主文档或旧族分配（doc-or-family 双通道，原有） | 同判重核（原有） |
| kb_delete_doc 删除登记对象的文档 | 该路径对象按族归并（新） | 无 await 链：核权与 removeFileInside 同处同步段（新） | —（同步链即最终点） |

- **统一判据**：任何改写（含正文变化导致 payloadHash/revision 变化）都不得触及"活动持有人为他人"的族；**Doc 写权不覆盖 Family 排他**；族未分配或归本人 → 照常放行（合法能力保留）。
- **冻结与重核时序**：装配期检查全部位于输入对象循环与 removedIds 计算的同步段（首个证据装配 await 之前）；核权通过后旧族并入 `DeclarationAuthImpact.familyKeys` 冻结集合；提交段顺序为 `assertRunLeaseActive → recheck(身份/代次/分配/发布窗口) → 基线漂移守卫 → assertDeclarationImpactAuthorized → mkdir → 原子写正文 → 声明持久化`，检查与落盘之间无 await。
- **基线漂移守卫（Leader steer）**：`buildKnowledgeDeclaration` 记录装配起点基线签名（`JSON.stringify(base)`，只用于逐字比对，不参与授权判定）；提交段重读当前登记（loadKnowledgeDraft 权威缓存）比对，漂移 → `kb_declaration_baseline_drifted`(409) 拒绝——否则整包保存会覆盖绕锁写者的登记变更（丢失更新），冻结影响面也建立在旧基线上。声明锁串行合法写者，守卫是与锁正交的不变量证明（不能重核旧集合却漏掉基线已变的事实）。
- **objects 三态不混同**：省略 → `kb_object_registry_stale` 门禁（形态判定，不变）；`[]` → 删除面核旧族；非空 → 重申面核新/旧族。
- **edit 继承声明**：inheritDeclarationsForEdit 以同族重申全部同路径对象进入 writeDocCore → buildKnowledgeDeclaration，天然走同一影响面与漂移守卫（"声明未改但正文会改到该族对象"正是该路径：对象族入冻结集，载荷变化 revision+1 也须经族判据）。
- **tombstone 对象**不参与旧族影响面（非活动对象面）。
- 旧模式（无 orchestration）：授权面不设防（既有行为），漂移守卫仍生效（丢失更新保护与模式无关）。

## 四、变更清单

- `server/src/agent/agent-tool-service.ts`（+146/−23 净变更）：
  1. `DeclarationAuthImpact.familyKeys` 注释（完整集合语义）；
  2. `assertDeclarationImpactAuthorized` 注释（判据覆盖旧族）；
  3. `buildKnowledgeDeclaration`：`impactPriorFamilies` 收集（移出/删除旧族）+ 装配期旧族排他核权 + 并入冻结集合 + 返回 `baselineSignature`；
  4. 输入循环：同路径 familyKey 变更加入旧族收集（跨路径分支结构化重排，判据零变化）；
  5. removedIds 计算处收集被删对象旧族；
  6. `toolKbDeleteDoc`：族排他核权（同步段，核权→落盘无窗口）；
  7. `writeDocCore` 终检段：基线漂移守卫（recheck 之后、影响面重核与触盘之前）。
- `server/tests/build-runtime-authority-impact.test.ts`（新增，17 用例）：两原反例回放、旧族/新族 await 窗口竞态、kb_delete_doc 负/正例、edit 继承正例、基线漂移（含未分配族变体）、部分删除、跨 path+改族、clientKey 重绑定、objects 三态、四组合法授权正例。
- `kb/build-actors.ts`：**未改**（activeFamilyAssignmentFor 判据已够用）。

## 五、验证（真实命令与结果）

- 定向：`cd server && FEISHU_SYNC_HOME=/tmp/feishu-build-v2-r3/fsh npx vitest run tests/build-runtime-authority-impact.test.ts tests/build-runtime-toolfix-regressions.test.ts tests/build-runtime-tools.test.ts tests/build-runtime-bridge.test.ts tests/build-runtime-review-authority.test.ts tests/build-runtime-publish-cancel.test.ts tests/agent-internal-auth.test.ts` → exit0，**7 文件 131 pass / 0 fail**（新文件 17 + 既有 F03/F03-R1/F01/F04–F06 等回归全绿）。
- `npm run typecheck`（server）→ exit0；`npx eslint src/agent/agent-tool-service.ts tests/build-runtime-authority-impact.test.ts` → exit0。
- **原反例回放**（probe 脚本仅改 import 指向本 worktree 与夹具根，逻辑零改动；`/tmp/feishu-build-v2-r3/replay-authority-{,delete-}probe.final.log`，exit 0/0）：
  - authority-probe：`change-prior-family ERROR kb_object_not_authorized`（修复前 SUCCESS、revision=2、familyKey=unassigned-new-family）；`remove-objects ERROR`；`oldFamilyOwner b receipts 1`（修复前 2）。
  - authority-delete-probe（独立场景）：`remove-objects ERROR`；`oldFamilyOwner b receipts 1`。
  - 拒绝后正文/声明/索引/回执均无变化（probe 日志 registry 输出 + 测试内逐项断言：对象 familyKey/canonical/revision、draft revision、文件字节、receipts）。
- 静场全量与最终 R2 唯一增量复审：**按指示未跑，留 Leader 统一执行**。
- 全程临时 FEISHU_SYNC_HOME（/tmp/feishu-build-v2-r3/）；未读生产知识库/凭据；未请求远程模型；未提交 Git。

## 六、合法授权正例保留（不靠禁用功能）

1. 旧族未分配：移出（objectId 稳定）、objects:[] 删除、部分删除、clientKey 重绑定、跨路径迁移照常；
2. 旧族归写者本人（装配期已持有或 await 窗口内 Leader 显式授予）：移出/迁移照常；
3. kb_delete_doc：族未分配或归删除者本人 → 照常；
4. 旧模式不设防（既有迁移机制原样，toolfix-regressions f03-legacy 用例回归通过）。

## 七、未覆盖与边界

- 静场全量、Windows 真机、setsid 逃逸、六源 A23 等既有边界维持 R2 报告口径，本轮不签发这些范围的结论。
- 基线漂移守卫依赖 loadKnowledgeDraft 权威缓存（进程内写者全走该入口）；外部进程直改 staging 文件且不失效缓存的场景超出本构建进程的威胁模型（守卫覆盖进程内绕锁写者，锁覆盖合法写者）。
- kb_delete_doc 与在途 kb_write_doc 的文件级竞态（删除后写入复活）不在本切片授权语义内（删除链本无锁、无 await；授权按最后提交状态判）。

## 八、交付与回滚

- 增量 patch：`/tmp/feishu-build-v2-r3/authority.patch`（721 行，2 文件，+614/−23；含正确 new-file hunk）。
  - 自洽性：`git apply --check --reverse` 于当前工作树通过；
  - 可应用性：临时 index（GIT_INDEX_FILE）从 HEAD `git apply --cached` 通过，stat：agent-tool-service.ts +146/−23、新测试 491 行；未动主树/暂存区/其他 worktree。
- 回滚：`git apply -R /tmp/feishu-build-v2-r3/authority.patch`（禁止整文件 checkout 覆盖兄弟/用户 WIP）。
- 本切片未覆盖 R2 其余 3 个 Major（R2-F10-01/02、R2-LC-01）——按任务书不在本切片写面，留 Leader 派发。
