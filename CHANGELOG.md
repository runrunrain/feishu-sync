# Changelog

本项目所有显著变更记录于本文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.2.0] - 2026-06-18

### 概要
v0.2.0：增改删三态识别 + 节点树可视化 + LLM 双通道（bigmodel）+ 3 主区中国风精简 UI + B1-B8 清偿。

### Added（feat）

- **变更检测三态识别**：区分 `added` / `modified` / `deleted` 三态，闭环 B1 / B7 / B8，支撑真实增量同步与孤儿文件识别。
- **节点树视图**：左侧节点树（含同级拖拽 reorder、业务标记独立标签），对接 mapping/tree 与 mapping/reorder API。
- **DiffReport API**：新增 `/api/mapping/diff` 端点，输出云端-本地差异结构化报告。
- **`_index.json` 快照**：索引扫描产出快照，加速 mapping/index 视图与一致性校验。
- **sheet 子表映射**：飞书电子表格子表维度的映射存储与同步路径。
- **软删除回收站**：删除项进入回收站（trash）表，可恢复；新增 `/api/trash` 端点。
- **LLM 双通道**：
  - `bigmodel`（GLM-5.2 / GLM-4-Flash，OpenAI 兼容协议）
  - `claude-cli`（主通道）+ `direct` 降级通道
  - 两通道共用一份配置（apiKey / baseURL / model），新增 `/api/llm/test-channel` 端点（响应不含 apiKey 字段）。
- **3 主区中国风精简 UI**：壹同步 / 贰浏览 / 叁设置三主区 IA，印章风格 logo 与水墨基调。
- **ErrorBoundary + Toast**：全局错误边界与统一 Toast 反馈，覆盖 loading / success / warning / error 四态。
- **CSV 表格重构**：五类块（标题/段落/列表/表格/CSV）的渲染统一与重构。
- **索引重建端点**：`POST /api/index/rebuild` 调 `IndexScanner.scanKnowledgeBase` 重建 documents 并刷新 `_index.json`（P5 新增）。

### Changed（refactor）

- 服务端引入 `content-backend` 抽象层与多渠道支持，统一 LLM 调用入口与配置迁移。
- 服务端入口选项重构：`corsDevMode` 显式独立（P5），从单一 `desktopMode` 多义信号中分离。

### Fixed（fix）

- **B4**：前端检测链路接入 config，配置变更实时生效。
- **B5**：`IndexScanner` 三格式头兼容（obj_token / parent_node_token / 双 token 头）。
- **B6**：LLM 失败时使用 `reconstructed` 兜底，避免阻塞同步流程。
- **CORS dev 模式**：standalone 入口 `corsDevMode=true` 放行 vite 5173 preflight；生产 Electron 保持严格白名单（`app://feishu-sync.local`）。
- **P0-bug-2 / 索引重建**：rebuild 端点上线后，DB 中 `empty_title` 由 16 → 0，全部 documents `status=synced`。
- **P1-bug-1 / AppUpdateCard dev 崩溃**：新增 `isDesktopUpdateAvailable()` 函数式守卫，覆盖 5 处 `window.desktop.update.*` 访问点；dev:all 模式渲染占位卡片而非触发 ErrorBoundary。

### Known Limitations / Deferred

- **KB 命名规范（NNN- 前缀）**：Q5 推翻了"强制 NNN- 前缀"的前提（与既有约定冲突），将下轮迭代重新定义。
- **同步块下钻**：Q3 已确认飞书当前 API 无同步块下钻语义，不做处理。
- **claude-cli 通道连通测试**：冷启动较慢（进程启动开销），首次 test-channel 可能超时，建议预热或调高超时上限。
- **P2-bug-1**：`top_level_dirs` 仅识别含 `obj_token` 头的 2 个顶层目录（非完整 4 类），为 KB 命名规范未完成的下游表现，非应用 bug。

### Tests

- 服务端单元测试：96 → 105（新增 CORS 中间件 5 用例 + rebuild 路由 4 用例）。
- tsc / vite build / vitest 全部 PASS。
- P5 端到端 + 重测全部 PASS（CORS preflight / rebuild empty_title 16→0 / AppUpdateCard 浏览器实测）。

### 审核记录

- 谛听（diting）P5-fix 审核：CONDITIONAL_PASS，无 Critical / Major，5 项 Minor 可后续处理。
- I1 红线（`lark-cli-client.ts` 零修改）自始至终保持。

---

## [0.1.0] - 初始版本

- 项目骨架（Electron + Vite + React + Hono + better-sqlite3）。
- 飞书文档拉取与本地镜像基础能力。
- 单一 LLM 通道、基础配置与同步流程。
