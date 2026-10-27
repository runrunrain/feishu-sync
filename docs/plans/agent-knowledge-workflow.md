# 工程治理与 Agent 标准知识库工作流

## 授权与基线
- 自治：unattended。用户全面授权工程整理；保留功能、用户数据、安装包与自动更新兼容。
- 2026-10-26：已 fetch origin 并 fast-forward 本地 main 到 8e35146（v0.3.47）。版本号保持，不创建 release/tag，不 push（未获远端发布授权）。
- 上游调查：docs/reports/engineering-baseline-audit.md（调查时基线 0.3.46，版本差异已由本次同步解决）。
- 最终目标：原始飞书知识库只读保全；pi Agent 生成有来源、可追溯、策划文风的标准知识库；可视化浏览阅读；持久会话支持设计讨论和显式 Work 本地操作；只读 MCP 对外查询。

## 总验收
1. 工程入口、模块职责、开发/测试/打包/数据安全与脚本用途有统一文档，校验可复现。
2. 工程整理通过测试/构建/风险审核后提交 main，不发版；随后创建探索开发分支。
3. 新功能复用 pi 正式 SDK 或 RPC，不另造 Agent；模型不可用时诚实报告，禁止伪造生成结果。
4. 原始库与标准库隔离，来源与构建状态持久化；失败不发布半成品。
5. 阅读、会话、Work 权限边界与 MCP 查询都有自动测试和真实入口验证；前端必须真实浏览器交互验证。

## 阶段与任务
| ID | 完整切片 / 负责人 | 前置与输入 | 产物 | 验收 | 状态 |
|---|---|---|---|---|---|
| G1 | 工程治理、文档、验证入口 / luban | v0.3.47、基线调查；隔离 worktree | 工程与文档 diff、docs/reports/engineering-governance.md | check/test/build；保留现有运行契约 | accepted：9281352f；Leader补隔离/排除/事实修正，54+615用例及构建通过 |
| D1 | trade-wisdom 与 pi 调研、公共方向设计 / fuxi | 用户方向、现有项目和 pi 文档；仅写设计 artifacts | docs/design/agent-knowledge-design.md，公共 API/状态/权限约定 | 真实代码证据，方案可实现，不照搬参考 | accepted：255048cd；公共契约 docs/design/agent-knowledge-design.md，研究证据已落盘 |
| G2 | main 集成验证与高风险审核 / Leader + diting | G1 | 验证证据、review | 通过后提交 main，不升级版本 | completed：治理main提交 2c2a6dd；8b8c6692 + 9438878e 复审PASS；native运行缺口保留 |
| F1 | 标准库、pi 会话与 MCP 后端纵向切片 / luban | main 已提交、D1 公共契约 | 代码/测试/运维文档/报告 | 原始库保护、原子发布、只读讨论、显式 Work、MCP 真协议 | accepted（本轮续接）：旧交付rejected历史保留；R01/R04残留及活进程运行根回归修复后独立PASS，既有9项关闭保持 |
| F2 | 标准库浏览和 Agent 会话 UI / luoshen | main 已提交、D1 公共契约 | UI/测试/真实交互证据 | 阅读、来源、构建、会话、模式/错误状态 | accepted：a8c7fb5b；已整合，fixture browser+24截图/视觉委托，真实F1联调待F3 |
| F3 | 开发分支集成、端到端验证、独立审核 / Leader + diting | F1、F2 | 验收矩阵/报告/分支提交 | 全套检查 + UI 真交互 + API/MCP 实测；如无可用模型明确未覆盖 | completed（本地开发分支）：R01/R04独立PASS，前端95/后端750及构建通过；按原目标本地提交，未合main/push/tag/release，安装包/native验证缺口保留 |

## 跨边界链路与责任
- 同步文件 → 构建 API → pi → 暂存标准库 → 校验发布 → UI 阅读：F1 负责身份/来源/构建状态，F2 消费，Leader 真实入口集成验收。原始库不可被构建工具改写。
- UI 会话 → 会话 API → pi tools → 事件/持久消息：Discuss 默认无本地写工具；Work 显式切换并绑定受控工作目录。F1 实施权限，F2 明示并处理错误/断线，Leader 验证模式切换与失败路径。
- 外部 MCP client → 标准库搜索/读取：F1 负责 JSON-RPC/transport、路径边界和只读暴露；Leader 以协议调用验收。

## 隔离与专家 Gate
- G1 使用 dirty-snapshot worktree；D1 只写主树 docs/design，与 G1 写面隔离。集成由 Leader 核对后完成，不覆盖范围外文件。
- F1、F2 公共契约先定，各自 worktree；API/types 归后端，UI 按契约实现。
- D1 调用 fuxi 设计态一次，供全部新功能共享。G2、F3 各做一次风险导向 diting 审核；少量问题直修，多问题合并回派；重大问题修复最多一次增量复审。
- 长命令后台化；缺依赖/ABI 先诊断，不以禁用测试通过验收。

## 风险与回滚
- 不修改既有 appId/更新 channel/数据目录，仅记录历史问题，避免破坏安装兼容。
- 不读取用户凭据配置到日志，不做真实飞书写入；模型调用仅显式测试/配置允许时执行。
- 用户原始知识库只读，输出目录必须独立，路径逃逸与 symlink 边界需测试。
- pi 模型/凭据不可用不能用 mock 冒充实测；保留可运行配置入口与准确未覆盖声明。
- 主树提交与分支操作由 Leader 完成；治理 main 和功能分支分开，可独立回退。

## 决策与修订
- 2026-10-26：用户确认全面改造、兼容现有功能与用户数据、先同步最新基线；明确后续 Agent 标准库方向与无人值守授权。
- 工程整理优先消除真实维护障碍；不为了目录美观改动成熟同步核心。工程治理阶段可记录大模块拆分方向，功能阶段按真实职责扩展。
- 2026-10-26 11:46:24 系统重启。Leader 11:51 核实 boottime 晚于旧任务启动，原进程组清空，无原任务进程；工具 reconcile 将重启后系统进程视作疑似后代而拒绝关闭，cancel 同样拒绝历史任务。已请用户执行两条 `/amagi recovery confirm-exited`。禁止重放或重派并发写任务，等待恢复后从当前落盘现场续接；摩擦记录 ev-20261026-165da9。
- 中断现场：G1 worktree 修改 package.json/package-lock.json，新增根与 server vitest.config.ts；依赖已有部分安装。G1/G2 未完成，未提交 main、未创建功能分支；D1 无设计 artifact。
- 2026-10-26：插件已完成后续新任务跨 boot 自动恢复优化；旧 macOS 记录无 boot 身份，最终安全实现保留一次人工确认。主上已在 TUI 为两条旧记录确认无残留进程，正式 reconcile 成功关闭为 cancelled/exited（不推断成功）。G1 续接 9281352f，D1 续接 255048cd；现场仅已有部分配置，未提交，不重放安装。
- D1 已接受：外部 Node>=22.19 + pi>=1.4<2 的 RPC 侧车，不升级Electron；Discuss只读、Work受控文件工具（无shell）；不可变release+CURRENT原子指针；MCP stdio只读manifest/Markdown、无SQLite依赖。Leader修正POSIX/macOS路径containment为realpath精确比较。真实模型工具往返尚未验证，不能把隔离环境无凭据说成主机全无凭据。D1设计/研究文件属于下一功能分支，治理main不混入未来功能设计。
- G2已接受：初审dry-run文案/Node范围/DI描述三项均修复并复审PASS。开发宿主支持^22.19.0 || ^24.0.0；默认测试home隔离；原始库来源不能只筛status=synced（changed/error但有成功本地版本仍保留）。Electron31 headers重编译成功，但本机最小启动卡dyld，runtime与打包仍未验证，不阻断不发版治理提交。
- 治理提交：main@2c2a6dd（55文件，v0.3.47未变，无tag/push/release）。来源软警示已只读复核：31个现存文件与G1 worktree逐字节一致，23个为Leader整合修正/验证资料，5个旧路径为4份报告归档原址及误入源码空壳删除；icon.png 1.5MB需20MB读取预算，非缺失文件。未来设计未混入该提交。
- 已切换 feat/agent-knowledge-workbench，D1公共设计与研究在此分支持久化，接下来F1/F2各自worktree并行；首轮Work不提供shell，外部MCP必须无SQLite原生依赖。原始源集合保留有成功本地版本的changed/error行，避免检测状态变化被误当源删除。
- 功能公共契约提交104ba2f；来源提示中design-research为已接受D1子任务产物，已只读git show复核。F1 ca201dd8（server/构建）、F2 a8c7fb5b（src/electron）各自worktree并行，无共享写入；公共API按D1，偏差必须回Leader。F3统一集成测试/真实入口+一次高风险阶段审核。
- 已只读核查F1/F2新launch-anchor均记录bootId（新插件确已加载），若再次跨重启可使用可靠boot身份自动恢复；不再沿用旧macOS无身份记录的缺口。
- Leader用pi-agent-dir合法只读RPC就绪探测（get_available_models，无prompt/无直接读凭据文件）得到504可用模型；D1无key结论只适用于隔离测试目录。已告知F1可在显式opt-in的临时配置中通过pi使用已有凭据做最小真实模型调用，不能假称无凭据跳过。
- Leader实际真实调用：builtin Haiku4.5收到HTTP400（已分类诊断，available不等于可调用）；改选已注册amagi-glm/glm-5.3-flash、关闭retry与thinking，2s内agent_settled/stop并精确回复smoke标记（bg-8ed04bae）。仅临时无敏感内容，无工具，不能冒充应用工具链验证；已通知F1可用路由。
- F2安全补充：既有MarkdownView的Markdown href缺协议allowlist，HTML链接只拦简单javascript。已要求UI侧统一安全协议/实体与控制字符处理、远程图片不附desktop token；新Agent/标准库入口默认不自动加载任意外部图片，避免模型输出借图片URL外发源内容。与新功能同批实现/测试/阶段审核，不在main治理提交中偷改旧行为。
- F1安全补充：Work的授权目录不得与应用运行代码/资源、pi安装树及pi-agent-dir凭据目录重叠，防止写扩展或可执行模型配置后被下一侧车加载而间接突破‘无shell’边界。由服务端路径确定保护根并复核，API不变；普通独立文档Workspace可用。不把文件工具围栏说成抵抗同uid外部程序或第三方自动执行的OS沙箱。
- F2已整合并接受：主树check/electron:build通过；Leader补图片授权绑定具体URL（切文档/换query重新确认）与本地CSV文件名空格保留/反斜杠协议相对拦截，lint/typecheck/前端测试再次通过。F2新端点验证是明确fixture，不计为最终F1联调；报告docs/reports/agent-knowledge-ui.md、截图global artifacts/f2-agent-knowledge-ui-shots。
- F1收口前Leader只读发现并要求修正两项具体接线：状态路由factory捕获旧config导致保存后status/probe仍旧值；raw-source谓词遗漏旧lastSyncedAt成功证据并把cloudDeleted观测标记直接当源删除。HTTP新config由F1修复，源谓词在终稿后由Leader整合修复。
- F3从主树真实pi/HTTP、浏览器、MCP验证核心闭环；又修复CSV附件围栏、SSE空游标/溢出、完整message_end DTO和工具多轮草稿锚点、停止ACK覆盖新SSE idle的竞态。测试与截图含失败现场而非只留成功图，完整证据在integration报告。
- 06b9041e独立full审核FIX（1C/10M），已接受报告，不代表接受功能。R01–R11包括完整代码树隔离、配置逆向重叠、默认app-llm注册、插话队列所有权、进程/能力回收、busy/idle、full工作集、源变化阻断、指针后DB对账及清理、JSONL元数据父链。全部一批续接04a0416b。续接前Leader回填5个后端修正到原worktree并比对190文件与主树一致，防止续接覆盖整合。
- 暂不提交功能分支；main治理提交和未改版本号/不push不发版约束不变。
- 唯一增量复审c478ffaf（报告已接受）仍FIX：9项关闭；R01遗漏Node发现时执行的npm真实代码根，R04进程活着但已settled的get_state收尾窗口仍接受无人消费的消息。04a0416b的‘全修完’交付已拒绝，保留已整合的有效修复和Leader补强，不回滚现场。按规则停止自动修复/复审循环，上报主上；后续须显式决定残留修复，不以全绿测试强行通过。最终检查bg-03556463为741后端/95前端及全部构建通过，功能分支仍未提交。

- 2026-10-26（America/Los_Angeles）：用户通过交接文档明确续接R01/R04，另显式授权只读审查子Agent。先复现旧反例，再移除npm执行发现、补实际npm包根与收尾双守卫。独立审查发现首个候选在A→B切换后丢失旧活进程根保护，已改为服务生命周期运行根集合并补真实协议进程回归；该候选没有提交。有限复核最终PASS，独立5文件53例和原样A→B反例通过；最终check为前端95/后端750例，构建及MCP stdio通过，允许本地功能提交。详见当前review与残留修复验证报告。
