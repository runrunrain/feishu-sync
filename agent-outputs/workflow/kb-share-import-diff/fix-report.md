# 共享包导入后待更新差异误报修复报告

## 输入与结论

- 上游调查：`agent-outputs/workflow/kb-share-import-diff/investigation.md`；独立审核：`agent-outputs/workflow/kb-share-import-diff/review-report.md` 和 `review-probe.mts`；项目约束：`CLAUDE.md`。
- 根因：旧 release 的 sourceSnapshot 缺少语义 digest，导入端也没有精确版本对应的 proof；头部同步时间导致 contentHash 不同后只能按原始字节判变。调查中为 117/119 条误报。
- 本次通过包外置 proof 迁移旧版本的语义基线；不修改 release manifest、release 文件清单或其哈希。proof 缺失且无法由精确原始字节补算时，回退字节比较；导入 proof 的可信边界见下文。

## 规格与落点

| 规格 | 实现及边界 |
|---|---|
| 导出 proof | `server/src/kb/portable-kb-service.ts` 使用 bundle schema 2 的根级 `source-comparison-v1.json`，元数据记载路径、大小和 sha256。键为 `JSON.stringify([objToken, contentHash, relPath])`；依次取 manifest 合法 digest、本机 proof 缓存中精确三元键的合法 digest（含已导入 proof），最后通过现有文件访问与语义哈希重新计算，仅精确 contentHash 相等才补算，异常/不匹配跳过。`server/src/routes/kb.ts` 传入 knowledgeBaseRoot 和 sheetCsvPaths。不得超过 8 MiB。 |
| 导入 proof | 先对附带文件执行有界流读取、长度及 sha256、JSON 对象和值格式和 manifest 三元键白名单校验，再安装 release；CURRENT 切换成功后 tmp+rename 合并 proof，保留本机原键及其值。合并异常仅 `console.warn`，已提交的导入不回滚。完整性 sha256 不是数字签名，不证明共享包发送者身份。 |
| 构建补齐 | `server/src/kb/source-comparison.ts` 新增对无 digest 的条目按精确 hash 取证的辅助函数；`server/src/kb/kb-build-service.ts` 在所选构建合并继承快照之后调用。普通 live 快照原本由 `capture:true` 补齐；所选增量的继承条目原会沿用旧条目而缺 digest。只有文件仍精确匹配才补齐，不可读、已变化或不支持的文件继续缺失。`versionedPublishedSources` 保留条目字段。 |
| 构建不变量 | `build-orchestration.ts` 的 `computeSnapshotHash` 只取 objToken、relPath、contentHash、mediaHash、whiteboardTextHash，不取 comparisonHash；证据资源绑定使用 entry.contentHash。未修改 readVerified、source_changed_during_build 或 contentHash。测试验证加 digest 不改变整体快照哈希。 |
| 状态口径 R3 | `server/src/routes/kb.ts` 删除 imported 的 pending=0 短路；状态与 changes 使用 `server/src/kb/kb-version-store.ts` 的共同 `sourceEntryChanged`，包含内容、路径、标题及白板旁路文字，并在 changes 中补齐白板文字 hash。旧短路位置没有说明产品限制；相关既有测试只断言零 pending，未有禁止导入后构建的理由；构建路由也未禁止已导入版本。文档详情仍按既有产品语义标记 packaged，未改。 |
| 测试 | `server/tests/portable-kb-service.test.ts`、`server/tests/kb-selected-build.test.ts`。原测试未删除或 skip，随新状态语义更新原测试桩与断言。 |

## 包与应用交叉兼容

| 包 | 应用 | 结果 |
|---|---|---|
| 旧 schema 1、无 proof | 新应用 | 按原方式导入；无 proof 时仍可能按字节比较。现有旧包导入测试通过。 |
| 新 schema 2、带 proof | 新应用 | 校验并安装；成功后合并 proof；附带文件不入 release。 |
| 旧 schema 1 | 旧应用 | 格式未改变，维持原有导入行为；本轮未启动旧应用实测。 |
| 新 schema 2 | 旧应用 | 旧 `openBundle` 对非 `bundle.json`/`release/` 条目先报「共享包含未知条目」，明确拒绝，不会误导入或改写 release；本结论是对旧版源代码的静态核对，未运行旧应用。 |

内部调用 `exportPortableKb` 没提供 `knowledgeBaseRoot` 时仍可生成 schema 1；桌面导出路由提供该参数。若源根为空，manifest 和缓存中已有 digest 仍可携带，但无法现场补算。proof 合并失败，或源在导出前已发生变化且无可用 digest 时，相应条目仍按旧逻辑比较，不保证消除误报。

## 信任边界（F1，Leader 已裁决接受）

独立审核 `review-report.md` 的 F1 及 `review-probe.mts` 证明：若发送方用接收端真实新正文的 digest 定向伪造旧版本三元键，并重算共享包内的 SHA，导入仍成功，status 和 changes 可被误导为零；合法 SHA、键与值格式只保证包内一致，不证明旧源字节与语义 digest 的绑定或发送者身份。同一 probe 中使用旧快照对已变化文件调用 `readVerified`，仍得到 `source_changed_during_build`。这是可被恶意发送方利用的已知风险，不宣称通过现有校验消除。

Leader 裁决按现有信任模型接受：导入共享包本来就信任发送方提供的整套标准库正文，附带 proof 与该 release 内容处于相同信任等级。proof 影响待更新预览和增量判等，可能隐藏真实待更新；它不替代构建期 `readVerified` 及发布前精确字节校验。导入、合并、消费处已注明该边界；本轮未新增 F1 验证代码或改变其校验机制。转分享复用缓存 proof 时也继承同一信任边界，接收方应确认整个转发链可信。

## 实际验证

以下命令均设置临时 `FEISHU_SYNC_HOME`，并设置 `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi`；没有读取真实 config、写入真实 `~/.feishu-sync`、rebuild 原生模块、提交或打包。

1. 主树根目录：`npm run typecheck`，退出 0，根前端、配置和 server TypeScript 均通过。
2. 主树根目录：`npm run lint`，退出 0，0 error、3 warnings：`src/components/NodeTreeView.tsx:319`、`src/hooks/useSessionAgentStatus.ts:21`、`src/hooks/useSyncStatus.ts:139`；均在本次写面之外，未改动。
3. 主树根目录：`npx vitest run src/components/kb`，退出 0，9 文件、64 测试通过。无前端代码修改，本轮未进行浏览器/Electron 真机交互。
4. 隔离工作树 `.amagi-worktrees/work-local-resources/server`：`npx vitest run tests/portable-kb-service.test.ts tests/kb-version.test.ts tests/kb-build.test.ts tests/kb-selected-build.test.ts tests/kb-whiteboard-text.test.ts --silent`，退出 0，5 文件、134 测试全部通过。测试前仅同步本任务 7 个代码/测试文件，并逐文件 `cmp` 成功；这 7 个路径在隔离树原先无未提交改动，且主树 HEAD `903f037` 与隔离树 HEAD `89b5ee6` 之间这些路径无提交差异，未同步并行线文件。主树 better-sqlite3 Electron ABI 未更改。
5. 端到端 fixture：自建两套源目录及 release，通过 Hono 的 `/api/kb/portable/export`、`/api/kb/portable/import`、`/api/kb/status`、`/api/kb/changes` 实际调用；两端仅 `fetch_date`/`last_synced_modify_time` 不同，两个入口均为 0；追加真实正文后均为 1。使用临时 fixture 与服务依赖替身，不接触真实飞书数据或跨机器 Electron 实例。
6. 附带文件测试：匹配条目生成 digest、不匹配跳过、已有 digest 在源不可用时沿用；原 release/包内 manifest 字节不变；错误 SHA、非 manifest 键、声明大小超限均拒绝并保持 CURRENT 未切换；旧包导入、保留本地已有条目及合并失败不撤销已成功导入均通过。
7. 增量构建测试：用真实构建/发布流水线、临时 SQLite 和模型工具替身创建 synthetic release，移除 fixture 旧 manifest 的 digest 模拟历史版本，再选择另一源增量构建；新 release 中继承且精确不变源含 `v1:` digest。与内容精确校验不匹配的继承源不补 digest 的辅助函数测试通过。
8. `git diff --check --` 本任务 7 文件：退出 0，无空白错误。

### 审核反馈修复轮验证

命令分别使用临时 `FEISHU_SYNC_HOME=$(mktemp -d /private/tmp/kb-forward-*.XXXXXX)` 与 `AMAGI_PI_SOURCE_DIR=/Users/run.mao/workpace/amagi-pi`：

1. 主树根目录 `npm run typecheck`：退出 0。`npm run lint`：退出 0，0 error、3 条原有范围外 hooks 警告（上文列明）。
2. 检查隔离树差异仅是本轮在 portable-kb-service、source-comparison、portable-kb-service 测试的改动；仅同步这 3 文件，然后逐一 `cmp` 原任务 7 文件，全部一致。未同步并行线文件或 rebuild better-sqlite3。
3. 隔离树 server 运行 `npx vitest run tests/portable-kb-service.test.ts tests/kb-version.test.ts tests/kb-build.test.ts tests/kb-selected-build.test.ts tests/kb-whiteboard-text.test.ts --silent`：退出 0，5 文件、136 测试全部通过。新增测试覆盖 manifest 优先、精确缓存键其次、排除无关键，以及 A→B→C 转分享：B 不重建且头部时间不同，C 的 changes 为 0；C 真实修改正文后为 1。测试使用临时文件及 Hono 路由，非真实设备。
4. 在同一隔离树 server、测试完成后运行 `./node_modules/.bin/tsx /Users/run.mao/workpace/feishu-sync/agent-outputs/workflow/kb-share-import-diff/review-probe.mts`：退出 0，`honest re-export from timestamp-only device` 的 proof 含精确三元键和 `v1:f42b3f602e3f470ff46a5a0ab9e9482222ad9435ab1204c715ded9a0b993089d`，不再为空。probe 的 F1 伪造场景仍可使 changes 为空、而旧快照 readVerified 抛 `source_changed_during_build`，与已接受信任边界一致。

## 面向用户的操作说明

两台设备都升级到包含此修复的版本后，在原导出设备**重新导出**共享包，再在另一台设备**重新导入**；导入已安装的相同 release 也会尝试合并新 proof。在整个共享包发送和转发链可信且 proof 可用时，待更新差异只应保留真实变化。旧包没有 proof，本修复不会凭另一台设备不同的原始字节凭空恢复历史 digest，因此单纯升级、继续使用已有旧包不保证自愈；若 release 本身已有 digest 或本地早已有有效 proof，则不需要补导入。导出端源已真实改变或不可读且没有已有精确键 proof 时对应项不能补证，仍可能显示为变化，应核实内容。已导入带 proof 的设备可在不重新构建的情况下再导出给第三台设备；接收者同样需要信任原始发送方及转发方。导入日志出现 proof 合并警告时版本仍导入成功，修复缓存后可重新导入新包。

## 未覆盖、风险与回滚

- 未用真实两台机器、真实账号或正式知识库验证；未运行旧版应用或全量 server 测试。旧版错误为静态代码证据。大规模 proof 和高并发导入未做性能/压力测试。
- 8 MiB proof 上限会使极大条目集合的导出明确失败；无签名的共享包仍应由用户自行确认来源。正常文件/证据校验不等于来源认证。
- 回滚本次修复应由授权人员局部撤销上表中的 7 个源码/测试文件的本次改动，不覆盖工作区其他并行改动；已有 schema 2 包在旧应用会被明确拒绝，回退后需由旧版重新导出 schema 1。已合并的 `.source-comparison-v1.json` 是本机缓存，回滚代码不会自动删除或改写它，是否清理应另行确认。
