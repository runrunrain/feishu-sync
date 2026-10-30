# Phase A1 / P0 实现与自验报告

## 结论

P0 已实现，等待 Leader 与 E0 合并验收；未提交 Git。只修改四个授权源码文件与相关测试，不实施 lex-v1、索引缓存、MCP v2、发布格式或 UI 变更。

## 上游输入

- 完整读取：`/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`，P0 依据 §4.1、§9、§11、附录 A（覆盖率乘子 `0.5 + hits/terms`）。
- 完整读取：`CLAUDE.md`、`docs/design/agent-knowledge-design.md`、`docs/design/kb-agent-upgrade-design.md`。
- 当前任务书约束：P0 与 E0 并行，E0 脚本/fixture 不在本任务写面；不全量测试、不提交。

## Changed files / 规格落点

| 文件 | 改动与验收对应 |
|---|---|
| `server/src/kb/kb-search.ts` | `searchDocs` 改 L1：单元子串匹配、逐单元累计原字段权重、乘以 `0.5 + 命中单元数/全部单元数`，保留部分命中；并列按 path 的 JS 码元字典序；排序后 limit。新增共用 `parseSearchQuery`。原 L0 仅重命名导出 `legacySearchDocs`，签名、算法、旧 locale 排序与片段不变，供 E0 比较。 |
| `server/src/agent/agent-tool-service.ts` | raw_search 共用查询切分，沿用原始库标题/路径/正文权重 10/5/20，加覆盖率。扫描全部候选，按分数降序、relPath 字典序排序后截断，不再提前 break；不向响应增加内部 score。 |
| `server/src/agent/tool-specs.ts` | 只调整 kb_search/raw_search 描述，引导空格分隔 2–4 关键词、引号短语；schema 不变。 |
| `server/src/mcp/kb-mcp-server.ts` | 只调整 search_knowledge 描述；工具集、schema、协议输出形态不变。 |
| `server/tests/kb-search.test.ts`（新） | 16 项 L1 单测：L0 多词零命中与 L1 恢复、覆盖率影响排序、部分命中、去重、短语、标点、ID/数值、单字符、path 并列、limit、空输入、缺正文及异常传播。 |
| `server/tests/raw-search.test.ts`（新） | 9 项真实 AgentToolService.executeTool 入口用例：Discuss/Work/Build 完整扫描排序、覆盖率、反转候选顺序、短语与 ID/数值、源快照变化毒化、symlink 逃逸不泄漏、描述/schema。 |
| `server/tests/mcp-kb.test.ts` | 原四工具协议回归 + 两项 P0 用例：真实 stdio 子进程从发布文件读取多词/短语/ID/数值，验证 limit、并列顺序、响应字段与分隔符空结果；子进程显式传临时 FEISHU_SYNC_HOME。 |
| `agent-outputs/workflow/20261029-kb-retrieval-mcp/p0-report.md` | 本交付报告。 |

新测试语料全部是测试文件中标明用途的合成内容，与 E0 评测 fixtures 独立。

### 实现微决策

- 单元解析保留英文大小写不敏感语义；按空白与设计列出的中英文标点切分；`"…"`、`“…”`、`「…」` 内作为连续短语；重复单元只计一次。未闭合引号按分隔符处理。
- 不拆 `+ - _ . % #`，因此 skill_id、v1.2、hp+10%、atk-5、数字与单字符仍可搜索。
- §5.3 是后续 lex-v1 的规则；P0 不提前加入其单 ASCII 丢弃、8 单元截断、NFKC/Markdown 规范化、词表/bigram 回退。避免在缺陷修复期丢掉已有单字符与数字搜索能力。
- 正文每篇每次搜索只获取一次；片段取正文最早命中的单元，保留既有片段窗口与回退摘要语义。
- raw 读失败仍按原策略只保留元字段分数；`readRawContent` 的快照毒化机制不变。新增测试证明 limit 之后的变化源也被读到并毒化，而不是被提前 break 漏掉。

## 实际验证

所有测试显式用临时 FEISHU_SYNC_HOME 启动；Vitest global-setup 另分配隔离 home，原始库/发布库 fixture 都在系统临时目录，MCP 子进程也显式注入临时 home。未读取或改写真实生产数据。

| 层级 | cwd / 命令 | 实际结果 |
|---|---|---|
| L1 | `server/`：`npm run typecheck` | 退出 0，server tsc --noEmit 通过。 |
| L1 | `server/`：`npm run build` | 退出 0，tsc 与 assets 打包通过；kb-mcp.cjs 521.4 KB、CLI 63.4 KB。均为既有构建产物，未纳入源码变更。 |
| L2 | `server/`：下方精确命令 | 退出 0，4 文件 / 46 测试通过：kb-search 16、raw-search 9、mcp-kb 6、agent-tool-families 15；最终一轮 317ms。MCP 为 SDK 客户端启动真实 Node stdio 子进程，不是协议 mock。 |
| 定向静态检查 | 根目录：`npx eslint server/src/kb/kb-search.ts server/src/agent/agent-tool-service.ts server/src/agent/tool-specs.ts server/src/mcp/kb-mcp-server.ts server/tests/kb-search.test.ts server/tests/raw-search.test.ts server/tests/mcp-kb.test.ts` | 首轮发现新正则 `\[` 多余转义，退出 1；局部去除后复查退出 0。修复后重新执行 typecheck、build、全部上述定向测试，仍通过。 |
| 改动检查 | 根目录：`git diff --check` | 退出 0。 |
| L0 保全 | 根目录：Node 脚本读取 `git show HEAD:server/src/kb/kb-search.ts`，提取原 searchDocs 函数，与当前 legacySearchDocs 仅消除 export 名称差异后逐字比较 | 退出 0，`PASS: legacySearchDocs implementation byte-identical to HEAD searchDocs (export rename only)`。 |

L2 可复现命令（cwd 为 `/Users/run.mao/workpace/feishu-sync/server`）：

```bash
test_home=$(mktemp -d "${TMPDIR:-/tmp}/feishu-p0-final.XXXXXX") && \
FEISHU_SYNC_HOME="$test_home" npx vitest run \
  tests/kb-search.test.ts tests/raw-search.test.ts \
  tests/mcp-kb.test.ts tests/agent-tool-families.test.ts
result=$?
if [ -n "$test_home" ]; then rmdir "$test_home"; fi
exit "$result"
```

额外记录：调查时按猜测读取三个不存在的测试文件路径收到 ENOENT，之后按源码与实际存在的 agent-tool-families 测试确定 fixture 写法，没有把未读取文件当证据。

## 风险映射 / 未覆盖

| 设计项 | 本期状态与剩余风险 |
|---|---|
| F1 多词整串退化 | 针对性测试已覆盖修复；真实语料的 Q2 Recall@10 与其它类别回归由 E0/Leader 阶段 Gate 判断，不能用合成单测冒充检索质量评测。 |
| F2 raw 遍历顺序提前截断 | 已修复，三种运行模式均测晚到高分命中；path 并列独立于输入顺序。 |
| F3 每次重读全部正文 | 按 P0 范围保留；raw 不再提前停止，I/O 会增加，这是完整排序的必要代价。索引/缓存由 P1 处理。本轮未做性能承诺。 |
| C1/C3/C4/C7 | 沿用共用纯函数和 StandardKbStore 文件读取链；未引入依赖/联网/数据库/写盘机制，不改 release/CURRENT 格式或发布链。MCP 真实发布切换回归通过。 |
| 现有读取失败语义 | raw 仍可返回不可读文档的元字段命中（无正文片段），这是保留行为；构建源变化仍 poison，下游发布检查负责拒绝。 |
| 路径排序 | L1 改为不依赖 locale 的码元字典序；单词等分项与旧 locale 排序可能不同，属任务要求的确定性变化。L0 保留旧排序供比较。 |
| 后续设计 | lex-v1、P2、网关、安全矩阵、真实模型/浏览器/Electron、Node20 特定运行验证均未在本期执行；也未运行全量测试。 |

## 工作区保护与回滚

- 开始时源码目标无已有 diff；存在其它未跟踪报告、workflow 目录及 amagi.json。执行中另出现 Leader 的 execution-plan/plan-registry 文件；这些全部只观察、不修改、不暂存。
- 未改 E0 脚本、fixtures，未 commit/stage/push；Leader 负责阶段集成与提交。
- 无数据迁移或发布格式变化。阶段提交后可由 Leader 撤销该 P0 提交；未提交时只按本报告列出的精确 diff 局部逆向编辑四个源码与既有 MCP 测试，确认归属后移除本任务新增的两个测试文件。不要路径 restore/reset 以免覆盖并行工作；回退源码后重新 `npm run build` 更新未跟踪构建产物。
