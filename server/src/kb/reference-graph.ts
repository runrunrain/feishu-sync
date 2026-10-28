/**
 * reference-graph — 引用边抽取纯函数（P1-A 引用图，P1 §2.1–2.2，按 P1-S1 RP 实测裁定修正）
 *
 * 关键修正（P1-S1 probe RP-1/RP-2/RP-3，agent-outputs/workflow/2026-10-27-kb-agent-upgrade/P1-S1-probe.md）：
 * - 引用主体在**正文内联标签**——`<cite doc-id>` / `<sheet token>` 与 Markdown 链接；
 *   @doc/@user 引用不进 reference_map。
 * - 无可提取数据（无评论）时 fetch 响应 `reference_map` 键**整体缺失**（RP-3），
 *   不是 `{}`/null——解析器必须容错键缺失。
 * - 因此 `extractBodyReferences` 是「链接 + 内联标签」双解析主体；
 *   `extractRefmapSupplement` 是补充扫描（覆盖 html5-block 类真 sidecar 组；
 *   保留组 `comments` 排除）。
 *
 * 消费方（P1-S3 入库接线，本切片不接线）：SyncEngine / custom-doc-sync 在提交
 * 事务内调 `extractDocumentReferences` → `source_references` 表（先删该源旧边
 * 再插新边，§2.2）。`SourceReferenceEdge` 即表行形态：target_token/target_type/
 * origin/kind/label(title)/occurrences；direction 抽取层恒 'out'，入链由消费层
 * 按 target_token 反查（§2.3 ResolvedReference）。
 *
 * 已知边界（RP-2，按 P1-S1 报告标注）：
 * - `<cite type="citation">`（参考文献容器）经 `docs +create` 会被**静默丢弃**
 *   （无诊断、revision 正常推进）——发布（P1-C）侧正文不保真；fetch 正文不出现
 *   该块，本模块对含 doc-id 的 citation 形态照常提取（宽容）。
 * - `docs +update` 实测**有** `--reference-map`（推翻 probe §6 记录）；写回不透传
 *   是显式设计选择（U35 修订）。overwrite 预览的 `reference_loss_risk` 警告消费
 *   「origin='refmap' 且同 target 无 origin='body'」的行——merge 的 body 优先
 *   折叠正好保证：合并结果中保留的 refmap 行 = 仅存在于 sidecar 的引用。
 *
 * 上限（§2.1）：单文档最多 500 条边，按 occurrences 降序截断；truncated 经
 * `extractDocumentReferences` 返回，S3 记同步警告 `references_truncated`。
 *
 * 纯函数、无 IO；不 import 前端 utils（server 包独立）——cite 属性解析是
 * src/utils/feishu-cite.ts `parseCiteTag` 的 server 端对应实现，属性集一致
 * （doc-id/title/file-type/type/user-id/user-name）。
 */

/** 归一目标类型（§2.1；sheets/base 路径段与 file-type 属性统一归一为 sheet/bitable）。 */
export type ReferenceTargetType =
  | 'docx'
  | 'wiki'
  | 'sheet'
  | 'bitable'
  | 'slides'
  | 'mindnote'
  | 'file'
  | 'unknown';

/**
 * 引用边（source_references 表行形态，§2.2；P1-S3 消费）。
 * 表列 label ← title 字段；src_obj_token 由入库方携带，不在抽取层。
 */
export interface SourceReferenceEdge {
  /** 目标 token：URL 路径段（wiki 为 node token）/ cite doc-id / sheet token 属性 / refmap token 键。 */
  targetToken: string;
  targetType: ReferenceTargetType;
  /** cite title 属性 / 链接文字 / refmap title|name 属性；截断 200 字符，缺失为 null。 */
  title: string | null;
  /** 抽取层恒出链；入链由 P1-S3 消费层按 target_token 反查（§2.3）。 */
  direction: 'out';
  origin: 'body' | 'refmap';
  /** body 固定 'link' | 'cite' | 'sheet'；refmap 为引用组名原样（截断 64 字符）。 */
  kind: string;
  occurrences: number;
}

export interface ReferenceExtractOptions {
  /** 本文档自身 token 集（obj_token 与 wiki_node_token 都可传）；命中的边为自引用，丢弃（§2.1）。 */
  selfTokens?: ReadonlyArray<string | null | undefined>;
  /** 媒体计划 token 集（图片/白板/附件，media-reference 已处理者）；命中不入图（§2.1）。 */
  excludeTokens?: ReadonlyArray<string | null | undefined>;
  /** 边数上限（默认 MAX_REFERENCE_EDGES）；按 occurrences 降序截断。 */
  maxEdges?: number;
}

export interface ExtractDocumentReferencesInput {
  /** fetch/同步产物的本地 Markdown 正文（正文内联标签是引用主体，RP 裁定）。 */
  markdown: string;
  /** fetch 响应 document.reference_map 原值（键可能整体缺失，RP-3）；宽容降级，不抛错。 */
  referenceMap?: unknown;
  selfTokens?: ReadonlyArray<string | null | undefined>;
  excludeTokens?: ReadonlyArray<string | null | undefined>;
  maxEdges?: number;
}

export interface ExtractDocumentReferencesResult {
  edges: SourceReferenceEdge[];
  /** 合并后超上限发生截断；S3 据此记同步警告 references_truncated（§2.1）。 */
  truncated: boolean;
}

/** 单文档边数上限（§2.1）。 */
export const MAX_REFERENCE_EDGES = 500;

const TITLE_MAX_LENGTH = 200;
const KIND_MAX_LENGTH = 64;
const REFMAP_MAX_DEPTH = 4;

/** token 形态守卫（§2.1 refmap 判定同域；body 的 doc-id/sheet token 也用它防误判）。 */
const TOKENISH_RE = /^[A-Za-z0-9]{16,64}$/;
const TOKEN_KEY_RE = /^(?:token|obj_token|doc_token|wiki_token|node_token)$/;
/** reference_map 保留组（§2.1 U32：comments 不是引用边来源）。 */
const RESERVED_REFMAP_GROUPS = new Set(['comments']);

/** 飞书资源路径段 / cite file-type 属性值 → 归一类型（file-type 取值集与路径段同名，skill 佐证）。 */
const FEISHU_SEGMENT_TYPE: Record<string, ReferenceTargetType> = {
  docx: 'docx',
  wiki: 'wiki',
  sheets: 'sheet',
  base: 'bitable',
  slides: 'slides',
  mindnote: 'mindnote',
  file: 'file',
};

/** 路径段后随 token（16–64 位，负向断言防截断更长 id）。 */
const FEISHU_URL_TARGET_RE = /\/(docx|wiki|sheets|base|slides|mindnote|file)\/([A-Za-z0-9]{16,64})(?![A-Za-z0-9])/;
const BARE_URL_RE = /https?:\/\/[^\s<>"'`\])]+/g;
const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINK_MD_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CITE_TAG_RE = /<cite\b[^>]*\/>|<cite\b[^>]*>[\s\S]*?<\/cite>/gi;
const SHEET_TAG_RE = /<sheet\b[^>]*\/>|<sheet\b[^>]*>[\s\S]*?<\/sheet>/gi;
const IMG_TAG_RE = /<img\b[^>]*>/gi;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,}) *$/;

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

function clampText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML 实体解码（src/utils/html-table.ts decodeHtmlEntities 的 server 端子集实现）。 */
function decodeHtmlEntitiesLite(input: string): string {
  return input.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body.length > 1 && (body[1] === 'x' || body[1] === 'X');
      const code = isHex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function buildTokenSet(tokens?: ReadonlyArray<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  if (tokens) {
    for (const token of tokens) {
      if (typeof token === 'string' && token.length > 0) set.add(token);
    }
  }
  return set;
}

function normalizeMaxEdges(value?: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : MAX_REFERENCE_EDGES;
}

/** 段名/file-type/obj_type 值 → 归一类型；未知或缺失即 unknown（§2.1）。 */
function mapSegmentType(value: string | null | undefined): ReferenceTargetType {
  if (!value) return 'unknown';
  return FEISHU_SEGMENT_TYPE[value.trim().toLowerCase()] ?? 'unknown';
}

/** URL → {token, type}；剥 query/fragment；非飞书资源路径返回 null。 */
function parseFeishuUrlTarget(url: string): { targetToken: string; targetType: ReferenceTargetType } | null {
  const pathOnly = url.replace(/[?#][^\s]*$/, '');
  const match = pathOnly.match(FEISHU_URL_TARGET_RE);
  if (!match) return null;
  return { targetToken: match[2], targetType: FEISHU_SEGMENT_TYPE[match[1]] ?? 'unknown' };
}

/** cite/sheet 标签属性读取（与 parseCiteTag 同属性语法；宽容自闭合 `/>`）。 */
function getTagAttr(tagStr: string, name: string): string | null {
  const re = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>/]+))`, 'i');
  const match = tagStr.match(re);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? null;
  if (raw === null) return null;
  const decoded = decodeHtmlEntitiesLite(raw).trim();
  return decoded.length > 0 ? decoded : null;
}

/** 行内代码 span 剔除（CommonMark 口径：n 个反引号开、恰 n 个闭；未闭合视为普通文字）。 */
function stripInlineCode(line: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let n = 0;
      while (line[i + n] === '`') n += 1;
      const close = line.indexOf('`'.repeat(n), i + n);
      if (close !== -1) {
        out.push(' ');
        i = close + n;
        continue;
      }
    }
    out.push(line[i]);
    i += 1;
  }
  return out.join('');
}

/** 截断排序：occurrences 降序，tie-break targetToken/kind/origin 升序（输出顺序确定）。 */
function compareEdges(a: SourceReferenceEdge, b: SourceReferenceEdge): number {
  if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
  if (a.targetToken !== b.targetToken) return a.targetToken < b.targetToken ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.origin <= b.origin ? -1 : 1;
}

function capEdges(edges: SourceReferenceEdge[], maxEdges: number): SourceReferenceEdge[] {
  return [...edges].sort(compareEdges).slice(0, maxEdges);
}

type AddEdgeFn = (
  targetToken: string,
  targetType: ReferenceTargetType,
  kind: 'link' | 'cite' | 'sheet',
  title: string | null,
) => void;

// ---------------------------------------------------------------------------
// ① 正文双解析（主体）：Markdown 链接 / 裸 URL + <cite> / <sheet> 内联标签
// ---------------------------------------------------------------------------

function scanLine(line: string, addEdge: AddEdgeFn): void {
  // 图片引用整体移除（媒体不是引用，§2.1；先于链接防 ![a](u) 被 [a](u) 误吞）
  let text = line.replace(IMAGE_MD_RE, ' ');
  // Markdown 链接 [text](url)
  text = text.replace(LINK_MD_RE, (_match: string, anchor: string, url: string) => {
    const hit = parseFeishuUrlTarget(url);
    if (hit) {
      addEdge(hit.targetToken, hit.targetType, 'link', clampText(decodeHtmlEntitiesLite(anchor), TITLE_MAX_LENGTH));
    }
    return ' ';
  });
  // 内联 cite 标签（@doc 引用主体形态，RP-2）；@user cite 无 doc-id 自然跳过
  text = text.replace(CITE_TAG_RE, (tag: string) => {
    const docId = getTagAttr(tag, 'doc-id');
    if (docId && TOKENISH_RE.test(docId)) {
      addEdge(docId, mapSegmentType(getTagAttr(tag, 'file-type')), 'cite', clampText(getTagAttr(tag, 'title'), TITLE_MAX_LENGTH));
    }
    return ' ';
  });
  // 内联 sheet 标签（嵌入表格，RP-2）；sheet-id 是短 id，只认 token 属性
  text = text.replace(SHEET_TAG_RE, (tag: string) => {
    const token = getTagAttr(tag, 'token');
    if (token && TOKENISH_RE.test(token)) addEdge(token, 'sheet', 'sheet', null);
    return ' ';
  });
  // <img> 标签移除（媒体；src 不作为引用）
  text = text.replace(IMG_TAG_RE, ' ');
  // 剩余裸 URL（自定义域名 / doubao 域按路径段路由，§2.1）
  for (const url of text.match(BARE_URL_RE) ?? []) {
    const hit = parseFeishuUrlTarget(url);
    if (hit) addEdge(hit.targetToken, hit.targetType, 'link', null);
  }
}

function collectBodyEdges(markdown: string, selfTokens: Set<string>, excludeTokens: Set<string>): SourceReferenceEdge[] {
  const edges = new Map<string, SourceReferenceEdge>();
  const addEdge: AddEdgeFn = (targetToken, targetType, kind, title) => {
    if (selfTokens.has(targetToken) || excludeTokens.has(targetToken)) return;
    const key = `${targetType}|${targetToken}|${kind}`;
    const existing = edges.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (existing.title === null && title !== null) existing.title = title;
    } else {
      edges.set(key, {
        targetToken,
        targetType,
        title,
        direction: 'out',
        origin: 'body',
        kind,
        occurrences: 1,
      });
    }
  };

  let inFence = false;
  let fenceMarkerChar = '';
  for (const rawLine of markdown.split(/\r?\n/)) {
    if (inFence) {
      const close = rawLine.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fenceMarkerChar) {
        inFence = false;
        fenceMarkerChar = '';
      }
      continue;
    }
    const open = rawLine.match(FENCE_OPEN_RE);
    if (open) {
      inFence = true;
      fenceMarkerChar = open[1][0];
      continue;
    }
    scanLine(stripInlineCode(rawLine), addEdge);
  }
  return [...edges.values()];
}

/**
 * 正文引用边抽取（主体来源，RP 裁定）。
 *
 * 解析形态：Markdown 链接 `[t](url)`、裸 URL（按飞书资源路径段路由，不按域名）、
 * `<cite doc-id file-type title type>`（@doc 引用）、`<sheet token>`（嵌入表格）。
 * 围栏代码块与行内代码内的内容不提取；@user cite（无 doc-id）与图片/`<img>`
 * 媒体不产生边；selfTokens/excludeTokens 命中丢弃；同 (type, token, kind)
 * 重复出现累加 occurrences；结果按 occurrences 降序截断到 maxEdges。
 */
export function extractBodyReferences(markdown: string, options?: ReferenceExtractOptions): SourceReferenceEdge[] {
  const selfTokens = buildTokenSet(options?.selfTokens);
  const excludeTokens = buildTokenSet(options?.excludeTokens);
  const edges = collectBodyEdges(markdown, selfTokens, excludeTokens);
  return capEdges(edges, normalizeMaxEdges(options?.maxEdges));
}

// ---------------------------------------------------------------------------
// ② reference_map 补充扫描：键缺失容错 + 未知结构宽容降级
// ---------------------------------------------------------------------------

interface RefScanContext {
  edges: Map<string, SourceReferenceEdge>;
  selfTokens: Set<string>;
  excludeTokens: Set<string>;
}

function addRefEdge(
  ctx: RefScanContext,
  kind: string,
  targetToken: string,
  targetType: ReferenceTargetType,
  title: string | null,
): void {
  if (ctx.selfTokens.has(targetToken) || ctx.excludeTokens.has(targetToken)) return;
  const key = `${targetType}|${targetToken}|${kind}`;
  const existing = ctx.edges.get(key);
  if (existing) {
    existing.occurrences += 1;
    if (existing.title === null && title !== null) existing.title = title;
  } else {
    ctx.edges.set(key, {
      targetToken,
      targetType,
      title,
      direction: 'out',
      origin: 'refmap',
      kind,
      occurrences: 1,
    });
  }
}

/**
 * 深度受限递归扫描（§2.1：深度 ≤4）。
 * 深度口径：reference_map(1) → 组(2) → ref 对象(3) → 其字符串属性(4)；
 * 第 5 层及更深的属性不扫。每层先收集字符串属性（token 边的类型/标题取同对象属性）。
 */
function scanRefNode(node: unknown, depth: number, kind: string, ctx: RefScanContext): void {
  if (node === null || typeof node !== 'object') return;
  const entries = Object.entries(node as Record<string, unknown>);
  const stringProps = new Map<string, string>();
  for (const [key, value] of entries) {
    if (typeof value === 'string') stringProps.set(key, value);
  }
  const childDepth = depth + 1;
  for (const [key, value] of entries) {
    if (value !== null && typeof value === 'object') {
      if (childDepth <= REFMAP_MAX_DEPTH) scanRefNode(value, childDepth, kind, ctx);
      continue;
    }
    if (typeof value !== 'string' || childDepth > REFMAP_MAX_DEPTH) continue;
    // ① 字符串值中的飞书 URL → 同正文规则
    for (const url of value.match(BARE_URL_RE) ?? []) {
      const hit = parseFeishuUrlTarget(url);
      if (hit) addRefEdge(ctx, kind, hit.targetToken, hit.targetType, null);
    }
    // ② token 键名 + token 形态值 → 边；类型取同对象 obj_type|type，缺失即 unknown
    if (TOKEN_KEY_RE.test(key) && TOKENISH_RE.test(value)) {
      const typeRaw = stringProps.get('obj_type') ?? stringProps.get('type') ?? null;
      const titleRaw = stringProps.get('title') ?? stringProps.get('name') ?? null;
      addRefEdge(ctx, kind, value, mapSegmentType(typeRaw), clampText(titleRaw, TITLE_MAX_LENGTH));
    }
  }
}

/**
 * reference_map 补充扫描（RP-1 裁定后的补充来源）。
 *
 * - 键整体缺失（undefined/null）→ 空数组（RP-3 实测形态）。
 * - 非对象输入（string/number/boolean/数组）→ 空数组，不抛错（宽容降级）。
 * - `comments` 保留组排除；其余组名原样作 kind（截断 64）。
 * - 只覆盖 html5-block 类真 sidecar 组；@doc/@user 引用不在此（在正文，RP-2）。
 */
export function extractRefmapSupplement(referenceMap: unknown, options?: ReferenceExtractOptions): SourceReferenceEdge[] {
  if (referenceMap === null || typeof referenceMap !== 'object' || Array.isArray(referenceMap)) return [];
  const ctx: RefScanContext = {
    edges: new Map<string, SourceReferenceEdge>(),
    selfTokens: buildTokenSet(options?.selfTokens),
    excludeTokens: buildTokenSet(options?.excludeTokens),
  };
  for (const [group, groupValue] of Object.entries(referenceMap as Record<string, unknown>)) {
    if (RESERVED_REFMAP_GROUPS.has(group)) continue;
    scanRefNode(groupValue, 2, group.slice(0, KIND_MAX_LENGTH), ctx);
  }
  return [...ctx.edges.values()];
}

// ---------------------------------------------------------------------------
// ③ 合并归一（body 优先）与组合入口
// ---------------------------------------------------------------------------

/** 数组内归一（同 type|token|kind 累加 occurrences、title 回填）；浅拷贝防污染输入。 */
function accumulateRows(rows: SourceReferenceEdge[]): SourceReferenceEdge[] {
  const map = new Map<string, SourceReferenceEdge>();
  for (const row of rows) {
    if (!row || typeof row.targetToken !== 'string' || row.targetToken.length === 0) continue;
    const key = `${row.targetType ?? 'unknown'}|${row.targetToken}|${row.kind ?? ''}`;
    const existing = map.get(key);
    if (existing) {
      const occurrences = (existing.occurrences || 0) + (row.occurrences || 0);
      existing.occurrences = occurrences > 0 ? occurrences : 1;
      if (existing.title === null && row.title != null) existing.title = row.title;
    } else {
      map.set(key, { ...row });
    }
  }
  return [...map.values()];
}

/**
 * 合并去重归一（§2.1 归一模型：目标 token/类型/标题；来源 body 优先）。
 *
 * 分组键 (targetToken, targetType)：组内含 body 行 → 输出 body 行（保留各自
 * kind 与 occurrences），refmap 行被丢弃；body 行 title 为空时回填组内 refmap
 * 行的首个非空 title。仅 refmap 的组原样保留 origin='refmap'（U35
 * reference_loss_risk 的查询基础）。结果按 occurrences 降序截断到 500。
 */
export function mergeReferences(body: SourceReferenceEdge[], refmap: SourceReferenceEdge[]): SourceReferenceEdge[] {
  return capEdges(mergeUncapped(body, refmap), MAX_REFERENCE_EDGES);
}

function mergeUncapped(body: SourceReferenceEdge[], refmap: SourceReferenceEdge[]): SourceReferenceEdge[] {
  const bodyGroups = new Map<string, SourceReferenceEdge[]>();
  for (const row of accumulateRows(body ?? [])) {
    const groupKey = `${row.targetType}|${row.targetToken}`;
    const list = bodyGroups.get(groupKey);
    if (list) list.push(row);
    else bodyGroups.set(groupKey, [row]);
  }
  const refmapGroups = new Map<string, SourceReferenceEdge[]>();
  for (const row of accumulateRows(refmap ?? [])) {
    const groupKey = `${row.targetType}|${row.targetToken}`;
    const list = refmapGroups.get(groupKey);
    if (list) list.push(row);
    else refmapGroups.set(groupKey, [row]);
  }
  const out: SourceReferenceEdge[] = [];
  for (const [groupKey, bodyRows] of bodyGroups) {
    const refRows = refmapGroups.get(groupKey);
    const fallbackTitle = refRows?.find((row) => row.title != null)?.title ?? null;
    for (const row of bodyRows) {
      out.push(row.title === null && fallbackTitle != null ? { ...row, title: fallbackTitle } : row);
    }
  }
  for (const [groupKey, refRows] of refmapGroups) {
    if (!bodyGroups.has(groupKey)) out.push(...refRows);
  }
  return out;
}

/**
 * 组合入口（P1-S3 入库消费）：body 主体 + refmap 补充 + 合并归一 + 上限，
 * 返回 truncated 供同步警告 references_truncated。referenceMap 键缺失直接
 * 省略该参数或传 undefined（RP-3 容错）。
 */
export function extractDocumentReferences(input: ExtractDocumentReferencesInput): ExtractDocumentReferencesResult {
  const selfTokens = buildTokenSet(input.selfTokens);
  const excludeTokens = buildTokenSet(input.excludeTokens);
  const bodyEdges = collectBodyEdges(input.markdown ?? '', selfTokens, excludeTokens);
  const refmapEdges = extractRefmapSupplement(input.referenceMap, { selfTokens: input.selfTokens, excludeTokens: input.excludeTokens });
  const merged = mergeUncapped(bodyEdges, refmapEdges);
  const capped = capEdges(merged, normalizeMaxEdges(input.maxEdges));
  return { edges: capped, truncated: merged.length > capped.length };
}
