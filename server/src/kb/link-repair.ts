import path from 'node:path';
import { FenceTracker } from './knowledge-compiler.js';

export interface LinkRepair { from: string; to: string }

/** D2(b) 写入期提示：正文中相对 .md 链接的目标既不在已知文档集合（草稿/
 * 已发布/当前分配）内、也不指向本文档时，发布门禁 kb_link_invalid 必然
 * 拦截。返回 `dest → resolved` 形式的目标清单（去重、按出现序）。守卫条件
 * 与 repairRelativeMdLinks 镜像（围栏/缩进代码/行内代码/图片/外链/绝对
 * 路径/纯锚点/非 .md 目标/带 % 转义均跳过），刻意不复用其重写路径——
 * 发布链路零改动，本函数只读提示。 */
export function findMissingRelativeMdTargets(markdown: string, docPath: string, knownPaths: Iterable<string>): string[] {
  const known = new Set(knownPaths);
  known.add(docPath);
  const missing: string[] = [];
  const seen = new Set<string>();
  const record = (destination: string, resolved: string): void => {
    if (known.has(resolved) || seen.has(destination)) return;
    seen.add(destination);
    missing.push(`${destination} → ${resolved}`);
  };
  const fence = new FenceTracker();
  let inlineDelimiter = 0;
  const dir = path.posix.dirname(docPath);
  for (const line of markdown.split('\n')) {
    if (FenceTracker.fenceRunOf(line)) { fence.visit(line); continue; }
    if (fence.inside) continue;
    if (/^(?: {4}|\t)/.test(line)) continue;
    const codeOffsets = new Set<number>();
    for (let i = 0; i < line.length;) {
      if (line[i] === '\\' && !inlineDelimiter && i + 1 < line.length) { i += 2; continue; }
      if (line[i] === '`') {
        let end = i + 1;
        while (line[end] === '`') end++;
        const count = end - i;
        if (!inlineDelimiter) inlineDelimiter = count;
        else if (inlineDelimiter === count) inlineDelimiter = 0;
        for (let j = i; j < end; j++) codeOffsets.add(j);
        i = end;
        continue;
      }
      if (inlineDelimiter) codeOffsets.add(i);
      i++;
    }
    for (const match of line.matchAll(/(!?\[[^\]]*]\()([^\s)]+)(\))/g)) {
      const destination = match[2]!;
      const offset = match.index ?? 0;
      if (codeOffsets.has(offset) || match[1]!.startsWith('!') || /^[a-z][a-z0-9+.-]*:/i.test(destination)
        || destination.startsWith('/') || destination.startsWith('#')) continue;
      const hash = destination.indexOf('#');
      const target = hash < 0 ? destination : destination.slice(0, hash);
      if (!/\.md$/i.test(target) || target.includes('?') || target.includes('\\') || /%[0-9a-f]{2}/i.test(target)) continue;
      record(destination, path.posix.normalize(path.posix.join(dir, target)));
    }
  }
  return missing;
}

/** Repair only a missing relative Markdown target with a unique basename. */
export function repairRelativeMdLinks(markdown: string, docPath: string, knownPaths: Iterable<string>): { markdown: string; repairs: LinkRepair[] } {
  const known = new Set(knownPaths);
  const repairs: LinkRepair[] = [];
  const fence = new FenceTracker();
  // Carry delimiter length across line breaks. Unclosed delimiters are treated
  // conservatively as code: missing a repair is safer than modifying a sample.
  let inlineDelimiter = 0;
  const lines = markdown.split('\n').map(line => {
    if (FenceTracker.fenceRunOf(line)) { fence.visit(line); return line; }
    if (fence.inside) return line;
    if (/^(?: {4}|\t)/.test(line)) return line;
    const codeOffsets = new Set<number>();
    for (let i = 0; i < line.length;) {
      if (line[i] === '\\' && !inlineDelimiter && i + 1 < line.length) { i += 2; continue; }
      if (line[i] === '`') {
        let end = i + 1;
        while (line[end] === '`') end++;
        const count = end - i;
        if (!inlineDelimiter) inlineDelimiter = count;
        else if (inlineDelimiter === count) inlineDelimiter = 0;
        for (let j = i; j < end; j++) codeOffsets.add(j);
        i = end;
        continue;
      }
      if (inlineDelimiter) codeOffsets.add(i);
      i++;
    }
    return line.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (full, prefix: string, destination: string, suffix: string, offset: number) => {
      if (codeOffsets.has(offset) || prefix.startsWith('!') || /^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('/') || destination.startsWith('#')) return full;
      const hash = destination.indexOf('#');
      const target = hash < 0 ? destination : destination.slice(0, hash);
      if (!/\.md$/i.test(target) || target.includes('?') || target.includes('\\') || /%[0-9a-f]{2}/i.test(target)) return full;
      const dir = path.posix.dirname(docPath);
      if (known.has(path.posix.normalize(path.posix.join(dir, target)))) return full;
      const candidates = [...known].filter(candidate => path.posix.basename(candidate) === path.posix.basename(target));
      if (candidates.length !== 1) return full;
      const relative = path.posix.relative(dir, candidates[0]!);
      const next = relative + (hash < 0 ? '' : destination.slice(hash));
      repairs.push({ from: destination, to: next });
      return prefix + next + suffix;
    });
  });
  return { markdown: lines.join('\n'), repairs };
}
