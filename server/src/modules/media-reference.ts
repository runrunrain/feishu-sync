/**
 * Parse media references emitted by `lark-cli docs +fetch` without coupling
 * the parser to a transport or a filesystem.  The fetch output is markdown
 * with a small amount of XML-like media markup, so this module deliberately
 * keeps the original spans rather than trying to render or download media.
 */

export type MediaReferenceKind = 'image' | 'attachment' | 'whiteboard';

export type MediaReferenceSource =
  | 'markdown-image'
  | 'markdown-link'
  | 'xml-image'
  | 'xml-file'
  | 'xml-source'
  | 'xml-whiteboard'
  | 'html-image'
  | 'html-link'
  | 'url';

/**
 * A reference target inside the original fetch body.
 *
 * `start`/`end` identify only the replaceable target: a URL for URL-based
 * references, or the token value for XML media tags.  This makes rewrites
 * lossless for surrounding markdown/XML syntax.
 */
export interface MediaReference {
  token: string;
  kind: MediaReferenceKind;
  source: MediaReferenceSource;
  /** Original remote URL when the reference originated from one. */
  sourceUrl: string | null;
  /** Original token value or URL text occupying [start, end). */
  original: string;
  start: number;
  end: number;
  /** `name` / `filename` from the source XML tag when present. */
  filename: string | null;
}

export type MediaReferenceReplacements =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string | undefined>>;

interface UrlTokenMatch {
  token: string;
  sourceUrl: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const URL_PATTERN = /https:\/\/[^\s<>"']+/g;
const XML_MEDIA_TAG_PATTERN = /<(image|img|file|source|whiteboard)\b([^>]*)>/gi;
const FILENAME_ATTRIBUTE_PATTERN = /(?:^|\s)(?:name|filename|file_name)\s*=\s*(["'])([^"']*)\1/i;

/**
 * Return every recognized occurrence in source order.  Unlike
 * `extractFeishuMediaReferences`, repeated tokens are retained so a caller
 * can inspect or rewrite every exact span.
 */
export function findFeishuMediaReferenceOccurrences(content: string): MediaReference[] {
  if (!content) return [];

  const references = [
    ...findXmlMediaReferences(content),
    ...findUrlMediaReferences(content),
  ];

  return references.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    return left.end - right.end;
  });
}

/**
 * Return recognized Feishu media tokens once, preserving first-appearance
 * order.  The retained span/URL/filename are therefore always from the first
 * occurrence of that token.
 */
export function extractFeishuMediaReferences(content: string): MediaReference[] {
  const seen = new Set<string>();
  const unique: MediaReference[] = [];

  for (const reference of findFeishuMediaReferenceOccurrences(content)) {
    if (seen.has(reference.token)) continue;
    seen.add(reference.token);
    unique.push(reference);
  }

  return unique;
}

/**
 * Replace only recognized media target spans with caller-supplied local,
 * POSIX-relative paths.  Unknown URLs, malformed tokens, missing mappings,
 * and unsafe replacement paths are left byte-for-byte unchanged.
 *
 * XML tag structure is intentionally preserved: for example,
 * `<whiteboard token="abc"/>` becomes `<whiteboard token="images/a.png"/>`
 * only when `abc` has a safe mapping.  Whether a whiteboard should become a
 * raster preview is a transport/rendering concern outside this parser.
 */
export function rewriteFeishuMediaReferences(
  content: string,
  replacements: MediaReferenceReplacements,
): string {
  const occurrences = findFeishuMediaReferenceOccurrences(content);
  if (occurrences.length === 0) return content;

  let cursor = 0;
  let rewritten = '';

  for (const occurrence of occurrences) {
    // Defensive guard in case a future matcher contributes overlapping spans.
    if (occurrence.start < cursor) continue;

    const replacement = lookupReplacement(replacements, occurrence.token);
    if (!replacement || !isSafeMediaRelativePath(replacement)) continue;

    rewritten += content.slice(cursor, occurrence.start);
    rewritten += replacement;
    cursor = occurrence.end;
  }

  if (cursor === 0) return content;
  return rewritten + content.slice(cursor);
}

/**
 * A media target must remain a simple local POSIX path.  Rejecting URL-like,
 * absolute, traversing, encoded-traversal, and backslash paths prevents a
 * caller-provided mapping from escaping the document directory or restoring a
 * remote URL during a supposedly local rewrite.
 */
export function isSafeMediaRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return false;
  }
  if (
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /[?#<>"']/.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    /%(?:2e|2f|5c)/i.test(value)
  ) {
    return false;
  }

  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function findXmlMediaReferences(content: string): MediaReference[] {
  const references: MediaReference[] = [];

  for (const tagMatch of content.matchAll(XML_MEDIA_TAG_PATTERN)) {
    const wholeTag = tagMatch[0];
    const tagName = tagMatch[1].toLowerCase();
    const attributes = tagMatch[2];
    const tagStart = tagMatch.index ?? 0;
    // Current `docs +fetch --doc-format markdown` emits `<img src="token">`
    // in addition to the documented `<image token="token">` form.  Only
    // image-like tags may use src as a media token; file/source/whiteboard
    // remain token-only so an arbitrary URL is never misclassified.
    const tokenMatch = mediaTokenAttributePattern(tagName).exec(attributes);
    if (!tokenMatch) continue;

    const token = tokenMatch[2];
    if (!isValidFeishuMediaToken(token)) continue;

    const tokenOffset = tokenMatch.index + tokenMatch[0].lastIndexOf(token);
    const attributesOffset = wholeTag.indexOf(attributes);
    if (attributesOffset < 0 || tokenOffset < 0) continue;

    const filenameMatch = FILENAME_ATTRIBUTE_PATTERN.exec(attributes);
    const filename = filenameMatch?.[2] || null;
    const kindAndSource = xmlKindAndSource(tagName);
    if (!kindAndSource) continue;

    const start = tagStart + attributesOffset + tokenOffset;
    references.push({
      token,
      kind: kindAndSource.kind,
      source: kindAndSource.source,
      sourceUrl: null,
      original: token,
      start,
      end: start + token.length,
      filename,
    });
  }

  return references;
}

function mediaTokenAttributePattern(tagName: string): RegExp {
  const attribute = tagName === 'image' || tagName === 'img'
    ? '(?:token|src)'
    : 'token';
  return new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*(["'])([^"']*)\\1`, 'i');
}

function findUrlMediaReferences(content: string): MediaReference[] {
  const references: MediaReference[] = [];

  for (const match of content.matchAll(URL_PATTERN)) {
    const candidate = trimTrailingUrlPunctuation(match[0]);
    if (!candidate) continue;

    const media = extractMediaTokenFromUrl(candidate);
    if (!media) continue;

    const start = match.index ?? 0;
    const context = classifyUrlContext(content, start);
    references.push({
      token: media.token,
      kind: context.kind,
      source: context.source,
      sourceUrl: media.sourceUrl,
      original: media.sourceUrl,
      start,
      end: start + media.sourceUrl.length,
      filename: null,
    });
  }

  return references;
}

function xmlKindAndSource(tagName: string): Pick<MediaReference, 'kind' | 'source'> | null {
  switch (tagName) {
    case 'image':
    case 'img':
      return { kind: 'image', source: 'xml-image' };
    case 'file':
      return { kind: 'attachment', source: 'xml-file' };
    case 'source':
      return { kind: 'attachment', source: 'xml-source' };
    case 'whiteboard':
      return { kind: 'whiteboard', source: 'xml-whiteboard' };
    default:
      return null;
  }
}

function classifyUrlContext(
  content: string,
  start: number,
): Pick<MediaReference, 'kind' | 'source'> {
  const lineStart = Math.max(content.lastIndexOf('\n', start - 1) + 1, 0);
  const prefix = content.slice(lineStart, start);

  if (/!\[[^\]\n]*\]\(\s*$/.test(prefix)) {
    return { kind: 'image', source: 'markdown-image' };
  }
  if (/\[[^\]\n]*\]\(\s*$/.test(prefix)) {
    return { kind: 'attachment', source: 'markdown-link' };
  }

  const lastTagStart = content.lastIndexOf('<', start);
  const lastTagEnd = content.lastIndexOf('>', start);
  if (lastTagStart > lastTagEnd) {
    const tagPrefix = content.slice(lastTagStart, start);
    const tagName = /^<([A-Za-z][A-Za-z0-9:_-]*)\b/.exec(tagPrefix)?.[1]?.toLowerCase();
    if (tagName === 'img' || tagName === 'image') {
      return { kind: 'image', source: 'html-image' };
    }
    if (tagName === 'a') {
      return { kind: 'attachment', source: 'html-link' };
    }
  }

  return { kind: 'attachment', source: 'url' };
}

function extractMediaTokenFromUrl(candidate: string): UrlTokenMatch | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || !isFeishuHost(url.hostname)) return null;

  const pathToken = tokenFromKnownPath(url.pathname);
  if (pathToken && isValidFeishuMediaToken(pathToken)) {
    return { token: pathToken, sourceUrl: candidate };
  }

  if (isKnownDownloadPath(url.pathname)) {
    const queryToken = firstQueryToken(url, ['file_token', 'fileToken', 'token', 'media_token']);
    if (queryToken && isValidFeishuMediaToken(queryToken)) {
      return { token: queryToken, sourceUrl: candidate };
    }
  }

  return null;
}

function tokenFromKnownPath(pathname: string): string | null {
  const direct = /^\/file\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (direct) return direct[1];

  const driveFile = /^\/drive\/file\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (driveFile) return driveFile[1];

  const driveMedia = /^\/drive\/medias?\/([A-Za-z0-9_-]+)\/(?:download|preview)\/?$/.exec(pathname);
  if (driveMedia) return driveMedia[1];

  const openApiMedia = /^\/open-apis\/drive\/v1\/medias\/([A-Za-z0-9_-]+)\/(?:download|preview)\/?$/.exec(pathname);
  if (openApiMedia) return openApiMedia[1];

  return null;
}

function isKnownDownloadPath(pathname: string): boolean {
  return pathname === '/space/api/box/stream/download' ||
    pathname === '/space/api/box/stream/download/' ||
    pathname === '/drive/v1/medias/download' ||
    pathname === '/drive/v1/medias/download/';
}

function firstQueryToken(url: URL, names: string[]): string | null {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value != null) return value;
  }
  return null;
}

function isFeishuHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'feishu.cn' ||
    normalized.endsWith('.feishu.cn') ||
    normalized === 'larksuite.com' ||
    normalized.endsWith('.larksuite.com');
}

function trimTrailingUrlPunctuation(candidate: string): string {
  let end = candidate.length;
  while (end > 0 && /[.,;:!?]/.test(candidate[end - 1])) end -= 1;

  // A markdown closing ')' is not part of a URL unless there is an unmatched
  // opening parenthesis inside the candidate.
  while (
    end > 0 &&
    candidate[end - 1] === ')' &&
    countCharacter(candidate.slice(0, end), '(') < countCharacter(candidate.slice(0, end), ')')
  ) {
    end -= 1;
  }

  return candidate.slice(0, end);
}

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const valueCharacter of value) {
    if (valueCharacter === character) count += 1;
  }
  return count;
}

function lookupReplacement(
  replacements: MediaReferenceReplacements,
  token: string,
): string | undefined {
  if (replacements instanceof Map) return replacements.get(token);
  const record = replacements as Readonly<Record<string, string | undefined>>;
  return Object.prototype.hasOwnProperty.call(record, token)
    ? record[token]
    : undefined;
}

function isValidFeishuMediaToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
