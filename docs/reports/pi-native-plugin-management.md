# Pi原生插件管理验证

日期：2026-10-27（America/Los_Angeles）。未合并main、未push/tag/release，应用版本保持0.3.47。

## 交付范围

管理单位从上下文条目修正为Pi原生package。内置知识库工作台含有效package.json/pi.extensions；对话、Work、构建规则与文风是同一包的配置项，原覆盖层及自定义条目保留。支持npm/git/本地包目录/单个JS或TS扩展文件，正式Pi CLI负责安装/更新/移除，Pi自身解析manifest、glob与资源筛选；启停保存并恢复原筛选。实际注册表是应用Pi home的settings.json，不是另造的插件协议。

参考源码：/Users/run.mao/workpace/amagi-codebox/internal/piplugin/service.go、executor.go、types.go及frontend/src/components/extensions/PiPluginPanel.vue；同时核对当前Pi安装的docs/packages.md、docs/extensions.md、resource-loader及SDK声明。CodeBox使用通用Pi目录，本应用按用户要求改为专属agent/pi-home。

## 隔离与生命周期

运行和包管理均使用应用Pi home；本机Pi认证/模型经子进程内Pi ModelRuntime与ReadOnlyAuthStorage复用，不复制密钥、写通用Pi设置或通用模型缓存。自动发现保持关闭，显式传递当前包筛选后启用的extensions/skills/prompts/themes，避免加载全包而越过筛选。

活跃任务期间包管理409；空闲进程先回收，更新后下一次恢复会话。revision和generation保护写入及异步列表刷新。数据目录与本地包源码纳入Workspace保护；丢失/损坏资源报错，不静默假装加载成功。SDK缺失时应用继续启动，插件页显示修复/刷新入口。

第三方插件是受用户信任的原生Node代码，可执行本机操作。宿主工具权限、内部能力令牌及路径校验继续有效，但它们不构成第三方代码的OS沙箱。界面已区分应用自带工具边界与外部插件能力。TUI专用UI请求仍受既有RPC取消策略限制。

## 验证

- pi-plugin-service.test.ts：真实Pi CLI本地包安装/解析/启停/更新/移除、独立TS文件、通用Pi哨兵保持、源码不删；多窗口旧revision与活跃任务拒绝；Pi显式空资源筛选及启停恢复不扩权。
- pi-plugin-isolation.test.ts：用合成通用Pi目录和哨兵模型，真实Pi启动后模型可用；set_auto_retry不改通用settings，auth/models字节不变、没有通用模型缓存、不加载通用扩展，也不复制认证key到应用auth。
- app-plugins-live.test.ts：真实Pi+本地SSE，原生manifest包注入上下文并提供plugin_echo；真实工具调用产生NATIVE_TOOL_RESULT:NATIVE_TOOL_PAYLOAD。活跃任务A→B快照不变、下轮更新、停用无残留、无变化复用，宿主bash/ws_write仍未向Discuss开放。
- 浏览器实际经“添加Pi插件”安装临时标准TS包，真实GLM调用native_pi_check并输出NATIVE_PI_PACKAGE_OK；包级停用/启用/重新加载可见。验收后移除该包，原始源码SHA保持；默认只留启用的知识库工作台包。
- 修复过程中保留了发现：canonical路径混用导致原生CLI相对源错位；--tools会在注册阶段过滤外部工具；直接-e整个包会绕过子资源筛选。分别统一cwd/agentDir、在外部插件模式下处理原生注册与工具负载、按原生解析的启用资源逐项加载。

本地目录与单文件包已端到端实测；npm/git下载入口使用同一正式CLI，未将本地验收冒称远端网络安装验收。Electron GUI沿用既有环境阻塞，不升级Electron或改变系统安全设置。此前独立安全复审只覆盖原范围，不冒称覆盖本次原生插件能力扩展。

截图：feishu-native-pi-tool-proof.png保留真实工具调用；最终管理页另存feishu-native-pi-packages.png。临时日志位于/tmp/feishu-pi-packages-*与/tmp/feishu-native-*；正式回归用例保存在server/tests/。


## 最终检查

冻结代码npm run check通过：前端12文件95例、后端62文件788例；lint无错误（2条既有hook警告）、三段typecheck通过。build:all、electron:build、最终MCP CJS真实stdio四例及diff检查通过，保留既有bundle体积提示。日志：/tmp/feishu-pi-packages-release-check.log、/tmp/feishu-pi-packages-release-build.log、/tmp/feishu-pi-packages-electron.log、/tmp/feishu-pi-packages-mcp.log。

新原生资源加载及只读共享认证路径经真实Pi/GLM完整构建：b_20261027071119_911cef → r_20261027T071213_5cb6e9，原始资料SHA保持。临时包已移除，管理页只保留一个启用的知识库工作台包；原四项配置仍可在其中编辑。
