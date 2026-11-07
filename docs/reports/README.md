# reports/ 保留与归档规则

`docs/reports/` 只保留两类文件：

1. **现行功能记录**：描述当前仍成立的机制与验证边界（如 [kb-source-versioning.md](kb-source-versioning.md)）。
2. **被现行文档引用的证据**：作为声明载体被 `docs/agent-knowledge.md` 或设计文档链接（安全复审、集成记录、设计取舍证据、当前验收记录）。

其余一次性验收、复审过程与阶段性治理报告在收口后移入 [archive/](archive/)：原文不改写历史结论，只修正因移动产生的相对链接。已被新报告完全承接的旧验证记录直接删除（`app-plugin-management.md` 已由 [pi-native-plugin-management.md](pi-native-plugin-management.md) 承接后移除）。

## 现保留清单

| 文件 | 价值 |
|---|---|
| [kb-source-versioning.md](kb-source-versioning.md) | 原始源选择与标准库版本记录的现行功能说明 |
| [agent-knowledge-integration.md](agent-knowledge-integration.md) | 工作台集成证据与真实验证边界声明（agent-knowledge.md 引用） |
| [agent-knowledge-review.md](agent-knowledge-review.md) | 独立安全复审 PASS 记录（agent-knowledge.md 引用） |
| [agent-knowledge-design-research.md](agent-knowledge-design-research.md) | 设计基线引用的方案取舍证据 |
| [unified-models-and-session-composer.md](unified-models-and-session-composer.md) | 模型配置、协议与会话切换的当前验收记录 |
| [pi-native-plugin-management.md](pi-native-plugin-management.md) | Pi 原生插件管理验证 |

## archive/ 归档清单

| 文件 | 内容 |
|---|---|
| [agent-knowledge-backend.md](archive/agent-knowledge-backend.md) | F1 后端切片实施报告 |
| [agent-knowledge-ui.md](archive/agent-knowledge-ui.md) | F2 UI 切片实施报告 |
| [agent-knowledge-review-initial.md](archive/agent-knowledge-review-initial.md) | 历史初审 |
| [agent-knowledge-review-previous-incremental.md](archive/agent-knowledge-review-previous-incremental.md) | 历史增量复审 |
| [agent-knowledge-residual-validation.md](archive/agent-knowledge-residual-validation.md) | 残留修复验证 |
| [agent-knowledge-integration.metadata.json](archive/agent-knowledge-integration.metadata.json) | 集成任务元数据 |
| [default-library-and-model-settings.md](archive/default-library-and-model-settings.md) | 早期默认库与模型设置验收（被 unified-models 承接） |
| [provider-protocol-support.md](archive/provider-protocol-support.md) | 早期接口协议验收（被 unified-models 承接） |
| [engineering-baseline-audit.md](archive/engineering-baseline-audit.md) | 2026-10 工程基线审计 |
| [engineering-governance.md](archive/engineering-governance.md) | 2026-10 工程治理报告 |
| [engineering-governance-review.md](archive/engineering-governance-review.md) | 2026-10 治理复审 |
| [leader-baseline-validation.md](archive/leader-baseline-validation.md) | 2026-10 Leader 基线核验 |
| [kb-source-tree-and-readiness-cache.md](archive/kb-source-tree-and-readiness-cache.md) | 源树与就绪缓存验收 |
| [local-source-cleanup.md](archive/local-source-cleanup.md) | 本地源清理验收 |
| [sidebar-batch-source-actions.md](archive/sidebar-batch-source-actions.md) | 侧栏批量源操作验收 |
| [sidebar-reorder-delete-blocklist.md](archive/sidebar-reorder-delete-blocklist.md) | 侧栏排序/删除/屏蔽验收 |
| [page-spacing-review.md](archive/page-spacing-review.md) | 页面间距审查 |
| [2026-11-04-mcp-feedback-verification.md](archive/2026-11-04-mcp-feedback-verification.md) | MCP 反馈一次性复测（结论已并入 kb-lan-mcp / agent-knowledge） |
| [custom-folder-e2e-verification.md](archive/custom-folder-e2e-verification.md) | 2026-08 自定义归档 e2e 验证 |
| [custom-folder-sync-report.md](archive/custom-folder-sync-report.md) | 2026-08 自定义归档同步报告 |
| [fix-report-20260812-custom-folder-archive-fix.md](archive/fix-report-20260812-custom-folder-archive-fix.md) | 2026-08 自定义归档修复报告 |
| [review-status-diting-m5-20260616.json](archive/review-status-diting-m5-20260616.json) | 2026-06 diting M5 审查状态（引用外部 D:/ 路径，历史事实保留） |
