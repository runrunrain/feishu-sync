# A2 / E0：离线检索评测交付

## 结论

评测脚本、独立冻结的 L0/L1、合成 fixture、相关测试、使用说明已交付；已实际跑通两种基线和 10/30 MiB 性能基准。**真实 80 条人工标注缺失，真实门槛未评估；lex-v1 待 P1 接线。合成结果不构成 P0/P1/P4 门槛通过。**

- Worktree：`/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/kb-retrieval-e0`
- 分支：`amagi/kb-retrieval-e0`；冻结基线 HEAD：`1df5fff3dc540cb6c9e92e8e714018b61cd03663`
- 未改业务代码、package-lock；未 git commit/stage/push。未创建 server/node_modules，复用预接入根 node_modules 链接（不纳入集成）。
- 报告严格落在任务机器声明的 worktree 路径，而不是正文较早出现的主树同名路径。

## 上游输入

完整读取：

1. `/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`（1234 行，含 v1.1、附录）
2. 本 worktree `CLAUDE.md`
3. `docs/design/agent-knowledge-design.md`、`docs/design/kb-agent-upgrade-design.md`（依项目约束读取完整正文）

事实入口：`server/src/kb/kb-search.ts`、`standard-kb-store.ts`、`raw-source-snapshot.ts`、`server/src/agent/path-guard.ts`，manifest 类型及测试配置。没有读取真实用户日志、私有知识库或凭据。

## 规格 → 产物

| 要求 | 产物 / 实际行为 | 状态 |
|---|---|---|
| 设计 CLI `--release --queries --ranker --out` | `server/scripts/kb-eval.ts`；直接读 pinned release，输出 report.json/.md；额外支持 --compare、--synthetic-fixture | 已实现并经真实子进程验证 |
| L0 完整复现旧算法 | `server/scripts/lib/kb-eval-rankers.ts`；独立冻结整串匹配、100/50/30/40/20/60 字段权重、原 snippet、localeCompare、1..50 截断 | 已实现，避免 A1 修改导致基线漂移 |
| L1 单元化/覆盖率比较 | 同模块 `e0-l1-units-coverage-v1`；逐单元 L0 权重求和 × `(0.5+coverage)` | 已运行；不声称与未集成 A1 产品实现等价 |
| 可调用共享 ranker 接口 | `EvalCorpus`、`EvalRanker`、`rankL0/rankL1/createBaselineRanker`；runner `evaluate()` 注入 ranker | 已实现，后续 resume 可接真实 KbQueryService |
| lex-v1 未就绪诚实失败 | CLI 在创建任何输出/语料前返回 `ranker_not_ready`，退出 1 | 已验证，无冒充指标 |
| Doc Recall / SectionHit / MRR / nDCG / GrepCompleteness | `kb-eval-metrics.ts`；文档取最大 grade、集合去重、宏平均及 count 分母、N/A、手算指标测试 | 全部口径可计算；L0/L1 无 sections/grep 能力时两项明确 null |
| 分组/逐条 JSON/MD、差值 | `kb-eval-runner.ts`；Q1–Q6、逐条排名/漏召回/分值/延迟/来源/差值、输入哈希、比较一致性守卫 | 已实际输出 |
| 固定种子 10/30MB 基准，只性能内存 | `kb-eval-synthetic.ts`；精确 10/30 MiB UTF-8 正文，250/750 篇；扩展报告 quality=null，无 qrels | 四组基准已运行 |
| 仓库只存 synthetic、不可伪造真实80条 | `server/tests/fixtures/kb-eval/synthetic-corpus.json`（5 篇）和 `synthetic-queries.jsonl`（12 条，六类各2条） | 已遵守，未凑真实数量 |
| 测试与使用说明 | `server/tests/kb-eval.test.ts`、`docs/kb-evaluation.md` | 18 项测试及静态检查通过 |

### 当前排序器能力的诚实边界

L0/L1 的产品契约没有章节 hits，也没有 grep。报告中的 `sectionHitAt5`、`grepCompleteness` 为 **null / N/A，count=0**；没有用读取到的正文推断命中章节，也没有参考扫描替代产品 grep。`scoreQuery` 已能消费真实章节及完整 grep 结果，单测中的 synthetic adapter 只检验这条接口与指标，不代表 lex-v1 已集成。

L1 使用明确命名的独立比较算法，而非 import 正在被 A1 修改的 `kb-search.ts`。本 worktree 未引入 A1 改动；Leader 集成后应核对单元解析/权重/覆盖率，再决定在 resume 接产品共享入口，避免误把独立 L1 比较结果当产品逐字节等价。

输入完整性采用现有 `resolveInside` 和发布相同的 `computeSourceHash`；损坏/缺失直接让本次评测失败，而不是缩小分母。标签必须绑定 release、存在的 H2/H3 章节，Q4 必须有非空 exhaustive。来源声明只能验证完整性，不能代替人工证明来源真实性。

## 实际验证

### 命令与退出状态

根 cwd 均为上述 worktree；测试 cwd 单独标记。

| 命令 / 入口 | cwd | 结果 |
|---|---|---|
| `../node_modules/.bin/vitest run tests/kb-eval.test.ts` | `server/` | 退出 0，18/18；最终运行 583ms，整次 820ms |
| `node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --skipLibCheck --noUnusedLocals --noUnusedParameters server/scripts/kb-eval.ts server/tests/kb-eval.test.ts` | 根 | 退出 0；显式覆盖 scripts/test，因为 server tsconfig 只含 src |
| `node_modules/.bin/eslint server/tests/kb-eval.test.ts` | 根 | 退出 0；scripts 被仓库 lint 配置排除，故另由 strict tsc 检查 |
| 下述 L0/L1 两个真实 CLI | 根 | 均退出 0，报告存在且可解析 |
| 下述 10/30 MiB × L0/L1 四个真实 CLI | 根 | 均退出 0，mode=performance-only，质量指标为 null |
| CLI `--release <临时release> --queries <synthetic jsonl> --ranker l1 --compare <l0> --out <临时目录>` | 测试子进程 | 退出 0；输入路径、来源、差值写入 JSON |
| CLI `--synthetic-fixture --ranker lex-v1 --out <临时目录>` | 测试子进程 | 预期退出 1，ranker_not_ready，输出目录不存在 |
| `git status --short` / `git diff --check` | 根 | 本任务无 tracked 代码修改；收尾观察到并发 `amagi.json` 改动（非本任务，保持不动）；diff --check 退出0；无 staged 文件 |

首次 strict tsc 曾发现一个未使用 import，已局部删除，最终重跑通过。未运行全量 server/root tests、桌面构建、MCP/浏览器/模型调用；本任务仅新增评测侧代码，按要求只跑 L1/L2 相关验证。root `npm test` 的 harness 自动收尾结果不冒称为本轮已执行。

### 可复现的实际基线命令

```bash
EVAL=$(mktemp -d /tmp/kb-e0-final.XXXXXX)
node --expose-gc --import tsx server/scripts/kb-eval.ts --synthetic-fixture --ranker l0 --out "$EVAL/l0"
node --expose-gc --import tsx server/scripts/kb-eval.ts --synthetic-fixture --ranker l1 --compare "$EVAL/l0/report.json" --out "$EVAL/l1"
for size in 10 30; do
  for ranker in l0 l1; do
    echo "progress: ${size}MiB $ranker"
    node --expose-gc --import tsx server/scripts/kb-eval.ts --synthetic-mb "$size" --ranker "$ranker" --out "$EVAL/perf${size}-$ranker"
  done
done
```

本次实际 EVAL：`/tmp/kb-e0-final.fUZAbS`。各子目录均有 `report.json` 和 `report.md`；JSON 保留完整逐条输出，L1 额外含逐条 delta。原始机器报告留临时目录，系统可能回收；以下表格将关键证据永久保存在本 artifact，完整结果可按上述入口重建。临时 synthetic release 已按 finally 清理，没有留下 40MB/80MB 语料在仓库。

测试覆盖：L0 权重/片段/并列/截断/大小写；L1 多词召回与覆盖率/去重/标点/标识符；手算 MRR/nDCG/集合 recall；SectionHit top5/grade2/空结果；grep 超集/重复/部分；null 分母；hash/缺失/逃逸/symlink；release 与标注守卫、围栏假标题排除；10MiB 二次生成哈希一致；真实 CLI 成功/失败/拒覆写；输出不得写入 release（含 symlink 别名）；adapter 接口与非确定排序拒绝。

## 合成质量基线（不是实际用户质量）

环境：Node v24.21.0，darwin/arm64，CPU 字符串 `Apple M6`。release `synthetic-e0-v1`：5 篇，709 字节 UTF-8 正文；manifest hash `sha256:2e6b5c91899ce3b92c2dbbc04adc4bd8f72d7bcd94284693eadeba0fb9cba37c`。

每类2条，共12条；SectionHit/Grep 所有分组均为 N/A，不补零或百分百。

| 分组 | L0 Recall@10 | L1 Recall@10 | L0 MRR@10 | L1 MRR@10 | L0 nDCG@10 | L1 nDCG@10 |
|---|---:|---:|---:|---:|---:|---:|
| Q1 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| Q2 | 0.0000 | 1.0000 | 0.0000 | 1.0000 | 0.0000 | 1.0000 |
| Q3 | 0.5000 | 0.5000 | 0.5000 | 0.5000 | 0.5000 | 0.5000 |
| Q4 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.8984 | 0.8984 |
| Q5 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| Q6 | 0.5000 | 0.5000 | 0.5000 | 0.5000 | 0.5000 | 0.5000 |
| 全部 | 0.5000 | 0.6667 | 0.5000 | 0.6667 | 0.4831 | 0.6497 |

### 逐条摘要

以下 Recall 与 MRR 在这12条中恰好相同；nDCG 唯一不同的是 q4a（两排序器均0.7967），其余等于表中命中值。

| ID | 查询 | L0 Recall/MRR | L1 Recall/MRR | 实际变化或限制 |
|---|---|---:|---:|---|
| synthetic-q1a | 暴击 | 1 | 1 | 均命中伤害文档 |
| synthetic-q1b | 宠物 | 1 | 1 | 均命中宠物文档 |
| synthetic-q2a | 宠物 升星 消耗 | 0 | 1 | L1 宠物第一，消耗规则第二；覆盖率优先 |
| synthetic-q2b | 暴击 结算顺序 | 0 | 1 | L1 恢复伤害文档 |
| synthetic-q3a | 暴击伤害结算顺序 | 0 | 0 | 尚无词表回退，不假装解决 |
| synthetic-q3b | 宠物升星消耗 | 1 | 1 | 正文恰有连续子串 |
| synthetic-q4a | 1001 | 1 | 1 | 商店在伤害前，直接答案 grade2 未居首，nDCG=0.7967 |
| synthetic-q4b | skill_id | 1 | 1 | 均命中伤害文档；不是 grep 完备证明 |
| synthetic-q5a | 血量 | 0 | 0 | 文档用生命值，词汇失配 |
| synthetic-q5b | 暴击伤害怎么算 | 0 | 0 | 口语改写未解决 |
| synthetic-q6a | 公会系统有哪些玩法 | 0 | 0 | 长句未解决 |
| synthetic-q6b | 公会 | 1 | 1 | 两篇均召回 |

合成 Q2 的改善只证明可复现的 F1 触发机制被此 L1 比较版消除，不证明真实查询显著提升，不能据此确认绝对阈值或启动 P4。

## 10/30 MiB 规模基准（只性能/内存）

种子 `0x20261029`，固定 6 条基准字符串，一轮全量预热后各3次，共18个测量样本。10MiB 精确10,485,760正文bytes/250篇，30MiB精确31,457,280正文bytes/750篇。每次独立 CLI 进程；开启 forced GC。

| 大小 / ranker | 验证准备 ms | warm search p95 ms | heap delta MiB | RSS delta MiB |
|---|---:|---:|---:|---:|
| 10MiB / L0 | 26.047 | 24.917 | 0.482 | 110.281 |
| 10MiB / L1 | 25.998 | 30.188 | 0.494 | 198.813 |
| 30MiB / L0 | 74.840 | 75.439 | 0.807 | 225.219 |
| 30MiB / L1 | 75.291 | 90.260 | 0.821 | 241.828 |

同规模 L0/L1 manifest 哈希一致：
- 10MiB：`sha256:95cb28d6038e894d113bd932e3646a98ad529ac4ed40a1486bf8b3feb0eae064`
- 30MiB：`sha256:9f82f071df99b17d6522aa524269b5ac5601b8afe585fcc7abbe6b151aa87ba6`

**解释限制：**

1. L0/L1 无索引，准备包含读取/完整性校验，不是 lex-v1 冷索引构建；语料刚生成也不是冷盘实验。
2. warm 包含每次逐篇 realpath、读文件、contentHash复核，额外校验成本一并计入；不冒充现有产品端到端性能。
3. heap delta 包含本评测器的 retained 对象，不能拿不到1MiB的数字宣称 P1 索引内存达标。RSS 增量明显较大（110–242MiB），保留如实观测；它含 Buffer/分配器/V8 已扩展堆页，不等于常驻索引大小。本轮没有做内存归因或调优。
4. 无产品 grep，grep p95 仍为 null；没有以 reference grep 代测。
5. `resultCharsP95` 仅计 ranker DTO，不是 MCP 响应预算验证。P1 §6.5、P2 预算与 MCP 端到端尚未验收。

## 未闭合项与剩余风险

| 缺口 | 已确认事实 / 后续输入 |
|---|---|
| 真实80条与人工来源 | 当前无真实用户/日志/阅读人工标注。需私有 release 及 Q1–Q6=15/20/10/10/15/10 的实际来源与章节标注；脚本不能替代人工产生 |
| 门槛冻结 | 设计 §10.3 的绝对阈值仍待真实基线后由 Leader 确认；所有报告 gateStatus=not-assessed |
| lex-v1 产品接线 | P1 KbQueryService 本轮不存在；resume 适配真实构造、releaseId锚定、search hits、完整 grep 分页/partial语义和close，不猜接口 |
| A1 产品 L1 一致性 | 本轮比较版有独立实现版本；集成后须核对/复用真实共享入口，再重新评测 |
| lex-v1 专属正确性 | 回退、IDF、段级片段/表头、regex预算、游标、切换告知等为P1/P2实现后验证，不交空壳或模拟通过 |
| 性能证据适用范围 | synthetic × 本机单进程 × 基线读盘/校验；不代表真实库、P1稳态索引、LAN或Electron体验 |
| 来源真实性 | provenance 可检查缺项，无法自动证明“human”声明属实，真实材料仍需独立审核 |

## Changed files（Leader 集成清单）

全部新增；没有业务文件 patch：

```text
server/scripts/kb-eval.ts
server/scripts/lib/kb-eval-io.ts
server/scripts/lib/kb-eval-metrics.ts
server/scripts/lib/kb-eval-rankers.ts
server/scripts/lib/kb-eval-runner.ts
server/scripts/lib/kb-eval-synthetic.ts
server/tests/kb-eval.test.ts
server/tests/fixtures/kb-eval/synthetic-corpus.json
server/tests/fixtures/kb-eval/synthetic-queries.jsonl
docs/kb-evaluation.md
agent-outputs/workflow/20261029-kb-retrieval-mcp/eval-report.md
```

`node_modules` 是派发前已存在的外部链接，不是本任务改动，不应纳入集成。收尾另观察到 `amagi.json` 删除 agents 配置的并发改动；本任务未写该文件，只读观察并保留，Leader 不应把它归入本任务集成清单。没有 package-lock 修改，没有真实生产数据进入仓库。

回滚：仅局部移除上述本任务新增文件即可，保留主上/并行任务文件和依赖链接；无需改配置、数据库或 release，没有提交需要回退。临时报告目录由调用者按保留需求清理，本轮未删除测试之外的既有内容。

建议下一步：Leader 先集成独立评测切片并核对 A1 L1 契约；P1就绪后 resume 本任务接真实共享引擎。真实80条请走实际采样与人工标注，届时重跑并由Leader裁定质量门槛，不从本合成报告推断真实达标。
