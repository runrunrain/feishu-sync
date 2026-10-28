# P1-S4 引用消费：raw_read 追加 + raw_links 工具 + prompt + 预览面板 + reference_loss_risk

- **日期**：2026-10-28 · **切片**：P1 §5 P1-S4（设计 §2.4 消费 + §2.3 解析面）
- **产物**：`server/src/kb/source-links.ts`（新，纯解析/渲染）、`server/src/agent/agent-tool-service.ts`（sourceLinks 注入 + raw_links + raw_read 末页追加）、`server/src/agent/tool-specs.ts`（RAW_LINKS_SPEC）、`server/src/types/agent-knowledge.ts`（三面工具常量）、`server/src/index.ts`（provider 接线）、`server/src/agent/prompts/standard-kb-build.md`（引用段规则）、`server/src/routes/content.ts`（references 出边）、`server/src/modules/source-batch.ts` + `server/src/types/source-batch.ts`（referenceLossRisk）、前端 `src/components/DocReferenceSection.tsx`（新）+ DocPreviewPanel/SourceBatchDialog/Dashboard/types 接线
- **上游输入**：设计 `lark-cli-newcaps-P1.md` §2.3–2.4；`P1-S3-report.md`（listSourceReferencesBySrc/ByTarget/referencedBy）；`P1-S2-report.md`（SourceReferenceEdge 形态）
- **状态**：完成（测试/验证见 §6）

## 1. 工具契约（收口审核消费）

### 1.1 `raw_read` 末页追加（引用列表是内容追加，不改工具面）

- **触发条件**：`offset + returnedLines >= totalLines`（末页）∧ `sourceLinksProvider` 已注入 ∧ 出入链至少一边非空。三个条件任一不满足时输出与旧版逐字一致（既有测试零回归的根据）。
- **位置与格式**（§2.4）：追加在 `</untrusted_source>` **之后**（应用生成的结构信息）；块形态：

  ```
  <source_links obj_token="…" out_truncated?="true" in_truncated?="true">
    <out target="wikiB" title="B 文档" path="b.md" in_raw="true" kb="规则/交叉.md"/>
    <in source="docD" title="D 文档" path="d.md"/>
  </source_links>
  ```

- **属性语义**：`target`=URL 中原 token（wiki 链接为 node token）；`title`=解析到的本地文档标题（回退边 label）；`path`=本地相对路径（已同步才有）；`in_raw`=build 态按快照口径（`snapshot.has`）、会话态按成功本地版本；`kb`=CURRENT manifest 中 sources 含该 objToken 的标准库文档路径（`;` 连接，无则省略）。属性值 XML 转义（`& " < >`）。
- **上限**：出入链各前 30 条（occurrences 降序、标题/token 升序）；超出方向标 `out_truncated="true"` / `in_truncated="true"`。details 增 `sourceLinks: { out, in, outTruncated, inTruncated }`（additive）。
- **子任务工具集交集规则不变**：不新增/移除任何 runKind 的工具成员语义，仅 raw_read 返回内容变化（§3.2 测试锚定）。

### 1.2 `raw_links` 新工具（只读，Discuss/Work/构建三面）

- **参数**：`{ objToken: string（必填，1..256）, direction?: 'out' | 'in' | 'both'（缺省 both）}`；`additionalProperties: false`。
- **返回**：JSON `{ objToken, direction, out: ResolvedLink[], in: ResolvedLink[], outTruncated, inTruncated }`；ResolvedLink = `{ direction, token, targetType, origin, kind, title, occurrences, objToken, localRelPath, synced, kbDocs[] }`。**各方向上限 200**（§2.4），超出标 truncated。
- **注册**：raw 工具族追加（`registerBuiltinFamilies` raw 族 + `RAW_LINKS_SPEC` 进 ALL_SPECS）；runKinds `['build','work','discuss']`；`DISCUSS_TOOLS/WORK_TOOLS/BUILD_TOOLS` 三面常量同步追加（pi `--tools` 参数面与 server 白名单一致——白名单派生=冻结序在前+注册序追加）。
- **数据源注入**：`AgentToolService` 构造项 `sourceLinks?: (objToken) => { out; in }`（index.ts 用 LocalMapStore 接线；入边双键并集 obj_token∪wiki_node_token）。未注入时 raw_read 不追加、raw_links 报 `references_unavailable`(500)。
- **目标解析**：出边 target 按 obj_token 与 wiki_node_token 双键匹配 documents 行（§2.3）；未命中保留原 token（`objToken:null, synced:false`）。

### 1.3 构建 prompt（`standard-kb-build.md`）

- 可用工具清单增 `raw_links` 行；新增「源间引用关系」节：`<source_links>` 块说明 + §2.4 原文规则（「源之间的引用关系用于确定标准库文档间的交叉链接；`in_raw="false"` 的目标不在本库范围内，只能以文字提及，不得臆测其内容」）+ 交叉链接写法（标准库内相对路径；目标无对应标准文档时不建链接只留文字）。

## 2. API 字段（收口审核消费）

### 2.1 `GET /api/mapping/content/:objToken` 增 `references`（出边）

- `referencedBy`（P1-S3 入边）保持不变；新增 `references: ResolvedSourceLink[]`（§1.2 的 ResolvedLink 形态，无 kbDocs——预览面板用不到）：`{ direction:'out', token, targetType, origin, kind, title, occurrences, objToken, localRelPath, synced }`。目标双键解析；旧测试替身（无 listSourceReferencesBySrc）安全降级 `[]`。
- 前端 `DocumentContent` 类型补 `referencedBy?` + `references?`（此前 server 已返回 referencedBy 但前端类型未登记）。

### 2.2 `POST /api/trash/source-batch/preview` 增 `referenceLossRisk`（删除/移出风险）

- **字段**（`SourceBatchPreview.referenceLossRisk?: SourceBatchReferenceLoss[]`，仅 `action:'delete'` 计算；`block` 不移除本地文档不计算 → undefined）：

  ```ts
  { objToken, title, referencedByCount,   // 按引用方文档去重（同源多边计一篇）
    sources: [{ objToken, title, localRelPath }] }  // 选集外引用方，≤50 条
  ```

- **语义**：待删文档按 obj/wiki 双键反查入边（分批 ≤400 键防 SQLite 变量上限）；引用方同在删除集内的边不计（同生共死不悬空）。清单按 referencedByCount 降序；entries 仅含有外部引用的文档。`revision` 哈希含新字段（preview/apply 同源计算，门不破坏——§6 测试锚定）。
- **前端消费**：`SourceBatchDialog` 预览页渲染 `SourceReferenceLossWarning`（「引用悬空风险：N 篇待删文档被选集外的文档引用…」+ 逐篇「『title』被 X 篇引用（引用方…）」）；Dashboard 单篇删除 Modal 打开时调同一 preview API（单 token 形态）拉取风险并显示「该文档被 N 篇文档引用，删除后这些引用将指向不存在的文档」；拉取失败不阻断删除（提示是增强信息非门槛）。

### 2.3 预览面板（src 最小）

- `DocReferenceSection`（新组件）：文档详情底部「引用关系」折叠区——出边（本文档引用）/入边（引用本文档）两组，每项 标题+方向图标+类型标签；未同步出边目标标「未纳入同步」、源行已删入边标「源已删除」；两侧皆空不渲染。挂载于 `DocPreviewPanel`（加载/错误态不渲染）。

## 3. 设计偏离与边界

| 项 | 说明 |
|---|---|
| 截断标记形态 | 设计只写「超出写 truncated="true"」未定位置；实现为根元素 `out_truncated`/`in_raw_truncated` 分向属性（双向各自可超） |
| `raw_links` 入参 | 设计 `{ objToken, direction? }` 一致；返回为扁平 JSON（含 direction 字段行），非设计 §2.3 的类形态——语义等价 |
| in_raw 会话口径 | 设计 inRawSnapshot 以快照为准；会话态无快照，退化为「有成功本地版本」（collectSourceCandidates 同口径） |
| 预览面板最小化 | 任务书限定「标题+方向+类型」；设计的「已同步项点击跳转」与「未同步项快捷归档入口」未做（S4 范围外，见 §5） |
| kb 属性连接符 | 多标准库文档时 `;` 连接单属性（设计示例只演示单值） |
| §2.5 写侧 reference_loss_risk（FeishuWriteService overwrite 预览警告） | **不在本任务书范围**（任务书把该名定义为删除/移出风险提示）；P0 写回线资产未动 |

## 4. 兄弟任务边界（共享树）

- P2-S4（raw_comments）已合入 content.ts 的 ContentDependencies 可选方法与 `getSourceCommentMeta`；本切片在同一 interface 追加两个可选方法、不同代码块，互不覆盖。agent 工具面按既有族注册模式追加（约束兑现）。
- 全部验证在含兄弟改动的共享树上执行并通过（§6），即合并态自洽。

## 5. 未覆盖项

- 预览面板「点击跳转/快捷归档」入口（设计 §2.4 UI 完整形态）；Electron 真机引用区目验（设计 P1-S4 验收行含「真机看到引用区」——需桌面端环境，本切片以组件级测试交付，真机留待收口/发布前统一验证）。
- 「真实库构建产物出现跨文档链接」验收行：prompt 规则已交付，真实构建验证依赖下一次实际构建（模型行为，非代码可测）。
- §2.5 FeishuWriteService overwrite 的 `reference_loss_risk` 警告（P0 写回线；见 §3）。
- custom-doc-sync 写边接线（S3 已列遗留，非本切片范围）。

## 6. 测试与验证证据（cwd=仓库根；`cd server` 后跑 server 侧）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run tests/raw-links.test.ts`（server） | 0 | 11/11：末页追加（格式/转义/双键入边/非末页不追加/零边不追加/无 provider 不追加/30 截断+manifest kb 属性/build 态 in_raw）；raw_links（both/out/in、200 上限+truncated、kbDocs、references_unavailable）；三面工具集+规格面；子任务 override 交集不变（task_ 族与 app_command 剔除）；prompt 引用段存在 |
| `npx vitest run tests/reference-loss-risk.test.ts`（server） | 0 | 5/5：双键悬空清单、选集内不计+同源去重、无外部引用空清单、block 不计算、revision 门 preview→apply 可执行（入边保留/出边清理回归） |
| `npx vitest run tests/agent-tool-families.test.ts tests/agent-tasks.test.ts tests/agent-session.test.ts tests/kb-build.test.ts tests/source-references.test.ts tests/sync-references.test.ts tests/source-cleanup.test.ts tests/reference-graph.test.ts`（server） | 0 | 151/151 既有 agent/kb/引用套件零回归（含 S1 白名单快照测试——raw_links 追加不破坏冻结序断言） |
| `npx vitest run`（server 全量） | 0 | **107 文件 / 1621 用例全通过**（S3 报告所列 p1-s5 兄弟中间态已消解） |
| `npm test`（前端全量） | 0 | 37 文件 / 313 用例通过（含新增 DocReferenceSection/SourceReferenceLossWarning SSR 4 用例：列表+计数+未同步标记、收起态、空态不渲染、风险文案与「等」折叠） |
| `npm run typecheck` | 0 | 根 src + 配置文件 + server 三段干净 |
| `npx eslint`（全部 17 个改动/新增文件） | 0 | 无告警 |

## 7. 回滚

- 纯 additive：revert `agent-tool-service.ts`/`tool-specs.ts`/`agent-knowledge.ts`/`index.ts`/`content.ts`/`source-batch.ts`/`source-batch.ts`(×2)/`Dashboard.tsx`/`DocPreviewPanel.tsx`/`SourceBatchDialog.tsx`/`src/types/index.ts` 即撤工具与 API 字段；删除 `kb/source-links.ts`、`DocReferenceSection.tsx` 与两个测试文件即回切片前状态。prompt 为内容编辑（还原该节即可）。无迁移、无配置变更、无表结构改动。
