/** Local Feishu sync can save a permission error as a Markdown placeholder.
 * Detect only that specific generated notice, not ordinary discussion of access. */
export function isPermissionDeniedSourcePlaceholder(content: string): boolean {
  const header = content.slice(0, 2500);
  return header.includes('该文档在飞书侧权限受限')
    && /API 返回\s*40403\s*no permission/i.test(header)
    && header.includes('向文档所有者申请权限');
}
