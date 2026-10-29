# 阶段 B 集成验证（P1 + P2 + P3）

基线提交 `8fba395`。上游：engine-report.md；设计完整路径见workflow.md。因默认luban模型不可派发，Leader直接完成P2注册/stdio、E0 lex接线与P3内置工具；不替换配置模型。已隔离实现的P5前端虽已回流主树，但不属于本阶段审核/提交，P5后端尚在独立树。

## 代码边界

- P1：server/src/kb/search/（14文件），kb-search.ts / standard-kb-store.ts / kb-build-service.ts、routes/kb.ts。
- P2：server/src/mcp/kb-mcp-{server,tools}.ts；七工具统一注册、schema验证/旧prefix、instructions、每会话notice、紧凑JSON或有界文本，无structuredContent。
- P3：agent-tool-service.ts / tool-specs.ts / types/agent-knowledge.ts；search路径段/hits、section按旧0基offset分页、kb_grep只读同时登记spec/模式面/族注册，不进入build/task。
- E0接线：kb-eval.ts、scripts/lib/kb-eval-lex.ts，以及评测/MCP/内置/纯引擎/服务/一致性测试；docs/agent-knowledge.md与kb-evaluation.md（后者将更新lex可用说明）。
- 集成额外决策：QueryService统一给transport预留512字符，保持UI/内置/MCP分页和cursor摘要一致；实际响应含notice仍在名义预算内。正文/来源保持资料语义。

## 实际命令与结果

- server `npx vitest run tests/kb-search.test.ts tests/raw-search.test.ts tests/kb-search-engine.test.ts tests/kb-query-service.test.ts tests/kb-search-consistency.test.ts tests/kb-builtin-query.test.ts tests/kb-eval.test.ts tests/mcp-kb.test.ts tests/agent-tool-families.test.ts tests/kb-build.test.ts tests/kb-version.test.ts`：11文件157项通过（1.93s）。包括真实Hono API、AgentToolService能力入口、SDK stdio Node24与ElectronRunAsNode Node20、实际七工具/错误/分页/篡改/版本通知测试。
- root `npm run lint && npm run typecheck`：0；lint仅3个既有非本任务hook警告，无error。strict tsc --allowJs显式覆盖评测CLI及新MCP/内置测试闭包：0。
- 评测真实CLI命令（无生产数据）：`node --expose-gc --import tsx scripts/kb-eval.ts --synthetic-fixture --ranker l1|lex-v1 --out ...`，lex对比l1；另 `--synthetic-mb 10|30 --ranker lex-v1`。所有退出0。完整json/md在 `/tmp/kb-stage-b.fOaCe7/`，各文件可按文档重建。
- tools/list实测5223字符，instructions486字符，工具描述总819字符；全文按非ASCII=1、ASCII=1/4估算2139.75 token（不是精确tokenizer测量），满足2.5k估算目标。

## 合成结果（不是80条真实标注）

12条fixture：产品L1整体Recall/MRR=0.6667；lex=0.9167、SectionHit=0.8333、GrepCompleteness=1（2条）；Q1/Q2/Q3 Recall=1，Q5=0.5，所有类别不低于L1。数据全部synthetic，不能据Q5启动P4或宣称真实门槛通过。

| 正文规模 | 准备含校验/索引 ms | search warm p95 ms | 全页literal grep p95 ms | forced-GC heap增量 |
|---|---:|---:|---:|---:|
| 10MiB | 131.89 | 3.89 | 62.23 | 21.71MiB |
| 30MiB | 377.96 | 7.95 | 486.58 | 63.51MiB |

本机Node24合成规模测量，非冷盘/真实语料/LAN；准备含E0输入校验及共享索引，grep排空产品全部预算页（每页产品重新扫描，所以包括穷举分页开销）。RSS增量约105/221MiB，不能与堆指标混淆。设计§6.5合成性能/堆预算达标；X的真实性能/规模触发条件未观察到。P4和真实阈值冻结仍需真实评测条件。

## 尚未覆盖

无真实标准库/80条问题/Claude Code可用安装/第二台设备；未做实际模型12问人工判分、客户端截断测量、P5真实进程或Electron卡片。全量项目回归留最终D集中跑。以上缺口不得改写为PASS。回滚排序可FEISHU_KB_RANKER=l1；无发布格式迁移。
