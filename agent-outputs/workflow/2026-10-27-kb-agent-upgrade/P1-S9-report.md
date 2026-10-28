# P1-S9 发布 UI 报告：标准库视图发布流 + 状态徽标 + 发布根设置

> 任务：消费 P1-S8 反向发布 API（preview/执行/列表/详情/target + 状态机），在标准库视图追加发布流（预览→确认值→执行→完成）、四态发布徽标（树/详情/历史 + 云端 URL 跳转）、设置区发布根配置（双向校验错误呈现）与发布历史。
> 设计依据：`lark-cli-newcaps-P1.md` §4.6（UI 段）；上游：P1-S8 报告 §二/§四。

## 一、产物与写面（全部前端 src/**，零 server 改动）

| 文件 | 状态 | 内容 |
|---|---|---|
| `src/types/kb-publish.ts` | 新建 | 发布 DTO 镜像（Plan/Run/Publication/Target/Gates） |
| `src/utils/kbPublish.ts` | 新建 | 纯函数层：状态/动作/阻断原因/警告/门控可读文案 + 选择集扁平化 |
| `src/utils/kbPublish.test.ts` | 新建 | 8 组断言（四态+全状态机文案/门控逐条/警告兜底/派生计算） |
| `src/components/kb/KbPublishStateBadge.tsx` | 新建 | 可复用徽标：四态短标签（树）/全状态长标签（历史详情）；cloudUrl 呈 anchor 或 click（span+开窗，避免 button 内嵌套 a） |
| `src/components/kb/KbPublishPanel.tsx` | 新建 | 侧栏「发布」面板：状态计数 + 最近发布 + 发布/历史/刷新入口 |
| `src/components/kb/KbPublishModal.tsx` | 新建 | 发布流弹窗（四步状态机）+ 发布历史列表；导出 PlanItemsTable/PublishHistoryList 供测试 |
| `src/components/kb/KbPublishModal.test.tsx` | 新建 | 7 用例（SSR：选择步/计划行/历史行/树徽标嵌套合法性） |
| `src/components/FeishuPublishSettingsCard.tsx` | 新建 | 设置卡：enabled 开关（PUT /api/config）+ 发布根粘贴校验（PUT target）/清除（两步确认） |
| `src/components/FeishuPublishSettingsCard.test.tsx` | 新建 | 4 用例（默认关/已配置/依赖提示/配置未加载） |
| `src/api/client.ts` | 追加 | 5 个 API：previewKbPublish / executeKbPublish / listKbPublications / getKbPublication / setKbPublishTarget |
| `src/types/index.ts` | 追加 | `Config.feishuPublish` 段（enabled + target） |
| `src/components/kb/KbTreePanel.tsx` | 追加 | 目录树文档行四态徽标（publicationsByPath prop） |
| `src/views/KnowledgeView.tsx` | 追加 | 侧栏「发布」项（conflict/unknown 红点角标）、发布记录加载、弹窗接线、文档详情「飞书发布」行 |
| `src/views/SettingsView.tsx` | 追加 | 飞书认证组「飞书发布」子项 |
| `src/App.tsx` | 追加 | handleJumpToSettings 扩展 'auth'；KnowledgeView 注入 onJumpToPublishSettings |

## 二、API 消费映射（P1-S8 契约 → UI）

| S8 端点 | UI 消费点 | 关键语义消费 |
|---|---|---|
| `POST /api/kb/publish/preview` | 弹窗预览步（PlanItemsTable） | action 四态徽标、blockedReason→文案、warnings 展开（details）、cloudEdited 标记、gates→逐条问题+「前往设置」、confirmRequired→确认值门、removed→全量模式提示、target→发布根行 |
| `POST /api/kb/publish` | 确认区执行（executeKbPublish） | confirm 精确匹配（PUBLISH/OVERWRITE_PUBLISHED 输入不符禁用）、planKey 回传（409 publish_plan_changed → 错误文案+返回重预览）、counts/逐项 outcome/removedMarked 完成态、actor:'ui' |
| `GET /api/kb/publications` | 树/详情徽标 + 侧栏最近发布 + 历史列表 | state 全状态机徽标、warnings（含 previousCloudTokens）、lastError、cloudUrl 跳转 |
| `GET /api/kb/publications/:kbPath` | client 导出（详情按需；当前 UI 用列表数据） | 路径整体 URL 编码（含 `/`） |
| `PUT /api/kb/publish/target` | 设置卡「校验并保存」/「清除发布根」 | `{url}`/`{target:null}` 形态；409 `publish_target_inside_watched_root`/`watched_root_inside_publish_target`、502 `publish_target_unverifiable`、400 `invalid_request` → 服务端 message + code 附加提示双行呈现 |
| `PUT /api/config`（feishuPublish.enabled） | 设置卡开关 | 服务端合并保留 target（S8 段合并语义）；CLI 主体禁改由服务端强制 |

## 三、真机验收记录（mock 数据，agent-browser 截图为证）

**环境**：standalone server（tsx，FEISHU_SYNC_HOME=/tmp/p1s9-home）+ mock lark-cli（LARK_CLI_PATH 指向脚本：伪造 auth/创建/更新/parse 回读/drive metas 时间门/wiki 祖先解析，`mock hand-edit` 模拟云端手改）+ 种子脚本（真实 renderForPublish 计算 v1 hash 入库：published×2/unknown×1/已移除路径×1；fake 云端 state 预置时间门数据）。截图归档 `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/p1s9-shots/`。

| 截图 | 验收点 | 证据摘要 |
|---|---|---|
| 01-publish-panel | 侧栏发布面板 | 计数「已发布 3/未知 1/共 6 篇」与种子一致；最近发布 4 行徽标正确；主次按钮层级清晰（识图确认） |
| 02-modal-select | 发布流·选择步 | 范围单选（勾选 6/6 ↔ 全量）、勾选清单带现态徽标+云端链接、force 开关说明 |
| 03-modal-preview | 发布流·预览步 | 6 行计划：冲突文档=阻断+「云端有修改」+原因文案；带图文档=新建+1 条警告；更新文档=更新；状态未知=阻断；确认区 placeholder=PUBLISH、输入空时执行禁用；确认区常驻可见（flex 布局修复后识图确认） |
| （操作）确认值校验 | 输入 `PUBLISHX` → 执行禁用；输入 `PUBLISH` → 放行 | agent-browser ref 断言两种状态 |
| 04-modal-result | 发布流·完成态 | 新建 3/更新 1/阻断 2/失败 0/互链补写 1；逐项状态徽标+云端链接；冲突行落 conflict |
| 05-tree-badges | 徽标更新 | 发布后树行：冲突/已发布/已发布/已发布/未知/警告（发布说明真实产生 published_with_warnings，见 §五） |
| 06-doc-detail-badge | 文档详情徽标 | 来源侧栏「飞书发布：已发布 · 有警告」+ 云端链接（a11y name 核验） |
| 07-history | 发布历史 | 7 行：状态徽标/时间/云端链接/lastError（冲突行完整文案）/警告折叠/历史 token 归档行 |
| 08-preview-force | 冲突解除预览 | force 后：冲突文档=更新+云端有修改、状态未知=新建；确认值升级 OVERWRITE_PUBLISHED；「将覆盖的云端文档：冲突文档」清单 |
| 09-force-result | 冲突解除执行 | 新建 1/更新 1，两行均「已发布」 |
| 10-preview-full-removed | 全量模式 | 全部 skip + 「将标记已从标准库移除：guide/已移除文档.md」；执行后该行 state=kb_removed（API 复核）；全 skip 时「无项可执行」提示（含 removed 例外放行） |
| 11-settings-card | 发布根设置·已配置 | 开关开启、已校验徽标、kind/label/token、清除入口、粘贴输入区 |
| 12-target-error-inside-watched | 发布根校验错误 | 409 双行文案：服务端「发布根（wiki 节点 …）位于监听子树 … 内：已发布内容会被同步回流…」+ UI 附加提示；非法 URL → 400「无法识别发布根 URL…」双行（DOM 断言） |
| 13-gates-disabled | 门控呈现 | 关闭开关后预览：gates 问题「反向发布未开启（设置 → 飞书认证 → 飞书发布）」+「前往设置」按钮（点击跳转设置卡成功）+ 执行发布禁用 |

**走通的操作链**（全部真实 HTTP → 真实 server → mock CLI）：发布（create/update/blocked 混合计划）→ 执行 → 徽标刷新；force+OVERWRITE_PUBLISHED 冲突覆盖；全量 kb_removed 标记；发布根粘贴校验（成功/监听树内拒绝/非法拒绝）；enabled 开关 UI→config 落盘往返。

## 四、测试与验证

| 验证 | 命令（cwd=repo root） | 结果 |
|---|---|---|
| 前端全量 | `npx vitest run` | **37 文件 / 313 用例全绿**（含本任务 +20 用例；兄弟任务并行新增用例一并通过） |
| 类型 | `npm run typecheck`（root+server 三段） | 退出码 0（此前 src/utils/lineDiff.ts 兄弟中间态错误已由其任务自行收敛） |
| Lint | `npx eslint <15 个本任务文件>` | 0 error 0 warning |
| 真机 | agent-browser + mock lark-cli（§三） | 13 截图 + 操作链断言；识图复核关键截图（面板层级/预览行/历史行/错误文案） |

## 五、真机发现（供 Leader/后续切片）

1. **互链改写触发回读校验假阳性警告**：两遍发布把「发布说明」中指向同批新建文档的相对链接改写为云端 URL 后，本地可见字符数（URL 剥离）与 fake 云端 charCount（按 md 原文长度）比值越界 → 真实落入 `published_with_warnings`（publish_verify_mismatch）。mock 的 charCount 口径偏简（= md 长度），真实飞书 parse 口径不同；但「链接改写显著拉大 raw/visible 比」在真实环境同样存在，佐证 S8 报告 §九.5「区间按样本校准」的必要性。建议 S9 后续用真实发布样本观察该比值分布。
2. **label 缺省为粘贴的 URL**：PUT target 只传 url 时 S8 以 url 为 label（契约行为），发布预览「发布根」行会显示长 URL。UI 未提供 label 输入（设计 §4.6 未要求）；如需美观可在设置卡加可选名称输入（小改）。
3. **Modal 内长计划表**：预览步计划表区独立滚动、确认区常驻底部（验收中修正）；视口较矮时计划表可见行数有限但可滚动，无布局塌陷。

## 六、待真机清单（真实环境，依赖主上授权 lark-cli 写权限）

- [ ] 真实发布链全流程：发布 → 飞书可见（真文档/真 URL）→ 改标准库 → 再发布为 update → 云端人工编辑后再发布被时间门阻断 → force+OVERWRITE_PUBLISHED 覆盖。
- [ ] 真实 `docs +create` 到 Drive 文件夹 / wiki 节点发布根（PB-1 的 wiki 路径仍未实测，S8 §九.4）。
- [ ] 真实 parse char_count 比值分布（§五.1）与 [0.8,1.25] 区间校准。
- [ ] Electron 真机（dev:desktop / 打包）走同链路（本验收为 standalone + vite 浏览器；desktop token 链路 UI 相同，openExternal 跳转云端链接需真机确认）。
- [ ] 生产资料发布根配置（真实 watchedRoots 下的双向校验文案与祖先链耗时体感）。

## 七、未覆盖项与风险

- 搜索结果列表未加发布徽标（任务书「列表」以目录树覆盖；搜索结果项无 path 徽标位，避免误植）。
- 发布执行无服务端进度事件（S8 为同步单请求），UI 以 executing 态+完成后结果呈现；大库发布期间弹窗需保持打开（关闭即断连，服务端仍会执行完）。
- 树徽标 click 形态用 span+window.open（button 内不能嵌 a 的 HTML 约束）；键盘可达性弱于真实链接（Enter/Space 已支持，焦点环依赖浏览器默认）。
- 并行验收期间共享树有兄弟任务高频写入（曾触发 vite 整页 reload），已用隔离 watch 的临时 vite 实例完成设置页走查；临时配置已删除，未污染仓库。

## 八、回滚方式

删除 9 个新文件（types/kb-publish.ts、utils/kbPublish.ts+test、KbPublishStateBadge/KbPublishPanel/KbPublishModal+test、FeishuPublishSettingsCard+test）并还原 6 个修改文件的追加块（client.ts 发布 API 段、types/index.ts feishuPublish、KbTreePanel 徽标、KnowledgeView 侧栏/弹窗、SettingsView 设置项、App.tsx auth 跳转）即可；无 server/数据面改动，无迁移。
