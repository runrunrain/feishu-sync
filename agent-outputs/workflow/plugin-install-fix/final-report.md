# 插件安装检测与应用内安装：最终交付

已修复并重新构建安装到当前设备，版本0.3.50（arm64，本地ad-hoc签名）。代码保留主树未提交，未改用户e5bb904提交或amagi上游/全局插件。

## 用户可见结果
- 构建专用固定amagi2.21.31与只读检测到的全局2.21.36分栏，不再把不同安装域混为一谈；运行时探测失败不会抹掉已装事实。
- 默认安装经正式Pi CLI从官方仓库完整commit929000ecbd8725e72b191493345d6abeef51c147获取，不再走未发布npm包。物化冻结、完整hash、真实CLI登记与Git溯源齐全；没有绕过固定版本/能力门。
- 本地目录选择接通原有desktop桥，浏览器仍可手填；短错误+可展开详情；显式刷新/新安装清错，过期GET不覆盖新状态/错误。
- 依赖内部.bin生成可迁移launcher，真正从原包位置执行；实体realpath严格在获取git容器内，外链拒绝；tilde覆盖与失败时序补齐。

## 验证
最终同全量/原断言/timeout仅文件串行：lint/typecheck、前端529/server3117通过，16skip，build:all通过。日志/tmp/plugin-install-fix-final-{check,build}.log。原生Git安装、重复hash、相对/恶意路径shim、真实扩展probe36/0有报告；独立审核初轮1Major/2Minor均经Leader小修闭合，c3021b31 PASS且accepted（review-report.md；原FIX与证据保留）。

临时浏览器实际安装/错误/校验见browser-acceptance.md和browser-installed-final.png。最终**已安装Electron**通过CDP实际操作设置→构建编排→默认安装→自动刷新显示专用31已装、全局36独立、静态检查通过；再次点校验得到沿用既有安装。electron-installed.png已实际读取核验，目录选择按钮在真实preload下可见，选择成功/取消分支由37项组件测试覆盖，不冒称额外OS文件选择器自动化。

## 本机安装
- 应用：/Applications/Feishu Sync.app，旧版备份：/Users/run.mao/Library/Application Support/feishu-sync-install-backups/20261101-171051-plugin-fix/Feishu Sync.app。
- 正常AppleEvent退出后ditto到新bundle、签名复核、rename替换；未强杀或删除用户数据。通过应用按钮新建专用31，旧失败npm骨架保留aside；全局Pi settings前后SHA相同（未输出配置内容）。
- 最终关闭19222临时调试入口并正常重启，无debug参数；PID60546/服务57834健康status=ok。已安装Electron SQLite ABI125内存SQL通过；实际受管typescript-language-server --version=6.0.0。开发root/server恢复Node ABI137，两份内存SQL通过，不影响已安装包。
- 临时浏览器会话已关闭，两个已核对cwd/命令的自有QA服务已正常停止；原失败/独立取证目录保留，不删除未确认现场。

## 边界
完整验证未达仍按原定义如实展示：安装成功/静态检查通过不等于A23六源、真实模型质量/性能、Windows真机或所有OS边界全部验收。未改变编排默认/用户现有配置，不把文件围栏称OS沙箱。

上游：research-report.md、implementation-report.md、review-initial-report.md、review-fixes.md、review-report.md、native-probe-report-extload.md、browser-acceptance.md。

<!--AMAGI:DONE-->
