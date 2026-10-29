# 知识库离线评测（E0）

入口：`server/scripts/kb-eval.ts`。不启动应用、不连接模型、不读 SQLite、不读取默认用户数据目录。输入只读；合成 release 自动创建在系统临时目录并在成功/失败后清理；输出目录由 `--out` 显式指定，必须不存在或为空，不能在输入 release 内。不改 package-lock。

## 运行

在仓库根目录，使用已有依赖（Node 22.19+ / 24）：

```bash
# 所有演示数据落临时目录。保留 $EVAL 供查看报告；不自动删除调用者指定的输出。
EVAL=$(mktemp -d "${TMPDIR:-/tmp}/kb-eval-results.XXXXXX")
node --expose-gc --import tsx server/scripts/kb-eval.ts \
  --synthetic-fixture --ranker l0 --out "$EVAL/l0"
node --expose-gc --import tsx server/scripts/kb-eval.ts \
  --synthetic-fixture --ranker l1 --compare "$EVAL/l0/report.json" --out "$EVAL/l1"

# 固定种子、精确 10/30 MiB UTF-8 正文；只测性能/内存，不产生质量指标。
node --expose-gc --import tsx server/scripts/kb-eval.ts \
  --synthetic-mb 10 --ranker l1 --out "$EVAL/perf10-l1"
node --expose-gc --import tsx server/scripts/kb-eval.ts \
  --synthetic-mb 30 --ranker l1 --out "$EVAL/perf30-l1"

# 真实人工标注：release-dir 是直接包含 manifest.json、docs/ 的目录，非 standard-kb 根。
node --expose-gc --import tsx server/scripts/kb-eval.ts \
  --release /absolute/standard-kb/releases/r_ID \
  --queries /absolute/private-eval/queries.jsonl --ranker l0 --out "$EVAL/real-l0"

# P1 未接线时明确失败，退出 1，不产生报告；绝不自动换成 L1。
node --import tsx server/scripts/kb-eval.ts \
  --synthetic-fixture --ranker lex-v1 --out "$EVAL/lex-v1"
```

输出：`report.json`（机器可读、逐条排名/漏召回/指标/分母/延迟/可选差值）与 `report.md`（分组汇总、逐条排名及差值）。`--compare` 只接受同 releaseId、manifest 哈希、queries 文件哈希、数据种类的质量报告；不同 release 或改过标签不可直接比较。

退出码：0 完成（**不代表质量门槛通过**），1 输入/完整性/未就绪/执行错误，2 CLI 用法错误。未知、重复、缺值参数都拒绝。`--help` 查看简表。生成中每 100 篇输出进度到 stderr。

## 输入格式与人工缺口

`queries.jsonl` 每行一项；继承设计 §10.1 字段，额外要求来源声明 `provenance`：

```json
{"id":"actual-unique-id","category":"Q2","query":"实际用户问题原文","consumer":"planner","releaseId":"r_ID","relevant":[{"path":"系统/规则.md","section":"规则 › 子规则","grade":2}],"provenance":{"kind":"human","source":"user","annotator":"实际标注者","reference":"私有问题收集记录的定位"}}
```

- `category`：Q1 单术语、Q2 多词、Q3 无空格、Q4 精确 ID/字段/数值、Q5 同义口语、Q6 全貌/跨文档。`consumer` 是 `planner` 或 `programmer`。
- `grade`：2 直接回答、1 相关上下文。文档级 grade 取其章节最大值。章节用 H2 或 `H2 › H3`；引言用空字符串。围栏代码中的标题不作为章节。
- Q4 必须增加非空 `exhaustive:[{"path":"系统/规则.md","line":123}]`，包含所有出现位置；坐标是 `stripStdHeader` 后正文第 1 行起算。输入校验检查路径与行号范围，**不替代人工穷举标注准确性审核**。
- 每条必须绑定实际 releaseId。未知路径、未知章节、无 qrel、重复 id、非法 grade/行号、release 不符直接报错；缺失/被篡改文档同样失败，不静默改变分母。contentHash 复用发布链 `computeSourceHash` 公式及 `resolveInside` realpath 围栏。
- 人工数据 `provenance.kind=human`；`source` 仅允许 `user | session-log | manual-reading`，必须填写实际 `annotator`、`reference`。脚本只验证声明完整，不能证明来源真实性，须独立人工审核。不能把 LLM 生成条目改个标签就当真实来源。
- 合成条目必须 `kind=synthetic`，不与 human 混跑；合成 release 不能标 human。仓库只保存明确 synthetic 的 5 篇/12 条测试数据，**不是设计要求的真实 80 条**。

真实数据存用户指定私有目录或 `<dataRoot>/eval/`，不提交仓库。目标数量 Q1..Q6 为 15/20/10/10/15/10：策划与程序各 20 个真实问题，辅以实际查询日志与阅读后的人工标注；每条标 1–5 个相关章节。E0 当前没有这些人工输入，不能宣称 E0 真实评测或 P0/P1/P4 门槛通过。

## 指标口径

| JSON 字段 | 口径 |
|---|---|
| docRecallAt10 | 前 10 个不同文档覆盖的相关文档数 / 全部相关文档数 |
| sectionHitAt5 | 前 5 文档返回的实际 hits 是否包含 grade=2 对应章节（0/1），不靠正文扫描推断 |
| mrrAt10 | 前 10 文档中第一个相关文档倒数排名；无命中为 0 |
| ndcgAt10 | 文档 grade=max(章节 grade)，gain=`2^grade-1`，discount=`log2(rank+1)`，按理想前 10 归一 |
| grepCompleteness | 实际 grep 全部页返回位置集合与 exhaustive 的交集 / exhaustive 集合；允许超集、不重复计数 |

每组与整体均为逐查询宏平均，`count` 表示可计算项数量。无相关标注/无直接回答章节/无非空 exhaustive，或排序器不具备相关能力时为 `null`（Markdown 为 N/A），不补零、不当 100%。当前 L0/L1 无章节 hits 和产品 grep，SectionHit/Grep 两项都为 N/A；这是真实能力缺口，不是漏算。接入 P1 后由真实引擎填充。单测中的 synthetic adapter 仅验证指标和共享调用契约，不是 lex-v1 运行证据。

## L0 冻结与产品 L1 接线

- `server/scripts/lib/kb-eval-rankers.ts` 导出可直接调用的 `rankL0`、`rankL1`、`createBaselineRanker` 与 `EvalRanker`。
- L0 冻结自 `kb-search.ts@1df5fff3dc540cb6c9e92e8e714018b61cd03663`：整串 trim/lowercase；title includes +100、startsWith +50，path +30、headings +40、summary +20、body +60；原片段截取、localeCompare 并列、1..50 limit 均保留。不会 import 后续已改为 L1 的 `searchDocs` 造成基线漂移。
- L1 在阶段 A 集成时已接到产品显式导出的 `l1SearchDocs` 和 `parseSearchQuery`（`implementation=product-p0-l1`），不另造比较算法。按空白/标点分单元，引号内保留短语，去重、保留 `_ . - + % #`，不提前应用 lex-v1 的 8 单元截断；逐单元 L0 权重之和乘 `0.5 + 命中单元数/总单元数`，片段取正文最早命中，并列按确定性 path 码元顺序。没有 IDF/回退/章节推断/NFKC。早期 E0 报告的独立 L1 数字是历史证据，集成报告使用产品 L1 重跑。
- `evaluate()`（`kb-eval-runner.ts`）接受 `EvalRanker`，是后续 resume 的共享 ranker 接入点。P1 接线时用真实 `KbQueryService` 实例；search 传固定 releaseId/limit=10，把实际 `hits` 原样传入，`supportsSections=true`；grep 必须排空产品游标页并确认完整，失败或 partial 不得伪装完整；close 负责资源释放。不得用参考扫描器补产品 grep 指标。
- lex-v1 当前 CLI 明确 `ranker_not_ready`。不猜尚不存在的 KbQueryService 构造/返回签名；后续同任务 resume 替换这一显式拒绝分支即可，不改业务文件。

## 性能与内存解释

规模生成器 `kb-eval-synthetic.ts` 固定种子 `0x20261029`，由同一 synthetic fixture 扩展，250/750 篇，正文精确 10/30 × 1024² 字节（不含服务端 header）。各文档有确定性不同编号和中文行，manifest 时间固定、路径/哈希确定。规模不是“真实查询集”，报告 `mode=performance-only`，`overall/groups=null`、`rows=[]`。

每次 CLI 独立进程：生成临时文件后，记录内存 → 校验读取 release（`preparationMs`）→ 一轮不计时预热 → 全部查询各 3 次测量；p95 取 nearest rank，不剔除慢样本。记录 Node/平台/CPU、正文大小、manifest/query 哈希、heap/RSS 前后和进程 maxRSS。排序器输出跨三轮不一致即失败。

**可比较边界：**

- L0/L1 没有索引；preparation 是验证装载，不得当作 lex-v1 冷索引构建。合成生成刚写过盘，也不是操作系统冷盘实验。
- L0/L1 warm 每次逐篇读文件、realpath 校验和 contentHash 复核；额外完整性开销纳入时延，不能冒称当前产品端到端性能或纯 CPU 算法性能。
- 内存 delta 是本评测进程观测值（含结果 DTO、校验与查询分配），不是 P1 索引稳态内存。`--expose-gc` 下前后强制 GC；不用该选项时 `gcAvailable=false`，不以此裁定内存预算。maxRSS 包含生成语料阶段。
- `resultCharsP95` 是 ranker 结果 JSON 字符数，不是 MCP 响应预算验证。无产品 grep 则不产生 grep p95。
- 后续 P1 必须另测真实构建/稳态堆增量和真实服务 grep，才可对照设计 §6.5 的预算；当前任何合成数字均不直接判真实质量门槛。

## 相关测试

```bash
# server cwd，L1/L2 相关测试；没有全面回归或真实用户数据访问
../node_modules/.bin/vitest run tests/kb-eval.test.ts
# root cwd；scripts 不在 server tsconfig.include 内，故显式检查脚本和测试闭包
node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
  --strict --skipLibCheck --noUnusedLocals --noUnusedParameters \
  server/scripts/kb-eval.ts server/tests/kb-eval.test.ts
```

回滚：新增独立脚本、测试、fixture、本文可单独移除；没有业务调用方、配置/数据库/发布格式迁移。评测输出是调用者选定目录，可在确认不需保留后自行清理；不要删除真实 release 或人工标注。
