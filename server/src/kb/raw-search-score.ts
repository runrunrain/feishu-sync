/** Shared lexical scoring for in-app raw_search and external MCP. */
export function scoreRawText(title: string, relPath: string, content: string, units: string[]): { score: number; snippet: string } {
  const lower = content.toLowerCase(); let score = 0, matched = 0, first = -1, length = 0;
  for (const unit of units) {
    let value = Number(title.toLowerCase().includes(unit)) * 10 + Number(relPath.toLowerCase().includes(unit)) * 5;
    const at = lower.indexOf(unit);
    if (at >= 0) { value += 20; if (first < 0 || at < first) { first = at; length = unit.length; } }
    score += value; if (value) matched++;
  }
  const start = Math.max(0, first - 60);
  return { score: score * (0.5 + matched / (units.length || 1)),
    snippet: first < 0 ? '' : `${start > 0 ? '…' : ''}${content.slice(start, first + length + 100).replace(/\n+/g, ' ')}…` };
}
