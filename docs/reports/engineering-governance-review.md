# G2 工程治理独立审核（full）

## 结论

**VERDICT: FIX**（Critical 0 / Major 1 / Minor 2）。阻断项是新增运维文档把实际会写状态库的 dry-run 描述为“只出报告 / 显式 apply 才写盘”，不是发现了新的同步业务缺陷。问题均可小范围文档/环境契约修正，无需改业务实现。

**native 缺口本身不阻断本次不发版的 main 治理基线接受**：现有证据支持 Node24 crash 已消除、Electron31 headers 编译可行；不支持 Electron 下 SQLite 已运行成功。修正文档后可接受治理基线，但不能据此签发桌面包兼容或发布验收通过。

## 范围与基线

- 项目：`/Users/run.mao/workpace/feishu-sync`；HEAD `8e351468384c65033baa25e6b5ae8d9a14616e85`（v0.3.47）。审查对象为当前未提交治理 diff，含新增配置、文档和资产；无提交行为。
- 必读输入已完整读取：`CLAUDE.md`、`docs/reports/engineering-governance.md`（含 Leader §六）、`docs/plans/agent-knowledge-workflow.md`。补读 `docs/reports/leader-baseline-validation.md`。
- 并行 `docs/design/`、未来功能方案及其研究报告不在本轮审核范围；不把它们混为治理提交内容。
- 只读项目，仅新增本报告。未读真实用户配置/凭据，未运行真实同步/修复、安装、native rebuild、打包或全套测试。

## Findings

### G2-01｜Major｜运维 dry-run 写入边界声明错误

- **定位**：`docs/operations.md:29,52-56`。
- **触发条件**：维护者按文档把 `sync-latest.ts`（包括 `--skip-index`，不带 `--apply`）当作仅生成 manifest/报告的操作，用真实状态目录执行。
- **实际影响**：即使不 apply，脚本也会创建缺失配置、打开并初始化/迁移 SQLite；鉴权成功后还会检测并更新 observed 等状态。`--skip-index` 仅跳过扫描，不能禁止这些状态写入。文档的风险分类掩盖了实际用户状态写入，违背本轮脚本风险声明须与实现一致的验收。知识库正文的 apply 门仍在，不能把它等同于“全部磁盘状态不写”。
- **证据**：`server/scripts/sync-latest.ts:514-535` 在任何 apply 分支之前执行 `prepareSyncLatestConfig()` 和 `store.initialize()`，且早于鉴权；`:382-387` 在配置缺失时直接 `writeJsonAtomically()`；`:549-556` 是非 skip-index 扫描，`:565-573` 是不受 apply 控制的检测。实际写 KB 的分支直到 `:674` 才判断 `args.apply`。独立运行既有 `sync-latest-config.test.ts` 的 `creates a missing config` 用例，exit 0，确认无 persist/apply 的配置创建行为；数据库/检测路径为静态证实，未执行真实同步。
- **归因**：脚本行为既有；本轮新增风险目录与说明引入错误承诺，不要求改变脚本既有行为。
- **最小修复方向**：将该脚本明确列为“默认不写 KB 正文，但会写配置/SQLite/报告”的有状态操作，补充隔离/备份要求；修正示例注释与 L2 分组标题/说明，不能再以 apply 作为所有写盘的边界。复核 CLAUDE 同类简写，避免继续传播同一歧义。

### G2-02｜Minor｜新声明的 Node 支持范围宽于锁定工具链

- **定位**：`package.json:35-36`、`docs/development.md:5`、`README.md:83`、`CONTRIBUTING.md:12`。
- **触发条件**：开发者采用文档允许的 Node20 早期版本、Node22 早期版本或 Node21，执行双包安装/质量门/桌面构建。
- **实际影响**：声明不构成可信的支持矩阵；可出现 EBADENGINE，engine-strict 下安装被拒，早期 Node 上工具加载也可能失败。当前实测 Node24、CI 最新22不受此项影响。
- **证据**：锁文件中 `@electron/rebuild@4.0.4` 要求 `>=22.12.0`（`package-lock.json:599`，该依赖既有）；本轮新增 lint 链的 `eslint-visitor-keys@5.0.1` 要求 `^20.19.0 || ^22.13.0 || >=24`；SQLite12 要求 `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`（排除21）。读取实际安装包 engines 并用 semver 对照，20.0/20.19/21.7/22.0 均被根 `>=20` 接受，却不满足 rebuild；21还不满足 SQLite。未安装或运行这些旧 Node，未声称逐版本实测失败。
- **归因**：工具链部分最低要求既有，本轮新增根 engines/更新开发指南时未收敛实际要求。
- **最小修复方向**：统一声明经工具链支持的开发 Node 范围（例如明确受支持的22较新版本/24 LTS），或明确区分仅 server 与完整开发打包环境；勿因 Electron 内嵌 Node20 而推断宿主开发工具也支持全部20版本。无需因此升级 Electron。

### G2-03｜Minor｜DI 表格仍引导消费者从错误位置取依赖

- **定位**：`docs/architecture.md:46`（DI 行）。
- **触发条件**：开发者按该行后半句“路由从 c.env 取依赖”新增路由。
- **实际影响**：取得 undefined；该行同时声明“并非 c.env”，内部冲突，与已修正 CLAUDE 及实际注入不一致。
- **证据**：`server/src/index.ts:195-205` 挂载 `(c as any).configManager/localMapStore/...`；`server/src/routes/custom-folders.ts:89-90` 从 context 自身读取；没有该表格声称的 env 注入。
- **最小修复方向**：将该行后半句同步改为“从 context 同名属性取依赖”。

## full 覆盖清单

| 审核面 | 核验与判断 |
|---|---|
| lint 等价性/行为 | 已逐项读全部产品及测试 diff，含以文本方式读取被 Git 判为 binary 的 sanitize-local-dir 测试。BOM→转义、正则字符转义/空格量词、let→const、未用 import/解构删除均未发现语义变化。Input 的 className 改名仍被解构排除，未开始透传。 |
| 安全写盘/归属 | atomic-commit/sync-engine 主体未改；LocalMapStore 的正则改写与 const 不改变迁移、归属和 synced 推进。独立运行原子提交回滚7例、自定义归档49例通过，包含竞态守卫与共享媒体回滚。 |
| 鉴权/CORS | 注入、health、auth、受保护路由顺序未改；读实际注册与 auth 代码，独立运行 CORS 5例通过。没有独立 auth 单测运行成功的证据，见命令备注。 |
| 测试可信度 | 未删除断言或禁用失败用例；html-table 的条件分支前仍有强制 type 断言，不能凭分支跳过变绿；MarkdownView predicate 更严格。mediaGap 测试改成合法枚举，仍验证同一分类行为。 |
| home 隔离 | globalSetup 装载前设临时 FEISHU_SYNC_HOME，teardown 恢复变量并只删除自身 mkdtemp 目录；独立环境用例通过。检索 server/tests 未发现硬编码真实 `.feishu-sync` 或 homedir 绕过。CLI 可执行发现路径不等于应用数据根隔离；本轮未触发真实飞书链路。 |
| CI/本地一致 | CI 双包 npm ci 后按 lint/typecheck/test:all 执行，等价根 check 顺序，再构建；未见跳过测试/吞错。最新 Node22 runner 与本地24有版本差异但均为声明的验证环境。实际 GitHub runner 未运行。 |
| 依赖/迁移/打包 | server 锁文件除 SQLite 驱动12升级无其他运行依赖变更；根主要增加治理工具及 vitest，js-yaml 有4.2→4.3.2解析结果变化。SQL接口调用/启动协议/打包 files、asarUnpack、appId、feed、版本号均未变。SQLite 跨 major 与 bundled SQLite 行为仍需 Electron运行补证，不以编译替代运行。 |
| 性能/一致性/维护性 | 无新增业务热路径、并发流程或写盘步骤；未见相关性能/并发回归证据。新增全局隔离解决真实home日志污染风险；不把全绿等价为覆盖完整。 |
| 资产/删除/归档 | icon.png 文件头确认1024×1024 RGB PNG，符合现有 win.icon 路径；未做视觉审美判断。4份归档逐字节对比 HEAD 原件均相同；被删400文档确仅header+标题；未发现代码消费者断链。历史工件内部既有绝对路径不伪装为新回归。 |
| 提交卫生 | .amagi-worktrees/、amagi-task/ 已被 ignore，lint/format亦排除；构建 files 白名单不收 docs/任务工件。当前 docs/ 整体未跟踪，含并行D1设计、计划、研究报告：提交时须按授权白名单选取，不能直接把整个docs当作治理产物。未执行 git add/commit。 |

## 独立验证记录

cwd 除特别注明均为项目根。以下为本审核者实际执行，非复述 Leader 全套结果。

| 命令/核验 | 状态 | 结果 |
|---|---|---|
| git status / diff / rev-parse、git diff --text（sanitize测试）、git diff --check | exit 0 | 基线与范围确认，diff-check无输出；无业务修复写入 |
| `npm test -- --run tests/test-environment.test.ts tests/custom-folders.test.ts tests/sync-engine-atomic.test.ts tests/auth-middleware.test.ts`，cwd=server | exit 0 | **3文件57例**通过；最后一个auth文件实际不存在且Vitest过滤器未报错，**不能计为auth测试通过** |
| `npm test -- --run tests/cors-middleware.test.ts`，cwd=server | exit 0 | 1文件5例通过 |
| `npm test -- src/components/ChangeListPanel.test.ts src/components/preview/MarkdownView.test.tsx src/utils/html-table.test.ts` | exit 0 | 3文件31例通过 |
| `npm test -- --run tests/sync-latest-config.test.ts -t 'creates a missing config'`，cwd=server | exit 0 | 1例通过，5例因筛选跳过；只运行既有隔离用例，没有运行真实同步main |
| 归档Buffer字节比较、本地Markdown链接存在性、依赖engines semver对照（Node只读取证） | exit 0 | 4份一致；所检本地链接均存在；最低支持范围冲突如G2-02 |
| `file build/icon.png` / `git check-ignore` | exit 0 | PNG类型尺寸正确；两个任务目录忽略规则有效 |

抽检合计 **94例实际执行通过**，无 worker crash。本轮没有编写或修改正式项目测试。工具曾对只读取证命令误提示“执行过Electron ABI构建”，该提示不是真实命令执行证据；本轮未重建任何native模块。

## 上游验证可信度与保留盲区

- Leader报告的双包npm ci、check（前端54/server615）、build:all/electron:build、隔离浏览器保存/导航/API回读与零错误，作为本轮输入采信；没有重复全套/浏览器/构建，也未将截图存在当作视觉审阅。
- 治理前 Node24 crash 在 `leader-baseline-validation.md` 有断言/堆栈记录；治理后独立重跑原49例与原子路径正常，支持修复有效。升级前版本锁实际为11.10.0（声明^11.9），升级后双锁为12.11.1。
- Electron31.7.7 headers隔离重编译成功、最小Node-mode程序仍在dyld阶段超时、adhoc签名strict verify成功均来自 Leader §六；本审核未重新执行。最小console.log都未到达，不能归因为SQLite代码不兼容；也不能以签名/编译成功推断ABI加载、SQL操作或桌面启动成功。
- 未覆盖：Electron内实际打开/查询/关闭SQLite、真实桌面主进程启动、Windows与mac双架构安装包、打包后ABI及更新链、真实GitHub CI、真实飞书/模型远端行为。此次接受范围仅main治理，不含发布。后续在可正常启动的目标环境补Electron内存SQLite冒烟与打包启动；保留准确“未运行”状态，不要求为治理合并强行解除本机安全限制。
- 新增风险目录整体已比仅凭verify/test文件名分类安全，但G2-01必须修正后才满足本轮安全文档验收。

## 交接与回滚

建议 Leader 直接修正上述少量文档/Node契约问题，逐编号确认关闭；native盲区保持，不因文档修正改称运行通过。无需重跑全套或改业务代码。本审核唯一文件变更为本报告；如需撤回，仅撤回本报告新增文件，勿使用批量restore/reset影响并行现场。


## 一次增量复审（Leader 直修后，2026-10-26）

**VERDICT: PASS**。本节为当前结论，取代上文初审 FIX；初审发现与验证原文保留作为历史证据。范围仅 G2-01/02/03 修复及直接相关契约，不扩展未来设计审核。

### 原编号关闭证据

- **G2-01（Major）：关闭**。`docs/operations.md:29-30,52-56` 已区分KB正文提交与状态/报告写入，列明配置创建、SQLite初始化/迁移、observed与备份；README.md:169 说明dry-run并非所有磁盘状态只读；CLAUDE.md:56-59,97 同步边界与缺失配置首次创建。与初审已核实脚本路径一致。
- **G2-02（Minor）：关闭**。根 package.json 与 package-lock.json 的根engines均为 `^22.19.0 || ^24.0.0`；semver检查接受22.19/24.0/24.21，排除20.19/21.7/22.18/23/25，满足初审相关工具最低要求。README.md:83、CONTRIBUTING.md:12、docs/development.md:5、CI注释:6一致；开发指南明确宿主与Electron内置Node分离。Electron声明仍^31.7.7、锁定31.7.7，未升级。
- **G2-03（Minor）：关闭**。docs/architecture.md:46 已将路由读取改成“context同名属性”，与该行注入说明、实际代码及CLAUDE一致。

### 验证与边界

- 读取修订后的 operations/development，检索 README、CLAUDE、CONTRIBUTING、CI、architecture 的对应行；根目录执行只读取证命令（git diff package.json + Node解析双JSON/semver），exit 0。未重跑全套、构建、安装或真实同步。
- native 边界保持：engineering-governance.md:68 仍明确最小 Electron Node-mode 在加载器阶段超时、未到 SQLite；未出现把重编译成功改称运行通过的声明。该缺口不阻断本次不发版 main 治理基线接受，不代表桌面运行/安装包/发布验收通过。
- 三项修复未见直接引入回归；当前未关闭 Critical/Major/Minor 均为0。未重新审计无关区域。Leader已明确未来设计不冒充治理产物、workflow活文件可作为编排记录保留；本轮未执行提交，不对尚未形成的提交文件集签发检查结论。
- 本轮唯一写入为本报告追加段，未改业务代码；如撤回复审，仅撤回本追加段，保留初审证据与其他现场。
