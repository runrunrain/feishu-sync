/** lex-v1 coordinates are body-line coordinates; never normalize across a newline. */
export function normalizeLine(value: string, caseSensitive = false): string {
  const nfkc = value.normalize('NFKC');
  return (caseSensitive ? nfkc : nfkc.toLowerCase()).replace(/\*\*|__|~~|`/g, '').replace(/\t/g, ' ');
}
export function normalize(value: string): string {
  return value.split('\n').map((line) => normalizeLine(line)).join('\n');
}
export function normalizePath(value: string): string {
  return normalize(value).replace(/\.md$/i, '').replace(/[/_-]/g, ' ');
}
export function comparePath(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function matchesPrefix(docPath: string, prefix = ''): boolean {
  const p = prefix.replace(/\/+$/, '');
  return !p || docPath === p || docPath.startsWith(p + '/');
}
