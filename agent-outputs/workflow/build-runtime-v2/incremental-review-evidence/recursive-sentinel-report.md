# 构建 v2 独立可重跑真实运行能力 probe 报告

> 生成：`server/scripts/probe-build-runtime.ts`（测试/证据切片，不改生产基建）。
> 真实链路：真实 pi + 真实 amagi（版本化安装）+ 真实子任务 MCP 桥；模型为本地 OpenAI 兼容 fixture——**明确不是实际 LLM 质量/性能证据**，仅用于驱动真实 Leader 派发与工具链路。

## 环境

- 时间：2026-11-01T15:55:32.132Z → 2026-11-01T15:55:52.332Z
- pi：`/Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`（1.4.0）
- amagi-pi 源：`/Users/run.mao/workpace/amagi-pi`（2.21.31，经 installAmagiPackage source 模式版本化物化）
- 临时根：/private/tmp/feishu-build-v2-incremental-review/fs-build-probe-mvy0hkf8-VyhbeZ（FEISHU_SYNC_HOME / HOME / PI_CODING_AGENT_DIR 全临时；未读生产资料）
- 结果：**pass 35 / fail 1 / unavailable 0 / not-measured 10**

## 检查项

| ID | 检查 | 状态 | 结论与证据 |
|---|---|---|---|
| preflight | 外部资源预检 | **pass** | pi 1.4.0 @ /Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js；amagi-pi 2.21.31 @ /Users/run.mao/workpace/amagi-pi（结构完整） |
| package-install | 版本化 amagi-pi 安装 | **pass** | installAmagiPackage(source) → /private/tmp/feishu-build-v2-incremental-review/fs-build-probe-mvy0hkf8-VyhbeZ/feishu-home/agent/runtime-packages/amagi-pi@2.21.31/package（hash fdd90b029725，3546 文件，fresh=true） |
| package-verify | 安装后哈希复核 | **pass** | verifyAmagiPackage hash=fdd90b029725（漂移即失败） |
| leader-start | 真实 Leader RPC 启动 | **pass** | session=build-b_mvy0hkfc_probe01-e1 pid=46682 agentDir=/private/tmp/feishu-build-v2-incremental-review/fs-build-probe-mvy0hkf8-VyhbeZ/feishu-home/agent/builds/b_mvy0hkfc_probe01/epochs/e1/home |
| static:pi-version | 静态/pi 版本 | **pass** | pi 1.4.0 在 >=1.4.0 <2.0.0 |
| static:amagi-package | 静态/amagi-pi 安装 | **pass** | amagi-pi@2.21.31 @ /private/tmp/feishu-build-v2-incremental-review/fs-build-probe-mvy0hkf8-VyhbeZ/feishu-home/agent/runtime-packages/amagi-pi@2.21.31/package（hash fdd90b029725，结构完整） |
| static:amagi-package-hash | 静态/amagi-pi 内容哈希 | **pass** | 哈希一致（3546 文件 / 83554 KiB） |
| static:model-key-mapping | 静态/模型密钥映射 | **pass** | provider zhipuai 在 amagi PROVIDER_KEY_MAP 内（密钥变量 ZHIPU_API_KEY；静态表源自 amagi-pi 源码，升版须重核） |
| static:model-key-present | 静态/模型密钥可用 | **pass** | 应用配置已提供 GLM 密钥（布尔核对，未取值） |
| static:spec-valid | 静态/运行规格 | **pass** | BuildRunSpec 校验通过（pools writer:1 reviewer:1） |
| static:thinking-level-map | 静态/思考档位映射 | **pass** | 全部模型档位映射已声明 |
| static:forbidden-roots | 静态/禁区根存在性 | **pass** | 原始库/标准库根可定位 |
| static:agent-dir-config | 静态/agentDir 配置 | **pass** | 四文件齐全且校验通过（spec 哈希 cc0e5adeec73） |
| static:workdir-clean | 静态/工作目录干净度 | **pass** | 工作目录无项目级 amagi.json/.mcp.json |
| static:extension-load | 静态/扩展加载 | **not-measured** | Leader 同时加载版本化 amagi-core 与应用转发扩展（-e 两项），无同名工具诊断；实际可调用工具与白名单一致；子进程加载同一安装目录的 amagi-pi |
| static:model-call | 静态/模型调用 | **not-measured** | 静态声明的 zhipuai 模型让 Leader 与子任务完成一次派发和工具调用；子进程环境只含所需密钥 |
| static:mcp-channel | 静态/MCP 通道 | **not-measured** | 子任务经 mcp_call 调用桥接工具；scope.mcp 显式列出的写入工具放行、未列出被拒；工具面无自动启用的 codemode/tool_search |
| static:identity | 静态/身份一致 | **not-measured** | 桥接读到的 AMAGI_TASK_ID/AMAGI_AGENT 与创建事件一致；两个并行子任务各自正确；续接链继承分配 |
| static:guard-effect | 静态/派发守卫生效 | **not-measured** | 守卫修改后的 scope 出现在冻结任务契约（v2-store spec）中；非构建角色与越界模型被阻止 |
| static:completion-notify | 静态/完成通知 | **not-measured** | 后台完成触发 Leader 新一轮，RPC 宿主正确处理自触发轮次；构建流程不依赖界面确认 |
| static:quota | 静态/配额 | **not-measured** | 子任务并发不超过各池容量之和，排队原因可见（amagi registry queueReason） |
| static:cancel | 静态/取消 | **not-measured** | 停止后无残留子进程（启动锚点/orphan 核对），旧凭据写入被拒绝 |
| static:recovery | 静态/恢复 | **not-measured** | 原会话续接后 amagi 对账正确，或成果级恢复可用 |
| static:prompt-injection-overhead | 静态/通用规则注入开销 | **not-measured** | 记录 Leader 输入 token 与偏离构建规则的次数（amagi L0 模板无开关，设计 §3.4） |
| leader-round1 | Leader 首轮完成 | **pass** | outcome=completed |
| cancel-leader-exit | 取消：Leader 终止 | **pass** | exit={"code":0,"signal":null}；Leader 已终止；全部已知个体已证明退出或排除归属 |
| cancel-no-residue | 取消：无残留进程 | **pass** | 取消后无相关进程（运行期 1 个全部退出） |
| old-gen-write-rejected | 旧代次写入被拒 | **pass** | status=401 error=run_token_invalid（预期 401：令牌已撤销/代次已轮换） |
| guard-freeze-scope | 派发守卫冻结 scope（v2-store 冻结契约） | **pass** | W1 契约：shell=deny、write=agent-outputs/**、mcp=13 项精确名单、deny 含原始库/配置面禁区、workspace=existing（原始敌意参数被守卫改写并冻结） |
| guard-block-illegal | 越界角色/模型派发被阻断 | **pass** | fuxi 阻断=true；越界模型阻断=true；首轮后冻结契约目录=3（预期 3，两个非法派发不得建任务） |
| child-tools-surface | 子任务真实工具面 | **pass** | 观测 4 个子任务请求：无 bash/advisor/lsp/codemode/tool_search/直连 mcp__*，含 read/write/mcp_call 等授权工具 |
| leader-tools-whitelist | Leader 工具白名单 | **pass** | 实际声明工具与冻结白名单一致（13 项，含 amagi 任务面） |
| leader-system-rules | Leader 冻结规则实际进入系统提示 | **pass** | 模型请求的 system 消息包含冻结规则 marker（不是仅用户首轮消息） |
| identity-uplink | 子任务身份上行（AMAGI_TASK_ID/AGENT） | **pass** | 桥接调用 9 次；未登记身份 0；角色不一致 0（身份来自真实子进程 env，经桥接头上行） |
| mcp-precise-authz | MCP 精确读/写授权 | **pass** | 只读 raw_list/raw_read=200；分配内写入(w1)=200；未分配写入(w2)=409；审查者正文写入被拒（amagi scope 层）；写作者审查工具被拒（amagi scope 层未授权名单拦截）；审查者只读 draft_list=200；续接写入=200 |
| codemode-facet | 子任务无 codemode/tool_search 面（设计 §3.3） | **pass** | 实际子任务请求面无禁用工具，强制codemode调用被拒；正常MCP通道另行验证 |
| p0-sentinel-deny | P0 敏感 sentinel 读取被拒（真实子进程） | **fail** | read 结果：[amagi 文件权限] read 目标在 deny 禁入区（deny 恒优先）：/private/tmp/feishu-build-v2-incremental-review/fs-build-probe-mvy0hkf8-VyhbeZ/fixtures/raw/sentine；grep 结果：raw/sentinel/secret-token.md:3: SENTINEL-SECRET-e19d0f4a：这行内容绝不允许出现在任何子任务输出或报告里。；哨兵内容泄漏=true |
| write-surface | 写面执法（配置面拒/报告面放行） | **pass** | amagi.json 写入：[amagi 文件权限] write 目标在 deny 禁入区（deny 恒优先，任何授予不得覆盖）（/private/tmp/feishu-build-v2-incremental-review/fs-build-probe-mvy0hk；agent-outputs 写入：Successfully wrote to agent-outputs/w1-report.md [amagi write] 实际落盘路径（本机 侧解析）：/private/tmp/feishu-build-v2-incremental-r |
| role-skill-load | 角色 skill 加载 | **pass** | 子任务系统提示含构建 skill（marker 命中）；用户目录技能残留=0 |
| same-package | 同版本包加载 | **pass** | settings.json 唯一包=与安装根一致；子进程工具面含 amagi_resource=true（amagi-core 已随包加载） |
| pool-cap-writer | 写作池容量=1 并发执法 | **pass** | w1=2026-11-01T15:55:38.423Z…2026-11-01T15:55:42.532Z；w2=2026-11-01T15:55:43.088Z…2026-11-01T15:55:45.641Z（串行） |
| pool-cross-parallel | 跨池并行（审查与写作重叠） | **pass** | 审查任务与写作任务区间重叠（独立池并行） |
| completion-self-round | 后台完成自触发新轮 | **pass** | 观测到 4 个自触发轮（事件：2026-11-01T15:55:41.097Z round self_1（后台完成通知自触发）；2026-11-01T15:55:42.688Z round self_2（后台完成通知自触发）；2026-11-01T15:55:45.806Z round self_3（后台完成通知自触发）；2026-11-01T15:55:48.860Z round self_4（后台完成通知自触发）） |
| resume-parent-chain | 续接父链与分配继承 | **pass** | actor 父链=true（bdba94dc←W1）；继承分配（supersedes）=true；v2-store 续接 spec 含父=true；续接写入=200,401 |
| ledger-generation-revoke | 代次轮换撤销全部身份 | **pass** | rotateGeneration(2) 后仍活跃身份=0（含全部 luban/diting/续接任务；旧代次写入已在 old-gen-write-rejected 验证） |
| fixture-disclaimer | fixture 模型声明 | **pass** | 模型为本地 OpenAI 兼容 fixture：仅驱动真实链路，不构成实际 LLM 质量/性能证据。 |

## 备注

- fixture 模型 ≠ 实际 LLM 质量/性能证据；本 probe 只证明运行能力与权限链路。

## 复跑

```bash
npx tsx scripts/probe-build-runtime.ts --piCli <pi 绝对路径> --sourceAmagi <amagi-pi 包根目录>
# 可选：--real-model（显式真实模型模式，需 ZHIPU_API_KEY 环境；不打印密钥）、--keep、--report <路径>
```
