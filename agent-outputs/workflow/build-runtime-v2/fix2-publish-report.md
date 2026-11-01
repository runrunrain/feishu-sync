# fix2-publish（R2 修正轮）：F11-R1 发布租约拒绝后 v1 唯一草稿丢失 + F14-R1 Leader 示例用不可达 mcp_call

- 基线：本 worktree `amagi/build-v2-r2-publish`（a776971 dirty-snapshot = 25cc0b4 + 统一修复批 + 用户 WIP）。未复用旧 worktree 代码、未采纳 046 queued 放宽补丁。
- 上游输入：`incremental-review-report.md`（§3 F11-R1 / F14-R1）、`fix-integration-report.md`、`CLAUDE.md`、`kb-build-service.ts`（publishRelease / publishReleaseInner / prepareKnowledgePublish / releaseConfirm / cleanupOldReleases）等模块头与实现。
- 改动 4 文件（未提交）：`server/src/kb/kb-build-service.ts`（+20/-8）、`server/src/agent/skills/knowledge-build/mcp-examples.md`（12 行改写）、`server/tests/build-runtime-publish-cancel.test.ts`（+163）、`server/tests/knowledge-skill-examples.test.ts`（+108/-32）。

## 〇、Leader 拒收与修正说明

R1 轮采用「v1 仍 rename 唯一副本 + catch 内 rename 搬回」。Leader 拒收理由成立：恢复动作自身抛错（或进程在 rename→catch 间中断）时，catch 仍无条件 `rmSync(releaseDir)` 删除唯一草稿；且把硬崩窗口当「既有边界」掩盖了「移动唯一副本」这个根因。**本轮按指示改为根因方案**（§一），R1 的搬回逻辑已全部删除。

## 一、F11-R1 修复（Major，根因方案）

### 根因与修法

根因：v1 发布布局（纯 Markdown，无知识声明）在提交前把 `staging/docs` 整体 `renameSync` 进 `releaseDir`——草稿**唯一副本**离开 staging；此后任何 CURRENT 前失败（提交点租约拒绝/copy 后写 manifest 失败/DB 失败）进入外层 catch，`rmSync(releaseDir)` 连同唯一草稿一起删除。

**修法（提交前不移走唯一草稿）**：`publishReleaseInner` 的 v1 分支把 `renameSync` 改为**逐文件 copy**（`copyFileSync`，walk 已收集的 `docFiles` 全集，含非 .md 文件与子目录）写入 `releaseDir/docs`。要点：

- **staging 原件永不离位**：取消/撤 ctx/超时/异常/进程硬崩任意时刻，草稿原件都在 staging 原位原字节；外层 catch 删的只是**未提交副本**，rmSync 与恢复动作无论成败都无数据丢失面（不再依赖任何"恢复成功"的前提）。
- **租约位点不动**：`preCommitLease` 仍在 CURRENT write 紧前原位（异步准备/编译期间取消窗口仍由提交点兜住），未前移消灭窗口；CURRENT 已提交后失败继续按指针真相收敛（`publishAlreadyCommitted` / releaseConfirm 收敛段原样），不回滚 current、不覆盖他 build 指针。
- **v2 同构**：v2 本就以编译产物生成 release、staging 草稿不动；v1 改为副本后两条路径同一模型——release 只是 staging 的副本/派生物，原子性始终由 CURRENT rename 单点保证（release 目录提交前不被引用，语义与 v2 写编译产物一致）。
- **成功发布后 v1 staging 草稿保留**（与 v2 同语义，供恢复/审计）；`executeLeaderPublishRequest` 发布后 postHash 复核从「v1 必漂移仅告警」变为「无并行写入时一致」，是改善。`writeVersion` 只写 releaseDir 内；`cleanupOldReleases` 仍为提交后尽力而为（内层 try 吞错不冒泡）；D5 governance 重试（`kb_governance_changed` 抛于 prepare，早于任何复制）同 releaseId 重试安全。
- **preparation 失败**（如声明损坏 `kb_publish_blocked`）发生在任何复制之前 → staging 原件本就未动。

仅改 v1 分支 copy 循环、publishRelease catch 注释与 preCommitLease JSDoc；**未触碰** shutdown/cancel/leaderProgress 等 Runtime 兄弟方法面。

## 二、F14-R1 修复（Minor，R1 轮已收，保持）

- `mcp-examples.md`「Leader 工具」段三例由 `mcp_call` 外壳改为**原生直接调用**（`{"tool":"build_manifest","arguments":{...}}` 等），并标注 `mcp_call`/`feishu-kb-bridge` 仅子任务可用；child 段示例未动。
- 测试从「只校验内层 schema」升级为**外层调用者真实生产工具面**校验：`mcp_call` 块内层工具必须在子任务桥真实工具面 `V2_CHILD_ALL_TOOLS`（build-actors.ts）；直接调用块外层工具必须在 `LEADER_TOOL_WHITELIST`（build-runtime-host.ts = amagi 任务面 + V2_LEADER_TOOLS）；生产不变量断言白名单永不含 `mcp_call`、Leader-only 工具不得以 mcp_call 形式出现在任何冻结资产。
- **未给 Leader 增开 mcp_call 权限**（工具面零改动）。

## 三、验证（全部真实执行，cwd=server）

| 项 | 命令/方式 | 结果 |
|---|---|---|
| 定向正负 | `npx vitest run tests/build-runtime-publish-cancel.test.ts tests/knowledge-skill-examples.test.ts` | **21/21**（F11-R1 5 例：v1 拒租约→字节保留+二次发布恢复、v2 拒租约、preparation 失败、manual 取消→保留+重新确认恢复、**cleanup 失败→发布成功+CURRENT 已切+staging 原草稿完整+二次重试成功**；F14-R1 1 例），exit 0 |
| 变异验证 | 把 copy 循环临时换回 `renameSync`（旧根因形态）重跑 F11-R1 组 | **v1 拒租约 / cleanup 失败 / manual 三用例红**（唯一副本被移走即被抓住）；恢复后复绿，MUTATION 残留 0 |
| 复审探针复用 | `publish-lease-probe.mts` 适配本 worktree（仅改导入路径） | 拒租约后 `POST_ABORT {stagingDocs:true, acceptedDraft:true, bytesPreserved:true, release:false, current:false}`（复审复现值全量反转；copy 方案下无任何恢复动作参与） |
| 相关回归 | 复审同批 8 文件 + publishRelease 消费者（e2e/evidence-resources/governance-seam/kb-build/knowledge-publish）+ governance 重试（build-scheduling-supplement）共 14 文件 | **232 通过/3 skip**（1 文件整跳为既有），exit 0 |
| 类型 | `server: npm run typecheck`、根三段 `npm run typecheck` | 均 exit 0 |
| Lint | `npx eslint`（改动 TS 文件） | exit 0 |

测试均为算法层 + mkdtemp 临时目录 fixture；未用生产资料/真实凭据/真实模型；未触碰 `~/.feishu-sync`。

## 四、接口变化与兄弟协调

- **签名零变化**：修复全在 `publishReleaseInner` v1 分支与既有 catch 注释内；F14 为冻结资产内容 + 测试强化。无需兄弟接口报告。
- 行为面提示 Runtime/前端：v1 成功发布后 `staging/docs` 草稿保留（原为移走）；`mcp-examples.md` 属 skill 包六文件合并哈希（`workflowRevision`）——内容已变，**冻结旧 revision 的在途构建续接会被 F12 完整性核验拒绝（设计内 fail-closed），需新 epoch/重新构建**；新构建不受影响。

## 五、未覆盖与已知边界（如实）

1. copy 方案下**不存在**「恢复失败仍删唯一副本」或「rename→catch 硬崩丢草稿」路径——staging 原件任何时刻不离位，本报告不再以此类窗口为边界。仍未覆盖的仅剩：进程硬崩时 `releaseDir` 可能残留半成品副本目录（不被 CURRENT 引用，不影响重试——新尝试用新 releaseId 新目录，残留由 retain 策略的尽力清理回收；数据无丢失）。
2. F14 仅约束冻结示例与测试面；真实 Leader/child 进程内行为由既有 native/e2e 批次覆盖，本切片未跑真实 Pi 进程。
3. Windows 真机、真实模型质量、A23 六源验收不在本切片范围（沿用复审结论）。

## 六、回滚

仅逆向应用本切片净增量 patch，先 `git apply --reverse --check` 核对现场再回退；主树集成副本为 `/tmp/feishu-build-v2-r2/publish.patch`。禁止整文件 checkout/restore 抹去初始用户改动或兄弟修复；回退本增量会恢复「v1 rename 唯一副本」原缺陷，不能作为已验收发布版本。
