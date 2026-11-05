import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contentResourceHash } from './evidence-locator.js';
import type { EvidenceResourcesFile } from './knowledge-compiler.js';
import type { KbManifest } from '../types/agent-knowledge.js';
import type { SourceContents } from './kb-version-store.js';

export interface SourceChangeBaseline {
  releaseId: string;
  contents: SourceContents;
  index: EvidenceResourcesFile | null;
}

export function sourceChangeBaseline(releaseRoot: string, manifest: KbManifest, contents: SourceContents): SourceChangeBaseline {
  const baseline: SourceChangeBaseline = { releaseId: manifest.releaseId, contents, index: null };
  if (!manifest.evidence?.hash) return baseline;
  const bytes = fs.readFileSync(path.join(releaseRoot, 'evidence-resources.json'));
  if (`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== manifest.evidence.hash) {
    throw new Error('来源变化基准证据索引哈希不匹配');
  }
  const index = JSON.parse(bytes.toString('utf8')) as EvidenceResourcesFile;
  if (index.schemaVersion !== 1 || index.normalization !== 'utf8-bytes-in-source-contents') {
    throw new Error('来源变化基准证据索引格式无效');
  }
  baseline.index = index;
  return baseline;
}

/** Mechanical reading hints, never evidence receipts or a semantic skip verdict.
 * A legacy index may omit unquoted sheets: report those as unknown, not added. */
export function summarizeSourceChanges(baseline: SourceChangeBaseline | null, input: {
  resources: Array<{ resourceId: string; sourceId: string; kind: 'text' | 'csv'; lines: string[] }>;
  segments: Array<{ resourceId?: string; outStart: number; outEnd: number; resStart?: number; resEnd?: number }>;
}) {
  let unchangedResources = 0;
  const changes: Array<{ resourceId: string; change: 'changed' | 'baseline_unindexed' | 'removed';
    oldLines?: number; currentLines?: number; resourceLineStart?: number; resourceLineEnd?: number;
    outputStart?: number; outputEnd?: number }> = [];
  for (const resource of input.resources) {
    const combined = baseline?.contents[resource.sourceId];
    const indexed = baseline?.index?.resources.find((item) => item.resourceId === resource.resourceId);
    let previous: string | undefined;
    if (combined !== undefined && indexed && Number.isSafeInteger(indexed.byteOffset) && Number.isSafeInteger(indexed.byteLength)) {
      const bytes = Buffer.from(combined, 'utf8');
      const start = indexed.byteOffset!;
      const length = indexed.byteLength!;
      if (start < 0 || length < 0 || start + length > bytes.length) throw new Error(`来源变化基准区段无效：${resource.resourceId}`);
      previous = bytes.subarray(start, start + length).toString('utf8');
      if (contentResourceHash(previous) !== indexed.resourceHash) throw new Error(`来源变化基准资源哈希不匹配：${resource.resourceId}`);
    } else if (combined !== undefined && resource.kind === 'text' && !combined.includes('\n\n--- CSV 1 ---\n')) {
      previous = combined;
    }
    if (previous === undefined) {
      changes.push({ resourceId: resource.resourceId, change: 'baseline_unindexed', currentLines: resource.lines.length });
      continue;
    }
    if (previous === resource.lines.join('\n')) { unchangedResources += 1; continue; }
    const old = previous.split('\n');
    const current = resource.lines;
    let prefix = 0;
    while (prefix < old.length && prefix < current.length && old[prefix] === current[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < old.length - prefix && suffix < current.length - prefix
      && old[old.length - suffix - 1] === current[current.length - suffix - 1]) suffix += 1;
    // Include surrounding lines, including the surviving neighbour of a deletion.
    const start = Math.max(1, prefix - 2);
    const end = Math.min(current.length, Math.max(prefix + 1, current.length - suffix) + 3);
    const segments = input.segments.filter((segment) => segment.resourceId === resource.resourceId
      && segment.resStart !== undefined && segment.resEnd !== undefined
      && segment.resStart <= end && segment.resEnd >= start);
    const first = segments[0]; const last = segments.at(-1);
    changes.push({ resourceId: resource.resourceId, change: 'changed', oldLines: old.length, currentLines: current.length,
      resourceLineStart: start, resourceLineEnd: end,
      ...(first && last ? { outputStart: first.outStart + Math.max(0, start - first.resStart!),
        outputEnd: last.outEnd - Math.max(0, last.resEnd! - end) } : {}) });
  }
  const sourceId = input.resources[0]?.sourceId;
  const currentIds = new Set(input.resources.map((item) => item.resourceId));
  for (const old of baseline?.index?.resources ?? []) {
    if (old.sourceId === sourceId && (old.kind === 'text' || old.kind === 'csv') && !currentIds.has(old.resourceId)) {
      changes.push({ resourceId: old.resourceId, change: 'removed' });
    }
  }
  return { baselineAvailable: baseline != null && sourceId != null && baseline.contents[sourceId] !== undefined,
    unchangedResources, changes: changes.slice(0, 24), truncated: changes.length > 24 };
}
