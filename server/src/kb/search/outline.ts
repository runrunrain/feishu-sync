import { normalize } from './normalize.js';
import { QueryError } from './query-error.js';

export interface KbSection {
  level: 1 | 2 | 3; heading: string; headingPath: string; anchor: string;
  startLine: number; endLine: number; chars: number;
  normStart: number; normEnd: number; normHeading: string;
}
export interface KbTable { headerLine: number; startLine: number; endLine: number }
export interface KbOutline { sections: KbSection[]; tables: KbTable[] }

/** H2/H3 sections do not overlap. H2 reads may include their descendant H3s. */
export function buildOutline(lines: string[], docPath: string, title: string): KbOutline {
  const sections: KbSection[] = [];
  const tables: KbTable[] = [];
  let fence: { char: string; length: number } | undefined;
  let h2 = '';
  let table: KbTable | undefined;
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + normalize(line).length + 1);
  const add = (level: 1 | 2 | 3, heading: string, headingPath: string, startLine: number) => {
    sections.push({ level, heading, headingPath, anchor: headingPath ? `${docPath}#${headingPath}` : docPath,
      startLine, endLine: lines.length, chars: 0, normStart: offsets[startLine - 1], normEnd: 0, normHeading: normalize(headingPath || heading) });
  };
  add(1, title, '', 1);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      if (!fence) fence = { char: f[1][0], length: f[1].length };
      else if (f[1][0] === fence.char && f[1].length >= fence.length && !f[2].trim()) fence = undefined;
      table = undefined;
      continue;
    }
    if (fence) continue;
    if (/^\|/.test(line)) {
      if (!table) { table = { headerLine: i + 1, startLine: i + 1, endLine: i + 1 }; tables.push(table); }
      table.endLine = i + 1;
    } else table = undefined;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    if (level === 2) { h2 = match[2]; add(2, match[2], match[2], i + 1); }
    if (level === 3) add(3, match[2], h2 ? `${h2} › ${match[2]}` : match[2], i + 1);
  }
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    s.endLine = (sections[i + 1]?.startLine ?? lines.length + 1) - 1;
    s.normEnd = Math.max(s.normStart, offsets[s.endLine] - 1);
    s.chars = lines.slice(s.startLine - 1, s.endLine).join('\n').length;
  }
  return { sections: sections.filter((s) => s.endLine >= s.startLine), tables };
}

export function sectionAt(sections: KbSection[], line: number): KbSection | undefined {
  return sections.find((s) => s.startLine <= line && line <= s.endLine);
}
export function splitAnchor(ref: string, knownPaths: readonly string[] = []): { path: string; section?: string } {
  // '#' is legal in a published filename: exact file first, then its longest anchor prefix.
  if (knownPaths.includes(ref)) return { path: ref };
  const file = knownPaths.filter((candidate) => ref.startsWith(`${candidate}#`)).sort((a, b) => b.length - a.length)[0];
  if (file) return { path: file, section: ref.slice(file.length + 1) };
  const at = ref.indexOf('#');
  return at < 0 ? { path: ref } : { path: ref.slice(0, at), section: ref.slice(at + 1) };
}
export function resolveAnchor(sections: KbSection[], ref: string): KbSection {
  // Full anchors and heading paths use the same canonical comparison.
  // A heading itself may contain '#'; prefer literal heading matches before parsing a full anchor.
  let heading = ref;
  let candidates = sections.filter((s) => s.headingPath === heading && s.headingPath);
  if (!candidates.length) candidates = sections.filter((s) => s.heading === heading);
  if (!candidates.length && ref.includes('#')) {
    heading = ref.slice(ref.indexOf('#') + 1);
    candidates = sections.filter((s) => s.headingPath === heading && s.headingPath);
    if (!candidates.length) candidates = sections.filter((s) => s.heading === heading);
  }
  if (candidates.length > 1) throw new QueryError('kb_section_ambiguous', '章节标题不唯一，请使用完整 headingPath', { candidates: candidates.map((s) => s.headingPath).slice(0, 50) });
  if (!candidates.length) throw new QueryError('kb_section_not_found', '章节不存在', { candidates: sections.filter((s) => s.headingPath).map((s) => s.headingPath).slice(0, 50) });
  return candidates[0];
}
export function sectionRange(sections: KbSection[], section: KbSection, lineCount: number): { start: number; end: number } {
  if (section.level === 1) return { start: section.startLine, end: section.endLine };
  const index = sections.indexOf(section);
  const next = sections.slice(index + 1).find((s) => s.level <= section.level);
  return { start: section.startLine, end: (next?.startLine ?? lineCount + 1) - 1 };
}
