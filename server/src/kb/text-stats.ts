/**
 * countText — Markdown 字数统计纯函数（P2 §2.1 契约；P1 §4.5 发布回读校验共用）
 *
 * 两个消费方（接线在各自切片，本模块不做 IO / 不依赖注入）：
 * - P2-S2 构建批次预算：effectiveWords 的正文项（设计 §2.2）。结果是调度
 *   估计，不进 manifest、不参与任何哈希。
 * - P1-S8 发布回读校验：countText(body).chars 与云端 profile.char_count
 *   的比值落在 [0.8, 1.25] 即通过（两侧口径必然不同，宽区间只捕捉
 *   「整段丢失 / 转换崩溃」量级错误，阈值见 P1 §4.5）。
 *
 * 预处理规则（P2 §2.1，顺序固定保证确定性）：
 * 1. 去掉文件首部 feishu_sync / feishu_sync_kb 头部注释（与
 *    standard-kb-store.stripStdHeader、sync-engine.generateHtmlHeader 的
 *    现行 YAML-in-HTML-comment 格式一致；IndexScanner 兼容的历史格式
 *    不在本函数职责内）。
 * 2. 图片 ![alt](url) 只计 alt；链接 [t](url) 只计 t（先图片后链接，
 *    避免 `!` 残留混入词元）。
 * 3. 行级处理（围栏状态机）：围栏开/闭行（```/~~~ 前缀）丢弃；围栏内的
 *    内容行原样保留（代码里的 `#`、`|`、`-` 不是 Markdown 标记）。
 * 4. 围栏外每行：循环剥行首 引用 `>` / 标题 `#{1,6} ` / 列表
 *    `-`/`*`/`+`/`1.` 标记；表格分隔行（仅由空白、`|`、`:`、`-` 构成且
 *    含 `-`）整行丢弃；主题分割线 ---/*** 丢弃；其余行去掉所有 `|`
 *    （表格列分隔符不是可见文字）。
 *
 * words：CJK 统一表意字符（Han 脚本）、假名（平假名/片假名）、谚文音节
 * （Hangul）每个码点计 1；其余文本按 [\p{L}\p{N}_'-]+ 连续段每段计 1
 * （连字符/撇号/下划线连写的英文算一个词）。两类不互相吞并：
 * 「abc中def」= 3 词。其他文字（西里尔等）走通用词元正则。
 *
 * chars：预处理后非空白 Unicode 码点数（代理对按 1 个码点计）。
 */

export interface TextStats {
  /** 词数：CJK 单字 + 非 CJK 连续词元 */
  words: number;
  /** 预处理后非空白 Unicode 码点数 */
  chars: number;
}

/** 文件首部 feishu_sync / feishu_sync_kb 头部注释（与 stripStdHeader 同风格）。 */
const HEADER_RE = /^<!--\s*\nfeishu_sync(?:_kb)?:[\s\S]*?\n-->\s*\n?/;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,}) *$/;
const QUOTE_RE = /^ {0,3}> ?/;
const HEADING_RE = /^ {0,3}#{1,6} +/;
const LIST_RE = /^ {0,8}(?:[-*+]|\d{1,9}[.)]) +/;
/** 主题分割线（--- / *** / ___）。 */
const THEMATIC_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,}) *$/;
/** 表格分隔行：整行只含空白、|、:、-（且确有 -）。 */
const TABLE_SEP_RE = /^[\s|:-]+$/;
/** 非 CJK 词元：设计原文 [\p{L}\p{N}_'-]+。 */
const NON_CJK_WORD_RE = /[\p{L}\p{N}_'-]+/gu;
/** CJK 单字切分（Han / 平假名 / 片假名 / 谚文音节），捕获组用于分桶。 */
const CJK_SPLIT_RE = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u;
const CJK_TEST_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const SPACE_RE = /\s/u;

/** 剥围栏外一行的行首 Markdown 标记（嵌套引用/列表前缀循环剥到不动）。 */
function stripLineMarkers(line: string): string {
  let s = line;
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(QUOTE_RE, '').replace(HEADING_RE, '').replace(LIST_RE, '');
  }
  return s;
}

/** Markdown 语法预处理：返回仅含可见文字的纯文本（保留换行结构）。 */
function preprocess(markdown: string): string {
  let text = markdown.replace(HEADER_RE, '');
  text = text.replace(IMAGE_RE, '$1').replace(LINK_RE, '$1');

  const outLines: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        fence = null; // 闭合围栏行丢弃
        continue;
      }
      outLines.push(line); // 围栏内内容原样保留
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length }; // 开围栏行丢弃
      continue;
    }
    let s = stripLineMarkers(line);
    if (THEMATIC_RE.test(s)) continue;
    if (TABLE_SEP_RE.test(s) && s.includes('-')) continue;
    s = s.replace(/\|/g, ' ');
    outLines.push(s);
  }
  return outLines.join('\n');
}

/** 词数：CJK 部分逐码点计，非 CJK 部分按连续词元计。 */
function countWords(text: string): number {
  let words = 0;
  for (const part of text.split(CJK_SPLIT_RE)) {
    if (!part) continue;
    if (CJK_TEST_RE.test(part)) words += [...part].length;
    else words += (part.match(NON_CJK_WORD_RE) ?? []).length;
  }
  return words;
}

export function countText(markdown: string): TextStats {
  const text = preprocess(markdown);
  let chars = 0;
  for (const ch of text) {
    if (!SPACE_RE.test(ch)) chars++;
  }
  return { words: countWords(text), chars };
}
