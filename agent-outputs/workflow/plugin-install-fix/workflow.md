# 插件检测与应用内安装修复

## 目标
修复构建编排页 amagi 插件已安装状态误解及默认安装npm404；按当前工作区实现并在实际桌面验证，保留用户14路径与其全局插件、不降低private固定31/hash/能力门槛。

## 已确认
- 旧构建状态仅认private runtime-packages安装记录，把其他Pi插件概括成未安装；installed状态还依赖runtime解析成功，错误时丢事实。
- 默认npm:amagi-pi@2.21.31公共源不存在；无路径按钮必404，源路径仅手填；“重装”实际只verify复用。
- 本机上游工作树manifest2.21.36，不可修改/假称31；已提交/公开Git HEAD929000ecbd8725e72b191493345d6abeef51c147的manifest为2.21.31，无版本tag。默认可用官方完整Git提交，经原生CLI/SDK获取，复用source物化冻结与最终CLI登记；不追latest。

## 切片
1. baize66387048：只读溯源通用插件管理/构建固定版本边界，research-report.md。
2. lubana7aef070：dirty-snapshot86020784 worktree实现（.amagi-worktrees/plugin-install-fix），复用CLI/SDK发现与冻结安装，状态DTO+目录选择/错误交互+正反回归+实际临时安装。禁止改用户WIP或生产插件。
3. Leader：核对合并diff、保留14路径，实际浏览器/Electron交互，独立高风险安装来源/状态审核，构建安装新版；现有应用与数据不清理。

当前：completed。实施a7aef070→1668c179已accept并主树集成；独立b914a0f9 FIX三项经Leader直接修正，c3021b31增量PASS且accepted。最终同全量529/3117通过16skip、构建通过，已打包安装到/Applications/Feishu Sync.app，并在实际Electron按钮完成专用31安装/再次校验，global36不变；debug已关闭，开发ABI恢复。详final-report.md。代码未自行提交，原用户e5bb904保持。

现场变更：原用户14路径已由另一会话提交为e5bb904，主树HEAD=e5bb904；实现worktree86020784已含同等用户内容，仅回流本批delta，不回滚/重放用户提交。只读报告66387048→8591eb91已accept并纠正该时间线。
