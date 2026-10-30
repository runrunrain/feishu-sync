# 阶段 C：独立内网共享与客户端兼容集成证据

基线 `060c02f`。上游：用户指定设计v1.1（路径见workflow）、gateway-report.md、ui-report.md、client-compatibility-report.md、regression-fixes.md。P5全部源码已集成主树；UI原mock历史与真实browser续接请看报告最新段。完整Electron界面留打包候选就绪后验证，不以Node20 RunAsNode冒充GUI。

## 实现与安全边界

- kb-lan/：私网CIDR(含IPv6/mapped)、Bearer摘要比较、独立秘密文件、父审计、会话/公平限流、子进程manager/心跳/退避/网卡恢复。
- kb-mcp-gateway.cjs：独立固定端口，只含/mcp、共享一个QueryService和共用七工具，每会话notice独立；默认关闭，主应用监听始终回环。无SQLite/出站连接/文件写入，审计由父落盘。
- 管理面：desktop-only七API，CLI/app_command禁kbLanMcp整段/子键，通用PUT配置剔除；令牌不入普通配置，轮换先关旧进程再持久新秘密。
- UI：设置→Agent标准库→知识库共享；启用/全网卡/轮换确认、掩码/显式reveal/失焦清除、配置环境引用、独立settings保存、真实状态/审计/排障。
- Leader修复：配置保存成功后的gateway refresh失败不再误报保存失败，兼容原路由mock缺standardKb的测试。
- 正则隔离补强：应用内kb_grep拒绝regex、只支持literal；仍满足P3可选穷举工具。JS regex只在stdio独立进程和带父watchdog的LAN子进程执行，避免冻结Electron主事件循环。未扩权限。
- 实际客户端发现并修复：Claude 2.1.312拒绝顶层oneOf导致三工具不可见，已移除组合schema，互斥校验仍在共用服务执行；pi direct对8k中文按字节截中段，按initialize client.name对pi会话选≤6000字符的页预算，服务/索引仍共享、next不静默丢。独立CLI修复后复测已通过：真实pi name=pi，8k/15k中文逐页恢复全文且每页未截断；Claude首轮七工具可见、三个原缺失工具真实调用成功，15k/25k/40k正文完整。均为真实CLI+产品MCP+合成推理fixture，不是实际LLM质量验收。

## 已执行

- root `npm run test:all`：前端65文件423项通过；server136通过/1 skip文件，1977通过/8 skip。21s，日志 `/Users/run.mao/.pi/agent/amagi/data/run-bg/bg-24eac70a.log`。首次全量两项旧测试失败已确证根因并仅修测试（macOS /etc symlink、Pi测试未显式选Pi后端），相关32项通过，未放松生产围栏。
- server build + P5/内置/config相关9文件89项通过（3.77s）：日志bg-1c059f6f；包含真实desktop API→CJS→MCP七工具、三端一致、双会话切版、令牌轮换旧401/旧session404、停用/权限/审计保密、Node20实际HTTP产物。
- 客户端compat小修后 build + MCP/三端/网关/内置4文件26项通过：日志bg-22e8d0be（以原始日志为准）。新增无顶层组合schema、pi会话每页UTF8<20KB、中文全文逐行分页恢复。
- C3正式产物真实grep恶性regex→watchdog→恢复：注入短时序3.14s；另生产默认2s tick/10s heartbeat/1s backoff实测 **13029.46ms≤15s**。临时脚本回收，报告保留原始数值。
- 合成容量实测（Node24、127.0.0.1，非真实资料/异机）：10MiB单客户端warm p95 3.87ms，3×4并发28.00ms；30MiB单8.01ms，3×4 52.97ms；busy/errors全0。每个子进程恰好1条index_build；冷启动总计227–436ms；父Node eventloop p99增量−0.033..0.664ms，非Electron负载证明。全部细表与方法见gateway-report.md。
- pi1.4与官方临时Claude2.1.312实际stdio/HTTP连接与Bearer正反验证通过；后续真实CLI+合成推理服务捕获证明pi direct中文字节截断、codemode脚本取得原文、instructions首行到达时序；不是实际LLM或人工问答质量。

## 仍待 Gate 与边界

本阶段集成需diting full安全/生命周期审核；真实browser重点启停/轮换/审计/端口故障已通过；回环.local/故障地址UI增量及Electron仍待成品补验，CIDR清空等在续接清单。客户端修复后回归已通过。候选打包/完整Electron、最终lint/typecheck/check尚在收口。独立pack staging不得改共享better-sqlite3 ABI。

真实80条标注、真实发布语料/质量门槛、12问人工判断、第二设备/真实内网、真睡眠、24小时长跑、Windows实机不具备条件，不计PASS。P4/X/P5b按真实门控，不由合成Q5或模拟负载擅自启动。回滚首先停用监听，再revert阶段提交，无发布格式/DB迁移。
