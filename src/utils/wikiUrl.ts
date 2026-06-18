/**
 * Feishu wiki root URL validation utilities
 *
 * Used by detection entry points (App top bar 立即检测 / ChangeList Detect Changes)
 * to validate that a root URL points to a Feishu wiki node before invoking
 * the change detection backend.
 *
 * B4 fix (P0): centralises the client-side URL contract so that detection
 * is never triggered with an empty string or a non-wiki URL.
 */

/**
 * Feishu wiki URL contract:
 *   https://{subdomain}.feishu.cn/wiki/{nodeToken}
 *
 * Subdomain is required (typically a tenant identifier such as
 * `qcnbafdrjx7n.feishu.cn`). The /wiki/ prefix is mandatory — non-wiki
 * Feishu URLs (e.g. /docx/, /sheets/) are rejected because the change
 * detector expects a wiki node root.
 */
const FEISHU_WIKI_URL_PATTERN =
  /^https:\/\/[a-z0-9-]+\.feishu\.cn\/wiki\/[A-Za-z0-9]+/i;

/**
 * Validate that a string is a well-formed Feishu wiki root URL.
 *
 * @param url - candidate URL (may be empty / undefined)
 * @returns `true` only when the URL matches the wiki contract.
 */
export function isValidFeishuWikiUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  return FEISHU_WIKI_URL_PATTERN.test(trimmed);
}

/**
 * Type guard variant — narrows the input to `string` when truthy.
 *
 * Useful at call sites that need to feed the URL into APIs requiring a
 * non-null `string` (e.g. the change detection backend), where the boolean
 * form above cannot narrow the type.
 */
export function isUsableWikiUrl(
  url: string | null | undefined
): url is string {
  return isValidFeishuWikiUrl(url);
}

/**
 * Pick the first usable wiki root URL from a list.
 *
 * @returns the first valid wiki URL, or `null` if none is valid.
 */
export function pickFirstValidWikiUrl(
  urls: string[] | null | undefined
): string | null {
  if (!Array.isArray(urls)) return null;
  for (const url of urls) {
    if (isValidFeishuWikiUrl(url)) return url.trim();
  }
  return null;
}
