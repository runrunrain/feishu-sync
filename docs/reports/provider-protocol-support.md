# 提供商协议与模型预设贯通验收

> 后续更新：原始文档整理三协议、空白配置和会话输入框模型切换已落实，当前验收见 [统一调用与会话模型选择](unified-models-and-session-composer.md)。以下保留当轮验收记录。
日期2026-10-27；feat/agent-knowledge-workbench，0.3.47开发版。此前未提交工作保留，不合并main、不推送/打tag/发版。

参考CodeBox的internal/launcher/pi_config.go协议映射与提供商配置交互，在现有LlmProviderConfig中新增protocol，使用Pi原生的openai-completions、openai-responses、anthropic-messages三种适配器。UI新增接口协议选择与相应Base URL提示，模型代码及运行参数仍由提供商下的预设管理，不另建连接或凭据存储。

## 调用与兼容

- Pi就绪探测、SessionService和KbBuildService继续通过buildAppLlmRunConfig构造同一描述符。协议、基础地址、模型代码、上下文、输出上限、思考能力一起交给Pi；密钥只通过子进程环境变量注入。
- 旧提供商缺少protocol时默认Chat Completions；一次迁移后重复加载不再写盘。非法协议保存被拒绝，配置文件保持；手工落盘的未知协议提供商会停用。新配置深拷贝默认数据，防止不同配置实例的提供商对象互相污染。
- 保存保留遮蔽密钥，切换协议不清空用户端点、模型与凭据；Agent列表显示提供商对应协议。原有模型配置摘要已经包含提供商协议，下一轮会话重建后使用新协议并保留历史。
- 原始文档整理是旧的独立direct通道，仍仅支持Chat Completions。UI提示该边界，非Chat协议在发请求前明确返回不支持，避免向Anthropic/Responses端点发送Chat请求。本轮需求的Agent和标准库构建均支持三种协议。

## 验证

npm run check通过：前端17文件116例、后端67文件857例；类型检查通过，lint零错误（两条既有Hook警告）。build:all和electron:build通过。Electron仅编译证据。

provider-protocol-live.test.ts使用真实Node/Pi/应用转发扩展、SessionService、KbBuildService、SQLite和临时原始/标准知识库；仅HTTP远端由本地协议fixture替代。三种协议逐项完成：

1. Agent对话产生预期回复，JSONL历史可读。
2. 标准库通过raw_read读取原文、kb_write_doc写入文档、kb_finish完成，经过正式校验与原子发布，manifest包含一篇文档，原始文件字节不变。
3. 所有模型请求严格命中选定路径：/v1/chat/completions、/v1/responses、/v1/messages；选定模型protocol-model和输出上限2048均生效。OpenAI两种协议使用Bearer，Anthropic使用x-api-key；请求正文不含密钥。

配置回归覆盖三种协议保存/回读、遮蔽密钥保留、缺省协议、未知协议拒绝且原文件不变、默认配置对象隔离和旧direct通道拒绝错协议请求。原有并发/收尾、插件和知识库发布测试全部保持通过。

浏览器在/tmp/feishu-f3-browser.e5Pew8隔离配置中新增「协议验收网关」，选择Responses保存，API确认协议/模型与遮蔽密钥；再切Anthropic并修改基础地址，保存后整页重载，仍正确显示Anthropic Messages及模型。截取provider-protocol-selection.png后恢复原提供商配置，移除验收条目；Agent仍使用原本地Pi来源，原有两篇资料SHA256保持。不调用真实远端模型、不改通用Pi。
