# 标准库构建：效率与校验拒绝的实测诊断（2026-11-06）

数据来源：`~/.feishu-sync/feishu-sync.db` 的 `kb_builds`，以及 `~/.feishu-sync/agent/builds/<buildId>/epochs/e1/home/sessions/` 下 Leader 与全部子任务 JSONL。
重放脚本：`agent-outputs/kb-build-speedup/analyze-build-sessions.py <buildId...>`。约束：不得降低任何角色的思考强度（writer high / reviewer high / integrator max 保持）。

## 1. 现象（真实构建，均 pi-amagi 编排）

| 构建 | 来源 | 本轮产出文档 | 墙钟 |
|---|---|---|---|
| b_20261105233621_7161f7 | 74 | 26 | 3h08m |
| b_20261105210253_de0b24 | 40 | 20 | 2h33m |
| b_20261105200231_d24019 | 9 | 8 | 1h00m |
| b_20261105185848_086790 | 1 | 12 | 1h04m |
| b_20261105160140_351d4b | 121 | 8 | 1h40m |

约每篇文档 6–8 分钟墙钟。7161f7 共 71 次 task_submit、23 次 task_resume；de0b24 共 60+20，输出 token 257 万。

## 2. 根因（按墙钟影响排序）

### R1 并发池被腰斩：配置 buildConcurrency=6，实际只有 3
`build-runtime-host.ts assembleSpec` 在 writer/reviewer 同模型（`samePool`）时把容量 `floor(max/2)` 同时赋给两个角色；`agent-dir-config.ts` 以 `modelSpecPoolKey` 为键生成 `amagi.json.concurrency.models = {"zhipuai/glm-5.3": 3}`——同模型两角色共用**一个**池，容量 3，而不是 6。实测 7161f7 全程平均并发 2.26（峰值 5），首批 6 个写作任务仅 3 个运行、3 个排队。`contracts.ts validateBuildRunSpec` 的 `poolSum <= maxConcurrentAgents` 把「同池重复计数」当成真实合计，是同一个错误的校验侧。

### R2 修订/复审在 FIFO 队列里排在新写作之后（关键路径延迟）
Leader 超额提交写作任务（队列里常驻 3–10 个）。7161f7：人塔寨综合战术系统的修订 `task_resume` 在 00:15:48 提交，修订会话 00:50:47 才有首个活动——**排队 35 分钟**；多篇文档出现 50–78 分钟的会话空档（等待审查/排队）。amagi 队列在外部包内，应用只能通过派发策略（dispatch-guard / Leader 协议）控制在途数。

### R3 发布门拒绝是「晚发现」：同一构建被拒 4 次，尾部 35+ 分钟空转
7161f7 `build_request_publish`：
1. `kb_validation_failed / source_not_covered ×3`（工作集源既未被文档引用也未列入 skipped）——到申请发布才第一次暴露，Leader 在 build_manifest/checkpoint 里看不到「还有哪些工作集源未覆盖」。
2. `blocking_issue_open ×3`（同一个问题 A5-B1）：作者只做了 `evidenceSelectorUpdates`（改证据列位，selector-only），正文哈希不变；问题关闭绑定「候选内容版本」，新的 pass 复核回执没能关闭它。Leader 先后做了：重登记问题、两次微复核、问题关闭诊断任务、让作者制造一处「忠实性修正」才推进内容哈希，02:07→02:44 共 37 分钟单线程。
3. 另有 `kb_output_owned_by_other_task`（写入资格被旧任务持有，需 Leader 收回/转交）、`kb_output_assignment_conflict`（de0b24）等派发侧摩擦；`task_control accept` 因 settlement=incomplete 缺 waive 被拒。

### R4 作者首稿阻断率高，返工链长
7161f7 的 27 篇里 15 篇首轮 `needs_revision`：常见 blocking = 丢限定词（「如/推荐/示例」被写成通则）、CSV 列位错位（@J↔@I、@G 空列）、bodyRange 未覆盖断言正文、虚构行、链接指向错误文档、七计合并成六项、步骤遗漏。每个返工 = 作者 resume（冷启动重读）+ 新开 diting 定向复核（重新读源）+ Leader 轮次。其中**可机械判定**的（bodyRange 与断言正文位置、selector 指向空 CSV 列、链接目标不存在/不含主题词、覆盖项归属）应在 `kb_write_doc` 即时拒绝而不是等人工审查。

### R5 子任务阅读/重试的回合开销
- 写作者读源平均 20+ 个 `raw_read` 回合，每页 ~120 行；每回合都是一次完整 LLM 往返（含思考）。7161f7 首个写作者：读 5 分钟 + 一次 6 分钟的写入回合（36k 输出 token，其中思考 7 万字符，不动）。
- 工具参数被 schema 拒绝（`additionalProperties:false` 等）后整回合重试：`build_handoff_submit.openIssues` 对象/字符串、`raw_search/draft_search/raw_csv_find/draft_read/kb_read_batch/draft_list` 的别名参数（objToken、queries、path、limit、kind、sourceId、listId…）、`raw_csv_find.queries ≤ 8`、`csvTableImports.columns` 数字/字符串、`kb_edit_doc evidenceClaims.clientKey 重复`、`kb_get_plan` 不在授权名单（协议却提到）。每次 ≈ 一个完整回合。
- `kb_evidence_unresolved`（CSV 选中全空单元格、TextSpan 超出回执范围）在 4 个构建中反复出现。

### R6 其他固定开销
- 预飞：来源冻结 + 图片预描述（73 张刷新失败，已有缓存保留）至 Leader 首个会话约 2–10 分钟。
- Leader 首轮规划以 max 思考 ~3 分钟（不动）。

## 3. 目标与验收（总）

- 吞吐：同模型 writer/reviewer 共享池容量 = `buildConcurrency`（1..6）；Leader 在途任务不超池容量；修订/复审不被新写作拖后。
- 晚发现 → 早发现：工作集未覆盖源、阻断问题关闭条件、身份缺口在 `build_manifest`/`build_checkpoint(status)`/`build_request_publish` 前置预览中可见。
- selector-only / 声明-only 修订必须能经新 pass 复核关闭阻断问题，不需要伪造正文改动。
- 机械可判定的返工项在写入时被拒绝并给出可直接重试的修正提示。
- 工具别名/形状容错：常见误填参数被服务端规范化或给出一次可修复的精确提示。
- 不降低任何思考强度、不放宽质量门禁（独立审查、证据校验、原子发布均保持）。
