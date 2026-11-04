/** Additive MCP output contract. Text fallbacks remain readable by older clients. */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
const str = { type: 'string' };
const num = { type: 'integer', minimum: 0 };
const nullable = (value: object) => ({ anyOf: [value, { type: 'null' }] });
const rows = { type: 'array', items: { type: 'object' } };
const object = { type: 'object' };
const page = { next: nullable(str) };
const raw = { sourceKind: { type: 'string', const: 'raw' }, catalogUpdatedAt: str, note: str,
  sourceAvailability: { type: 'string', enum: ['permission_denied_placeholder', 'unreadable'] }, usableAsEvidence: { type: 'boolean' } };
const rawPage = { ...raw, total: num, nextOffset: nullable(num) };
const status = { type: 'object', properties: { scope: { type: 'string', const: 'page' },
  state: { type: 'string', enum: ['available', 'legacy-unclassified', 'unavailable'] }, note: str,
  objectRefs: { type: 'array', items: { type: 'object', properties: { objectId: str,
    businessStatus: { type: 'string', enum: ['unknown', 'candidate', 'approved', 'disputed', 'deprecated'] },
    reviewStatus: { type: 'string', enum: ['pending', 'passed', 'rejected', 'stale'] }, evidenceCount: num },
  required: ['objectId', 'businessStatus', 'reviewStatus', 'evidenceCount'] } } }, required: ['scope', 'state', 'objectRefs', 'note'] };
const standard = { releaseId: str, notice: str };
const text = { ...standard, text: str, ...page };
const contracts: Record<string, { properties: Record<string, object>; required: string[] }> = {
  search_knowledge: { properties: { ...standard, ...page, query: object, total: num, results: rows, unmatchedUnits: { type: 'array', items: str }, warning: str }, required: ['releaseId', 'query', 'total', 'results', 'next'] },
  grep_knowledge: { properties: { ...standard, ...page, mode: str, totalMatches: num, totalFiles: num, complete: { type: 'boolean' }, files: rows }, required: ['releaseId', 'mode', 'totalMatches', 'files', 'complete', 'next'] },
  get_outline: { properties: text, required: ['releaseId', 'text', 'next'] },
  list_knowledge: { properties: text, required: ['releaseId', 'text', 'next'] },
  get_knowledge_bundle: { properties: text, required: ['releaseId', 'text', 'next'] },
  get_knowledge: { properties: { ...text, next: nullable(num), startLine: num, endLine: num, knowledgeStatus: status }, required: ['releaseId', 'text', 'next', 'startLine', 'endLine', 'knowledgeStatus'] },
  get_release_info: { properties: { ...standard, ...page, docCount: num, sourceCount: num, coverage: object, sources: rows }, required: ['releaseId', 'docCount', 'sourceCount', 'coverage', 'sources', 'next'] },
  get_object: { properties: { ...standard, ...page, object: nullable(object), evidence: rows, evidenceNote: str, related: rows }, required: ['releaseId', 'object', 'evidence', 'evidenceNote', 'next'] },
  compare_knowledge: { properties: { ...standard, ...page, objects: rows, total: num, usage: str, related: rows }, required: ['releaseId', 'objects', 'total', 'next'] },
  raw_list: { properties: { ...rawPage, catalogHash: str, results: rows }, required: ['sourceKind', 'catalogHash', 'results', 'total', 'nextOffset'] },
  raw_search: { properties: { ...rawPage, catalogHash: str, results: rows }, required: ['sourceKind', 'catalogHash', 'results', 'total', 'nextOffset'] },
  raw_read: { properties: { ...rawPage, contentHash: str, lines: rows, sourceSegments: rows }, required: ['sourceKind', 'contentHash', 'lines', 'nextOffset'] },
  raw_list_sheets: { properties: { ...rawPage, contentHash: str, sheets: rows }, required: ['sourceKind', 'contentHash', 'sheets', 'total', 'nextOffset'] },
  raw_search_sheet: { properties: { ...rawPage, contentHash: str, cells: rows, complete: { type: 'boolean' } }, required: ['sourceKind', 'contentHash', 'cells', 'complete', 'nextOffset'] },
  raw_read_sheet: { properties: { ...rawPage, contentHash: str, sheet: str, cells: rows }, required: ['sourceKind', 'contentHash', 'sheet', 'cells', 'nextOffset'] },
  raw_list_images: { properties: { ...rawPage, contentHash: str, images: rows }, required: ['sourceKind', 'contentHash', 'images', 'nextOffset'] },
  raw_search_images: { properties: { ...rawPage, catalogHash: str, images: rows, nextSourceOffset: nullable(num) }, required: ['sourceKind', 'catalogHash', 'images', 'nextOffset'] },
  raw_read_image: { properties: { ...raw, image: object }, required: ['sourceKind', 'image'] },
  raw_links: { properties: { ...rawPage, catalogHash: str, links: rows }, required: ['sourceKind', 'catalogHash', 'links', 'nextOffset'] },
};
export function withOutputSchema(tool: Tool): Tool {
  const contract = contracts[tool.name];
  if (tool.outputSchema) return tool;
  if (!contract) throw new Error(`Missing MCP output contract: ${tool.name}`);
  return { ...tool, outputSchema: { type: 'object', ...contract, additionalProperties: true } };
}
