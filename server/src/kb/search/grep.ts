import type { KbIndexDoc } from './index-types.js';
import { normalizeLine, comparePath, matchesPrefix } from './normalize.js';
import { sectionAt } from './outline.js';
import { clipLine, normalizedSpans } from './snippet.js';
import { invalid } from './query-error.js';
export interface GrepOptions { pattern: string; mode?: 'literal'|'regex'; caseSensitive?: boolean; pathPrefix?: string; context?: number }
export interface GrepMatch { line: number; heading: string; anchor: string; text: string; tableHeader?: string; before?: Array<{ line: number; text: string }>; after?: Array<{ line: number; text: string }> }
export interface GrepEntry { path: string; title: string; match: GrepMatch }
export interface GrepScan { entries: GrepEntry[]; complete: boolean; partialReason?: string; regexTruncatedLines: number }
/** Soft protection only: a single JS RegExp.exec cannot be interrupted. */
export function grepDocs(docs: KbIndexDoc[], opts: GrepOptions, timing: { now?: () => number; budgetMs?: number } = {}): GrepScan {
  if (typeof opts.pattern !== 'string' || !opts.pattern.length || opts.pattern.length > 200) invalid('pattern');
  const mode = opts.mode ?? 'literal';
  if (!['literal', 'regex'].includes(mode)) invalid('mode');
  const context = opts.context ?? 0;
  if (!Number.isInteger(context) || context < 0 || context > 3) invalid('context');
  let re: RegExp | undefined;
  if (mode === 'regex') {
    if (/(\(.*[+*}]\)[+*{])/.test(opts.pattern)) invalid('pattern', '拒绝嵌套量词正则');
    try { re = new RegExp(opts.pattern, opts.caseSensitive ? 'u' : 'ui'); } catch { invalid('pattern', '正则表达式无效'); }
  }
  const literal = normalizeLine(opts.pattern, opts.caseSensitive);
  if (!re && !literal) invalid('pattern', '规范化后的 pattern 不能为空');
  const now = timing.now ?? Date.now, start = now();
  const entries: GrepEntry[] = [];
  let processed = 0, regexTruncatedLines = 0;
  for (const doc of [...docs].sort((a, b) => comparePath(a.path, b.path))) {
    if (!matchesPrefix(doc.path, opts.pathPrefix)) continue;
    for (let i = 0; i < doc.lines.length; i++) {
      if (re && processed++ % 1000 === 0 && now() - start > (timing.budgetMs ?? 300)) return { entries, complete: false, partialReason: 'regex_time_budget', regexTruncatedLines };
      const raw = doc.lines[i];
      let at: number;
      if (re) {
        if (raw.length > 2000) regexTruncatedLines++;
        const hit = re.exec(raw.slice(0, 2000));
        if (!hit) continue;
        at = hit.index;
      } else {
        const norm = normalizeLine(raw, opts.caseSensitive);
        if (!norm.includes(literal)) continue;
        // Plain matches need no NFKC-to-source offset map (important for exhaustive high-df scans).
        const plain = opts.caseSensitive ? raw : raw.toLowerCase();
        const direct = plain.length === raw.length ? plain.indexOf(literal) : -1;
        at = direct >= 0 ? direct : normalizedSpans(raw, [literal], opts.caseSensitive)[0]?.[0] ?? 0;
      }
      const line = i + 1, section = sectionAt(doc.sections, line);
      const table = doc.tables.find((t) => t.headerLine !== line && t.startLine <= line && line <= t.endLine);
      const ctx = (a: number, b: number) => doc.lines.slice(a, b).map((text, k) => ({ line: a + k + 1, text: clipLine(text, 0, 200) }));
      entries.push({ path: doc.path, title: doc.title, match: { line, heading: section?.headingPath || section?.heading || doc.title,
        anchor: section?.anchor ?? doc.path, text: clipLine(raw, at, 200),
        ...(table ? { tableHeader: clipLine(doc.lines[table.headerLine - 1], 0, 80) } : {}),
        ...(context ? { before: ctx(Math.max(0, i - context), i), after: ctx(i + 1, Math.min(doc.lines.length, i + 1 + context)) } : {}) } });
    }
  }
  return { entries, complete: true, regexTruncatedLines };
}
