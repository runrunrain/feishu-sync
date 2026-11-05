# workflow：标准库构建门禁精简与流程优化

自治级别：unattended（主上要求编排模式自主执行）

## 目标与总验收
- G1 盘点标准库构建链路中的全部校验/门禁/阻断点，按「保护数据安全的硬不变量」与「可降级/可删除的过度校验」分类，有代码与真实运行证据。
- G2 删除或降级不必要的阻断（改为警告/让模型自修），保留安全硬不变量（路径逃逸、staging→release→CURRENT 原子切换、源变化阻断、零飞书 token 等 CLAUDE.md 列明契约）。
- G3 构建流程改为以模型智能编排为主：一段 flow 工作流提示词驱动，减少宿主侧强制状态机/多轮门禁往返。
- G4 `npm run check`（或 server typecheck + 相关测试）通过；测试随行为变化同步更新，不靠删测试过关。
- G5 保护工作树中主上未提交的 11 个文件改动（不回退、不覆盖）。

## Phase 表
| Phase | 目标 | Agent | 依赖 | 输出 | 状态 |
|---|---|---|---|---|---|
| P1 门禁盘点 | 代码+真实构建记录证据化盘点所有门禁 | baize 06766d5c | - | p1-gate-inventory.md | accepted |
| P2 方向设计 | 保留/降级/删除决策 + 新 flow 构建流程 + 提示词 | fuxi d6034d33 | P1 | p2-design.md | accepted |
| P3 实施 | 按设计改代码、提示词、测试 | luban 多轮，F01 最终 2cdd59b9 | P2 | 代码 + p3-report.md | accepted（F02/F03 保守剩余项见下） |
| P4 审核 | 阶段 diff 对抗审核 | diting fa1fe255 → 4dc6c875 | P3 | p4-review.md、p4b-rereview.md | accepted：增量复审 PASS，F01/F04 关闭 |
| P5 集成 | 合并主树、保留并行修复、最终验证 | Leader | P4 | final-report.md | done：560 后端专项 + 560 前端 + 3 入口 E2E 通过；全量 7 个既有失败，未提交 |

## 跨边界链路
构建入口（UI/CLI `kb build` → HTTP route → KbBuildService → build runtime host/leader supervisor → pi worker 工具 kb_* → validator/precheck → publication release/CURRENT）。端到端责任：P3 luban，验收用 server 测试驱动 build 服务 + 集成测试。

## 总验收收口
详见 [final-report.md](./final-report.md)：G1/G2/G3/G5 达成，完整失败记忆优化保留；G4 类型/lint/build/专项/入口 E2E 通过，后端全量未全绿（7 个失败均在改前失败集合中）。不宣称真实模型提速比例。

## 决策与修订日志
- 当前：主树与隔离树 src/server/src/server/tests/electron 全部逐字节一致；主树保留 Electron ABI，后端测试使用隔离树的 Node ABI。主树缺少锁文件声明的 @types/archiver、@types/unzipper、@types/readdir-glob，仅补回这三项类型包，未改依赖清单或原生二进制。
- 集成：三方合并仅 resumeBriefing 提示词冲突，保留并行线新增的交接复用、normal 级提示不扩大调查、remove 不虚构后继规则；主树未提交、不改生产数据、不安装桌面包。
- 验收范围修订：F02 对不能证明历史归属或会遗留未展开 include 的结构问题仍阻断；F03 当前只缓存阶段发布的确定性失败（含 kb_restatement_stale），整候选键仍可能随无关变化失效，最终发布未共享缓存。二者作为明确保留项，不声称达到 P2 全规格。
- F01 已按标准模式主体绑定实施并通过独立复审；strict/旧回执保留精确规则。真实 HTTP→Pi/amagi→桥接→发布测试已运行，3/3 通过（fixture 模型，非真实模型质量/耗时测量）。
- 审核连接中断恢复：23bd1ebb fetch failed、3f0bc29b 429 均无报告，最终由 4dc6c875 完成；不把中断当作审核通过。
- P3 首轮后：并行线开始改 review-authority.ts 声明作用域绑定（与 S3 重叠），S3 暂缓只出建议；worktree 先同步主树最新脏改动并做本地基线提交。
- P2 后：主树有并行修复线持续写同批文件（kb-build-service/agent-tool-service 等，19:28 仍在改），P3 改用 worktree(dirty-snapshot) 隔离实施，收尾由 Leader 以 3-way 补丁合回主树。
- 初始：工作树已有主上未提交改动（automatic-recovery/tool-specs 等），所有写入 Agent 须在其上叠加。
