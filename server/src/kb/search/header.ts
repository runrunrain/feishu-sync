/** Shared reader helper: importing it must not pull Store/Service into a cycle. */
export function stripStdHeader(markdown: string): string {
  const match = /^<!--\s*\nfeishu_sync_kb:[\s\S]*?\n-->\s*\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}
