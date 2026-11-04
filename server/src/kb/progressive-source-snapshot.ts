/**
 * A progressive release keeps untouched documents and their source versions from
 * the current immutable release. Only sources used by newly promoted documents
 * advance to the build snapshot. Frozen text/CSV bytes are recovered from the
 * release's verified resource index, so the publisher can validate the mixed
 * snapshot without reading newer bytes from the live source tree.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KbManifest, RawSourceSnapshotEntry } from '../types/agent-knowledge.js';
import type { KnowledgeDraftFile } from '../agent/agent-tool-service.js';
import { contentResourceHash, verifyEvidence, type EvidenceResource } from './evidence-locator.js';
import type { EvidenceResourcesFile } from './knowledge-compiler.js';
import type { ImageEvidencePayload } from './evidence-resources.js';
import type { SourceContents } from './kb-version-store.js';
import { RawSourceSnapshot } from './raw-source-snapshot.js';

interface FrozenSource {
  content: string;
  attachments: Array<{ path: string; content: string }>;
}

/** Load published image evidence from the immutable release, including its
 * caption. Progressive publication must not substitute newer live image bytes
 * for a carried document's already published source version. */
export function loadProgressiveBaselineImages(input: {
  releaseRoot: string;
  evidenceIndexHash: string;
  resourceIds: ReadonlySet<string>;
}): Map<string, ImageEvidencePayload> {
  const result = new Map<string, ImageEvidencePayload>();
  if (input.resourceIds.size === 0) return result;
  const indexBytes = fs.readFileSync(path.join(input.releaseRoot, 'evidence-resources.json'));
  const indexHash = `sha256:${crypto.createHash('sha256').update(indexBytes).digest('hex')}`;
  if (indexHash !== input.evidenceIndexHash) throw new Error('阶段发布基准图片证据索引哈希不匹配');
  const index = JSON.parse(indexBytes.toString('utf8')) as EvidenceResourcesFile;
  if (index.schemaVersion !== 1) throw new Error('阶段发布基准图片证据索引格式无效');
  for (const resourceId of input.resourceIds) {
    const resource = index.resources.find((item) => item.resourceId === resourceId && item.kind === 'image');
    const file = index.evidenceFiles.find((item) => item.resourceId === resourceId && item.kind === 'image');
    if (!resource || !file?.image || resource.resourceHash !== file.hash
      || file.image.imageHash !== file.hash || !/^evidence\/image-[a-f0-9]{16}\.bin$/.test(file.path)) {
      throw new Error(`阶段发布继承图片证据索引不符：${resourceId}`);
    }
    const bytes = fs.readFileSync(path.join(input.releaseRoot, file.path));
    const hash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (hash !== file.hash || bytes.length !== file.bytes) throw new Error(`阶段发布继承图片证据文件损坏：${resourceId}`);
    result.set(resourceId, {
      src: file.image.src, bytes,
      resource: { resourceId, kind: 'image', sourceId: resource.sourceId,
        sourceSnapshotHash: resource.sourceSnapshotHash, resourceHash: resource.resourceHash,
        imageHash: file.image.imageHash, caption: file.image.caption },
    });
  }
  return result;
}

function frozenSourcesFromRelease(input: {
  releaseRoot: string;
  manifest: KbManifest;
  sourceContents: SourceContents;
  tokens: ReadonlySet<string>;
}): Map<string, FrozenSource> {
  if (input.tokens.size === 0) return new Map();
  const indexPath = path.join(input.releaseRoot, 'evidence-resources.json');
  const expectedHash = input.manifest.evidence?.hash;
  if (!expectedHash) {
    // Legacy v1 releases have a verified source-contents sidecar but no
    // evidence index. A text-only source can be carried exactly as published;
    // CSV split boundaries cannot be reconstructed safely without the index.
    const frozen = new Map<string, FrozenSource>();
    for (const token of input.tokens) {
      const combined = input.sourceContents[token];
      if (!input.manifest.sourceSnapshot.some((entry) => entry.objToken === token) || typeof combined !== 'string'
        || combined.includes('\n\n--- CSV 1 ---\n')) {
        throw new Error(`阶段发布缺少基准来源证据区段：${token}`);
      }
      frozen.set(token, { content: combined, attachments: [] });
    }
    return frozen;
  }
  const indexBytes = fs.readFileSync(indexPath);
  const actualHash = `sha256:${crypto.createHash('sha256').update(indexBytes).digest('hex')}`;
  if (!expectedHash || actualHash !== expectedHash) throw new Error('阶段发布冻结证据索引与基准版本不一致');
  const index = JSON.parse(indexBytes.toString('utf8')) as EvidenceResourcesFile;
  if (index.schemaVersion !== 1 || index.normalization !== 'utf8-bytes-in-source-contents') {
    throw new Error('阶段发布不支持基准版本的证据索引格式');
  }
  const baseEntries = new Map(input.manifest.sourceSnapshot.map((entry) => [entry.objToken, entry]));
  const frozen = new Map<string, FrozenSource>();
  for (const token of input.tokens) {
    const entry = baseEntries.get(token);
    const combined = input.sourceContents[token];
    if (!entry || typeof combined !== 'string') throw new Error(`阶段发布缺少基准来源快照：${token}`);
    const combinedBytes = Buffer.from(combined, 'utf8');
    const resources = index.resources.filter((item) => item.sourceId === token && (item.kind === 'text' || item.kind === 'csv'));
    const text = resources.filter((item) => item.kind === 'text');
    // Older releases index only sources referenced by compiled evidence. A
    // carried source without evidence still has its exact combined bytes in
    // source-contents.json; accept that as text only when no CSV split is needed.
    if (resources.length === 0 && !combined.includes('\n\n--- CSV 1 ---\n')) {
      frozen.set(token, { content: combined, attachments: [] });
      continue;
    }
    if (text.length !== 1) throw new Error(`阶段发布缺少基准来源正文区段：${token}`);
    const read = (item: typeof resources[number]): string => {
      const start = item.byteOffset;
      const length = item.byteLength;
      if (item.sourceSnapshotHash !== entry.contentHash || !Number.isSafeInteger(start) || !Number.isSafeInteger(length)
        || start! < 0 || length! < 0 || start! + length! > combinedBytes.length) {
        throw new Error(`阶段发布基准来源区段无效：${token}`);
      }
      const value = combinedBytes.subarray(start!, start! + length!).toString('utf8');
      if (contentResourceHash(value) !== item.resourceHash) throw new Error(`阶段发布基准来源资源哈希不匹配：${token}`);
      return value;
    };
    const content = read(text[0]!);
    const attachments = resources.filter((item) => item.kind === 'csv')
      .sort((a, b) => a.byteOffset! - b.byteOffset!)
      .map((item) => {
        if (!item.path || path.basename(item.path) !== item.path) throw new Error(`阶段发布基准 CSV 路径无效：${token}`);
        return { path: item.path, content: read(item) };
      });
    const recombined = content + attachments.map((attachment, index) => `\n\n--- CSV ${index + 1} ---\n${attachment.content}`).join('');
    if (recombined !== combined) throw new Error(`阶段发布基准来源区段不完整：${token}`);
    frozen.set(token, { content, attachments });
  }
  return frozen;
}

/** Existing published source versions remain frozen until their documents are
 * promoted. The live snapshot still verifies every newly promoted source. */
export function progressiveSourceSnapshot(input: {
  entries: RawSourceSnapshotEntry[];
  live: RawSourceSnapshot;
  manifest: KbManifest | null;
  releaseRoot: string | null;
  sourceContents: SourceContents;
  promotedSources: ReadonlySet<string>;
}): RawSourceSnapshot {
  const baseEntries = input.manifest?.sourceSnapshot ?? [];
  const frozenTokens = new Set(baseEntries.filter((entry) => {
    const current = input.live.get(entry.objToken);
    return !input.promotedSources.has(entry.objToken) && current?.contentHash !== entry.contentHash;
  }).map((entry) => entry.objToken));
  if (frozenTokens.size && (!input.manifest || !input.releaseRoot)) throw new Error('阶段发布缺少基准版本');
  const frozen = frozenTokens.size
    ? frozenSourcesFromRelease({ releaseRoot: input.releaseRoot!, manifest: input.manifest!, sourceContents: input.sourceContents, tokens: frozenTokens })
    : new Map<string, FrozenSource>();
  const baseKnowledgePath = input.releaseRoot && path.join(input.releaseRoot, 'knowledge.json');
  if (frozen.size && baseKnowledgePath && fs.existsSync(baseKnowledgePath)) {
    const knowledge = JSON.parse(fs.readFileSync(baseKnowledgePath, 'utf8')) as { evidence?: Array<{ sourceRef?: { sourceId?: string }; selector?: { kind?: string } }> };
    const indexed = input.manifest?.evidence?.hash
      ? new Set<string>(JSON.parse(fs.readFileSync(path.join(input.releaseRoot!, 'evidence-resources.json'), 'utf8'))
        .resources.map((item: { sourceId: string }) => item.sourceId))
      : new Set<string>();
    if (knowledge.evidence?.some((item) => frozen.has(item.sourceRef?.sourceId ?? '')
      && (!indexed.has(item.sourceRef?.sourceId ?? '')
        || (item.selector?.kind !== 'text_span' && item.selector?.kind !== 'csv_cells'
          && item.selector?.kind !== 'media_region')))) {
      throw new Error('阶段发布缺少冻结证据，或包含尚不支持的工作簿证据');
    }
  }
  return new class extends RawSourceSnapshot {
    override readVerified(root: string, token: string) {
      const entry = this.get(token);
      if (!entry) throw new Error(`阶段发布来源不在快照内：${token}`);
      const prior = frozen.get(token);
      if (prior) return { ...prior, realPath: path.join(input.releaseRoot!, 'source-contents.json'), entry };
      const current = input.live.readVerified(root, token);
      if (current.entry.contentHash !== entry.contentHash) throw new Error(`阶段发布来源版本不一致：${token}`);
      return { ...current, entry };
    }
  }(input.entries);
}

/** Recheck carried citations against the frozen release bytes and issue
 * mechanical stage receipts. These receipts are scoped to the temporary
 * candidate; writer evidence keeps its original read receipts. */
export function seedProgressiveCarriedReceipts(input: {
  stagingRoot: string;
  buildId: string;
  knowledgeBaseRoot: string;
  snapshot: RawSourceSnapshot;
  draft: KnowledgeDraftFile;
  carriedPaths: ReadonlySet<string>;
  baselineReleaseRoot: string | null;
  baselineEvidenceHash: string | null;
}): number {
  const objects = new Map(input.draft.objects.map((object) => [object.objectId, object]));
  const lines: string[] = [];
  const carriedImages = new Set(input.draft.evidence.filter((evidence) =>
    evidence.selector.kind === 'media_region'
    && input.carriedPaths.has(objects.get(evidence.objectId)?.canonical?.path ?? ''))
    .map((evidence) => evidence.sourceRef.resourceId));
  if (carriedImages.size && (!input.baselineReleaseRoot || !input.baselineEvidenceHash)) {
    throw new Error('阶段发布缺少基准图片证据索引');
  }
  const publishedImages = carriedImages.size
    ? loadProgressiveBaselineImages({ releaseRoot: input.baselineReleaseRoot!,
      evidenceIndexHash: input.baselineEvidenceHash!, resourceIds: carriedImages })
    : new Map<string, ImageEvidencePayload>();
  for (const evidence of input.draft.evidence) {
    const docPath = objects.get(evidence.objectId)?.canonical?.path;
    if (!docPath || !input.carriedPaths.has(docPath)) continue;
    if (evidence.selector.kind !== 'text_span' && evidence.selector.kind !== 'csv_cells'
      && evidence.selector.kind !== 'media_region') {
      throw new Error(`阶段发布不支持继承证据类型：${evidence.evidenceId}/${evidence.selector.kind}`);
    }
    const entry = input.snapshot.get(evidence.sourceRef.sourceId);
    if (!entry) throw new Error(`阶段发布继承证据来源缺失：${evidence.evidenceId}`);
    if (evidence.selector.kind === 'media_region') {
      const resource = publishedImages.get(evidence.sourceRef.resourceId)?.resource;
      if (!resource || resource.sourceId !== entry.objToken
        || resource.sourceSnapshotHash !== entry.contentHash || resource.resourceHash !== evidence.sourceRef.resourceHash) {
        throw new Error(`阶段发布继承图片证据索引不符：${evidence.evidenceId}`);
      }
      const readReceiptId = `krr_stage_${crypto.createHash('sha256')
        .update(`${input.buildId}\0${evidence.evidenceId}\0${entry.contentHash}`).digest('hex').slice(0, 20)}`;
      const verification = verifyEvidence({ evidence: {
        evidenceId: evidence.evidenceId, sourceRef: evidence.sourceRef, selector: evidence.selector,
        quoteHash: evidence.quoteHash, readReceiptId,
      }, resources: [resource], receipts: [{ readReceiptId, resourceId: resource.resourceId, lineStart: 1, lineEnd: 1 }] });
      if (!verification.ok) throw new Error(`阶段发布继承图片证据复核失败：${evidence.evidenceId} — ${verification.message}`);
      evidence.readReceiptId = readReceiptId;
      lines.push(JSON.stringify({ readReceiptId, buildId: input.buildId, unitId: null,
        toolCallId: 'progressive-baseline-carry', sourceSnapshotHash: entry.contentHash,
        resourceId: resource.resourceId, selector: { kind: 'read_range', lineStart: 1, lineEnd: 1 },
        returnedHash: resource.resourceHash, truncated: false }));
      continue;
    }
    const verified = input.snapshot.readVerified(input.knowledgeBaseRoot, entry.objToken);
    const csvBase = evidence.sourceRef.resourceId.includes('#csv:')
      ? evidence.sourceRef.resourceId.split('#csv:')[1] ?? '' : '';
    const content = csvBase
      ? verified.attachments.find((attachment) => path.basename(attachment.path) === csvBase)?.content
      : verified.content;
    if (content === undefined) throw new Error(`阶段发布继承证据资源缺失：${evidence.evidenceId}`);
    const resource: EvidenceResource = {
      resourceId: evidence.sourceRef.resourceId, kind: csvBase ? 'csv' : 'text',
      content, ...(csvBase ? { path: csvBase } : {}), sourceId: entry.objToken,
      sourceSnapshotHash: entry.contentHash, resourceHash: contentResourceHash(content),
    };
    const range = evidence.selector.kind === 'text_span'
      ? { lineStart: evidence.selector.lineStart, lineEnd: evidence.selector.lineEnd }
      : { lineStart: 1, lineEnd: content.split('\n').length };
    const readReceiptId = `krr_stage_${crypto.createHash('sha256')
      .update(`${input.buildId}\0${evidence.evidenceId}\0${entry.contentHash}`).digest('hex').slice(0, 20)}`;
    const verification = verifyEvidence({ evidence: {
      evidenceId: evidence.evidenceId, sourceRef: evidence.sourceRef, selector: evidence.selector,
      quoteHash: evidence.quoteHash, readReceiptId,
    }, resources: [resource], receipts: [{ readReceiptId, resourceId: resource.resourceId, ...range }] });
    if (!verification.ok) throw new Error(`阶段发布继承证据复核失败：${evidence.evidenceId} — ${verification.message}`);
    evidence.readReceiptId = readReceiptId;
    lines.push(JSON.stringify({ readReceiptId, buildId: input.buildId, unitId: null,
      toolCallId: 'progressive-baseline-carry', sourceSnapshotHash: entry.contentHash,
      resourceId: resource.resourceId, selector: { kind: 'read_range', ...range },
      returnedHash: resource.resourceHash, truncated: false }));
  }
  if (lines.length) fs.appendFileSync(path.join(input.stagingRoot, 'read-receipts.jsonl'), `${lines.join('\n')}\n`);
  return lines.length;
}

/** A progressive release stores stage-scoped image receipts. Rebind only
 * unchanged published image evidence to the next build after verifying the
 * immutable image bytes and caption against the release index. Changed source
 * evidence stays untouched so the normal publish gate requires a rewrite. */
export function rebindBaselineImageEvidence(input: {
  buildId: string;
  draft: KnowledgeDraftFile;
  snapshot: RawSourceSnapshot;
  releaseRoot: string;
  evidenceIndexHash: string | null;
}): string[] {
  const eligible = input.draft.evidence.filter((evidence) => evidence.selector.kind === 'media_region'
    && input.snapshot.get(evidence.sourceRef.sourceId)?.contentHash === evidence.sourceRef.sourceSnapshotHash);
  if (eligible.length === 0) return [];
  if (!input.evidenceIndexHash) throw new Error('基线图片证据缺少发布索引，无法接续回执');
  const publishedImages = loadProgressiveBaselineImages({
    releaseRoot: input.releaseRoot,
    evidenceIndexHash: input.evidenceIndexHash,
    resourceIds: new Set(eligible.map((evidence) => evidence.sourceRef.resourceId)),
  });
  return eligible.map((evidence) => {
    const entry = input.snapshot.get(evidence.sourceRef.sourceId)!;
    const resource = publishedImages.get(evidence.sourceRef.resourceId)?.resource;
    if (!resource) throw new Error(`基线图片证据资源缺失：${evidence.evidenceId}`);
    const readReceiptId = `krr_seed_${crypto.createHash('sha256')
      .update(`${input.buildId}\0${evidence.evidenceId}\0${entry.contentHash}`).digest('hex').slice(0, 20)}`;
    const verification = verifyEvidence({
      evidence: { evidenceId: evidence.evidenceId, sourceRef: evidence.sourceRef,
        selector: evidence.selector, quoteHash: evidence.quoteHash, readReceiptId },
      resources: [resource],
      receipts: [{ readReceiptId, resourceId: resource.resourceId, lineStart: 1, lineEnd: 1 }],
    });
    if (!verification.ok) throw new Error(`基线图片证据复核失败：${evidence.evidenceId} — ${verification.message}`);
    evidence.readReceiptId = readReceiptId;
    return JSON.stringify({ readReceiptId, buildId: input.buildId, unitId: null,
      toolCallId: 'baseline-carry-image', sourceSnapshotHash: entry.contentHash,
      resourceId: resource.resourceId, selector: { kind: 'read_range', lineStart: 1, lineEnd: 1 },
      returnedHash: resource.resourceHash, truncated: false });
  });
}
