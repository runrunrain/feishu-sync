# 文档索引

本目录是开发与运维文档的唯一总引；仓库根 [README.md](../README.md) 面向使用者，[CLAUDE.md](../CLAUDE.md) 是 Agent/协作者的仓库契约入口，[CHANGELOG.md](../CHANGELOG.md) 记录版本变更。模块级设计动机以源码头注释为准。

## 开发者入门

| 文档 | 内容 |
|------|------|
| [architecture.md](./architecture.md) | 三层同进程架构、模块地图、进程与令牌域、关键不变量。第一篇 |
| [development.md](./development.md) | 环境要求、双包结构、开发命令、原生模块 ABI、调试入口 |
| [testing.md](./testing.md) | 测试分层、运行命令、编写约定、CI 拆分 |
| [data-contract.md](./data-contract.md) | SQLite 表契约、config.json 各段、Markdown header round-trip |
| [operations.md](./operations.md) | 打包与发布流程、正式回填运维、`server/scripts` 脚本风险分级 |
| [security-model.md](./security-model.md) | 令牌域、批准流、路径围栏、审计文件族与边界声明 |

## 标准知识库与 Agent 工作台

| 文档 | 内容 |
|------|------|
| [agent-knowledge.md](./agent-knowledge.md) | 工作台配置、原始库/标准库关系、Discuss/Work 权限、任务编排、CLI、源编辑写回、只读 MCP |
| [build-orchestration.md](./build-orchestration.md) | 标准库构建编排（pi-amagi）：角色、派发准入、审查与阻断关闭、发布就绪、证据回执 |
| [build-operations.md](./build-operations.md) | 构建运行态目录、观测、度量与 `build-metrics-report`、失败码处置、进程对账、内置 amagi bundle |
| [claude-runtime.md](./claude-runtime.md) | Claude Code 运行时后端：配置、就绪码、权限映射、与 pi 的差异 |
| [kb-retrieval.md](./kb-retrieval.md) | 标准库检索子系统：索引、排序、查询门面、限流与降级 |
| [kb-lan-mcp.md](./kb-lan-mcp.md) | 局域网只读 MCP：启用、令牌、工具、客户端接入与排查 |
| [kb-evaluation.md](./kb-evaluation.md) | 检索评测方法与 `kb-eval` 脚本 |
| [cli-reference.md](./cli-reference.md) | CLI 命令全表、风险级、退出码与启用方式 |
| [feishu-publish.md](./feishu-publish.md) | 标准库反向发布到飞书 |
| [kb-document-sharing.md](./kb-document-sharing.md) | 指定标准库文档导出 Markdown、内网静态网页分享、链接跳转与返回基准文档 |
| [source-cloud-operations.md](./source-cloud-operations.md) | 原始源的云端操作：历史回滚、移出、重命名与写回 |
| [troubleshooting.md](./troubleshooting.md) | 故障排查 FAQ |

## 设计文档

| 文档 | 内容 |
|------|------|
| [design/agent-knowledge-design.md](./design/agent-knowledge-design.md) | Agent 标准库公共设计与 API/安全契约（基线） |
| [design/kb-agent-upgrade-design.md](./design/kb-agent-upgrade-design.md) | 升级增补：双模型图片理解、并行构建、任务编排、CLI 命令面、源库受控写/写回 |
| [design/kb-lan-mcp-distribution.md](./design/kb-lan-mcp-distribution.md) | 局域网 MCP 分发设计 |
| [design/build-fidelity-eval.md](./design/build-fidelity-eval.md) | 构建保真度评测设计 |

## 报告与计划

- [reports/](./reports/README.md)：现行功能记录与被引用的验证证据（保留/归档规则见其 README）；[reports/archive/](./reports/archive/) 为历史报告。
- [plans/agent-knowledge-workflow.md](./plans/agent-knowledge-workflow.md)：工作台早期工作流计划（已完成，历史）。

## 快速命令（根目录）

```bash
npm run check        # lint + typecheck + 前端/server 全部测试（CI 同口径）
npm run dev:all      # 前端 (:5173) + server (:3001) 并行，浏览器开发
npm run dev:desktop  # 内嵌 server 的 Electron 开发态
```
