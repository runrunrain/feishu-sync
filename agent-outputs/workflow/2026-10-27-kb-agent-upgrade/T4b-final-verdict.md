# T4b 终裁（quick）：批 C 修复核验与 Phase 4 收口

**Phase 4 收口 VERDICT: PASS。** 原 01–10 全部关闭：01–05、09–10 沿用上轮 PASS；本轮独立重放确认 F06/F07 闭合，F08 接受为组件级交互证据。没有新增 finding。此裁决仅覆盖任务指定的 T4b 原十项及批 C 直接相关集成链，不代表真飞书、真机 UI 或整个共享树生产发布认证。

## 输入与基线

必读且已完整读取：
- `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/T4b-recheck.md`（上轮 7/10 PASS；含原独立反例主体）。
- `agent-outputs/workflow/2026-10-27-kb-agent-upgrade/T4b-fixC-report.md`（批 C 变更与自验）。

cwd：`/Users/run.mao/workpace/feishu-sync`；实际 `git rev-parse HEAD`：`6295b27d6642cfa3c4d611d7af6d8de7712a58f2`。已取 status/diff stat：共享未提交树，68 个 tracked 文件变化，另有 untracked 新服务/测试等；publication-service 本身为 untracked，不能把 HEAD diff 当作批 C 独立补丁。按当前源码、原反例与正式回归审核，不归责其他并行改动。

Leader 提供的 server 1698、前端 351、typecheck 全绿为上游基线；本轮未重复 server 全量，实际复核批 C 的 server 62+188、前端全量 351 与三段 typecheck，全部通过。

## F06：PASS（原 Major 关闭）

**定位**：`server/src/kb/publication-service.ts:896,922,928,959`；`:1224-1235,1272`；`:1398-1411`。

- `overwriteIssued` 在 revision 只读获取之后、实际 overwrite 调用之前置位。写后 `parse`/`incomplete_response`/`timeout` 经 `classifyOverwriteError` 归 unknown；写前 revision parse 不误入写后分类。
- 第一遍 create/update 非确认成功的结果进入 `firstPassUnresolved`，第二遍在调用 runUpdate 前排除。计划级 blocked 不进入第二遍候选；安全 skip 与成功项仍可按互链变化回写。
- **独立原反例 A 重放**：B 已发布→release 改正文→替身先接受 overwrite 再抛 parse→state、push_log outcome 均为 unknown；再次普通 PUBLISH 不重发，overwrite attempts=1（旧反例为 failed/2）。
- **独立原反例 B 重放**：A 已发布且引用新 B→新 release 改 A 并创建 B→A overwrite timeout→同批第二遍不再覆盖 A，attempts=1、secondPass=0、A 保持 unknown（旧反例为 2/1）。
- 正式 `server/tests/kb-publication-fixC.test.ts` 第 1–3 例通过：另核对普通重发明确 blocked(state_unknown)、A 只一条 unknown 结果、写前 revision parse 为 failed 且 overwrite=0。
- `incomplete_response` 的 overwrite 分支本轮仅静态确认，与 parse/timeout 同一条件；未单列动态注入，不夸称已实测所有错误码。

## F07：PASS（原 Major 关闭）

**定位**：`publication-service.ts:1063-1070`；`server/src/modules/local-map-store.ts:3555-3570`。

- `archivedTokens` 无条件从 warningsJson 提取 previousCloudTokens，再可选追加 current token；current token 为空不再清掉既有谱系。排除 provider 汇总当前 token 与谱系。
- **独立多次 force 反例重放**：发布旧 A→置 unknown→force create 抛 parse、current token 清空→首次失败后 A 仍在排除集→恢复 create 再 force 成功→A 与新 token 同时在排除集。旧 A 不再退出防自我喂养集合。
- 正式 fixC 第 4 例通过，并断言中间态 cloudToken=null、state=unknown，以及成功行 warningsJson.previousCloudTokens 含 A；没有只断言当前 token。

## F08：PASS（组件级交互证据闭合）

**定位**：`src/components/SourceEditControls.mount.test.tsx` 两例；实际 handler `SourceEditControls.tsx:343-353,517-525,589-596`。

完整读取测试并实际运行：使用 jsdom、React createRoot 真挂载 `SourceEditControls`，通过 DOM button.click() 依次触发「写回飞书」与「对比云端与本地」，不是直接调用导出 helper。Toast 被隔离；fetch 为明确 fixture 替身，client.request 与组件 handler 未被替换。

- 成功链断言 POST push/preview，再恰一次 GET `/api/sources/doxcnT1/history-content`（不含 revisionId），弹窗 DOM 同时出现云端与本地正文及标签。
- 502 失败链断言不可读提示、原错误码/消息、打开飞书核对引导，并保留本地正文。
- 两例通过；锚点阻断按钮走动态点击，冲突按钮共用同一 handler 的接线由静态确认。本轮没有动态制造真实云端冲突。

按本任务验收裁定，接受为**组件级交互证据**，不等同真实服务端/飞书响应、浏览器布局或 Electron 实机走查；后者进入下方主上环境清单，不阻塞本轮收口。

## 原 01–10 总结论

| 原编号 | 终裁 | 本轮依据 |
|---|---|---|
| 01 并发发布准入 | PASS（保持关闭） | 上轮独立重放 PASS；fixA 正式 18 例整体复跑通过 |
| 02 每次 overwrite 云端时间门 | PASS（保持关闭） | 上轮 PASS；publication/fixA 回归通过 |
| 03 配置发布根双向校验 | PASS（保持关闭） | 上轮真实 ConfigManager/Hono 入口证据；fixA 回归通过 |
| 04 写前历史锚点与日志 | PASS（保持关闭） | 上轮 PASS；publication/fixA 回归通过 |
| 05 unknown 移出围栏 | PASS（保持关闭） | 上轮 PASS；cloud-move/edit/push/history 回归通过 |
| 06 写后未知与同批重发 | **PASS（本轮关闭）** | 两个原反例独立重放 + fixC 第 1–3 例 |
| 07 多次 force 谱系保全 | **PASS（本轮关闭）** | 原多次 force 反例独立重放 + fixC 第 4 例 |
| 08 云端对比消费链证据 | **PASS（本轮关闭）** | createRoot + DOM 点击，成功/失败两例；按约定接受组件级 |
| 09 anchorExact 秒级口径 | PASS（保持关闭） | 上轮 PASS；cloud-history 59 例回归通过 |
| 10 关键状态落盘失败围栏 | PASS（保持关闭） | 上轮 PASS；history/move 回归通过 |

增量原则：未重审上轮未改且与批 C 无因果关系的模块，不把继承证据描述为本轮独立重放。未见本轮修复引入回归。

## 本轮命令与证据账本

全部命令真实执行，退出码均为 0。

| cwd | 命令 | 关键结果 |
|---|---|---|
| 根 | `git rev-parse HEAD && git status --short && git diff HEAD --stat` | 取得上述共享树基线；不修改现场 |
| server | `npx vitest run tests/kb-publication.test.ts tests/kb-publication-fixA.test.ts tests/kb-publication-fixC.test.ts --silent` | 3 files / **62 passed**（40+18+4） |
| 根 | `python3 /tmp/t4b-final-replay.py` | 1 file / **3 passed**，原反例改安全断言；临时目录 finally 删除 |
| server | `npx vitest run tests/cloud-history.test.ts tests/cloud-move.test.ts tests/source-push.test.ts tests/source-edit.test.ts --silent` | 4 files / **188 passed**（59+42+64+23） |
| 根 | `npx vitest run src/components/SourceEditControls.mount.test.tsx src/components/SourceEditControls.test.tsx src/components/source-history/CloudDiffModal.test.tsx --silent && npm run typecheck` | 3 files / **19 passed**；src、配置、server 三段 tsc 通过 |
| 根 | `npm test -- --silent` | 前端全量 **41 files / 351 passed** |
| 根 | `git diff HEAD -- package.json && rm /tmp/t4b-final-replay.py` | 确认 jsdom 仅新增 devDependency；本轮临时 Python 已删除 |

### 独立重放的可复核方法

临时脚本 `/tmp/t4b-final-replay.py` 已依任务要求删除；没有写项目测试。重建方式：
1. 从 `T4b-recheck.md` 附录提取 `describe('T4b independent residuals'...)` 三个测试；fixture 前缀取 `server/tests/kb-publication-fixA.test.ts` 首个 `describe('T4b-01` 之前内容，将 ../src import 指向当前绝对源码路径。
2. 保留触发和服务调用，仅将原不安全断言转换为安全预期：parse 的 state/push_log failed→unknown；两个 attempts 2→1；secondPass 1→0；末次 force 后 not.toContain(A)→toContain(A)，另断言包含成功后的当前 token。
3. 在 /tmp 独立目录链接 server/node_modules，以临时 Vitest config 指向原 server/tests/global-setup.ts（隔离 FEISHU_SYNC_HOME），用当前 Vitest 运行；finally 删除临时目录与 fixture。测试名沿用原反例旧标题，实际断言已按本节转换，不能从旧标题推导仍有不安全行为。

证据等级：当前真实 publication 服务 + 临时 SQLite 动态验证；远端均为注明的 lark stub，无实际云写或凭据操作。前端为真实组件 + 请求 fixture，不冒称端到端联调。

## 主上环境清单与剩余边界（不阻塞本轮）

- 浏览器/Electron：打开有本地编辑的源文档→写回预览→锚点阻断或云端冲突→点击对比→检查当前云端/本地两栏正文、滚动与实际布局；再验证真实读取失败时的错误原因和本地单侧保留。未做真机/视觉裁定。
- 移出 S5 与既有 C-1～C-5 的实际 CLI 参数/输出/权限契约仍按上轮报告保留，不能拿 stub 全绿宣称生产可用；未重开为本轮新 finding。
- 未运行 server 1698 全量、桌面构建/打包、生产资料迁移、真实飞书写入；未复跑 lint。server 全量仅引用 Leader 基线，本轮相关 250 例与前端全量、typecheck 有独立复验。
- 唯一持久写入为本报告；业务代码与正式测试零修改，未 commit/stash/restore/reset。回滚本轮产物只移除此报告，不采用上游批 C 报告中可能覆盖共享现场的 checkout 回滚指令。

**VERDICT: PASS（T4b 原十项、批 C 修复及任务声明的集成抽查范围）。**
