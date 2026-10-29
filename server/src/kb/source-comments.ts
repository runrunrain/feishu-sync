/**
 * source-comments — 评论溯源解析纯函数（P2-S4，设计 lark-cli-newcaps-P2 §5.1）。
 *
 * 数据源：`docs +fetch` 响应 `document.reference_map.comments` 组（零新增
 * 调用，与正文同一响应携带）。实测形态（P1-S1 probe §1 / fixture
 * `server/tests/fixtures/p1s1-lark-cli/fetch-refmap-comments.json`，MD-3）：
 *
 *   "comments": {
 *     "c1": { "data": "<comment comment-id=\"…\" is_whole=\"true\"><msg user=\"测试用户\">正文</msg></comment>" }
 *   }
 *
 * - 无可提取数据（无评论）时 `reference_map` 键**整体缺失**（RP-3）——
 *   调用方区分成功执行 docs +fetch（缺键视为零评论）与未采集的文档类型。
 * - `comments.tips` 存在即截断（probe §1：`comments.tips.data` 表示截断）；
 *   tips 不是评论条目。
 * - 条目字段按容错双读解析（MD-3 只实测到 msg 文本与 user 作者；quote/
 *   created_at/solved 在实测样本中未出现，按属性/子元素双读宽容解析，
 *   解析不出即 NULL，不猜测）。
 * - 解析不出文本的条目丢弃（设计 §5.1）。
 *
 * 与 reference-graph.ts 的关系：`extractRefmapSupplement` 把 `comments`
 * 列为保留组排除（引用边不消费评论）；本模块是该组**单独**的解析入口
 * （共用同一 reference_map 输入，不共用扫描器——两者提取目标完全不同）。
 *
 * 纯函数、无 IO；消费方见 LocalMapStore.replaceSourceComments（P2-S4
 * SyncEngine 同步事务内「先删后插」）与 raw_comments 只读工具。
 */

/** 单条解析后的评论（source_comments 表行形态，src_obj_token 由入库方携带）。 */
export interface ParsedSourceComment {
  /** reference_map.comments 的二级键（如 c1）；表主键组成部分。 */
  commentRef: string;
  /** 规范化纯文本（剥内嵌标签 + 实体解码，多条 msg 按行拼接），≤4000 字符。 */
  text: string;
  /** 划词原文（若响应提供），≤500 字符；缺失为 null。 */
  quote: string | null;
  /** 作者（msg user 属性，首条 msg 为准）；缺失为 null。 */
  author: string | null;
  /** 云端创建时间（若响应提供，原样字符串）；缺失为 null。 */
  createdAtCloud: string | null;
  /** 已解决状态：true=已解决，false=未解决，null=未知（设计 §5.1 solved 列）。 */
  solved: boolean | null;
}

export interface RefmapCommentsExtraction {
  comments: ParsedSourceComment[];
  /** comments.tips 存在即 true（云端截断，如实标注、不补全）。 */
  truncated: boolean;
}

/** 设计 §5.1 列上限。 */
const TEXT_MAX_LENGTH = 4000;
const QUOTE_MAX_LENGTH = 500;
const AUTHOR_MAX_LENGTH = 200;
const REF_MAX_LENGTH = 128;
const TIME_MAX_LENGTH = 64;

/** comments 组内的截断标记键（非评论条目）。 */
const TIPS_KEY = 'tips';

/**
 * 解析 reference_map.comments 组。容错面（全部返回空结果、不抛错）：
 * referenceMap 键缺失 / 非对象 / comments 组缺失或非对象 / 条目 data 非
 * 字符串（尝试直接字符串值）/ comment XML 解析不出任何 msg 文本（丢弃）。
 */
export function extractRefmapComments(referenceMap: unknown): RefmapCommentsExtraction {
  if (referenceMap === null || typeof referenceMap !== 'object' || Array.isArray(referenceMap)) {
    return { comments: [], truncated: false };
  }
  const group = (referenceMap as Record<string, unknown>).comments;
  if (group === null || typeof group !== 'object' || Array.isArray(group)) {
    return { comments: [], truncated: false };
  }
  let truncated = false;
  const byRef = new Map<string, ParsedSourceComment>();
  for (const [ref, entry] of Object.entries(group as Record<string, unknown>)) {
    if (ref === TIPS_KEY) {
      truncated = true;
      continue;
    }
    const data = readEntryData(entry);
    if (data === null) continue;
    const parsed = parseCommentXml(data);
    if (parsed === null) continue; // 解析不出文本的条目丢弃
    const commentRef = ref.slice(0, REF_MAX_LENGTH);
    if (!byRef.has(commentRef)) byRef.set(commentRef, { ...parsed, commentRef });
  }
  return { comments: [...byRef.values()], truncated };
}

/** 条目值 → data 字符串；宽容：`{data}` 对象或直接字符串值。 */
function readEntryData(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    const data = (entry as Record<string, unknown>).data;
    return typeof data === 'string' ? data : null;
  }
  return null;
}

/**
 * 解析单条 `<comment …>…</comment>` XML 片段（fixture 形态）。
 * 返回 null = 没有任何可提取文本（丢弃）。
 *
 * 容错双读（MD-3 未实测字段按此宽容，不猜值）：
 * - quote：`<comment quote="…">` / `quote_text` 属性，或 `<quote>` /
 *   `<reply_quote>` 子元素的文本内容。
 * - created_at_cloud：`created_at` / `create_time` / `time` / `at` 属性。
 * - solved：`solved` / `is_solved` 属性（"true"/"1" → true，"false"/"0" →
 *   false，其余 → null）。
 */
function parseCommentXml(
  data: string,
): Omit<ParsedSourceComment, 'commentRef'> | null {
  // 只识别带闭合标签的 <comment> 片段；自闭合/无闭合时退化为把整串当
  // msg 容器（宽容，attrs 为空）。
  const commentMatch = data.match(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/i);
  const attrsRaw = commentMatch?.[1] ?? '';
  const inner = commentMatch?.[2] ?? data;

  const attrs = parseAttributes(attrsRaw);
  const msgs = [...inner.matchAll(/<msg\b([^>]*)>([\s\S]*?)<\/msg>/gi)];
  const texts: string[] = [];
  let author: string | null = null;
  for (const msg of msgs) {
    const msgAttrs = parseAttributes(msg[1]);
    const text = normalizePlainText(msg[2]);
    if (author === null) {
      const user = msgAttrs.get('user') ?? msgAttrs.get('user_name');
      if (user) author = clampText(user, AUTHOR_MAX_LENGTH);
    }
    if (text.length > 0) texts.push(text);
  }
  if (msgs.length === 0) {
    // 无 msg 元素：把 comment 内文本整体当正文（最后手段的宽容面）。
    const fallback = normalizePlainText(inner);
    if (fallback.length > 0) texts.push(fallback);
  }
  if (texts.length === 0) return null;

  const quote = readQuote(attrs, inner);
  const createdAtCloud = readCreatedAt(attrs);
  return {
    text: clampText(texts.join('\n'), TEXT_MAX_LENGTH),
    quote,
    author,
    createdAtCloud,
    solved: readSolved(attrs),
  };
}

/** 属性串 → 键值表（小写键、实体解码；畸形属性跳过）。 */
function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(/([a-zA-Z_][\w:-]*)\s*=\s*"([^"]*)"/g)) {
    attrs.set(match[1].toLowerCase(), decodeEntities(match[2]));
  }
  return attrs;
}

/** 划词原文：属性优先，其次 <quote>/<reply_quote> 子元素文本。 */
function readQuote(attrs: Map<string, string>, inner: string): string | null {
  const attrQuote = attrs.get('quote') ?? attrs.get('quote_text');
  if (attrQuote && attrQuote.trim().length > 0) {
    return clampText(attrQuote.trim(), QUOTE_MAX_LENGTH);
  }
  const elementMatch = inner.match(/<(?:quote|reply_quote)\b[^>]*>([\s\S]*?)<\/(?:quote|reply_quote)>/i);
  if (elementMatch) {
    const text = normalizePlainText(elementMatch[1]);
    if (text.length > 0) return clampText(text, QUOTE_MAX_LENGTH);
  }
  return null;
}

function readCreatedAt(attrs: Map<string, string>): string | null {
  const raw = attrs.get('created_at') ?? attrs.get('create_time') ?? attrs.get('time') ?? attrs.get('at');
  if (!raw || raw.trim().length === 0) return null;
  return clampText(raw.trim(), TIME_MAX_LENGTH);
}

function readSolved(attrs: Map<string, string>): boolean | null {
  const raw = attrs.get('solved') ?? attrs.get('is_solved');
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

/** msg 内文本规范化：剥内嵌标签（保留其文本）、解码实体、去首尾空白。 */
function normalizePlainText(raw: string): string {
  const stripped = raw.replace(/<[^>]*>/g, '');
  return decodeEntities(stripped).trim();
}

/** 实体解码（命名 + 十进制/十六进制数字实体；未知实体原样保留）。 */
function decodeEntities(raw: string): string {
  return raw
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      switch (body) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'nbsp': return ' ';
        default: return match;
      }
    });
}

function clampText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
