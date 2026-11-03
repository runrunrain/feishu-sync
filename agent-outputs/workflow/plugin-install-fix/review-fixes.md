# 独立审核三项闭环（Leader直接处理）

原报告review-initial-report.md保留b914a0f9的FIX：F01 Major、F02/F03 Minor。不覆盖原证据，不擅自改pin/全局插件。

- F01：获取root拒绝自身为symlink；获取root/git容器/SDK实体三者realpath归一，实际gitRoot必须严格对应root/git，实体必须严格在gitRoot内；返回并物化canonical实体，同一实体在await git HEAD检查后再次核验。不是扩大为所有同uid FS TOCTOU的OS沙箱承诺。新增真实git fixture负例：package位置、git祖先、acquire根三种外链置换都amagi_acquisition_incomplete且无安装记录；git-extra相近前缀不接受。正常/temp→/private/temp物理别名保留正例与真实Git live通过。
- F02：按官方tilde语义展开~、~/及Windows~\\覆盖，再必要绝对化；补正式断言，其他发现/隔离语义不变。
- F03：移除被动[status]清安装错误effect；清错仅用户显式刷新/新安装动作，安装前旧GET不能擦除更新的安装失败。新增deferred GET→安装失败→旧GET后到仍保留错误→显式刷新清错反例。原成功后latest-request-wins测试保留。

验证：根单组件37通过，server三文件30通过（含真正Git/原生SDK/Pi的live非skip）、typecheck和lint exit0。日志/tmp/plugin-install-fix-r2-{ui,server,types,lint}.log。先前主树全量前端528/server3113过16skip、build exit0保留；这轮将再跑最终全量，并做一次对应增量复核后才替换桌面应用。
