/**
 * SlidesXmlAdapter — deterministic Feishu Slides XML to Markdown projection.
 *
 * This adapter is deliberately pure: it makes no filesystem, network, or
 * lark-cli calls.  The caller is responsible for obtaining the complete XML
 * presentation and for materialising the media references returned here.
 */

export type SlidesMediaKind = 'image' | 'whiteboard';

export interface SlidesMediaReference {
  kind: SlidesMediaKind;
  /** The exact token/source value carried by the presentation XML. */
  token: string;
  /** One-based index of the slide that references this resource. */
  slideNumber: number;
}

export interface SlidesXmlAdaptResult {
  /** Canonical deterministic Markdown, beginning with the caller-supplied H1. */
  markdown: string;
  slideCount: number;
  /** De-duplicated `<img src>` values in first-seen order. */
  imageTokens: string[];
  /** De-duplicated `<whiteboard token>` values in first-seen order. */
  whiteboardTokens: string[];
  /** All media references, retaining their slide locations and source kinds. */
  mediaReferences: SlidesMediaReference[];
}

interface XmlTextNode {
  kind: 'text';
  value: string;
}

interface XmlElementNode {
  kind: 'element';
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

type XmlNode = XmlTextNode | XmlElementNode;

interface MarkdownBlock {
  kind: 'paragraph' | 'bullet';
  text: string;
}

const OMITTED_TEXT_TAGS = new Set([
  'animation',
  'background',
  'color',
  'fill',
  'font',
  'layout',
  'line',
  'notes',
  'shadow',
  'stroke',
  'style',
  'theme',
  'transform',
]);

const LINE_BREAK_TAGS = new Set(['br', 'break', 'linebreak']);
const LIST_CONTAINER_TAGS = new Set(['list', 'ol', 'ul']);

/**
 * Convert a complete Feishu Slides presentation XML payload into readable
 * Markdown. A malformed payload is rejected rather than being converted into
 * a success-looking metadata placeholder.
 */
export function adaptSlidesXmlToMarkdown(
  xml: string,
  title: string,
): SlidesXmlAdaptResult {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    throw new Error('Slides XML 为空，无法导出幻灯片正文');
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('Slides 标题为空，无法生成 Markdown H1');
  }

  const root = parseXml(xml);
  if (localName(root.name) !== 'presentation') {
    throw new Error(`Slides XML 根节点必须为 presentation，实际为 ${root.name}`);
  }

  const slides = findDescendants(root, 'slide');
  if (slides.length === 0) {
    throw new Error('Slides XML 不包含任何 slide 节点，拒绝生成占位正文');
  }

  const mediaReferences: SlidesMediaReference[] = [];
  const markdownParts: string[] = [`# ${normalizeInline(title)}`];

  slides.forEach((slide, index) => {
    const slideNumber = index + 1;
    markdownParts.push(`## 幻灯片 ${slideNumber}`);

    const body = extractSlideBody(slide);
    if (body) markdownParts.push(body);

    mediaReferences.push(...extractMediaReferences(slide, slideNumber));
  });

  const imageTokens = distinct(
    mediaReferences
      .filter((reference) => reference.kind === 'image')
      .map((reference) => reference.token),
  );
  const whiteboardTokens = distinct(
    mediaReferences
      .filter((reference) => reference.kind === 'whiteboard')
      .map((reference) => reference.token),
  );

  return {
    markdown: `${markdownParts.join('\n\n').trim()}\n`,
    slideCount: slides.length,
    imageTokens,
    whiteboardTokens,
    mediaReferences,
  };
}

/** Thin class facade for dependency injection at the SyncEngine boundary. */
export class SlidesXmlAdapter {
  adapt(xml: string, title: string): SlidesXmlAdaptResult {
    return adaptSlidesXmlToMarkdown(xml, title);
  }
}

function parseXml(xml: string): XmlElementNode {
  const stack: XmlElementNode[] = [];
  let root: XmlElementNode | null = null;
  let cursor = 0;

  while (cursor < xml.length) {
    const nextOpen = xml.indexOf('<', cursor);
    if (nextOpen === -1) {
      appendText(xml.slice(cursor), stack);
      break;
    }

    if (nextOpen > cursor) {
      appendText(xml.slice(cursor, nextOpen), stack);
    }

    if (xml.startsWith('<!--', nextOpen)) {
      const end = xml.indexOf('-->', nextOpen + 4);
      if (end === -1) throw new Error('Slides XML 注释未闭合');
      cursor = end + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', nextOpen)) {
      const end = xml.indexOf(']]>', nextOpen + 9);
      if (end === -1) throw new Error('Slides XML CDATA 未闭合');
      appendText(xml.slice(nextOpen + 9, end), stack);
      cursor = end + 3;
      continue;
    }

    if (xml.startsWith('<?', nextOpen)) {
      const end = xml.indexOf('?>', nextOpen + 2);
      if (end === -1) throw new Error('Slides XML processing instruction 未闭合');
      cursor = end + 2;
      continue;
    }

    if (xml.startsWith('<!', nextOpen)) {
      const end = findTagEnd(xml, nextOpen + 2);
      if (end === -1) throw new Error('Slides XML 声明未闭合');
      cursor = end + 1;
      continue;
    }

    const end = findTagEnd(xml, nextOpen + 1);
    if (end === -1) throw new Error('Slides XML 标签未闭合');
    const rawTag = xml.slice(nextOpen + 1, end).trim();
    if (!rawTag) throw new Error('Slides XML 包含空标签');

    if (rawTag.startsWith('/')) {
      const closingName = rawTag.slice(1).trim();
      if (!isValidName(closingName)) {
        throw new Error(`Slides XML 关闭标签无效: </${closingName}>`);
      }
      const open = stack.pop();
      if (!open || open.name !== closingName) {
        throw new Error(`Slides XML 标签未正确嵌套: </${closingName}>`);
      }
    } else {
      const selfClosing = rawTag.endsWith('/');
      const openTag = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
      const parsed = parseOpeningTag(openTag);
      const node: XmlElementNode = {
        kind: 'element',
        name: parsed.name,
        attributes: parsed.attributes,
        children: [],
      };

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else if (root) {
        throw new Error('Slides XML 包含多个根节点');
      } else {
        root = node;
      }

      if (!selfClosing) stack.push(node);
    }

    cursor = end + 1;
  }

  if (stack.length > 0) {
    throw new Error(`Slides XML 标签未闭合: <${stack[stack.length - 1].name}>`);
  }
  if (!root) {
    throw new Error('Slides XML 不包含根节点');
  }
  return root;
}

function appendText(
  text: string,
  stack: XmlElementNode[],
): void {
  if (!text) return;
  if (stack.length === 0) {
    if (text.trim().length > 0) {
      throw new Error('Slides XML 根节点外包含非空文本');
    }
    return;
  }
  stack[stack.length - 1].children.push({ kind: 'text', value: text });
}

function findTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function parseOpeningTag(rawTag: string): { name: string; attributes: Record<string, string> } {
  const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/.exec(rawTag);
  if (!match) throw new Error(`Slides XML 开始标签无效: <${rawTag}>`);
  const [, name, rawAttributes] = match;
  return { name, attributes: parseAttributes(rawAttributes) };
}

function parseAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let cursor = 0;

  while (cursor < rawAttributes.length) {
    while (/\s/.test(rawAttributes[cursor] ?? '')) cursor += 1;
    if (cursor >= rawAttributes.length) break;

    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(rawAttributes.slice(cursor));
    if (!nameMatch) {
      throw new Error(`Slides XML 属性无效: ${rawAttributes.slice(cursor)}`);
    }
    const name = nameMatch[0];
    cursor += name.length;
    while (/\s/.test(rawAttributes[cursor] ?? '')) cursor += 1;
    if (rawAttributes[cursor] !== '=') {
      throw new Error(`Slides XML 属性缺少值: ${name}`);
    }
    cursor += 1;
    while (/\s/.test(rawAttributes[cursor] ?? '')) cursor += 1;

    const quote = rawAttributes[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Slides XML 属性值必须带引号: ${name}`);
    }
    cursor += 1;
    const valueEnd = rawAttributes.indexOf(quote, cursor);
    if (valueEnd === -1) throw new Error(`Slides XML 属性值未闭合: ${name}`);
    attributes[name] = decodeXmlEntities(rawAttributes.slice(cursor, valueEnd));
    cursor = valueEnd + 1;
  }

  return attributes;
}

function isValidName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value);
}

function extractSlideBody(slide: XmlElementNode): string {
  const blocks: MarkdownBlock[] = [];
  for (const content of findDescendants(slide, 'content')) {
    blocks.push(...extractContentBlocks(content));
  }

  return renderBlocks(blocks);
}

function extractContentBlocks(content: XmlElementNode): MarkdownBlock[] {
  const ordered: Array<{ order: number; node: XmlElementNode; kind: MarkdownBlock['kind'] }> = [];
  let order = 0;

  const visit = (node: XmlElementNode, ancestors: XmlElementNode[]): void => {
    for (const child of node.children) {
      if (child.kind !== 'element') continue;
      const currentOrder = order;
      order += 1;
      const name = localName(child.name);
      const lineage = [...ancestors, node];

      if (name === 'p') {
        ordered.push({
          order: currentOrder,
          node: child,
          kind: hasListAncestor(lineage) ? 'bullet' : 'paragraph',
        });
        continue;
      }

      const isListItem = name === 'li' || (name === 'item' && hasListAncestor(lineage));
      if (isListItem && !hasDescendant(child, 'p')) {
        ordered.push({ order: currentOrder, node: child, kind: 'bullet' });
        continue;
      }

      visit(child, lineage);
    }
  };

  visit(content, []);
  ordered.sort((left, right) => left.order - right.order);

  const blocks = ordered
    .map(({ node, kind }) => ({ kind, text: normalizeBlockText(extractNodeText(node)) }))
    .filter((block): block is MarkdownBlock => block.text.length > 0);

  if (blocks.length > 0) return blocks;

  const plainText = normalizeBlockText(extractNodeText(content));
  return plainText ? [{ kind: 'paragraph', text: plainText }] : [];
}

function extractMediaReferences(
  slide: XmlElementNode,
  slideNumber: number,
): SlidesMediaReference[] {
  const references: SlidesMediaReference[] = [];
  const visit = (node: XmlElementNode): void => {
    const name = localName(node.name);
    if (name === 'img') {
      const src = getAttribute(node, 'src');
      if (src?.trim()) {
        references.push({ kind: 'image', token: src.trim(), slideNumber });
      }
    } else if (name === 'whiteboard') {
      const token = getAttribute(node, 'token');
      if (token?.trim()) {
        references.push({ kind: 'whiteboard', token: token.trim(), slideNumber });
      }
    }
    for (const child of node.children) {
      if (child.kind === 'element') visit(child);
    }
  };
  visit(slide);
  return references;
}

function renderBlocks(blocks: MarkdownBlock[]): string {
  let result = '';
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const rendered = block.kind === 'bullet' ? `- ${block.text}` : block.text;
    if (!result) {
      result = rendered;
      continue;
    }
    // Keep adjacent bullets in a single Markdown list; prose blocks retain a
    // blank separator for stable, readable output.
    const previousBlock = blocks[index - 1];
    result += previousBlock.kind === 'bullet' && block.kind === 'bullet'
      ? `\n${rendered}`
      : `\n\n${rendered}`;
  }
  return result;
}

function extractNodeText(node: XmlNode): string {
  if (node.kind === 'text') return decodeXmlEntities(node.value);
  const name = localName(node.name);
  if (OMITTED_TEXT_TAGS.has(name)) return '';
  if (LINE_BREAK_TAGS.has(name)) return '\n';
  return node.children.map((child) => extractNodeText(child)).join('');
}

function normalizeBlockText(value: string): string {
  const normalizedLines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => normalizeInline(line))
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));
  return normalizedLines.join('  \n').trim();
}

function normalizeInline(value: string): string {
  return decodeXmlEntities(value).replace(/\s+/g, ' ').trim();
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|amp|lt|gt|quot|apos);/g, (match, hex, decimal) => {
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (decimal) {
      const codePoint = Number.parseInt(decimal, 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    switch (match) {
      case '&amp;': return '&';
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      case '&apos;': return "'";
      default: return match;
    }
  });
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function findDescendants(node: XmlElementNode, name: string): XmlElementNode[] {
  const matches: XmlElementNode[] = [];
  const visit = (current: XmlElementNode): void => {
    for (const child of current.children) {
      if (child.kind !== 'element') continue;
      if (localName(child.name) === name) matches.push(child);
      visit(child);
    }
  };
  visit(node);
  return matches;
}

function hasDescendant(node: XmlElementNode, name: string): boolean {
  return findDescendants(node, name).length > 0;
}

function hasListAncestor(ancestors: XmlElementNode[]): boolean {
  return ancestors.some((ancestor) => {
    const name = localName(ancestor.name);
    return name === 'li' || LIST_CONTAINER_TAGS.has(name);
  });
}

function getAttribute(node: XmlElementNode, name: string): string | undefined {
  const direct = node.attributes[name];
  if (direct !== undefined) return direct;
  const match = Object.entries(node.attributes).find(([key]) => localName(key) === name);
  return match?.[1];
}

function localName(name: string): string {
  const separator = name.lastIndexOf(':');
  return (separator === -1 ? name : name.slice(separator + 1)).toLowerCase();
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}
