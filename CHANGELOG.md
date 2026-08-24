# Changelog

本项目所有显著变更记录于本文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.2.9] - 2026-08-24

### 概要
v0.2.9：修复打包应用内嵌 server 强占 3001 端口导致启动报错（EADDRINUSE）的 P0 bug。

### Fixed（fix）

- **内嵌 server 端口回退错误**：`startServer` 用 `options.port || DEFAULT_PORT`，Electron 传入的 `port: 0`（系统自动分配）被 `||` 当作 falsy 回退到 3001——打包应用始终强占 3001，与本机其他服务（开发服务器等）冲突时内嵌 server 启动失败、应用报错。改为 `??` 仅在未传端口时回退，Electron 模式恢复随机端口。

---

## [0.2.8] - 2026-08-24

### 概要
v0.2.8：总览区布局重构——三栏全宽工作台 + 文档内容预览（MD/CSV），并修复树搜索过滤失效。

### Added（feat）

- **总览区三栏布局**：主内容区取消 max-w 居中限制（消除宽屏空白），改为左节点树（300–320px）+ 中文档预览（主区域）+ 右详情侧栏（详情/最近变更/孤儿提醒），三栏等高独立滚动。
- **文档预览面板**：点击节点即以 Markdown / CSV 双页签预览本地内容；MD 支持渲染/源码切换，sheet 多子表切换，含骨架屏与分级空态；新增 `GET /api/mapping/content/:objToken`（knowledgeBaseRoot 内安全只读，512KB 截断）。
- **预览面板「在文件夹中打开」按钮** 与 **↑/↓ 键盘切换节点**（联动预览并滚入可视区）。
- 视觉与交互动效：树选中态强化、导航/页签下划线 scaleX 过渡、切换淡入。

### Fixed（fix）

- 树搜索框与过滤器此前只自动展开祖先、不过滤渲染；现按「匹配节点 + 祖先链」正确过滤并显示匹配数。
- `ChannelTestRequest.llm` 类型补 `timeoutMs`；根 tsconfig 排除前端测试文件。

---

## [0.2.7] - 2026-08-19

### 概要
v0.2.7：优化退出协调机制与自定义文档同步稳定性，提升打包与运行可靠性。

### Added（feat）

- **退出协调器（Quit Coordinator）优化**：增强主进程退出与后台轮询协调，提升退出与清理稳定性。
- **自定义归档与同步强化**：进一步健全自定义文件夹文档的变更检测与同步写回链路。

---

## [0.2.6] - 2026-08-12

### 概要
v0.2.6：自定义归档文档纳入同步状态跟踪（云端变更可检测、可同步更新本地）。

### Added（feat）

- **归档文档同步状态跟踪**：快捷添加的自定义归档文档（_custom/）不再只是添加时快照——云端内容变更可通过检测识别（detectCustomFolderChanges，接入检测与轮询）、出现在变更列表（diff 并入 modified）、并可在同步区勾选同步更新本地文件（写回 _custom/，保留归档归属）。
- **纯云文档链接归档修复**：非知识库 /docx/ 链接的 131005 回退在真实 lark-cli 子进程链路可达（错误 code 从 stderr JSON 提取透传），零散文档归档主路径打通。

### Fixed（fix）

- 多 watchedRoot 下归档文档在变更列表/计数中重复 N 倍（前端按 objToken 去重）。

---

## [0.2.5] - 2026-08-12

### 概要
v0.2.5：快捷添加飞书云链接 + 自定义文件夹归档；树层级视觉修正。

### Added（feat）

- **快捷添加云文档**：纵览页左侧树顶部新增「快捷添加云文档」按钮，粘贴飞书链接（知识库内或任意零散 docx）即可添加；支持非知识库纯云文档（131005 回退解析）。
- **自定义文件夹归档**：新建/改名/删除自定义文件夹，将零散云文档归档到指定文件夹（本地落盘 _custom/<文件夹>/，含图片附件）；树底部「自定义归档」分组展示归档文档，可收起/展开，点击联动详情卡；孤儿扫描与对账逻辑已排除归档文件。
- **树层级视觉**：顶层（watchedRoot 分组）文字/图标大于其他层级，深层节点不再与顶层同尺寸；watchedRoot 分组支持点击收起。

### Fixed（fix）

- 归档写入安全链：媒体下载参数顺序、同标题冲突不覆盖、DB 失败快照回滚、非 wiki 回退 host 白名单与 131005 限定、结构树成员拒绝归档、并发归档串行化、对账入口透传归档路径、错误分类修正。

---

## [0.2.4] - 2026-08-12

### 概要
v0.2.4：飞书视图根目录（watchedRoot 分组）支持收起。

### Added（feat）

- **根目录收起**：飞书视图顶层按 watchedRoot 分组的标题行可点击展开/收起（含箭头指示、数量徽标、键盘可达），未分类分组同样支持；默认保持展开。

---

## [0.2.3] - 2026-08-12

### 概要
v0.2.3：修复页面版本信息显示停留在 0.2.0 的问题（硬编码版本号改为构建时注入）。

### Fixed（fix）

- **版本号动态化**：顶部栏与「关于与更新」卡片不再硬编码 v0.2.0，改为 vite 构建时注入 package.json version（桌面端优先显示 Electron 真实版本 app.getVersion），版本信息与实际安装包一致。

---

## [0.2.2] - 2026-08-12

### 概要
v0.2.2：修复切换主区后同步进度丢失、飞书侧待处理面板默认收起。

### Fixed（fix）

- **同步进度跨主区保留**：同步状态（syncing/结果/总数）从 SyncView 局部 state 提升为全局 SyncProvider（Context），切换主区不再丢失，后台同步执行期间切回进度卡照常显示，同步结果列表也保留。
- **飞书侧待处理面板默认收起**：改为默认收起、点击标题行展开/收起（含数量徽标与键盘可达性），减少主界面干扰。

---

## [0.2.1] - 2026-08-12

### 概要
v0.2.1：修复总览区飞书/本地树视图布局显示面积过小、内容显示不全的问题。

### Fixed（fix）

- **树视图布局**：总览区左侧树列 280px 加宽至 340px，总览主区放宽至 1440px（同步/设置区保持 1280px 不受影响）。
- **树行内容完整展示**：飞书/本地树缩进 10px/级 收紧至 8px/级（上限 48→40px），把空间让给标题；飞书树标题增加悬停显示全名（title），深层节点不再无提示截断。
- **lark-cli 认证**：修复 user 身份 refresh token 过期导致认证身份回退为 bot 的问题（需重新执行 `lark-cli auth login` 授权，非代码改动）。

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
