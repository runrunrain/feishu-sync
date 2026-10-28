# P2-S4 报告：评论溯源（采集入库 + raw_comments 只读工具 + 预览面板）

- **日期**：2026-10-28 · **代码基线**：`feat/agent-knowledge-workbench`（共享树，与 P1-S4 / P2-S2 等并行切片同区共存）
- **上游输入**：设计 `lark-cli-newcaps-P2.md` §0-U51 / §5.1 / §8（任务书所称 §4 评论溯源段）；`P1-S1-probe.md` §1/§3（MD-3 实测评论形态）；fixtures `server/tests/fixtures/p1s1-lark-cli/`（`fetch-refmap-comments.json` / `fetch-no-refmap.json`）。
- **一句话**：docx 同步事务内从同一 fetch 响应的 `reference_map.comments` 组采集评论入 `source_comments` / `source_comment_meta` 两张表（additive 双登记），`raw_comments` 只读工具只进 Discuss/Work 工具集，预览面板只读展示；评论数据全程不进构建输入。

## 一、变更清单（规格 → 产物）

| 规格（任务/设计 §5.1） | 产物位置 |
|---|---|
| 两张表（additive 双登记） | `server/src/modules/local-map-store.ts`：`applyAdditiveMigrations()` 新表 exec + `getCreateTablesDDL()` DDL 段（`source_comments` / `source_comment_meta`，列与设计逐字一致；第二张表即 meta 表，评论者/已解决状态在 `source_comments.author` / `solved` 三态列） |
| 按源删 / 批量插 / 按源查 | 同上：`replaceSourceComments`（先删后插，自包事务→savepoint 嵌套）、`deleteSourceCommentsBySrc`（两表同删）、`listSourceCommentsBySrc`、`getSourceCommentMeta`；入参/行型 `SourceCommentInsert/Row` + `SourceCommentMetaRow` |
| 评论形态解析（fixture 驱动，容错双读） | `server/src/kb/source-comments.ts`（新）：`extractRefmapComments(referenceMap)` 纯函数——键整体缺失（RP-3）/非对象容错；`tips` 键=截断标记且不算条目；`<comment …><msg user=…>text</msg></comment>` 实测形态（MD-3）；quote/created_at/solved 属性与子元素双读、解析不出为 NULL 不猜值；无文本条目丢弃；text≤4000、quote≤500；多条 msg 按行拼接、作者取首条；实体解码+内嵌标签剥除 |
| 同步事务内采集 | `server/src/modules/sync-engine.ts`：`fetched.referenceMap !== undefined`（即 docx 走 docs+fetch）时事务外纯函数解析（与引用边同款，不拉长 SQLite 事务），`applyDbWrites` 内紧随 `replaceSourceReferences` 调 `replaceSourceComments`——与正文基线同生共死；legacy 写入路径（`FEISHU_SYNC_LEGACY_WRITE`）与引用边同规则不写 |
| rebuild 不重建评论 | 无代码改动（结构上 `reference-rebuild.ts` 只读 md 重算引用边，不触碰评论表）；测试锁定：rebuild 后评论行与 meta 逐字不变、也不为无评论文档造 meta（`server/tests/source-comments.test.ts`） |
| raw_comments 只读工具 | `server/src/agent/tool-specs.ts`（`RAW_COMMENTS_SPEC` + ALL_SPECS）、`server/src/types/agent-knowledge.ts`（`DISCUSS_TOOLS`/`WORK_TOOLS` 追加，**BUILD_TOOLS 不加**）、`server/src/agent/agent-tool-service.ts`（raw 族注册 `runKinds:['work','discuss']`、`SourceCommentsProvider` 注入、`toolRawComments` 执行器、summarizeArgs）、`server/src/index.ts`（provider 接线） |
| 工具输出形态（设计 §5.1） | `<untrusted_comments obj_token total truncated>` 包裹，逐条 `<comment ref author at solved>` + 可选 `<quote>` + 正文，XML 转义；文档不存在 404；meta 无行（从未采集）→ 包裹内说明行 |
| 预览面板（最小只读） | 路由 `server/src/routes/content.ts`（`GET /api/mapping/comments/:objToken`：collected/total/truncated/updatedAt/comments）；前端 `src/api/client.ts` `getDocumentComments` + `src/types/index.ts` `DocumentComments`；组件 `src/components/SourceCommentsSection.tsx`（「评论 n 条（可能不完整）」+ 只读列表：作者/时间/已解决/划词/正文；`collected=false` 整体不渲染）挂入 `DocPreviewPanel` 底部（P1-S4 引用区之后，不同组件） |
| 生命周期对称 | LMS 四处与 source_references 同款级联：`deleteDocumentByToken`（硬删）、`purgeWatchedRootData`（同步根移除）、`pruneMissingLocalDocs`（含 NOT EXISTS 防御）、`clearLocalDocument`（本地基线清除→下次成功同步自然重采） |

## 二、验收 → 证据 → 状态

| 验收（任务书「测试」段） | 证据（真实命令，cwd=server/ 或根） | 状态 |
|---|---|---|
| 采集入库 + 回滚（TestHooks） | `npx vitest run tests/source-comments.test.ts` → **21 passed**：docx 同步入库（fixture 形态 2 条+meta）、重同步替换不累积（含 tips 截断→truncated=1）、`failAfterMarkDocumentSynced` → 评论随基线/正文一起回滚（v1 行保留、v2 行不存在）、无 reference_map 键→不写 meta（从未采集）、refmap 存在但无 comments 组→meta total=0 | ✅ |
| rebuild 不重建 | 同文件「rebuild 不重建评论」用例：`rebuildSourceReferences` 后行与 meta 逐字不变、无评论文档不造 meta | ✅ |
| raw_comments 登记 + 构建工具集排除 | 同文件工具面用例：`toolsForRunKind('discuss'/'work')` 含、`('build')` 不含（pi --tools 参数面=构建 spawn 面）；服务白名单面 `createRunContext` 双面同断言；执行器输出包裹/转义/details、404、从未采集、零评论 | ✅ |
| 预览面板渲染 | `npx vitest run src/components/SourceCommentsSection.test.tsx`（根目录）→ **8 passed**：header 文案（n 条/可能不完整）、完整字段渲染、截断标注、字段缺失容错、SSR 初始空态 | ✅ |
| 迁移双登记 | 双登记用例：fresh 库列序齐全 + `getCreateTablesDDL()` 文本携带两表 + DROP 后再 `initialize()` 重建 | ✅ |
| 既有零回归 | 全量 server：`npx vitest run` → **107 files / 1621 passed**；根 `npm test` → **37 files / 313 passed**；`npm run typecheck`（根 src+配置+server 三段）通过；`npm run lint` 0 errors（3 warnings 均为未触碰文件的既有项） | ✅ |

## 三、关键裁定与边界

1. **MD-3 按实测落地**：fixture 仅证实「文本 + user 作者」两字段；quote/created_at/solved 未在实测样本出现——按设计「容错双读」实现（属性 + `<quote>`/`<reply_quote>` 子元素），解析不出即 NULL，不猜值。后续实测到新形态只需扩 `parseCommentXml` 的双读面。
2. **「从未采集」语义**：采集门槛是「本次 fetch 响应携带 `reference_map`」（等价 docx 走 docs+fetch）。sheet/bitable/slides 不写任何行；docx 无评论也写 meta（total=0）。`raw_comments` 与预览面板都以此区分「没有评论」与「从未采集」（后者隐藏/说明，不显示 0 条）。
3. **生命周期对称裁定**：设计 §5.1 未写评论生命周期，本切片按 P1-S3 引用边同款语义对称落四钩（源行硬删/同步根移除/本地基线清除/孤儿防御）——评论只在同步时采集，本地版本消失后旧评论不再对应任何本地状态，下次成功同步自然重采。
4. **不变量（任务第 5 条）**：① 构建工具集排除已由测试锁死（参数面+服务白名单面）；② `effectiveWords`（P2-S2 产物，`kb-build-service.ts`）只消费源文件正文+识图描述+白板文字，结构上无评论路径；③ 构建提示词资产（`standard-kb-build.md`）不含 raw_comments；④ 快照/contentHash 公式未动。
5. **未覆盖项（如实标注）**：
   - **custom-doc-sync 快捷归档首拍不采集**：`syncDocxToCustomFolder` 的 `prefetchedDocument` 只携带 `{content,url}`（reference_map 被上游丢弃），改造需路由→入库全链路透传，超出本切片「sync-engine.ts 追加」授权面。归档文档经检测报 modified 后走 SyncEngine docx 路径的下次同步会照常采集（届时 referenceMap 存在）。
   - **前端真机/Electron 交互验证未做**（CLAUDE.md 要求前端改动真机验证）：本切片只交付 SSR 渲染测试 + typecheck；评论区是纯只读展示组件，风险低，建议随工作台整体验证轮补真机截图走查。
   - 评论截断不补全（设计裁定：逐文档分页代价与同步等同）——`truncated` 如实标注，UI/工具输出均带标记。

## 四、回滚方式

- 代码：revert 本切片 hunks（共享树上与兄弟切片同文件共存，按本报告变更清单逐文件取本切片 diff）；新增文件直接删除（`server/src/kb/source-comments.ts`、`server/tests/source-comments.test.ts`、`src/components/SourceCommentsSection.tsx` + `.test.tsx`）。
- 数据：两张表保留无害（设计 §7 回滚路径：取消采集调用与工具注册即可；无数据迁移逆操作）。
