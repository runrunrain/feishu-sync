# 知识库检索与 MCP 交付验收

结论：可达实现与本机交付验收完成。全量检查、独立重包、新版真实 Electron 和唯一增量安全终审均通过，无未关闭代码 finding。交付为本机 ad-hoc 成品，不是全部外部验收通过或公开发行批准；真实质量/异机等 partial 项如下。

## 交付入口

- 源码仓库：`/Users/run.mao/workpace/feishu-sync`
- 使用说明：`docs/agent-knowledge.md`、`docs/kb-lan-mcp.md`、`docs/kb-evaluation.md`
- 本机 arm64 安装包（真实GUI/介质均已验证）：`dist-desktop/darwin-arm64/FeishuSync-0.3.50-arm64.dmg` 与 `.zip`
- 完整 App：`dist-desktop/darwin-arm64/mac-arm64/Feishu Sync.app`
- 独立产物：`server/dist/mcp/kb-mcp.cjs`（stdio）、`kb-mcp-gateway.cjs`（由应用管理的内网 HTTP 子进程）
- 活计划：`workflow.md`；证据以各报告最新续接段为准，早期 blocked/mock 段保留为历史。

## 分阶段变更

| 阶段 | 提交 / 状态 | 交付 |
|---|---|---|
| A | `8fba395` | 多词与raw排序修复、L0保全、E0评测CLI/合成fixture |
| B | `060c02f` | lex-v1共用索引/查询服务、七工具MCP、内置section/grep与真实三端入口 |
| C | `c2aca8d` | 独立内网网关、安全管理与设置卡、真实客户端兼容修复、审计/恢复/容量验证 |
| D | 本文件所属最终提交（`git log -1 -- 本文件`） | 全量回归、实际Discuss/Pi转发链、独立staging安装包与Electron验证、交付资料 |

## 设计追溯矩阵

| 设计项 | 实现 / 证据 | 当前验收 |
|---|---|---|
| P0 F1/F2 | 产品L1多词/短语/ID、raw全量评分排序；64项阶段A集成、合成Q2 0→1 | met（真实质量另列） |
| E0 评测工具 | pinned release与来源校验、Recall/SectionHit/MRR/nDCG/grep、逐组逐条报告、L0/L1/真实lex适配、10/30MiB固定种子 | met（80条真实输入缺失） |
| P1 lex-v1 | NFKC/围栏分段/词表与bigram回退/BM25F/覆盖率共现/表头片段；同一rank core | met |
| P1 索引与发布纪律 | hash含附件、realpath围栏、缺失篡改剔除/报错、两版LRU/Promise去重、分片让出、CURRENT后异步预热，无发布格式迁移 | met；B独立终审PASS |
| P1 三端一致与性能 | 真实Hono、能力入口、Node20/24 SDK；越预算UI取满top-k、内置cursor续页；10/30MiB预算达标 | met（真实语料性能另列） |
| P2 七工具 | search/grep/outline/get/bundle/list/release_info、只读注解、紧凑JSON/资料帧、行号/anchor、预算/游标/版本告知、完整错误路径 | met |
| P2 客户端实用性 | 真实pi/Claude stdio+HTTP、Bearer正反、Claude七工具/原缺三个工具实际调用；pi中文页安全预算；见client-compatibility-report | met（本机真实客户端+合成推理服务，不是实际LLM效果） |
| P3 内置工具 | kb_search pathPrefix/hits/cursor、kb_read section与0基分页、literal-only kb_grep；spec/能力面/模式白名单同步；真实Pi会话→转发扩展→内部HTTP三工具捕获通过 | met；仅推理使用合成fixture，不冒充LLM效果 |
| P5 传输与一致性 | 独立端口子进程、共享服务/index、会话IP/TTL/上限/公平限流、各会话notice、JSON HTTP/GET405/64KB | met |
| P5 安全与管理面 | 默认关、socket私网CIDR子集、拒Origin、摘要Bearer/三域隔离、desktop-only管理、CLI/app_command/通用config禁改、秘密权限原子写 | met；两种启动日志已修、实际进程凭据未检出；增量安全终审d5338094 PASS |
| P5 生命周期/审计 | 正常退出回收、轮换停旧、心跳/漂移/退避/网卡恢复、元数据审计轮转与indexBuildMs | met（实际睡眠/24h另列） |
| P5 压测/看门狗 | 10/30MiB单机回环单/3×4，busy=0；生产默认恶性regex恢复13029.46ms≤15s | met（异机/完整Electron负载另列） |
| P5 UI | 真实浏览器启停/轮换/reveal/审计/冲突/保留与撤销；回环.local与故障地址增量；完整Electron补验 | met：新包四类系统剪贴板私有回验、权限边界、日志、blur、CIDR与回收PASS；原CIDR FAIL撤回 |
| 构建与本机成品 | 独立staging arm64 app/dmg/zip，codesign通过、包内SQLite ABI125和MCP真查询通过，主树ABI137/hash未变 | met：最终481源digest与包一致，签名/介质/ABI/真实GUI通过；增量安全终审PASS |
| P4 aliases | 必须真实Q5门槛触发，当前无真实发布/qrel | gated，未触发实施，不用合成Q5冒充依据 |
| X 持久化索引 | 真实50MB/冷启动/搜索/7日容量条件未观察；合成预算已达标 | gated，保留设计预案，不增发布格式 |
| P5b TLS | v1设计明确可信内网HTTP+Bearer；无新增合规/不可信网络需求 | gated，未实施 |

## 已确认的验证事实

### D1–D15 决策逐项

| 决策 | 对齐结论 |
|---|---|
| D1 纯词法+agent循环 | met：无查询期模型/向量/rerank，读工具有界供agent自适应；真实12问效果另列 |
| D2 lex-v1 | met：段级BM25F、精确单元→词表→CJK回退、覆盖率/共现、纯rank core |
| D3 读者侧内存索引 | met：按release/hash惰性缓存与后台预热；无发布格式/SQLite迁移 |
| D4 共用引擎 | met：HTTP、能力工具、stdio/LAN均经KbQueryService；正式入口比对 |
| D5 七工具 | met：旧四名保留，新增grep/outline/bundle；真实客户端七工具可用；常驻token预算与真实LLM另列 |
| D6 返回形态 | met：紧凑JSON/编号资料帧、anchor、预算/next；pi会话额外≤6000字符避字节截断 |
| D7 版本策略 | met：每调用单release，默认跟随CURRENT、显式锚定、独立会话notice |
| D8 语义层门控 | gated：无真实Q5，不用合成低分擅启aliases或其他语义栈 |
| D9 评测先行 | partial：工具/合成fixture/L0-L1基线在切换前具备；80条真实输入和绝对阈值冻结未完成 |
| D10 分期 | adapted：A=P0/E0、B=P1/P2/P3原子可构建提交、C=P5、D交付；B不能按P1/P2/P3三个独立commit撤回，已记录此兼容性取舍 |
| D11 子进程HTTP | met：独立固定端口、JSON会话/GET405、主监听仍回环，无主API公开挂载 |
| D12 kb-lan认证 | met：三域隔离/秘密存储/desktop-only管理、日志白名单已验证；新Electron与standalone日志对本次实际凭据比较均未检出 |
| D13 网络暴露 | met：默认关/私网/Origin/警告等已验证；CIDR省略默认真实PUT→200→文件→GET成功，原错误清空操作未触发React/无请求已澄清；HTTP剩余风险保留 |
| D14 多客户端 | met（本机机制）：共享一份index、notice会话化、4/2/32队列、regex独占与父watchdog；异机/睡眠另列 |
| D15 共用注册与并行 | met：registerKbTools唯一注册，P5开发沿冻结引擎契约并行，最终直接获得v2七工具 |

### §10.4 与 §13.10 严格验收边界

| 项 | 已做 | 未做 / 当前结论 |
|---|---|---|
| §10.4 | 真实Claude/pi客户端+合成推理fixture实际工具循环、锚点/release/分页与响应捕获 | 12条真实Q2/Q5/Q6、人工判分、v1对照及目标模型常驻token实测未做；不能以fixture usage值代替 |
| A1 | 真实管理API→独立进程安全矩阵、令牌负例/Origin/CIDR、轮换/停用与命令禁改；本机loopback | met（本机）；legacy日志已修并由真实进程私有比对，第二设备另列 |
| A2 | 正式HTTP/stdio/能力/LAN三端逐字节同版、双会话独立notice | met |
| A3 | crash/熔断/漂移机制、默认ReDoS实际13.03s恢复、GUI真实child超时回收 | partial：真实系统睡眠/唤醒和24h未做 |
| A4 | 10/30MiB本机回环单/3×4性能与Node父event-loop样本达标 | partial：第二设备、有线/Wi-Fi、Electron父压测p99增量尚未证实 |
| A5 | 本机真实pi/Claude挂载、Bearer正反、pi8k/15k每页完整、Claude15k/25k/40k正文 | partial：非异机/真实LLM12问；fixture不冒充人工质量 |
| A6 | 完整实际Electron绝大多数状态/blur/loading/退出已通过且截图实读 | met：最终新包四类复制/权限/日志/blur/CIDR/回收全部PASS，已抽看运行/停用截图 |
| A7 | Node20/24、打包Electron RunAsNode、两CJS实际tools/call、无native静态引用、签名/介质 | met：最终新包重验通过，CJS字节与已验证客户端版本相同 |
| A8 | 最终实际Electron动态主端口；系统Node执行正式standalone入口，在显式49614启用网关/七工具/查询/作废/回收通过 | partial（严格端口/环境）：3001有foreign watcher未碰；NODE_ENV=test跳过自动安装，不声称默认环境完全等价 |

- 阶段B初验157项、修复相关49项；独立首审F1分页/F2含#路径均关闭，终审PASS。
- 最终源 `npm run check && npm run build:all && npm run electron:build` 退出0（bg-a85e675f）：lint0error/3既有warning、根/配置/server typecheck通过；前端66文件427项通过；server138通过/1skip文件，1981通过/8skip项。新增打包helpers后的全量lint再次退出0，未重复全量测试。
- C build+9文件89项；MCP兼容增量4文件26项；真实CLI修复后逐页/正文比对通过；C独立full审核PASS。真机随后揭示两项真实缺陷后已修复，最终真实Electron c00dda65通过，唯一增量安全终审d5338094 PASS、无finding（另独立跑7文件51项）。
- E0合成12条：lex Recall/MRR0.9167、SectionHit0.8333、Q4 grep1；这不是80条真实评测。
- 10/30MiB共享索引：准备131.89/377.96ms，search p95 3.89/7.95ms，排空literal grep p95 62.23/486.58ms，heap21.71/63.51MiB。
- 网关10/30MiB单客户端p95 3.87/8.01ms、3×4 p95 28.00/52.97ms，busy/errors0；都是单机回环短样本。
- 最终 DMG 86,980,239B，SHA256 `6d1d4cc639280d01df602ebc87d9462cb3226f3e771ee65d23b012f1a2cd348c`；ZIP 100,297,633B，SHA256 `6d9d16b8f39cc5b52a52816f651fbfc0666720e2b6dbc402c9f1a6d3a5e99b9a`。
- 最终481源清单SHA256 `885c1582db06618660e9d1e092d34b8931579366c470b3e4efe861e548b91f3b`；app规范化清单 `c1735035bf972c3211eb26920bb92f15f1886a9abb3bbd5b84efd2abfd33e7bb`。主树/包内ABI137/125各自可用且主树native hash未变。

## 外部条件与明确未完成项

1. 本机没有真实已发布标准库、历史查询为0；真实80条用户/人工qrel、真实质量门槛冻结与12问人工正确性未完成。工具、合成单测和fixture推理不替代这些输入；未向生产目录写发布、未复制生产正文进Git。
2. 无第二台设备：异机Claude/pi、真实网络延迟/防火墙/.local解析、真实多人流量周度指标未测。
3. 真实系统睡眠、24h长跑、Windows实机未测；已完成的是机制/注入漂移和本机默认看门狗。
4. 实际远端LLM效果未测；真实Discuss与客户端工具链用本地合成推理fixture，准确标注。
5. 本机安装包为ad-hoc本地构建，不是Developer ID签名/Apple公证的公开发行版；未向Applications覆盖安装，未验证Gatekeeper默认放行，未上传或push。
6. 严格默认standalone:3001因foreign watcher占用未测，未连接/停止它；用官方FEISHU_SYNC_PORT覆盖后的真实模式已测。Electron父进程压测p99增量、目标模型常驻token与可选stdio设置页原生复制未单独实测（共享helper/单测和本轮四复制已验证）。

## 自主决策与回滚

- 用户指定设计作为方向基线，不另造向量/SQLite/RAG栈；P4/X/P5b按真实触发条件，不越门控。
- 默认角色模型注册失败期间曾临时覆盖，用户要求后立即删除；用户修复模型目录后全部后续派发/续接按默认模型，临时编排配置不进Git。
- 真实客户端证据驱动修正Claude schema与pi字节预算；内置grep收窄literal保护Electron；未扩写权限或公开暴露。
- 构建在独立staging重建native，保留开发Node ABI。测试/打包命令只指向owned合成目录，不主动操作真实资料/凭据或网络/防火墙/全局客户端配置；foreign watcher保持不动。
- 运行回滚先停用内网共享；源码阶段可独立revert，无DB/发布格式迁移。保留用户原有未跟踪复盘文档，不混入提交。
- 旧版本曾把desktop凭据写入启动日志；本任务发现的临时实例已退出、令牌失效、日志脱敏。安装新版后请正常重启既有应用/standalone以换新desktop凭据，勿分享旧原始日志；foreign :3001实例没有由本任务擅自停止或读取其日志。
