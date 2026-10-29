/**
 * MarkdownView - 轻量 Markdown 渲染器（v0.2.8 预览面板，v0.2.9 完善图片/表格，v0.3.0 受控 HTML 表格与飞书 cite 引用）
 *
 * 设计约束：项目要求断网可读、零运行时依赖，因此不引入 react-markdown，
 * 自研覆盖同步产物的常见语法子集：
 *   - ATX 标题（# ~ ######）
 *   - ``` 围栏代码块（保留语言标记展示）
 *   - GFM 管道表格（对齐行 `:---` / `:---:` / `---:`、转义 `\|`、缺列自动补齐）
 *   - 块级受控 HTML 表格（保留 colspan / rowspan 合并、vertical-align、内部行内标签、安全白名单）
 *   - 图片：相对路径经 `baseDir` 解析为 kbRoot 相对路径，走鉴权 fetch →
 *     blob → objectURL 渲染（<img> 无法携带 X-Desktop-Token）；远程 URL
 *     直接渲染；加载/失败均有占位态
 *   - 无序/有序列表（按缩进支持嵌套；混合标记逐项保留 ol/ul、起始编号透传 <ol start>、
 *     任务列表 `[ ]`/`[x]` 渲染勾选框、缩进续行归并前项）
 *   - 引用块、水平线、段落（中文硬换行无空格拼接）
 *   - 块级 <details>/<summary>（sheet A 型元数据）与 <callout>（飞书提示块，
 *     emoji + 底色）受控渲染
 *   - 行内：**粗体** / *斜体*（侧边界约束，`2*3*4` 不误判）/ ~~删除线~~ / `行内码` / [链接](url) / 图片
 *     （链接/图片目标尾随 title 剥离，不污染 src/href）
 *   - 飞书 cite 引用超链接（`<cite doc-id="..." title="...">` 打开外部 wiki）
 *   - 行内常见 HTML 标记（`<b>`, `<i>`, `<br>`, `<a>`, `<span style>`（白名单样式）,
 *     `<u>`, `<mark>`, `<sub>`, `<sup>`, `<font color>`（白名单色） 等）
 *
 * 同步产物适配（media-reference.ts 的改写约定）：
 *   - 剥掉 `<synced-source>...</synced-source>` 包裹标签
 *   - `<whiteboard token="images/a.jpg"/>` 等已被改写为本地路径的 XML
 *     媒体标签（含包裹式 `<whiteboard …>…</whiteboard>`）转换为 Markdown 图片
 *     语法再解析；file/source 的本地附件路径转为可点击链接
 *   - 所有预处理替换区分 ``` 围栏代码块（代码内容不参与替换）；
 *     `<sheet>`（含无属性裸形态）兑底为提示块
 */

import { Fragment, useEffect, useState, type JSX, type ReactNode } from 'react';
import { ImageIcon, Loader2 } from 'lucide-react';
import { getMediaBlobUrl, getSyncedReference } from '../../api/client';
import {
  decodeHtmlEntities,
  extractHtmlTableBlocks,
  parseHtmlTable,
  parseSafeInlineStyle,
  type HtmlTableBlock,
} from '../../utils/html-table';
import { openExternalUrl, parseCiteTag } from '../../utils/feishu-cite';

// ---------------------------------------------------------------------------
// 同步产物预处理
// ---------------------------------------------------------------------------

/** 已被改写为本地相对路径的 XML 媒体标签（whiteboard/image/img/file/source）。
 *  D19：镜像 sync-engine renderLocalizedMediaReferences 的写法，追加可选的
 *  包裹式内容与闭合标签（`<whiteboard …>板书</whiteboard>`），避免转换后残留
 *  `</whiteboard>` 字面文本。内容限定 `[^<]*`（不含下一个标签），防止无闭合
 *  标签时贪婪吞到后文。 */
const XML_MEDIA_RE =
  /<(whiteboard|image|img|file|source)\b[^>]*?(?:token|src)="([^"]+)"[^>]*?\/?>(?:[^<]*<\/\1\s*>)?/gi;

/** 飞书 token（无路径分隔、无扩展名）保持原文；本地路径（含 / 或扩展名）可转附件链接（D3）。 */
function looksLikeLocalAttachment(src: string): boolean {
  if (isRemoteUrl(src) || src.includes('://')) return false;
  return src.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(src);
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

// ---------------------------------------------------------------------------
// 链接协议白名单（F2 安全修复：不可信内容防 javascript:/data: 等注入）
// ---------------------------------------------------------------------------

/** 允许外链的协议白名单（https/http 外部导航 + mailto 邮件）。 */
const HREF_PROTOCOL_ALLOWLIST = new Set(['http:', 'https:', 'mailto:']);

/**
 * 净化不可信 Markdown/HTML 里的链接 href。
 *
 * 输入可能是同步产物、标准库 AI 生成文档或 Agent 输出——全部按不可信
 * 文本对待。规则（Leader 审查修正）：
 *   1. 先做 HTML 实体解码（`&#106;avascript:` 实体混淆）；
 *   2. 剥离 C0/DEL 字符并去首尾空白；协议探测额外忽略内部空格，保留合法相对文件名空格；
 *   3. 解析出 scheme（`^[a-z][a-z0-9+.-]*:`，含 `//` 形式）；
 *   4. scheme 不在白名单 → 返回 null；无 scheme（相对路径/锚点）→ 放行
 *      （相对路径在本应用内不会执行脚本，`.csv` 相对导航由上层拦截）。
 *
 * 返回净化后的 href（原始非空白的字符串，实体已解码）；拒绝时返回 null，
 * 调用方降级为纯文本展示，不渲染 <a>。
 */
export function sanitizeHref(raw: string): string | null {
  if (!raw) return null;
  // 1) 实体解码（markdown 源可能携带；重复解码是幂等安全的展示层行为）。
  //    另移除空白类命名实体（&Tab;/&NewLine; 等，decodeHtmlEntities 不覆盖）
  //    ——它们等效于控制字符切片绕过（java&Tab;script:）。
  let href = decodeHtmlEntities(raw).replace(/&(tab|newline|nonbreakingspace);/gi, '');
  // 2) 剥离控制字符与内部空白（防止 scheme 解析被切片绕过）
  // C0/control 字符浏览器会忽略；普通内部空格属于合法文件名，不能把「经济 模型.csv」改名。
  href = href.replace(/[\x00-\x1f\x7f]+/g, '').trim();
  if (!href) return null;
  // 3) scheme 解析：形如 scheme: 或 //host
  const probe = href.replace(/ /g, '');
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (schemeMatch) {
    const actualScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
    return actualScheme && HREF_PROTOCOL_ALLOWLIST.has(actualScheme[1].toLowerCase() + ':') ? href : null;
  }
  if (probe.replace(/\\/g, '/').startsWith('//')) return null; // 包含浏览器视作 // 的反斜杠混合形式
  return href; // 相对路径 / 锚点
}

/** 链接被拦截时的降级展示（可读、可解释，不伪装成可点击）。 */
function BlockedLink({ label }: { label: React.ReactNode }) {
  return (
    <span
      className="text-ink-faint underline decoration-dotted cursor-not-allowed"
      title="已拦截：链接协议不被允许"
    >
      {label}
    </span>
  );
}

function looksLikeLocalMedia(src: string): boolean {
  return (
    !isRemoteUrl(src) &&
    !src.includes('://') &&
    /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(src)
  );
}

/** Convert simple exported HTML lists while preserving item order and nesting. */
function convertHtmlLists(text: string, stack: Array<{ ordered: boolean; next: number }>): string {
  return text.replace(/<(\/?)(ul|ol|li)\b([^>]*)>/gi, (tag, slash: string, type: string, attrs: string) => {
    const kind = type.toLowerCase();
    if (kind === 'ul' || kind === 'ol') {
      if (slash) { if (!stack.length) return tag; stack.pop(); }
      else stack.push({ ordered: kind === 'ol', next: 1 });
      return '\n';
    }
    const list = stack[stack.length - 1];
    if (!list) return tag;
    if (slash) return '\n';
    const explicit = /(?:^|\s)seq\s*=\s*["']?(\d+)/i.exec(attrs);
    const number = explicit ? Number(explicit[1]) : list.next;
    list.next = number + 1;
    return `\n${'  '.repeat(stack.length - 1)}${list.ordered ? `${number}.` : '-'} `;
  });
}

/**
 * preprocess：同步产物预处理。
 *
 * D2（2026-10 T2a-r）：所有全文替换必须区分 ``` 围栏代码块——代码块内的
 * `<!-- -->` 注释、`<table>`、`<sheet>`、媒体标签都是展示内容的一部分，
 * 替换会破坏代码块原文，未闭合 `<!--` 更会跨围栏非贪婪匹配吞掉正文与闭栏。
 * 因此先按围栏切段，仅对非代码段执行替换（开栏 /^```/、闭栏 /^```\s*$/
 * 与 parseBlocks 保持同一套规则）。 */
export function preprocess(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let textBuf: string[] = [];
  let inFence = false;
  const flushText = () => {
    if (textBuf.length > 0) {
      out.push(transformTextSegment(textBuf.join('\n')));
      textBuf = [];
    }
  };
  for (const line of lines) {
    if (!inFence && /^```/.test(line)) {
      flushText();
      inFence = true;
      out.push(line);
      continue;
    }
    if (inFence && /^```\s*$/.test(line)) {
      out.push(line);
      inFence = false;
      continue;
    }
    if (inFence) out.push(line);
    else textBuf.push(line);
  }
  flushText();
  return out.join('\n');
}

/** 仅作用于非代码段的一系列产物适配替换。 */
function transformTextSegment(text: string): string {
  let out = text;
  // 飞书文档标题与布局包装属于导出语义，保留实际文字并按 Markdown 排版。
  // 区分行内代码，避免改写代码示例；围栏代码已在 preprocess 中隔离。
  let tableDepth = 0;
  const listStack: Array<{ ordered: boolean; next: number }> = [];
  out = out.split(/(`+[^`\n]*`+)/g).map((part, index) => {
    if (index % 2) return part;
    const withoutHtmlParagraphs = part.split(/(<\/?table\b[^>]*>)/gi).map((piece) => {
      if (/^<table\b/i.test(piece)) { tableDepth++; return piece; }
      if (/^<\/table\b/i.test(piece)) { tableDepth = Math.max(0, tableDepth - 1); return piece; }
      if (tableDepth) return piece;
      return convertHtmlLists(piece
        .replace(/<h([1-6])\b[^>]*>([^<\n]*)<\/h\1\s*>/gi, (_all, level: string, title: string) => `\n\n${'#'.repeat(Number(level))} ${decodeHtmlEntities(title.trim())}\n\n`)
        .replace(/<\/?p\b[^>]*>/gi, '\n\n'), listStack);
    }).join('');
    return withoutHtmlParagraphs
      .replace(/^\s*<title\b[^>]*>([^\n<]*)<\/title\s*>\s*$/gim, (_all, title: string) => `\n# ${decodeHtmlEntities(title.trim())}\n`)
      .replace(/<\/?(?:grid|column|figure|fragment)\b[^>]*>/gi, '\n\n')
      .replace(/<agenda\b[^>]*>\s*<\/agenda\s*>/gi, '\n\n> 议程内容未包含在本地导出中。\n\n')
      .replace(/<\/?sub-page-list\b[^>]*>/gi, '\n\n')
      .replace(/<sub-page\b([^>]*?)\s*\/>/gi, (_all, attrs: string) => {
        const title = /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
        const text = decodeHtmlEntities(title?.[1] ?? title?.[2] ?? '未命名子页面');
        return `\n- ${text.replace(/([\\`*_[\]])/g, '\\$1')}\n`;
      })
      .replace(/<synced_reference\b([^>]*?)>([\s\S]*?)<\/synced_reference\s*>/gi,
        (_all, attrs: string, inner: string) => inner.trim() ? `\n\n${inner}\n\n` : `\n\n<synced_reference${attrs}></synced_reference>\n\n`)
      .replace(/<synced_reference\b([^>]*?)\/\s*>/gi,
        (_all, attrs: string) => `\n\n<synced_reference${attrs}></synced_reference>\n\n`);
  }).join('');
  // 1) XML 媒体标签 → Markdown 图片/附件链接（仅当属性值已是本地相对路径；
  //    仍是飞书 token 的保留原文，避免渲染出坏图）。
  //    D3：file/source 的本地非图片路径（attachments/*.pdf 等）转可点击
  //    链接——消费端兜底，同时覆盖自定义归档链路的历史产物。
  out = out.replace(XML_MEDIA_RE, (whole, tag: string, target: string) => {
    if (looksLikeLocalMedia(target)) return `![媒体](${target})`;
    if (/^(?:file|source)$/i.test(tag) && looksLikeLocalAttachment(target)) {
      return `[${basenameOf(target)}](${target})`;
    }
    return whole;
  });
  // 2) 剥掉 <synced-source> 包裹标签（保留内部内容）。
  out = out.replace(/<\/?synced-source\b[^>]*>/gi, '');
  out = out.replace(/<whiteboard\b[^>]*?(?:\/\s*>|>\s*<\/whiteboard\s*>)/gi,
    '\n\n> 此白板尚未同步到本地，请查看飞书原文。\n\n');
  // 3) 剥掉 HTML 注释（含文件首部的 feishu_sync YAML-in-comment 头，
  //    真实 Markdown 渲染器同样不展示注释）；未闭合的 <!-- 只去标记不吞正文
  //    （D2：避免非贪婪匹配吃到后文 --> 而丢大段内容）。
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<!--/g, '');
  // 4) 为紧贴其它行内或块级内容的 <table> 标签注入独立段落换行，避免被段落粘连
  out = out.replace(/([^\n])\s*(<table[\s>])/gi, '$1\n\n$2');
  out = out.replace(/(<\/table>)\s*([^\n])/gi, '$1\n\n$2');
  // 5) 飞书内嵌 sheet 标签兜底（2026-09-04）：docx 正文中的
  //    <sheet sheet-id="..." token="..."></sheet> 引用若未被同步链路
  //    展开（历史产物 / 展开失败保留原标签），优雅降级为提示块而非
  //    裸 XML。新同步产物已在服务端展开为「## 子表:」段（见
  //    sync-engine expandInlineSheetTags）。
  //    D18：容忍无属性裸 <sheet></sheet> / 自闭合形态。
  out = out.replace(
    /<sheet\b([^>]*?)\/?>\s*(?:<\/sheet\s*>)?/gi,
    (_whole: string, attrs: string) => {
      const sheetId = /sheet-id="([^"]*)"/.exec(attrs)?.[1] ?? '';
      const token = /token="([^"]*)"/.exec(attrs)?.[1] ?? '';
      return `\n\n> 【内嵌子表】sheet-id: ${sheetId || '未知'}${token ? ` · token: ${token}` : ''}。触发重新同步本文档可展开为完整表格。\n\n`;
    },
  );
  return out;
}

// ---------------------------------------------------------------------------
// 鉴权图片组件
// ---------------------------------------------------------------------------

interface AuthImageProps {
  /** Markdown 中的原始 src（相对 md 文件目录或远程 URL）。 */
  src: string;
  alt: string;
  /** md 文件所在目录（kbRoot 相对），用于解析相对 src。 */
  baseDir: string;
  /**
   * 远程图片策略（F2 安全修复）：
   *   - 'auto'：旧行为，远程 URL 直接交给 <img> 自动加载（既有预览面兼容）；
   *   - 'confirm'：不可信内容默认不自动加载外部图片（防止把源内容
   *     编码进 URL 经浏览器外发），渲染占位卡片，用户点击后本次加载。
   * 本地受认证资源（kbRoot 相对路径）不受此策略影响——它们只经唯一
   * API 出口（getMediaBlobUrl）取本机服务，不携带凭据到远程。
   */
  remotePolicy?: 'auto' | 'confirm';
}

export function resolveMediaPath(src: string, baseDir: string): string {
  // Win 产物防御（2026-09-04 浮动图片修复）：历史/异构产物中图片引用
  // 可能携带反斜杠分隔（`images\主表_A7.png`），先归一到 POSIX 再拼接，
  // 否则 split('/') 会把整段当成单 segment，服务端 404。
  const cleaned = src.replace(/^\.\//, '').replace(/\\/g, '/');
  const normalizedBase = baseDir.replace(/\\/g, '/');
  const segments = [...normalizedBase.split('/').filter(Boolean), ...cleaned.split('/')];
  // 归一化 ..（图片引用可能指向上级目录）
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

/** 授权只对当前 URL 生效，组件复用或文档切换不能把上一次点击授权转给另一资源。 */
export function needsRemoteImageConsent(src: string, policy: 'auto' | 'confirm', authorizedSrc: string | null): boolean {
  return isRemoteUrl(src) && policy === 'confirm' && authorizedSrc !== src;
}

function AuthImage({ src, alt, baseDir, remotePolicy = 'auto' }: AuthImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [failureDetail, setFailureDetail] = useState<string>('');
  const [authorizedRemoteSrc, setAuthorizedRemoteSrc] = useState<string | null>(null);

  useEffect(() => {
    setFailed(false);
    setFailureDetail('');
    if (isRemoteUrl(src)) {
      // 远程 URL：直接交给 <img>，不经任何鉴权 fetch —— 永不把
      // X-Desktop-Token 附到远程请求（安全不变量，勿改为 fetch+headers）。
      setBlobUrl(src);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    getMediaBlobUrl(resolveMediaPath(src, baseDir))
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setBlobUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFailed(true);
          // 失败可见化（win 浮动图片排查）：带出解析后的 kbRoot 相对路径
          // 与 HTTP 状态，真机一眼定位是路径错位还是文件缺失。
          setFailureDetail(
            `${resolveMediaPath(src, baseDir)}（${err instanceof Error ? err.message : String(err)}）`,
          );
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, baseDir]);

  // 远程图片且策略为 confirm 且未授权：占位，不自动加载（不发起任何请求）。
  // 注意：所有 hooks 必须在本分支之前调用完毕（条件 return 不能早于 hook）。
  if (needsRemoteImageConsent(src, remotePolicy, authorizedRemoteSrc)) {
    let host = src;
    try {
      host = new URL(src).host;
    } catch {
      /* 保留原文 */
    }
    return (
      <span className="my-2 flex items-center gap-2 rounded-md border border-dashed border-line bg-paper-2/50 px-3 py-3 text-xs text-ink-faint">
        <ImageIcon className="w-4 h-4 shrink-0" />
        <span className="min-w-0">外部图片（{host}）不会自动加载</span>
        <button
          type="button"
          onClick={() => setAuthorizedRemoteSrc(src)}
          className="shrink-0 px-2 py-0.5 rounded-sm border border-jade/40 text-jade hover:bg-jade/10 transition-colors"
        >
          点击加载
        </button>
      </span>
    );
  }

  if (failed) {
    return (
      <span
        className="my-2 flex items-center gap-2 rounded-md border border-dashed border-line bg-paper-2/50 px-4 py-6 text-xs text-ink-faint"
        title={failureDetail || src}
      >
        <ImageIcon className="w-4 h-4 shrink-0" />
        图片加载失败：{alt || src}
        {failureDetail && <span className="text-[10px] font-mono">{failureDetail}</span>}
      </span>
    );
  }
  if (!blobUrl) {
    return (
      <span className="my-2 flex items-center justify-center gap-2 rounded-md border border-line/60 bg-paper-2/40 px-4 py-8 text-xs text-ink-faint">
        <Loader2 className="w-4 h-4 animate-spin" />
        图片加载中…
      </span>
    );
  }
  return (
    <img
      src={blobUrl}
      alt={alt}
      title={alt || src}
      className="my-2 max-w-full rounded-md border border-line/60 shadow-sm"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

// 支持 Markdown 原生标记 + 飞书 cite 标签 + 常用行内 HTML (b/i/br/del/code/a/span)
// URL 段允许一层成对括号嵌套（2026-09-04 浮动图片修复）：同步产物文件名
// 可含半角括号（如 `③-1(Framwork)分析拆解（确定复杂度）_B63_x.png`），
// 旧模式 [^)\n]* 会在文件名内首个 `)` 截断 src（mac/win 同现「图片加载
// 失败：③-1(Framwork)…」实测）。嵌套组对齐 CommonMark 平衡括号规则；
// 无括号 URL 行为不变。
// D10（2026-10 T2a-r）：扩充 u/ins/mark/sub/sup/font 行内白名单。
// D16：*斜体* 加侧边界 `(?<![\w*])…(?![\w*])`，避免 `2*3*4` 这类乘号
// 文本被误判斜体（ASCII 词内斜体同步让渡，与 CJK 强调不冲突）。
const INLINE_RE =
  /(!\[.*?\]\((?:[^()\n]|\([^()\n]*\))*\))|(\[.*?\]\((?:[^()\n]|\([^()\n]*\))*\))|(\*\*(?:\\.|[^*\\\n])+\*\*)|((?<![\w*])\*(?:\\.|[^*\\\n])+\*(?![\w*]))|(~~(?:\\.|[^~\\])+~~)|(`[^`]+`)|(<cite\b[^>]*>(?:[\s\S]*?<\/cite>)?|<cite\b[^>]*\/>)|(<(?:b|strong)\b[^>]*>[\s\S]*?<\/(?:b|strong)>)|(<(?:i|em)\b[^>]*>[\s\S]*?<\/(?:i|em)>)|(<br\s*\/?>)|(<(?:del|s)\b[^>]*>[\s\S]*?<\/(?:del|s)>)|(<code\b[^>]*>[\s\S]*?<\/code>)|(<a\b[^>]*>[\s\S]*?<\/a>)|(<span\b[^>]*>[\s\S]*?<\/span>)|(<(?:u|ins)\b[^>]*>[\s\S]*?<\/(?:u|ins)>)|(<mark\b[^>]*>[\s\S]*?<\/mark>)|(<(?:sub|sup)\b[^>]*>[\s\S]*?<\/(?:sub|sup)>)|(<font\b[^>]*>[\s\S]*?<\/font>)/gi;

/** 剥离 CommonMark 链接/图片目标的尾随 title（` "标题"` / `'标题'` / `(标题)`）。
 *  D15：未剥离时 title 会拼进 src/href，鉴权 fetch 404 → 「图片加载失败」。 */
function stripMdTitle(dest: string): string {
  return dest.replace(/\s+(?:"[^"]*"|'[^']*'|\([^()\n]*\))$/, '');
}

/** <font color> 白名单：仅十六进制色与常见命名色，其余降级为无样式文本。 */
const FONT_COLOR_RE =
  /^(?:#[0-9a-fA-F]{3,8}|red|crimson|firebrick|darkred|orange|orangered|tomato|gold|amber|yellow|olive|lime|green|seagreen|teal|cyan|skyblue|blue|navy|indigo|purple|violet|magenta|pink|brown|sienna|gray|grey|slategray|black|white)$/;

/** 还原 GFM 反斜杠转义与 HTML 实体，只作用于展示文本 */
function unescapeInline(s: string): string {
  const unescaped = s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  return decodeHtmlEntities(unescaped);
}

interface InlineContext {
  baseDir: string;
  onNavigateCsv?: (href: string) => boolean;
  feishuHost?: string;
  /** 远程图片策略（见 AuthImageProps.remotePolicy）；默认 'auto' 保留旧行为。 */
  remoteImages?: 'auto' | 'confirm';
  resolveSyncedReferences?: boolean;
}

export function renderInline(text: string, keyPrefix: string, ctx: InlineContext): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;

  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(unescapeInline(text.slice(last, idx)));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;

    if (token.startsWith('![')) {
      // 1. Markdown 图片（D15：剥离尾随 title，防止污染 src）
      const close = token.indexOf('](');
      const alt = unescapeInline(token.slice(2, close));
      const src = stripMdTitle(token.slice(close + 2, -1));
      out.push(
        <AuthImage
          key={key}
          src={src}
          alt={alt}
          baseDir={ctx.baseDir}
          remotePolicy={ctx.remoteImages ?? 'auto'}
        />,
      );
    } else if (token.startsWith('[')) {
      // 2. Markdown 链接（协议白名单：拒绝 javascript:/data:/vbscript: 与
      //    实体/控制字符混淆；拒绝时降级为纯文本，不渲染 <a>）
      const close = token.indexOf('](');
      const label = unescapeInline(token.slice(1, close));
      const rawHref = stripMdTitle(token.slice(close + 2, -1));
      const safeHref = sanitizeHref(rawHref);
      if (!safeHref) {
        out.push(<BlockedLink key={key} label={label} />);
      } else {
        const isCsv =
          !isRemoteUrl(safeHref) && safeHref.split(/[?#]/)[0].toLowerCase().endsWith('.csv');
        out.push(
          <a
            key={key}
            href={safeHref}
            target={isCsv ? undefined : '_blank'}
            rel={isCsv ? undefined : 'noopener noreferrer'}
            onClick={(e) => {
              if (isCsv && ctx.onNavigateCsv) {
                const handled = ctx.onNavigateCsv(safeHref);
                if (handled) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }
            }}
            className="text-jade hover:text-seal underline underline-offset-2 decoration-line hover:decoration-seal transition-colors cursor-pointer"
          >
            {label}
          </a>,
        );
      }
    } else if (token.startsWith('**')) {
      // 3. Markdown 粗体
      out.push(
        <strong key={key} className="font-semibold text-ink">
          {unescapeInline(token.slice(2, -2))}
        </strong>,
      );
    } else if (token.startsWith('~~')) {
      // 4. Markdown 删除线
      out.push(
        <del key={key} className="text-ink-faint">
          {unescapeInline(token.slice(2, -2))}
        </del>,
      );
    } else if (token.startsWith('`')) {
      // 5. Markdown 行内代码
      out.push(
        <code
          key={key}
          className="px-1 py-0.5 mx-0.5 rounded-sm bg-paper-2 border border-line/60 text-[0.85em] text-seal font-mono"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (/^<cite\b/i.test(token)) {
      // 6. 飞书 cite 标签（需求 2）
      const parsedCite = parseCiteTag(token, ctx.feishuHost);
      if (parsedCite.url) {
        out.push(
          <a
            key={key}
            href={parsedCite.url}
            title={parsedCite.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openExternalUrl(parsedCite.url!);
            }}
            className="text-blue-600 hover:text-blue-700 underline underline-offset-2 decoration-blue-300 hover:decoration-blue-500 cursor-pointer transition-colors"
          >
            {parsedCite.displayText}
          </a>,
        );
      } else if (parsedCite.displayText) {
        out.push(
          <span key={key} className="text-ink-soft">
            {parsedCite.displayText}
          </span>,
        );
      }
    } else if (/^<(?:b|strong)\b/i.test(token)) {
      // 7. HTML 粗体
      const inner = token.replace(/^<(?:b|strong)\b[^>]*>/i, '').replace(/<\/(?:b|strong)>$/i, '');
      out.push(
        <strong key={key} className="font-semibold text-ink">
          {renderInline(inner, `${key}-b`, ctx)}
        </strong>,
      );
    } else if (/^<(?:i|em)\b/i.test(token)) {
      // 8. HTML 斜体
      const inner = token.replace(/^<(?:i|em)\b[^>]*>/i, '').replace(/<\/(?:i|em)>$/i, '');
      out.push(
        <em key={key} className="text-ink-soft">
          {renderInline(inner, `${key}-i`, ctx)}
        </em>,
      );
    } else if (/^<br\s*\/?>/i.test(token)) {
      // 9. HTML 换行
      out.push(<br key={key} />);
    } else if (/^<(?:del|s)\b/i.test(token)) {
      // 10. HTML 删除线
      const inner = token.replace(/^<(?:del|s)\b[^>]*>/i, '').replace(/<\/(?:del|s)>$/i, '');
      out.push(
        <del key={key} className="text-ink-faint">
          {renderInline(inner, `${key}-d`, ctx)}
        </del>,
      );
    } else if (/^<code\b/i.test(token)) {
      // 11. HTML <code>
      const inner = token.replace(/^<code\b[^>]*>/i, '').replace(/<\/code>$/i, '');
      out.push(
        <code
          key={key}
          className="px-1 py-0.5 mx-0.5 rounded-sm bg-paper-2 border border-line/60 text-[0.85em] text-seal font-mono"
        >
          {decodeHtmlEntities(inner)}
        </code>,
      );
    } else if (/^<a\b/i.test(token)) {
      // 12. HTML 链接（同一协议白名单；实体/控制字符混淆在此一并拦截）
      //     D11：非引号分支字符类修正为 [^\s>]（旧写法 `[^\\s>]` 误排除字面 s，
      //     `https://…` 在首个 s 截断）
      const hrefM = token.match(/\bhref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const rawHref = hrefM ? hrefM[1] ?? hrefM[2] ?? hrefM[3] ?? '' : '';
      const safeHref = sanitizeHref(rawHref);
      const inner = token.replace(/^<a\b[^>]*>/i, '').replace(/<\/a>$/i, '');
      if (!safeHref) {
        out.push(<BlockedLink key={key} label={renderInline(inner, `${key}-a`, ctx)} />);
      } else {
        const isCsv =
          !isRemoteUrl(safeHref) && safeHref.split(/[?#]/)[0].toLowerCase().endsWith('.csv');
        out.push(
          <a
            key={key}
            href={safeHref}
            target={isCsv ? undefined : '_blank'}
            rel={isCsv ? undefined : 'noopener noreferrer'}
            onClick={(e) => {
              if (isCsv && ctx.onNavigateCsv) {
                const handled = ctx.onNavigateCsv(safeHref);
                if (handled) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }
            }}
            className="text-jade hover:text-seal underline underline-offset-2 decoration-line hover:decoration-seal transition-colors cursor-pointer"
          >
            {renderInline(inner, `${key}-a`, ctx)}
          </a>,
        );
      }
    } else if (/^<span\b/i.test(token)) {
      // 13. HTML span（D12：style 经 parseSafeInlineStyle 白名单解析，
      //     保留 color/font-weight 等安全子集；危险值整体剥离）
      const styleM = /\bstyle\s*=\s*["']([^"']*)["']/i.exec(token);
      const safeStyle = styleM ? parseSafeInlineStyle(styleM[1]) : undefined;
      const hasStyle = !!safeStyle && Object.keys(safeStyle).length > 0;
      const inner = token.replace(/^<span\b[^>]*>/i, '').replace(/<\/span>$/i, '');
      out.push(
        <span key={key} style={hasStyle ? safeStyle : undefined}>
          {renderInline(inner, `${key}-sp`, ctx)}
        </span>,
      );
    } else if (/^<(?:u|ins)\b/i.test(token)) {
      // 13a. HTML 下划线（D10）
      const inner = token.replace(/^<(?:u|ins)\b[^>]*>/i, '').replace(/<\/(?:u|ins)>$/i, '');
      out.push(
        <u key={key} className="underline">
          {renderInline(inner, `${key}-u`, ctx)}
        </u>,
      );
    } else if (/^<mark\b/i.test(token)) {
      // 13b. HTML 高亮（D10）
      const inner = token.replace(/^<mark\b[^>]*>/i, '').replace(/<\/mark>$/i, '');
      out.push(
        <mark key={key} className="rounded-sm bg-amber-100 px-0.5 text-ink">
          {renderInline(inner, `${key}-mk`, ctx)}
        </mark>,
      );
    } else if (/^<(?:sub|sup)\b/i.test(token)) {
      // 13c. HTML 上下标（D10）
      const isSub = /^<sub\b/i.test(token);
      const inner = token
        .replace(/^<s(?:ub|up)\b[^>]*>/i, '')
        .replace(/<\/s(?:ub|up)>$/i, '');
      const SubSupTag = isSub ? 'sub' : 'sup';
      out.push(<SubSupTag key={key}>{renderInline(inner, `${key}-ss`, ctx)}</SubSupTag>);
    } else if (/^<font\b/i.test(token)) {
      // 13d. HTML font（D10：仅白名单 color，其余属性丢弃、内容保留）
      const color = /\bcolor\s*=\s*["']?([^"'\s>]+)["']?/i.exec(token)?.[1] ?? '';
      const inner = token.replace(/^<font\b[^>]*>/i, '').replace(/<\/font>$/i, '');
      const safeColor = FONT_COLOR_RE.test(color) ? color : undefined;
      out.push(
        <span key={key} style={safeColor ? { color: safeColor } : undefined}>
          {renderInline(inner, `${key}-f`, ctx)}
        </span>,
      );
    } else {
      // 14. Markdown *斜体*
      out.push(
        <em key={key} className="text-ink-soft">
          {unescapeInline(token.slice(1, -1))}
        </em>,
      );
    }
    last = idx + token.length;
  }

  if (last < text.length) out.push(unescapeInline(text.slice(last)));
  return out;
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

type TableAlign = 'left' | 'center' | 'right';

/** 列表项数据：ordered/num 记录逐项标记类型与起始序号（D6/D7），
 *  供渲染层按缩进递归构嵌套树。 */
export interface ListItemData {
  indent: number;
  text: string;
  ordered: boolean;
  num?: number;
}

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'table'; header: string[]; aligns: TableAlign[]; rows: string[][] }
  | HtmlTableBlock
  | { type: 'list'; ordered: boolean; items: ListItemData[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string }
  | { type: 'synced_reference'; token: string; blockId: string }
  // D1：sheet A 型元数据 <details> 块受控渲染（原生折叠，summary 经行内解析）
  | { type: 'details'; summary: string; blocks: Block[] }
  // D9：飞书 <callout> 提示块受控渲染（emoji + 底色，内容递归块解析）
  | { type: 'callout'; emojiId: string; background: string; blocks: Block[] };

/** CJK 字符范围：CJK 符号/假名/汉字/全角形式。用于硬换行拼接判定（D13）。 */
const CJK_CHAR_RE = /[\u3000-\u9fff\uff00-\uffef]/;

/** 拼接两段文本：两侧边界均为 CJK 时不加空格，否则保留单空格（D13）。 */
function appendCjkAware(base: string, extra: string): string {
  const prev = base[base.length - 1] ?? '';
  const next = extra[0] ?? '';
  return base + (CJK_CHAR_RE.test(prev) && CJK_CHAR_RE.test(next) ? extra : ` ${extra}`);
}

/** 段落多行拼接（D13：替代 buf.join(' ')，中文句中不再插入多余空格）。 */
function joinParagraphLines(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (out === '') out = line;
    else if (line !== '') out = appendCjkAware(out, line);
  }
  return out;
}

/** 列表项缩进续行判定（D8）：缩进的普通行归并前项，块起点行除外。 */
function isListContinuationLine(line: string): boolean {
  if (!line || !line.trim()) return false;
  if (!/^[ \t]/.test(line)) return false;
  const t = line.trim();
  if (/^#{1,6}\s/.test(t)) return false;
  if (t.startsWith('```')) return false;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return false;
  if (/^([-*+]|\d+[.)])\s/.test(t)) return false; // 列表项由主正则处理
  if (/^<(?:table|details|callout)\b/i.test(t)) return false;
  return true;
}

/** 行内 <table> 开/闭标签深度差（D17：嵌套表格按深度匹配）。 */
function tableDepthDelta(line: string): number {
  const opens = (line.match(/<table\b/gi) ?? []).length;
  const closes = (line.match(/<\/table\s*>/gi) ?? []).length;
  return opens - closes;
}

/** 按未转义的 | 切分单元格（`\|` 是字面竖线，不是分隔符）。 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 判断是否为 GFM 表格分隔行，并解析各列对齐方式。 */
function parseTableSeparator(line: string): TableAlign[] | null {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed.includes('-')) return null;
  const parts = trimmed.split('|').map((p) => p.trim());
  if (parts.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const part of parts) {
    if (!/^:?-+:?$/.test(part)) return null;
    const left = part.startsWith(':');
    const right = part.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return aligns;
}

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 围栏代码块（D14：info string 容忍含空格/属性，取整行为语言标记）
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang: (fence[1] ?? '').trim(), lines: buf });
      continue;
    }

    const reference = line.match(/^\s*<synced_reference\b([^>]*)>\s*<\/synced_reference\s*>\s*$/i);
    if (reference) {
      const attr = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(reference[1]);
      const token = attr('src-token'), block = attr('src-block-id');
      blocks.push({ type: 'synced_reference', token: token?.[1] ?? token?.[2] ?? '', blockId: block?.[1] ?? block?.[2] ?? '' });
      i++;
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: heading[2].trim(),
      });
      i++;
      continue;
    }

    // 水平线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // D9：块级 <callout>（飞书提示块）受控解析——emoji 与底色保留，
    // 内容递归 parseBlocks；未闭合时宽容收集到末尾（不泄漏裸标签）
    const calloutOpen = line.match(/^\s*<callout\b([^>]*)>/i);
    if (calloutOpen) {
      const attrs = calloutOpen[1] ?? '';
      const emojiId = /emoji-id\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
      const background = /background-color\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
      const buf: string[] = [];
      const selfClosed = /\/\s*$/.test(attrs);
      const first = line.slice(calloutOpen[0].length).trim();
      if (!selfClosed) {
        if (first) buf.push(first);
        i++;
        while (i < lines.length) {
          const closeM = /<\/callout\s*>/i.exec(lines[i]);
          if (closeM && closeM.index !== undefined) {
            const before = lines[i].slice(0, closeM.index).trim();
            if (before) buf.push(before);
            i++;
            break;
          }
          buf.push(lines[i]);
          i++;
        }
      } else {
        i++;
      }
      blocks.push({ type: 'callout', emojiId, background, blocks: parseBlocks(buf.join('\n')) });
      continue;
    }

    // D1：块级 <details>（sheet A 型元数据产物）受控折叠渲染
    if (/^\s*<details\b[^>]*>/i.test(line)) {
      const buf: string[] = [];
      const first = line.replace(/^\s*<details\b[^>]*>/i, '').trim();
      if (first) buf.push(first);
      i++;
      while (i < lines.length) {
        const closeIdx = lines[i].search(/<\/details\s*>/i);
        if (closeIdx !== -1) {
          const before = lines[i].slice(0, closeIdx).trim();
          if (before) buf.push(before);
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      const raw = buf.join('\n');
      const summaryM = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(raw);
      const inner = (summaryM ? raw.replace(summaryM[0], '') : raw).trim();
      blocks.push({
        type: 'details',
        summary: summaryM ? summaryM[1].trim() : '',
        blocks: parseBlocks(inner),
      });
      continue;
    }

    // 块级 HTML 表格（需求 1；D17：嵌套表格按 <table> 深度匹配，
    // 内层 </table> 不再提前闭块导致外层残片泄漏）
    if (/^\s*<table[\s>]/i.test(line)) {
      const tableLines: string[] = [line];
      let depth = tableDepthDelta(line);
      i++;
      while (i < lines.length && depth > 0) {
        tableLines.push(lines[i]);
        depth += tableDepthDelta(lines[i]);
        i++;
      }
      const rawHtml = tableLines.join('\n');
      const tableBlock = parseHtmlTable(rawHtml);
      if (tableBlock) {
        blocks.push(tableBlock);
        continue;
      }
    }

    // GFM 管道表格：当前行含 | 且下一行是合法分隔行
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseTableSeparator(lines[i + 1]);
      if (aligns) {
        const header = splitTableRow(line);
        const rows: string[][] = [];
        i += 2;
        while (
          i < lines.length &&
          lines[i].includes('|') &&
          lines[i].trim() !== ''
        ) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        const width = Math.max(header.length, aligns.length);
        while (header.length < width) header.push('');
        while (aligns.length < width) aligns.push('left');
        for (const row of rows) {
          while (row.length < width) row.push('');
        }
        blocks.push({ type: 'table', header, aligns, rows });
        continue;
      }
    }

    // 列表（按缩进嵌套；D6：逐项记录标记序号；D8：缩进续行归并前项）
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      const items: ListItemData[] = [];
      while (i < lines.length) {
        const lm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (lm) {
          const ordered = /^\d/.test(lm[2]);
          items.push({
            indent: lm[1].length,
            text: lm[3],
            ordered,
            num: ordered ? parseInt(lm[2], 10) : undefined,
          });
          i++;
          continue;
        }
        // D8：缩进普通行（图片/文本）归并前一项，避免脱离列表项；
        // 紧随的 GFM 表格（含分隔行）仍按独立块结束列表
        const isInlineTableStart =
          lines[i].includes('|') &&
          i + 1 < lines.length &&
          parseTableSeparator(lines[i + 1]) !== null;
        if (items.length > 0 && isListContinuationLine(lines[i]) && !isInlineTableStart) {
          const prev = items[items.length - 1];
          items[items.length - 1] = { ...prev, text: appendCjkAware(prev.text, lines[i].trim()) };
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered: items[0]?.ordered ?? false, items });
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: buf });
      continue;
    }

    // 段落：合并连续普通行（遇到标题、代码块、引用、列表、分隔线、HTML 表格、
    // details/callout 块停止）
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) &&
      !/^\s*<(?:table|details|callout)\b/i.test(lines[i]) &&
      !(
        lines[i].includes('|') &&
        i + 1 < lines.length &&
        parseTableSeparator(lines[i + 1]) !== null
      ) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }

    const paragraphText = joinParagraphLines(buf);
    // 容错提取：若段落中仍嵌有块级 HTML 表格，将其切分独立
    const segments = extractHtmlTableBlocks(paragraphText);
    if (segments.length > 1 || (segments.length === 1 && segments[0].type === 'table')) {
      for (const seg of segments) {
        if (seg.type === 'table') {
          blocks.push(seg.block);
        } else if (seg.content.trim()) {
          blocks.push({ type: 'paragraph', text: seg.content.trim() });
        }
      }
    } else {
      blocks.push({ type: 'paragraph', text: paragraphText });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// 块级渲染
// ---------------------------------------------------------------------------

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-kai font-medium text-ink mt-6 mb-3 pb-2 border-b border-line/60 first:mt-0',
  2: 'text-lg font-kai font-medium text-ink mt-5 mb-2.5 first:mt-0',
  3: 'text-base font-kai font-medium text-ink mt-4 mb-2 first:mt-0',
  4: 'text-sm font-kai font-medium text-ink-soft mt-3 mb-1.5 first:mt-0',
  5: 'text-sm font-medium text-ink-soft mt-3 mb-1.5 first:mt-0',
  6: 'text-xs font-medium text-ink-faint mt-2 mb-1 first:mt-0',
};

const ALIGN_CLASS: Record<TableAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/** D9：飞书 callout emoji-id → 字形映射（未知降级 💬）。 */
const CALLOUT_EMOJI: Record<string, string> = {
  warning: '⚠️',
  warn: '⚠️',
  error: '❌',
  danger: '❌',
  info: 'ℹ️',
  tip: '💡',
  bulb: '💡',
  lightbulb: '💡',
  idea: '💡',
  success: '✅',
  check: '✅',
  question: '❓',
  help: '❓',
  star: '⭐',
  pin: '📌',
  fire: '🔥',
  heart: '❤️',
  note: '📝',
  memo: '📝',
};

/** D9：飞书 callout background-color → 静态样式类映射（未知降级中性色）。 */
const CALLOUT_TONE: Record<string, string> = {
  yellow: 'bg-amber-50/80 border-amber-200',
  orange: 'bg-orange-50/80 border-orange-200',
  blue: 'bg-sky-50/80 border-sky-200',
  green: 'bg-emerald-50/80 border-emerald-200',
  red: 'bg-red-50/80 border-red-200',
  pink: 'bg-pink-50/80 border-pink-200',
  purple: 'bg-violet-50/80 border-violet-200',
  grey: 'bg-paper-2/60 border-line/70',
  gray: 'bg-paper-2/60 border-line/70',
};

const CALLOUT_TONE_FALLBACK = 'bg-paper-2/60 border-line/70';

interface ListItemNode {
  item: ListItemData;
  children: ListItemNode[];
}

/** D7：按缩进把扁平列表项构树，嵌套子级保留自身标记类型（ol/ul）。 */
function buildListTree(items: ListItemData[]): ListItemNode[] {
  const roots: ListItemNode[] = [];
  const stack: ListItemNode[] = [];
  for (const item of items) {
    const node: ListItemNode = { item, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].item.indent > item.indent) stack.pop();
    const top = stack[stack.length - 1];
    if (top && top.item.indent === item.indent) {
      // 同级兄弟项：挂到其父级（或根）下
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
    } else if (top) {
      top.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  return roots;
}

function renderListNodes(nodes: ListItemNode[], keyPrefix: string, ctx: InlineContext): JSX.Element {
  const first = nodes[0].item;
  const items = nodes.map((node, idx) => {
    // D5：任务列表 `[ ]`/`[x]` 渲染勾选框而非字面括号
    const task = node.item.text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
    const checked = !!task && task[1] !== ' ';
    return (
      <li key={`${keyPrefix}-${idx}`} className="pl-1 marker:text-jade">
        {task ? (
          <>
            <span
              data-md-task={checked ? 'checked' : 'open'}
              aria-label={checked ? '已完成' : '未完成'}
              className="mr-1 select-none"
            >
              {checked ? '☑' : '☐'}
            </span>
            {renderInline(task[2], `${keyPrefix}-${idx}-t`, ctx)}
          </>
        ) : (
          renderInline(node.item.text, `${keyPrefix}-${idx}`, ctx)
        )}
        {node.children.length > 0 && renderListNodes(node.children, `${keyPrefix}-${idx}-sub`, ctx)}
      </li>
    );
  });
  const listClass = `my-2 space-y-1 text-sm leading-relaxed text-ink-soft ${
    first.ordered ? 'list-decimal' : 'list-disc'
  }`;
  // D6：起始编号透传 <ol start>；起始为 1 时不输出（保持既有输出）
  return first.ordered ? (
    <ol start={first.num && first.num !== 1 ? first.num : undefined} className={listClass}>
      {items}
    </ol>
  ) : (
    <ul className={listClass}>{items}</ul>
  );
}

function renderList(
  block: Extract<Block, { type: 'list' }>,
  keyPrefix: string,
  ctx: InlineContext,
): JSX.Element {
  return renderListNodes(buildListTree(block.items), keyPrefix, ctx);
}

// Only simultaneous reads are shared; completed results are not kept as stale cloud data.
const pendingReferences = new Map<string, Promise<{ content: string; baseDir?: string }>>();
function readReference(token: string, blockId: string) {
  const key = `${token}:${blockId}`;
  const existing = pendingReferences.get(key);
  if (existing) return existing;
  const pending = getSyncedReference(token, blockId).finally(() => pendingReferences.delete(key));
  pendingReferences.set(key, pending);
  return pending;
}

function SyncedReference({ token, blockId, feishuHost, autoLoad }: { token: string; blockId: string; feishuHost?: string; autoLoad?: boolean }) {
  const [content, setContent] = useState<{ content: string; baseDir?: string } | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);
  const valid = /^[A-Za-z0-9]{1,128}$/.test(token) && /^[A-Za-z0-9]{1,128}$/.test(blockId);
  useEffect(() => {
    if (!valid || (!autoLoad && attempt === 0)) return;
    let cancelled = false;
    setStatus('loading'); setContent(null);
    readReference(token, blockId).then((result) => {
      if (!cancelled) { setContent(result); setStatus('idle'); }
    }).catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [token, blockId, autoLoad, attempt, valid]);
  const sourceUrl = valid && feishuHost && /^[A-Za-z0-9.-]+$/.test(feishuHost) ? `https://${feishuHost}/docx/${token}` : null;
  return <div className="my-3 rounded-md border border-line bg-paper/40 px-3 py-2 text-sm" data-md-block="synced-reference">
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
      <span>同步引用</span>
      {status === 'loading' && <span role="status">正在加载引用内容…</span>}
      {status === 'error' && <span role="status">无法加载引用内容，请检查网络或飞书访问权限。</span>}
      {!valid && <span>引用信息不完整，无法加载内容。</span>}
      {valid && status !== 'loading' && content === null && <button type="button" className="text-seal underline" onClick={() => setAttempt((value) => value + 1)}>{status === 'error' ? '重试' : '加载引用内容'}</button>}
      {sourceUrl && <button type="button" className="text-jade underline" onClick={() => openExternalUrl(sourceUrl)}>查看飞书原文</button>}
    </div>
    {content !== null && (content.content.trim() ? <MarkdownView content={content.content} baseDir={content.baseDir} feishuHost={feishuHost} remoteImages="confirm" /> : <p className="mt-2 text-xs text-ink-faint">引用内容为空。</p>)}
  </div>;
}

function renderBlock(block: Block, index: number, ctx: InlineContext): ReactNode {
  const key = `b-${index}`;
  switch (block.type) {
    case 'synced_reference':
      return <SyncedReference key={key} token={block.token} blockId={block.blockId} feishuHost={ctx.feishuHost} autoLoad={ctx.resolveSyncedReferences} />;
    case 'heading': {
      const Heading = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Heading key={key} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[6]}>
          {renderInline(block.text, key, ctx)}
        </Heading>
      );
    }
    case 'code':
      return (
        <div key={key} data-md-block="code" className="my-3 rounded-md border border-line/70 bg-dark overflow-hidden">
          {block.lang && (
            <div className="px-3 py-1.5 text-[10px] font-mono text-paper/60 border-b border-paper/10 bg-dark">
              {block.lang}
            </div>
          )}
          <pre className="px-3.5 py-3 text-xs leading-relaxed text-paper font-mono overflow-x-auto scrollbar-thin">
            {block.lines.join('\n')}
          </pre>
        </div>
      );
    case 'table':
      return (
        <div key={key} data-md-block="table" className="my-3 overflow-x-auto scrollbar-thin rounded-md border border-line/70">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-paper-2">
                {block.header.map((cell, ci) => (
                  <th
                    key={ci}
                    className={`px-3 py-2 font-medium text-ink border-b border-line whitespace-nowrap ${
                      ALIGN_CLASS[block.aligns[ci] ?? 'left']
                    }`}
                  >
                    {renderInline(cell, `${key}-h${ci}`, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 1 ? 'bg-paper/60' : 'bg-card-bg'}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`px-3 py-1.5 text-ink-soft border-b border-line/40 align-top ${
                        ALIGN_CLASS[block.aligns[ci] ?? 'left']
                      }`}
                    >
                      {renderInline(cell, `${key}-r${ri}c${ci}`, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'html_table':
      // 需求 1：受控 HTML 表格渲染，保留 colspan/rowspan，样式与 Markdown 表格一致
      return (
        <div key={key} data-md-block="table" className="my-3 overflow-x-auto scrollbar-thin rounded-md border border-line/70">
          <table className="w-full text-xs border-collapse">
            {block.colgroup && (
              <colgroup>
                {block.colgroup.map((col, ci) => (
                  <col
                    key={ci}
                    span={col.span}
                    style={col.width ? { width: col.width } : undefined}
                  />
                ))}
              </colgroup>
            )}
            {block.headRows.length > 0 && (
              <thead>
                {block.headRows.map((row, ri) => (
                  <tr key={ri} className="bg-paper-2">
                    {row.cells.map((cell, ci) => (
                      <th
                        key={ci}
                        colSpan={cell.colspan}
                        rowSpan={cell.rowspan}
                        style={{
                          verticalAlign: cell.valign || 'top',
                          ...(cell.style || {}),
                        }}
                        className={`px-3 py-2 font-medium text-ink border-b border-line ${
                          cell.align ? ALIGN_CLASS[cell.align] : 'text-left'
                        }`}
                      >
                        {renderInline(cell.content, `${key}-h${ri}c${ci}`, ctx)}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
            )}
            <tbody>
              {block.bodyRows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 1 ? 'bg-paper/60' : 'bg-card-bg'}>
                  {row.cells.map((cell, ci) => (
                    <td
                      key={ci}
                      colSpan={cell.colspan}
                      rowSpan={cell.rowspan}
                      style={{
                        verticalAlign: cell.valign || 'top',
                        ...(cell.style || {}),
                      }}
                      className={`px-3 py-1.5 text-ink-soft border-b border-line/40 ${
                        cell.align ? ALIGN_CLASS[cell.align] : 'text-left'
                      }`}
                    >
                      {renderInline(cell.content, `${key}-r${ri}c${ci}`, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list':
      return renderList(block, key, ctx);
    case 'details':
      // D1：原生 <details> 折叠块，summary 经行内解析，内容递归块渲染
      return (
        <details
          key={key}
          data-md-block="details"
          className="my-3 rounded-md border border-line/70 bg-paper-2/40 px-4 py-2.5 text-sm"
        >
          {block.summary ? (
            <summary className="cursor-pointer select-none font-medium text-ink">
              {renderInline(block.summary, `${key}-sum`, ctx)}
            </summary>
          ) : null}
          <div className="mt-2">
            {block.blocks.map((b, bi) => (
              <Fragment key={bi}>{renderBlock(b, bi, ctx)}</Fragment>
            ))}
          </div>
        </details>
      );
    case 'callout':
      // D9：emoji 与底色受控保留，内容递归块渲染（不再退化为普通段落）
      return (
        <div
          key={key}
          data-md-block="callout"
          className={`my-3 flex gap-2.5 rounded-md border px-4 py-3 text-sm ${
            CALLOUT_TONE[block.background.trim().toLowerCase()] ?? CALLOUT_TONE_FALLBACK
          }`}
        >
          <span className="shrink-0 select-none leading-relaxed" aria-hidden="true">
            {CALLOUT_EMOJI[block.emojiId.trim().toLowerCase()] ?? '💬'}
          </span>
          <div className="min-w-0 flex-1">
            {block.blocks.map((b, bi) => (
              <Fragment key={bi}>{renderBlock(b, bi, ctx)}</Fragment>
            ))}
          </div>
        </div>
      );
    case 'quote':
      return (
        <blockquote
          key={key}
          className="my-3 pl-3 border-l-2 border-jade/60 text-sm text-ink-soft italic space-y-1"
        >
          {block.lines.map((l, li) => (
            <p key={li}>{renderInline(l, `${key}-q${li}`, ctx)}</p>
          ))}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} className="my-4 border-line/60" />;
    case 'paragraph':
      return (
        <p key={key} className="my-2 text-sm leading-relaxed text-ink-soft">
          {renderInline(block.text, key, ctx)}
        </p>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 组件出口
// ---------------------------------------------------------------------------

export interface MarkdownViewProps {
  content: string;
  /** md 文件所在目录（kbRoot 相对 POSIX 路径），用于解析相对图片路径。 */
  baseDir?: string;
  /** 点击相对 .csv 链接时的拦截处理器：返回 true 表示已命中本地子表并阻止浏览器默认跳转。 */
  onNavigateCsv?: (href: string) => boolean;
  /** 飞书租户域名（如 "qcnbafdrjx7n.feishu.cn"），用于生成并打开 wiki 超链接。 */
  feishuHost?: string;
  /** 仅本地源文档预览自动读取飞书同步引用；其他不可信内容须用户主动加载。 */
  resolveSyncedReferences?: boolean;
  /**
   * 远程图片策略（F2 安全修复，不可信内容必设 'confirm'）：
   *   - 'auto'（默认）：远程图片自动加载（既有预览面兼容行为）；
   *   - 'confirm'：不自动加载外部图片（渲染占位卡片，点击授权后加载）。
   * 标准库 AI 生成文档、原始库文档、Agent 输出等不可信入口应传 'confirm'。
   */
  remoteImages?: 'auto' | 'confirm';
  /** 标准库长文采用独立阅读排版；其他预览入口保留紧凑布局。 */
  variant?: 'preview' | 'reading';
}

export function MarkdownView({
  content,
  baseDir = '',
  onNavigateCsv,
  feishuHost,
  resolveSyncedReferences = false,
  remoteImages = 'auto',
  variant = 'preview',
}: MarkdownViewProps) {
  const blocks = parseBlocks(preprocess(content));
  const ctx: InlineContext = { baseDir, onNavigateCsv, feishuHost, remoteImages, resolveSyncedReferences };
  return (
    <div className={variant === 'reading' ? 'markdown-reading' : 'px-5 py-4'}>
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b, i, ctx)}</Fragment>
      ))}
    </div>
  );
}
