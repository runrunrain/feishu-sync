# T4b 修复批 C 报告（F06/F07/F08 三项收口）

按 `T4b-recheck.md` 剩余 finding 修复，供 diting 终裁。反例固化一律为安全行为断言（修复后预期），非反例行为。cwd `/Users/run.mao/workpace/feishu-sync`（共享未提交树，本轮 `git rev-parse HEAD` 同复审基线）。

## 1. F06 发布 overwrite 写后未知分类与第二遍重发 → 已闭合

**修复位置**（`server/src/kb/publication-service.ts`）：

- **写后未知分类**：`:1224` `overwriteIssued` 标记（置位点 `:1234`，紧贴 `overwriteDocument` 调用前）；`:1272` catch 按 `overwriteIssued` 分流；新增 `:1392-1414` `classifyOverwriteError`——命令已发出后的 `timeout`/`parse`/`incomplete_response` → unknown（与 create `classifyCreateError`/revert/move 同口径），其余回落 `classifyError`（404/权限 → cloud_missing/failed）。**写前只读失败不进该分类**：`fetchDocumentRevision`（`:1225`）抛 parse 时 `overwriteIssued=false`，仍 failed 可重试——满足复审「不能笼统把只读失败改成未知」的约束；回读 `parseDocumentProfile` 失败本就在 `verifyPublished` 内部捕获为警告，不经 catch。
- **同批第二遍准入**：`:892-896` `firstPassUnresolved` 排除集；`:922/:928` 第一遍 create/update 未确认成功（非 created/updated，含 unknown/failed/blocked/cloud_missing）记入；`:956-959` 第二遍互链回写跳过排除集内文档（每文档单次尝试语义）。
- 模块头不变量 `:25-29` 同步补记。

**测试锚点**（`server/tests/kb-publication-fixC.test.ts`，新增 4 例）：

1. 「overwrite 已发出后响应 parse 不可判定 → unknown；普通重发被 state_unknown 阻断（attempts=1）」——复刻 `t4b-replay-review` F06 触发 A（替身先真实写入 createdDocs 再抛 parse，meta 保持原秒值过时间门）：outcome/state=unknown，`listSourcePushLogs(token)[0].outcome='unknown'`（原为 failed）；再次普通 PUBLISH → `blocked(state_unknown)`，attempts 保持 1。
2. 「overwrite timeout → unknown 且同批第二遍互链回写零重发」——复刻 `t4b-secondpass-timeout` 触发 B（仅发布 A → rel-002 改 A 正文+新增 B → A overwrite timeout、B 创建成功）：`attempts=1`、`counts.secondPass=0`（原反例 attempts=2/secondPass=1）、A 仅一条 `['unknown']` 结果（无第二遍重复条目）、终态 unknown。
3. 「写前只读失败（fetchRevision 抛 parse）仍 failed」——反向锚定：outcome/state=failed、push_log outcome=failed、`overwrite` 调用 0 次（覆盖命令从未发出）。
4. （F07，见下）

## 2. F07 空 current token 丢谱系 → 已闭合

**修复位置**：`publication-service.ts:1050-1070` `archivedTokens`——`previousCloudTokens` 谱系无条件从 `warnings_json` 带过，当前 `cloud_token` 仅作可选追加（原实现 `row.cloudToken` 为空时整段丢弃 `parsed.previousCloudTokens`）；空谱系不写字段（首次发布行为不变）。

**测试锚点**（fixC 第 4 例「force 重建失败→再次重建的谱系持久化」）：A 发布 → 行置 unknown → 第一次 force（create 抛 parse）→ 行 unknown 且 `cloudToken=null`（空 current token 分支前置成立，provider 仍含 A）→ 第二次 force 成功 → `listPublishedCloudTokens()` **同时含旧 A 与新 B**、新行 `warningsJson.previousCloudTokens` 含 A（原反例：第二次 force 后仅 B，A 退出排除集）。

## 3. F08 组件挂载级测试 → 已闭合（jsdom 层）

**新增** `src/components/SourceEditControls.mount.test.tsx`（`@vitest-environment jsdom`，createRoot 真挂载，2 例）：

- **成功链**：挂载 → jsdom `element.click()` 依次触发「写回飞书」（真实 POST `/push/preview`，method 断言）→ 计划 blocked(rollback_anchor_unavailable) →「对比云端与本地」→ 断言 fetch 调用恰一次且 **URL 为 `/api/sources/doxcnT1/history-content`、不含 revisionId**（缺省=云端当前正文）；弹窗 DOM 回填渲染：两侧 label（云端当前正文/本地当前正文）+ 云端拉取正文行 + 本地正文行（行级差异态）。
- **真实失败降级链**：history-content 返回 502 → 弹窗「云端正文暂不可读」+ 如实展示 `history_content_unavailable`/`upstream boom`/「打开飞书文档核对」+ 本地侧单侧预览保留。
- 与既有 `SourceEditControls.test.tsx`（SSR + `buildCloudDiffContext` helper 锚定）互补：本文件走的是**组件按钮 → handler → helper → client.request → fetch** 的完整挂载链，非函数直调。
- **如实标注**：jsdom `element.click()` 是 DOM 事件派发，不等同真机浏览器/Electron 的实际点击与视觉走查；后者仍留主上环境清单（打开应用 → 源文档预览 → 写回飞书 → 锚点阻断弹窗 → 对比云端与本地 → 人工核对两栏渲染；以及 502 降级态文案）。本轮未做浏览器/Electron 实机验证，不冒充。

## 测试与自验（真实入口）

| cwd | 命令 | 结果 |
|---|---|---|
| server/ | `npx vitest run tests/kb-publication.test.ts tests/kb-publication-fixA.test.ts tests/kb-publication-fixC.test.ts` | **3 files / 62 passed**（既有 58 零回归 + 新增 4） |
| server/ | `npx vitest run tests/cloud-history.test.ts tests/cloud-move.test.ts tests/source-push.test.ts tests/source-edit.test.ts` | **4 files / 188 passed**（批 B 相关链零回归） |
| 根 | `npm test`（前端全量） | **41 files / 351 passed**（既有 349 + 新增挂载 2） |
| 根 | `npm run typecheck`（root src + 配置 + server 三段） | exit 0 |
| 根 | `npm run lint` | 0 error（3 条 warning 为本轮未触碰文件的既有项） |

注：一次 `npx vitest run "tests/kb-publication*.test.ts"` 因引号 glob 未展开实际漏跑 publication 三文件（vitest 按 regex 过滤匹配 0），已用显式文件名重跑补齐上表口径；该次输出不计为验证。

## 变更文件与回滚

- `server/src/kb/publication-service.ts`（F06 分类/第二遍准入 + F07 archivedTokens + 模块头注释）
- `server/tests/kb-publication-fixC.test.ts`（新增）
- `src/components/SourceEditControls.mount.test.tsx`（新增）
- `package.json` / `package-lock.json`：devDependencies 新增 `jsdom ^30.1.3`（仅测试环境依赖）。安装过程注记：官方 registry 经本地代理（127.0.0.1:18890）挂起 7 分钟无进展，改用 npmmirror 完成安装后已把 lock 内 38 个镜像 URL 统一归一回 `registry.npmjs.org`（版本与 integrity 不变，JSON 校验通过）；npm 11 输出的 install-scripts blocked 警告涉及 esbuild/fsevents 等**已装包的重复提示**，vitest/transform 实测正常。
- 回滚：`git checkout -- server/src/kb/publication-service.ts package.json package-lock.json` + 删除两个新增测试文件（共享树上另有他人未提交改动，回滚前逐文件核对归属）。

## 未覆盖与边界

- 真机浏览器/Electron 点击与视觉走查未做（jsdom 不覆盖，留主上环境清单，上文已列步骤）。
- 远端行为均为注明 stub，零云端写入；`classifyOverwriteError` 的 `incomplete_response` 分支由客户端 `updateDocument` 响应形态防御触发，正式用例未单列（create 侧已有客户端级用例覆盖该码的产生语义）。
- 未跑 server 全量 1600+ 用例与桌面打包；harness 结算以 `npm test`（根，前端全量）复核，本轮前端全量已绿。
