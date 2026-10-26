# 工程与文档现状基线调查（engineering-baseline-audit）

- 日期：2026-10-26 ｜ 执行：白泽（explorer，只读取证）
- 审计基线：本地 `main` @ `672d327`（release: v0.3.46，2026-10-11）。**注意：本地落后 `origin/main` 1 个提交，origin 已有 `v0.3.47`（`8e35146`，2026-10-13，"过期账号重新认证入口与授权错误反馈修复"），本地无该提交内容。**
- 方法：只读（read / git ls-files / git log / grep），**未运行测试、未构建、未安装、未做任何改造**；未读取家目录配置与凭据。
- 标注三态：〔观察〕＝有直接证据锚点；〔推断〕＝基于证据+写明前提；〔未核验〕＝本轮未覆盖。所有路径相对仓库根。

---

## 一、结论索引表

| # | 主张 | 三态 | 锚点 | 适用边界 |
|---|------|------|------|----------|
| 1 | 三层同进程架构真实存在且与文档描述一致 | 观察 | `electron/main.ts:137-146`（dev 加载 `../server/dist/index.js`、生产 `app.asar.unpacked/server/dist/index.js`）；`server/src/index.ts`（Hono buildServer）；前端 `fetch(` 仅出现在 `src/api/client.ts`（grep 全 src 非测试文件仅 1 处命中） | 未运行验证启动行为，仅静态结构 |
| 2 | 业务代码规模：server 34 个模块 + 10 个路由文件；sync-engine.ts 实际 1818 行 | 观察 | `git ls-files server/src/modules`（34 文件）、`server/src/routes`（10 文件）；`wc -l`：sync-engine 1818 / local-map-store 2279 / change-detector 1768 | 行数随 HEAD 变化；v0.3.47 后可能再变 |
| 3 | 测试资产可观：server 43 个 `.test.ts`，前端 6 个测试文件 | 观察 | `git ls-files 'server/tests/*.test.ts'` 计数 43；src 下 6 个 `*.test.*` | 是否全绿未核验（未运行） |
| 4 | **前端测试无运行器**：根 package.json 无 test script，根 package-lock 无 vitest | 观察 | 根 `package.json` scripts 无 test/typecheck/lint；`grep -c '"vitest"' package-lock.json` = 0；server vitest（server/package.json devDeps）不覆盖 `src/` | 不能排除开发者临时 `npx` 手跑，但无声明式入口 |
| 5 | **CI 只有发布链，无质量门禁**：仅 `.github/workflows/release.yml`，tag/dispatch 触发三平台打包发布，无 push/PR 的测试/类型检查 job | 观察 | `.github/workflows/release.yml`（全文只含 build-mac/build-win 两 job）；README:贡献节要求本地跑 `npm test && typecheck`，无机器强制 | lint 门禁缺失另见 #6 |
| 6 | **零 lint/format 配置**：无 eslint/prettier/biome/editorconfig | 观察 | `ls -a` 过滤无命中（根与 server 均） | — |
| 7 | README 版本与技术栈漂移：声称 v0.3.28 / electron-builder 24 / better-sqlite3 9 | 观察 | `README.md:11`、`README.md:342`（v0.3.28）；`README.md:52`（electron-builder 24）、`README.md:55`（better-sqlite3 9）vs 根 `package.json`（version 0.3.46、electron-builder ^26.8.1、better-sqlite3 ^11.9.0） | CHANGELOG 反而是新的（见 #8） |
| 8 | CHANGELOG 维护良好且与 package.json 一致（顶部 [0.3.46] 2026-10-11）；发布历史活跃 | 观察 | `CHANGELOG.md:7`（## [0.3.46] - 2026-10-11）；git log 最近 5 条均为 release 提交（v0.3.42→v0.3.46） | 活跃性的间接佐证还有 release.yml 内 v0.3.27/v0.3.38 实测注释 |
| 9 | CLAUDE.md 两处技术细节过时：server 实际 `moduleResolution: bundler`（非 NodeNext）；sync-engine 实际 1818 行（非 1475） | 观察 | `CLAUDE.md:137` vs `server/tsconfig.json:7`；`CLAUDE.md:76` vs `wc -l` 实测 | CLAUDE.md 其余声称多数抽查一致（见 §四） |
| 10 | CLAUDE.md "e2e 脚本端口硬编码" 声称属实：`SERVER_URL = 'http://127.0.0.1:4123'` | 观察 | `server/scripts/e2e-integration-test.ts:11` | CLAUDE.md 只说问题存在未写端口值，与实际相符 |
| 11 | `tsconfig.node.json` 是死配置：include 指向不存在的 `electron-builder.config.js`（实际 `.cjs`），且无任何文件引用它 | 观察 | `tsconfig.node.json`（include 行）；`ls` 根目录只有 `.cjs`；grep package.json/vite.config.ts/tsconfig.json/scripts/*.cjs 无 "tsconfig.node" 引用 | 根 tsconfig 仅 references `server/tsconfig.json` |
| 12 | **Windows 打包图标引用了不存在的文件**：`win.icon: "build/icon.png"`，但 build/ 磁盘与 git 均无 icon.png（被 `.gitignore:48 *.png` 全局忽略拦截） | 观察 | `electron-builder.config.cjs`（win.icon 行）；`ls build/` 仅 4 文件无 icon.png；`git check-ignore -v build/icon.png` 命中 `.gitignore:48` | electron-builder 对缺失 icon 的实际行为（报错/回退默认图标）〔未核验〕；历史 release 成功说明构建未因此失败〔推断〕 |
| 13 | 打包配置含占位身份：appId `com.yourcompany.feishu-sync`、fallback 仓库 `yourcompany/feishu-sync`，与实际发布仓库 runrunrain/feishu-sync 不一致 | 观察 | `electron-builder.config.cjs`（appId/defaultRepository 行）；README badge/链接指向 runrunrain/feishu-sync | CI 内 feed URL 经 GITHUB_REPOSITORY 覆盖，仅本地构建与 appId 恒为占位 |
| 14 | 一次飞书同步产物被提交进源码树：`server/400-玩法与表现.md`，头部含 `obj_token: Si3PdaILEoel19xFEfOciWVmned` | 观察 | 该文件头部注释块（获取日期 2026-06-16） | obj_token 为文档标识非凭据；不影响打包（files 列表不含它），属仓库卫生问题 |
| 15 | 仓库根散落历史工作流产物：两份 2026-08-12 一次性实测/实现报告、`.review-status.json`（diting M5 审查，2026-06-16，引用 `D:/WorkPace/...` 本仓库不存在的报告路径，无任何代码引用）、`projects-memory/` 内 1 份 agent fix-report（其引用的 review 报告同样不在仓库） | 观察 | `custom-folder-e2e-verification.md`、`custom-folder-sync-report.md`（头部日期与环境行）；`.review-status.json` 全文；`projects-memory/projects/feishu-sync/agent-outputs/coder/20260812-custom-folder-archive-fix/fix-report.md`（开头注记） | 均无代码引用（grep "review-status" 无命中） |
| 16 | server/scripts 40+ 脚本混杂：正式运维脚本（sync-latest/reconcile/backup）与一次性阶段脚本（verify-m1/m2a/m2b/m3、debug-*、test-*、gate2/gate5）同层；另混入 3 个 Python 文件 | 观察 | `git ls-files server/scripts`（41 项，含 `run_migration_v2.py`、`update_doc_mapping.py`、migration_v2..v4.sql）；`server/tests/local_map_store_sql.py` | CLAUDE.md 已声明 migration v2..v5 为文件级参考 |
| 17 | **无 docs/ 目录**：文档仅 README + CLAUDE.md + CHANGELOG + 上述散件；README「开发文档导航」也只列 CHANGELOG/CLAUDE.md | 观察 | 全仓 `find -type d -name docs`（排除 node_modules）无命中；`git ls-files '*.md'` 非 fixture 项 | 本报告落盘的 `docs/reports/` 为新建目录 |
| 18 | server 子包版本 `0.2.0` 与主版本线（0.3.46）脱节；该文件会被打进安装包（files 含 `server/package.json`） | 观察 | `server/package.json`（version 字段）；`electron-builder.config.cjs` files 列表 | 无证据表明运行时读取该 version；属一致性问题 |
| 19 | 依赖双安装（根 + server）为既定结构；根 `dependencies` 为空、react/hono/better-sqlite3/openai 等全在 devDependencies；打包只收 `server/node_modules/**`（asarUnpack）并整体排除根 node_modules | 观察 | 根 `package.json`（dependencies/devDependencies）；`electron-builder.config.cjs` files 列表与 `asarUnpack: ["server/**"]` | 语义易误导（根 devDeps 里的运行库实际只服务开发态）〔推断〕；打包链可用性由历史 release 佐证 |
| 20 | 代码与注释体现真实工程纪律，不支持"vibecoding=低质量"预设 | 观察 | server 43 个测试文件；CHANGELOG 条目含实测细节（如 0.3.45 Windows scope 引号根因）；release.yml 长注释记录竞态根因与修复（v0.3.38/0.3.45 实测）；layout-reconstructor.ts:1-24 五类块规则注释与 README 模块描述一致 | 判断仅基于静态证据，未运行验证 |

---

## 二、现状能力盘点（已存在且自洽的部分）

1. **架构落地与文档一致**：Electron 主进程动态加载内嵌 Hono server（生产/开发双路径，`electron/main.ts:137-146`）；前端单一 API 出口 `src/api/client.ts`（#1）；vite 代理支持 `BACKEND_PORT`/`FEISHU_SYNC_DEV_TOKEN`（`vite.config.ts`）。
2. **业务模块完整**：检测（change-detector）、同步（sync-engine）、表格重构（layout-reconstructor，五类块规则有注释锚点）、LLM 通道（content-backend/direct-channel）、SQLite（local-map-store）、自定义归档（custom-doc-sync）等 34 模块 + 10 路由文件。
3. **发布链可用**：release.yml 覆盖 mac x64/arm64 + win x64，含依赖缓存、并发幂等 release 创建、CHANGELOG 提取 notes、latest-arm64 通道分离；build-desktop-target.cjs + electron-builder.config.cjs 参数化（平台/架构/签名模式校验齐全）。
4. **变更管理活跃**：CHANGELOG 与 package.json 同步推进（0.3.46），git log 近 5 条均为 release 提交。
5. **测试资产规模**：server 43 个测试文件覆盖路由/引擎/原子提交/迁移等；CLAUDE.md 记录的 gotcha（CORS dev gate、DI 中间件顺序、ABI 切换）有真实注释支撑（模块头注释抽查一致）。

## 三、缺口与风险（按影响排序）

### A. 质量门禁缺失（对"大规模开发前"影响最大）
- 无 push/PR CI（#5）；贡献全靠 README 自觉条款。
- 根 package.json 无 test/typecheck/lint（#4、#6）；前端 6 个测试文件实际无处运行（#4）；vite build 走 esbuild 转译不做类型检查〔推断：vite 默认行为，未单独验证报错路径〕。
- 推论：v0.3.28→0.3.46 的 18 个版本中回归防护主要依赖 server 侧测试的本地自觉运行 + 真机走查〔推断，无 CI 运行记录可查证〕。

### B. 文档基线漂移（新开发者/Agent 的第一入口已失真）
- README 三处硬漂移：版本（11/342 行）、electron-builder、better-sqlite3（52/55 行）（#7）。
- CLAUDE.md 两处技术细节漂移：NodeNext、1475 行（#9）；CLAUDE.md 是 Agent 工程约定入口，其行数/解析器声称会误导后续开发。
- 无 docs/ 目录，无架构文档/模块地图/A_DR（架构决策记录）；模块知识分散在模块头注释与 CLAUDE.md（#17）。

### C. 仓库卫生（历史工作流产物混入源码树）
- 同步产物入库（#14）、根目录一次性报告 ×2、死审查状态、agent 产物入库（#15）、scripts 混杂 + Python 混入（#16）。
- `.gitignore` 全局 `*.png/*.jpg/*.gif` 的副作用已实际发生：win 打包图标被规则拦截且从未入库（#12）。

### D. 版本状态
- 本地落后 origin 1 commit（v0.3.47 未拉取）；server 子包版本 0.2.0 脱节（#18）；appId 占位（#13）。

## 四、CLAUDE.md 声称抽查结果（非穷尽）

| 声称 | 结果 |
|------|------|
| server 用 `.js` 扩展名 import | ✅ `server/src/index.ts:22` `./data-root.js` |
| NodeNext 解析 | ❌ 实为 bundler（`server/tsconfig.json:7`） |
| sync-engine 1475 行 | ❌ 实为 1818 |
| e2e 脚本端口硬编码 | ✅ `e2e-integration-test.ts:11`（4123） |
| api/client.ts 唯一出口 | ✅ grep 全 src 非测试文件仅此一处 fetch( |
| 生产/开发 server 加载路径 | ✅ `electron/main.ts:137-146` |
| migration v2..v5 文件级参考 | ✅ 脚本存在（.sql/.mjs/.ts/.py 混杂） |
| atomic-commit 顺序 / 99991400 退避 / SyncEngineTestHooks | 未核验（本轮未逐行读） |

## 五、待核验项与证据缺口

1. 未运行 `npm test` / `typecheck`（只读约束）——测试当前是否全绿未知。
2. origin v0.3.47 提交内容未读（本地无该对象，仅提交标题）。
3. electron-builder 对缺失 `build/icon.png` 的实际行为（报错或回退默认图标）。
4. README"工作时间 15min"已核（polling-scheduler.ts:69），"夜间 2h"未核。
5. config-manager 的 watchedRoots 真相源实现未直接读码核验（仅两份文档互相印证）。
6. 项目 references（根 tsconfig → server/tsconfig.json）无任何 script 使用〔推断〕，未验证 `tsc -b` 行为。

## 六、范围澄清问题（需用户拍板；本报告不替选、不排期）

用户已明确的只有：大规模开发前做全面工程整理与文档补齐。以下边界需用户决定：

- **Q1 允许的改动面**：是否允许动物理布局与配置（例：`server/400-*.md` 移出仓库、根目录散件归档进 docs/、server/scripts 分层、electron-builder/tsconfig 清理、引入 lint 与前端测试运行器）？还是仅补文档、一律不动现有文件位置？
- **Q2 兼容性红线**：已发布安装包的自动更新 feed、产物命名（FeishuSync-*）、用户数据（~/.feishu-sync SQLite/config 结构）、`server/package.json` 字段是否必须保持不变？
- **Q3 大规模开发的主战场**：桌面 GUI / server 同步引擎 / 脚本与运维链？这决定文档体系（模块地图/ADR/运维手册）与门禁建设的优先对象。
- **Q4 整理基线**：先把本地同步到 origin `v0.3.47` 再整理，还是直接基于本地 `v0.3.46`？（当前落后 1 个提交，涉及认证修复）

以上每题均需用户选择方向；本报告仅提供事实约束（如 #12 表明改 .gitignore 与打包图标存在耦合），不做选型裁决。

---

*报告生成：白泽（explorer）· 只读审计 · 未运行测试/构建/安装 · 未做任何改造。主文档即本文件；派发链 artifact metadata 由 harness 托管。*
