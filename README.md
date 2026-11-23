# Feishu Sync

[![Release](https://img.shields.io/github/v/release/runrunrain/feishu-sync?style=flat-square&logo=github)](https://github.com/runrunrain/feishu-sync/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/runrunrain/feishu-sync/ci.yml?style=flat-square&label=ci)](https://github.com/runrunrain/feishu-sync/actions/workflows/ci.yml)
[![Release CI](https://img.shields.io/github/actions/workflow/status/runrunrain/feishu-sync/release.yml?style=flat-square&label=release%20ci)](https://github.com/runrunrain/feishu-sync/actions/workflows/release.yml)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square)](https://github.com/runrunrain/feishu-sync/releases/latest)
[![Electron](https://img.shields.io/badge/Electron-31-9feaf9?style=flat-square&logo=electron&logoColor=47848f)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%20LTS-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

面向本地知识库沉淀与 AI 协作的跨平台桌面应用。自动检测飞书知识库子树变更并选择性同步为本地 Markdown 与 Excel 原件，内置自定义归档、Agent 标准知识库工作台、只读 MCP 服务（本机 HTTP / WSL 桥接 / 局域网）、内网静态网页分享与 `feishu-sync` 命令行工具。

[核心功能](#核心功能) · [下载与安装](#下载与安装) · [快速开始](#快速开始) · [配置与运维](#配置与运维) · [架构与技术栈](#架构与技术栈) · [本地开发与打包](#本地开发与打包) · [安全与边界](#安全与边界) · [文档导航](#文档导航) · [参与贡献](#参与贡献)

> 版本发布与完整变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 核心功能

### 飞书知识库同步与归档

- **定时检测与托盘提醒**：按设定间隔轮询飞书知识库子树，比对文档编辑时间并在托盘提示变更数量。
- **分型同步与安全写盘**：按 `docx`、`sheet`、`slides` 分型读取；正文图片、附件与可下载白板资源落盘并重写为本地引用。同步默认 dry-run，实际落盘经库外 staging 校验后原子替换；移动、删除、路径冲突、父链缺失与无权限条目保留为 blocker，不自动覆盖。
- **表格重构与多协议整理**：识别 A/B/C/D/E 五类块重构表格布局；可选接入多协议 LLM（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages）对齐文档风格，调用失败时回退确定性结果。
- **自定义归档**：把知识库目录树之外的零散云文档归档至 `_custom/<文件夹>/`，支持云端变更检测；手工放入的带同步头文档在全量重建时自动纳管。
- **双视图与统一预览**：目录树支持飞书结构视图与本地目录视图；文档预览还原折叠块、提示卡、嵌套表格与同步引用，表格优先以 Excel 画板呈现并支持连续缩放与图片查看。

### Agent 标准知识库工作台

详细配置与操作见 [docs/agent-knowledge.md](./docs/agent-knowledge.md)。

- **Pi 多角色编排构建**：把已同步的本地原始库整理为带来源追溯的独立标准知识库，支持全量构建、按变更增量更新、选择性重建、断点续跑、发布就绪门禁与只读构建度量。
- **Discuss 与 Work 会话**：Discuss 提供只读知识问答；Work 在授权 Workspace 内协作并支持原生 Pi 插件、按会话切换模型/思考强度与本机插件资源，以及从任意已完成轮次分叉新会话。
- **图片理解与任务编排**：可选配置图片理解模型与内容寻址缓存，失败不阻断构建；支持多角色子任务编排（`kb-analyst` / `kb-converter` / `kb-reviewer`）与 Pi 原生插件包管理。

### 共享、导出与外部接入

- **只读 MCP（20 工具）**：覆盖已发布标准库与已同步原始库（含工作簿单元格、图片与引用索引）。本机固定监听 `http://127.0.0.1:47392/mcp`，支持退出托盘后独立常驻与 Windows/WSL Codex 一键桥接；可按需开启可信局域网共享（默认关闭，端口 `47391`），见 [docs/kb-lan-mcp.md](./docs/kb-lan-mcp.md)。
- **文档导出与内网网页分享**：勾选已发布标准库文档导出单篇 `.md` 或带图 Markdown ZIP；可一键生成固定版本的内网静态网页分享（独立端口 `47393`，自动排除虚拟网卡），支持页内链接、章节跳转与返回基准文档，见 [docs/kb-document-sharing.md](./docs/kb-document-sharing.md)。
- **命令行工具（CLI）**：默认开启 `feishu-sync` CLI 并生成命令入口，提供 40 条运维与查询命令、单命令帮助、位置参数、拼写建议、shell 补全及表格输出，内置 Skill 可一键安装至 `.agents`、Claude Code 或 Codex，见 [docs/cli-reference.md](./docs/cli-reference.md)。

### 受控写回与反向发布（默认关闭）

- **源文档本地编辑与写回飞书**：开启 `feishuWrite` 并完成增量写权限授权后，可在本地受控编辑带规范头的 `docx` 源，经三段式校验写回飞书并立即回拉收敛；未写回的本地编辑会阻断同步覆盖。
- **标准库反向发布与云端操作**：开启 `feishuPublish` 后可将标准库反向发布至飞书知识库（见 [docs/feishu-publish.md](./docs/feishu-publish.md)），并支持云端历史回滚、重命名与安全移出（见 [docs/source-cloud-operations.md](./docs/source-cloud-operations.md)）。

### 表格原件与只读文档

电子表格同步后以同目录 `<文档名>.xlsx` 作为画板源文件，`<文档名>.md` 与 `.csv-data/` 继续供文本检索与知识库索引使用；Markdown 头部通过 `source_workbook` 关联原件。原始库完整性哈希计入 XLSX，仅调整图片或布局也会触发源变更。

- **获取策略**：优先调用 `lark-cli sheets +workbook-export` 保留飞书导出字节；只有阅读权限导致导出受限时，自动通过 `+workbook-info`、`+sheet-info`、自适应分块 `+cells-get` 与 `+float-image-list` 在本地重建 XLSX，无需修改云文档。
- **还原内容**：保留文字坐标、公式与缓存值、样式、行高列宽（含自动行高）、隐藏行列、合并区域，以及浮动图与单元格内图片的锚点、偏移、尺寸和层级；混排链接目标记入批注与元数据，取得方式、版本和核对结果记入 `.xlsx.metadata.json`。
- **失败兜底**：每个分块均校验截断标记、真实行列坐标、图片数量与读取前后版本号。原件与重建均未完成时，仅在 CSV 通过完整性与版本校验后存作后备并标为「Excel 待修复」，保留变更项且不覆盖已有 Excel；手工放入的 Excel 亦不自动覆盖。
- **能力边界**：只读重建上限为 200 万网格位置、单表 50,000 行 / 1,024 列，XLSX 读取上限 64 MiB。无法读取图片、存在不支持映射的附件/富文本/透视表/裁剪样式时仍标为待修复；画板预览不执行宏、外链或公式重算，图表、形状与条件格式计算结果请直接打开 Excel 原件查看。

可在独立目录做只读核验（不触碰正式知识库或状态库）：

```bash
node node_modules/tsx/dist/cli.mjs server/scripts/verify-sheet-workbook.ts --token <spreadsheet-token> --output <输出文件.xlsx>
node node_modules/tsx/dist/cli.mjs server/scripts/preview-sheet-workbook.ts <已生成的文件.xlsx>
```

---

## 下载与安装

### 桌面安装包

从 [GitHub Releases](https://github.com/runrunrain/feishu-sync/releases/latest) 下载对应平台安装包：

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `FeishuSync-<version>-arm64.dmg` | 主力分发目标 |
| macOS（Intel） | `FeishuSync-<version>.dmg` | x64 构建 |
| Windows x64 | `FeishuSync-Setup-<version>-x64.exe` | NSIS 安装器 |

> **macOS 首次启动提示“无法验证开发者”**：CI 产物使用 ad-hoc 签名，首次打开前在终端解除隔离属性（或在「系统设置 → 隐私与安全性」点击「仍要打开」）：
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Feishu Sync.app"
> ```
>
> 如需正式签名分发，按[桌面打包](#桌面打包)中的 `:release` 流程使用 Developer ID 与 Apple 公证构建。

### 运行前提

| 依赖 | 要求 | 用途 |
| --- | --- | --- |
| `lark-cli` | `1.0.89+`（`npm install -g lark-cli`） | 飞书认证、变更检测、文档与媒体读取及写回（应用不存飞书 token） |
| Node.js | `>= 22.19`（支持 22.x / 24.x LTS） | 使用 Agent 标准知识库工作台时必需；仅做飞书同步可不装 |
| `@earendil-works/pi-coding-agent` | `>= 1.4, < 2`（`npm install -g '@earendil-works/pi-coding-agent@^1.4.0'`） | Agent 会话与标准库构建运行时；未安装不影响飞书同步 |

---

## 快速开始

### 1. 完成飞书认证

应用完全依赖 `lark-cli` 的 user 认证态，启动时自动联网核验。可通过桌面端「设置 → 飞书认证」完成设备授权，或在终端执行：

```bash
# 按最小只读同步边界登录（9 个必需 scope）
lark-cli auth login --scope="wiki:node:retrieve wiki:space:retrieve docs:document.content:read sheets:spreadsheet:read docx:document:readonly drive:drive.metadata:readonly docs:document.media:download slides:presentation:read offline_access"

# 联网核验就绪状态（须显示 user 可用且 verified=true）
lark-cli auth status --verify --json
```

认证就绪须同时满足：当前 user 可用、通过飞书服务端联网验证、可识别账号身份，且覆盖上述 9 个 scope。认证过期时在设置页点击「重新认证」（同账号保留已有权限）；账号停用或撤权后点击「切换飞书账号」（换号仅申请同步必需权限，并校验新旧账号差异）。新账号须已获准使用当前飞书应用并具备目标知识库权限。

### 2. 首次启动配置

1. **确认本地知识库目录**：未配置时首次启动自动初始化默认目录——Windows 依次尝试 `D:\飞书知识库`、`C:\飞书知识库`、用户文档下的 `飞书知识库`；macOS/Linux 使用 `~/Documents/飞书知识库`；设置了 `FEISHU_SYNC_HOME` 时落在 `<FEISHU_SYNC_HOME>/飞书知识库`。
2. **添加监听根**：在设置页填入要同步的飞书知识库节点 URL（或导入已有 `config.json`）。
3. **按需配置模型**：初始不预置任何模型提供商或密钥。在「设置 → 服务提供商与模型」添加提供商（支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages），或为 Agent 选用本机 Pi 凭据。
4. **建立索引并同步**：首次扫描本地已有 `.md` 建立映射基线，检测变更后勾选目标文档同步。
5. **按需启用工作台**：确认 Pi 运行时就绪后，在「标准库」发起全量构建，发布后可阅读、导出、分享或接入外部 MCP 客户端。

### 3. 日常使用与托盘控制

应用最小化后常驻系统托盘，默认每 30 分钟按 `pollIntervalMinutes` 轮询全部已启用监听根（开机启动、手动点击与定时轮询共用单次在途检测，避免重复触发）。

| 入口 | 操作 | 说明 |
| --- | --- | --- |
| 全局快捷键 | `CmdOrCtrl+Shift+F` | 唤起主窗口 |
| 托盘菜单 | 显示窗口 / 隐藏窗口 | 切换主窗口显隐 |
| 托盘菜单 | 立即检测变更 | 立即触发一次变更检测并展示主窗口 |
| 托盘菜单 | 退出 Feishu Sync | 退出桌面应用（开启「允许本机 MCP 独立运行」时本机 MCP 继续监听） |

---

## 配置与运维

### 本地服务与端口一览

| 服务 | 默认地址 / 端口 | 默认状态 | 说明 |
| --- | --- | --- | --- |
| 本机 HTTP MCP | `http://127.0.0.1:47392/mcp` | 开启 | 20 个只读工具；`allowStandaloneKbMcp` 为 `true` 时退出托盘后继续监听；WSL 桥接复用此端口 |
| 局域网只读 MCP | `<内网IP>:47391/mcp` | 关闭 | `kbLanMcp.enabled` 控制，Bearer 令牌鉴权，仅限可信内网 |
| 标准库网页分享 | `<内网IP>:47393` | 按需 | 创建分享后监听，自动排除 Hyper-V / WSL / Docker / VPN 等虚拟网卡 |
| 独立开发后端 | `http://127.0.0.1:3001` | 仅开发 | `npm run server:dev` / `dev:all`；桌面态使用系统随机端口 |
| 前端开发服务 | `http://localhost:5173` | 仅开发 | Vite HMR |

### 配置文件（`config.json`）

数据目录默认位于 `~/.feishu-sync/`（含 `config.json` 与 `feishu-sync.db`），可通过环境变量 `FEISHU_SYNC_HOME` 整体指定。`watchedRoots` 是监听根真相源；`larkCliPath` 已移除，非标准路径统一通过环境变量 `LARK_CLI_PATH` 指定。

最小示例（含多协议模型提供商）：

```json
{
  "knowledgeBaseRoot": "D:/飞书知识库",
  "watchedRoots": [
    {
      "id": "root-1",
      "url": "https://example.feishu.cn/wiki/<node-token>",
      "localDir": "",
      "layoutProfile": "default",
      "enabled": true
    }
  ],
  "llm": {
    "primaryChannel": "direct",
    "temperature": 0.2,
    "timeoutMs": 600000,
    "contentAdaptationEnabled": false,
    "providers": [
      {
        "id": "provider-1",
        "name": "My Provider",
        "protocol": "openai-completions",
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "YOUR_API_KEY",
        "enabled": true,
        "models": [
          {
            "id": "model-1",
            "name": "Default Model",
            "model": "your-model-id"
          }
        ]
      }
    ],
    "activeProviderId": "provider-1",
    "activeModelId": "model-1"
  },
  "pollIntervalMinutes": 30,
  "allowStandaloneKbMcp": true,
  "cli": { "enabled": true },
  "kbLanMcp": { "enabled": false, "bindAddress": "auto", "port": 47391, "maxSessions": 16 },
  "feishuWrite": { "enabled": false },
  "feishuPublish": { "enabled": false },
  "sync": {
    "slidesScreenshot": { "enabled": false },
    "whiteboardExport": { "enabled": true }
  },
  "enableAutoStart": true,
  "enableNotifications": true
}
```

核心字段说明（完整数据契约与 Agent / 标准库字段见 [docs/data-contract.md](./docs/data-contract.md)）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `knowledgeBaseRoot` | 自动初始化 | 本地原始知识库根目录 |
| `watchedRoots` | `[]` | 监听的飞书知识库根列表（`id` / `url` / `localDir` / `layoutProfile` / `enabled`） |
| `llm.providers` | `[]` | 模型提供商列表；单提供商配置 `protocol`（`openai-completions` / `openai-responses` / `anthropic-messages`）、`baseUrl`、`apiKey` 与模型预设；Pi 编排角色当前要求 `openai-completions` |
| `llm.contentAdaptationEnabled` | `false` | 同步时是否启用 LLM 风格对齐；关闭或失败时保持确定性重构结果 |
| `llm.timeoutMs` | `600000` | 单次 LLM 请求超时（毫秒） |
| `pollIntervalMinutes` | `30` | 定时变更检测间隔（分钟） |
| `allowStandaloneKbMcp` | `true` | 从托盘退出后是否保留本机 HTTP MCP 独立监听 |
| `cli.enabled` | `true` | 开启 `feishu-sync` 命令行访问与本地 shim 安装 |
| `kbLanMcp.enabled` | `false` | 开启可信局域网只读 MCP 共享（默认端口 `47391`，最大会话 16） |
| `standardKb.buildConcurrency` | `2` | 标准库构建并行度（1–6，兼容读取旧字段 `buildParallelism`） |
| `feishuWrite.enabled` | `false` | 开启源文档写回飞书（需额外授权 `docx:document:write_only`） |
| `feishuPublish.enabled` | `false` | 开启标准库反向发布到飞书知识库 |
| `sync.whiteboardExport.enabled` | `true` | 白板旁路导出开关；失败只告警，正文仍保留 PNG 预览引用 |
| `sync.slidesScreenshot.enabled` | `false` | 幻灯片截图采集开关 |
| `enableAutoStart` / `enableNotifications` | `true` / `true` | 开机自启与托盘通知开关 |

### 正式知识库回填脚本

不经 GUI 批量回填原始知识库时，使用 `server/scripts/sync-latest.ts`：

```bash
cd server
npx tsx scripts/sync-latest.ts --skip-index          # dry-run：不写 KB 正文，仍写清单/报告与状态库
npx tsx scripts/sync-latest.ts --skip-index --apply  # 提交 KB 正文，仅执行 create / replace
```

- 已有配置默认只读，需持久化改写时传入 `--persist-config`；根目录按 `--kb <绝对路径>` → `FORMAL_KB` → `config.json` 的 `knowledgeBaseRoot` 解析。
- 未加 `--apply` 仍会初始化或迁移 SQLite 并推进 `observed` 状态，操作真实数据目录前务必先备份；恢复时须同时还原知识库目录、SQLite 与配置。
- `move`、`delete`、路径冲突、父链缺失、未知对象类型与无权限条目保留为带 `reasonCode` 的 blocker，不自动覆盖；缺少可信飞书标识的历史本地文件不自动认领。

---

## 架构与技术栈

### 总体架构

桌面端采用分层结构：Electron 主进程托管托盘、更新与图片裁剪桥，经 `utilityProcess.fork` 运行内嵌 Hono 业务后端，业务层操作 SQLite 状态库与本地文件系统，React 渲染进程通过 preload 注入的桌面令牌访问唯一出口 `src/api/client.ts`。Agent 会话与标准库构建经 JSONL RPC 调度外部 Pi 侧车，权限裁决与路径围栏留在服务端。详细架构与模块地图见 [docs/architecture.md](./docs/architecture.md)。

### 技术栈

| 层级 | 技术选型 |
| --- | --- |
| 桌面壳 | Electron 31 + electron-builder 26 + electron-updater 6 |
| 前端 | React 18 + Vite 6 + Tailwind CSS 4 |
| 后端 | Hono 4 + `@hono/node-server`（Electron `utilityProcess` 托管或独立 Node 运行） |
| 存储 | `better-sqlite3` 12（SQLite，22 张表，启动自动 additive 原地迁移） |
| 模型接入 | OpenAI SDK + Anthropic SDK（支持三协议与流式/思考强度） |
| 飞书接入 | `lark-cli` 子进程封装（QPS 节流、错误分类、99991400 指数退避，零内置 token） |
| Agent 与共享 | 外部 Node ≥ 22.19 + Pi RPC 侧车；esbuild 单文件 CJS（只读 MCP / 局域网网关 / WSL 桥接 / CLI） |
| 工程工具链 | TypeScript 5 + esbuild 0.28 + Vitest + ESLint 9 + Prettier |

### 项目结构

```text
feishu-sync/
├── src/                 # React 前端源码与前端测试
├── electron/            # Electron 主进程、preload、utilityProcess 托管、托盘与自动更新
├── server/
│   ├── src/
│   │   ├── modules/     # 同步核心（检测、同步引擎、表格重构、映射存储、配置、LLM 通道）
│   │   ├── routes/      # 23 个 Hono 路由文件与鉴权中间件
│   │   ├── agent/       # Pi 运行时、进程池、工具裁决、路径围栏、任务编排、图片理解、批准流
│   │   ├── kb/          # 标准库构建编排（pi-amagi）、发布门、检索、导出与内网网页分享
│   │   ├── mcp/         # 本机/stdio/WSL 桥接 MCP 与只读工具注册
│   │   ├── kb-lan/      # 局域网只读 MCP 网关与审计
│   │   ├── sources/     # 原始库受控编辑、写回飞书与云端操作
│   │   ├── ops/         # 40 条统一命令表（CLI 与 app_command 共用）
│   │   └── cli/         # feishu-sync CLI 客户端与内置 Skill
│   ├── scripts/         # 资产打包、回填与运维脚本
│   ├── bundled/         # 冻结的内置 amagi-pi 包与清单
│   └── tests/           # 服务端 Vitest 测试套件
├── scripts/             # 桌面打包、ABI 校验与 pretest 自动修复脚本
├── build/               # 安装包图标、NSIS 与 macOS entitlements
└── docs/                # 架构、开发、测试、数据契约、安全与专题文档
```

---

## 本地开发与打包

### 环境与安装

需要 Node.js `22.19+`（22.x）或 `24.x` LTS（`.nvmrc` 对齐 CI 的 22.x）。根目录与 `server/` 需分别安装依赖：

```bash
npm install
cd server && npm install && cd ..
```

### 运行开发态

- **浏览器联调（前端 Vite `:5173` + 独立后端 `:3001`）**：

```bash
export FEISHU_SYNC_DEV_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
npm run dev:all
```

也可分终端运行 `npm run dev` 与 `npm run server:dev`（两终端须设置相同的 `FEISHU_SYNC_DEV_TOKEN`）。

- **桌面开发态（免打包，Electron 内嵌后端 + Vite HMR）**：

```bash
# Windows
start-dev.bat

# macOS / Git Bash
./start-dev.sh

# 或直接运行 npm 脚本
npm run dev:desktop
```

前端修改即时热更新；改动 `server/` 或 `electron/` 后执行 `npm run server:build && npm run electron:build` 再重启。

### 质量门禁与测试

```bash
npm run check        # lint + typecheck + 前端与服务端全部测试（CI 同口径）
npm run lint         # ESLint 检查
npm run typecheck    # 根 src + 根配置 + server 三段类型检查
npm run test:all     # 前端 + 服务端 Vitest 测试
```

> 跑完 Electron 桌面构建后，`better-sqlite3` 会切换为 Electron ABI；执行 `npm test` 时 `pretest` 会通过 `scripts/ensure-node-sqlite.cjs` 自动检测并恢复为当前 Node ABI，无需手工干预。

### 桌面打包

```bash
npm run build:all             # 构建前端、服务端与 Agent/MCP/CLI/分享静态资产
npm run electron:build        # 编译 Electron 主进程与 preload
npm run desktop:dist:win:x64  # 输出 dist-desktop/win32-x64/FeishuSync-Setup-<version>-x64.exe
npm run desktop:dist:mac:arm64
npm run desktop:dist:mac:x64
```

macOS 普通命令生成本地测试用的 ad-hoc 签名包；对外分发使用 `:release` 后缀（`desktop:dist:mac:arm64:release` / `desktop:dist:mac:x64:release`），打包脚本会强制校验 Developer ID 签名、Gatekeeper 与 Apple 公证票据。推荐使用 App Store Connect API Key 配置公证凭据：

```bash
export APPLE_API_KEY="/absolute/path/to/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

证书可装入当前钥匙串，或通过 `CSC_LINK` / `CSC_KEY_PASSWORD` 传入。macOS 本机一键构建可执行 `./build.command`。

---

## 安全与边界

- **零飞书凭据**：仓库与运行时不保存飞书 token、`app_id` 或 `app_secret`，全部经 `lark-cli` 用户认证态访问。
- **四令牌域隔离**：Desktop、CLI、Agent 内部工具与 LAN MCP 四个令牌域互不接受对方令牌；模型发起的非只读 `app_command` 须逐次经会话批准，模型传入的确认字段一律剔除。详见 [docs/security-model.md](./docs/security-model.md)。
- **明文模型密钥提示**：模型提供商 `apiKey` 按现行架构明文保存于本地 `config.json`（含 `_warning` 字段提醒），请妥善保护数据目录，切勿提交到版本库。
- **内网明文传输边界**：局域网 MCP（`47391`）与内网网页分享（`47393`）均为明文 HTTP，仅限可信内网使用，不要配置公网端口转发。
- **已知限制**：
  - macOS 安装包须在 macOS 环境下构建，Windows 无法直接产出 DMG。
  - 自动更新当前指向 GitHub Releases 通用源，私有分发需配置 `DESKTOP_UPDATE_FEED_URL`。
  - 电子表格原件导出遇飞书权限 `1069902` 时需后台放行对应接口或回退只读重建。
  - `server/scripts/e2e-integration-test.ts` 测试端口暂为硬编码 `4123`。

---

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](./docs/README.md) | 开发与运维文档总索引 |
| [docs/architecture.md](./docs/architecture.md) | 进程模型、模块地图、四令牌域与关键不变量 |
| [docs/development.md](./docs/development.md) | 开发环境、双包结构、同步缓存与诊断、ABI 说明 |
| [docs/testing.md](./docs/testing.md) | 测试分层、运行命令与 CI 拆分 |
| [docs/data-contract.md](./docs/data-contract.md) | 22 张 SQLite 表、配置段默认值与 Markdown Header 契约 |
| [docs/security-model.md](./docs/security-model.md) | 令牌隔离、审批流、PathGuard 围栏与审计日志 |
| [docs/operations.md](./docs/operations.md) | 打包发布约束、正式回填运维与脚本风险分级 |
| [docs/agent-knowledge.md](./docs/agent-knowledge.md) | Agent 标准知识库工作台配置与使用说明 |
| [docs/build-orchestration.md](./docs/build-orchestration.md) | Pi 多角色构建编排、epoch 与发布就绪门 |
| [docs/build-operations.md](./docs/build-operations.md) | 构建运行态、度量报告与内置 `amagi-pi` 运维 |
| [docs/kb-lan-mcp.md](./docs/kb-lan-mcp.md) | 本机 HTTP MCP、WSL 桥接与局域网只读共享 |
| [docs/kb-document-sharing.md](./docs/kb-document-sharing.md) | 标准库 Markdown 导出与内网静态网页分享 |
| [docs/kb-retrieval.md](./docs/kb-retrieval.md) | 标准库与原始库检索机制、MCP 工具与限流 |
| [docs/cli-reference.md](./docs/cli-reference.md) | `feishu-sync` CLI 40 条命令、风险级与退出码 |
| [docs/feishu-publish.md](./docs/feishu-publish.md) | 标准库反向发布到飞书知识库 |
| [docs/source-cloud-operations.md](./docs/source-cloud-operations.md) | 源文档云端历史、回滚、重命名与移出 |
| [docs/claude-runtime.md](./docs/claude-runtime.md) | Claude Code 历史会话兼容运行时说明 |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | 常见问题与排查入口 |
| [AGENTS.md](./AGENTS.md) / [CLAUDE.md](./CLAUDE.md) | 面向编码代理与 Claude Code 的仓库工程契约 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本化变更记录 |

---

## 参与贡献

欢迎提交 Issue 与 Pull Request。提交前请在根目录跑通与 [CI](.github/workflows/ci.yml) 一致的质量门禁：

```bash
npm run check
```

协作规范与提交流程详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

**发布流程**：改动合入 `main` 后，按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 在 `CHANGELOG.md` 顶部归档条目，运行 `npm version <patch|minor> --no-git-tag-version` 并推送 `v*` 标签，[Release workflow](.github/workflows/release.yml) 自动构建三平台产物并同步提取 Release 说明。

---

## 许可证

[MIT](./LICENSE) © runrunrain
