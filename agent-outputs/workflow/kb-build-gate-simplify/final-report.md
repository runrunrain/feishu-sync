# 标准库构建门禁精简：集成交付

时间：2026-11-05。代码已合入 `/Users/run.mao/workpace/feishu-sync`，未提交 Git，未改生产配置/知识库数据，未安装或重启桌面应用。server 构建产物已更新。

## 已落地

- 新增 `standardKb.strictGates`，默认 `false`。构建创建时冻结；恢复沿用冻结值，缺字段的旧检查点仍严格。设置为 `true` 可对新构建恢复严格校验/精确审查绑定，不回退 flow 提示词。
- 发布质量类问题按显式策略转为 warning：相对链接、重要覆盖项 unresolved、未解释对象移除、默认证据预算、输出体量、正文格式等。未登记规则默认仍阻断；显式预算和证据硬上限保留。
- 写入时修复唯一可确定的同名相对 Markdown 链接，不猜测多候选，不改指定的代码块/code span。覆盖启发式改为提示。
- 新标准模式审查回执绑定正文及对象/断言/关系等主体。只改证据坐标、覆盖去向或部分空白可复用原审查；正文/主体变化仍失效。旧回执与严格模式走原精确规则。
- 本构建中由服务端校验成功的证据记录内存指纹；发布时指纹及冻结资源匹配可省去重复解引用。基线承接、旧恢复、无可信标记或指纹变化仍完整验证。
- Leader 改用 flow 提示词安排派写、独立审查、定向修订和发布；派发范围启发式只给建议。新增 `build_request_publish.skipped`（工作集与理由受校验），不让 skipped 绕过源完整性检查。
- 阶段确定性发布失败提供 `stageBlockedPaths`，同一缓存键可避免重复尝试；复用已保存交接，警告不扩大为新调查。
- 路径/权限围栏、源变化阻断、证据真实性、有效独立审查和 blocking 问题闭环、staging→不可变 release→原子切 CURRENT 等保护保留。

使用说明：`docs/agent-knowledge.md` 的「构建、阅读与来源」。没有新增前端控件。

## 最终验证

| 项目 | 实际结果 |
|---|---|
| 独立增量审核 | `p4b-rereview.md`：PASS；F01/F04 关闭，无新增 finding；独立 server tsc + 313 测试通过 |
| 主树 `npm run typecheck` | 通过 |
| 主树 `npm run lint` | 通过，3 条既有 React hook warning |
| 主树 `npm run build --prefix server` | 通过，提示词/扩展/MCP/CLI 资产重新构建 |
| 主树 `npm test`（前端） | 85 文件，560 测试通过 |
| 后端专项（24 文件，单 worker） | 560 测试通过 |
| 后端全量（单 worker） | 3345 通过、7 失败、19 跳过；7 个失败名称全部在改前基线已复现的 9 项中，无新增失败名称。**全量未全绿** |
| 真实 HTTP 入口端到端 | `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/build-runtime-e2e.test.ts --maxWorkers=1 --minWorkers=1`：3/3 通过。临时数据根、真实 Pi/amagi/桥接/发布，本地 fixture 模型；不是生产资料或真实模型质量测试 |
| diff / 文件核验 | `git diff --check` 通过；主树与 Node 验证工作树的 src、server/src、server/tests、electron 全部逐字节相同 |

证据摘要已留存 `validation-summary.log`，完整命令输出在 `/tmp/kb-gate-integrated-*.log`、`/tmp/kb-gate-api-e2e.log`；改前失败对照 `/tmp/kb-gate-commit-baseline.log`。

后端失败文件为 build-runtime-amagi-live、build-runtime-capability-probe、desktop-server-process、kb-discuss-integration、kb-precheck-integration、source-tree（2 项）。没有删除测试或新增 skip 来过关。

## 集成与环境保护

- 工作树 `.amagi-worktrees/kb-gate-simplify`，补丁基线 `aa69abd4807c6b03e984cf6aaa0c7dcf58b88230`。代码三方合入主树，唯一冲突是恢复提示词；将并行线新增的交接复用/避免无效调查规则保留在精简版本中。
- 主树 `build-runtime-tools.test.ts` 的并行线 priorClaims 回归一并保留；已将最终合并版本同步至测试工作树。
- 主树 SQLite 为 Electron ABI 125，Node 测试需要 ABI 137。没有重建主树原生二进制；后端回归在源码逐字节一致且 Node 依赖已安装的隔离树运行。
- 主树首次 typecheck 因缺少锁文件已声明的类型包失败；从相同 lockfile 安装的隔离树补回 `@types/archiver@5.3.4`、`@types/unzipper@0.10.11`、`@types/readdir-glob@1.1.5` 后通过。未改 package.json/lockfile。
- 集成前逐文件备份及主树/隔离树 SHA 校验清单：`/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-gate-final-7y00bxzb`。最终文件哈希：`integrated-files.json`；补丁：`/tmp/kb-gate-simplify.patch`。不要整体回退 aa69abd 或覆盖并行线改动。

## 明确保留项与风险

1. **历史问题归因仍保守**：无法证明在 CURRENT 已存在且完全属于承接面的结构问题继续阻断；会遗留未展开 include 的编译错误不作 warning 放行。没有实现 P2 设想的全部历史问题降级。
2. **失败记忆未完全共享**：当前限于阶段发布的确定性失败，键仍覆盖整个候选，可能被无关变化失效；最终发布尚未与阶段发布共用路径级缓存。没有承诺每篇同一问题只检查一次。
3. **审查复用的质量取舍**：能解析但不支持原断言的替换证据，以及不改变正文的断言坐标重指向，不自动触发重审；这是标准模式的显式取舍。要求逐次重审时启用严格模式。
4. **没有真实模型前后耗时对照**，不宣称提速比例。没有穷举受控并发竞态，也未单独执行 selector-only 编辑后阶段 CURRENT 晋级的全链用例。
5. 应用正在运行的构建继续使用冻结策略/规则；本次没有替换已安装桌面应用或强制迁移正在执行的任务。

## 总验收

- G1 门禁盘点：met（59 条，含实际历史阻塞证据）。
- G2 清理非安全门禁：met，部分结构历史问题保守保留。
- G3 flow 与智能编排：met；失败记忆的完整优化为 partial。
- G4 验证：专项、类型检查、lint、build、入口 E2E 通过；全量有已复现的基线失败，非全绿。
- G5 保护原修改：met（三方合并、哈希检查、备份，无主树提交）。

上游：`p1-gate-inventory.md`、`p2-design.md`、`p3-report.md`（历史执行过程）、`p4-review.md`、`p4b-rereview.md`。
