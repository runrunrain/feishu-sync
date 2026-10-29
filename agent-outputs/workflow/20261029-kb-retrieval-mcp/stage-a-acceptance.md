# 阶段 A 验收

上游：本目录 investigation.md / p0-report.md / eval-report.md；用户指定设计原文路径见workflow.md。

## 已交付

- P0多词、引号/ID兼容与覆盖率；raw_search全量评分后排序截断；L0完整保全。
- E0离线CLI、指标、真实来源校验、合成fixture及10/30MiB基准入口。
- Leader集成修正：E0的L1改调产品l1SearchDocs/parseSearchQuery，避免两种L1；旧E0报告是历史独立比较版，最终本次使用implementation=product-p0-l1。
- 相关任务已显式accept；自动全量机器检查缺事实已豁免，最终D统一check，不当作全量通过。

## 验证事实

- server npm run typecheck：0。
- root strict tsc覆盖kb-eval.ts/test闭包：0；定向eslint：0。
- server cwd `npx vitest run tests/kb-search.test.ts tests/raw-search.test.ts tests/kb-eval.test.ts tests/mcp-kb.test.ts tests/agent-tool-families.test.ts`：5文件64项通过，937ms。
- 首次从root以server配置跑测试，因root错误导致No test files found；诊断后仅纠正cwd，未将该错误算成产品失败或通过。
- 两次实际CLI产物：`/tmp/kb-stage-a.7yO2jy/{l0,l1}/report.{json,md}`。12条synthetic：整体Recall/MRR L0=0.5、产品L1=0.6667；Q2 0→1；其他类别无下降。只是修复机制证据，非真实质量门槛。
- git diff --check：0。构建及旧MCP协议证据见p0-report.md。

## 未具备条件

无真实发布/查询日志，80条真实标注与绝对门槛未评估；保持设计先验值、不伪造冻结结论。lex-v1适配/章节/grep由B接线。无生产数据、无配置/DB/发布格式变更。阶段可整体revert。

## 模型决策追溯

主上最新要求后续派发用默认配置；已删除主树和所有worktree角色模型覆盖。C1默认派发仍因gpt-6.1-terra未注册而零模型执行失败，保留其现场树，不擅自换模型。运行中既有任务继续；Leader处理必要集成。
