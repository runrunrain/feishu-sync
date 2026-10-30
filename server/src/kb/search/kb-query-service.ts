/** The only query facade for UI, built-in tools, stdio and LAN MCP. No session state or writes. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../../agent/path-guard.js';
import type { KbManifest } from '../../types/agent-knowledge.js';
import type { KbVersionDto } from '../../types/kb-version.js';
import { l1SearchDocs } from '../kb-search.js';
import { buildKbIndex, type BuildIndexOptions } from './kb-index.js';
import type { KbIndex, KbIndexDoc } from './index-types.js';
import { KbIndexCache } from './kb-index-cache.js';
import { rankLexV1 } from './rank-lex-v1.js';
import { makeSnippet, type SnippetHit } from './snippet.js';
import { grepDocs, type GrepMatch } from './grep.js';
import { comparePath, matchesPrefix } from './normalize.js';
import { parseQuery, queryHints } from './query.js';
import { resolveAnchor, sectionRange, splitAnchor } from './outline.js';
import { resolveRelease as resolvePublishedRelease, availableReleases, validateReleaseId, type ResolvedRelease } from './release-reader.js';
import { QueryError, invalid } from './query-error.js';
import { KB_COVERAGE_NOTE, sourceVersionWarning, suggestDocPaths } from './query-metadata.js';
export { QueryError } from './query-error.js';
export { resolveRelease, readCurrent } from './release-reader.js';
export type { ResolvedRelease } from './release-reader.js';

export interface PageParams { releaseId?: string; cursor?: string; maxChars?: number }
export interface SearchParams extends PageParams { query: string; limit?: number; pathPrefix?: string; tags?: string[]; maxSnippets?: number }
export interface SearchResultHit { docId: string; path: string; title: string; summary: string; snippet: string; score?: number; coverage?: number; matchedUnits?: string[]; fallbackUnits?: string[]; matchType?: 'exact'|'fallback'; hits?: SnippetHit[] }
export interface SearchResult { releaseId: string; ranker: 'lex-v1'|'l1'; rankerVersion: 'lex-v1'|'l1'; query: ReturnType<typeof parseQuery>; total: number; results: SearchResultHit[]; next: string|null; unmatchedUnits: string[]; warning?: string; hint?: string[] }
export interface GrepParams extends PageParams { pattern: string; mode?: 'literal'|'regex'; caseSensitive?: boolean; pathPrefix?: string; context?: number; maxMatches?: number }
export interface GrepResult { releaseId: string; mode: 'literal'|'regex'; hint?: string; totalMatches: number; totalFiles: number; complete: boolean; partial?: boolean; partialReason?: string; regexTruncatedLines?: number; files: Array<{ path: string; title: string; matches: GrepMatch[] }>; next: string|null }
export interface OutlineParams extends PageParams { path?: string; docId?: string; pathPrefix?: string; depth?: 2|3 }
export interface ReadParams { path?: string; docId?: string; section?: string; startLine?: number; maxLines?: number; includeSources?: boolean; releaseId?: string; maxChars?: number }
export interface BundleParams extends PageParams { pathPrefix?: string; paths?: string[]; dryRun?: boolean; lineNumbers?: boolean }
export interface ListParams extends PageParams { pathPrefix?: string; depth?: number; includeSummary?: boolean }
export interface ReleaseInfoParams extends PageParams { includeChanges?: boolean }
export interface TextPage { releaseId: string; text: string; next: string|null }
export interface ReadPage { releaseId: string; text: string; next: number|null; startLine: number; endLine: number }
export interface ReleaseInfoResult {
  releaseId: string; buildId: string; mode: KbManifest['mode']; baseReleaseId: string|null; publishedAt: string; model: string|null;
  docCount: number; sourceCount: number; bodyChars: number; ranker: 'lex-v1'|'l1'; toolsVersion: '2';
  integrity: KbIndex['integrity']; availableReleases: string[];
  coverage: { kind: 'curated'; note: string; referencedSourceCount: number; skippedSourceCount: number };
  sources: Array<{ objToken: string; title: string; relPath: string; referencedBy: number; warning?: ReturnType<typeof sourceVersionWarning> }>;
  changes?: { summary: string; docs: Array<Pick<KbVersionDto['docChanges'][number], 'path'|'title'|'kind'|'additions'|'deletions'|'reason'> & { mergedInto?: string[]|null; removalNote?: string }> }|null;
  next: string|null;
}
interface Cursor { v: 1; r: string; t: string; h: string; o: number }
export interface KbQueryServiceOptions extends BuildIndexOptions { maxChars?: number; cache?: KbIndexCache; prewarm?: boolean; onWarmError?: (error: unknown) => void }
function int(value: number|undefined, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) invalid(field, `${field} 必须在 ${min}..${max}`);
  return value;
}
function bool(value: boolean|undefined, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(field); return value;
}
function string(value: string|undefined, field: string): void { if (value !== undefined && typeof value !== 'string') invalid(field); }
function prefix(value?: string): string {
  string(value, 'pathPrefix'); const p = (value ?? '').replace(/\/+$/, '');
  if (p && (p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => !s || s === '..' || s === '.') || /[:\0]/.test(p))) invalid('pathPrefix');
  return p;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => comparePath(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(params: unknown): string { return crypto.createHash('sha256').update(canonical(params)).digest('base64url'); }
function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decode(value: string): Cursor {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (c.v !== 1 || typeof c.r !== 'string' || typeof c.t !== 'string' || typeof c.h !== 'string' || !Number.isSafeInteger(c.o) || c.o < 0) throw new Error();
    validateReleaseId(c.r);
    return c;
  } catch { throw new QueryError('invalid_cursor', '游标格式无效'); }
}
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function safeBody(value: string): string { return value.replace(/<\/kb_doc>/g, '<\\/kb_doc>'); }
function bodyLine(value: string, no: number, numbers: boolean): string {
  const limited = value.length > 2000 ? value.slice(0, 2000 - '…[行截断]'.length) + '…[行截断]' : value;
  return `${numbers ? `${String(no).padStart(6)}\t` : ''}${safeBody(limited)}\n`;
}
function frame(doc: KbIndexDoc, releaseId: string, start: number, end: number, numbers: boolean, section?: string, part?: string): string {
  return `<kb_doc path="${xml(doc.path)}" docId="${xml(doc.docId)}" release="${xml(releaseId)}" lines="${start}-${end}/${doc.lines.length}"${section ? ` section="${xml(section)}"` : ''}${part ? ` part="${part}"` : ''}>\n`
    + doc.lines.slice(start - 1, end).map((line, i) => bodyLine(line, start + i, numbers)).join('') + '</kb_doc>\n';
}

export class KbQueryService {
  readonly cache: KbIndexCache;
  readonly maxChars: number;
  constructor(public readonly kbRoot: string, private readonly options: KbQueryServiceOptions = {}) {
    this.cache = options.cache ?? new KbIndexCache();
    const env = Number(process.env.KB_MCP_MAX_CHARS);
    const hardLimit = Number.isInteger(env) && env >= 2000 ? env : 20000;
    this.maxChars = int(options.maxChars, hardLimit, 2000, hardLimit, 'maxChars');
    if (options.prewarm !== false) setImmediate(() => { void this.prewarmCurrent().catch((e) => {
      if (options.onWarmError) options.onWarmError(e); else console.warn('[kb-search] prewarm failed:', e);
    }); });
  }
  resolveRelease(releaseId?: string): ResolvedRelease { return resolvePublishedRelease(this.kbRoot, releaseId); }
  async prewarmCurrent(): Promise<void> {
    try { await this.load(this.resolveRelease()); }
    catch (e) { if (e instanceof QueryError && e.code === 'kb_not_published') return; throw e; }
  }
  private async load(release: ResolvedRelease): Promise<KbIndex> {
    try {
      const index = await this.cache.get(release.releaseDir, () => buildKbIndex(release.releaseDir, release.manifest, this.options));
      // A build yielded; cleanup may have removed its directory while it was in flight.
      if (!fs.existsSync(release.releaseDir) || fs.realpathSync.native(release.releaseDir) !== release.releaseDir || !fs.statSync(release.releaseDir).isDirectory()) {
        this.cache.delete(release.releaseDir);
        throw new QueryError('kb_release_unavailable', '版本已被清理或路径发生变化', { currentReleaseId: release.currentReleaseId ?? null });
      }
      return index;
    } catch (e) {
      if (e instanceof QueryError) throw e;
      throw new QueryError('kb_index_failed', '无法构建知识库索引', { detail: String(e) });
    }
  }
  private budget(params: { maxChars?: number }, fallback: number): number {
    // Fixed headroom for the transport's release-switch notice. Keep this policy in the
    // shared facade so all readers paginate identically and cursor digests remain stable.
    return int(params.maxChars, Math.min(fallback, this.maxChars), 2000, this.maxChars, 'maxChars') - 512;
  }
  private async begin(tool: string, params: PageParams, normalized: unknown): Promise<{ release: ResolvedRelease; index: KbIndex; offset: number; next: (o: number) => string }> {
    const hash = digest(normalized), cursor = params.cursor === undefined ? undefined : decode(params.cursor);
    if (cursor && (cursor.t !== tool || cursor.h !== hash || (params.releaseId !== undefined && params.releaseId !== cursor.r))) throw new QueryError('invalid_cursor', '游标与参数或版本不匹配');
    const release = this.resolveRelease(params.releaseId ?? cursor?.r);
    const index = await this.load(release);
    return { release, index, offset: cursor?.o ?? 0, next: (o) => encode({ v: 1, r: release.releaseId, t: tool, h: hash, o }) };
  }
  private checkOffset(offset: number, length: number): void { if (offset > length) throw new QueryError('invalid_cursor', '游标偏移超出结果'); }
  private jsonPage<T>(items: T[], offset: number, limit: number, budget: number, next: (o: number) => string, render: (items: T[], cursor: string|null) => object): object {
    this.checkOffset(offset, items.length);
    const page: T[] = [];
    for (let i = offset; i < items.length && page.length < limit; i++) {
      const candidate = [...page, items[i]], cursor = i + 1 < items.length ? next(i + 1) : null;
      if (JSON.stringify(render(candidate, cursor)).length > budget) break;
      page.push(items[i]);
    }
    const cursor = offset + page.length < items.length ? next(offset + page.length) : null;
    if ((!page.length && offset < items.length) || JSON.stringify(render(page, cursor)).length > budget) invalid('maxChars', '预算不足以容纳一个完整结果，请增加 maxChars');
    return render(page, cursor);
  }
  private textPage(lines: string[], offset: number, budget: number, next: (o: number) => string, header: string, releaseId: string): TextPage {
    this.checkOffset(offset, lines.length);
    let text = header, used = 0;
    for (let i = offset; i < lines.length; i++) {
      const cursor = i + 1 < lines.length ? `next: ${next(i + 1)}\n` : '';
      if (text.length + lines[i].length + cursor.length > budget) break;
      text += lines[i]; used++;
    }
    const cursor = offset + used < lines.length ? next(offset + used) : null;
    if ((!used && offset < lines.length) || text.length + (cursor ? `next: ${cursor}\n`.length : 0) > budget) invalid('maxChars', '预算不足以容纳一个完整结果');
    if (cursor) text += `next: ${cursor}\n`;
    return { releaseId, text, next: cursor };
  }
  private findDoc(release: ResolvedRelease, index: KbIndex, ref: { path?: string; docId?: string }): KbIndexDoc {
    string(ref.path, 'path'); string(ref.docId, 'docId');
    if (Number(ref.path !== undefined) + Number(ref.docId !== undefined) !== 1) invalid('path', 'path/docId 必须二选一');
    const doc = ref.path !== undefined ? index.byPath.get(ref.path) : index.byDocId.get(ref.docId!);
    if (doc !== undefined) return index.docs[doc];
    const entry = release.manifest.docs.find((d) => ref.path !== undefined ? d.path === ref.path : d.docId === ref.docId);
    if (entry) throw new QueryError('kb_integrity_error', '文档缺失、越界或内容哈希不匹配', { path: entry.path });
    const term = ref.path ?? ref.docId ?? '';
    const suggestions = suggestDocPaths(index.docs, term, ref.docId !== undefined);
    throw new QueryError('kb_not_found', '文档不存在', { suggestions });
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const parsed = parseQuery(params.query), limit = int(params.limit, 10, 1, 30, 'limit');
    const maxSnippets = int(params.maxSnippets, 2, 0, 3, 'maxSnippets'), pathPrefix = prefix(params.pathPrefix);
    if (params.tags !== undefined && (!Array.isArray(params.tags) || params.tags.length > 5 || !params.tags.every((t) => typeof t === 'string'))) invalid('tags');
    const tags = [...new Set(params.tags ?? [])].sort();
    const budget = this.budget(params, 8000);
    const state = await this.begin('search', params, { query: params.query, limit, maxSnippets, pathPrefix, tags, budget });
    const { release, index, offset, next } = state;
    const ranker = process.env.FEISHU_KB_RANKER === 'l1' ? 'l1' : 'lex-v1';
    let query = parsed, results: Array<() => SearchResultHit>;
    const selected = (doc: KbIndexDoc) => matchesPrefix(doc.path, pathPrefix) && tags.every((t) => doc.tags.includes(t));
    if (ranker === 'l1') {
      const docs = index.docs.filter(selected);
      // L1's historical 50-result cap must not truncate the facade's pagination.
      results = l1SearchDocs(docs.map((d) => ({ ...d, headings: d.sections.map((s) => s.headingPath) })), params.query, Number.MAX_SAFE_INTEGER,
        (d) => index.docs[index.byPath.get(d.path)!].lines.join('\n'), true).map((hit) => () => hit);
    } else {
      const ranked = rankLexV1(index, params.query); query = ranked.query;
      results = ranked.ranked.filter((r) => selected(r.doc)).map((r) => {
        let hit: SearchResultHit | undefined;
        return () => {
          if (!hit) {
            const hits = r.sections.filter((s, i) => s.score > 0 || i === 0).slice(0, maxSnippets).map((s) => makeSnippet(r.doc, s.section, query));
            hit = { docId: r.doc.docId, path: r.doc.path, title: r.doc.title, summary: r.doc.summary.slice(0, 120),
              snippet: hits[0]?.snippet ?? '', hits, score: Math.round(r.score * 100) / 100, coverage: r.coverage,
              matchedUnits: r.matchedUnits, fallbackUnits: r.fallbackUnits, matchType: r.matchedUnits.length ? 'exact' : 'fallback' };
          }
          return hit;
        };
      });
    }
    const selectedDocs = index.docs.filter(selected);
    const unmatchedUnits = query.units.filter((unit) => !selectedDocs.some((doc) => doc.normAll.includes(unit) || Object.values(doc.meta).some((v) => v.includes(unit))));
    const base = { releaseId: release.releaseId, ranker, rankerVersion: ranker, query, total: results.length, unmatchedUnits,
      ...(unmatchedUnits.length ? { warning: '部分完整关键词在当前检索范围内未命中；回退片段仅供改写查询参考，不代表已覆盖所问主题。' } : {}),
      ...(!results.length ? { hint: queryHints(query, index.vocab) } : {}) };
    return this.jsonPage(results, offset, limit, budget, next, (page, cursor) => ({ ...base, results: page.map((build) => build()), next: cursor })) as SearchResult;
  }

  async grep(params: GrepParams): Promise<GrepResult> {
    const pathPrefix = prefix(params.pathPrefix), context = int(params.context, 0, 0, 3, 'context');
    const maxMatches = int(params.maxMatches, 100, 1, 500, 'maxMatches'), mode = params.mode ?? 'literal';
    const caseSensitive = bool(params.caseSensitive, false, 'caseSensitive'), budget = this.budget(params, 12000);
    const { release, index, offset, next } = await this.begin('grep', params, { pattern: params.pattern, mode, caseSensitive, pathPrefix, context, maxMatches, budget });
    const scan = grepDocs(index.docs, { ...params, mode, caseSensitive, pathPrefix, context });
    const base = { releaseId: release.releaseId, mode,
      ...(mode === 'literal' && /[[\]()*+?{}|^$\\]/.test(params.pattern) ? { hint: '当前按字面量查询；若要使用正则表达式，请显式传入 mode: "regex"。' } : {}),
      totalMatches: scan.entries.length, totalFiles: new Set(scan.entries.map((e) => e.path)).size,
      complete: scan.complete, ...(!scan.complete ? { partial: true, partialReason: scan.partialReason } : {}),
      ...(scan.regexTruncatedLines ? { regexTruncatedLines: scan.regexTruncatedLines } : {}) };
    return this.jsonPage(scan.entries, offset, maxMatches, budget, next, (page, cursor) => {
      const files: GrepResult['files'] = [];
      for (const e of page) { let file = files[files.length - 1]; if (!file || file.path !== e.path) { file = { path: e.path, title: e.title, matches: [] }; files.push(file); } file.matches.push(e.match); }
      return { ...base, files, next: cursor };
    }) as GrepResult;
  }

  async outline(params: OutlineParams): Promise<TextPage> {
    if ([params.path, params.docId, params.pathPrefix].filter((v) => v !== undefined).length !== 1) invalid('path', 'path/docId/pathPrefix 必须三选一');
    const depth = int(params.depth, 3, 2, 3, 'depth'), pathPrefix = prefix(params.pathPrefix), budget = this.budget(params, 8000);
    const { release, index, offset, next } = await this.begin('outline', params, { path: params.path, docId: params.docId, pathPrefix, depth, budget });
    const docs = params.pathPrefix !== undefined ? index.docs.filter((d) => matchesPrefix(d.path, pathPrefix)) : [this.findDoc(release, index, params)];
    const rows = [...docs].sort((a, b) => comparePath(a.path, b.path)).flatMap((doc) => {
      const heading = `${doc.path} 《${doc.title}》 ${doc.lines.length}行 ${doc.lines.join('\n').length}字 tables:${doc.tables.length}\n`;
      // Every row is self-describing so continuation pages retain the document identity.
      return [heading, ...doc.sections.filter((s) => s.level <= depth).map((s) => {
        const range = sectionRange(doc.sections, s, doc.lines.length);
        return `${doc.path}  L${s.startLine}-${s.level === 1 ? s.endLine : range.end} ${s.level === 1 ? '(引言)' : `${'#'.repeat(s.level)} ${s.headingPath}`} ${s.chars}字\n`;
      })];
    });
    return this.textPage(rows, offset, budget, next, `release ${release.releaseId}\n`, release.releaseId);
  }

  async read(params: ReadParams): Promise<ReadPage> {
    const startLine = int(params.startLine, 1, 1, Number.MAX_SAFE_INTEGER, 'startLine'), maxLines = int(params.maxLines, 400, 1, 2000, 'maxLines');
    const includeSources = bool(params.includeSources, true, 'includeSources'), budget = this.budget(params, this.maxChars);
    string(params.section, 'section'); string(params.path, 'path');
    const release = this.resolveRelease(params.releaseId), index = await this.load(release);
    const anchor = params.path !== undefined ? splitAnchor(params.path, release.manifest.docs.map((doc) => doc.path)) : undefined;
    const doc = this.findDoc(release, index, { path: anchor?.path, docId: params.docId });
    let sectionName = params.section ?? anchor?.section;
    if (params.section?.startsWith(`${doc.path}#`)) {
      sectionName = params.section.slice(doc.path.length + 1);
    } else if (params.section?.includes('.md#') && !doc.sections.some((s) => s.headingPath === params.section || s.heading === params.section)) {
      invalid('section', 'anchor 与目标文档不一致');
    }
    if (params.section !== undefined && anchor?.section !== undefined && sectionName !== anchor.section) invalid('section', 'path anchor 与 section 冲突');
    if (sectionName !== undefined && !sectionName.length) invalid('section');
    const section = sectionName ? resolveAnchor(doc.sections, sectionName) : undefined;
    const range = section ? sectionRange(doc.sections, section, doc.lines.length) : { start: 1, end: doc.lines.length };
    const start = range.start + startLine - 1;
    if (start > range.end) invalid('startLine', '行号超出目标文档或章节');
    const sources = includeSources ? this.sourcesText(release.manifest, doc) : '';
    let end = Math.min(range.end, start + maxLines - 1);
    let text = '', continuation: number|null = null;
    for (;;) {
      continuation = end < range.end ? end - range.start + 2 : null;
      text = frame(doc, release.releaseId, start, end, true, section?.headingPath) + sources + (continuation ? `next: startLine=${continuation} releaseId=${release.releaseId}\n` : '');
      if (text.length <= budget) break;
      if (--end < start) invalid('maxChars', '预算不足以容纳一行及文档帧');
    }
    return { releaseId: release.releaseId, text, next: continuation, startLine: start, endLine: end };
  }
  private sourcesText(manifest: KbManifest, doc: KbIndexDoc): string {
    if (!doc.sources.length) return '';
    return 'sources: ' + doc.sources.map((id) => {
      const source = manifest.sourceSnapshot.find((s) => s.objToken === id);
      if (!source) return id;
      const warning = sourceVersionWarning(source);
      return `${source.title} (${source.relPath})${warning ? ` [source_version_label_mismatch: 标题 V${warning.titleVersion} / 路径 V${warning.pathVersion}；可能是旧路径名，内容版本未确认]` : ''}`;
    }).join('; ') + '\n';
  }

  async bundle(params: BundleParams): Promise<TextPage> {
    if (Number(params.paths !== undefined) + Number(params.pathPrefix !== undefined) !== 1) invalid('paths', 'pathPrefix/paths 必须二选一');
    if (params.paths !== undefined && (!Array.isArray(params.paths) || params.paths.length < 1 || params.paths.length > 50 || !params.paths.every((p) => typeof p === 'string'))) invalid('paths');
    const pathPrefix = prefix(params.pathPrefix), paths = params.paths ? [...new Set(params.paths)].sort(comparePath) : undefined;
    const dryRun = bool(params.dryRun, false, 'dryRun'), lineNumbers = bool(params.lineNumbers, false, 'lineNumbers'), budget = this.budget(params, this.maxChars);
    const { release, index, offset, next } = await this.begin('bundle', params, { pathPrefix, paths, dryRun, lineNumbers, budget });
    const docs = (paths ? paths.map((p) => this.findDoc(release, index, { path: p })) : index.docs.filter((d) => matchesPrefix(d.path, pathPrefix))).sort((a, b) => comparePath(a.path, b.path));
    const chars = docs.reduce((sum, d) => sum + d.lines.join('\n').length, 0);
    const header = `bundle release=${release.releaseId} docs=${docs.length} chars=${chars} pages≈${Math.max(1, Math.ceil(chars / budget))}\n`;
    const renderPage = (rows: string[]) => {
      // Derive the ordinal from deterministic packing, keeping the cursor format {o:number}.
      let position = 0, page = 1;
      while (position < offset) {
        const previous = this.textPage(rows, position, budget, next, `${header.trimEnd()} page=${page}\n`, release.releaseId);
        if (!previous.next) throw new QueryError('invalid_cursor', '整包游标超出页边界');
        position = decode(previous.next).o; page++;
        if (position > offset) throw new QueryError('invalid_cursor', '整包游标不在页边界');
      }
      return this.textPage(rows, offset, budget, next, `${header.trimEnd()} page=${page}\n`, release.releaseId);
    };
    if (dryRun) return renderPage(docs.map((d) => `${d.path} 《${d.title}》 ${d.lines.join('\n').length}字\n`));
    // Precompute deterministic, line-aligned parts. Cursor offset is a part index, never a byte offset.
    const parts: string[] = [];
    const room = budget - header.length - next(0).length - 64;
    for (const doc of docs) {
      const ranges: Array<[number, number]> = [];
      let start = 1, end = 0;
      for (let line = 1; line <= doc.lines.length; line++) {
        if (frame(doc, release.releaseId, start, line, lineNumbers, undefined, '999999/999999').length > room) {
          if (end < start) invalid('maxChars', '预算不足以容纳一行及文档帧');
          ranges.push([start, end]); start = line;
          if (frame(doc, release.releaseId, start, line, lineNumbers, undefined, '999999/999999').length > room) invalid('maxChars', '预算不足以容纳一行及文档帧');
        }
        end = line;
      }
      if (end >= start) ranges.push([start, end]);
      ranges.forEach(([a, b], i) => parts.push(frame(doc, release.releaseId, a, b, lineNumbers, undefined, ranges.length > 1 ? `${i + 1}/${ranges.length}` : undefined)));
    }
    return renderPage(parts);
  }

  async list(params: ListParams = {}): Promise<TextPage> {
    const depth = int(params.depth, 2, 1, 10, 'depth'), pathPrefix = prefix(params.pathPrefix), includeSummary = bool(params.includeSummary, false, 'includeSummary'), budget = this.budget(params, 8000);
    const { release, index, offset, next } = await this.begin('list', params, { depth, pathPrefix, includeSummary, budget });
    const docs = index.docs.filter((d) => matchesPrefix(d.path, pathPrefix));
    const rows: string[] = [], dirs = new Map<string, number>();
    for (const doc of docs) {
      const relative = pathPrefix ? doc.path.slice(pathPrefix.length + 1) : doc.path;
      const pieces = relative.split('/');
      for (let i = 1; i < pieces.length; i++) { const key = pieces.slice(0, i).join('/'); dirs.set(key, (dirs.get(key) ?? 0) + 1); }
    }
    const emitted = new Set<string>();
    for (const doc of [...docs].sort((a, b) => comparePath(a.path, b.path))) {
      const relative = pathPrefix ? (doc.path === pathPrefix ? path.basename(doc.path) : doc.path.slice(pathPrefix.length + 1)) : doc.path;
      const pieces = relative.split('/');
      for (let i = 1; i < pieces.length && i <= depth; i++) {
        const key = pieces.slice(0, i).join('/');
        if (!emitted.has(key)) { rows.push(`${'  '.repeat(i - 1)}${key}/ (${dirs.get(key) ?? 0})\n`); emitted.add(key); }
      }
      if (pieces.length <= depth) rows.push(`${'  '.repeat(pieces.length - 1)}${relative} 《${doc.title}》${includeSummary ? ` — ${doc.summary.slice(0, 80)}` : ''}\n`);
    }
    return this.textPage(rows, offset, budget, next, `release ${release.releaseId} docs=${docs.length}\n`, release.releaseId);
  }

  async releaseInfo(params: ReleaseInfoParams = {}): Promise<ReleaseInfoResult> {
    const includeChanges = bool(params.includeChanges, false, 'includeChanges'), budget = this.budget(params, this.maxChars);
    const { release, index, offset, next } = await this.begin('releaseInfo', params, { includeChanges, budget });
    const m = release.manifest;
    let changes: ReleaseInfoResult['changes'];
    if (includeChanges) {
      try {
        const value = JSON.parse(fs.readFileSync(resolveInside(release.releaseDir, 'changes.json', 'read'), 'utf8')) as KbVersionDto;
        if (!Array.isArray(value.docChanges) || typeof value.summary !== 'string') throw new Error('changes.json invalid');
        changes = { summary: value.summary, docs: value.docChanges.map(({ path, title, kind, additions, deletions, reason, mergedInto }) => {
          if (mergedInto !== undefined && (kind !== 'removed' || !Array.isArray(mergedInto) || !mergedInto.length
            || !mergedInto.every((p) => typeof p === 'string' && m.docs.some((d) => d.path === p)))) throw new Error('changes.json invalid merge targets');
          return { path, title, kind, additions, deletions, ...(reason ? { reason } : {}),
            ...(kind === 'removed' ? { mergedInto: mergedInto ?? null,
              removalNote: mergedInto ? '构建明确声明内容合并至目标文档。' : '本版不再包含此路径；未记录合并去向，不能据此认定内容已迁移。' } : {}) };
        }) };
      } catch (e) {
        if ((e as { code?: string }).code === 'not_found') changes = null;
        else throw new QueryError('kb_index_failed', '版本变更记录无效或越界', { detail: String(e) });
      }
    }
    // Large integrity/changes inventories are paged, not silently dropped. P2 may expose the additive cursor.
    const sourceRefs = new Map<string, number>();
    for (const doc of m.docs) for (const token of new Set(doc.sources)) sourceRefs.set(token, (sourceRefs.get(token) ?? 0) + 1);
    const sources = m.sourceSnapshot.map((source) => {
      const warning = sourceVersionWarning(source);
      return { objToken: source.objToken, title: source.title, relPath: source.relPath,
        referencedBy: sourceRefs.get(source.objToken) ?? 0, ...(warning ? { warning } : {}) };
    });
    type Item = { kind: 'missing'|'mismatched'|'release'; value: string } | { kind: 'change'; value: NonNullable<ReleaseInfoResult['changes']>['docs'][number] }
      | { kind: 'source'; value: ReleaseInfoResult['sources'][number] };
    const items: Item[] = [...index.integrity.missing.map((value) => ({ kind: 'missing' as const, value })),
      ...index.integrity.mismatched.map((value) => ({ kind: 'mismatched' as const, value })),
      ...availableReleases(this.kbRoot).map((value) => ({ kind: 'release' as const, value })),
      ...(changes?.docs.map((value) => ({ kind: 'change' as const, value })) ?? []),
      ...sources.map((value) => ({ kind: 'source' as const, value }))];
    return this.jsonPage(items, offset, Number.MAX_SAFE_INTEGER, budget, next, (page, cursor) => ({
      releaseId: release.releaseId, buildId: m.buildId, mode: m.mode, baseReleaseId: m.baseReleaseId, publishedAt: m.publishedAt, model: m.model,
      docCount: m.docs.length, sourceCount: m.sourceSnapshot.length, bodyChars: index.docs.reduce((sum, d) => sum + d.lines.join('\n').length, 0),
      ranker: process.env.FEISHU_KB_RANKER === 'l1' ? 'l1' : 'lex-v1', toolsVersion: '2',
      coverage: { kind: 'curated', note: KB_COVERAGE_NOTE, referencedSourceCount: sources.filter((source) => source.referencedBy > 0).length,
        skippedSourceCount: m.skippedSources?.length ?? 0 },
      sources: page.filter((i) => i.kind === 'source').map((i) => i.value),
      integrity: { verified: index.integrity.verified, missing: page.filter((i) => i.kind === 'missing').map((i) => i.value), mismatched: page.filter((i) => i.kind === 'mismatched').map((i) => i.value) },
      availableReleases: page.filter((i) => i.kind === 'release').map((i) => i.value),
      ...(includeChanges ? { changes: changes ? { summary: changes.summary, docs: page.filter((i) => i.kind === 'change').map((i) => i.value) } : null } : {}), next: cursor,
    })) as ReleaseInfoResult;
  }
}

// Store instances are short-lived at existing API/tool call sites. Share the facade by output root,
// bounded independently of the two-release LRU inside each facade.
const shared = new Map<string, KbQueryService>();
export function getKbQueryService(kbRoot: string): KbQueryService {
  const key = path.resolve(kbRoot);
  let service = shared.get(key);
  if (!service) service = new KbQueryService(key, { onWarmError: (e) => console.warn('[kb-search] prewarm failed:', e) });
  shared.delete(key); shared.set(key, service);
  while (shared.size > 2) shared.delete(shared.keys().next().value!);
  return service;
}
