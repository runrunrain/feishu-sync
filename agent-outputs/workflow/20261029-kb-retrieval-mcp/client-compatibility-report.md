# MCP 客户端兼容性：修复后真实 CLI 复测

## 结论与边界

**本机客户端修复复测通过。** 真实 pi 1.4.0 的 initialize 名称命中预算；direct 按 next 完整恢复 8k/15k 合成正文且每页未截断。Claude Code 2.1.312 的首次模型工具表含七工具，原先缺失的三个工具均实际调用成功；15k/25k/40k 正文逐字送达。此前发现的 `oneOf` 问题保留为历史证据，已按新产物复测关闭。测试是**真实 CLI + 产品 MCP + 回环合成推理 fixture**，不是实际 LLM 效果或人工评测；第二台设备未测。

上游输入：
- `/Users/run.mao/workpace/Database/01-AI技术与工具/飞书同步/知识库方案/知识库检索与MCP服务设计方案.md`，全文，尤其 §12.2 U2/U3 和 §13.12 U7/U10。
- `CLAUDE.md`；`agent-outputs/workflow/20261029-kb-retrieval-mcp/investigation.md`；`agent-outputs/workflow/20261029-kb-retrieval-mcp/stage-b-evidence.md`。
- 本机 pi `README.md`、`docs/mcp.md`、`docs/cli.md`、`docs/security.md`、`docs/environment-variables.md`、`docs/models.md` 和 `docs/models-configuration.md`。直接调用的中文截断已在下文独立实测。

## 本轮修复后复测（当前结论）

Leader 上游反馈：移除三工具顶层 `oneOf`、保留服务端互斥校验；pi 客户端 session 限制响应预算 6000 字符；构建及 26 项相关测试通过（`bg-22e8d0be`，Leader按原始日志校正计数，本轮未重跑该组）。本轮只改本报告与 `client-smoke.mts`，**未修改产品**。

续测运行同一套 `CASE_FILTER=pi-stdio|pi-http|claude-stdio|claude-http` 命令，逐批独立执行，四批均退出 0，客户端全部退出 0，gateway 退出 0。脚本通过 stdio 透明转发器或本机 HTTP 透明转发器只记录 initialize 的 `clientInfo`，不改变 MCP 消息；只把合成消息传到回环推理 fixture；不得将该 fixture 当成真实模型。测试时 `KB_MCP_MAX_CHARS=60000`，不代表产品默认值。真实客户端收到的 pages 和其 stdout 中的工具结束事件由脚本逐字对比。

### pi 实际名称、分页与重组

四种 stdio/HTTP × direct/codemode 均捕获真实 initialize `{"name":"pi","version":"1.4.0"}`，命中产品的精确 `clientName === 'pi'` 分支；HTTP 抓取的是流经回环转发器的实际 initialize，stdio 抓取 stdin 原始协议，仅记录 clientInfo。

| 中文正文主体 | direct 每页字符数 | 每页 UTF-8 字节 | 按 next 的 startLine | 实际逐行重组 |
|---|---|---|---|---|
| 8k | 5,487 / 3,833 | 14,997 / 10,501 | 50 / 结束 | 83/83 行，逐行相等，首/中/尾均存在 |
| 15k | 5,480 / 5,453 / 5,445 / 1,126 | 14,992 / 14,949 / 14,943 / 2,946 | 50 / 97 / 144 / 结束 | 153/153 行，逐行相等，首/中/尾均存在 |

两种传输逐页一致；脚本同时检查页内字符 ≤6000、每页字节 <20,480、无截断标记、行号连续无重复、末页无 next；stdout 与实际发给合成模型的每页逐字相等。表中字符含帧和行号；原始非 pi 基准完整响应分别为 9,191 / 25,365 字节与 17,105 / 47,419 字节。codemode 分别实际调用 2/4 页，脚本看见首中尾，向模型仅返回 97 字节统计摘要，**不声称模型收到全文**。未配置 description 时，codemode 后续用户提示的 system 消息含 instructions 完整首行；direct 未见首行但工具描述已列入首次清单。

### Claude 七工具、三调用及正文大小

stdio 与 HTTP 均捕获 `clientInfo.name=claude-code`、version `2.1.312`，首次出站模型工具表实际包含 `search_knowledge`、`grep_knowledge`、`get_outline`、`get_knowledge`、`get_knowledge_bundle`、`list_knowledge`、`get_release_info` 七项。每个会话实际依次调用：`get_outline(path)`、`get_knowledge_bundle(paths,maxChars=2000)`（**非 dry-run**，返回真实正文帧和分页）、`get_knowledge(path,maxLines=2000)`；三项均非错误，首项含合成章节，第二项含 `<kb_doc>`。正文路径不再以 release_info 代替。

| 中文主体 | 产品 get 响应字符 / UTF-8 字节 | Claude stdout 与发送模型 | 哨兵 / 截断 |
|---|---:|---|---|
| 15k | 17,105 / 47,419 | 两者均与原始响应逐字相等 | 首/中/尾均保留，未截断 |
| 25k | 28,405 / 78,919 | 同上 | 同上 |
| 40k | 45,355 / 126,169 | 同上 | 同上 |

各大小在两传输均完成三调用；本次未观察截断标记或保存路径。仅对上述合成中文正文和配置有效，**不声称判定 25k token 门限**。输入输出为 BMP 字符，字符计数为 JS UTF-16 code units，字节为 UTF-8。

证据目录（仅合成数据；含出站 request 和 stdout 事件）：pi stdio `/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-client-fixture-6XzIbm/`，pi HTTP `/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-client-fixture-IzSxFY/`，Claude stdio `/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-client-fixture-RNuBts/`，Claude HTTP `/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-client-fixture-8KkKrw/`。所列目录 `.log/.json/.jsonl` 中 `fskb_` 格式扫描均 0；随机测试令牌仅在环境中传递。

定向验证：仓库根 `./node_modules/.bin/eslint agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts` 退出 0；`server/` 下 `./node_modules/.bin/tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --allowImportingTsExtensions ../agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts` 退出 0。`ps` 检查本次 `kb-client-fixture-` 网关剩余 0。未运行全量测试。

未覆盖：真实 LLM / 12 问人工判分 / 80 条真实 qrel、第二台设备及实际内网延迟、Claude 项目 `.mcp.json` 批准流程、Claude token 数门限。上述缺口不影响本次本机合成推理 fixture 范围，但不得外推为完整生产质量验收。

---

## 环境与隔离（沿用）

- macOS arm64，Node `v24.21.0`，pi `1.4.0`；`command -v claude` 未命中。全局 `@anthropic-ai/claude-code` 包为 `2.1.312`，其安装脚本已阅读：只定位可选平台包并硬链/复制二进制到包内。未运行全局脚本、未修改全局安装。
- 在自建 `/tmp/kb-client-compat.RZJYnd/` 执行 `npm install --prefix <owned-temp> --ignore-scripts --no-audit --no-fund --package-lock=false --cache <owned-temp>/cache @anthropic-ai/claude-code-darwin-arm64@2.1.312`，退出 0；直接调用该官方平台包的二进制，`--version` 为 `2.1.312 (Claude Code)`。未使用 curl|sh、管理员、共享依赖或工作区 lockfile。
- `server/tests/helpers/kb-search-fixture.ts` 写入独立合成 `smoke-release`，路径 `战斗/伤害.md`，正文只含自造暴击规则；`FEISHU_SYNC_HOME`、HOME、`PI_CODING_AGENT_DIR`、`CLAUDE_CONFIG_DIR` 全在 owned 临时目录；gateway 仅绑 127.0.0.1 的操作系统分配端口。测试随机 token 在进程环境中传递，gateway 只接收摘要，报告不含 token 或摘要。
- 项目产品代码和 UI 服务未改动、未接管。两个客户端都是 CLI 真实进程，产品路径为 `server/dist/mcp/kb-mcp.cjs` 和 `server/dist/mcp/kb-mcp-gateway.cjs`。临时 smoke 驱动文件 `/tmp/kb-client-compat.RZJYnd/smoke.mts` 不含明文令牌；运行时生成随机令牌。

## 实际调用与结果

工作目录为仓库 `server/`：`node --import tsx /tmp/kb-client-compat.RZJYnd/smoke.mts`，退出 0；脚本以 25s/客户端调用超时、5s gateway ready 超时，最终 SIGTERM 并等子进程退出。以下是脚本内脱敏命令及真实输出摘要：

| 目标 | 命令 | 预期 / 实际 |
|---|---|---|
| pi 正确令牌 | `pi mcp list --json`，隔离 `mcp.json` 含 stdio 与 `Authorization: Bearer ${SMOKE_TOKEN}` HTTP | 退出 0；两者 `connected`；各列出 7 个工具：search、grep、outline、get、bundle、list、release_info。证明真实连接与工具发现，**不是 tools/call**。|
| pi 错令牌 | 同命令，替换仅本进程环境变量为错误合成值 | 退出 1；stdio 仍 connected，HTTP `failed`，错误文案 `MCP server requires authentication`。未观察交互授权；这条文案不会显示服务端中文错误。|
| Claude 配置 | `claude mcp add-json -s user stdio <stdio-json>`、`claude mcp add-json -s user http <http-json>`，在独立 HOME/config 中 | 两条退出 0；HTTP JSON 的 header 值为字面量 `Bearer ${SMOKE_TOKEN}`，不是明文。|
| Claude 正确令牌 | `claude mcp list` | 退出 0；stdio 与 HTTP 均显示 `✔ Connected`。证明 user-scope `add-json` 配置中的环境变量在本次运行时可成功用于鉴权；不等同于验证 project `.mcp.json` 的批准流程。|
| Claude 错令牌 | 同命令，使用错误合成环境变量 | **退出仍为 0**，HTTP 显示 `✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401). Check that the token is valid for this MCP endpoint — OAuth fallback is disabled when headers.Authorization is set. Error detail: {"error":{"code":"kb_lan_unauthorized","message":"令牌缺失或无效;请在主机「知识库共享」设置中复制最新令牌"}}`。因此自动化不能仅凭 Claude list 退出码判定成功。|

上述正反配对使用同一个 HTTP 配置和相同二进制，只改变传入客户端进程的 Bearer 环境变量。能证明此配置路径下 Bearer 有效、错误值被拒；并未对网络报文做抓包，也未测试 `.mcp.json` 的 `${VAR}` 项目批准流程或 `--header` 明文添加方式。U7 为**部分覆盖**，不能外推其他版本或第二台设备。

## 修复前续测历史：真实客户端 + 合成推理 fixture

本节以下保留修复前事实，不代表现状。命令入口保留，但 `client-smoke.mts` 已更新为上方修复后测试，不能用现行脚本重现旧产物结论。

`agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts` 是可复用驱动：真实客户端连接真正产品 bundle 和合成发布，回环 fixture 读取各客户端首次请求的工具清单，按名称返回一次工具调用，捕获下一请求实际 tool-result 和 system 内容。只生成合成文本；不访问远端模型、没有真实凭据。pi 使用 owned 目录 `models.json` + dummy key（仅子进程测试后端，不是本角色模型切换）；Claude 使用隔离 HOME、`ANTHROPIC_BASE_URL` 与 dummy key。读取内容以 JS 字符串长度（UTF-16 code units；本例字符均在 BMP）和 UTF-8 字节计。为测 25k/40k，将测试进程的 `KB_MCP_MAX_CHARS` 设为 60000；这是测试变量，**不是产品默认 20000 的行为**。pi 8k/15k 原始响应低于默认字符预算，结果仍适用于该默认值。

在 `server/` 分批执行（每批有外层 175s 和子客户端 45/60s 上限）：

```bash
CASE_FILTER=pi-stdio node --import tsx ../agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts
CASE_FILTER=pi-http node --import tsx ../agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts
CASE_FILTER=claude-stdio node --import tsx ../agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts
CASE_FILTER=claude-http node --import tsx ../agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts
```

4 批命令均退出 0，gateway `exit=0`，客户端各退出 0。`CLAUDE_BIN` 可指向另一份官方 Claude Code；默认使用上节临时官方二进制。`CASE_FILTER` 可缩小到单项。脚本不把 token 写入配置，捕获仅含合成消息，不写 HTTP 头。

### U10：pi 直接调用与 codemode 对照

两种传输结果一致。真实 `get_knowledge`，产品原始响应由独立 SDK 调用测量；SDK 仅作原始载荷对照，客户端行为由真实 pi 与 fixture 出站记录证明。8k/15k 指合成的中文主体规模，原始响应包含行号和帧，因而总字符数大于 8k/15k。

| 中文主体 | MCP 原始响应 字符 / UTF-8 字节 | pi direct 送模型 字符 / 字节 | 真实 CLI stdout 的 `tool_execution_end` | 结果 |
|---|---:|---:|---|---|
| 8k | 9,191 / 25,365 | 7,613 / 20,661 | 与送模型文本同长度/字节 | 中间 `MIDDLE_SENTINEL` 消失，首尾保留；有截断标记 |
| 15k | 17,105 / 47,419 | 7,617 / 20,661 | 与送模型文本同长度/字节 | 中间消失，首尾保留；有截断标记 |

例如 15k 的实测提示含 `…9668 chars truncated…`，以及 `[Full output: /tmp/pi-mcp-10b2b455cd13eaa1.txt (read it with offset/limit)]`。路径为一次运行生成的临时文件，非稳定接口。最新 HTTP 运行的 `/tmp/pi-mcp-cf76c7fdd6885aa3.txt`、`/tmp/pi-mcp-f662d63a32668e34.txt` 均被脚本回读并与同一原始响应逐字相等；临时文件日后可能被系统清理。8k 已因 25,365 UTF-8 字节而被截，说明以中文字符预算 20000 并不能防止 pi direct 中段缺失；测试不能单凭这两个点精确拟合阈值。

codemode 内部脚本实际取得 9,191 / 17,105 字符，三个 sentinel 均存在；它只向模型回传统计摘要，分别 100 / 101 字符与字节。**stdout 的嵌套 `mcp__kb__get_knowledge` 事件仍显示截断版**，而 codemode 脚本取得原文、回传模型的是摘要；不要把 stdout 的嵌套事件误认为 codemode 收到的数据，也不能声称模型收到了全文。捕获：`/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-client-fixture-JdWoBw/`（HTTP）、`/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-client-fixture-p5pXxC/`（stdio）。

### U3：instructions 到达情况

未配置 description。pi codemode 曝光下第一轮请求未发现首行；服务连接后在**第二次用户提示对应的第 3 次出站请求**的 system 消息中发现完整首行 `这是游戏策划标准知识库（只读），提供策划与程序设计文档的检索、穷举、结构和正文读取。`；stdio 和 HTTP 均如此。首轮异步连接可能尚未完成，不能保证初始请求就带首行。direct 曝光的这三次请求未含首行；它直接暴露七个工具描述。实际 fixture 捕获的是客户端真实出站消息，而非仅靠文档推断。

### U2：Claude Code 真实 CLI 结果

由于下节缺陷，无法通过 Claude 实际触发 `get_knowledge`。为不掩盖缺陷，续测使用产品仍可见的 `get_release_info(includeChanges:true)`，在合成 release 的 `changes.json.summary` 中放 15k/25k/40k 中文及首/中/尾哨兵，`KB_MCP_MAX_CHARS=60000`；因此是 Claude **该工具路径**输出行为，不等价于 get 正文的通用结论。各次 Claude CLI 运行均看不到目标工具，原因已在 debug 日志中明确记录。

| 中文主体 | 产品原始响应 字符 / 字节 | CLI stdout tool-result 字符 / 字节 | 实际送合成模型 字符 / 字节 | 观察 |
|---|---:|---:|---:|---|
| 15k | 15,404 / 45,404 | 15,404 / 45,404 | 15,404 / 45,404 | 与原文逐字相等；首/中/尾均存在 |
| 25k | 25,404 / 75,404 | 25,404 / 75,404 | 25,404 / 75,404 | 同上 |
| 40k | 40,404 / 120,404 | 40,404 / 120,404 | 40,404 / 120,404 | 同上 |

stdio、HTTP 均一致；未见截断标记或全文保存路径。这里未测真实 tokenizer、25k **token** 门限或真实模型服务行为；不能根据中文字符数推断 token 数。证据：`/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-client-fixture-nk0gxu/`（stdio）、`/var/folders/q0/6kr7qkp52b922c7_w47mght80000gn/T/kb-client-fixture-HqGzWD/`（HTTP），包含合成 request JSON 与 CLI JSONL。

### 产品缺陷：Claude 三工具不可用

复现：运行 `CASE_FILTER=claude-stdio-15000` 或 `CASE_FILTER=claude-http-15000`，查看 stdout 初始化工具列表和同目录 `claude-<transport>-15000.debug.log`。预期七个知识工具可被 Claude 模型调用；实际只有 `get_release_info`、`grep_knowledge`、`list_knowledge`、`search_knowledge` 四个。Claude 2.1.312 原始错误：

```text
Skipping tool "get_knowledge": its input schema uses top-level oneOf, which the Anthropic API does not accept. Other tools from this server remain available.
```

`get_outline` 与 `get_knowledge_bundle` 有同文案。根因已由客户端日志与 `server/src/mcp/kb-mcp-tools.ts` 三个 schema 的顶层 `oneOf` 相互印证；初次 `claude mcp list` Connected 只证明连接，不证明七工具对模型可见。此任务未修改产品。建议 Leader 交实现任务移除不兼容的顶层组合 schema、保留服务端三选一校验并从真实 Claude 复测三个工具，再用同一驱动测正文大小。

## 修复前的尚未覆盖（历史，现状以上方为准）

- Claude `get_knowledge` 的 15k/25k/40k 输出受上述缺陷阻断；修复前不能宣称该工具兼容或 U2 在正文路径完整通过。
- 未使用真实 LLM，未做 12 问人工判分、真实 qrel 或引用正确率；没有第二台设备和真实网络性能证据。U7 的项目 `.mcp.json` 批准流程未测。
- 不主张 Claude 的 25k-token 阈值已判定；不声称 pi codemode 将全文送给模型。未运行全量测试。

## 修复前辅助脚本验证（历史）

- 仓库根：`./node_modules/.bin/eslint agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts`，退出 0；`gateway` 已按要求使用 `const`。
- `server/`：`./node_modules/.bin/tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --allowImportingTsExtensions ../agent-outputs/workflow/20261029-kb-retrieval-mcp/client-smoke.mts`，退出 0。首次未传 `--strict` 时受既有 `src/agent/path-guard.ts:420` 联合类型收窄错误影响退出 2；补上 `--strict` 后通过，未修改生产文件。
- 最后一次脚本修改后分别复跑 `CASE_FILTER=pi-stdio-code-8000` 和 `CASE_FILTER=claude-stdio-15000`，两次退出 0；新增的捕获完整性检查未报错。脚本退出 0 只代表测试链已捕获，并非宣告三工具兼容。
- `ps` 定向检查 `kb-client-fixture-` 测试网关，剩余 0；未触碰其他任务进程。对报告引用的 3 个续测目录内 `.log/.json/.jsonl` 做 `fskb_` 格式扫描，匹配数均为 0。

## 清理和回滚

驱动脚本自身 gateway 发 SIGTERM 后 `exit=0`，真实客户端均已返回；原先观察到另一任务 `/tmp/feishu-kb-live.MH6HuA/` 网关，未触碰。测试临时目录与临时 npm 缓存保留以便复核；仅含合成数据和临时客户端配置（令牌变量引用，不存实际随机值）。仓库内产物只有本报告和 `client-smoke.mts`；回滚只需移除这两份新增文件，临时目录可由负责人按已授权清理流程移除。未提交 Git。
