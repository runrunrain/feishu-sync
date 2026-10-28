# P2-S8 报告：类型提示——cloudObjType 透传 + 未知类型 blocker 文案

- **日期**：2026-10-28 · **分支**：`feat/agent-knowledge-workbench`（共享树）
- **上游输入**：`lark-cli-newcaps-P2.md` §4.3/U50/§6（P2-S8 行）、§4.2（blocker 文案列）
- **状态**：已实施；定向 vitest + 前端全量测试 + 双侧 typecheck + lint 全绿

## 一、切片范围

按任务书：**不做 mindnote 同步**，只把检测链折叠为 `unknown` 之前已知的真实云端类型透传到 blocker 详情与 UI 文案。分类行为不变（仍折叠 `unknown`、仍产 `unsupported_type` blocker）。

## 二、数据流（改动点 ★）

```
lark-cli obj_type('mindnote'/'file'/…)
  ★ ChangeDetector 构造 CloudNodeObservation 时携带 cloudObjTypeOf(raw)
    （仅折叠路径携带；docx/sheet/slides/bitable/'unknown' 不携带）
  ★ toChangedDocument → ChangedDocument.cloudObjType（undefined 不进 JSON）
  ★ planDocument 的 unknown 分支 → PlannedSyncDocument.cloudObjType
    + reason 文案含类型 + suggestedResolution 按 mindnote/file 特化
  ★ plannedFailure（仅 reasonCode='unsupported_type'）→ FailedDocument.cloudObjType
  → SyncResult / detect API JSON 自动透出（结构化字段；无 CLI sync 命令，无需 CLI 改动）
  ★ 前端：变更列表详情条 + 同步结果 cloudSideFailures 说明行；pending 面板经
    server error/suggestedResolution 文案透出（不落库，无 DB 列变更）
```

## 三、产物清单

| 文件 | 改动 |
|---|---|
| `server/src/types/index.ts` | `CloudNodeObservation` / `ChangedDocument` / `PlannedSyncDocument` / `FailedDocument` 各增可选 `cloudObjType?: string`（含 P2-S8 注释） |
| `server/src/modules/change-detector.ts` | 新增 `cloudObjTypeOf()`（折叠才携带，'unknown' 是折叠产物不携带）；9 处 observation 构造点补字段（custom 检测/root/fast-meta/fast-detail/拓扑刷新×2/enriched/legacy 转换/父链 hydrate）；`toChangedDocument` 透传。`knownObservation`（DB 折叠值重建）不带——原始类型已不可得，诚实缺省 |
| `server/src/modules/operation-manifest.ts` | `blockedPlan` details + 返回对象支持 `cloudObjType`；unknown 分支：reason 带 `云端对象类型 <t> 当前不支持同步…`（无类型时保持原文案）；suggestedResolution 特化 mindnote→「思维笔记暂不支持同步，可在飞书中导出为文档后纳入。」/ file→「云空间文件暂不支持同步。」 |
| `server/src/modules/sync-engine.ts` | 仅 `plannedFailure` 一处：`reasonCode==='unsupported_type'` 时透传 `planned.cloudObjType`（其余失败路径 `undefined` 不进 JSON） |
| `src/types/index.ts` | `ChangedDocument` / `FailedDocument` / `PlannedSyncDocument` 镜像补 `cloudObjType?: string` |
| `src/utils/cloudObjType.ts`（新） | `unsupportedCloudTypeHint`（mindnote/file 设计 §4.2 文案）/ `unsupportedCloudTypeText`（「不支持同步的类型：\<t\>（提示）」）；空值返回 null 不渲染 |
| `src/components/ChangeItem.tsx` | 变更列表详情区：`cloudObjType` 存在时渲染类型提示条（仿 mediaGapReason 样式） |
| `src/components/SyncResultList.tsx` | 「已收入飞书侧待处理」块下：带 `cloudObjType` 的失败项逐条列「\<标题\>不支持同步的类型：\<t\>（…）」 |
| `server/tests/change-detector.test.ts` | +2 用例：mindnote/file 折叠透传（objType 仍 unknown、changeType 仍 added）；docx 对照 `JSON.stringify` 不含 cloudObjType 键 |
| `server/tests/sync-safety.test.ts` | +1 用例：mindnote blocker 的 planned/failed 详情（`cloudObjType`、reason 含类型、suggestedResolution 含设计文案）+ 同批 docx 计划不出现该键 + failed JSON 含 `"cloudObjType":"mindnote"` |
| `src/utils/cloudObjType.test.ts`（新） | +6 用例（文案映射/空值 null） |

**未动面**：`feishu_pending_items` 无新列（不落库，pending 面板经文案透出）；runtime 占位分支（sync-engine `fetchDocumentContent` catch）不动；custom 快捷添加 API 的 `unsupported_type` 拒绝面不动；CLI 无 sync 命令面（无改动需要）。

## 四、不变量核对（验收 4：已支持类型字节级不变）

1. **携带条件收紧**：`cloudObjTypeOf` 对 docx/sheet/slides/bitable/'unknown' 一律返回 `undefined` → 已支持类型从源头不携带。
2. **undefined 不序列化**：`JSON.stringify` 忽略 undefined 属性 → detect/sync API 对已支持类型的 JSON 字节不变。
3. **plannedFailure 仅 unsupported_type 分支带**；blockedPlan 的其余 reasonCode（deleted 等）不传该字段。
4. **无 cloudObjType 的 unknown blocker**（真实类型不可得，如 DB 折叠值重建路径）：reason/suggestedResolution 保持原文案字节不变。
5. **DB/文件零变化**：`recordCloudObservation` 显式挑列，observation 多余字段不落库；不写任何知识库文件；`normalizeObjType` 分类逻辑未动（既有 `sync-engine.test.ts` normalize 用例不改全绿）。

## 五、验证证据

| 验证 | 命令（cwd=feishu-sync） | 结果 |
|---|---|---|
| 检测透传 + blocker 详情（定向） | `cd server && npx vitest run tests/sync-safety.test.ts tests/change-detector.test.ts` | 66 passed（含新增 3） |
| 核心模块回归 | `npx vitest run tests/sync-engine.test.ts tests/detect-routes.test.ts tests/custom-folder-detect-sync.test.ts` | 64 passed |
| 同步 API 层回归 | `npx vitest run tests/sync-route-safety.test.ts` | 7 passed |
| 前端全量 | `npm test`（35 文件 / 301 用例） | 全绿（含新增 6） |
| typecheck | `npm run typecheck`（根 src + 根配置 + server 三段） | 0 错误 |
| lint | `npm run lint` | 0 errors（3 warnings 为既有 `useSyncStatus` 项，与本切片无关） |

注：共享树并行任务在动 sync-engine/types 等同名文件，以上 diff 归因已核对——本切片在 `sync-engine.ts` 仅 `plannedFailure` 一处 `+` 行，其余改动属兄弟任务。

## 六、未覆盖项 / 风险

- 前端未做真机浏览器视觉验证（任务书为最小文案面；文案单元已测，组件行为属既有渲染路径的纯条件新增）。设计 §4.3 的 mindnote 专属文案在 server `suggestedResolution` 与前端 helper 两处维护，措辞以设计 §4.2 为准，已保持一致。
- `knownObservation`（Drive 失败时的 DB 折叠值回退路径）无法恢复原始类型 → 该路径的 unknown blocker 无 `cloudObjType`（回落旧文案），属信息可得性边界而非缺陷。
