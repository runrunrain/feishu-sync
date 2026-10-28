# P2-S3 报告：设置页——构建字数预算 UI + 截图/白板开关露出

- **日期**：2026-10-28 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P2.md` §2.5（配置与界面）、`P2-S2-report.md`（buildBatchWordBudget 契约）、`P1-S5-report.md`（slidesScreenshot + optionalScopes 契约）、`P0-S6-report.md`（whiteboardExport 契约）
- **状态**：已实施；真机浏览器全链路验证通过

## 一、产物清单

| 文件 | 改动 |
|---|---|
| `src/types/agent.ts` | `StandardKbConfig.buildBatchWordBudget: number`（P2-S2 报告 §五.5 的前端镜像补齐项） |
| `src/types/index.ts` | `AuthStatus.optionalScopes?: {granted, missing}`（P1-S5 server 契约镜像）；新增 `SyncConfig`（slidesScreenshot/whiteboardExport）+ `Config.sync?` |
| `src/components/agent/AgentSettingsCard.tsx` | 「每批字数预算」控件（构建并行数旁，输入+保存模式）；导出 `clampBuildBatchWordBudget` / `describeBuildBatchWordBudgetInput` / 三个边界常量；3 处 fallback base 补缺省 40000 |
| `src/components/SyncMediaSettingsCard.tsx` | **新卡**「同步媒体选项」：slidesScreenshot 开关（+scope 提示态）、whiteboardExport 开关（+svgTimeoutMs 高级项）；导出 `describeSvgTimeoutInput` / `SLIDES_SCREENSHOT_SCOPE` |
| `src/components/common/Input.tsx` | Toggle additive `ariaLabel` prop + `role="switch"`/`aria-checked`（修无名称开关按钮——读屏与自动化均无法定位；既有消费方不传不受影响） |
| `src/views/SettingsView.tsx` | 「知识库与同步」组注册 `kb-sync-media` 侧栏项（同步根目录之后） |
| `src/components/SyncMediaSettingsCard.test.tsx` | 新增 10 用例 |
| `src/components/agent/AgentSettingsCard.test.tsx` | 新增 3 用例（渲染锚定 + clamp/feedback 纯函数）+ makeConfig 补字段 |

## 二、控件与 API 字段映射表

| 控件（位置） | API 路径 | 字段 | 取值域/缺省 | 保存行为 |
|---|---|---|---|---|
| 每批字数预算（Agent 标准库 → 标准库与 Workspace） | `PUT /api/config` → `standardKb` | `standardKb.buildBatchWordBudget` | `{0}∪[4000,400000]`，缺省 40000；0=按源数分批旧行为 | 输入+保存按钮；前端同款钳制后发送（非数字→40000、≤0→0、越界→边界、floor），与服务端 `normalizeBuildBatchWordBudget` 语义一致 |
| 幻灯片整页截图（知识库与同步 → 同步媒体选项） | `PUT /api/config` → `sync` | `sync.slidesScreenshot.enabled` | boolean，缺省 false | Toggle 即保存，只传该子段（server 子段级 spread merge，另一段不动） |
| 截图权限提示态（同上卡内） | `GET /api/feishu/auth-status` | `optionalScopes.missing/granted` 含 `slides:presentation:screenshot` | — | 只读消费：开关开启 ∧ missing 含该 scope → 「未授权」徽标 + 引导警示条（指向「飞书认证」重新认证勾选截图权限；未授权期间同步自动跳过截图不阻断）。无 optionalScopes 字段（旧 server）防御性不渲染 |
| 白板矢量导出（同上卡内） | `PUT /api/config` → `sync` | `sync.whiteboardExport.enabled` | boolean，缺省 true（仅显式 false 关闭） | Toggle 即保存；关闭时 svgTimeoutMs 高级项联动隐藏（值经 server merge 保留） |
| SVG 导出超时高级项（开启白板时显示） | `PUT /api/config` → `sync` | `sync.whiteboardExport.svgTimeoutMs` | 正整数毫秒，缺省回落执行层 30000 | 输入+保存；空输入不发送该键（保留现值）；显式携带当前 enabled |

## 三、验证证据

### 1. 真机浏览器全链路（agent-browser + 真实 Hono server，临时 FEISHU_SYNC_HOME）

环境：`FEISHU_SYNC_HOME=/tmp/p2s3-home.haQ4GR` + `FEISHU_SYNC_DEV_TOKEN`（vite proxy 注入）跑 `npm run dev:all`；宿主 lark-cli 真实认证态（user，1.0.98），`optionalScopes = {granted:[], missing:["slides:presentation:screenshot"]}`——正好命中主上当前真实形态的「未授权」分支。

| # | 操作链路 | 断言（config API 实测回读） | 截图 |
|---|---|---|---|
| 1 | 打开同步媒体选项卡 | 两开关默认态：截图关、白板开；SVG 超时输入显示 | 01 |
| 2 | 开启「幻灯片整页截图」 | `sync.slidesScreenshot.enabled=true` 落盘；「未授权」徽标 + 引导警示条出现 | 02 |
| 3 | SVG 超时填 45000 → 保存 | `sync.whiteboardExport.svgTimeoutMs=45000` 落盘 | 03 |
| 4 | 关闭「白板矢量导出」 | `enabled=false` 落盘；SVG 输入框联动隐藏；svgTimeoutMs 经 merge 保留 | 04 |
| 5 | 切「Agent 标准库 → 标准库与 Workspace」 | 预算控件回填服务端缺省 **40000**（effect 回填路径，SSR 测试覆盖不到） | 05 |
| 6 | 预算输入 100 | 即时琥珀警示「低于下限 4000，保存将按 4000 生效」 | 06 |
| 7 | 保存 → 再输 0 → 保存 | 落盘分别为 **4000**（钳制）与 **0**（合法旧行为值） | 07 |
| 8 | 恢复 40000 | 落盘 40000，输入框回填 | 08 |

关键 curl 证据（`GET /api/config` 逐次回读）：
- 开截图后：`sync={"slidesScreenshot":{"enabled":true},"whiteboardExport":{"enabled":true}}`
- 存超时后：`sync={"slidesScreenshot":{"enabled":true},"whiteboardExport":{"enabled":true,"svgTimeoutMs":45000}}`
- 关白板后：`sync={... "whiteboardExport":{"enabled":false,"svgTimeoutMs":45000}}`
- 预算链：`budget=40000（缺省）→ 4000（100 钳制）→ 0 → 40000（恢复）`

### 2. 视觉走查（amagi-media-understanding 委托识图，7 张截图逐张核验）

- 三组控件标题、开关状态、输入值、helper/警示文案逐字转写全部正确（含「0 = 按源数分批（旧行为）；范围 4000–400000……」「低于下限 4000，保存将按 4000 生效」「截图权限（slides:presentation:screenshot）未授权」）。
- 识图提出的两个疑点均以 DOM 取证闭环：
  - 「底部提示被截断」→ 滚动容器 `scrollHeight(417)>clientHeight(397)`，滚动 20px 后元素 `bottom(568)≤视口(577)` 完整可见——**滚动可达的视口溢出，非布局裁切**（补截图 10）。
  - 「amber 警示对比度偏低」→ 已改 `text-amber-600`→`text-amber-700`（AuthSettingsCard 既有先例同色）。
- 既有环境噪音（非本切片引入，未改）：认证态轮询偶发把主视图重置回同步视图；「重新检测」按钮 loading 时双图标叠加（FeishuWriteSettingsCard 同款模式）。

### 3. 测试与静态检查（cwd=repo root）

| 项 | 命令 | 结果 |
|---|---|---|
| 前端全量 | `npm test` | exit 0 · **28 files / 250 tests passed**（基线 237+，含本切片 13 个新用例） |
| 类型 | `npx tsc -p tsconfig.json` / `tsconfig.node.json` | 均 exit 0 |
| server 段 | `cd server && npx tsc --noEmit` | exit 0（过程中曾遇兄弟任务 sync-engine.ts 中间态，收敛后全绿） |
| Lint | `npx eslint <8 个改动文件>` | exit 0 |

新增用例覆盖：钳制纯函数 13 断言（0/负/3999.7/4000 恰等/40500.9 取整/400000 恰等/999999/空串/非数字）、输入反馈分级（error/warn/hint）、SyncMedia 卡渲染与缺省态、scope 提示四分支（开启未授权/已授权/未开启/无 optionalScopes 防御）、白板开关联动、svgTimeout 输入校验。

## 四、未覆盖项 / 边界

1. **增量授权流程本体**：任务书只要求提示态文案；「在浏览器完成 includeOptionalScopes 授权」的完整 device flow UI 属 P1-S5 §5 遗留的前端后续切片（server 契约 `POST /api/feishu/auth/device/start {includeOptionalScopes:true}` 已就绪，前端 `startDeviceAuth` 尚未透传该参数）。
2. **slidesScreenshot 开启后的真实采集**：需主上授权 screenshot scope 后按 P1-S5 §5 清单实测，非本切片范围。
3. **Electron 真机**：本验证为 dev:all 浏览器链路（preload/token 路径未走）；控件均为纯 config API 消费，无 Electron 专属依赖。
4. **设置页在 400px 以下极窄宽度**：未逐一走查（沿用既有响应式骨架：侧栏常驻、内容区随页面滚动）。

## 五、并行撞写记录

- 本切片写面仅 `src/**`（8 文件），与兄弟任务（server 侧 sync-engine/lark-cli/kb 等）零重叠。
- 过程中 server 段 tsc 曾报 `sync-engine.ts` 白板 backfill 类型缺失——git status 归因为并行兄弟未提交中间态（非我写面），收敛后复验全绿。

## 六、回滚方式

- `git checkout` 本切片 8 个 src 文件改动 + 删除 `SyncMediaSettingsCard.tsx`/`.test.tsx` 与截图目录。
- 运行期等价回滚：`buildBatchWordBudget=0`（按源数分批）、`slidesScreenshot.enabled=false`、`whiteboardExport.enabled=true`（缺省）。
- Toggle `ariaLabel` 为公共组件 additive 改动，回滚不影响既有消费方（不传即无行为变化，仅恢复无名称按钮）。
