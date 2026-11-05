# 独立审核：共享包导入后差异误报修复（full）

## 结论

**needs_revision**。发现 1 项 Major、1 项 Minor：外部 proof 的合法 SHA/键/值不能证明其 digest 与旧 contentHash 的绑定，定向伪造可隐藏真实正文变化；另外，已导入旧 release 在第二设备重新导出时会丢失已获得的 proof。

VERDICT: FIX

本结论仅适用于任务指定 7 文件的未提交 diff，不评价并行工作线或整个产品的安全性。

## 基线与输入

- 主树：`/Users/run.mao/workpace/feishu-sync`，HEAD `903f03793d15342481d89e7251d075711d085b7a`；以 HEAD 为 diff 基线。
- 已读 `CLAUDE.md`；上游：`agent-outputs/workflow/kb-share-import-diff/investigation.md`、`agent-outputs/workflow/kb-share-import-diff/fix-report.md`。
- 审核变更仅限 `server/src/kb/{portable-kb-service,source-comparison,kb-build-service,kb-version-store}.ts`、`server/src/routes/kb.ts`、`server/tests/{portable-kb-service,kb-selected-build}.test.ts`。相邻源快照、证据与前端仅追踪消费者，不纳入修改范围。
- 测试前后均逐文件 `cmp`，7 文件与 `.amagi-worktrees/work-local-resources/` 相同；未 rebuild、安装依赖或修改任何项目源码/测试。

## Findings

### F1｜Major｜外部 proof 可以把真实正文修改伪装成语义未变

- **定位**：`server/src/kb/portable-kb-service.ts:306-327`（尤其 322-326）、`:330-346`、`:408-410`；消费链为 `server/src/kb/source-comparison.ts:63-68,77-87`。
- **触发条件**：旧 manifest 条目没有 comparisonHash，接收端没有该键的既有可信 proof。包发送者知道或能预测接收端的另一版本正文，令 proof 的合法旧三元键指向**新正文**的语义 digest，并同步重算 bundle 中 proof 的长度与 SHA256。release 所有文件与 manifest 均可保持不变。
- **实际影响**：导入成功；旧 contentHash 与当前 contentHash 明确不同、正文从 `OLD CONTENT` 变为 `REAL EDIT`，但 `/api/kb/status` 返回 changed=0，`/api/kb/changes` 返回 sources=[]。因此真实待更新被隐藏，UI 的“按这些变更更新”也因空列表禁用（`src/components/kb/KbChangesPanel.tsx:121-122`）。这不是仅伪造一个随机 digest：攻击者直接使用预期当前正文的正确 digest，判等要求“当前 digest 等于 proof digest”恰好被满足。
- **证据（实际复现）**：`agent-outputs/workflow/kb-share-import-diff/review-probe.mts`，通过真实 export → ZIP 修改 → import → 两个 Hono HTTP 入口。运行输出：
  - oldHash=`sha256:2a1dbfa83b738f4a2c3c60533a8421beb8caf61b170457efa552b1d136b13ebe`
  - currentHash=`sha256:3bb6440f8e8face7e87541acc59c35b999601b3728fc0ab456eff437fec8cfeb`
  - importAccepted=true；statusCode=200、pending={added:0,changed:0,removed:0}；changesCode=200、sources=[]。
- **原因**：SHA256 只证明 proof 与同一不可信包里的元数据一致；键白名单只证明其引用的是某旧版本，并没有验证“旧精确字节 → 此语义 digest”。当前文件精确 hash 的检查只能证明新 digest 属于新版本，无法证明它也属于旧版本。任意不知道当前内容的随机伪造通常无效，但不构成对定向伪造的防线。
- **归因与边界**：这是新增外部 proof→本地比较缓存的信任通道。既有 manifest 内 digest 本身也没有发送者认证，但本例**不修改 release manifest 或任何 release 文件**，不能用既有 manifest 风险抵消本次新增通道。未复现构建中途变更校验被绕过；同一 probe 用旧快照调用 readVerified，仍抛 `source_changed_during_build`。应准确区分“隐藏待更新/影响增量判等”和“构建中快照完整性失效”。
- **最小修复方向**：不要把未验证的外部摘要提升为可压制真实变化的本地可信证明。只有能验证绑定时才用于判等，例如携带并校验完整旧源资源、先复算精确 contentHash 再复算语义 digest；或引入明确可信发送者认证/用户信任决策。没有这些依据时保留精确字节比较。仅增加 SHA、三元键或值格式检查不能修复。实施者应补充本 probe 对应的项目回归测试。

### F2｜Minor｜第二设备再导出旧 release 时丢失已导入的有效 proof

- **定位**：`server/src/kb/portable-kb-service.ts:128-141`。
- **触发条件**：A 的旧 release 无 digest；A 导出附带有效 proof，B 导入后仅同步头时间戳与 A 不同。B 不重新构建，直接再导出当前 release 给 C。
- **实际影响**：B 的导出只查看原 manifest.comparisonHash，或尝试让 B 当前字节匹配 A 的旧 contentHash；既没有 digest 又字节不匹配，最终 proof={}。B 上本已消除的误报在 C 重新出现。属于正常转分享链的修复覆盖缺口，不是数据丢失。
- **证据（实际复现）**：同一 `review-probe.mts` 的 `honest re-export from timestamp-only device` 场景输出 `proof:{}`；其中 A→B 是未篡改的诚实包，B 当前正文与 A 相同、仅 fetch_date 不同。C 的退化路径由 `withSourceComparisonBaseline` 无可补值、`addSourceComparisonHashes` 对旧基线无 digest 跳过静态证实；本轮未启动第三套 HTTP 实例。
- **最小修复方向**：解决 F1 的信任区分后，导出端也应消费当前 release 精确三元键对应的**可信**本地 proof，再在确实缺失时补算；不能直接把任意导入缓存全部当可信。补充 A→B→C 转分享回归。

## Full 覆盖清单

| 方面 | 审核结论与依据 |
|---|---|
| proof 有界读取/大小 | schema 2 元数据要求安全整数且 ≤8 MiB，并与 ZIP 声明尺寸相等；readProof 流累计同时限声明大小与8 MiB，最终精确长度+SHA；JSON 不接受 null、数组或标量。结构防线成立，不等于语义可信（F1）。 |
| 键/值/路径 | Object.entries 每项必须属于 manifest 的 JSON 三元键集合，值必须 `v1:`+64位小写十六进制。根级 proof 路径只允许固定名；其他文件必须 release/ 内安全相对路径；重复条目、目录、符号链接/特殊文件均拒绝。无新增路径逃逸路径发现。 |
| schema 1/2 | schema 1 携带 proof 字段或根 proof 文件均拒绝；schema 2 要求对应条目/元数据；条目总数与 release 清单数量联动。没有通过切换 schema 绕过校验的静态路径发现。未做恶意 ZIP 大规模 fuzz。 |
| 合并原子性 | mergeProof 内 read→合并→wx tmp→rename 全为同步操作，无 await；当前单进程并发导入不会在这段中间交错导致缓存 lost update。`{...proof,...previous}` 保留同键本机值。异常捕获在 CURRENT 切换之后，不回滚成功导入；现有失败测试真实写入非法缓存验证此点。 |
| 并发边界 | tmp+rename 不是跨进程 compare-and-swap，两个 OS 进程共享根目录仍可能 read-modify-write 丢更新；仓库契约为单 Electron 主进程内嵌 server，本轮不把未声明的多进程写入保障列回归。未做并发压力测试；整个导入流程原有异步 CURRENT 竞态不属于本次新增同步合并的保证。 |
| 构建补齐 | 新 helper 只跳过合法已有 digest；其余经 resolveInside、visitSourceFiles、sourceComparisonHash 校验完整精确 contentHash 才补算。不匹配/不可读保持无 digest；不改 contentHash。调用点在所选构建继承快照合并之后，符合用途。 |
| 快照/证据绑定 | `build-orchestration.ts:105-115` 明确仅使用 objToken/relPath/contentHash/mediaHash/whiteboardTextHash，**无 comparisonHash**；`evidence-resources.ts:100,168` 绑定 entry.contentHash。`vision-description-version.ts:48-64` 保留该字段。实际 hash 不变测试通过。 |
| 构建中不变量 | `raw-source-snapshot.ts:217-244` readVerified 与 `kb-build-service.ts:7958-8035` 发布前精确校验未修改。probe 明确验证旧快照拒绝当前真实改动；134 测试包含相关构建回归。未执行真实模型构建。 |
| status/changes | 两入口都先 enrichWhiteboardTextHash、prepareSourcePreview，再共同使用 sourceEntryChanged。内容、路径、标题沿用旧 changes 口径；额外独立比较白板旁路 hash，是有意补齐，不是“与旧逻辑逐项完全相同”。无其他新口径不一致发现。 |
| 消费者 | `KnowledgeView.tsx:417-418,592,623,646-650` 用 pending 驱动徽标、确认计数与提示；`KbChangesPanel.tsx:121-122` 使用详细列表启用更新。未发现依赖 imported⇒pending=0 的构建限制或自动触发构建链。无本地源的导入库显示 removed，与 changes 一致，不能理解为包损坏。前端并行线仅静态追踪，未作视觉或真机验收。 |
| 兼容性 | `git show HEAD:...portable-kb-service.ts` 核实旧代码先拒绝非 bundle.json/release/ 根条目（旧行183），且只接受 schema 1（旧行209），所以新包在旧应用明确失败。未运行旧应用。开发分支未发版场景可接受，但旧错误“未知条目”并不解释升级办法。建议增加版本说明/最低接收版本，或提供显式“兼容旧版（无proof）”导出选项；不建议默默移除证明并宣称已修复误报。 |
| 性能/维护 | 正常新增导出顺序重读源，8 MiB proof 有界；构建 helper 对已带 digest 的条目立即跳过。未压测最大数据集；缓存整体历史累计大小并没有8 MiB上限（8 MiB是单包限制），此轮不将既有本地缓存无界读取泛化为新增阻断项。 |

## 测试有效性与实际验证

### 本轮实际执行

1. 主树对上述 7 文件逐个 `cmp` 隔离树，测试前后均退出0；`git diff --check -- <7文件>` 退出0。
2. cwd=`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/work-local-resources/server`：
   ```sh
   AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi \
   FEISHU_SYNC_HOME=$(mktemp -d /private/tmp/kb-review-tests.XXXXXX) \
   npx vitest run tests/portable-kb-service.test.ts tests/kb-version.test.ts tests/kb-build.test.ts tests/kb-selected-build.test.ts tests/kb-whiteboard-text.test.ts --silent
   ```
   退出0；5文件、134测试通过（17+33+38+11+35），4.40秒。没有操作主树 Electron ABI。
3. 同 cwd：
   ```sh
   AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi \
   FEISHU_SYNC_HOME=$(mktemp -d /private/tmp/kb-review-probe-home.XXXXXX) \
   ./node_modules/.bin/tsx /Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/kb-share-import-diff/review-probe.mts
   ```
   退出0；上述 F1/F2 真实复现。probe 仅生成临时 fixture，未编写/修改项目正式测试。现场根：`/private/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-review-probe-LKfbFR`；脚本可独立重跑。

### 可信度与缺口

- 新测试使用真实 ZIP、源文件、哈希、导入和 Hono 入口；所选构建测试使用临时 SQLite 与真实发布/工具路径，模型进程替身不替代待审核 digest/文件行为，因此不是纯自证 mock。
- SHA 错误、非白名单键、声明超限测试有效；但没有断言“白名单合法键+格式合法且 SHA 正确、语义绑定却伪造”的攻击，134通过不能覆盖 F1。
- 保留本机条目的测试覆盖不同旧键；同键冲突优先级来自 spread 的静态证据，未独立并发复现。JSON结构、超实际解压流、zip特殊条目等主要为静态路径核查，不宣称已逐类 fuzz。
- 未独立重跑 typecheck/lint/前端测试、全量 server 测试、真实双设备/Electron/浏览器交互或旧应用。上游相关通过声明不冒充本轮执行结果。

## 产物与回滚

本轮仅写入本目录 `review-report.md` 与 `review-probe.mts`，无源码修复 patch、无项目测试新增。报告无需业务回滚；不再需要 probe 时由授权维护者移除该脚本及其打印的临时 fixture。不要据此清理其他并行工作树或用户数据。

最终结论：**needs_revision**（F1 修复后复审；F2 为非阻断兼容链缺口）。
