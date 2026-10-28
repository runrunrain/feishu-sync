# P1-S2 引用抽取：reference-graph.ts 纯函数

- **日期**：2026-10-28 · **切片**：P1 §5 P1-S2（设计 §2.1–2.2 + P1-S1 RP 实测裁定修正版）
- **产物**：`server/src/kb/reference-graph.ts`（纯函数，无 IO，~470 行）+ `server/tests/reference-graph.test.ts`（26 用例，fixture 驱动）
- **上游输入**：设计 `lark-cli-newcaps-P1.md` §2.1–2.2；`P1-S1-probe.md` RP-1/RP-2/RP-3 裁定（引用主体在正文内联 cite 标签，reference_map 仅补充；键缺失容错）
- **状态**：完成。P1-S3 入库接线未做（本切片范围外，设计 §5）

## 1. RP 裁定落点

| 裁定 | 实现 |
|---|---|
| 引用主体在正文内联标签（RP-1/2） | `extractBodyReferences` 双解析：Markdown 链接/裸 URL + `<cite doc-id file-type title type>` + `<sheet token>`；cite 属性集与 `src/utils/feishu-cite.ts` `parseCiteTag` 逐一对应（server 端对应实现，不 import 前端包） |
| reference_map 仅补充 | `extractRefmapSupplement`：通用属性扫描（URL 值 + token 键名），`comments` 保留组排除，html5-block 类真 sidecar 组覆盖；@doc/@user 引用不在其中 |
| 键整体缺失（RP-3） | `undefined`/`null` → 空数组；非对象（string/number/boolean/数组）→ 空数组不抛错（宽容降级） |
| `<cite type="citation">` create 静默丢弃（RP-2 已知边界） | 模块头 JSDoc + 测试标注；fetch 正文不出现该块，含 doc-id 的 citation 形态照常提取 |
| `docs +update` 实测有 `--reference-map`（U35 修订） | 写回不透传是显式设计选择；merge 保留「仅 refmap」行（origin='refmap'），正是 U35 `reference_loss_risk` 警告的查询基础 |

## 2. 导出签名与类型清单（P1-S3 消费）

```ts
// server/src/kb/reference-graph.ts
export type ReferenceTargetType =
  | 'docx' | 'wiki' | 'sheet' | 'bitable' | 'slides' | 'mindnote' | 'file' | 'unknown';

export interface SourceReferenceEdge {   // §2.2 source_references 行形态
  targetToken: string;                   // ← target_token 列
  targetType: ReferenceTargetType;       // ← target_type 列
  title: string | null;                  // ← label 列（截断 200；cite title/链接文字/refmap title|name）
  direction: 'out';                      // 抽取层恒出链；入链由 S3 按 target_token 反查（§2.3）
  origin: 'body' | 'refmap';             // ← origin 列
  kind: string;                          // ← kind 列（body: 'link'|'cite'|'sheet'；refmap: 组名截断 64）
  occurrences: number;                   // ← occurrences 列
}                                        // src_obj_token/updated_at 由入库方携带

export const MAX_REFERENCE_EDGES = 500;  // §2.1 单文档上限

export interface ReferenceExtractOptions {
  selfTokens?: ReadonlyArray<string | null | undefined>;   // obj_token 与 wiki_node_token 都传，自引用丢弃
  excludeTokens?: ReadonlyArray<string | null | undefined>; // 媒体计划 token 集（图片/白板/附件不入图）
  maxEdges?: number;                                        // 默认 MAX_REFERENCE_EDGES
}

export function extractBodyReferences(markdown: string, options?: ReferenceExtractOptions): SourceReferenceEdge[];
export function extractRefmapSupplement(referenceMap: unknown, options?: ReferenceExtractOptions): SourceReferenceEdge[];
export function mergeReferences(body: SourceReferenceEdge[], refmap: SourceReferenceEdge[]): SourceReferenceEdge[];

// S3 主入口（一次完成 body 主体 + refmap 补充 + 合并归一 + 自引用/媒体排除 + 上限）：
export interface ExtractDocumentReferencesInput {
  markdown: string;            // fetch/同步产物本地正文
  referenceMap?: unknown;      // fetch 响应 document.reference_map 原值；键缺失省略即可（RP-3）
  selfTokens?: ReadonlyArray<string | null | undefined>;
  excludeTokens?: ReadonlyArray<string | null | undefined>;
  maxEdges?: number;
}
export interface ExtractDocumentReferencesResult {
  edges: SourceReferenceEdge[];
  truncated: boolean;          // S3 据此记同步警告 references_truncated（§2.1）
}
export function extractDocumentReferences(input: ExtractDocumentReferencesInput): ExtractDocumentReferencesResult;
```

## 3. 语义要点（S3 接线须知）

- **body 解析**：围栏代码块（``` 与 ~~~，开/闭标记字符一致）与行内代码（CommonMark n 反引号口径）内不提取；`![…](…)` 图片与 `<img>` 标签整体移除（媒体不是引用）；@user cite（无 doc-id）自然跳过；doc-id/sheet-token 加 `^[A-Za-z0-9]{16,64}$` 守卫防误判。
- **URL 路由按路径段**（`/docx|wiki|sheets|base|slides|mindnote|file/<token>`），不按域名（自定义租户域/doubao 域适用）；query/fragment 剥离；token 后随字母数字不截断（负向断言）。file-type/obj_type 值走同一映射表（sheets→sheet、base→bitable 归一），未知/缺失→unknown。
- **merge（body 优先）**：分组键 (targetToken, targetType)。组内含 body 行 → 输出 body 行（保留 kind 与 occurrences），refmap 行丢弃；body 行 title 为 null 时回填组内 refmap 首个非空 title。仅 refmap 的组保留 origin='refmap'（U35 警告查询基础）。输入数组内同 (type,token,kind) 重复行累加 occurrences（浅拷贝，不污染输入）。
- **上限与排序**：三个 extract/merge 出口统一「occurrences 降序，tie-break targetToken/kind/origin 升序」确定性排序后截断；`extractDocumentReferences.truncated` 以未截断合并长度判定。
- **refmap 深度口径**：reference_map(1)→组(2)→ref 对象(3)→其字符串属性(4) 有效；第 5 层不扫（§2.1「深度 ≤4」）。token 边类型取同对象 `obj_type|type`，title 取 `title|name`。

## 4. 测试与验证证据

| 命令（cwd=server） | 退出码 | 结果 |
|---|---|---|
| `npx vitest run tests/reference-graph.test.ts` | 0 | 26/26 通过 |
| `npm run typecheck`（tsc --noEmit） | 2 | 报错仅 `src/modules/lark-cli-client.ts(231) TS6133`——**兄弟任务（P0 线）共享树中间态**（该文件 +307 行非本切片写面）；错误列表中无 reference-graph.ts，本切片文件类型干净 |
| `npx eslint server/src/kb/reference-graph.ts server/tests/reference-graph.test.ts`（cwd=根） | 0 | 无告警 |

用例覆盖（设计 §2.6 前三行 + RP 修正）：fixture 三形态出边与 @user 排除；七路径段类型映射与 query/fragment 剥离；裸 URL/自定义域名/doubao 域；```与~~~围栏及行内代码排除；自引用双 token 排除；图片/`<img>`/excludeTokens 媒体排除；重复累加 occurrences 与 title 回填；file-type 缺失→unknown；citation 已知边界标注；实体解码与 200/64 截断；500 上限降序截断与自定义 maxEdges；comments 组排除、键缺失（RP-3 fixture `fetch-no-refmap.json`）、非对象宽容降级、URL 属性、token 键名、深度 4 截断、refmap occurrences/kind/title 截断、self/exclude 过滤；merge body 优先/标题回填/refmap 独有行保留/输入去重/合并上限；组合入口 truncated 判定。

## 5. 未覆盖项与边界

- 入库/生命周期/`sources.references-rebuild`/`SyncEngineTestHooks` 回滚 = P1-S3；`raw_read`/`raw_links` 消费 = P1-S4（本切片仅纯函数）。
- refmap 真实样本只有 comments 组（P1-S1 fixture）；html5-block 等真 sidecar 组形态无实测样本，解析按设计「通用属性扫描」实现，S5/S8 若取得新 fixture 可直接补用例（接口不变）。
- 内联标签跨行形态不解析（P1-S1 实测均为单行内联）；`<cite type="citation">` 的 create 侧丢失属 P1-C 已知边界，不阻断。
- 全量 `npm test`（harness 结算口径，前端 vitest）不含 server/tests；server 全量测试未跑（共享树存在兄弟中间态，按预检指引留给结算隔离快照验证）。

## 6. 回滚

纯新增文件：删除 `server/src/kb/reference-graph.ts` 与 `server/tests/reference-graph.test.ts` 即回到切片前状态；无其他文件改动、无迁移、无配置变更。
