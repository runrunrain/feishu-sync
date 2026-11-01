# 设计v2总验收矩阵（活文档）

状态：pending=尚待实现/验证；met=有可回源证据；partial=仅部分层验证；blocked=真实外部条件不足。模拟/fixture与真实模型运行分开记录。

| ID | 设计 | 验收行为 | 责任 | 状态/证据 |
|---|---|---|---|---|
| A01 | 3.1/13.1 | 专用home只声明固定版本amagi；Leader/子进程同包同hash；配置面禁读写 | R/E | pending |
| A02 | 3.2 | zhipuai静态模型；key仅env；未映射provider明确拒绝；无PI_*凭据 | R/I | pending |
| A03 | 3.3 | 子任务仅应用MCP，精确工具授权，readOnlyHint正确，无自动codemode/tool_search | R/T/E | pending |
| A04 | 3.4 | Leader实际白名单与激活集合一致，无应用同名task与正文/内置工具 | R/T/E | pending |
| A05 | 3.4 | tool_call改参实际进入冻结契约，越界角色/模型拒绝 | E/R | met（派发守卫边界）：918a4d13真实Pi+amagi v2-store冻结契约与越权模型/档位阻断通过；独立暂存快照重跑B2通过 |
| A06 | 3.5/6 | 唯一构建skill加载；Leader规则注入；自动行为显式冻结计数 | R/I | pending |
| A07 | 3.6 | 子任务仅amagi调度，模型池容量合计≤K，Leader只占应用一槽 | R/I | pending |
| A08 | 4.1 | 两并行任务env身份与RPC创建事件一致；pending只读；角色不一致拒绝 | T/I | pending |
| A09 | 4.2 | 唯一输出分配、冲突可见、转移先撤旧、续接继承并撤原ID | T/I | pending |
| A10 | 4.3 | 审查者不为作者或其续接链，绑定精确正文/对象/证据/来源/规则hash | T/I | pending |
| A11 | 4.4 | 同幂等键同载荷安全重放、异载荷拒绝；取消换代迟到写入拒绝 | T/I | pending |
| A12 | 5.1–5.3 | 原冻结/图片缓存复用；材料清单非目录装箱派发；交接可回读；审查局部失效 | I/T | pending |
| A13 | 5.4 | agent_end不等于结束；后台完成自触发轮次；一次空闲提示后二次leader_idle | R/I | pending |
| A14 | 5.4 | 精确候选revision锁定，未解决阻断/失效审查不可发布，复用原知识校验与原子指针 | T/I | pending |
| A15 | 7 | 局部编辑继承声明/稳定定位/变更集/结构化错误；批量读取预算游标截断 | T | pending |
| A16 | 8/9 | checkpoint保留成果/审查/分配/问题/游标/冻结版本，运行三轴与成果接受分离 | T/I | pending |
| A17 | 9 | 先撤凭据、关闭stdin、10s宽限、实际残留核对，无双Leader | R/I | pending |
| A18 | 9 | 会话恢复/成果级恢复明确区分，包升级不复用不兼容内部状态 | R/I/U | pending |
| A19 | 10/13.5 | Claude原生未经同契约实测拒绝；旧checkpoint缺字段走legacy，无静默fallback | I/U | pending |
| A20 | 12 | UI实际任务/排队原因/接受成果/问题/并发、当前计划语义，无虚构百分比/累计用量 | I/U | partial：fixture浏览器7场景/9截图，首轮拟定DTO不算后端接线；97e740f9继续适配 |
| A21 | 12/13.1 | 用量未知标unknown，轮次/自动行为/时延按来源区分，不重复计数父子token | R/I/U | pending |
| A22 | 13.2 | 临时FEISHU_SYNC_HOME真实Pi：1Leader+2并行作者+1独立审查+候选提交 | 集成验证 | pending |
| A23 | 13.3 | 同六源快照/模型/档位/32768/并发6/热图片缓存三次对照，中位≤20min（20样本后p95） | 集成验证 | pending；正式六源合法夹具与运行成本另核实 |
| A24 | 13.4 | 回执丢失、取消写入、迟到、Leader崩溃残留、包升级、分配转移、恢复、发布并发故障链 | 集成验证 | pending |
| A25 | 13.5 | 保守legacy默认；新模式失败保留候选日志；达到全部门槛前不切默认/不删旧调度 | I | pending |
| A26 | 项目约定 | 全量check/build，浏览器实际交互，无范围外/初始用户改动丢失，不提交 | Leader/U/Gate | 初始check在切Node ABI后通过；重构集成后待重跑 |

## 初始回归证据
- 初次check：lint/typecheck通过；better-sqlite3 ABI125 vs 当前Node137导致数据库测试失败（非重构回归），原输出 /tmp/feishu-build-v2-baseline/check.log。
- 按CLAUDE执行server npm rebuild better-sqlite3，exit0。
- 重新check全通过，服务端165 passed/1 skipped、2492 passed/4 skipped。原输出 /tmp/feishu-build-v2-baseline/check-node-abi.log。

## 独立风险Gate
完成集成测试后派diting full审核，重点A01/A03/A05/A08–A11/A14/A17/A18/A24，避免只测独立工具函数而漏掉真实调用链。
