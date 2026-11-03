# 实际浏览器与桌面交互验收（进行中）

## 隔离
Leader在实现worktree启临时后端watch与Vite：FEISHU_SYNC_HOME=/tmp/feishu-plugin-install-qa.zyVRI8/data，server19121、前端5173，fixture开发token只用于临时服务；未改生产配置/全局Pi设置。agent-browser独立会话plugin-install-fix-6f0a8a36f815。真实lark-cli认证状态仅UI启动探测，未同步/构建真实资料。

## 已执行
- 进入设置→Agent标准库→构建编排：真实UI显示“构建专用固定2.21.31：未安装”，与“全局Pi 2.21.36，本地目录，不用于构建”分栏，来源为实际SDK只读发现，不是mock。
- 默认按钮实际标官方Git+完整commit929000e，公开来源/信任说明清晰；不再误导npm安装。
- 浏览器无desktop.selectDirectory仍可手填。填不存在绝对路径→点安装→服务端真实400，界面可操作短错误；source路径不触发回退Git。
- 真实默认按钮获取官方Git，但初次物化失败（执行中的实现候选）：NPM .bin内部链接的真实路径是/private/tmp，而包含判断根为/tmp，误报外链。原详细错误折叠/展开均实际点击验证；已将完整错误交实现修复，不能据此称默认安装通过。
- 工具摩擦：本机agent-browser fill空字符串及组合键未清空React受控input（值逐字核查）；为避免伪造状态，重新导航完整页面后明确确认输入空，再实际点击默认安装。未改DOM/React状态或mock接口。

## 修正后的实际成功链
- HMR切换曾使设置页退出，先重新进入并逐字确认source输入为空；真实点击官方固定Git按钮，完成CLI获取、依赖物化、最终登记，页面自动显示专用2.21.31已安装；全局2.21.36仍独立未改变。
- 成功后按钮变为“校验固定版本2.21.31”，再次真实点击得到“沿用既有安装”；旧安装错误已清除。
- 原生完整/性能验收未伪装：临时配置缺模型，静态检查仍未过、fullyVerified仍未达，而安装状态正确显示已装。
- 截图browser-installed.png已实际读取核验，状态区、全局版本说明、校验按钮和来源说明都在卡片内，无原长错误撑开布局。

## 二次依赖语义核验
Leader真实运行初版冻结包.bin --version曾exit1（字节复制导致它从.bin寻找../package.json而错位）；已让实施者改相对launcher后，旧坏包只在本临时root移aside留存，不篡改record。重新进入真实UI，空source默认按钮从官方Git新建冻结副本，实际.bin --version=6.0.0 exit0；截图browser-installed-final.png为这轮最终包。全局Pi settings前后SHA逐字cmp一致（未输出配置内容）。

实施者已补真实amagi扩展加载native probe36/0（amagi_resource=true、Leader启动、角色规则注入等）及相对shim/恶意路径回归；Leader主树完整lint/typecheck、前端528/server3113通过16skip、build:all通过，5文件定向74通过。日志/tmp/plugin-install-fix-{check,build,targeted}.log。请求竞态与目录选择取消/成功/无桥由36项组件测试覆盖。

## 最终Electron交付
独立增量c3021b31 PASS已接受。打包arm64 exit0，应用已替换并正常启动；旧版备份见final-report.md。通过临时19222 CDP在实际安装包操作默认Git安装与再次校验，显示专用31已装、全局36不变、静态检查通过，截图electron-installed.png已读取核验。工具connect未使后续命令持续绑定（最初落about:blank），核对真实/json/list后改每条显式--cdp19222，未用空白页冒充应用。最终正常退出并无debug参数重启，调试端口关闭，健康/ABI检查通过；全局settings SHA仍相同。最终全量529/3117通过16skip，详情final-report.md。
