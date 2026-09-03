/**
 * Feishu URL helpers.
 *
 * Watched root URLs come in many shapes from the wiki share dialog:
 *   https://xxx.feishu.cn/wiki/<token>?fromScene=spaceOverview
 *   https://xxx.feishu.cn/wiki/<token>?ch=wiki_tab
 *   https://xxx.feishu.cn/wiki/<token>/              (trailing slash)
 *
 * lark-cli (and our backend) only cares about `/wiki/<token>`; query
 * params and trailing slashes leak into the URL match key used by the
 * change detector and lark-cli-client.ts (getNode). We normalise on the
 * client so the stored `watchedRootUrls[]` is the canonical form, and
 * display a hint when we had to strip something.
 *
 * NOTE: backend `lark-cli-client.ts` is intentionally untouched per Task
 * Contract. We do the normalisation here so the backend receives a clean
 * URL regardless.
 */

const FEISHU_WIKI_TOKEN_RE = /\/wiki\/([A-Za-z0-9]+)/;

export interface NormalizedFeishuUrl {
  /** Canonical form stored in watchedRootUrls: https://xxx.feishu.cn/wiki/<token> */
  canonical: string;
  /** True if the input had a query string or trailing slash that we stripped. */
  wasModified: boolean;
  /** True if the input parses to a /wiki/<token> URL we recognise. */
  isValid: boolean;
}

/**
 * Normalise a Feishu wiki URL to the canonical form used in storage.
 * Returns { canonical: input } unchanged when the input does not look
 * like a wiki URL (callers can still save it; we just won't pretend).
 */
export function normalizeFeishuUrl(input: string): NormalizedFeishuUrl {
  const raw = (input ?? '').trim();
  if (!raw) {
    return { canonical: '', wasModified: false, isValid: false };
  }

  const match = raw.match(FEISHU_WIKI_TOKEN_RE);
  if (!match) {
    return { canonical: raw, wasModified: false, isValid: false };
  }

  // Reconstruct as <origin>/wiki/<token>, dropping query/fragment/trailing slash.
  // We avoid `new URL` because Windows Electron renderer may receive URLs that
  // are technically valid for navigation but have unusual schemes; matching on
  // the wiki token is stricter and good enough.
  const tokenEnd = match.index! + match[0].length;
  const canonical = raw.slice(0, tokenEnd);
  const wasModified = canonical !== raw;

  return {
    canonical,
    wasModified,
    isValid: true,
  };
}

/**
 * Batch-normalise an array of URLs, deduplicating empty/identical entries.
 * Used when saving watchedRootUrls to ensure the persisted list is clean.
 */
export function normalizeFeishuUrlList(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const { canonical } = normalizeFeishuUrl(u);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * 从 canonical wiki URL 提取根节点 token（watchedRoots.id）。
 * 非合法 https://<租户>.feishu.cn/wiki/<token> 形式返回 null。
 */
export function extractWikiRootId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/wiki\/([A-Za-z0-9]+)$/);
    if (parsed.protocol !== 'https:' || !/\.feishu\.cn$/i.test(parsed.hostname) || !match) {
      return null;
    }
    return match[1];
  } catch {
    return null;
  }
}

/**
 * 从飞书 URL 提取租户域名（host / domain）。
 * 例如从 "https://qcnbafdrjx7n.feishu.cn/wiki/xxx" 提取 "qcnbafdrjx7n.feishu.cn"。
 * 非合法飞书域名返回 null。
 */
export function extractFeishuTenantHost(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' && /\.feishu\.cn$/i.test(parsed.hostname)) {
      return parsed.host;
    }
  } catch {
    // 容错降级正则
    const match = trimmed.match(/^https?:\/\/([a-z0-9-]+\.feishu\.cn)/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * 从配置中的 watchedRootUrls 或 watchedRoots 列表中解析出租户域名。
 * 返回首个有效租户 host，若均无有效地址则返回空字符串。
 */
export function resolveFeishuTenantHost(
  watchedRootUrls?: string[] | null,
  roots?: Array<{ url: string }> | null,
): string {
  if (Array.isArray(watchedRootUrls)) {
    for (const u of watchedRootUrls) {
      const host = extractFeishuTenantHost(u);
      if (host) return host;
    }
  }
  if (Array.isArray(roots)) {
    for (const r of roots) {
      const host = extractFeishuTenantHost(r?.url);
      if (host) return host;
    }
  }
  return '';
}

