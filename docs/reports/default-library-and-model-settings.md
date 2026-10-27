# 默认知识库目录与模型配置易用性验收

> 后续更新：原始文档整理三协议、空白配置和会话输入框模型切换已落实，当前验收见 [统一调用与会话模型选择](unified-models-and-session-composer.md)。以下保留当轮验收记录。
日期：2026-10-27。feat/agent-knowledge-workbench，版本0.3.47；保留此前未提交工作，不合并main、不推送或发版。

## 实现与参考

参考amagi-codebox的docs/user/providers.md、AddProviderDialog.vue和PresetDialog.vue，沿用「服务提供商负责连接与认证、预设负责模型与参数」的组织方式。复用本应用已有ConfigManager、ModelProviderSettings和统一provider descriptor，不创建旁路配置系统。

- 启动时初始化未配置的知识库路径并落盘：Windows按D盘、C盘、用户Documents顺序尝试；macOS/Linux使用用户Documents。已有路径保持。FEISHU_SYNC_HOME隔离部署使用其数据根下的飞书知识库。目录权限失败尝试下一项，全失败保留手动入口；损坏配置不自动覆盖。
- 开放「服务提供商与模型」设置页，支持多提供商、多预设、默认选择、上下文与输出token数、思考能力，以及「保存并用于Agent」。应用内提供商通过现有OpenAI兼容接口调用，其他Pi原生协议仍可通过本地Pi配置使用。密钥沿用既有遮蔽/保留/清除语义。
- Agent来源可切换应用内服务提供商或本地Agent配置（Pi）。可选的应用提供商必须启用、配置端点/密钥且有启用的模型；切换提供商清除上一个提供商的预设绑定。失效的显式模型选择不静默更换，也不借用其他提供商的密钥。
- 本地Pi桥接先由原生ModelRuntime与ReadOnlyAuthStorage解析可用聊天模型，再仅注册相应提供商和模型。排除未认证内置目录与过期OAuth；原生认证解析用于实际请求，支持仅在auth.json中保存的API Key。通用Pi认证、models.json与缓存均不写入，缓存位于应用专属Pi home。
- 会话/构建/探测使用同一应用配置描述符。已有会话以模型来源、提供商/预设/参数、运行时与本地配置文件摘要判断进程是否兼容；配置改变后下一轮重建并恢复历史，配置未变时复用。不把密钥或摘要放入前端DTO、命令行或日志。

## 自动检查

npm run check通过：前端17文件116例、后端66文件847例，三段typecheck通过，lint零错误（保留两条既有Hook依赖警告）。build:all与electron:build通过。

新增或扩充回归覆盖：D/C盘选择、创建与持久化、已有路径保留、权限回退、损坏配置保全、预设参数与遮蔽密钥回读、无跨提供商密钥回退、无效/停用显式选择、模型与认证摘要变更，以及同一会话修改模型后重建进程、输出上限真实生效、相同配置继续复用。原有R04并发/收尾与idle生命周期回归保持通过；注入进程fixture同步登记其配置基线。

真实Pi回归使用临时models.json/auth.json：仅配置的两项模型出现在列表，缺少认证的自定义项和内置目录、过期OAuth均不出现。存储于auth.json的测试Key在本地OpenAI兼容HTTP fixture完成对话，返回预期回复，原认证/模型文件逐字节保持，密钥不复制进应用auth.json。

独立首次启动脚本在临时FEISHU_SYNC_HOME构造真实buildServer：自动创建「飞书知识库」且GET配置返回持久化路径，重复读取不变。Windows分支通过平台注入测试，本轮未做Windows实机安装验收。

## 浏览器验收

仅使用/tmp/feishu-f3-browser.e5Pew8，不修改真实应用配置或真实知识库。

1. 新设置页创建「本地验收网关」，连接127.0.0.1本地HTTP fixture，预设「快速对话」模型usability-chat，上下文64000、输出2048；保存并用于Agent。
2. Agent设置显示所选提供商和预设，未配置密钥的GLM不在可选项中。页面重新进入后参数与遮蔽密钥正确回读。
3. 从对话页新建验收会话，实际收到「应用内模型配置验收成功。」；本地HTTP捕获model=usability-chat、max_completion_tokens=2048，且认证与测试Key匹配。不访问远端模型。
4. 切换为本地Pi配置，状态就绪，下拉按提供商分组加载过滤后的96项；只读取配置及认证，不进行远端模型调用。
5. 验收结束软删除自建会话并将JSONL移入.deleted，恢复原应用模型配置及Pi来源，移除测试提供商。原有两篇原始资料SHA256不变。

截图：provider-model-settings.png、app-model-conversation.png，位于本会话visualizations目录。Electron仅构建证据；未合并main、未发版。
