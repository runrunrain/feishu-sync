# S13 报告：源编辑/写回 UI + CLI 命令登记

- 上游输入：`docs/design/kb-agent-upgrade-design.md` §6.3/§7.4–7.6、`S11-report.md`（edit/revert/edit-status 契约）、`S12-report.md`（push preview/push 契约与 confirm 门）、`S9-report.md`（source.* 登记占位说明与 CLI 基建）、`src/components/DocPreviewPanel.tsx`
- 产物：代码（§一）+ 测试（§五）+ 12 张真机浏览器截图（§四）
- 范围外（按任务书）：真实云端写回冒烟（S12 §六 Leader 清单）、`source show/state` 命令登记（设计 §6.3 有、本任务书登记面未列）

## 一、改动清单（写面登记）

### 新文件

| 文件 | 内容 |
|---|---|
| `src/components/SourceEditControls.tsx` | 预览面板共用操作条：编辑（Modal 正文编辑器，header 不可见不可改，baseHash OCC，409 冲突面板+刷新引导）、状态徽标（dirty/pushed/conflict/pushing）、放弃修改（window.confirm + revert）、写回飞书（preview→按确认级别二次确认→push→结果/409 force 引导/403 设置引导）；导出纯函数 `splitFeishuSyncHeader`（与 S11 splitHeaderBody 同规则：仅 `-->\n\n` 精确规范分隔计入头部） |
| `src/components/FeishuWriteSettingsCard.tsx` | 设置页「飞书写入」卡：feishuWrite.enabled 开关（useConfig→PUT /api/config）、writeScopesGranted 徽标、「授权写入权限」→ scopeSet='write' Device Flow（复用 AuthSettingsCard 视觉模式：URL+复制+重新打开+等待+取消；完成态刷新 auth-status） |
| `src/components/SourceEditControls.test.tsx` | 9 用例：header 切分 4 分支（规范/单换行不吞并/历史头/无头）+ 渲染分支 5（编辑入口/截断禁用/非规范头禁用/sheet 不渲染/未同步不渲染） |
| `src/components/FeishuWriteSettingsCard.test.tsx` | 4 用例：开关+未授权引导、已开启+已授权降级入口、配置未加载、检测中 |
| `server/tests/cli-source-commands.test.ts` | 13 用例：/api/cli/:command 执行路径 9（edit-status 形状、edit confirm 门 422→落盘 dirty→409 透传、push-preview blocked write_disabled、push 422→403 写门→allowOverwrite 派生 OVERWRITE_CLOUD 通过路由 confirm 校验、revert 422→恢复清行）+ CLI 子进程端到端 4（edit --new-text --base-hash --yes 退出码 0 落盘、edit 无 --yes 退出码 4、push 4/1 两态、revert --yes 0 还原） |

### 追加/集成（任务书写面内）

| 文件 | 改动 |
|---|---|
| `server/src/ops/command-table.ts` | **只追加** 5 条 source.* 命令（§二），不动既有 25 条 |
| `src/components/DocPreviewPanel.tsx` | 头部行接入 SourceEditControls（仅 docx+有本地 md+非加载态）；内容加载提取 `loadContent` 供编辑/放弃/写回后重载 |
| `src/components/kb/RawSourceDrawer.tsx` | tab 行接入同款控件（`reloadNonce` 重载机制） |
| `src/views/SettingsView.tsx` | 「飞书认证」分组追加侧栏项「飞书写入」（auth tab） |
| `src/api/client.ts` | 追加 5 函数（getSourceEditStatus/editSourceDocument/revertSourceEdit/previewSourcePush/pushSourceToFeishu）；`startDeviceAuth` 增可选 `options.scopeSet`（缺省 'read'，既有调用行为不变）；DeviceAuthStartResult 增 scopeSet 字段 |
| `src/types/index.ts` | 追加 SourceEditState/SourceEditStatus/SourceEditStateDto/SourceEditResult/SourcePushPlan/SourcePushResult；AuthStatus.writeScopesGranted?；Config.feishuWrite? |

### 写面外最小追加（请 Leader 按此扩写面）

| 文件 | 理由与范围 |
|---|---|
| `server/src/cli/args.ts` | `POSITIONALS` 追加 5 行（source.* 首位置参数绑 objToken）。不加则 CLI 把 `<objToken>` 判为多余位置参数退出码 2，设计 §6.3 的 `source edit <objToken>` 用法无法成立；S9 报告 §五已预告 POSITIONALS 是登记点。纯数据追加，无逻辑改动 |
| `server/tests/ops-command-table.test.ts` | 「首批不含 source.*」断言按 S13 登记更新为「已登记+风险级/confirm 锚定」+ 新增 source.* request() 纯函数用例（8 条） |
| `server/tests/cli-args.test.ts` | 命令总数 25→30 断言更新 + 新增 source.* 位置参数绑定/必填/boolean 旗标用例 |
| `src/api/client.test.ts` | startDeviceAuth 默认 body 断言更新（scopeSet:'read' 显式化）+ 新增 scopeSet:'write' 用例 |

## 二、命令表登记清单（对照任务书 riskLevel）

| 命令 | 风险 | confirm（表内） | request() 映射 | 实际请求体 confirm |
|---|---|---|---|---|
| `source.edit-status <objToken>` | read | — | GET `/api/sources/:t/edit-status` | — |
| `source.edit <objToken> (--new-text s \| --op JSON) --base-hash h` | mutate | `{confirm:'EDIT'}` | POST `/api/sources/:t/edit` | `confirm:'EDIT'` + `actor:'cli'`；op/newText 二选一（同给/全缺 → invalid_args 退出码 2） |
| `source.revert <objToken>` | **mutate**（任务书指定；设计 §6.3 原为 destructive） | `{confirm:'REVERT'}` | POST `/api/sources/:t/revert` | `confirm:'REVERT'` + actor |
| `source.push-preview <objToken>` | read | — | POST `/api/sources/:t/push/preview` | — |
| `source.push <objToken> [--allow-overwrite] [--force]` | remote_write | `{confirm:'PUSH'}`（--yes 门基线值） | POST `/api/sources/:t/push` | **由 request() 派生**：allowOverwrite∨force → `'OVERWRITE_CLOUD'`，否则 `'PUSH'` |

- push 的动态 confirm 处理：CLI `--yes` 注入表内基线值过 `/api/cli/:command` 确认门；实际 confirm 由表内纯函数按旗标派生——两个值都满足「显式确认后才执行」，remote_write 必带 confirm 的表级不变量（S8 测试）不破。CLI 帮助文本「将注入 confirm=PUSH」在 overwrite 场景与实际值（OVERWRITE_CLOUD）有措辞差，属外观项。
- 设计 §6.3 的 `--from-file` 未实现（CLI 为表驱动零定制，文件读取属 CLI 客户端新能力）；shell 代换 `--new-text "$(cat f)"` 可达同效。
- agentExposed：5 条全部 true（设计 §7.6：Agent 经 app_command source.*（Work，逐次批准））。

## 三、契约对照（S11/S12 报告 → UI/CLI 消费）

| 契约点 | 消费位置 | 验证 |
|---|---|---|
| edit-status 返回 bodyHash（OCC baseHash） | SourceEditControls 挂载即取；编辑器保存携带 | 浏览器实测 + cli-source-commands.test |
| edit 409 `source_edit_conflict`（details.currentBodyHash） | 编辑器内冲突面板 + 「刷新最新正文」 | 浏览器实测（另一入口先保存→UI 再保存→面板呈现，截图 10） |
| edit `confirm:'EDIT'` 硬门 | UI 恒带；CLI 表内 confirm 注入 | server 测试 + CLI 退出码 4 |
| revert `confirm:'REVERT'` | UI window.confirm + API body；CLI --yes | 浏览器实测（dialog 拦截验证）+ CLI |
| preview `mode/blockedReason/bytes/conflict/warnings` | 写回弹窗完整消费（追加/覆盖/阻止三态+冲突+警告列表） | 浏览器实测（write_disabled 引导→overwrite 警告，截图 05/07） |
| push confirm 门（append→PUSH；overwrite/force→OVERWRITE_CLOUD） | append=普通确认钮；overwrite=红色警示钮（「我已了解风险，覆盖云端」） | 浏览器实测 + server 测试 |
| 409 `source_push_conflict`（details.cloudObjEditTime）→ force 引导 | 错误面板 + 「强制覆盖云端」钮（force+OVERWRITE_CLOUD） | 代码路径与文案锚定（真机本次未遇 409 冲突场景，见 §六） |
| 403 `feishu_write_disabled`/`feishu_write_scope_missing` → 去设置/去授权 | preview blocked 文案 + push 错误面板，路径「设置 → 飞书认证 → 飞书写入」 | 浏览器实测（截图 05/08） |
| device/start `scopeSet:'write'`、auth-status `writeScopesGranted` | 设置卡开关/徽标/授权钮 | 浏览器实测（本机已有 write scope → 徽标「已授权」；二次发起 → 409 in-progress 错误面板，截图 11） |
| pushed 行重推防护（S12 偏差 5） | UI 对 pushed 只显徽标（「已写回，等待回拉同步收敛」），不显示「写回飞书」按钮 | 组件分支 + SSR 锚定 |
| mdTruncated（mapping/content 512KB 截断） | 编辑钮禁用 + 提示（防整文替换丢尾部） | SSR 用例 |
| header 不可见不可改 | 编辑器仅装载 `splitFeishuSyncHeader().body`；保存 replace_body 只写正文 | 浏览器实测（编辑器首行 `# 标题`，磁盘 header 字节原样）+ 磁盘核验 |

## 四、真机浏览器验证（截图 12 张，`screenshots-s13/`）

环境：`vite build` 静态产物 + 自建静态/代理服务（:5275→:3101）+ 隔离 `FEISHU_SYNC_HOME` 临时数据根（不触碰真实数据）。**为何不用 dev:all**：共享树上兄弟切片（S5/S7）持续改 `src/` 触发 vite 全页重载，三次在编辑流程中途重置组件状态（modal 消失/status 丢失）；静态构建消除 HMR 后全流程稳定复现。

操作序列（每步含服务端核验）：

| # | 操作 | 结果（服务端证据） | 截图 |
|---|---|---|---|
| 1 | 选中种子 docx → 预览 | 编辑入口出现（仅 docx） | 01/02 |
| 2 | 点「编辑」→ 编辑器 | 编辑器只含正文（无 feishu_sync 头）；title 取自 edit-status | 03 |
| 3 | 键盘追加文本 → 保存 | toast+「本地已修改」徽标；edit-status `editState.state=dirty`、bodyHash 变化；磁盘 header 字节原样+追加文本在；`source-edits/<t>/base.md+000001.md` 落盘；审计行 `actor:'ui'` | 04 |
| 4 | 「写回飞书」（feishuWrite 未开启） | preview blocked `write_disabled` + 设置路径引导 | 05 |
| 5 | 设置→飞书认证→飞书写入：开关开启 | `PUT /api/config` 后 `feishuWrite.enabled=true`；写入权限徽标「已授权」（本机 lark-cli 已含 write scope） | 06/06b |
| 6 | 再次「写回飞书」 | plan=**overwrite**（本次编辑为插段非纯追加，规划正确）+ 红色警示（评论锚点/协作块警告、字节、三段式兜底 warning） | 07 |
| 7 | 点「我已了解风险，覆盖云端」 | 真实 lark-cli 路径：伪造 token → fetch 段 API 99992402 失败 → 502 错误面板呈现（消息+原始 lark 错误）；行保持 dirty（S12「①段 fetch 失败回 dirty 零写入」实测吻合） | 08 |
| 8 | 「放弃修改」→ confirm 对话框 → 确认 | editState 清空、bodyHash 还原、磁盘追加文本消失 | 09 |
| 9 | 复开编辑器 → 另一入口（curl）先保存 → UI 再保存 | 409 冲突面板「保存冲突：正文已被其他入口修改」+ 刷新引导 | 10 |
| 10 | 设置卡「重新授权写入权限」×2 | 首次真实发起（页面跳转 accounts.feishu.cn 设备验证 URL=流程已通）；二次 → 服务端 409 in-progress 错误面板如实呈现 | 11 |

RawSourceDrawer（标准库原始文档抽屉）：与 DocPreviewPanel 共用同一 SourceEditControls 组件，SSR 用例锚定挂载分支；真机未单独走标准库页流程（需已发布标准库数据，见 §六）。

## 五、验证证据

| 项 | 命令/入口 | 结果 |
|---|---|---|
| 新 CLI 测试 | `cd server && npx vitest run tests/cli-source-commands.test.ts` | **13/13** |
| 命令表/参数解析更新 | `tests/ops-command-table.test.ts`（26）、`tests/cli-args.test.ts`（13） | **39/39** |
| CLI 邻接回归 | `tests/cli-client.test.ts tests/cli-endpoint.test.ts` | **全部通过** |
| 触碰域定向回归 | cli×4 + source-edit(20) + source-push(43) + config-routes | **167/167** |
| 全量 server | `cd server && npm test` | **90 files / 1169 tests 全绿** |
| 根前端 | `npm test` | **237/237**（含新 13 用例 + client.test 契约更新 2） |
| typecheck | `npm run typecheck`（root+node+server 三段） | exit 0 |
| lint | eslint 本切片 15 个文件 | 0 error 0 warning |
| 真机浏览器 | §四 10 步操作序列 | 全部通过，12 截图落盘 |

## 六、未覆盖项与风险

1. **`GET /api/mapping/content` 增 bodyHash/editState 未实施**（任务书第 5 项的替代路线）：任务书约束 server 只动 command-table/cli-admin/tests，`content.ts` 不在写面；前端 OCC 入口已按任务书预备路线改用 `GET /api/sources/:objToken/edit-status`（S11 交付，语义等价且是 S11 报告推荐的预览面板入口）。若 Leader 仍要 mapping/content 增字段，需扩写面后追加（改动面：`server/src/routes/content.ts` 单文件）。
2. **真机 409 push 冲突 + force 分支未走通**：需要真实云端「他人先改」场景（S12 §六 Leader 冒烟清单步骤 5）；UI 侧该分支的错误面板/强制覆盖按钮代码路径与 409 形状已由 server 测试锚定（push 409 details.cloudObjEditTime 契约来自 S12 测试）。
3. **RawSourceDrawer 真机流程未单独截图**：共用组件 + SSR 锚定（见 §四末段）；标准库页原始文档抽屉的完整真机序列留待 Leader 集成阶段顺带过卡。
4. **Device Flow 授权完成态未在浏览器走完**（避免占用/变更用户真实 lark-cli 认证态）：发起/URL 打开/409 in-progress 错误态已实测；complete→success 徽标刷新链路由 S12 server 测试 + hook 复用保证。首次发起的设备授权会话在隔离 server 上 ~10 分钟自然过期，不影响用户 3001 实例。
5. **CLI `--from-file`/`--replace` 快捷形态未实现**（§二说明）；`llm set-key --key-stdin` 仍不在表内（S9 已记录，需 stdin 通道设计）。
6. 共享树注意：兄弟切片（S5/S7）持续改动 `src/components/agent/*`、`kb/*`；本切片写面与其零交集，全量绿在两次运行中均复现。

## 七、回滚

- 前端：删 4 个新文件（SourceEditControls/FeishuWriteSettingsCard ×2 对）；还原 DocPreviewPanel/RawSourceDrawer/SettingsView/client.ts/types/index.ts/client.test.ts（均为追加式，反向 patch 即可）。
- server：command-table.ts 删 source.* 5 条块；args.ts 删 POSITIONALS 5 行；删 `tests/cli-source-commands.test.ts`；还原 ops-command-table/cli-args 两测试的 S13 段。
- 数据：无 schema 变化；已产生的 source_edits 行与备份目录由既有「放弃修改/写回」路径管理，回滚代码不影响其安全性（这正是设计 §13 的刻意行为）。
- 真机验证的临时数据根已清理（隔离 home 移入 amagi-trash；截图与报告在 agent-outputs）。
