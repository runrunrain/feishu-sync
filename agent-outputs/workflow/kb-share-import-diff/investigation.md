# 调查报告：导入标准库共享包后「待更新差异」出现 100+ 变更项

- 调查时间：2026-11-06；代码基线：主树 HEAD `903f037`（实验用隔离工作树 `.amagi-worktrees/work-local-resources/server`，基线 `89b5ee6` + 未提交 Work 开关改动，`git diff HEAD --stat` 显示 17 文件 +774/-23，其中 server 侧仅 `local-map-store.ts` +5/-1（agent_sessions.local_resources 列），与 kb/changes 链路无关）。
- 被测真实数据（全部只读）：knowledgeBaseRoot=`/Users/run.mao/workpace/weixiao-database/飞书同步知识库`；outputRoot=`/Users/run.mao/.feishu-sync/standard-kb`（CURRENT=`r_20261105T101438_b67104`，150 docs / 119 sources）；真实 DB `/Users/run.mao/.feishu-sync/feishu-sync.db`（只以 readonly 或副本方式打开）。

## 结论索引

| # | 主张 | 状态 | 锚点 | 适用边界 |
|---|------|------|------|----------|
| C1 | 变更项按 objToken 对齐；判定=`sourceContentsChanged` + relPath + title，其中 contentHash 不等时依赖 `comparisonHash`(v1: digest) 判语义等价 | 观察 | `server/src/kb/kb-version-store.ts:50-73`；`server/src/kb/source-comparison.ts:69-75` | 代码事实 |
| C2 | contentHash 串联主文档+CSV+xlsx+附件的**原始字节**，包含头部 `fetch_date`/`last_synced_modify_time` → 同账号两台设备各自同步后必然不同 | 观察 | `raw-source-snapshot.ts:117-136`(`visitSourceFiles`/`computeSourceHash`)；`sync-engine.ts:2318-2324` | 纯 docx 源亦中招（fetch_date 每次同步重写） |
| C3 | 当前 CURRENT release 的 manifest 119 条 sourceSnapshot **0 条带 comparisonHash digest**；该机制由 `9c1e6ad`(11-05 03:01) 引入，release 构建于 02:14，早于合入 47 分钟 | 观察 | manifest 实测统计；`git log -S addSourceComparisonHashes` 唯一命中 `9c1e6ad`；releases mtime | 本机现状；新代码重新构建的 release 预期带 digest（未实测构建，见待核验 V1） |
| C4 | 导入设备上 `withSourceComparisonBaseline` 需读本地 `.source-comparison-v1.json` proof；共享包不含 proof、导入流程也不落盘 → 基线维持无 digest；`addSourceComparisonHashes`(capture=false) 对 baseline 无 digest 的条目直接 continue，连语义 digest 都不现场算 | 观察 | `source-comparison.ts:77-90,95-115`；`portable-kb-service.ts` 全文无 proof 写入；`routes/kb.ts:77`（changes 路径未传 capture） | 代码事实；proof 文件现存本机仅 1 条（475B） |
| C5 | **复现**：原包导入 + 设备2独立同步时刻（仅头部时间戳不同）→ **117/119 条 changed**，全部归因 `contentHash-diff + manifest-no-comparisonHash-digest`，affectedDocs=150 | 观察（实证） | 实验场景 B（下文）；与主上「100 多个」吻合 | 排除 /tmp 符号链接伪影后于 `/private/tmp` 重跑的干净值 |
| C6 | 修复方向 A 验证：manifest 注入 118 条 digest 后同环境变更项 **117→1**（仅剩 1 条真实变化） | 观察（实证） | 实验场景 C | 注入法在导出端补算；DqjvsySS 因源已真实变化无法补算（正确保留 changed） |
| C7 | 修复方向 B 验证：outputRoot 放置 proof 缓存（118 条）同样 **117→1** | 观察（实证） | 实验场景 D | proof 按精确 contentHash 键控，仅对未变源有效 |
| C8 | `/api/kb/status` 对导入版本短路 pending=0，`/api/kb/changes` 不短路 → status 显示无待更新、changes 面板却列 117 条，行为自相矛盾 | 观察 | `routes/kb.ts:272-278`（status 短路）vs `routes/kb.ts:541-564`（changes 无短路）；前端 `src/api/client.ts:1642` + `KbChangesPanel.tsx:99` | 代码事实 |
| C9 | CSV/xlsx/图片/文件名/relPath 在两设备间一致（同账号同步），不贡献误报；NFC/NFD、CRLF、排序差异未观察到影响 | 观察 | 场景 C 中 118 条判等即证（digest 输入含全部这些成分）；sheet 三源逐成分对比 md(抹时间)/xlsx/CSV 两端 hash 全同 | 本数据集；NFD 仅影响带组合符/emoji 文件名，本库未见 |
| C10 | 剩余 1 条（`DqjvsySS…` 200-041-作战单元，sheet）是设备1构建后的**真实重同步**（本机 proof 有其旧 digest、当前文件 hash≠manifest hash），属应检出的真实变化 | 观察+推断 | 场景 A/C/D 均恒为 1；proof 文件内容含该 token | 「xlsx 内容真变了」未逐字节证实（见待核验 V2） |

## 一、调用链（文件:行）

```
前端 KbChangesPanel.tsx:99 ── getKbChanges() (src/api/client.ts:1642)
GET /api/kb/changes                     routes/kb.ts:541
 └ withSourceComparisonBaseline(...)    source-comparison.ts:77   ← 读 <outputRoot>/.source-comparison-v1.json 补 digest
 └ RawSourceSnapshot.scan(root, docs, sheetCsvPaths)   raw-source-snapshot.ts:158-200
     └ computeSourceHash → visitSourceFiles            raw-source-snapshot.ts:117-152  ← contentHash=原始字节串联 sha256
 └ prepareSourcePreview(scan.entries, manifest, …)    routes/kb.ts:71-89
     └ addSourceComparisonHashes({entries, base, root, csvPaths})  source-comparison.ts:95  ← 未传 capture
     └ enrichEntriesWithMedia(仅对「contentHash 变但语义未变」候选)  routes/kb.ts:80-84
 └ captureSourceContents(snapshot, root)               kb-version-store.ts:19-25（readVerified 逐条复验 hash）
 └ sourceChangePreview(snapshot, contents, manifest,
     versions.readSourceContents(releaseId), excluded) kb-version-store.ts:50-73
     └ readSourceContents → releases/<id>/source-contents.json   kb-version-store.ts:96-98
     └ sourceContentsChanged                           source-comparison.ts:69-75
共享包：exportPortableKb / importPortableKb / verifyRelease   portable-kb-service.ts:107/262/222
```

## 二、Q1：变更项判定逻辑

1. **对齐 key**：`objToken`（`sourceChangePreview` 用 `before/current` 两个 Map 按 token 取；`sourceComparisonKey` 仅用于 proof 缓存键=`JSON.stringify([objToken, contentHash, relPath])`）。
2. **跳过条件**（`kb-version-store.ts:59`）：`old && next && !sourceContentsChanged(old,next) && old.relPath===next.relPath && old.title===next.title`。
3. **`sourceContentsChanged`**（`source-comparison.ts:69-75`）：先看 `contentHash` 是否相等；不等时，只有当 relPath、objType 相同 **且** `before.comparisonHash` 是 `v1:` digest 且与当前计算的 digest 相等，且 mediaHash（若双边存在）相等、whiteboardTextHash（若当前有定义）相等，才判「未变」。
4. **contentHash 输入**：主 md 字节 + `source_workbook` 指向的 .xlsx 字节 + `*.xlsx.metadata.json` 里 `attachments/*` 字节 + 全部 CSV 字节，按访问顺序串接后 sha256（`raw-source-snapshot.ts:117-152`）。
5. **comparisonHash 输入**（`source-comparison.ts:36-66`）：markdown 用 `withoutSyncTimestamps`（抹 `fetch_date`/`last_synced_modify_time`）后的 sha256；xlsx 用成员排序 + 抹 `docProps/core.xml` 的 dcterms:created/modified 的成员 hash 表；CSV/附件用原始字节 hash；rows=[kind,name,digest] 排序后整体 sha256。**前置门槛：当前文件精确 contentHash 必须等于条目 contentHash，否则返回 undefined。**
6. `source-contents.json` 随 release 打包（exportPortableKb 打包整个 releaseDir，实测 314 文件含它），只影响 diff 展示（`beforeAvailable`/lineDiff），不影响变更计数。

## 三、Q2：设备间差异成分逐项排查

| 成分 | 是否进 key/hash | 两设备是否不同 | 证据 |
|------|----------------|---------------|------|
| 头部 `fetch_date`（本地同步时刻） | 进 contentHash；comparisonHash 已抹 | **必然不同** → C2/C5 | `sync-engine.ts:2318`（每次同步重写）；实验 B 中 117 条全部 contentHash-diff |
| 头部 `last_synced_modify_time`（云端修改时间） | 进 contentHash；comparisonHash 已抹 | 同账号一般相同；抹除规则覆盖 | `source-comparison.ts:16-18` 正则含两字段 |
| 头部其余字段（obj_token/wiki_node_token/space_id/original_link/source_workbook） | 进两种 hash | 相同（同一云端） | `sync-engine.ts:2264-2329` 字段表；场景 C 118 条判等 |
| relPath / watched root 目录名 / `_custom` / 冲突后缀 | 进跳过条件与 proof key，不进 hash 本身 | 目录名一致时相同；不一致则真报 changed（合理） | 任务书确认两设备目录名均为「策划 - Designer」 |
| title | 进跳过条件（DB title 相同） | 相同 | 场景 C 无 title-diff 归因 |
| 图片/媒体文件名与 mediaHash | mediaHash=图片字节 hash，不进 contentHash | 相同（同云端图片字节） | `source-images.ts:140-…`；场景 C 无 mediaHash-diff |
| sheet CSV 路径/字节、xlsx | 进 contentHash 与 comparisonHash | 字节相同（同账号同步产物）；xlsx 抹导出时间后 digest 稳定 | debug 逐成分对比：md(抹时间)/xlsx/CSV 两端 hash 全同 |
| CRLF/NFC-NFD/排序 | digest 输入按 name 排序；路径 realpath 归一 | 未观察到差异 | 场景 C 118 条判等；注意 `/tmp` 符号链接会破坏 CSV 去重（实验伪影，非产品问题，见 §四注） |
| **导入 release 是否带 sourceContents** | 不影响计数 | 带（314 文件含 source-contents.json） | exportPortableKb 打包整个 releaseDir |
| **withSourceComparisonBaseline 选错基线？** | 否——基线就是 CURRENT manifest，问题在于 manifest 无 digest 且本地无 proof | — | `source-comparison.ts:77-90` |
| **导出包漏文件？** | 否——verifyRelease 后 314 文件完整落盘（含 manifest/source-contents/changes） | — | `portable-kb-service.ts:222-259,262-330`；实测 import 校验通过 |

## 四、Q3：实证复现

环境：隔离工作树 server（Node ABI，未 rebuild）；临时 HOME=`/private/tmp/kb-diff-test`（**必须用实体路径**——`/tmp` 是 `/private/tmp` 符号链接，会使 DB 中路径与 `resolveInside` 的 realpath 去重失败、CSV 双份计入 hash、`listKbExcludedSources` 按 root 匹配失效，初次实验在 /tmp 下得到 183/68/181 的失真值，已全部作废重跑）。

设备2 模拟 = 真实库 rsync 副本 + 真实 DB 副本（391 行绝对路径改写到副本根）+ 共享包经 `exportPortableKb`（真实 outputRoot 只读）导出、`importPortableKb` 装入临时 HOME；头部时间改写脚本把每个 md 的 `fetch_date`/`last_synced_modify_time` 改为 `2026-11-06T18:23:45.000+08:00`（285/296 个含头 md 中 282 个命中；正文零改动）。changes 计算逐行复刻 `routes/kb.ts:541-551`。

| 场景 | 设备2库 | 共享包/基线 | 变更项 | byReason |
|------|---------|------------|--------|----------|
| A 对照：字节相同 | pristine 副本 | 原包（0 digest） | **1** | 1× 真实变化（DqjvsySS） |
| B 主上场景 | 头部时间改写 | 原包（0 digest） | **117** | 117× `contentHash-diff+manifest-no-comparisonHash-digest`，affectedDocs=150 |
| C 修复A | 头部时间改写 | manifest 注入 118 条 digest 重打包 | **1** | 同 A |
| D 修复B | 头部时间改写 | 原包 + outputRoot 放 proof(118条) | **1** | 同 A |

计数贡献拆解：117 = 119 manifest 源 − 2 条未被改写的源（无该头部字段的 md）。100+ 与 117 吻合（另一台设备上 2 条未改写源是否同样未变取决于其同步产物，量级不变）。

复现命令（脚本已用毕删除，关键步骤）：
```bash
rsync -a --exclude=.git "$REAL_KB/" /private/tmp/kb-diff-test/kb-m/
cp "$REAL_DB" /private/tmp/kb-diff-test/home-m/feishu-sync.db   # 副本内 391 行绝对路径改写到 kb-m
npx tsx scripts/kb-diff-exp.mts export        # exportPortableKb(REAL_OUT→/private/tmp/.../share.zip)
npx tsx scripts/kb-diff-exp.mts import-m      # importPortableKb(临时HOME, zip, null)
npx tsx scripts/kb-diff-exp.mts mutate-headers
npx tsx scripts/kb-diff-exp.mts changes-m     # → 117
```

## 五、Q4：根因与修复方向

**根因（按计数贡献）**：
- R1（≈117 项）：共享包 manifest 的 sourceSnapshot 不带 comparisonHash digest（C3：该 release 构建于机制合入前 47 分钟）+ 导入设备无本地 proof（C4：proof 不随包携带、导入不落盘）+ changes 路径 `addSourceComparisonHashes` 未传 `capture`、对 baseline 无 digest 的条目跳过现场计算 → 语义等价判定完全失效，退化为 contentHash 字节比较；而 contentHash 含每次同步都重写的 `fetch_date`（C2）→ 两设备间必然全量不等。四者缺一即不会全量误报。
- R2（1 项）：`DqjvsySS…` 在设备1构建后被真实重同步，属应检出的真实变化（安全不变量正确生效，非缺陷）。
- R3（表现层）：`/api/kb/status` 对导入版本短路 pending=0 而 `/api/kb/changes` 不短路（C8）——即使 R1 修复，两个入口对「导入后待更新」的语义也应统一。

**修复方向**（均不削弱「源变化须阻断构建」）：
1. **导出端保证 digest 完整性（推荐，已验证 C6）**：构建路径 `addSourceComparisonHashes(capture:true)` 已能为全部 live 源算 digest——用当前代码**重新构建一次再导出**，manifest 即自带 118/119 级别的 digest（剩 1 条为真实变化，保留检出是正确行为）。若要修复存量 release，可在 `exportPortableKb` 时对能精确匹配的条目补算 digest 写入包内 manifest（本实验 patch-and-pack 即此做法）。
2. **导入端落盘 proof（备选，已验证 C7）**：`importPortableKb` 成功后把 manifest 中已有 digest 以 `.source-comparison-v1.json` 形式落盘到 outputRoot（或导出包直接携带 proof 文件）。注意 proof 对「导出后源已真实变化」的条目天然无效（键控精确 contentHash），与方向 1 互补。
3. **changes 路径允许现场计算**：`prepareSourcePreview`/`withSourceComparisonBaseline` 场景下，对 baseline 无 digest 但源文件可读的条目现场计算语义 digest（等价于对 changes 端点传 `capture:true` 或放宽 `source-comparison.ts:104` 的条件）。它只影响「是否显示为待更新」，构建期间的逐字节不变量（`readVerified`、`source_changed_during_build`）不受影响。
4. **统一 imported 语义（R3）**：`/api/kb/changes` 与 `/api/kb/status` 二选一保持一致——要么 changes 也对 imported 短路（代价：真实变化也不显示，且下次本机构建前无法预览），要么 status 去掉短路（代价：导入后立刻显示待更新）。结合方向 1/3，推荐 changes 保留真实计算（修好 R1 后它本来就只显示真实差异）。

安全不变量影响评估：方向 1/2/3 都只作用于「待更新差异预览」的判等层；`source_changed_during_build`（构建期逐字节校验）、`readVerified`、evidence 的 sourceSnapshotHash 绑定均以 contentHash 为准，未被触碰；真实内容变化（含 xlsx 重导出、CSV 变更）在四场景中均被正确检出（DqjvsySS 恒为 changed）。

## 六、待核验项与所缺证据

- V1：「用当前代码（9c1e6ad 之后）重新构建的 release，manifest 携带 digest」——本轮未实际跑构建（构建需 LLM 通道与完整流水线，超出只读调查范围）；旁证=构建路径 `kb-build-service.ts:2351-2352` 传 `capture:true` 且 `versionedPublishedSources` 以 spread 保留字段。建议由实施方跑一次增量构建后 `jq '[.sourceSnapshot[]|select(.comparisonHash)]|length' manifest.json` 验证。
- V2：DqjvsySS 的 xlsx 是否存在真实内容变化（vs 仅重导出噪声）——可对其 md/csv/xlsx 做逐成员比对；不影响本报告结论（该条在四场景中行为一致）。
- V3：主上实际看到的确切数字（117±2 或含 added 的更大值）未与原始设备核对；建议导出设备上跑同一 changes 计算对照。
- 实验现场保留在 `/private/tmp/kb-diff-test`（两份库副本、home-a/home-m/home-m2、share.zip/share-digest.zip，约 2.2GB），确认后可整体删除；首轮 /tmp 下的失真现场已移入 `${TMPDIR}/amagi-trash.Qvchkl`。
