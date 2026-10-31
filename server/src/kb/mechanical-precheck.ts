/**
 * mechanical-precheck — 构建审查前的机械预检（S3 切片 B，方案 §3）。
 *
 * 定位：只做提示、不做门禁。对「源 → 草稿」做确定性的数值 / 条件词 /
 * 登记术语比对，产出疑点清单；接线（注入审查提示词、
 * standardKb.reviewPolicy.mechanicalPrecheck 开关）在切片 C，本模块为
 * 纯函数：无 IO、无 SQLite、无依赖注入。
 *
 * 设计取舍（宁缺勿滥：误报率在合成集上度量，见
 * tests/kb-mechanical-precheck.test.ts）：
 * - 数值：千分位 / 全角 / 百分号 / 万亿倍率 / 常用单位（中拉等价表）/
 *   范围（3-5、3~5、3至5）规范化后按键比较；中文数字、分数、科学计数
 *   不抽取（漏报）。50% 与 0.5、1000米 与 1公里 不做语义换算，跨写法
 *   会以 missing+added 成对出现，供人工判定。
 * - 噪声：两侧同掩日期 / 时间 / 三段版本号 / 「第N章」类引用序号；
 *   草稿侧额外剔除 feishu_sync 头、围栏代码块、链接 URL（含锚点）、
 *   有序列表序号、标题多点序号。年份等真实内容数字被省略时随之漏报。
 * - 条件词：句级对齐（共享数值，或 ≥3 个共享 CJK 二元组 / 拉丁词），
 *   对齐失败不报（漏报而非误报）；「当」仅认「当…时」结构，「若干」
 *   不算「若」。
 * - 术语：全半角 + 大小写归一后，编辑距离恰为 1 的同文种变体；与任一
 *   登记词互为子串的窗口不报（2 字登记词因此基本不产变体报告）。
 *
 * precheck 返回 { findings, truncated, total } 而非裸数组：任务书要求
 * 「超出 maxFindings 报 truncated 计数」，计数需要载体。
 *
 * F01 修复（计算预算，diting 审核）：句级对齐改用倒排候选索引（按共享
 * 数值 / CJK 二元组 / 拉丁词）替代逐源句全扫描——预算内结果与全扫描
 * 实现同输入逐条一致（择优与平局规则不变）；同时设对齐工作单元预算与
 * 输入字符总量上限，超限降级并在返回值 degraded/skippedReason 如实
 * 标注（对齐按失败处理：宁漏报勿误报），绝不无界阻塞主事件循环。
 */

export type PrecheckFindingKind =
  | 'number_missing'
  | 'number_added'
  | 'condition_dropped'
  | 'term_variant';

/** 登记词表条目（canonical + aliases；切片 C 决定从知识对象 aliases 取）。 */
export interface PrecheckTerm {
  canonical: string;
  aliases: string[];
}

export interface PrecheckDraftInput {
  path: string;
  /** 草稿正文（标准库 Markdown，可含 feishu_sync_kb 头） */
  text: string;
  /** 引用的源 objToken（只与登记在 input.sources 中的比对） */
  sources: string[];
}

export interface PrecheckInput {
  /** objToken → 源正文（feishu-sync 导出的 Markdown） */
  sources: Map<string, string>;
  drafts: PrecheckDraftInput[];
  terms?: PrecheckTerm[];
}

export interface PrecheckFinding {
  kind: PrecheckFindingKind;
  draftPath: string;
  /** 1-based；无法定位草稿对应位置时为 0 */
  draftLine: number;
  draftSnippet: string;
  sourceToken: string;
  /** 1-based；number_added / term_variant 无源侧位置时为 0 */
  sourceLine: number;
  sourceSnippet: string;
  /** 机器可比对的规范值：数值键（如 12秒 / 3~5米 / 150%）/ 条件词 / 变体≈登记词 */
  detail: string;
}

export interface PrecheckOptions {
  /** 输出上限，默认 200；超出部分计入 truncated */
  maxFindings?: number;
  /** F01：句级对齐计算预算（工作单元 = 倒排累加 1 条 posting）。
   * 缺省 ALIGN_WORK_BUDGET；超限降级（degraded 如实标注）。 */
  alignWorkBudget?: number;
  /** F01：输入字符总量上限（源 + 草稿）。缺省 PRECHECK_INPUT_CHAR_CAP；
   * 超限句级对齐整体跳过（数值/术语比对照常），降级如实标注。 */
  inputCharCap?: number;
}

export interface PrecheckResult {
  findings: PrecheckFinding[];
  /** 超出 maxFindings 被截断的条数 */
  truncated: number;
  /** 截断前总条数 */
  total: number;
  /** F01 降级标注：仅在计算预算/输入上限触发时存在（旧结果形状兼容）。 */
  degraded?: true;
  /** degraded 时的原因说明（人读；供 formatFindingsForPrompt 与调用方告警）。 */
  skippedReason?: string;
}

const DEFAULT_MAX_FINDINGS = 200;
const SNIPPET_MAX = 48;
/** 非语义数字掩码占位（不会命中数字 / CJK / 拉丁词元正则） */
const MASK = ' ';

const KIND_ORDER: Record<PrecheckFindingKind, number> = {
  number_missing: 0,
  number_added: 1,
  condition_dropped: 2,
  term_variant: 3,
};

// ---------------------------------------------------------------------------
// Markdown 清洗（保留原始行号；与 text-stats.ts 的预处理同风格）

interface CleanLine {
  /** 原始 1-based 行号 */
  line: number;
  /** 清洗后可见文本（全角归一、非语义数字已掩码） */
  text: string;
}

const HEADER_RE = /<!--\s*\nfeishu_sync(?:_kb)?:[\s\S]*?\n-->/;
const INLINE_COMMENT_RE = /<!--[\s\S]*?-->/g;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,}) *$/;
const QUOTE_RE = /^ {0,3}> ?/;
const HEADING_RE = /^ {0,3}#{1,6} +/;
const LIST_RE = /^ {0,8}(?:[-*+]|\d{1,3}[.)]) +/;
/** 标题多点序号（3.2.1）或「1、」；单数字+空格（年份/数量）不剥 */
const HEADING_SERIAL_RE = /^(?:\d{1,3}(?:\.\d{1,3}){1,4}|\d{1,3}[、.])[、.\s]*\s*/;
const THEMATIC_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,}) *$/;
const TABLE_SEP_RE = /^[\s|:-]+$/;
/** 非语义数字：日期 / 时间 / 三段版本号 / 「第N章」类引用序号（两侧同掩） */
const NON_SEMANTIC_RE =
  /\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{4} ?年(?: ?\d{1,2} ?月)?(?: ?\d{1,2} ?日)?|\d{1,2}:\d{2}(?::\d{2})?|\d+\.\d+\.\d+|第 ?\d+ ?[章节条款卷期号步轮场次回名位篇]/g;

/** 全角 ASCII（U+FF01..U+FF5E）→ 半角；全角空格 → 空格。 */
function toHalfWidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c >= 0xff01 && c <= 0xff5e ? String.fromCharCode(c - 0xfee0) : ch === '　' ? ' ' : ch;
  }
  return out;
}

/** 块级删除时保留换行数，行号不漂移。 */
function keepNewlines(block: string): string {
  return '\n'.repeat((block.match(/\n/g) ?? []).length);
}

/**
 * Markdown → 可比对的行集合。剔除：feishu_sync 头、HTML 注释、围栏代码、
 * 图片/链接 URL（保留可见文本）、引用/标题/列表标记、标题多点序号、
 * 分割线与表格分隔行；最后做全角归一 + 非语义数字掩码。
 */
function cleanMarkdown(markdown: string): CleanLine[] {
  let text = (markdown ?? '').replace(/\r\n?/g, '\n');
  text = text.replace(HEADER_RE, keepNewlines).replace(INLINE_COMMENT_RE, keepNewlines);
  text = text.replace(IMAGE_RE, '$1').replace(LINK_RE, '$1');
  const out: CleanLine[] = [];
  let fence: { char: string; len: number } | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(raw);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue; // 围栏内容与闭合行都不参与比对
    }
    const open = FENCE_OPEN_RE.exec(raw);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      continue;
    }
    let s = toHalfWidth(raw);
    let prev = '';
    while (prev !== s) {
      prev = s;
      s = s.replace(QUOTE_RE, '');
    }
    if (HEADING_RE.test(s)) s = s.replace(HEADING_RE, '').replace(HEADING_SERIAL_RE, '');
    s = s.replace(LIST_RE, '');
    if (THEMATIC_RE.test(s) || TABLE_SEP_RE.test(s)) continue;
    s = s.replace(/\|/g, ' ').replace(NON_SEMANTIC_RE, MASK);
    out.push({ line: i + 1, text: s });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 数值抽取与规范化

interface NumOcc {
  line: number;
  start: number;
  end: number;
  /** 所在清洗行文本（供 snippet） */
  text: string;
}

type NumEntry =
  | { kind: 'num'; value: string; start: number; end: number }
  | { kind: 'range'; lo: string; hi: string; loEnd: number; start: number; end: number };

const NUMBER_TOKEN_RE = /\d[\d.,]*/g;

/** 千分位校验 + 前导零 / 小数尾零归一；非法千分位（枚举式 "1,23"）返回 null。 */
function canonicalValue(raw: string): string | null {
  const s = raw.replace(/[.,]+$/, '');
  if (!s) return null;
  if (s.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return null;
  const noComma = s.replace(/,/g, '');
  const dot = noComma.indexOf('.');
  let intPart = dot < 0 ? noComma : noComma.slice(0, dot);
  let frac = dot < 0 ? '' : noComma.slice(dot + 1);
  intPart = intPart.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  if (intPart === '') intPart = '0';
  return frac ? `${intPart}.${frac}` : intPart;
}

/** 十进制右移（×10^places），字符串运算避免浮点误差（3.5万 → 35000）。 */
function shiftDecimal(value: string, places: number): string {
  const dot = value.indexOf('.');
  let intPart = dot < 0 ? value : value.slice(0, dot);
  let frac = dot < 0 ? '' : value.slice(dot + 1);
  if (frac.length >= places) {
    intPart += frac.slice(0, places);
    frac = frac.slice(places);
  } else {
    intPart += frac.padEnd(places, '0');
    frac = '';
  }
  intPart = intPart.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : intPart;
}

const LATIN_UNIT_CLASS: Record<string, string> = {
  m: '米', km: '千米', cm: '厘米', mm: '毫米', kg: '公斤', g: '克', t: '吨',
  s: '秒', ms: '毫秒', min: '分钟', h: '小时', hour: '小时', day: '天', d: '天',
  w: '周', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB', hp: 'HP', dps: 'DPS', px: 'PX',
};
const CJK_UNIT_CLASS: Record<string, string> = {
  厘米: '厘米', 毫米: '毫米', 千米: '千米', 公里: '千米', 公斤: '公斤',
  千克: '公斤', 分钟: '分钟', 小时: '小时', 毫秒: '毫秒',
};
const CJK_UNIT_1 = new Set([
  '米', '秒', '分', '天', '日', '周', '月', '年', '个', '次', '倍', '层', '人',
  '名', '条', '张', '件', '点', '回', '合', '轮', '场', '步', '局', '页', '行',
  '款', '项', '度', '克', '吨', '升', '元',
]);

/** 数后缀：万亿倍率 → 百分号 → 拉丁单位（等价表）→ 中文单位（先两字后单字）。 */
function numberKey(text: string, value: string, end: number): { value: string; unit: string } {
  let i = end;
  if (text[i] === ' ') i++;
  if (text[i] === '万' || text[i] === '亿') {
    value = shiftDecimal(value, text[i] === '万' ? 4 : 8);
    i++;
    if (text[i] === ' ') i++;
  }
  if (text[i] === '%') return { value, unit: '%' };
  const latin = /^[A-Za-z]{1,6}/.exec(text.slice(i, i + 8));
  if (latin) {
    const cls = LATIN_UNIT_CLASS[latin[0].toLowerCase()];
    if (cls) return { value, unit: cls };
  }
  const two = text.slice(i, i + 2);
  if (CJK_UNIT_CLASS[two]) return { value, unit: CJK_UNIT_CLASS[two] };
  const one = text[i] ?? '';
  if (CJK_UNIT_1.has(one)) return { value, unit: one };
  return { value, unit: '' };
}

/**
 * 抽取一行文本的规范化数值键（首个出现者胜出）。
 * 键形如 `单位|数值`（无单位为 `-`、百分数为 `%`）或 `单位|lo~hi`（范围，
 * 端点同时登记，降低「3秒或5秒」式改写的成对误报）。
 */
function extractNumbers(text: string, line: number, out: Map<string, NumOcc>): void {
  const entries: NumEntry[] = [];
  let lastValidEnd = -1;
  for (const m of text.matchAll(NUMBER_TOKEN_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const value = canonicalValue(m[0]);
    if (value !== null) {
      const prev = entries[entries.length - 1];
      let merged = false;
      if (prev && prev.kind === 'num' && lastValidEnd >= 0) {
        const gap = text.slice(lastValidEnd, start);
        if (gap === '-' || gap === '–' || gap === '—' || gap === '~' || gap === '～'
          || /^\s*(?:至|到)\s*$/.test(gap)) {
          entries[entries.length - 1] = { kind: 'range', lo: prev.value, hi: value, loEnd: prev.end, start: prev.start, end };
          merged = true;
        }
      }
      if (!merged) entries.push({ kind: 'num', value, start, end });
      lastValidEnd = end;
    }
  }
  const put = (key: string, start: number, end: number) => {
    if (!out.has(key)) out.set(key, { line, start, end, text });
  };
  for (const e of entries) {
    if (e.kind === 'num') {
      const k = numberKey(text, e.value, e.end);
      put(`${k.unit || '-'}|${k.value}`, e.start, e.end);
    } else {
      const hi = numberKey(text, e.hi, e.end);
      const lo = numberKey(text, e.lo, e.loEnd);
      const unit = hi.unit || lo.unit;
      put(`${unit || '-'}|${lo.value}~${hi.value}`, e.start, e.end);
      put(`${unit || '-'}|${lo.value}`, e.start, e.end);
      put(`${unit || '-'}|${hi.value}`, e.start, e.end);
    }
  }
}

/** 比对键 → 人读形式（秒|12 → 12秒；%|150 → 150%；米|3~5 → 3~5米）。 */
function formatKey(key: string): string {
  const bar = key.indexOf('|');
  const unit = key.slice(0, bar);
  const value = key.slice(bar + 1);
  if (unit === '-') return value;
  if (unit === '%') return `${value}%`;
  return `${value}${unit}`;
}

// ---------------------------------------------------------------------------
// 条件词

const CONDITION_WORDS = [
  '除非', '如果', '假如', '一旦', '超过', '不超过', '大于', '小于', '不大于',
  '不小于', '至少', '至多', '不得', '必须', '禁止', '不可', '无法', '只有',
  '仅当', '仅', '若', '当',
];
/** 长词优先，命中区间内的短词（超过⊂不超过、当⊂仅当）不重复计 */
const WORD_LEN_DESC = [...CONDITION_WORDS].sort((a, b) => b.length - a.length);
/** 「当」的复合词前缀（正当/适当/充当…）不是条件语义 */
const DANG_PREFIX_BLACKLIST = new Set(['正', '适', '恰', '妥', '快', '舒', '便', '独', '充']);

function conditionGuard(text: string, word: string, idx: number): boolean {
  if (word === '若') return text[idx + 1] !== '干'; // 若干
  if (word === '当') {
    if (DANG_PREFIX_BLACKLIST.has(text[idx - 1] ?? '')) return false;
    return /当[^。！？；\n]{0,30}时/.test(text.slice(idx)); // 只认「当…时」结构
  }
  return true;
}

/** 文本中的条件词命中（按出现位置排序；去重由调用方 Set 完成）。 */
function findConditionWords(text: string): Array<{ word: string; index: number }> {
  const hits: Array<{ word: string; index: number }> = [];
  const covered: Array<[number, number]> = [];
  for (const word of WORD_LEN_DESC) {
    let idx = text.indexOf(word);
    while (idx >= 0) {
      const inside = covered.some(([s, e]) => idx >= s && idx + word.length <= e);
      if (!inside && conditionGuard(text, word, idx)) {
        hits.push({ word, index: idx });
        covered.push([idx, idx + word.length]);
      }
      idx = text.indexOf(word, idx + 1);
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// 句子切分与句级对齐

interface Sentence {
  text: string;
  line: number;
  numbers: Set<string>;
  bigrams: Set<string>;
  latin: Set<string>;
  conditions: Set<string>;
}

const CJK_RUN_RE = /[\u4e00-\u9fff]{2,}/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9-]{2,}/g;

function makeSentence(text: string, line: number): Sentence {
  const numbers = new Map<string, NumOcc>();
  extractNumbers(text, line, numbers);
  const bigrams = new Set<string>();
  for (const m of text.matchAll(CJK_RUN_RE)) {
    for (let i = 0; i + 2 <= m[0].length; i++) bigrams.add(m[0].slice(i, i + 2));
  }
  const latin = new Set<string>();
  for (const m of text.matchAll(LATIN_WORD_RE)) latin.add(m[0].toLowerCase());
  return {
    text,
    line,
    numbers: new Set(numbers.keys()),
    bigrams,
    latin,
    conditions: new Set(findConditionWords(text).map((h) => h.word)),
  };
}

/** 行 → 句（。！？；!?; 为界；CleanLine 已按行切分）。 */
function buildSentences(lines: CleanLine[]): Sentence[] {
  const out: Sentence[] = [];
  for (const { line, text } of lines) {
    for (const seg of text.split(/[。！？；!?;]/)) {
      const t = seg.trim();
      if (t) out.push(makeSentence(t, line));
    }
  }
  return out;
}

/** 对齐阈值：共享 1 个数值，或 3 个 CJK 二元组 / 拉丁词的等价组合。 */
const ALIGN_MIN_SCORE = 3;

/** F01：句级对齐工作单元预算（1 单元 = 倒排累加 1 条 posting）。 */
export const ALIGN_WORK_BUDGET = 2_000_000;
/** F01：输入字符总量上限（源 + 草稿，线性清洗/抽取照跑，对齐跳过）。 */
export const PRECHECK_INPUT_CHAR_CAP = 2_000_000;

interface AlignWorkBudget {
  unitsRemaining: number;
  exhausted: boolean;
}

/**
 * 单个草稿的句级对齐器（F01：倒排候选索引替代全扫描）。
 *
 * 语义保持：对每条源句，把其数值 / CJK 二元组 / 拉丁词命中的草稿句
 * posting 逐条累加权重（数值 3 / 二元组 1 / 拉丁词 2）——与原「遍历
 * 全部草稿句逐个打分」等价（打分 ≥1 ⇔ 共享任一 token），再取最高分
 * 且索引最小者（原实现的「先到先胜」平局规则等价于最大分中的最小
 * 索引）。预算内不截断候选，因此同输入结果与全扫描实现逐条一致。
 * 相同源句文本（如重复规则文档）命中缓存，不重复计算。
 */
class DraftAligner {
  private readonly postings = new Map<string, number[]>();
  private readonly cache = new Map<string, Sentence | null>();

  constructor(
    private readonly sentences: Sentence[],
    private readonly budget: AlignWorkBudget,
  ) {
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      for (const n of s.numbers) addPosting(this.postings, n, i);
      for (const b of s.bigrams) addPosting(this.postings, b, i);
      for (const w of s.latin) addPosting(this.postings, w, i);
    }
  }

  /** 找草稿中与源句对应度最高的句子；对齐失败 / 预算耗尽返回 null
   * （宁漏报勿误报；降级由调用方如实标注）。 */
  align(src: Sentence): Sentence | null {
    if (this.budget.exhausted) return null;
    // 缓存只存 Sentence | null（从不存 undefined），get 命中即可直接返回
    const cached = this.cache.get(src.text);
    if (cached !== undefined) return cached;
    const result = this.compute(src);
    this.cache.set(src.text, result);
    return result;
  }

  private compute(src: Sentence): Sentence | null {
    // 预算预检：最坏工作量 = 各 token posting 长度之和（每条 posting 恰好
    // 累加一次）。超限不做部分计算——本句按未对齐处理并耗尽预算。
    let work = 0;
    for (const n of src.numbers) work += this.postings.get(n)?.length ?? 0;
    for (const b of src.bigrams) work += this.postings.get(b)?.length ?? 0;
    for (const w of src.latin) work += this.postings.get(w)?.length ?? 0;
    if (work > this.budget.unitsRemaining) {
      this.budget.exhausted = true;
      this.budget.unitsRemaining = 0;
      return null;
    }
    this.budget.unitsRemaining -= work;
    if (work === 0) return null; // 与任何草稿句无共享 token：对齐必然失败
    const scores = new Map<number, number>();
    const bump = (key: string, weight: number) => {
      const list = this.postings.get(key);
      if (!list) return;
      for (const idx of list) scores.set(idx, (scores.get(idx) ?? 0) + weight);
    };
    for (const n of src.numbers) bump(n, 3);
    for (const b of src.bigrams) bump(b, 1);
    for (const w of src.latin) bump(w, 2);
    let bestIdx = -1;
    let bestScore = 0;
    for (const [idx, score] of scores) {
      if (score > bestScore || (score === bestScore && idx < bestIdx)) {
        bestIdx = idx;
        bestScore = score;
      }
    }
    return bestScore >= ALIGN_MIN_SCORE ? this.sentences[bestIdx] : null;
  }
}

function addPosting(postings: Map<string, number[]>, key: string, index: number): void {
  const list = postings.get(key);
  if (list) list.push(index);
  else postings.set(key, [index]);
}

// ---------------------------------------------------------------------------
// 登记术语变体

interface TermEntry {
  norm: string;
  display: string;
  cjk: boolean;
}
interface TermRegistry {
  exact: Set<string>;
  entries: TermEntry[];
  /** CJK 登记词长度集合（窗口长度预筛） */
  lengths: Set<number>;
}

function normalizeTerm(s: string): string {
  return toHalfWidth(s).toLowerCase().replace(/\s+/g, '');
}

function buildRegistry(terms: PrecheckTerm[] | undefined): TermRegistry {
  const exact = new Set<string>();
  const entries: TermEntry[] = [];
  for (const t of terms ?? []) {
    for (const form of [t.canonical, ...(t.aliases ?? [])]) {
      const norm = normalizeTerm(form);
      if (!norm || exact.has(norm)) continue;
      exact.add(norm);
      entries.push({ norm, display: t.canonical, cjk: /[\u4e00-\u9fff]/.test(norm) });
    }
  }
  const lengths = new Set<number>();
  for (const e of entries) if (e.cjk) lengths.add(e.norm.length);
  return { exact, entries, lengths };
}

/** 编辑距离恰为 1（相等已在调用方排除）；长度差 >1 直接否。 */
function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const short = la < lb ? a : b;
  const long = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else {
      if (skipped) return false;
      skipped = true;
      j++;
    }
  }
  return true;
}

interface TermHit {
  line: number;
  start: number;
  len: number;
  text: string;
  window: string;
  display: string;
}

/** 端点必要条件：d≤1 时短串首或尾必与长串同端字符一致（换字只可能占一端）。 */
function endpointPrefilter(win: string, term: string): boolean {
  return win[0] === term[0] || win[win.length - 1] === term[term.length - 1];
}

/**
 * 草稿文本中的未登记变体：
 * - 拉丁词元：token ≥4 字符、登记词 ≥3，编辑距离 1（大小写/全半角先归一，
 *   归一后精确相等即合法，不报）。
 * - CJK 窗口：与登记词同长或差 1（max ≥3）；与任一登记词互为子串的窗口
 *   视为正常用法不报（防「会心一击⊃会心」式误报）。
 */
function scanTerms(lines: CleanLine[], registry: TermRegistry): TermHit[] {
  const hits: TermHit[] = [];
  const seen = new Set<string>();
  const containsMemo = new Map<string, boolean>();
  const hasContainment = (win: string): boolean => {
    const memo = containsMemo.get(win);
    if (memo !== undefined) return memo;
    const rel = registry.entries.some((e) => win.includes(e.norm) || e.norm.includes(win));
    containsMemo.set(win, rel);
    return rel;
  };
  for (const { line, text } of lines) {
    for (const m of text.matchAll(LATIN_WORD_RE)) {
      const tok = m[0].toLowerCase().replace(/-+$/, '');
      if (tok.length < 4 || registry.exact.has(tok)) continue;
      const start = m.index ?? 0;
      const key = `${line}:${start}:${tok}`;
      if (seen.has(key)) continue;
      for (const e of registry.entries) {
        if (e.cjk || e.norm.length < 3) continue;
        if (!endpointPrefilter(tok, e.norm)) continue;
        if (editDistanceAtMost1(tok, e.norm)) {
          seen.add(key);
          hits.push({ line, start, len: tok.length, text, window: tok, display: e.display });
          break;
        }
      }
    }
    for (const runM of text.matchAll(CJK_RUN_RE)) {
      const run = runM[0];
      const base = runM.index ?? 0;
      for (let wlen = 2; wlen <= run.length; wlen++) {
        if (!registry.lengths.has(wlen - 1) && !registry.lengths.has(wlen) && !registry.lengths.has(wlen + 1)) continue;
        for (let s = 0; s + wlen <= run.length; s++) {
          const win = run.slice(s, s + wlen);
          if (registry.exact.has(win)) continue;
          const key = `${line}:${base + s}:${win}`;
          if (seen.has(key)) continue;
          for (const e of registry.entries) {
            if (!e.cjk) continue;
            const lenDiff = Math.abs(e.norm.length - wlen);
            if (lenDiff > 1 || Math.max(e.norm.length, wlen) < 3) continue;
            if (!endpointPrefilter(win, e.norm)) continue;
            if (editDistanceAtMost1(win, e.norm)) {
              if (hasContainment(win)) break; // 含登记词的窗口是正常用法
              seen.add(key);
              hits.push({ line, start: base + s, len: wlen, text, window: win, display: e.display });
              break;
            }
          }
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 主流程

function clip(s: string, max = SNIPPET_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function clipAround(text: string, start: number, len: number, max = SNIPPET_MAX): string {
  const from = Math.max(0, start - 12);
  const to = Math.min(text.length, start + len + 12);
  let t = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (from > 0) t = '…' + t;
  if (to < text.length) t += '…';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpFindings(a: PrecheckFinding, b: PrecheckFinding): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || cmpStr(a.draftPath, b.draftPath)
    || a.draftLine - b.draftLine
    || cmpStr(a.detail, b.detail)
    || cmpStr(a.sourceToken, b.sourceToken)
    || a.sourceLine - b.sourceLine
    || cmpStr(a.draftSnippet, b.draftSnippet)
  );
}

type SourcedOcc = NumOcc & { token: string };

/**
 * 机械预检主入口。逐草稿：先做与源引用无关的术语变体扫描；引用了登记源
 * 时再做数值缺失/新增与条件词丢失比对。输出按 kind → draftPath → 行号 →
 * detail 稳定排序并截断。
 *
 * F01：句级对齐受 alignWorkBudget / inputCharCap 约束，超限降级（对齐
 * 按失败处理）并在返回值 degraded/skippedReason 如实标注；数值比对、
 * 术语扫描不受降级影响照常执行。
 */
export function precheck(input: PrecheckInput, options: PrecheckOptions = {}): PrecheckResult {
  const maxFindings = Math.max(0, Math.floor(options.maxFindings ?? DEFAULT_MAX_FINDINGS));
  const findings: PrecheckFinding[] = [];
  const registry = buildRegistry(input.terms);

  // F01：输入字符预算——超限时句级对齐整体跳过（线性比对照常），如实标注。
  let inputChars = 0;
  for (const text of input.sources.values()) inputChars += (text ?? '').length;
  for (const draft of input.drafts) inputChars += (draft.text ?? '').length;
  const inputCharCap = Math.max(0, Math.floor(options.inputCharCap ?? PRECHECK_INPUT_CHAR_CAP));
  const workBudget = Math.max(0, Math.floor(options.alignWorkBudget ?? ALIGN_WORK_BUDGET));
  const budget: AlignWorkBudget = { unitsRemaining: workBudget, exhausted: false };
  let degraded = false;
  let skippedReason = '';
  if (inputChars > inputCharCap) {
    degraded = true;
    skippedReason = `输入字符总量 ${inputChars} 超过上限 ${inputCharCap}，句级对齐已跳过，疑点清单可能不完整`;
  }

  const sourceData = new Map<
    string,
    { numbers: Map<string, NumOcc>; sentences: Sentence[]; byNumber: Map<string, Sentence> }
  >();
  for (const [token, text] of input.sources) {
    const lines = cleanMarkdown(text);
    const numbers = new Map<string, NumOcc>();
    for (const l of lines) extractNumbers(l.text, l.line, numbers);
    const sentences = buildSentences(lines);
    // 首句索引：等价于原 sentences.find（首个含 key 的句子），免逐 key 全扫描
    const byNumber = new Map<string, Sentence>();
    for (const s of sentences) {
      for (const k of s.numbers) if (!byNumber.has(k)) byNumber.set(k, s);
    }
    sourceData.set(token, { numbers, sentences, byNumber });
  }

  for (const draft of input.drafts) {
    const refs = (draft.sources ?? []).filter((t) => sourceData.has(t));
    const dLines = cleanMarkdown(draft.text);
    const dSentences = buildSentences(dLines);

    for (const hit of scanTerms(dLines, registry)) {
      findings.push({
        kind: 'term_variant',
        draftPath: draft.path,
        draftLine: hit.line,
        draftSnippet: clipAround(hit.text, hit.start, hit.len),
        sourceToken: refs[0] ?? '',
        sourceLine: 0,
        sourceSnippet: '',
        detail: `「${hit.window}」疑似「${hit.display}」的未登记变体`,
      });
    }

    if (refs.length === 0) continue; // 无登记源可比对：数值/条件检查跳过（避免对空报 added）

    const dNumbers = new Map<string, NumOcc>();
    for (const l of dLines) extractNumbers(l.text, l.line, dNumbers);

    const srcNumbers = new Map<string, SourcedOcc>();
    for (const token of refs) {
      for (const [k, occ] of sourceData.get(token)!.numbers) {
        if (!srcNumbers.has(k)) srcNumbers.set(k, { ...occ, token });
      }
    }

    // F01：对齐器仅在可对齐时创建（预算耗尽/降级后不再建索引）
    const aligner = !degraded && !budget.exhausted ? new DraftAligner(dSentences, budget) : null;

    for (const [k, occ] of srcNumbers) {
      if (dNumbers.has(k)) continue;
      const sent = sourceData.get(occ.token)!.byNumber.get(k) ?? null;
      const aligned = sent && aligner ? aligner.align(sent) : null;
      findings.push({
        kind: 'number_missing',
        draftPath: draft.path,
        draftLine: aligned ? aligned.line : 0,
        draftSnippet: aligned ? clip(aligned.text) : '',
        sourceToken: occ.token,
        sourceLine: occ.line,
        sourceSnippet: clipAround(occ.text, occ.start, occ.end - occ.start),
        detail: `数值「${formatKey(k)}」`,
      });
    }
    for (const [k, occ] of dNumbers) {
      if (srcNumbers.has(k)) continue;
      findings.push({
        kind: 'number_added',
        draftPath: draft.path,
        draftLine: occ.line,
        draftSnippet: clipAround(occ.text, occ.start, occ.end - occ.start),
        sourceToken: refs[0],
        sourceLine: 0,
        sourceSnippet: '',
        detail: `数值「${formatKey(k)}」`,
      });
    }

    for (const token of refs) {
      for (const sent of sourceData.get(token)!.sentences) {
        if (sent.conditions.size === 0) continue;
        const aligned = aligner ? aligner.align(sent) : null;
        if (!aligned) continue;
        const kept = new Set(findConditionWords(aligned.text).map((h) => h.word));
        for (const word of sent.conditions) {
          if (kept.has(word)) continue;
          findings.push({
            kind: 'condition_dropped',
            draftPath: draft.path,
            draftLine: aligned.line,
            draftSnippet: clip(aligned.text),
            sourceToken: token,
            sourceLine: sent.line,
            sourceSnippet: clip(sent.text),
            detail: `条件词「${word}」`,
          });
        }
      }
    }
  }

  if (!degraded && budget.exhausted) {
    degraded = true;
    skippedReason = `句级对齐计算超出预算（${workBudget} 工作单元），超出部分按未对齐处理，疑点清单可能不完整`;
  }

  findings.sort(cmpFindings);
  const total = findings.length;
  const truncated = Math.max(0, total - maxFindings);
  return {
    findings: findings.slice(0, maxFindings),
    truncated,
    total,
    ...(degraded ? { degraded: true as const, skippedReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// 审查提示词格式化（本切片只交付函数，接线在切片 C）

/** F01 降级信息（可选第三参）：precheck 返回 degraded 时由调用方透传，
 * 在输出尾部如实警告清单可能不完整；未降级调用不传，输出与旧版一致。 */
export interface PrecheckPromptDegradation {
  skippedReason?: string;
}

/** 疑点清单 → 审查提示词用的简明中文列表（超 limit 截断并注明省略数；
 * 降级时追加预算警告——空清单也不例外，避免误读为「未发现疑点」）。 */
export function formatFindingsForPrompt(
  findings: PrecheckFinding[],
  limit = 40,
  degradation?: PrecheckPromptDegradation,
): string {
  const list = findings ?? [];
  const reason = degradation?.skippedReason?.trim();
  const warn = degradation
    ? `⚠ 机械预检${reason ? `：${reason}` : '计算预算超限'}——本清单可能不完整（宁漏报勿误报）。`
    : '';
  if (list.length === 0) {
    return warn || '机械预检未发现疑点。';
  }
  const shown = list.slice(0, Math.max(0, limit));
  const head = shown.length < list.length
    ? `机械预检发现 ${list.length} 处疑点（提示性清单，逐条判定后处理；仅展示前 ${shown.length} 条，省略 ${list.length - shown.length} 条）：`
    : `机械预检发现 ${list.length} 处疑点（提示性清单，逐条判定后处理）：`;
  const rows = shown.map((f, i) => {
    const loc = f.draftLine > 0 ? ` L${f.draftLine}` : '';
    switch (f.kind) {
      case 'number_missing':
        return `${i + 1}.【数值缺失】${f.draftPath}${loc}：源 ${f.sourceToken} L${f.sourceLine}「${f.sourceSnippet}」中的${f.detail}未在草稿对应内容出现`;
      case 'number_added':
        return `${i + 1}.【数值新增】${f.draftPath} L${f.draftLine}「${f.draftSnippet}」出现源中不存在的${f.detail}（对照源 ${f.sourceToken}）`;
      case 'condition_dropped':
        return `${i + 1}.【条件丢失】${f.draftPath} L${f.draftLine}「${f.draftSnippet}」：源句 L${f.sourceLine}「${f.sourceSnippet}」中的${f.detail}未保留`;
      case 'term_variant':
        return `${i + 1}.【术语变体】${f.draftPath} L${f.draftLine}「${f.draftSnippet}」：${f.detail}（不在登记词表）`;
    }
  });
  return [head, ...rows, ...(warn ? [warn] : [])].join('\n');
}
