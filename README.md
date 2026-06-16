# 飞书知识库本地同步管理工具（feishu-sync）

跨平台桌面应用：自动检测飞书知识库子树变更并选择性同步到本地，保持本地重构后的 Markdown 内容结构（表格布局、层级格式），支持 LLM 驱动的内容适配。

## 技术栈
- 桌面：Electron 31 + electron-builder 24 + electron-updater 6
- 前端：React 18 + Vite 6 + Tailwind CSS 4
- 后端：Hono 4 + @hono/node-server（内嵌同进程）
- 数据：better-sqlite3 9（SQLite，documents/sync_log/run_log 三表）
- LLM：OpenAI SDK → deepseek（OpenAI 兼容）
- 飞书：lark-cli 1.0.53（认证+变更检测+内容获取统一入口，工具零飞书 token）

## 核心模块
- LarkCliClient：lark-cli 子进程封装，QPS 节流，错误分类
- ChangeDetector：wiki 子树变更检测（obj_edit_time 对比）
- SyncEngine：内容获取→媒体下载→同步块下钻→表格导出→重构→LLM适配→写本地
- LayoutReconstructor：A/B/C/D/E 五类块识别的表格重构引擎
- ContentAdapter：deepseek few-shot 风格对齐
- LocalMapStore：SQLite 映射与状态库
- TrayService：系统托盘常驻

## 安全红线
- 工具代码禁止任何飞书 token 变量（全委托 lark-cli user 认证态）
- 本地 Server Token 鉴权 + Origin/Referer 校验
- deepseek apiKey 加密存储

## 设计文档
架构设计、技术实现、飞书认证专项设计见项目交付目录。

## 状态
M0-M5 全量实现中（Amagi 自主执行模式）。
