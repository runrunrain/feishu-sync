# 单文档构建监控与定向改进

构建：`b_20261105092329_e8471c`。被观察应用为桌面0.3.51 / commit b2b1447；该构建未被重启、取消或人工改写。本轮成功发布后，确认无活跃构建及会话进程，已于10:32Z安装本报告补丁，版本保持0.3.51。

## 最终结果

- 2026-11-05T10:14:39.909Z 发布成功；总耗时 **51分10.260秒**。
- release：`r_20261105T101438_b67104`；10:27Z只读核对 `CURRENT.json` 正确指向本release。
- 新旧release均150篇；目标篇变化，其余**149篇逐字节一致**，没有新增或删除文档。
- 修订于10:10:22写入（约11.6分钟），复审10:11:33→10:13:09（约96秒），结论pass、1条suggestion。正文确有修改，因此旧审查失效并重新审查，符合约束。
- 发布保留1项证据结构警告和25项覆盖警告，没有迫使模型改写全库。首次最终发布因Leader尚未更新旧问题清单而被拒，更新清单后第二次成功；未绕过独立审查。

## 真实进展（UTC）

| 时间 | 观察 |
|---|---|
| 09:23:29 | 用户发起选定源重建；全量快照119源，实际工作集1源 |
| 09:24:30 | 图片处理完成：新描述3，缓存0，未理解0；约59.5秒窗口包含远端识图与承接缓存扫描，无法细分 |
| 09:25:15 | 首次派发被拒：staging草稿路径被当成本地必需输入；下一轮自行修正 |
| 09:25:43 | 作者获输出分配 |
| 09:43:28 | 写入证据选择了全空CSV单元格，被正确拒绝；按重试令牌局部修复，未重复发送正文 |
| 09:44:33 | 首稿成功写入，写作约18.8分钟；主要耗时为模型多轮长推理，未发现无活动挂死 |
| 09:46:16 | 独立审查开始 |
| 09:57:19 | 审查完成：2个blocking、3个suggestion（约11分钟） |
| 09:58:48 | 原作者会话续接定向修订 |
| 10:06:50 | 定向编辑引用不存在的coverage item，拒绝后纠正；没有半提交 |
| 10:10:22 | 修订写入成功，旧审查失效 |
| 10:13:09 | 定向复审pass（约96秒） |
| 10:13:23 | 阶段发布成功，目标篇进入正式库 |
| 10:14:05 | 最终发布因旧问题清单仍有2个blocking被拒 |
| 10:14:30 | Leader依据复审回执更新清单 |
| 10:14:39 | 第二次最终发布成功；收回写入凭据、回收构建子进程 |

首轮审查阻断为：字段表的证据范围漏掉前三行；正文草图计数与源表不符且证据列错位。这些属于真实质量问题，不应通过放宽门禁自动放行。提示建议与范围记账问题被标为suggestion，未一律升级成blocking。

## 本次代码改动

1. `server/src/agent/skills/knowledge-build/leader-protocol.md`：明确来源token/草稿路径是桥接资源，放任务正文，通过raw_read/draft_read读取，不作为本地文件契约参数。
2. `server/src/agent/skills/knowledge-build/reviewer-protocol.md`：schema查询限定审查角色可用工具，核验作者声明走draft_read，不查询写工具schema。
3. `server/src/agent/tool-specs.ts`：说明metadataOnly与声明筛选互斥；blocking问题必须带targetPath；问题清单读取仅用targetPath或空参数，不能凭listId/issueListId猜测参数。上述均为既有约束的说明补全，没有增加阻断门禁。
4. `server/src/kb/kb-build-service.ts`：图片开始日志不再被误读为已经命中缓存；完成后记录新描述/缓存/未理解/刷新失败数量及耗时；保留源图片缓存扫描单独计时。未改变扫描范围、缓存语义、写入或发布规则。
5. 两个测试文件补充说明契约与日志断言。

当前仍没有新旧真实模型对照，不能宣称这些补丁已缩短本轮耗时。不会为追求速度自动降低思考强度、修改用户模型配置、删除审查或伪造证据。

## 验证

- 已实现文件在主树与 `.amagi-worktrees/kb-gate-simplify` 逐字节同步，隔离树以Node24/ABI137运行测试；主树及已安装应用的Electron ABI125未重建。
- `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi npx vitest run tests/knowledge-skill-examples.test.ts tests/kb-build-parallel.test.ts tests/kb-build-resume.test.ts tests/build-runtime-e2e.test.ts --maxWorkers=1 --minWorkers=1`：**4文件，60测试通过，0跳过**。
- E2E为真实HTTP/Pi/amagi/桥接/发布链路，模型为本地fixture，不是生产模型质量或提速验证。
- server `npm run typecheck`、`npm run build` 通过；涉及TypeScript文件的ESLint与`git diff --check`通过。
- 没有前端改动；`npm run desktop:dist:mac:arm64` 打包成功（152.90秒），版本仍0.3.51。安装后健康检查、CLI、签名、Electron ABI125 SQLite内存查询通过。
- 新主进程PID14197；安装前后配置哈希和真实 `CURRENT.json` 哈希完全一致。外部Codex启动的只读MCP进程PID99853保留，不被当作桌面主进程误杀。
- 旧应用备份：`/Applications/Feishu Sync.backup-20261105T103225Z.app`；安装证据：`install-receipt.json`（base commit、工作树补丁哈希、签名及4个打包关键文件的逐字节核对）。未提交代码，版本文件没有变化；并行性能调查目录的既有修改保留不动。

## 证据与继续观察

- 初诊与纠错：`initial-diagnosis.md` v2。初版对59.5秒窗口的错误归因已撤回，采用修正版。
- 原始事件：`~/.feishu-sync/standard-kb/.builds/b_20261105092329_e8471c/events.jsonl`。
- 写入/审查/续接：该构建 `.staging/.../build-actors/events.jsonl` 与 `reviews.json`。
- 会话：`~/.feishu-sync/agent/builds/b_20261105092329_e8471c/epochs/e1/home/sessions/`。
- 每30秒只读监控：`/tmp/feishu-single-build-monitor.jsonl`（不含凭据与正文）；后台句柄 `bg-3e882119` 已在10:14:51Z捕获published后正常结束。
- 验证日志：`/tmp/kb-live-monitor-validation.log`、`/tmp/kb-live-monitor-typecheck.log`、`/tmp/kb-live-monitor-build.log`。
- 发布核验：`publish-verification.json`（无正文，仅路径、数量和指针）；对照确认为1篇改变、149篇不变。终态API的images/metrics为空值，不能据此声称未做识图或未审查；本报告以运行期采样与持久事件为准。
- 未覆盖：补丁安装后的真实模型耗时对照、不同来源/不同模型泛化。此次小补丁不解决大部分长推理时间；下一步应以质量不下降为条件，对比模型/思考强度与定向编辑路径，不盲目移除校验。不自动触发新生产构建以免产生额外模型费用。

## 总验收

| 项目 | 结算 |
|---|---|
| 真实构建监控至终态、保留可复核证据 | met |
| 工作集与发布范围保持单篇、其余149篇保全 | met |
| 定向修订与独立复审闭环、warning不强行全库返工 | met |
| 已证实工具使用摩擦补清说明、增加分段观测，测试和构建通过 | met |
| 安全安装、版本不变、配置和发布指针不变 | met |
| 新补丁真实提速与质量对照 | partial：需下一次用户测试，不能从说明改动推定收益 |
