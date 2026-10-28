/**
 * push-planner — 飞书写回推送规划（S12，设计 §7.5）纯函数层。
 *
 * 两个职责（均无 I/O、无状态，便于单测锚定 S0 实测样例）：
 *
 * 1. 转义归一化层（S0-write-probe §④-4 / D3、D4 实测）：
 *    lark-cli markdown 写入与导出的转义集不对称——写入无条件转义 8 类
 *    字符，导出只保留其中一部分；两者往返是「语义级高保真、字节级不
 *    往返」。任何「前缀/相等」判断与写后回读校验都必须先归一化：
 *      - 段落内 `\|` / `\[` / `\]` / `\<` 字节失真（导出不重新转义）；
 *      - 表格分隔行固定规范化（`|---|---|` → `|-|-|`，语义等价）；
 *      - 导出附加的 `<title>…</title>` 行剥离（import 建档的文档导出时
 *        会有首行 title，正文比较时须剥离）；
 *      - 文档末尾换行/尾随空白去除（导出无结尾换行）。
 *
 * 2. planPush：按 base→current 的差异形态给出 append / overwrite / blocked
 *    决策。blocked 语义（设计 §7.4 SourcePushPlanDto.blockedReason）：
 *      no_changes | overwrite_required | overwrite_unsupported |
 *      images_in_append | images_in_overwrite
 *
 * 3. 写面转义（escapeLiteralAngleBracketsForWrite）：push 正文中的字面
 *    `<`（sync-engine 产物的 `<img>/<whiteboard>/<sheet>` 标签等）在
 *    lark-cli markdown 模式下会按 XML 块指令解析（S0 §②-S2），必须以
 *    `\<` 转义为字面文本后写入。归一化层对称反转 `\<`，因此比较面仍以
 *    未转义原文为基线。
 */

/** 飞书云端媒体 token 形态（与 media-reference.ts 的 TOKEN_PATTERN 同源，
 * 本模块保持纯函数、不引模块依赖，故在本地声明等价正则）。 */
const CLOUD_MEDIA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

/** XML 形态媒体标签（sync-engine 产物 / 导出残留）。 */
const XML_MEDIA_TAG_PATTERN = /<(?:image|img|file|source|whiteboard|sheet)\b[^>]*>/gi;
/** 标签内可承载引用目标的属性。 */
const MEDIA_ATTR_PATTERN = /(?:token|src|path)\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
/** markdown 图片引用（含本地相对目标与 `@./` 本地文件形态）。 */
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\n]*\]\(\s*(?:<([^<>]*)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

/** 表格分隔行：仅由 `|` `:` `-` 与空白组成，且同时含 `|` 与 `-`。 */
function isTableSeparatorLine(line: string): boolean {
  if (!line.includes('|') || !line.includes('-')) return false;
  return /^[\s|:-]+$/.test(line);
}

/** 分隔行规范化：每格去空白、`-`/`:` 连续段折叠为单个（S0 D3：`|---|---|` → `|-|-|`）。 */
function normalizeSeparatorLine(line: string): string {
  return line
    .split('|')
    .map((cell) => cell.trim().replace(/-{2,}/g, '-').replace(/:{2,}/g, ':'))
    .join('|');
}

/** 行级归一化：分隔行规范化 + 写入转义集的对称反转（`\|` `\[` `\]` `\<`）。 */
function normalizeLine(line: string): string {
  const separator = isTableSeparatorLine(line) ? normalizeSeparatorLine(line) : line;
  return separator
    .replace(/\\\|/g, '|')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .replace(/\\</g, '<');
}

/**
 * 导出正文归一化（S0 §④-4 全项）。写入侧与导出侧对称应用：
 *   ① 剥离首行 `<title>…</title>`（连同其后的一个空行，import 建档文档
 *      的导出形态）；
 *   ② 逐行归一化（分隔行 + 转义反转）；
 *   ③ 去文档末尾换行/尾随空白（导出无结尾换行；首部空白保留——正文
 *      缩进可能是语义）。
 */
export function normalizeForCompare(body: string): string {
  let text = typeof body === 'string' ? body : '';
  const titleMatch = /^<title>[^\n]*<\/title>\n(\n)?/.exec(text);
  if (titleMatch) text = text.slice(titleMatch[0].length);
  const normalized = text.split('\n').map(normalizeLine).join('\n');
  return normalized.replace(/\s+$/, '');
}

/**
 * 写面转义：push 正文中尚未转义的字面 `<` 一律 `\<`（S0 §②-S2：markdown
 * 模式下 XML 标签解析生效）。已转义的 `\<` 不重复转义。
 */
export function escapeLiteralAngleBracketsForWrite(body: string): string {
  return body.replace(/(?<!\\)</g, '\\<');
}

/**
 * 检测正文（或后缀）中是否含「本地媒体引用」——写入云端后无法解析的
 * 引用目标（本地相对路径 / `@./` 本地文件）。云端 token 与 https URL
 * 形态不算本地引用（`![](https://feishu.cn/file/<token>)` 是回拉形态）。
 */
export function containsLocalMediaReference(text: string): boolean {
  for (const tag of text.match(XML_MEDIA_TAG_PATTERN) ?? []) {
    const attr = MEDIA_ATTR_PATTERN.exec(tag);
    const value = attr?.[1] ?? attr?.[2] ?? '';
    if (isLocalMediaTarget(value)) return true;
  }
  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const target = (match[1] ?? match[2] ?? '').trim();
    if (isLocalMediaTarget(target)) return true;
  }
  return false;
}

function isLocalMediaTarget(value: string): boolean {
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (CLOUD_MEDIA_TOKEN.test(value)) return false;
  // 其余（images/xx.png、@./f.pdf、attachments/…、任意相对路径）都是本地引用。
  return true;
}

// ============================================================================
// planPush（设计 §7.5 规则）
// ============================================================================

export type SourcePushBlockedReason =
  | 'no_changes'
  | 'overwrite_required'
  | 'overwrite_unsupported'
  | 'images_in_append'
  | 'images_in_overwrite';

export interface PlanPushInput {
  /** 基线正文（source-edits/base.md，最后一次同步版）。 */
  baseBody: string;
  /** 当前正文（本地文件正文，含未写回修改）。 */
  currentBody: string;
  allowOverwrite: boolean;
  overwriteSupported: boolean;
}

export interface PlanPushResult {
  mode: 'append' | 'overwrite' | 'blocked';
  blockedReason?: SourcePushBlockedReason;
  /** append 模式：待追加的后缀（原文，未经写面转义——转义在写入前统一做）。 */
  appendMarkdown?: string;
}

/**
 * 推送规划（纯函数）。规则（设计 §7.5，前缀/相等判断先经归一化层）：
 *   - 归一化后 current === base → blocked(no_changes)
 *   - current 以 base 为前缀（原文前缀或行对齐归一化前缀）→ append；
 *     后缀含本地图片引用 → blocked(images_in_append)
 *   - 否则 allowOverwrite ∧ overwriteSupported → overwrite；正文含本地
 *     图片引用 → blocked(images_in_overwrite)
 *   - 否则 blocked(overwrite_required | overwrite_unsupported)
 */
export function planPush(input: PlanPushInput): PlanPushResult {
  const { baseBody, currentBody } = input;
  const normalizedBase = normalizeForCompare(baseBody);
  const normalizedCurrent = normalizeForCompare(currentBody);
  if (normalizedCurrent === normalizedBase) {
    return { mode: 'blocked', blockedReason: 'no_changes' };
  }

  const suffix = deriveAppendSuffix(baseBody, currentBody, normalizedBase, normalizedCurrent);
  if (suffix !== null) {
    if (containsLocalMediaReference(suffix)) {
      return { mode: 'blocked', blockedReason: 'images_in_append' };
    }
    return { mode: 'append', appendMarkdown: suffix };
  }

  if (input.allowOverwrite && input.overwriteSupported) {
    if (containsLocalMediaReference(currentBody)) {
      return { mode: 'blocked', blockedReason: 'images_in_overwrite' };
    }
    return { mode: 'overwrite' };
  }
  return { mode: 'blocked', blockedReason: input.allowOverwrite ? 'overwrite_unsupported' : 'overwrite_required' };
}

/**
 * 推导 append 后缀：
 *   ① 原文前缀（常规路径：编辑器不改动既有字节）→ 直接切尾；
 *   ② 行对齐归一化前缀（既有行仅发生归一化等价变化，如分隔行改写）→
 *     末行必须仍是原文前缀扩展，否则视为不可安全切分（退回 overwrite
 *     决策由调用方处理）。
 * 返回 null 表示 base 不是 current 的（归一化）前缀。
 */
function deriveAppendSuffix(
  baseBody: string,
  currentBody: string,
  normalizedBase: string,
  normalizedCurrent: string,
): string | null {
  if (currentBody.startsWith(baseBody)) {
    return currentBody.slice(baseBody.length);
  }
  if (!normalizedCurrent.startsWith(normalizedBase)) return null;

  const baseLines = baseBody.split('\n');
  const currentLines = currentBody.split('\n');
  if (currentLines.length < baseLines.length) return null;

  const last = baseLines.length - 1;
  // 前 k-1 行：归一化等价即可（追加通常发生在文末，不触碰既有行）。
  for (let index = 0; index < last; index += 1) {
    if (normalizeLine(currentLines[index] ?? '') !== normalizeLine(baseLines[index])) {
      return null;
    }
  }
  // 末行：必须是原文前缀扩展（末行中途改写无法字节安全切分）。
  const lastBase = baseLines[last];
  const lastCurrent = currentLines[last] ?? '';
  if (!lastCurrent.startsWith(lastBase)) return null;
  const head = lastCurrent.slice(lastBase.length);
  return head.length > 0 || currentLines.length > baseLines.length
    ? `${head}${currentLines.length > baseLines.length ? `\n${currentLines.slice(baseLines.length).join('\n')}` : ''}`
    : null;
}
