import { normalizeLine } from './normalize.js';
import type { KbIndexDoc } from './index-types.js';
import type { KbSection } from './outline.js';
import type { ParsedQuery } from './query.js';

export interface SnippetHit { line: number; heading: string; anchor: string; snippet: string }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Offset map handles NFKC expansions, combining marks, and removed Markdown marks. */
export function normalizedSpans(line: string, terms: string[], caseSensitive = false): Array<[number, number]> {
  let nfkc = '';
  const nfkcStarts: number[] = [], nfkcEnds: number[] = [];
  for (const m of graphemes.segment(line)) {
    const chunk = m.segment.normalize('NFKC');
    for (let i = 0; i < chunk.length; i++) { nfkcStarts.push(m.index); nfkcEnds.push(m.index + m.segment.length); }
    nfkc += chunk;
  }
  const loweredStarts: number[] = [], loweredEnds: number[] = [];
  let offset = 0;
  for (const ch of nfkc) {
    const lowered = caseSensitive ? ch : ch.toLowerCase();
    for (let i = 0; i < lowered.length; i++) { loweredStarts.push(nfkcStarts[offset]); loweredEnds.push(nfkcEnds[offset + ch.length - 1]); }
    offset += ch.length;
  }
  const lowered = caseSensitive ? nfkc : nfkc.toLowerCase();
  let text = '';
  const starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < lowered.length;) {
    if (['**', '__', '~~'].some((mark) => lowered.startsWith(mark, i))) { i += 2; continue; }
    if (lowered[i] === '`') { i++; continue; }
    text += lowered[i] === '\t' ? ' ' : lowered[i];
    starts.push(loweredStarts[i]); ends.push(loweredEnds[i]); i++;
  }
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) continue;
    let at = 0;
    while ((at = text.indexOf(term, at)) >= 0) { ranges.push([starts[at], ends[at + term.length - 1]]); at += term.length; }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  return merged;
}
export function clipLine(line: string, at: number, max: number): string {
  const start = Math.max(0, at - Math.floor((max - 2) / 2));
  const end = Math.min(line.length, start + max - (start > 0 ? 1 : 0) - 1);
  return `${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}
function markedSnippet(line: string, terms: string[], max: number): string {
  const ranges = normalizedSpans(line, terms);
  const at = ranges[0]?.[0] ?? 0;
  const focusLength = ranges[0] ? ranges[0][1] - at : 0;
  const coreLength = Math.min(focusLength, max - 4);
  const start = Math.max(0, at - Math.min(60, Math.floor((max - 4 - coreLength) / 2)));
  const end = Math.min(line.length, Math.max(at + coreLength, Math.min(at + focusLength + 60, start + max - 4)));
  let text = start ? '…' : '', position = start;
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue;
    const from = Math.max(a, start), to = Math.min(b, end);
    text += line.slice(position, from) + '⟦' + line.slice(from, to) + '⟧'; position = to;
  }
  text += line.slice(position, end) + (end < line.length ? '…' : '');
  // Trim in a marker-aware fashion: a whole marked token is an indivisible piece.
  let result = '';
  for (const part of text.match(/⟦[^⟧]*⟧|[^⟦]/gu) ?? []) {
    if (result.length + part.length > max - 1) return result + '…';
    result += part;
  }
  return result;
}
export function makeSnippet(doc: KbIndexDoc, section: KbSection, query: ParsedQuery): SnippetHit {
  const terms = query.units.flatMap((u) => query.fallback[u] ?? [u]);
  let line = section.startLine, best = -1;
  for (let i = section.startLine; i <= section.endLine; i++) {
    const norm = normalizeLine(doc.lines[i - 1]);
    const count = query.units.filter((u) => (query.fallback[u] ?? [u]).some((t) => norm.includes(t))).length;
    if (count > best) { line = i; best = count; }
  }
  const table = doc.tables.find((t) => t.startLine < line && line <= t.endLine);
  const header = table ? `表头: ${clipLine(doc.lines[table.headerLine - 1], 0, 76)}\n` : '';
  return { line, heading: section.headingPath || section.heading, anchor: section.anchor,
    snippet: header + markedSnippet(doc.lines[line - 1], terms, 160 - header.length) };
}
