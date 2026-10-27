# 上一版上下文管理验证（历史记录）

当前实现已按用户澄清改为Pi原生package管理；本记录仅保留上一版验证范围，参见[原生插件管理验证](pi-native-plugin-management.md)。

## 实现结果

设置的Agent标准库分类下新增“应用插件”。知识库对话、Work上下文、构建规则与文风均可编辑/启停/恢复默认，自定义上下文插件可选对话、Work、构建范围。应用数据根内独立注册表保存覆盖层，不写设备通用Pi插件/设置。工具桥仍为应用必需扩展，用户文本不是可执行代码；本轮不引入第三方JS/TS或npm安装。

注册表通过expectedRevision拒绝丢失更新，限制文本及数量；配置与快照均在数据根围栏内。Pi继续禁用自动发现，仅显式加载工具桥与新增上下文扩展。上下文从实际before_agent_start进入system prompt；构建不再重复把规则/文风拼入每批用户消息。按模式冻结运行快照，活跃任务保留旧快照，下一轮仅在指纹变化时回收空闲进程并恢复同一会话历史。

## 可复核证据

- app-plugins.test.ts四例：默认与覆盖层、持久化、增删启停、恢复默认、冲突409、字段/范围/大小校验、按模式快照冻结、通用Pi临时哨兵未改、损坏/篡改/symlink拒绝。使用独立临时数据根，不读真实凭据。
- app-plugins-live.test.ts一例使用真实Pi、本地OpenAI SSE服务及哨兵key。首轮挂起时修改A→B，首轮system仍为A；第二轮重新spawn并恢复会话，system为B且无A；停用后第三轮无两者，第四轮未修改则复用进程。工具仍只有Discuss白名单，无bash/ws_write。
- 第一个真实Pi测试候选在finally重复发送fixture响应，产生“headers already sent”；修正fixture响应幂等后原样保留全部行为断言并通过。不是产品加载失败，也未以更弱断言替换。
- 当前浏览器实际在插件页新建“临时插件验收”、选择对话范围并保存；真实GLM会话发送“应用插件验收口令”，得到仅由插件指定的APP_PLUGIN_LOADED_7F91。验收插件随后删除，四个内置项均保持启用。数据目录为/tmp/feishu-f3-browser.e5Pew8，非用户正式资料。
- 真实pi/GLM经新插件链路完成全量构建：b_20261027060605_252ac1 → r_20261027T060704_40e162，2份合成原始源、2篇标准文档；正文不含来源元数据或修订记录，全部原始字节SHA不变。
- 最终npm run check：前端95例，后端60文件786例；lint无错误（2条既有hook警告）、三段typecheck通过。build:all复制2份prompt和2份Pi扩展并成功打包MCP；electron:build与最终MCP CJS真实stdio四例通过。保留既有前端bundle体积提示。

## 边界与交付状态

真实模型证据来自合成知识库，不表示大型正式库的质量与成本验收。Electron GUI仍受既有环境问题阻塞；本次不调整Electron版本或系统安全设置。未合并main、未push/tag/release，版本保持0.3.47。旧安全复审只覆盖其原范围，不冒称独立审查过本次新增功能。

日志：/tmp/feishu-plugin-live-test-final.log、/tmp/feishu-app-plugins-final-check.log、/tmp/feishu-app-plugins-build.log、/tmp/feishu-plugin-build-live.log。临时日志不保证长期留存，正式回归保留在server/tests/。
