# 原始源选择与标准库版本记录

> 本文是现行功能记录：源参与范围标记、diff 驱动的待更新差异与独立版本入口的实现说明与验证边界。设计契约见 [agent-knowledge-design.md §16](../design/agent-knowledge-design.md)；构建编排见 [build-orchestration.md](../build-orchestration.md)，CLI 侧入口见 [cli-reference.md](../cli-reference.md)。

## 源参与范围标记

标记独立存于 SQLite 的 `kb_source_exclusions` 表（`knowledge_root` + `obj_token` 主键），按原始库根目录隔离。标记只写应用元数据：不改原始文件、不进同步文件头，索引重建与重新同步后保留。

| exclusion_kind | 写入口 | 语义 |
|---|---|---|
| `explicit` 明确排除 | `PUT /api/kb/sources/:objToken` `{included:false}` | 从标准库移除该来源。构建快照与发布前源集合复核一律排除；对已发布来源等同变更集 removed |
| `build_selection` 构建勾选 | `POST /api/kb/sources/selection`（`include/exclude/invert` 批量，1–50000 个 token，单事务完成） | 只收窄全量构建的工作集。按变更更新仍保留已发布来源参与（`retainUnselectedPublished=true`），勾选不等于删除已发布来源 |

- 列表入口：`GET /api/kb/sources`（`q/page/limit` 分页，每行含 `included/excluded/published/pending/referencedBy`）与 `GET /api/kb/sources/tree`（按飞书父子关系投影的树）。
- 排除已发布来源 → 待更新差异与变更集按 removed 处理；恢复参与 → 按 added 重新处理。`POST /api/kb/sources/selection` 校验库根一致（变化返回 409 `source_selection_changed`）与 token 有效性（404 `source_not_found`）。
- 构建进行中修改选择被 409 `kb_build_running` 拒绝；恢复断点的构建沿用冻结源集合，不重新扫描当前文档。
- 选择谓词（`kb/source-selection.ts` 的 `selectKnowledgeSources`）：explicit 排除始终出局；云端删除（`cloudDeleted=1` 或 `deleted_confirmed`）只排除未发布源——已发布来源即使观测到云端删除，只要本地成功版本仍在就继续参与；未勾选但已发布的来源按模式决定去留。

## 待更新差异（diff 驱动）

`GET /api/kb/changes` 比较当前本地源与基线发布快照：

- 基线 = `CURRENT` release 的 `manifest.sourceSnapshot`；`withSourceComparisonBaseline` 仅为基线条目回填导入时缓存的语义比较证明（comparisonHash），不切换基线版本，导入发布的祖先链衔接见下文版本可见性。
- 变更判定：`relPath`、`title`、`whiteboardTextHash` 任一变化，或源内容变化。内容变化以 `contentHash`（精确字节 hash）为初判：字节不同但 `relPath`/`objType` 相同且语义比较摘要 `comparisonHash` 相等（换行、导出时间、CSV 顺序等表示差异归一后一致）时不判 changed；旧发布无 `comparisonHash` 时按当轮读取验证的字节匹配豁免。图片理解启用时另比 `mediaHash`（`contentHash` 公式不变，旧 manifest 无 `mediaHash` 视为未变）。比较只基于本地已落盘字节，云端观测状态不参与。
- 返回：基线 releaseId、每个源的逐行 diff（`added/changed/removed`，removed 区分 `excluded`/`missing` 原因）、受影响文档清单、图片维度统计（`total/uncached`）。
- 旧发布只有 hash 没有历史原文时，该源 `beforeAvailable=false` 并明确提示，不用当前内容伪造旧 diff。
- 源 diff 会进入构建提示，但模型必须读取完整当前源，不能凭截断差异补写；无变化时不新建发布。

## 独立版本入口

- 每个新 release 在 docs 正文目录之外写两份文件（`kb/kb-version-store.ts`）：`source-contents.json`（源原文快照，CSV 附件以分隔标记拼入）与 `changes.json`（父版本、发布时间、说明、源差异、标准文档差异、`mergedInto`）。写入在 CURRENT 切换前完成，失败沿发布事务终止，不发布半成品。
- 入口：`GET /api/kb/versions`（保留版本列表与差异数量，含 `retainReleases`）与 `GET /api/kb/versions/:releaseId`（变更详情）。releaseId 做格式校验与 realpath 围栏，路径逃逸返回 null。
- 版本可见性 = `CURRENT` 祖先链（每步校验 manifest 自洽，链深上限 50）：崩溃遗留的孤立 release 不算成功发布历史。
- 文档路径合并去向 `mergedInto` 只来自构建期的文档级合并声明，当前唯一入口是 legacy 单批编排的 `kb_finish.docMerges`（旧 path → 目标 path 数组，目标必须存在于本版）。Pi 编排的 `kb_edit_doc.objectMerges` 与 `build_register_migrations` 登记的是知识对象迁移（对象级合并/拆分/移除），进入对象治理记录，不写入文档级 `mergedInto`。未记录的历史版本返回 `null`，不按共享源或相似标题猜测。
- 正文中的构建元数据头不计入正文 diff；保留策略沿用 `standardKb.retainReleases`（默认 3），父版本被清理后已记录 diff 仍可读。版本范围为父子版本、保留历史与差异查看，不涉及 Git 进程、远程仓库或回滚操作。

## 验证

- `server/tests/kb-version.test.ts`：源选择 → 源 diff → 按变更更新 → 独立版本全链、diff 与正文边界、源选择批量事务、手动删源与标准库更新闭环。
- 相关回归：`kb-selected-build.test.ts`（勾选构建）、`portable-kb-service.test.ts`（导入恢复的基线衔接）、`knowledge-seam.test.ts`。
- 本机 MCP / HTTP 入口的真实验证边界统一声明在 [agent-knowledge-integration.md](agent-knowledge-integration.md)，不在本文重复。
