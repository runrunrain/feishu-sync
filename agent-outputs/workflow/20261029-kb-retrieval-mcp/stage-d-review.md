# Stage D：修复后唯一增量安全终审

**VERDICT: PASS**

本轮声明范围内无 Critical / Major / Minor finding；不是完整阶段 C 重审，也不是最终外部发布批准。旧 `stage-c-review.md` 的 PASS 不作为新增 IPC / 日志修复的通过依据。本轮未修改生产代码、测试、依赖、模型或 ABI，未提交 Git、未全量 check / build、未自动发起下一轮。

## 基线、输入与精确范围

- 主树 `/Users/run.mao/workpace/feishu-sync`；实际 HEAD `c2aca8d2bc4f745dcaf3bd6aecb0a8b0ef1be459`。以 `git diff c2aca8d` 加 `git status --short` 中范围内 untracked 文件为当前实现，不使用旧 worktree 源码。
- 完整实读 `CLAUDE.md` 及本目录 `stage-c-review.md`、`stage-d-fixes.md`、`ui-report.md`、`package-report.md`。采用专项报告最新续接；早期 FAIL / pending 保留为历史，不覆盖后来的实测。
- 生产增量：`electron/{main.ts,preload.ts,desktop-contracts.ts,clipboard-service.ts}`；`src/types/index.ts` 的桌面镜像；`src/utils/clipboard.ts`；`KbLanMcpSettingsCard`、`agent/AgentSettingsCard`、`CliAccessSettingsCard`、`AuthSettingsCard`、`FeishuWriteSettingsCard`、`ChangeItem` 六个组件的七个复制调用点；`server/src/index.ts` 两处日志；README 开发环境凭据说明。
- 验证增量：untracked `src/utils/clipboard.test.ts`、`server/tests/kb-lan-desktop-fixes.test.ts`，以及 KB 卡新增 CIDR 回归；相邻既有组件/API测试用于针对性复核。
- 未变 KB 引擎、全网关不重审。范围外报告、注册表、`amagi.json`、`kb-discuss-integration.test.ts` 等未跟踪内容只辨别归属，不当作本轮新增实现、不修改。
- 独立只读重算生产清单（同 `package-source-manifest.py` 的路径/序列化规则，含 untracked 源与 ignored build 资源）：**481 条，SHA-256 `885c1582db06618660e9d1e092d34b8931579366c470b3e4efe861e548b91f3b`**，与 staging `repack-source-final.json` 字典完全相同。此为源码冻结/包关联证据，不是可复现构建证明。

## 修复逐项裁定与对抗核实

原首审无 C 编号；以下沿用 `ui-report.md` 旧缺陷序号，不创设回归 finding。

| 原问题 / 反例 | 本轮核实 | 裁定 |
|---|---|---|
| UI 旧缺陷 1：文件页 Chromium 权限拒绝，复制均失败 | `main.ts:366–368` 仅固定 write IPC，按调用时的当前 mainWindow 取得 WebContents；无窗口或已销毁窗口传 null。`clipboard-service.ts:12–18` 同时校验 live trusted 对象、sender 对象全等、非空 senderFrame 与 trusted.mainFrame 全等；外来 WebContents、iframe、空 frame、销毁对象在写函数前拒绝。授权检查至同步写入间无 await | **关闭** |
| 字符串伪造、UTF-8 超界、异常回显复制值 | 原生端拒非 string，`Buffer.byteLength(value,'utf8') > 1 MiB` 拒绝，等于上限允许；非 ASCII 按字节而非 JS length。写异常替换为固定错误；本函数/handler/preload/helper 不记录值。没有 read / 任意 channel 参数或任意 IPC 暴露 | 满足 |
| 借修复放宽权限，或 native 拒绝后转浏览器绕过 | main 权限 handler 仍全部 callback(false)，sandbox/contextIsolation/webSecurity 未改。helper 选择 native 后 await 并直接传播错误，不 catch 后 fallback。仅缺 native bridge 时走原浏览器 writeText；ChangeItem 的旧 execCommand 分支只在无 bridge 且无 clipboard 时可达，不承接 native 拒绝 | 满足 |
| UI 旧缺陷 3：desktop 启动 options dump、standalone token 输出 | `index.ts:692` 仅构造两个严格布尔白名单字段，未知 futureSecret 不被展开/序列化；`index.ts:844` 固定提示代替 standalone token 打印。沿启动路径检索，无另一份 options 整体日志。未知新增 option 不会自动获得日志资格；不是全仓任意异常字符串的脱敏保证 | **关闭** |
| 复制路径改变导致 KB token 生命周期或配置泄密 | KB 卡 diff 仅改 import 与 copy sink；回源检查 reveal generation、blur/visibility/unmount/状态失效清除路径保持。copy 的失败/成功文案固定，不接入 Toast/logger 或复制值；pi/Claude 配置仍使用字面 `Bearer ${FEISHU_KB_TOKEN}`，不把 reveal token 传入配置生成器 | 满足，无修复引入回归 |
| README 引导把秘密粘入日志/源码 | 示例用子进程随机生成至 shell 环境，供 Vite proxy 与 server 共用；明确勿打印/提交，分终端需同值。既有 Vite 配置从同一 env 读值，未新增 renderer bundle 密钥注入 | 满足 |
| UI 旧缺陷 2：清空 CIDR 未生效 | `git diff --name-only c2aca8d -- server/src/kb-lan server/src/modules/config-manager.ts` 无输出；KB 卡生产 diff 也无 CIDR 行为改动。新增组件用例验证省略值/回读；server 用例覆盖 PUT→GET→磁盘→ConfigManager→启用/重启与显式 []。旧候选实测正确 Backspace 后 PUT 200、busy 转换、磁盘/GET 无字段，说明原 fill 空串未触 React | **撤回误报，不存在待修 CIDR finding** |

## 实际查证与引用证据

### 本轮独立执行（cwd 均为主树）

1. `git rev-parse HEAD`、`git status --short`、`git diff c2aca8d --stat`、范围完整 tracked diff；逐项完整读取三个新 clipboard 文件与新 server 回归，读取必要主窗口/导航/preload/启动及 KB 消费链。未仅依赖 diff stat 漏掉 untracked。
2. `git diff --check c2aca8d -- README.md electron src server/src/index.ts`：exit 0。CIDR manager / ConfigManager diff 空。前者不替代 untracked 语法验证。
3. `npm test -- --run src/utils/clipboard.test.ts src/components/KbLanMcpSettingsCard.test.tsx src/components/CliAccessSettingsCard.test.tsx src/components/agent/AgentSettingsCard.test.tsx src/components/AuthSettingsCard.test.tsx src/components/FeishuWriteSettingsCard.test.tsx src/api/kb-lan-mcp.test.ts`：exit 0，**7 文件 51 项通过**。含原生可信帧/异 sender/异 frame/空 frame/销毁对象、类型/UTF-8 界限、固定错误，native 优先/拒绝不降级、浏览器正常与拒绝。
4. 只读 Python 从 Git 路径集合重算上述 481 条生产源清单并与 staging 记录比较：exit 0，digest 相等、snapshot_equal=true；不生成清单文件。
5. 对原始 `bg-a85e675f.log` 仅提取汇总及目标测试行，未 dump 全日志、未读取真实凭据。实读行 123–124：427 前端通过；8671：`kb-lan-desktop-fixes.test.ts` 2 项通过；8756–8757：server 1981 通过/8 skip；8762 起 build:all、8797 起 electron:build；另有 lint 0 error/3 warning。命令 exit 0 的整体状态采用任务书与打包报告，不以本轮 grep 退出状态冒充原命令状态。

### 引用上游，未在本轮重新执行

- `stage-d-fixes.md#最终续接：撤回 CIDR 业务改动后的回归`：原 worktree 五文件 19 项通过作为历史辅助；当前实现认定来自主树 diff/源码及主树原始 check 日志，而不是旧 worktree 状态。
- `ui-report.md#最新续接：最终候选 181dc28f 真实 Electron 增量复验`（任务书标记真实 Electron 任务 c00dda65）：真实按钮→系统剪贴板私有比较，地址/pi/Claude/token 四类均通过；navigator 仍 NotAllowedError、write 桥存在且无 read 桥；两 token 对本次启动日志检查均 false；原生 blur、CIDR、作废/退出回收通过。候选标题与任务标识不混同 Git HEAD，关联以 481 条源 digest 为准。视觉结论沿用洛神，不重新代签。
- `package-report.md#当前交付与状态` 至 `§13.10 A8`：新源→构建→包逐字节关联；签名/包内 Electron31.7.7 ABI125 SQLite；主树 Node ABI137 未变；DMG只读挂载与 ZIP 解包完整清单验证。stdio/gateway CJS 哈希仍为 `84c1b83e…` / `025b7050…`，因此旧真实客户端证据未因本次复制/日志修改失效。以上本轮引用，不冒充重包/介质重验。
- 同报告 standalone 正式入口实测：显式回环 **49614**，health/管理/真实 gateway/七工具/停止/凭据日志私有检查通过；默认3001被 foreign watcher占用未触，`NODE_ENV=test` 仅用于跳过自动安装，不能宣称默认环境全等价。

## 证据可信度、盲区与交付边界

- 负向 IPC 授权以代码实际同步路径与直接函数 fixture 回归验证；真实 Electron证据证明正常写入和权限未放宽，但未独立用恶意 iframe/销毁竞态跑真实 IPC 负向矩阵。未发现必须另写复现脚本的成立反例，故不新增脚本或项目测试。
- server 两项新增回归已审其真实 HTTP/SQLite/child/重启及四 console 方法 spy 路径，并读到主树原始全量日志中的通过结果。本轮不重跑其 beforeAll bundleGateway（会刷新编译输出），也不重复整套 check/build。
- 最新 Electron 私有检查覆盖本次进程两类已知 token；standalone helper 使用显式 env 凭据，随机缺省 token 不打印另有源码路径证据。不是对所有既有日志、所有异常和第三方依赖输出的全仓安全证明；旧日志披露历史不因修复被抹去。
- 真实80条/异机私网/睡眠/24h/实际LLM人工判分仍未覆盖；默认端口3001、Windows、Gatekeeper默认放行、公证亦不在本次通过范围。ad-hoc包不是正式发布批准。
- 主树本轮仅新增本报告；测试未主动变更产品/依赖/ABI。回滚本轮仅涉及本报告，产品修复回滚由 Leader 按原 diff 裁决，不执行 reset/restore/clean。

**VERDICT: PASS（仅限上述冻结增量安全终审；无 finding，不自动扩展为最终外部发布批准。）**

DONE
