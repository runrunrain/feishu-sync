# 飞书知识库本地同步管理工具（feishu-sync）

**跨平台桌面应用**：自动检测飞书知识库子树变更并选择性同步到本地，保持本地重构后的 Markdown 内容结构（表格布局、层级格式），支持 LLM 驱动的内容适配。

**状态**：v0.3.3，正式同步 + 自定义归档交付版。正式回填默认只生成计划；只有显式 apply 才会写入知识库，路径冲突、移动、删除和未知类型均不会自动执行。

---

## 功能特性

- **变更检测**：定时轮询飞书知识库子树，托盘通知变更数量（支持工作时间高频检测）
- **同步引擎**：单篇/批量同步，docx、sheet、slides 分型读取；正文图片、附件和可下载白板资源会落盘并改写为本地引用
- **表格重构**：A/B/C/D/E 五类块自动识别与重构（metadata/hierarchy/datatable/paragraph/sparse）
- **LLM 适配**：direct 单通道（OpenAI SDK，默认智谱 bigmodel GLM，`glm-4-flash` 免费档起步），风格对齐失败时回退确定性结果
- **自定义归档**：结构树之外的零散云文档快捷归档到 `_custom/<文件夹>/`，支持云端变更检测；手工放入的文件在全量重建时自动纳管并回填归属
- **双视图与预览**：节点树支持飞书结构视图 / 本地目录视图，内置 Markdown 文档预览面板
- **系统托盘**：常驻托盘，快捷键（CmdOrCtrl+Shift+F）显示窗口，支持开机自启
- **自动更新**：electron-updater 集成，支持检查/下载/安装更新流程

---

## 技术栈

- **桌面**：Electron 31 + electron-builder 24 + electron-updater 6
- **前端**：React 18 + Vite 6 + Tailwind CSS 4
- **后端**：Hono 4 + @hono/node-server（内嵌同进程）
- **数据**：better-sqlite3 9（SQLite，documents/sync_log/run_log 主表 + localDirs/custom_folders 等辅助表，启动时 additive 迁移原地升级）
- **LLM**：OpenAI SDK → 智谱 bigmodel GLM（OpenAI 兼容端点，默认 `glm-4-flash`）
- **飞书**：lark-cli（实测 1.0.89；认证、变更检测、内容读取、媒体下载统一入口；工具不保存飞书 token）
- **开发**：TypeScript 5 + esbuild 0.28

---

## 架构概览

**分层架构**：桌面层（Electron）→ 服务层（Hono）→ 业务层（ChangeDetector/SyncEngine/LayoutReconstructor/ContentAdapter/LocalMapStore/LarkCliClient/ConfigManager）→ 数据层（SQLite）→ 展示层（React）

**核心模块**：

- **LarkCliClient**：lark-cli 子进程封装，QPS 节流，错误分类（99991400 指数退避）
- **ChangeDetector**：wiki 子树变更检测（obj_edit_time 对比本地 SQLite）
- **SyncEngine**：内容分型读取 → 媒体引用解析/下载 → 本地引用重写 → staged 原子提交 → SQLite 基线推进
- **LayoutReconstructor**：A/B/C/D/E 五类块识别的表格重构引擎
- **ContentAdapter**：direct 通道（bigmodel GLM）few-shot 风格对齐（temperature 0.2）
- **LocalMapStore**：SQLite 映射与状态库（首次索引扫描 < 10s；watchedRoot/自定义归档双身份回填）
- **TrayService**：系统托盘常驻与变更通知
- **UpdaterService**：electron-updater 集成（autoDownload=false，autoInstallOnAppQuit=false）

---

## 快速使用说明

### 环境要求

- Node.js 18+（实测 v24.16.0）
- lark-cli 1.0.89+（全局安装：`npm install -g lark-cli`）
- Windows 11 / macOS（打包目标含 macOS x64/arm64，跨平台打包需目标平台环境）

### 安装依赖

```bash
# 根目录安装前端依赖
npm install

# 安装 server 子包依赖
cd server
npm install
cd ..
```

### 飞书认证

工具依赖 lark-cli user 认证态，启动自动检测就绪状态：

```bash
# 认证登录（最小只读同步边界；scope 空格或逗号分隔）
lark-cli auth login --scope="wiki:node:retrieve wiki:space:retrieve docs:document.content:read sheets:spreadsheet:read docx:document:readonly drive:drive.metadata:readonly docs:document.media:download slides:presentation:read offline_access"

# 确认认证状态（需显示 user ready + token valid）
lark-cli auth status
```

**认证就绪条件**：user ready + 覆盖上表 9 个 scope（与 `ConfigManager` 默认 `requiredScopes` 一致）

### 配置 LLM 与本地知识库

编辑 `config.json`（首次运行自动生成，`watchedRoots` 为监听根配置真相源）：

```json
{
  "llm": {
    "primaryChannel": "direct",
    "openAiCompatBaseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "YOUR_BIGMODEL_API_KEY",
    "directModel": "glm-4-flash",
    "temperature": 0.2,
    "timeoutMs": 600000
  },
  "pollIntervalMinutes": 30,
  "knowledgeBaseRoot": "D:/WorkPace/Database/03-项目交付",
  "watchedRoots": [
    {
      "id": "root-1",
      "url": "https://feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb",
      "localDir": "",
      "layoutProfile": "default",
      "enabled": true
    }
  ],
  "larkCliPath": "lark-cli",
  "requiredScopes": [
    "wiki:node:retrieve",
    "wiki:space:retrieve",
    "docs:document.content:read",
    "sheets:spreadsheet:read",
    "docx:document:readonly",
    "drive:drive.metadata:readonly",
    "docs:document.media:download",
    "slides:presentation:read",
    "offline_access"
  ],
  "enableAutoStart": true,
  "enableNotifications": true
}
```

### 正式知识库回填

正式回填脚本位于 server/scripts/sync-latest.ts。它会以当前用户配置为权威：已有配置只读加载，除非显式传入 --persist-config；默认不会改写密钥、模型或其他用户字段。

    cd server
    npx tsx scripts/sync-latest.ts --skip-index
    npx tsx scripts/sync-latest.ts --skip-index --apply

第一条命令只生成 operation manifest 和汇总报告。第二条命令仅执行 create / replace；move、delete、路径冲突、父链不完整、未知对象类型与无权限对象会保留为带 reasonCode 的 blocker，绝不自动覆盖本地文件。

提交前会先把正文、图片、附件、白板缩略图和 sheet CSV 写入 staging。任一资源缺失、媒体下载失败或提交异常时，不推进 SQLite 的 synced 基线。正式运维还应保留 operation manifest 与备份；恢复时同时还原知识库、SQLite 和配置。

当前已知限制：没有可信飞书标识的历史本地文件不会被自动认领；需要先核对内容和路径，再通过独立迁移回填映射。当前无法导出的未知对象类型同样保留为 blocker，而不是写入占位成功记录。

### 开发模式

```bash
# 并行启动前端（vite）+ server（tsx watch）
npm run dev:all

# 或分别启动
npm run dev          # 仅前端
npm run server:dev   # 仅 server

# 生产 server 启动（编译后）
npm run server:start
```

**访问地址**：前端 `http://localhost:5173`，server `http://127.0.0.1:3001`（Desktop Token 鉴权）

### 开发态快速启动（非打包）

```bash
# Windows：双击 start-dev.bat 或命令行执行
start-dev.bat

# Git Bash / macOS / Linux：
./start-dev.sh

# 或直接使用 npm 命令
npm run dev:desktop

# 链路说明：
# 1. 预编译 server/dist + dist-electron/main.cjs
# 2. concurrently 并行启动 vite（5173）+ electron（内嵌 server）
# 3. Electron 主进程内跑 server（better-sqlite3 ABI 115 一致，无冲突）
# 4. 开发态 loadURL localhost:5173，自动打开 DevTools
```

**优势**：无需 electron-builder 打包（~99MB），快速验证前端 + 内嵌 server 链路。

**热更新**：
- 前端改：vite HMR 即时生效
- server/main 改：重新 `npm run server:build && npm run electron:build` 后重启 dev:desktop

### 构建与打包

```bash
# 构建（前端 + server）
npm run build:all

# Electron 编译
npm run electron:build

# Windows 打包（NSIS）
npm run desktop:dist:win:x64

# macOS 打包（需 macOS 环境）
npm run desktop:dist:mac:x64    # Intel
npm run desktop:dist:mac:arm64  # Apple Silicon

# 可分发正式包（Developer ID 签名 + Apple 公证）
npm run desktop:dist:mac:x64:release
npm run desktop:dist:mac:arm64:release
```

普通 macOS 命令生成完整的 ad-hoc 签名包，适合在构建机本地测试。对外分发必须使用
`:release` 命令，并提前配置 Developer ID Application 证书和 Apple 公证凭据。
正式构建会强制检查签名、Gatekeeper 评估和 DMG 公证票据，任一步失败都会让构建失败，
避免发布 macOS 会拦截的产物。

推荐使用 App Store Connect API Key 配置公证：

```bash
export APPLE_API_KEY="/absolute/path/to/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

签名证书可安装到当前钥匙串，或通过 electron-builder 支持的
`CSC_LINK` / `CSC_KEY_PASSWORD` 提供。

**打包产物**：`dist/FeishuSync-Setup-<version>-x64.exe`（Windows NSIS，当前 0.3.3，~99MB）

### 首次使用流程

1. **启动应用**：安装 `FeishuSync-Setup-<version>-x64.exe` 后启动
2. **配置面板**：设置知识库根路径 + 飞书根 URL + LLM API Key（默认 bigmodel GLM）
3. **认证确认**：检查认证状态是否就绪（lark-cli auth status）
4. **首次索引**：工具自动扫描本地已有 `.md` 文件（< 10s，35 节点）
5. **变更检测**：定时轮询（默认 30min），托盘通知变更数量
6. **选择同步**：GUI 选择文档 → 点击同步 → 本地 Markdown 更新

### 日常使用

- **托盘常驻**：最小化到托盘，右键菜单（显示/隐藏/立即检测/退出）
- **定时检测**：默认 30min，工作时间（9-18 点）15min，夜间（23-8 点）2h
- **快捷键**：`CmdOrCtrl+Shift+F` 显示主窗口
- **开机自启**：配置 `enableAutoStart: true` 自动启动

### 托盘与快捷键

| 快捷键 | 功能 |
|-------|------|
| `CmdOrCtrl+Shift+F` | 显示主窗口 |

| 托盘菜单项 | 功能 |
|-----------|------|
| 显示窗口 | 恢复主窗口 |
| 隐藏窗口 | 最小化到托盘 |
| 立即检测变更 | 手动触发变更检测 |
| 退出应用 | 关闭工具 |

---

## 配置说明（config.json 字段表）

| 字段 | 类型 | 示例值 | 说明 |
|------|------|--------|------|
| `llm.openAiCompatBaseUrl` | string | `"https://open.bigmodel.cn/api/paas/v4"` | OpenAI 兼容端点（默认智谱 bigmodel） |
| `llm.apiKey` | string | `"sk-xxxx"` | LLM API Key（当前明文存储，配 `_warning` 字段提醒勿提交；加密 deferred） |
| `llm.directModel` | string | `"glm-4-flash"` | direct 通道模型（bigmodel 免费档默认） |
| `llm.timeoutMs` | number | `600000` | 通道超时（远程模型过载时依赖 SDK 内部重试） |
| `llm.temperature` | number | `0.2` | 温度参数（风格对齐） |
| `pollIntervalMinutes` | number | `30` | 基础轮询间隔（分钟） |
| `knowledgeBaseRoot` | string | `"D:/WorkPace/Database"` | 本地知识库根路径 |
| `watchedRoots` | object[] | `[{ id, url, localDir, layoutProfile, enabled }]` | 监听根配置（真相源） |
| `larkCliPath` | string | `"lark-cli"` | lark-cli 命令路径（Win/Mac 自动适配） |
| `requiredScopes` | string[] | `["wiki:node:retrieve", ...]` | 必需权限范围（共 9 项） |
| `enableAutoStart` | boolean | `true` | 开机自启 |
| `enableNotifications` | boolean | `true` | 托盘通知开关 |

---

## 安全说明

- **零飞书 token**：工具代码禁止任何飞书 token 变量，全委托 lark-cli user 认证态
- **本地鉴权**：Server Token（crypto.randomBytes(32)）+ Origin/Referer 校验，防止外部调用
- **加密存储**：LLM apiKey 当前明文存 config.json（架构决策，含 `_warning` 字段提醒勿提交；加密 deferred）；代码零飞书 token
- **安全红线**：禁止 app_id/app_secret；禁止硬编码 token；前端必须浏览器交互验证

---

## 项目结构

```
feishu-sync/
├── dist/                # 前端构建产物
├── dist-electron/       # Electron 编译产物（main.cjs/preload.cjs）
├── server/
│   ├── dist/            # Server 构建产物（index.js）
│   └── src/             # Server 源码（Hono 路由/业务逻辑）
├── electron/
│   ├── main.ts          # Electron 主进程
│   ├── preload.ts       # Context Bridge 暴露 API
│   └── ...              # 托盘/更新/自启动服务
├── src/                 # React 前端源码
├── scripts/             # 构建脚本（build-desktop-target.cjs）
└── build/               # 打包资源（图标/NSIS 配置）
```

---

## 开发文档导航

以下为外部交付路径（原始 Windows 开发环境），仓库内不含 docs/ 目录：

| 文档 | 路径 | 内容 |
|------|------|------|
| 架构设计文档 | `D:/WorkPace/Database/03-项目交付/03-项目工具/知识库本地同步管理工具/架构设计文档.md` | 总体架构、模块设计、接口签名、数据模型、关键流程 |
| 技术实现文档 | `D:/WorkPace/Database/03-项目交付/03-项目工具/知识库本地同步管理工具/技术实现文档.md` | 技术栈、工程结构、完整代码骨架、构建命令、测试策略 |
| 飞书认证架构专项设计 | `D:/WorkPace/Database/03-项目交付/03-项目工具/知识库本地同步管理工具/飞书认证架构专项设计.md` | LarkCliClient 设计、Config schema 修订、认证就绪检查流程 |

---

## 当前状态与已知限制

**当前状态**：v0.3.3 交付版。核心链路均已落地：定时变更检测 → 分型同步（docx/sheet/slides）→ 表格重构与 LLM 风格对齐 → staged 原子提交；自定义归档（快捷添加 + 手工文件动态纳管）；主区双视图与 Markdown 预览；托盘常驻与自动更新。

**已知限制**：
- macOS 打包需 macOS 环境（Windows 上无法生成 macOS DMG）
- 真实自动更新需配置生产 feed URL（当前为 generic provider）
- GUI 端到端交互需打包后真机验证
- 端到端测试脚本端口硬编码（需改为环境变量读取）
- sheet 导出可能遇飞书权限 1069902（需后台授权）

**下一步计划**：
- 配置生产 feed URL 实现真实自动更新
- 在有权限限制的子树中实测 40403 占位文件逻辑
- 修复端到端测试脚本端口硬编码（`server/scripts/e2e-integration-test.ts:11`）

---

## 许可证

内部项目，专有许可证。
