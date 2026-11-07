# 工程治理 G1 报告

- 日期：2026-10-26 ｜ 执行：鲁班（luban）｜ 基线：v0.3.47（worktree `amagi/engineering-governance`）
- 上游输入：`docs/reports/engineering-baseline-audit.md`（白泽审计）、`docs/plans/agent-knowledge-workflow.md`、CLAUDE.md
- 约束遵守：未 commit/push/发版；未改 appId/更新 feed/包名/版本号；未改产品行为；未读家目录凭据；未运行真实同步脚本；docs/design 与 docs/plans 未触碰。

## 一、覆盖项（验收 → 实现 → 验证）

| # | 验收 | 实现 | 验证（命令 / 退出码） |
|---|------|------|----------------------|
| 1 | 统一根 test/typecheck/check 入口 | 根 `package.json` 新增 `test`/`test:watch`/`test:server`/`test:all`/`typecheck`/`lint`/`format`/`format:check`/`check`；`engines.node >=20` | `npm run check` exit 0（lint 0 error + 三段 tsc + 8+43 测试文件） |
| 2 | 接通已有前端测试 | 前端测试为 vitest 风格（实测 import，非假设）；根加 `vitest ^2.1.9` devDep + `vitest.config.ts`（include 仅 `src/`，node 环境，显式 jsx automatic）；`server/vitest.config.ts` 显式声明 tests 范围（修复根配置导致的 server 测试"找不到文件"连带问题） | `npm test` exit 0，**8 文件 54 用例全绿**（此前无运行器） |
| 3 | server Node24 native crash 诊断修复 | 根因：better-sqlite3 11.x `Statement::~Statement` 在 Node 24 worker teardown 后 GC 弱回调中调 `RemoveEnvironmentCleanupHook`，断言 `env!=nullptr` 崩溃（worker 静默退出，49 用例丢失，ABI 本身正常）。修复：双包 better-sqlite3 ^11.9.0 → **^12.11.1**（12.4.1+ 含修复，engines 20/22/23/24/25/26 兼容） | 单文件复现：升级前 crash 29s / 升级后 `vitest run tests/custom-folders.test.ts` exit 0（49/49，769ms）；全套 `FEISHU_SYNC_HOME=/tmp/... npx vitest run` exit 0，**43 文件 614 用例全绿**（此前 42/43 + 49 丢失） |
| 4 | lint/format 基础 | ESLint 9 flat config（`eslint.config.js`）+ eslint-plugin-react-hooks（源码已有 5 处该规则 disable 注释，属恢复接通）+ prettier 配置渐进采纳（`.prettierrc.json`/`.prettierignore`，不做全仓一次性 format）。遗留清零：修 16 处 error（未用 import/变量、等价正则转义归一、let→const、BOM 正则改 `\uFEFF` 转义、React 组件解构重命名 `_className`）+ 测试类型欠账 11 处（3 文件，测试纳入 typecheck 后暴露） | `npm run lint` exit 0（剩 2 处 `react-hooks/exhaustive-deps` **warning**：行为敏感未自动修，已在 docs/testing.md 透明记录） |
| 5 | push/PR CI | 新增 `.github/workflows/ci.yml`：push(main)/PR/dispatch → 双包 npm ci → lint → typecheck → test:all → 构建冒烟（build:all + electron:build；打包链仍归 release.yml） | YAML 解析通过（js-yaml）；各步骤命令本地逐一实跑同口径 exit 0 |
| 6 | Node 要求 | `engines.node: ">=20"`（vite 6/vitest 2/better-sqlite3 12 支持矩阵；Node 18 已 EOL）；README/CLAUDE.md 同步 | `node -v` v24.21.0 实测全链绿 |
| 7 | 文档漂移修正 | README：v0.3.28→v0.3.47（2 处）、electron-builder 24→26、better-sqlite3 9→12、Node 18+→20+、贡献流程改根目录 `npm run check`、项目结构图更新、docs 导航。CLAUDE.md：NodeNext→bundler、sync-engine 1475 行→"1800+ 行量级"（不再锚定精确值）、补根统一命令、补 Node24 teardown 实测坑 | grep 版本残留清零；两文件与实测事实（package.json/wc -l/tsconfig）逐项对照 |
| 8 | docs 体系建设 | `docs/README.md`（索引）、`architecture.md`（mermaid 架构图+模块地图+5 条不变量）、`development.md`（环境/双包/ABI/红线）、`testing.md`（分层/约定/已知问题）、`data-contract.md`（SQLite/config/header 契约）、`operations.md`（发布不可变约束+回填运维+**41 脚本 L1/L2/L3 风险分级**）、根 `CONTRIBUTING.md` | 全部锚点来自实测（代码/配置/审计），无发明内容 |
| 9 | 历史产物归档 | 根 2 份一次性报告 + `.review-status.json` + projects-memory fix-report → `docs/reports/archive/`（git mv 保留历史）；空壳同步产物 `server/400-玩法与表现.md`（150B，仅 header+标题无正文）git rm | 归档前后 grep 无代码引用（4 个名字全仓 0 命中）；空目录树移动至 mktemp trash 未删 |
| 10 | 真实配置问题修复 | ① `tsconfig.node.json` include 指向不存在的 `electron-builder.config.js` → 改为实际存在的 `vite.config.ts`+`vitest.config.ts`（纳入 typecheck）；② 根 `tsconfig.json` 移除测试文件 exclude（测试纳入类型检查）；③ win 打包图标 `build/icon.png` 从未被入库（.gitignore `*.png` 全局拦截）→ 从 `build/icon.icns` 提取 1024px 源图 + `.gitignore` 加 `!build/icon.png` 负例外 | ① `tsc --noEmit -p tsconfig.node.json` exit 0；② typecheck 含测试后 11 处欠账已修且全绿；③ `git check-ignore -v build/icon.png` 命中负规则，`git add -N` 成功入库待合并 |

## 二、验证记录（真实命令 + 退出码）

| 命令（cwd=根，除注明） | 退出码 | 关键结果 |
|---|---|---|
| `npm run check`（含 FEISHU_SYNC_HOME 隔离） | 0 | lint 0 error + typecheck 3 段 + 前端 54 + server 614 全绿 |
| `npx vitest run`（根） | 0 | 8 文件 54 用例 |
| `FEISHU_SYNC_HOME=/tmp/g1-fs-home npx vitest run`（server/） | 0 | 43 文件 614 用例 |
| `npx vitest run tests/custom-folders.test.ts`（server/，升级后） | 0 | 49/49（升级前同命令 native crash） |
| `npm run build:all` | 0 | vite build + server tsc |
| `npm run electron:build` | 0 | dist-electron/main.cjs + preload.cjs |
| `npx eslint .` | 0 | 0 error / 2 warning（透明记录） |

未运行：桌面打包（`desktop:dist:*`，超范围且需目标平台）、真实 CI runner（ci.yml 逻辑与本地同口径，actionlint 未装）、真实同步/飞书链路（任务红线）。

## 三、changed files 概览

- 配置/入口：`package.json`、`server/package.json`、双 `package-lock.json`、`tsconfig.json`、`tsconfig.node.json`、`vitest.config.ts`(新)、`server/vitest.config.ts`(新)、`eslint.config.js`(新)、`.prettierrc.json`/`.prettierignore`(新)、`.gitignore`、`.github/workflows/ci.yml`(新)
- 代码（等价改写/死代码清理，无行为变化）：`electron/main.ts`、`server/src/{config-manager,lark-cli-client,lark-cli-manager,local-map-store,orphan-files,reconciliation-apply}.ts`、`server/src/routes/custom-folders.ts`、`src/components/{ModelProviderSettings,QuickAddDocDialog,common/Input}.tsx` + 6 个测试文件
- 文档：`README.md`、`CLAUDE.md`、`CONTRIBUTING.md`(新)、`docs/` 6 篇(新)
- 归档/资产：4 件 → `docs/reports/archive/`；删 `server/400-*.md`；`build/icon.png`(新，1.5MB 1024px)

回滚方式：全部为工作区改动（未 commit），`git checkout -- <file>` + 删除新增未跟踪文件即可；依赖回滚 `git checkout package*.json && npm install`（双包）。

## 四、未覆盖 / 风险

1. **better-sqlite3 12 与 Electron 31 打包链**：@electron/rebuild 对 12.x 的编译仅由 release workflow 覆盖，本轮未打包实测（Node ABI 侧 614 用例全绿）。合并后首跑 `desktop:dist:mac:arm64` 或依赖 CI tag 构建验证。
2. **2 处 react-hooks deps warning**（NodeTreeView roots / useSyncStatus watchedRootUrls）：自动修可能改变闭包行为，留待对应组件下次改动时人工处理（docs/testing.md 已记录）。
3. **e2e-integration-test.ts 端口硬编码**：保留为已知技术债（改它需真实环境验证，超出本轮）。
4. **appId 占位**（`com.yourcompany.feishu-sync`）：历史安装包兼容原因**有意不动**（docs/operations.md 已声明约束）。
5. **ci.yml 未在真实 runner 跑过**：步骤与本地实跑同口径；若 GitHub 侧 npm/electron 缓存差异导致首跑失败，属环境修正而非逻辑缺口。
6. server 测试建议 `FEISHU_SYNC_HOME` 隔离：本轮实测两跑法均绿，但隔离跑法可避免长尾用例写真实家目录（docs/testing.md 已写）。

## 五、建议下一步

G2 审核时重点抽查：better-sqlite3 升级 diff、eslint --fix 的产品文件等价性、ci.yml 步骤与本地口径一致性。

## 六、Leader 整合验证与修正（不覆盖原始 G1 证据）

- 已将治理 diff 集成主工作区，未提交。保留并行 D1 设计与活 workflow 文件，不覆盖其更新。
- 新增 `.amagi-worktrees/`、`amagi-task/` gitignore 及 lint/format 排除，避免主树检查递归扫描隔离树。
- 新增 Vitest globalSetup：在模块装载前自动将 FEISHU_SYNC_HOME 指向临时目录并在结束后清理；新增环境回归测试。不再仅靠开发者手动设置隔离变量。
- 修正 CLAUDE/架构文档的 DI 描述：现有代码把依赖挂到 context 自身，并非 c.env；修正 ABI 验证必须以 Electron 而非系统 Node 执行。
- 运维脚本风险目录改为保守分类：verify/test/gate 名称不代表只读；verify-media-gap 会初始化数据库，gate5 包含 apply；未证实隔离者不放入‘零写入’类别。保留并明确 historical reconcile-apply 的 home 路径债务。
- `npm ci` 双包完成；主树 `npm run check && npm run build:all && npm run electron:build` exit 0（bg-e7f6e3e7）：前端 54 用例、server 615 用例（含新增隔离测试），无 native worker 丢失。
- 浏览器真实交互（隔离 home + API3101/Vite5173，lark-cli 显式不可用，未读取实际飞书凭据）：打开应用→设置→输入临时知识库路径→保存→看到‘已保存知识库设置’；实际 API 回读确认路径持久化→切同步页显示未配置根URL与禁用同步→回设置路径仍保留；browser errors 为空。截图 `/tmp/feishu-g2-settings.png`、`/tmp/feishu-g2-sync.png`（未声称视觉审美审阅）。
- Electron 原生验证：隔离临时目录安装 better-sqlite3 12.11.1，按 Electron31.7.7 headers 重编译成功（`@electron/rebuild -f -w better-sqlite3 -v 31.7.7`）；主树 Node ABI 未被修改。
- **运行验证受环境阻塞**：初次 Electron 启动停在 dyld，lsof 确认本次启动 app 被移到系统废纸篓；恢复本地测试运行时后，原始 bundle 签名校验失败。仅对本地开发 bundle 做 ad-hoc 签名（未改系统安全设置），严格签名校验已通过，但最小 Node-mode `console.log/process.exit` 仍在加载器阶段超时，未执行到 SQLite。日志 bg-f79040ad/bg-e81f5598/bg-99a08184/bg-45f990c9。不能把原生‘重编译成功’声称为‘Electron 运行验证通过’；完整打包/Windows 仍未覆盖。
- G2 初审 1 Major（dry-run状态写入文案）、2 Minor（开发Node范围、DI表格残留）已Leader修复：README/CLAUDE/运维明确不提交KB正文仍会写配置/SQLite/observed/报告；根package+lock支持范围统一 ^22.19.0 || ^24.0.0，开发指南与CI注释同步；DI表格使用context属性。原始G1的Node>=20表述是阶段历史，最终以当前manifest与开发指南为准。
- `git diff --check` 与 package/lock版本及engines一致性检查通过；G2 UI自建浏览器、API与Vite均已关闭，避免占用后续开发端口。最终版本仍v0.3.47，未tag/push/发版。独立增量复审/治理main提交随后记录。
