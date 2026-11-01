# 本机macOS arm64构建安装

已按当前工作区（含原有12+2本地改动）构建0.3.50，本地ad-hoc签名，未发布/公证、未改源码或提交Git。

- `npm run desktop:dist:mac:arm64` exit0（147s），日志句柄bg-45d78a22：前端/server/Electron编译、两份Electron native rebuild、DMG/ZIP、deep strict codesign通过。
- 安装：正常AppleEvent quit旧版，确认主进程退出；ditto到临时bundle并复核签名，再rename旧版备份、新bundle入位；未强杀、未清理用户数据。
- 当前路径：`/Applications/Feishu Sync.app`；版本0.3.50，arm64/Electron31.7.7，PID88520，内嵌服务127.0.0.1:61533/api/health返回status=ok；未做额外业务同步/真实资料构建或完整UI回归。
- 安装包内better-sqlite3实际执行内存SQL成功，Electron ABI125；开发root/server随后npm rebuild恢复Node ABI137，两份内存SQL通过。恢复后再次验证已安装包ABI125及健康检查仍通过。
- 旧版：`/Users/run.mao/Library/Application Support/feishu-sync-install-backups/20261101-155416/Feishu Sync.app`。仅备份应用，不宣称备份用户数据库。
- DMG：`dist-desktop/darwin-arm64/FeishuSync-0.3.50-arm64.dmg`，85.25MB，SHA256=78085afa1870fad8c1bf7e6bb04ad612beb180d4942a631d582a34751dd8db2a；ZIP同目录95.31MB。
- 构建/安装/ABI恢复前后原工作区diff逐字cmp相同，tracked/untracked状态相同；本交付报告是随后新增的唯一归档目录，不修改原有用户代码。
- npm依赖审计输出9个moderate，未越界运行audit fix；本地包非Developer ID分发包。

上游：`agent-outputs/workflow/build-runtime-v2/final-delivery-report.md`（代码交付693d840，当前本地包额外包含用户WIP）。

<!--AMAGI:DONE-->
