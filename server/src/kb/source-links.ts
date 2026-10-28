/**
 * P1-S4（设计 §2.3/§2.4）：引用边解析到本地文档。
 *
 * 纯函数、无 IO：输入是 LocalMapStore 的引用行（P1-S3
 * listSourceReferencesBySrc / listSourceReferencesByTarget 产物）与一个
 * 「token → documents 行」查询函数，输出同时携带方向与本地解析结果的
 * ResolvedSourceLink。三个消费面共用：
 *   - agent raw_read 的 <source_links> 追加与 raw_links 工具；
 *   - GET /api/mapping/content 的出边列表（预览面板「引用」区）；
 *   - source-batch 预览的 reference_loss_risk（独立实现，不经本模块）。
 *
 * 解析口径（§2.3）：目标 token 按 obj_token 与 wiki_node_token 双键匹配
 * ——外部文档可能用任一种 URL 引用同一篇文档。未命中的目标保留原始
 * token（「指向不在本库的文档」是真实信息，不是错误）。
 */

import { hasSuccessfulLocalVersion } from './raw-source-snapshot.js';
import type { DocumentRecord } from '../types/index.js';

/** 引用出边行（与 local-map-store SourceReferenceRow 结构兼容）。 */
export interface SourceLinkEdgeRow {
  srcObjToken: string;
  targetToken: string;
  targetType: string;
  label: string | null;
  origin: 'body' | 'refmap';
  kind: string;
  occurrences: number;
  updatedAt: string;
}

/** 引用入边行（出边行 + 引用方文档元数据；源行已删时元数据为 null）。 */
export interface IncomingLinkEdgeRow extends SourceLinkEdgeRow {
  srcTitle: string | null;
  srcLocalRelPath: string | null;
}

/** 已解析到本地文档行的引用（设计 §2.3 ResolvedReference 的实现面）。 */
export interface ResolvedSourceLink {
  direction: 'out' | 'in';
  /** out：边目标 token（URL 中的原值）；in：引用方 obj_token。 */
  token: string;
  targetType: string;
  origin: 'body' | 'refmap';
  kind: string;
  /** 展示标题：优先解析到的本地文档标题，回退边 label。 */
  title: string | null;
  occurrences: number;
  /** 解析到的本地 documents 行 obj_token（按 obj/wiki 双键；null=不在本地库）。 */
  objToken: string | null;
  localRelPath: string | null;
  /** 是否有成功本地版本（设计 inRawSnapshot 的库级口径；build 态快照口径由调用方覆写）。 */
  synced: boolean;
}

/** token → documents 行查询（obj_token 或 wiki_node_token 命中均可）。 */
export type SourceLinkLookup = (token: string) => DocumentRecord | null;

export interface ResolveSourceLinksInput {
  outEdges: ReadonlyArray<SourceLinkEdgeRow>;
  inEdges: ReadonlyArray<IncomingLinkEdgeRow>;
  lookup: SourceLinkLookup;
}

/** 确定性排序：occurrences 降序，再标题、再 token 升序（§2.4 展示顺序）。 */
export function sortResolvedLinks(links: ResolvedSourceLink[]): ResolvedSourceLink[] {
  return links.slice().sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    const titleA = a.title ?? '';
    const titleB = b.title ?? '';
    if (titleA !== titleB) return titleA < titleB ? -1 : 1;
    if (a.token !== b.token) return a.token < b.token ? -1 : 1;
    return 0;
  });
}

/** 双键解析一个目标 token 到本地 documents 行。 */
function resolveDoc(lookup: SourceLinkLookup, token: string): DocumentRecord | null {
  if (!token) return null;
  return lookup(token);
}

export function resolveSourceLinks(input: ResolveSourceLinksInput): {
  out: ResolvedSourceLink[];
  in: ResolvedSourceLink[];
} {
  const out = input.outEdges.map((edge) => {
    const doc = resolveDoc(input.lookup, edge.targetToken);
    return {
      direction: 'out' as const,
      token: edge.targetToken,
      targetType: edge.targetType,
      origin: edge.origin,
      kind: edge.kind,
      title: doc?.title || edge.label || null,
      occurrences: edge.occurrences,
      objToken: doc?.objToken ?? null,
      localRelPath: doc?.localRelPath ?? null,
      synced: Boolean(doc && doc.localRelPath && hasSuccessfulLocalVersion(doc)),
    };
  });
  const inLinks = input.inEdges.map((edge) => {
    const doc = resolveDoc(input.lookup, edge.srcObjToken);
    return {
      direction: 'in' as const,
      token: edge.srcObjToken,
      targetType: edge.targetType,
      origin: edge.origin,
      kind: edge.kind,
      title: doc?.title || edge.srcTitle || edge.label || null,
      occurrences: edge.occurrences,
      objToken: doc?.objToken ?? null,
      localRelPath: doc?.localRelPath ?? edge.srcLocalRelPath ?? null,
      synced: Boolean(doc && doc.localRelPath && hasSuccessfulLocalVersion(doc)),
    };
  });
  return { out: sortResolvedLinks(out), in: sortResolvedLinks(inLinks) };
}

/**
 * raw_read 末页 <source_links> 块（§2.4 契约）：出入链各取前 30 条，
 * 超出方向标 truncated="true"；属性值 XML 转义。整体是应用生成的结构
 * 信息（位于 <untrusted_source> 之外），但标题取自文档数据。
 */
export const SOURCE_LINKS_PAGE_LIMIT = 30;

export function renderSourceLinksBlock(input: {
  objToken: string;
  out: ReadonlyArray<ResolvedSourceLink & { kbDocs?: string[]; inRaw?: boolean }>;
  in: ReadonlyArray<ResolvedSourceLink>;
}): string | null {
  if (input.out.length === 0 && input.in.length === 0) return null;
  const outVisible = input.out.slice(0, SOURCE_LINKS_PAGE_LIMIT);
  const inVisible = input.in.slice(0, SOURCE_LINKS_PAGE_LIMIT);
  const attrs: string[] = [`obj_token="${escapeXmlAttr(input.objToken)}"`];
  if (input.out.length > outVisible.length) attrs.push('out_truncated="true"');
  if (input.in.length > inVisible.length) attrs.push('in_truncated="true"');
  const lines: string[] = [`<source_links ${attrs.join(' ')}>`];
  for (const link of outVisible) {
    const parts = [
      `target="${escapeXmlAttr(link.token)}"`,
      ...(link.title != null ? [`title="${escapeXmlAttr(link.title)}"`] : []),
      ...(link.localRelPath != null ? [`path="${escapeXmlAttr(link.localRelPath)}"`] : []),
      `in_raw="${link.inRaw ?? link.synced ? 'true' : 'false'}"`,
      ...(link.kbDocs && link.kbDocs.length > 0 ? [`kb="${escapeXmlAttr(link.kbDocs.join(';'))}"`] : []),
    ];
    lines.push(`  <out ${parts.join(' ')}/>`);
  }
  for (const link of inVisible) {
    const parts = [
      `source="${escapeXmlAttr(link.token)}"`,
      ...(link.title != null ? [`title="${escapeXmlAttr(link.title)}"`] : []),
      ...(link.localRelPath != null ? [`path="${escapeXmlAttr(link.localRelPath)}"`] : []),
    ];
    lines.push(`  <in ${parts.join(' ')}/>`);
  }
  lines.push('</source_links>');
  return lines.join('\n');
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
