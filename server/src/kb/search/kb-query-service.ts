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
import { resolveAnchor, sectionRange, splitAnchor, type KbSection } from './outline.js';
import { resolveRelease as resolvePublishedRelease, availableReleases, validateReleaseId, loadReleaseKnowledge, type ResolvedRelease } from './release-reader.js';
import { assembleKnowledgeIndex, KNOWLEDGE_INDEX_SCHEMA_VERSION, type KbKnowledgeIndex } from './knowledge-index.js';
import {
  BUSINESS_STATUSES,
  KNOWLEDGE_OBJECT_TYPES,
  REVIEW_STATUSES,
  type BusinessStatus,
  type Evidence,
  type EvidenceNature,
  type EvidenceRole,
  type KnowledgeObject,
  type KnowledgeObjectType,
  type KnowledgeRelationType,
  type ReviewStatus,
} from '../knowledge-schema.js';
import { QueryError, invalid } from './query-error.js';
import { KB_COVERAGE_NOTE, sourceVersionWarning, suggestDocPaths } from './query-metadata.js';
export { QueryError } from './query-error.js';
export { resolveRelease, readCurrent } from './release-reader.js';
export type { ResolvedRelease } from './release-reader.js';

export interface PageParams { releaseId?: string; cursor?: string; maxChars?: number }
// ---- A案 §8.1 对象级查询与用途三态（T4b）----
export type KbUsage = 'browse' | 'operational' | 'compare';
export type KbObjectMatchType = 'object_id' | 'filter' | 'family' | 'related';
export type KbFreshnessState = 'not_scheduled' | 'fresh' | 'overdue';
export interface KbObjectFreshness { state: KbFreshnessState; staleAfter: string | null; evaluatedAt: string }
export interface KbObjectCanonicalRef { docId: string; path: string; anchor: string; bodyRange: { startLine: number; endLine: number } }
export interface KbObjectResultRow {
  releaseId: string;
  objectId: string;
  revision: number;
  title: string;
  aliases: string[];
  domainIds: string[];
  type: KnowledgeObjectType;
  familyKey: string;
  variantKey: string;
  scope: { scopeKey: string; scopeText: string };
  canonical: KbObjectCanonicalRef | null;
  businessStatus: BusinessStatus;
  reviewStatus: ReviewStatus;
  freshness: KbObjectFreshness;
  matchType: KbObjectMatchType;
  snippet: string;
  evidenceCount: number;
  /** 高风险 claim 无绑定证据的 claimKey（A案 §8.1 证据缺口） */
  evidenceGaps: string[];
  /** 未处于 approved+passed 时提示禁止直接执行（A案 §8.1：用途过滤不是权限机制） */
  caution?: string;
  tombstone?: { reason: string; successorObjectIds: string[] };
  /** related 行携带：命中该对象的关系边 */
  relation?: { edgeId: string; type: KnowledgeRelationType; direction: 'out' | 'in' };
}
export interface KbRelationHint { edgeId: string; type: KnowledgeRelationType; fromObjectId: string; toObjectId: string; decisionRef?: string }
export interface KbRelatedBudget {
  maxHops: 1; maxObjects: 6; maxChars: 6000;
  included: number; chars: number;
  remaining: number;
  stopReason: 'max_objects' | 'max_chars' | null;
}
export interface ObjectQueryParams extends PageParams {
  usage?: KbUsage;
  objectId?: string;
  familyKey?: string;
  types?: KnowledgeObjectType[];
  domainIds?: string[];
  businessStatuses?: BusinessStatus[];
  reviewStatuses?: ReviewStatus[];
  limit?: number;
}
export interface ObjectQueryResult {
  releaseId: string;
  usage: KbUsage;
  /** 组织规则版本（A案 §8.2 游标绑定项）；v1 为 null */
  organizationHash: string | null;
  total: number;
  objects: KbObjectResultRow[];
  related: KbObjectResultRow[];
  relatedBudget: KbRelatedBudget;
  conflictHints: KbRelationHint[];
  /** operational 资格检查的原因计数（A案 §8.1：无结果不退回 candidate） */
  excluded?: Record<string, number>;
  hint?: string[];
  legacy?: { label: 'legacy-unclassified'; notice: string };
  next: string | null;
}
export interface ObjectReadParams extends PageParams { objectId: string }
export interface KbEvidenceDto {
  evidenceId: string;
  claimKey: string;
  role: EvidenceRole;
  nature: EvidenceNature;
  source: { sourceId: string; sourceSnapshotHash: string; resourceId: string; resourceHash: string };
  /** 依据定位描述（A案 §8.3：返回该 release 保留的版本和定位） */
  locator: string;
  quoteHash: string;
}
export interface ObjectReadResult {
  releaseId: string;
  organizationHash: string | null;
  object: KbObjectResultRow | null;
  evidence: KbEvidenceDto[];
  evidenceNote: string;
  related: KbObjectResultRow[];
  relatedBudget: KbRelatedBudget;
  conflictHints: KbRelationHint[];
  legacy?: { label: 'legacy-unclassified'; notice: string };
  next: null;
}
export interface SearchParams extends PageParams { query: string; limit?: number; pathPrefix?: string; tags?: string[]; maxSnippets?: number;
  /** A案 §8.1：用途过滤（compare 属对象查询，search 不接受）；给出任一对象过滤参数即进入对象感知模式 */
  usage?: KbUsage;
  types?: KnowledgeObjectType[];
  domainIds?: string[];
  businessStatuses?: BusinessStatus[];
  reviewStatuses?: ReviewStatus[];
}
export interface SearchResultHit { docId: string; path: string; title: string; summary: string; snippet: string; score?: number; coverage?: number; matchedUnits?: string[]; fallbackUnits?: string[]; matchType?: 'exact'|'fallback'; hits?: SnippetHit[];
  /** 对象感知模式：命中文档内通过过滤的对象及其状态（A案 §8.1 标签随结果流转） */
  objectRefs?: Array<{ objectId: string; businessStatus: BusinessStatus; reviewStatus: ReviewStatus }> }
export interface SearchResult { releaseId: string; ranker: 'lex-v1'|'l1'; rankerVersion: 'lex-v1'|'l1'; query: ReturnType<typeof parseQuery>; total: number; results: SearchResultHit[]; next: string|null; unmatchedUnits: string[]; warning?: string; hint?: string[];
  usage?: KbUsage;
  /** v1 release / 旧 schema 内容：未分类，不能看起来像已批准（A案 §8.1） */
  legacy?: 'legacy-unclassified';
  excluded?: Record<string, number>; }
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
interface Cursor { v: 1; r: string; t: string; h: string; o: number; /** A案 §8.2：用途查询钉住 evaluatedAt（新鲜度跨页稳定） */ e?: number }
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
/** A案 §8.1：受控枚举数组参数（去重排序后返回，进 digest 保游标稳定） */
function enumArray<T extends string>(value: T[] | undefined, allowed: ReadonlySet<T>, field: string, max: number): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > max || !value.every((item) => allowed.has(item))) invalid(field);
  return [...new Set(value)].sort() as T[];
}
function stringArray(value: string[] | undefined, field: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > max || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 80)) invalid(field);
  return [...new Set(value)].sort();
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
    if (c.e !== undefined && (!Number.isSafeInteger(c.e) || c.e <= 0)) throw new Error();
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
  private knowledgeCache = new Map<string, KbKnowledgeIndex>();

  /** A案 §8.2：按 (releaseId, organizationHash, indexSchemaVersion) 缓存知识
   * 索引视图；v1/未组织化 release → null。sidecar 损坏由 loadReleaseKnowledge
   * 抛 QueryError（T4a 语义：组织查询失败不降级，透传）。 */
  private knowledgeView(release: ResolvedRelease): KbKnowledgeIndex | null {
    if (!release.organization) return null;
    const key = `${release.releaseId}:${release.organization.hash}:${KNOWLEDGE_INDEX_SCHEMA_VERSION}`;
    const cached = this.knowledgeCache.get(key);
    if (cached) return cached;
    const { knowledge } = loadReleaseKnowledge(release);
    const view = assembleKnowledgeIndex(release.releaseId, knowledge);
    for (const existing of this.knowledgeCache.keys()) {
      if (existing.startsWith(`${release.releaseId}:`)) this.knowledgeCache.delete(existing);
    }
    this.knowledgeCache.set(key, view);
    return view;
  }

  private async begin(tool: string, params: PageParams, normalized: unknown, pinned?: { evaluatedAt?: number }): Promise<{ release: ResolvedRelease; index: KbIndex; offset: number; evaluatedAt: number | undefined; next: (o: number) => string }> {
    const hash = digest(normalized), cursor = params.cursor === undefined ? undefined : decode(params.cursor);
    if (cursor && (cursor.t !== tool || cursor.h !== hash || (params.releaseId !== undefined && params.releaseId !== cursor.r))) throw new QueryError('invalid_cursor', '游标与参数或版本不匹配');
    const release = this.resolveRelease(params.releaseId ?? cursor?.r);
    const index = await this.load(release);
    // A案 §8.2：游标携带 evaluatedAt，后续页新鲜度判定与首页一致
    const evaluatedAt = pinned?.evaluatedAt ?? cursor?.e;
    return { release, index, offset: cursor?.o ?? 0, evaluatedAt,
      next: (o) => encode({ v: 1, r: release.releaseId, t: tool, h: hash, o, ...(evaluatedAt !== undefined ? { e: evaluatedAt } : {}) }) };
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

  // ------------------------------------------------------------------
  // A案 §8.1/§8.2：对象级查询、用途三态与关系扩展（T4b）
  // ------------------------------------------------------------------

  /** A案 §4.4/§8.1：staleAfter 新鲜度判定；无/非法日期 → not_scheduled */
  private freshnessOf(object: KnowledgeObject, evaluatedAt: number): KbObjectFreshness {
    const evaluatedAtIso = new Date(evaluatedAt).toISOString();
    if (!object.staleAfter) return { state: 'not_scheduled', staleAfter: null, evaluatedAt: evaluatedAtIso };
    const due = Date.parse(object.staleAfter);
    if (!Number.isFinite(due)) return { state: 'not_scheduled', staleAfter: object.staleAfter, evaluatedAt: evaluatedAtIso };
    return { state: evaluatedAt <= due ? 'fresh' : 'overdue', staleAfter: object.staleAfter, evaluatedAt: evaluatedAtIso };
  }
  /** A案 §2.1：unknown 范围不得用于 operational 答案 */
  private static isUnknownScope(object: KnowledgeObject): boolean {
    const scopeKey = object.scopeKey?.trim().toLowerCase();
    return !scopeKey || scopeKey === 'unknown';
  }
  private static hasHighRiskClaim(object: KnowledgeObject): boolean {
    return (object.claims ?? []).some((claim) => claim.riskCategory === 'high');
  }
  /** 必需依赖可用（A案 §8.1）：depends_on/exception_to 目标自身满足资格且
   * 其必需依赖递归可用；depends_on 环不可用（带 visiting 守卫）。 */
  private dependencyUsable(view: KbKnowledgeIndex, objectId: string, evaluatedAt: number, memo: Map<string, boolean>, visiting: Set<string>): boolean {
    const memoized = memo.get(objectId);
    if (memoized !== undefined) return memoized;
    if (visiting.has(objectId)) return false;
    const object = view.objectsById.get(objectId);
    if (!object || object.tombstone || !object.canonical) return false;
    visiting.add(objectId);
    let usable = object.businessStatus === 'approved' && object.reviewStatus === 'passed'
      && !KbQueryService.isUnknownScope(object)
      && !(this.freshnessOf(object, evaluatedAt).state === 'overdue' && KbQueryService.hasHighRiskClaim(object));
    if (usable) {
      for (const edge of view.relationsFrom.get(objectId) ?? []) {
        if (edge.type !== 'depends_on' && edge.type !== 'exception_to') continue;
        if (!this.dependencyUsable(view, edge.toObjectId, evaluatedAt, memo, visiting)) { usable = false; break; }
      }
    }
    visiting.delete(objectId);
    memo.set(objectId, usable);
    return usable;
  }
  /** operational 资格首命原因（A案 §8.1：无结果时返回原因计数，不退回 candidate） */
  private operationalBlockReason(view: KbKnowledgeIndex, object: KnowledgeObject, evaluatedAt: number, memo: Map<string, boolean>): string | null {
    if (object.businessStatus !== 'approved') return 'not_approved';
    if (object.reviewStatus !== 'passed') return 'review_not_passed';
    if (KbQueryService.isUnknownScope(object)) return 'scope_unknown';
    if (this.freshnessOf(object, evaluatedAt).state === 'overdue' && KbQueryService.hasHighRiskClaim(object)) return 'high_risk_overdue';
    for (const edge of view.relationsFrom.get(object.objectId) ?? []) {
      if (edge.type !== 'depends_on' && edge.type !== 'exception_to') continue;
      if (!this.dependencyUsable(view, edge.toObjectId, evaluatedAt, memo, new Set())) return 'dependency_unavailable';
    }
    return null;
  }
  /** canonical 正文片段（行号相对去头部正文，与 KbIndexDoc.lines 同坐标） */
  private canonicalSnippet(index: KbIndex, object: KnowledgeObject): string {
    const canonical = object.canonical;
    if (!canonical) return '';
    const docNo = index.byPath.get(canonical.path);
    if (docNo === undefined) return '';
    const doc = index.docs[docNo];
    const start = Math.max(1, Math.min(canonical.bodyRange.startLine, doc.lines.length));
    const end = Math.min(canonical.bodyRange.endLine, doc.lines.length);
    const parts: string[] = [];
    let chars = 0;
    for (let line = start; line <= end && chars < 200; line++) {
      const text = doc.lines[line - 1].trim();
      if (!text || /^<a id="ko_[A-Za-z0-9_-]+"><\/a>$/.test(text)) continue;
      const take = text.slice(0, Math.max(0, 200 - chars - 1));
      parts.push(take.length < text.length ? `${take}…` : text);
      chars += take.length + 1;
    }
    return parts.join('\n');
  }
  private objectRow(release: ResolvedRelease, view: KbKnowledgeIndex, index: KbIndex, object: KnowledgeObject, evaluatedAt: number, matchType: KbObjectMatchType): KbObjectResultRow {
    const evidence = view.evidenceByObject.get(object.objectId) ?? [];
    const boundClaims = new Set(evidence.map((item) => item.claimKey));
    const knownEvidenceIds = new Set(view.knowledge.evidence.map((item) => item.evidenceId));
    const evidenceGaps = (object.claims ?? [])
      .filter((claim) => claim.riskCategory === 'high'
        && !boundClaims.has(claim.claimKey)
        && !(claim.evidenceIds ?? []).some((id) => knownEvidenceIds.has(id)))
      .map((claim) => claim.claimKey);
    const approvedPassed = object.businessStatus === 'approved' && object.reviewStatus === 'passed';
    return {
      releaseId: release.releaseId,
      objectId: object.objectId,
      revision: object.revision,
      title: object.title,
      aliases: object.aliases ?? [],
      domainIds: object.domainIds ?? [],
      type: object.type,
      familyKey: object.familyKey,
      variantKey: object.variantKey,
      scope: { scopeKey: object.scopeKey, scopeText: object.scopeText },
      canonical: object.canonical ? { ...object.canonical, bodyRange: { ...object.canonical.bodyRange } } : null,
      businessStatus: object.businessStatus,
      reviewStatus: object.reviewStatus,
      freshness: this.freshnessOf(object, evaluatedAt),
      matchType,
      snippet: this.canonicalSnippet(index, object),
      evidenceCount: evidence.length,
      evidenceGaps,
      ...(approvedPassed ? {} : { caution: '该对象未处于 approved+review passed 状态，禁止直接作为现行规则执行；用途过滤不是权限机制，直接读取需自行核对状态与证据。' }),
      ...(object.tombstone ? { tombstone: { reason: object.tombstone.reason, successorObjectIds: object.tombstone.successorObjectIds } } : {}),
    };
  }
  /** A案 §8.2：关系扩展预算（样本初始默认 1 跳/6 对象/6000 字符）。related 与
   * direct 分离；depends_on/exception_to 优先，其次 part_of；conflicts_with/
   * supersedes 只返回提示与入口，不带入计算链；objectId 去重，超预算返回
   * remaining 与停止原因。 */
  private expandRelated(release: ResolvedRelease, view: KbKnowledgeIndex, index: KbIndex, direct: KnowledgeObject[], evaluatedAt: number): { related: KbObjectResultRow[]; relatedBudget: KbRelatedBudget; conflictHints: KbRelationHint[] } {
    const MAX_HOPS = 1, MAX_OBJECTS = 6, MAX_CHARS = 6000;
    const priority: Partial<Record<KnowledgeRelationType, number>> = { depends_on: 0, exception_to: 0, part_of: 1 };
    const seen = new Set(direct.map((object) => object.objectId));
    const conflictHints: KbRelationHint[] = [];
    const hintSeen = new Set<string>();
    const candidates: Array<{ object: KnowledgeObject; relation: { edgeId: string; type: KnowledgeRelationType; direction: 'out' | 'in' }; priority: number }> = [];
    for (const object of direct) {
      const edges = [...(view.relationsFrom.get(object.objectId) ?? []), ...(view.relationsTo.get(object.objectId) ?? [])];
      for (const edge of edges) {
        if (edge.type === 'conflicts_with' || edge.type === 'supersedes') {
          if (!hintSeen.has(edge.edgeId)) {
            hintSeen.add(edge.edgeId);
            conflictHints.push({ edgeId: edge.edgeId, type: edge.type, fromObjectId: edge.fromObjectId, toObjectId: edge.toObjectId, ...(edge.decisionRef ? { decisionRef: edge.decisionRef } : {}) });
          }
          continue;
        }
        const rank = priority[edge.type];
        if (rank === undefined) continue; // 其余关系不进入样本初始扩展
        const otherId = edge.fromObjectId === object.objectId ? edge.toObjectId : edge.fromObjectId;
        if (seen.has(otherId)) continue;
        const other = view.objectsById.get(otherId);
        if (!other || other.tombstone) continue;
        seen.add(otherId);
        candidates.push({ object: other, relation: { edgeId: edge.edgeId, type: edge.type, direction: edge.fromObjectId === object.objectId ? 'out' : 'in' }, priority: rank });
      }
    }
    candidates.sort((a, b) => a.priority - b.priority || (a.relation.edgeId < b.relation.edgeId ? -1 : 1));
    const related: KbObjectResultRow[] = [];
    let chars = 0, stopReason: KbRelatedBudget['stopReason'] = null;
    for (const candidate of candidates) {
      if (related.length >= MAX_OBJECTS) { stopReason = 'max_objects'; break; }
      const row: KbObjectResultRow = { ...this.objectRow(release, view, index, candidate.object, evaluatedAt, 'related'), relation: candidate.relation };
      const rowChars = JSON.stringify(row).length;
      if (chars + rowChars > MAX_CHARS) { stopReason = 'max_chars'; break; }
      related.push(row); chars += rowChars;
    }
    return {
      related,
      relatedBudget: { maxHops: MAX_HOPS, maxObjects: MAX_OBJECTS, maxChars: MAX_CHARS, included: related.length, chars, remaining: candidates.length - related.length, stopReason },
      conflictHints,
    };
  }
  private static objectFiltersMatch(object: KnowledgeObject, filters: { types?: KnowledgeObjectType[]; domainIds?: string[]; businessStatuses?: BusinessStatus[]; reviewStatuses?: ReviewStatus[] }): boolean {
    if (filters.types && !filters.types.includes(object.type)) return false;
    if (filters.businessStatuses && !filters.businessStatuses.includes(object.businessStatus)) return false;
    if (filters.reviewStatuses && !filters.reviewStatuses.includes(object.reviewStatus)) return false;
    if (filters.domainIds && !(object.domainIds ?? []).some((domain) => filters.domainIds!.includes(domain))) return false;
    return true;
  }
  private static relatedBudgetEmpty(): KbRelatedBudget {
    return { maxHops: 1, maxObjects: 6, maxChars: 6000, included: 0, chars: 0, remaining: 0, stopReason: null };
  }
  private static legacyNotice(): { label: 'legacy-unclassified'; notice: string } {
    return { label: 'legacy-unclassified',
      notice: '该 release 为 v1（未组织化），无知识对象数据；内容按 legacy-unclassified 处理，不能视为已批准。可继续用全文检索/阅读（search/grep/read）浏览内容，对象级特性不可用。' };
  }

  /** A案 §8.1 对象级查询：objectId 直取 / 过滤列表 / compare 同族并列。 */
  async objects(params: ObjectQueryParams): Promise<ObjectQueryResult> {
    const usage: KbUsage = params.usage === undefined ? 'browse' : params.usage;
    if (usage !== 'browse' && usage !== 'operational' && usage !== 'compare') invalid('usage');
    const types = enumArray(params.types, KNOWLEDGE_OBJECT_TYPES, 'types', 6);
    const businessStatuses = enumArray(params.businessStatuses, BUSINESS_STATUSES, 'businessStatuses', 5);
    const reviewStatuses = enumArray(params.reviewStatuses, REVIEW_STATUSES, 'reviewStatuses', 4);
    const domainIds = stringArray(params.domainIds, 'domainIds', 10);
    const filtersPresent = types !== undefined || businessStatuses !== undefined || reviewStatuses !== undefined || domainIds !== undefined;
    const objectId = params.objectId === undefined ? undefined : (string(params.objectId, 'objectId'), params.objectId);
    const familyKey = params.familyKey === undefined ? undefined : (string(params.familyKey, 'familyKey'), params.familyKey);
    if (objectId !== undefined && objectId.length < 3) invalid('objectId');
    if (familyKey !== undefined && (familyKey.length < 1 || familyKey.length > 200)) invalid('familyKey');
    // 互斥校验（沿用现有参数互斥模式）：直取不带过滤；compare 需族键且不接受状态过滤
    if (objectId !== undefined && familyKey !== undefined) invalid('objectId', 'objectId 与 familyKey 不得同时提供');
    if (objectId !== undefined && filtersPresent) invalid('objectId', 'objectId 直取不接受过滤参数');
    if (usage === 'compare') {
      if (objectId === undefined && familyKey === undefined) invalid('familyKey', 'compare 需要 familyKey 或 objectId');
      if (filtersPresent) invalid('usage', 'compare 并列返回各状态方案，不接受类型/状态过滤');
    }
    if (usage === 'operational' && objectId === undefined && familyKey !== undefined) invalid('familyKey', 'operational 列表不接受 familyKey；同族对比请使用 compare');
    const limit = int(params.limit, 30, 1, 100, 'limit');
    const budget = this.budget(params, 12000);
    const pre = this.resolveRelease(params.releaseId ?? (params.cursor === undefined ? undefined : decode(params.cursor).r));
    const view = this.knowledgeView(pre);
    if (!view) {
      // A案 §8.1：v1 release 对象查询不报错——legacy 提示（可全文检索）
      return { releaseId: pre.releaseId, usage, organizationHash: null, total: 0, objects: [], related: [],
        relatedBudget: KbQueryService.relatedBudgetEmpty(), conflictHints: [], legacy: KbQueryService.legacyNotice(), next: null };
    }
    const evaluatedAt = params.cursor === undefined ? Date.now() : decode(params.cursor).e ?? Date.now();
    const organizationHash = pre.organization!.hash;
    // A案 §8.2：游标绑定 usage/过滤参数/组织规则版本；evaluatedAt 由游标 e 钉住
    const normalized = { usage, objectId, familyKey, types, domainIds, businessStatuses, reviewStatuses, limit, budget, organizationHash };
    const { release, index, offset, next } = await this.begin('objects', { ...params, releaseId: pre.releaseId }, normalized, { evaluatedAt });

    let direct: KnowledgeObject[];
    let matchType: KbObjectMatchType;
    let excluded: Record<string, number> | undefined;
    const hint: string[] = [];
    if (usage === 'compare') {
      // A案 §8.1：同 familyKey 方案/冲突/取代并列返回，各标状态；objectId 用于解析所属族
      const target = objectId !== undefined ? view.objectsById.get(objectId) : undefined;
      const key = familyKey ?? target?.familyKey;
      if (!key) throw new QueryError('kb_not_found', '知识对象不存在', { objectId, releaseId: release.releaseId });
      matchType = 'family';
      direct = view.activeObjects.filter((object) => object.familyKey === key)
        .sort((a, b) => (a.canonical?.path ?? '').localeCompare(b.canonical?.path ?? '')
          || (a.canonical?.bodyRange.startLine ?? 0) - (b.canonical?.bodyRange.startLine ?? 0)
          || (a.objectId < b.objectId ? -1 : 1));
    } else if (objectId !== undefined) {
      // A案 §8.1：直接读取已知对象不受 operational 隐式屏蔽（DTO 带状态与提示）
      const object = view.objectsById.get(objectId);
      if (!object) throw new QueryError('kb_not_found', '知识对象不存在', { objectId, releaseId: release.releaseId });
      direct = [object]; matchType = 'object_id';
    } else {
      matchType = 'filter';
      const filters = { types, domainIds, businessStatuses, reviewStatuses };
      const memo = new Map<string, boolean>();
      excluded = {};
      const passing: KnowledgeObject[] = [];
      for (const object of view.activeObjects) {
        if (!KbQueryService.objectFiltersMatch(object, filters)) { excluded.excluded_by_filter = (excluded.excluded_by_filter ?? 0) + 1; continue; }
        if (usage === 'operational') {
          const reason = this.operationalBlockReason(view, object, evaluatedAt, memo);
          if (reason) { excluded[reason] = (excluded[reason] ?? 0) + 1; continue; }
        }
        passing.push(object);
      }
      direct = passing.sort((a, b) => (a.canonical?.path ?? '').localeCompare(b.canonical?.path ?? '')
        || (a.canonical?.bodyRange.startLine ?? 0) - (b.canonical?.bodyRange.startLine ?? 0)
        || (a.objectId < b.objectId ? -1 : 1));
      if (usage === 'operational' && !direct.length && view.activeObjects.length) {
        hint.push('当前过滤条件下无满足 operational 资格的对象；excluded 为各原因计数，不自动退回 candidate。可改用 browse 查看候选对象、get_object 直接读取对象（不受屏蔽），或回源原始库核实。');
      }
    }
    return this.jsonPage(direct, offset, limit, budget, next, (page, cursor) => {
      const rows = page.map((object) => this.objectRow(release, view, index, object, evaluatedAt, matchType));
      const { related, relatedBudget, conflictHints } = this.expandRelated(release, view, index, page, evaluatedAt);
      return {
        releaseId: release.releaseId, usage, organizationHash,
        total: direct.length, objects: rows, related, relatedBudget, conflictHints,
        ...(usage === 'operational' && objectId === undefined ? { excluded: excluded ?? {} } : {}),
        ...(hint.length ? { hint } : {}),
        next: cursor,
      };
    }) as ObjectQueryResult;
  }

  /** A案 §8.1/§8.3：objectId 直取（对象+状态+canonical 片段+证据列表+关系扩展）。 */
  async getObject(params: ObjectReadParams): Promise<ObjectReadResult> {
    string(params.objectId, 'objectId');
    if (params.objectId.length < 3 || params.objectId.length > 120) invalid('objectId');
    const release = this.resolveRelease(params.releaseId);
    const view = this.knowledgeView(release);
    if (!view) {
      // v1：不报错，明确 legacy 提示（对象特性不可用）
      return { releaseId: release.releaseId, organizationHash: null, object: null, evidence: [],
        evidenceNote: '', related: [], relatedBudget: KbQueryService.relatedBudgetEmpty(), conflictHints: [],
        legacy: KbQueryService.legacyNotice(), next: null };
    }
    const object = view.objectsById.get(params.objectId);
    if (!object) throw new QueryError('kb_not_found', '知识对象不存在', { objectId: params.objectId, releaseId: release.releaseId });
    const index = await this.load(release);
    const evaluatedAt = Date.now();
    const row = this.objectRow(release, view, index, object, evaluatedAt, 'object_id');
    const { related, relatedBudget, conflictHints } = this.expandRelated(release, view, index, [object], evaluatedAt);
    const evidence = view.evidenceByObject.get(object.objectId) ?? [];
    const evidenceDto: KbEvidenceDto[] = evidence.slice(0, 50).map((item) => ({
      evidenceId: item.evidenceId,
      claimKey: item.claimKey,
      role: item.role,
      nature: item.nature,
      source: { ...item.sourceRef },
      locator: KbQueryService.evidenceLocator(item),
      quoteHash: item.quoteHash,
    }));
    return {
      releaseId: release.releaseId,
      organizationHash: release.organization!.hash,
      object: row,
      evidence: evidenceDto,
      evidenceNote: `依据为该 release 发布时保留的证据版本与定位（共 ${evidence.length} 条${evidence.length > 50 ? `，本页仅列前 50 条` : ''}）；当前原始源是否仍与发布依据一致需另行比对，本查询不访问原始库。`,
      related, relatedBudget, conflictHints,
      next: null,
    };
  }

  /** A案 §5.2 证据定位描述（可读摘要；原始定位字段在 knowledge.json 保留） */
  private static evidenceLocator(item: Evidence): string {
    const selector = item.selector;
    switch (selector.kind) {
      case 'text_span': return `正文 L${selector.lineStart}-${selector.lineEnd}${selector.headingPath.length ? `（${selector.headingPath.join(' › ')}）` : ''}`;
      case 'csv_cells': return `CSV ${selector.resourcePath} 记录 ${selector.recordStart}-${selector.recordEnd} 列 [${selector.columns.join(', ')}]`;
      case 'workbook_cells': return `工作簿 ${selector.workbookName}/${selector.sheet}!${selector.rangeA1}`;
      case 'media_region': return `图片 ${selector.imageHash.slice(0, 16)}…${selector.region ? ` 区域 ${selector.region.w}×${selector.region.h}` : ''}`;
    }
  }


  /** A案 §8.1/§8.2：对象感知 search 片段——只从通过过滤的对象 canonical 范围生成
   * snippet（泄漏防护）；文档 summary 混状态时改用对象摘要。 */
  private objectSnippetHit(doc: KbIndexDoc, object: KnowledgeObject, query: ReturnType<typeof parseQuery>): SnippetHit | null {
    const canonical = object.canonical;
    if (!canonical) return null;
    const startLine = Math.max(1, canonical.bodyRange.startLine);
    const endLine = Math.min(canonical.bodyRange.endLine, doc.lines.length);
    if (startLine > endLine) return null;
    const section: KbSection = { level: 2, heading: object.title, headingPath: object.title, anchor: `${canonical.path}#${canonical.anchor}`,
      startLine, endLine, chars: 0, normStart: 0, normEnd: 0, normHeading: '' };
    return makeSnippet(doc, section, query);
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const parsed = parseQuery(params.query), limit = int(params.limit, 10, 1, 30, 'limit');
    const maxSnippets = int(params.maxSnippets, 2, 0, 3, 'maxSnippets'), pathPrefix = prefix(params.pathPrefix);
    if (params.tags !== undefined && (!Array.isArray(params.tags) || params.tags.length > 5 || !params.tags.every((t) => typeof t === 'string'))) invalid('tags');
    const tags = [...new Set(params.tags ?? [])].sort();
    // A案 §8.1：usage 三态与对象过滤——给出任一参数即进入对象感知模式；缺省行为不变
    const usage: KbUsage | undefined = params.usage === undefined ? undefined
      : (params.usage === 'browse' || params.usage === 'operational' ? params.usage
        : params.usage === 'compare' ? invalid('usage', 'compare 属对象级查询（同 familyKey 并列），请使用对象查询入口') : invalid('usage'));
    const types = enumArray(params.types, KNOWLEDGE_OBJECT_TYPES, 'types', 6);
    const businessStatuses = enumArray(params.businessStatuses, BUSINESS_STATUSES, 'businessStatuses', 5);
    const reviewStatuses = enumArray(params.reviewStatuses, REVIEW_STATUSES, 'reviewStatuses', 4);
    const domainIds = stringArray(params.domainIds, 'domainIds', 10);
    const knowledgeActive = usage !== undefined || types !== undefined || businessStatuses !== undefined || reviewStatuses !== undefined || domainIds !== undefined;
    const budget = this.budget(params, 8000);
    const pre = knowledgeActive ? this.resolveRelease(params.releaseId ?? (params.cursor === undefined ? undefined : decode(params.cursor).r)) : undefined;
    const view = pre ? this.knowledgeView(pre) : null; // sidecar 损坏 → QueryError 透传不降级（T4a/A案 §8.2）
    const evaluatedAt = knowledgeActive && pre ? (params.cursor === undefined ? Date.now() : decode(params.cursor).e ?? Date.now()) : undefined;
    const state = await this.begin('search', knowledgeActive ? { ...params, releaseId: pre!.releaseId } : params,
      { query: params.query, limit, maxSnippets, pathPrefix, tags, budget,
        ...(knowledgeActive ? { usage: usage ?? 'browse', types, domainIds, businessStatuses, reviewStatuses, organizationHash: pre!.organization?.hash ?? null } : {}) },
      knowledgeActive && evaluatedAt !== undefined ? { evaluatedAt } : undefined);
    const { release, index, offset, next } = state;
    const ranker = process.env.FEISHU_KB_RANKER === 'l1' ? 'l1' : 'lex-v1';
    let query = parsed, results: Array<() => SearchResultHit>;
    const selected = (doc: KbIndexDoc) => matchesPrefix(doc.path, pathPrefix) && tags.every((t) => doc.tags.includes(t));
    // 对象感知模式：文档需有通过过滤的对象才可入结果（A案 §8.1 operational /
    // §8.2 泄漏防护：被过滤章节不生成 snippet）
    let knowledge: { view: KbKnowledgeIndex; qualifies: (object: KnowledgeObject) => boolean; excluded: Record<string, number>; docQualifying: Map<string, KnowledgeObject[]>; mode: 'browse' | 'operational' } | null = null;
    if (knowledgeActive && view) {
      const filters = { types, domainIds, businessStatuses, reviewStatuses };
      const mode = usage ?? 'browse';
      const memo = new Map<string, boolean>();
      const excluded: Record<string, number> = {};
      for (const object of view.activeObjects) {
        if (!KbQueryService.objectFiltersMatch(object, filters)) { excluded.excluded_by_filter = (excluded.excluded_by_filter ?? 0) + 1; continue; }
        if (mode === 'operational') {
          const reason = this.operationalBlockReason(view, object, evaluatedAt!, memo);
          if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
        }
      }
      const passes = (object: KnowledgeObject) => KbQueryService.objectFiltersMatch(object, filters)
        && (mode !== 'operational' || this.operationalBlockReason(view, object, evaluatedAt!, memo) === null);
      const docQualifying = new Map<string, KnowledgeObject[]>();
      for (const [docPath, objects] of view.objectsByDoc) {
        const passing = objects.filter(passes);
        if (passing.length) docQualifying.set(docPath, passing);
      }
      knowledge = { view, qualifies: passes, excluded, docQualifying, mode };
    }
    if (ranker === 'l1') {
      const docs = index.docs.filter(selected);
      // L1's historical 50-result cap must not truncate the facade's pagination.
      const l1 = l1SearchDocs(docs.map((d) => ({ ...d, headings: d.sections.map((s) => s.headingPath) })), params.query, Number.MAX_SAFE_INTEGER,
        (d) => index.docs[index.byPath.get(d.path)!].lines.join('\n'), true);
      results = (knowledge ? l1.filter((hit) => knowledge.docQualifying.has(hit.path)) : l1).map((hit) => {
        if (!knowledge) return () => hit;
        const knowledgeState = knowledge;
        return () => this.knowledgeAwareL1Hit(hit, knowledgeState, index, maxSnippets, query);
      });
    } else {
      const ranked = rankLexV1(index, params.query); query = ranked.query;
      const pool = ranked.ranked.filter((r) => selected(r.doc));
      results = (knowledge ? pool.filter((r) => knowledge.docQualifying.has(r.doc.path)) : pool).map((r) => {
        if (!knowledge) {
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
        }
        const knowledgeState = knowledge, docRanked = r;
        let knowledgeHit: SearchResultHit | undefined;
        return () => {
          if (!knowledgeHit) knowledgeHit = this.knowledgeAwareHit(docRanked, knowledgeState, maxSnippets, query);
          return knowledgeHit;
        };
      });
    }
    const selectedDocs = index.docs.filter(selected);
    const unmatchedUnits = query.units.filter((unit) => !selectedDocs.some((doc) => doc.normAll.includes(unit) || Object.values(doc.meta).some((v) => v.includes(unit))));
    if (knowledgeActive && !view) {
      // A案 §8.1：旧 schema 内容标 legacy-unclassified；operational 不把未分类当已批准，不自动退回
      if (usage === 'operational' || types !== undefined || businessStatuses !== undefined || reviewStatuses !== undefined || domainIds !== undefined) {
        const empty = { releaseId: release.releaseId, ranker, rankerVersion: ranker, query, total: 0, results: [], unmatchedUnits,
          usage: usage ?? 'browse', legacy: 'legacy-unclassified' as const, excluded: { legacy_unclassified: index.docs.length },
          hint: [usage === 'operational'
            ? '当前 release 为 v1（未组织化），全部内容按 legacy-unclassified 处理，不能作为已批准规则回答。可改用 browse 浏览、get_knowledge 阅读原文或回源原始库。'
            : '当前 release 为 v1（未组织化），对象状态过滤不可用；可去掉对象过滤参数后浏览全文检索。'] };
        return this.jsonPage([], offset, limit, budget, next, () => empty) as SearchResult;
      }
    }
    const hints = !results.length ? queryHints(query, index.vocab) : [];
    if (knowledge?.mode === 'operational' && !results.length) {
      hints.push('无满足 operational 资格的对象命中（excluded 为原因计数，不自动退回 candidate）。可用 browse 查看候选、get_object 直接读取对象（不受屏蔽），或回源原始库核实。');
    }
    const base = { releaseId: release.releaseId, ranker, rankerVersion: ranker, query, total: results.length, unmatchedUnits,
      ...(unmatchedUnits.length ? { warning: '部分完整关键词在当前检索范围内未命中；回退片段仅供改写查询参考，不代表已覆盖所问主题。' } : {}),
      ...(!results.length ? { hint: hints } : {}),
      ...(knowledgeActive ? { usage: knowledge?.mode ?? (usage ?? 'browse'), ...(knowledge ? { excluded: knowledge.excluded } : {}), ...(view ? {} : { legacy: 'legacy-unclassified' as const }) } : {}) };
    return this.jsonPage(results, offset, limit, budget, next, (page, cursor) => ({ ...base, results: page.map((build) => build()), next: cursor })) as SearchResult;
  }

  /** 对象感知 lex 命中：片段与摘要只来自通过过滤的对象（A案 §8.2 泄漏防护） */
  private knowledgeAwareHit(ranked: { doc: KbIndexDoc; score: number; coverage: number; matchedUnits: string[]; fallbackUnits: string[]; sections: Array<{ section: KbSection; score: number }> },
    knowledge: { view: KbKnowledgeIndex; qualifies: (object: KnowledgeObject) => boolean; docQualifying: Map<string, KnowledgeObject[]> }, maxSnippets: number, query: ReturnType<typeof parseQuery>): SearchResultHit {
    const qualifying = knowledge.docQualifying.get(ranked.doc.path) ?? [];
    const docObjects = knowledge.view.objectsByDoc.get(ranked.doc.path) ?? [];
    // 文档 summary 混状态时改用对象摘要，不能泄露被过滤方案造成误用（A案 §8.2）
    const allPass = docObjects.length > 0 && docObjects.every(knowledge.qualifies);
    const scored = qualifying.map((object) => ({
      object,
      score: Math.max(0, ...ranked.sections.filter((s) => s.section.startLine <= (object.canonical?.bodyRange.endLine ?? 0)
        && (object.canonical?.bodyRange.startLine ?? Number.MAX_SAFE_INTEGER) <= s.section.endLine).map((s) => s.score)),
    })).sort((a, b) => b.score - a.score || (a.object.objectId < b.object.objectId ? -1 : 1));
    const hits = scored.slice(0, maxSnippets).map(({ object }) => this.objectSnippetHit(ranked.doc, object, query)).filter((hit): hit is SnippetHit => hit !== null);
    return { docId: ranked.doc.docId, path: ranked.doc.path, title: ranked.doc.title,
      summary: allPass ? ranked.doc.summary.slice(0, 120) : qualifying.map((object) => object.title).join('；').slice(0, 120),
      snippet: hits[0]?.snippet ?? '', hits, score: Math.round(ranked.score * 100) / 100, coverage: ranked.coverage,
      matchedUnits: ranked.matchedUnits, fallbackUnits: ranked.fallbackUnits, matchType: ranked.matchedUnits.length ? 'exact' : 'fallback',
      objectRefs: qualifying.map((object) => ({ objectId: object.objectId, businessStatus: object.businessStatus, reviewStatus: object.reviewStatus })) };
  }

  private knowledgeAwareL1Hit(hit: SearchResultHit, knowledge: { view: KbKnowledgeIndex; qualifies: (object: KnowledgeObject) => boolean; docQualifying: Map<string, KnowledgeObject[]> }, index: KbIndex, maxSnippets: number, query: ReturnType<typeof parseQuery>): SearchResultHit {
    const docNo = index.byPath.get(hit.path);
    const doc = docNo === undefined ? undefined : index.docs[docNo];
    const qualifying = knowledge.docQualifying.get(hit.path) ?? [];
    const docObjects = knowledge.view.objectsByDoc.get(hit.path) ?? [];
    const allPass = docObjects.length > 0 && docObjects.every(knowledge.qualifies);
    const hits = doc ? qualifying.slice(0, maxSnippets).map((object) => this.objectSnippetHit(doc, object, query)).filter((item): item is SnippetHit => item !== null) : [];
    return { ...hit,
      summary: allPass ? hit.summary : qualifying.map((object) => object.title).join('；').slice(0, 120),
      snippet: hits[0]?.snippet ?? hit.snippet, hits,
      objectRefs: qualifying.map((object) => ({ objectId: object.objectId, businessStatus: object.businessStatus, reviewStatus: object.reviewStatus })) };
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
