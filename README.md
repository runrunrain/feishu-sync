# 飞书知识库本地同步管理工具（feishu-sync）

**跨平台桌面应用**：自动检测飞书知识库子树变更并选择性同步到本地，保持本地重构后的 Markdown 内容结构（表格布局、层级格式），支持 LLM 驱动的内容适配。

**状态**：M0-M5 全量完成（v0.1.0），谛听审核通过。

---

## 功能特性

- **变更检测**：定时轮询飞书知识库子树，托盘通知变更数量（支持工作时间高频检测）
- **同步引擎**：单篇/批量同步，图片/附件/sheet 块下钻，表格导出为本地重构版 Markdown
- **表格重构**：A/B/C/D/E 五类块自动识别与重构（metadata/hierarchy/datatable/paragraph/sparse）
- **LLM 适配**：deepseek few-shot 风格对齐，支持流式输出与降级策略
- **系统托盘**：常驻托盘，快捷键（CmdOrCtrl+Shift+F）显示窗口，支持开机自启
- **自动更新**：electron-updater 集成，支持检查/下载/安装更新流程

---

## 技术栈

- **桌面**：Electron 31 + electron-builder 24 + electron-updater 6
- **前端**：React 18 + Vite 6 + Tailwind CSS 4
- **后端**：Hono 4 + @hono/node-server（内嵌同进程）
- **数据**：better-sqlite3 9（SQLite，documents/sync_log/run_log 三表）
- **LLM**：OpenAI SDK → deepseek（OpenAI 兼容）
- **飞书**：lark-cli 1.0.53（认证+变更检测+内容获取统一入口，工具零飞书 token）
- **开发**：TypeScript 5 + esbuild 0.28

---

## 架构概览

**分层架构**：桌面层（Electron）→ 服务层（Hono）→ 业务层（ChangeDetector/SyncEngine/LayoutReconstructor/ContentAdapter/LocalMapStore/LarkCliClient/ConfigManager）→ 数据层（SQLite）→ 展示层（React）

**核心模块**：

- **LarkCliClient**：lark-cli 子进程封装，QPS 节流，错误分类（99991400 指数退避）
- **ChangeDetector**：wiki 子树变更检测（obj_edit_time 对比本地 SQLite）
- **SyncEngine**：内容获取 → 媒体下载 → 同步块下钻 → 表格导出 → 重构 → LLM 适配 → 写本地
- **LayoutReconstructor**：A/B/C/D/E 五类块识别的表格重构引擎
- **ContentAdapter**：deepseek few-shot 风格对齐（temperature 0.2）
- **LocalMapStore**：SQLite 映射与状态库（首次索引扫描 < 10s）
- **TrayService**：系统托盘常驻与变更通知
- **UpdaterService**：electron-updater 集成（autoDownload=false，autoInstallOnAppQuit=false）

---

## 快速使用说明

### 环境要求

- Node.js 18+（实测 v24.16.0）
- lark-cli 1.0.53（全局安装：`npm install -g lark-cli`）
- Windows 11（打包目标含 macOS x64/arm64，需 macOS 环境验证）

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
# 认证登录（首次使用需登录飞书账号）
lark-cli auth login --scope=wiki:doc:readOnly,sheets:spreadsheet:readOnly

# 确认认证状态（需显示 user valid 且含 requiredScopes）
lark-cli auth status
```

**认证就绪条件**：user valid + scope 覆盖 `wiki:doc:readOnly,sheets:spreadsheet:readOnly`

### 配置 deepseek 与本地知识库

编辑 `config.json`（首次运行自动生成）：

```json
{
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "YOUR_DEEPSEEK_API_KEY",
    "model": "deepseek-chat",
    "temperature": 0.2
  },
  "pollIntervalMinutes": 30,
  "knowledgeBaseRoot": "D:/WorkPace/Database/03-项目交付",
  "watchedRootUrls": ["https://feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb"],
  "larkCliPath": "lark-cli",
  "requiredScopes": ["wiki:doc:readOnly", "sheets:spreadsheet:readOnly"],
  "enableAutoStart": true,
  "enableNotifications": true
}
```

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
# 一键启动（vite + electron 内嵌 server，无需打包）
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
```

**打包产物**：`dist/FeishuSync-Setup-0.1.0-x64.exe`（Windows NSIS，~99MB）

### 首次使用流程

1. **启动应用**：双击 `FeishuSync-Setup-0.1.0-x64.exe` 安装后启动
2. **配置面板**：设置知识库根路径 + 飞书根 URL + deepseek API Key
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
| `llm.baseUrl` | string | `"https://api.deepseek.com/v1"` | deepseek API 地址 |
| `llm.apiKey` | string | `"sk-xxxx"` | deepseek API Key（加密存储，不入库） |
| `llm.model` | string | `"deepseek-chat"` | LLM 模型 |
| `llm.temperature` | number | `0.2` | 温度参数（风格对齐） |
| `pollIntervalMinutes` | number | `30` | 基础轮询间隔（分钟） |
| `knowledgeBaseRoot` | string | `"D:/WorkPace/Database"` | 本地知识库根路径 |
| `watchedRootUrls` | string[] | `["https://..."]` | 飞书知识库根 URL 列表 |
| `larkCliPath` | string | `"lark-cli"` | lark-cli 命令路径（Win/Mac 自动适配） |
| `requiredScopes` | string[] | `["wiki:doc:readOnly"]` | 必需权限范围 |
| `enableAutoStart` | boolean | `true` | 开机自启 |
| `enableNotifications` | boolean | `true` | 托盘通知开关 |

---

## 安全说明

- **零飞书 token**：工具代码禁止任何飞书 token 变量，全委托 lark-cli user 认证态
- **本地鉴权**：Server Token（crypto.randomBytes(32)）+ Origin/Referer 校验，防止外部调用
- **加密存储**：deepseek apiKey 不明文写入 config.json，启动时内存解密
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

| 文档 | 路径 | 内容 |
|------|------|------|
| 架构设计文档 | `D:/WorkPace/Database/03-项目交付/03-项目工具/知识库本地同步管理工具/架构设计文档.md` | 总体架构、模块设计、接口签名、数据模型、关键流程 |
| 技术实现文档 | `D:/WorkPace/Database/03-项目交付/03-项目工具/知识库本地同步管理工具/技术实现文档.md` | 技术栈、工程结构、完整代码骨架、构建命令、测试策略 |
| 飞书认证架构专项设计 | `D:/WorkPace/Database/03-项目交付/03-项目工具/知识库本地同步管理工具/飞书认证架构专项设计.md` | LarkCliClient 设计、Config schema 修订、认证就绪检查流程 |

---

## 当前状态与已知限制

**当前状态**：M0-M5 全量完成（v0.1.0），谛听最终重审 PASS。

**验收证据**：
- 功能验收：变更检测（31 节点）、单篇 docx 同步、表格重构、deepseek LLM 适配
- 性能验收：增量检测 ~2s（< 5s 达标），单篇 docx < 1s（< 30s 达标）
- 安全验收：Token 鉴权、Origin 校验、零飞书 token、加密存储全绿
- 跨平台验收：Electron v31.7.7 可启动，开机自启动配置已实现

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
