# workflow：标准库构建提速与校验拒绝治理（unattended）

## 目标与总验收
构建在不降低思考强度/质量门禁的前提下：墙钟显著缩短、发布门拒绝可早发现、阻断问题可被正确关闭、常见工具误用不再浪费回合。
总验收：见 diagnosis.md §3。验证 = 单测/回归 + tsc 基线对照 + 全量 vitest 对基线 + 独立审查（diting）。无法做真实模型整轮计时，不承诺固定倍数。

## 基线（Phase 0）
tsc：3 个既有错误（portable-kb-service.ts 缺 @types）；vitest：3417 pass / 1 fail（tests/bundled-amagi.test.ts，与本任务无关）。better-sqlite3 已 `npm rebuild` 到 Node 24 ABI。

## Phase 1（并行，同树，文件边界隔离）
| 包 | 任务 | 范围 | 状态 |
|---|---|---|---|
| WP-A | 3fb18164 | 同池容量 / 派发准入 / leader 协议 3–5 步 | running |
| WP-B1 | 84a7fa03 | blocking issue 关闭语义（selector-only） | running |
| WP-B2 | 3c7a4d92 | 发布就绪预览 / 写权冲突 / leader 协议第 7 步 | running |
| WP-C | 346de330 | 工具参数容错 + 证据错误自动修复提示 | running |
| WP-D | 4d4ee124 | 阅读回合/首稿机械拦截/作者协议精炼 | running |

## 跨边界链路
1. Leader 派发 → dispatch-guard 准入(A) → amagi 池(A) → 子任务读/写(C,D) → 审查回执 → 问题关闭(B1) → 发布预览/申请(B2)。端到端入口验收：在 mock/夹具 Leader 的构建集成测试（现有 kb-build/pi-amagi 集成测试）上全量回归；无真实模型。
2. 共享文件：agent-tool-service.ts（B1/B2/C/D 不同函数）、leader-protocol.md（A:3–5，B2:7）、frozen 协议 hash 测试。集成批由 Leader 合并后统一跑全量。

## Phase 2：集成与审查
Leader 跑全量 vitest + tsc + `npm run build:all`/lint；diting 审阶段总 diff（高风险：调度准入、问题关闭、校验放宽）。

## 决策日志
- 2026-11-06：不降思考强度；不改 buildRoles 模型。采用同树并行（无 worktree，node_modules 依赖）。
- 不执行安装到 /Applications（需要用户环境签名与重启，属部署动作；列为未做项）。
