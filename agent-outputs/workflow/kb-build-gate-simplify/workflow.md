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
| P1 门禁盘点 | 代码+真实构建记录证据化盘点所有门禁 | baize | - | p1-gate-inventory.md | pending |
| P2 方向设计 | 保留/降级/删除决策 + 新 flow 构建流程 + 提示词 | fuxi 设计态 | P1 | p2-design.md | pending |
| P3 实施 | 按设计改代码、提示词、测试 | luban | P2 | 代码 + p3-report.md | pending |
| P4 审核 | 阶段 diff 对抗审核 | diting | P3 | p4-review.md | pending |

## 跨边界链路
构建入口（UI/CLI `kb build` → HTTP route → KbBuildService → build runtime host/leader supervisor → pi worker 工具 kb_* → validator/precheck → publication release/CURRENT）。端到端责任：P3 luban，验收用 server 测试驱动 build 服务 + 集成测试。

## 决策与修订日志
- 初始：工作树已有主上未提交改动（automatic-recovery/tool-specs 等），所有写入 Agent 须在其上叠加。
