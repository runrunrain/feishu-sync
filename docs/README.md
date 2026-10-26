# 开发文档索引

工程治理基线：v0.3.47（2026-10 整理）。本目录是开发文档的唯一宗引；模块级设计动机仍以源码头注释为准（大量「P0-Qx 实测 / 实测 confirmed / 历史教训」标注）。

| 文档 | 内容 | 读者 |
|------|------|------|
| [architecture.md](./architecture.md) | 三层同进程架构、模块地图、进程/启动契约、关键不变量 | 所有开发者，第一篇 |
| [development.md](./development.md) | 环境要求、双包结构、开发命令、ABI gotcha、调试入口 | 日常开发 |
| [testing.md](./testing.md) | 测试分层、运行命令、编写约定、已知问题 | 日常开发 / 提交前 |
| [data-contract.md](./data-contract.md) | SQLite 表契约、config.json、Markdown header round-trip | 改数据层/同步引擎必读 |
| [operations.md](./operations.md) | 发布打包流程、正式回填运维、server/scripts 脚本风险分级 | 发版 / 运维 |

## 报告与计划

- [reports/](./reports/) —— 工程审计与治理报告（含 [archive/](./reports/archive/) 历史报告归档）
- 工程约定速查：仓库根 [CLAUDE.md](../CLAUDE.md)（Agent/协作者的仓库契约入口）

## 快速命令（根目录）

```bash
npm run check        # lint + typecheck + 前端/server 全部测试（CI 同口径）
npm run dev:all      # 前端 (:5173) + server (:3001) 并行，浏览器开发
npm run dev:desktop  # 内嵌 server 的 Electron 开发态
```
