/** Local Feishu sync can save a permission error as a Markdown placeholder.
 * Detect only that specific generated notice, not ordinary discussion of access. */
export function isPermissionDeniedSourcePlaceholder(content: string): boolean {
  const header = content.slice(0, 2500);
  return header.includes('该文档在飞书侧权限受限')
    && /API 返回\s*40403\s*no permission/i.test(header)
    && header.includes('向文档所有者申请权限');
}

/** A synced-reference marker contains no copied source content. Skip only the
 * generated shell whose remaining body says it refers to another design; any
 * other prose, image, or table makes the source available for real review. */
export function isUnresolvedSyncedReferencePlaceholder(content: string): boolean {
  let body = content.replace(/^\s*<!--\s*\r?\nfeishu_sync:[\s\S]*?-->\s*/i, '');
  const reference = /<synced_reference\b[^>]*\bsrc-token="[^"]+"[^>]*>\s*<\/synced_reference>/gi;
  if (!body.match(reference)) return false;
  body = body.replace(reference, '').replace(/^# [^\r\n]+\r?\n?/, '').trim();
  return /^引用\s*\d{3}\s*(?:的)?设计[。.]?$/u.test(body);
}
