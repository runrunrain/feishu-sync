/** Shared lexical scoring for in-app raw_search and external MCP. */
import { canFallback, fallbackTerms, parseQuery } from './search/query.js';

/** Only use fragment recall when a single unquoted phrase has no exact hit. */
export function rawFallbackTerms(query: string): string[] {
  const parsed = parseQuery(query);
  if (parsed.units.length !== 1 || parsed.phrases?.includes(parsed.units[0]) || !canFallback(parsed.units[0])) return [];
  return fallbackTerms(parsed.units[0], []).slice(0, 12);
}

export function scoreRawFallback(title: string, relPath: string, content: string, fragments: string[]): { score: number; snippet: string; matchedFragments: string[] } {
  const haystack = `${title}\n${relPath}\n${content}`.toLowerCase();
  const matchedFragments = fragments.filter((fragment) => haystack.includes(fragment));
  if (matchedFragments.length < 2) return { score: 0, snippet: '', matchedFragments: [] };
  const result = scoreRawText(title, relPath, content, matchedFragments);
  return { score: result.score * 0.1, snippet: result.snippet, matchedFragments };
}

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
