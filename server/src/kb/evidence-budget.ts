/** A growing incremental library must not spend its entire evidence budget on
 * already published, immutable resources at every stage publication. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolveInside } from '../agent/path-guard.js';
import { DEFAULT_EVIDENCE_BUDGET_BYTES, EVIDENCE_BUDGET_MAX_BYTES, resolveEvidenceBudgetBytes, type StandardKbConfig } from '../types/agent-knowledge.js';
import { StandardKbStore } from './standard-kb-store.js';
import { resolveRelease } from './search/release-reader.js';

function releaseEvidenceBytes(outputRoot: string, releaseId: string): number {
  const manifest = new StandardKbStore(outputRoot).readManifest(releaseId);
  if (!manifest) throw new Error(`证据预算基线 release 不可读取：${releaseId}`);
  if (!manifest.evidence) return 0;
  const release = resolveRelease(outputRoot, releaseId);
  const bytes = fs.readFileSync(resolveInside(release.releaseDir, manifest.evidence.resourcesPath, 'read'));
  const hash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (hash !== manifest.evidence.hash) throw new Error(`证据预算基线索引哈希不符：${releaseId}`);
  const index = JSON.parse(bytes.toString('utf8')) as { evidenceFiles?: Array<{ path?: string; bytes?: number }> };
  if (!Array.isArray(index.evidenceFiles)) throw new Error(`证据预算基线索引无效：${releaseId}`);
  const unique = new Map<string, number>();
  for (const file of index.evidenceFiles) {
    if (typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || (file.bytes ?? -1) < 0) {
      throw new Error(`证据预算基线资源记录无效：${releaseId}`);
    }
    const old = unique.get(file.path);
    if (old !== undefined && old !== file.bytes) throw new Error(`证据预算基线资源路径冲突：${file.path}`);
    unique.set(file.path, file.bytes!);
  }
  return [...unique.values()].reduce((sum, value) => sum + value, 0);
}

function originEvidenceBytes(outputRoot: string, baseReleaseId: string | null, buildId: string): number {
  const store = new StandardKbStore(outputRoot);
  const visited = new Set<string>();
  let releaseId = baseReleaseId;
  let earliestRetainedStage: string | null = null;
  while (releaseId) {
    if (visited.has(releaseId)) throw new Error('证据预算基线存在 release 循环');
    visited.add(releaseId);
    const manifest = store.readManifest(releaseId);
    // Retention may already have pruned an ancestor. The earliest retained
    // stage is a conservative upper bound for its origin's evidence bytes.
    if (!manifest) return earliestRetainedStage ? releaseEvidenceBytes(outputRoot, earliestRetainedStage) : 0;
    if (manifest.buildId !== buildId) return releaseEvidenceBytes(outputRoot, releaseId);
    if (Number.isSafeInteger(manifest.evidenceBudgetOriginBytes) && manifest.evidenceBudgetOriginBytes! >= 0) {
      return manifest.evidenceBudgetOriginBytes!;
    }
    earliestRetainedStage = releaseId;
    releaseId = manifest.baseReleaseId;
  }
  return earliestRetainedStage ? releaseEvidenceBytes(outputRoot, earliestRetainedStage) : 0;
}

export function evidenceBudgetForPublication(input: {
  config: Pick<StandardKbConfig, 'evidenceBudgetBytes'> | null | undefined;
  mode: 'incremental' | 'full';
  outputRoot: string;
  baseReleaseId: string | null;
  buildId: string;
}): { limit: number; originBytes?: number } {
  const configured = resolveEvidenceBudgetBytes(input.config);
  // An explicit limit keeps its original absolute per-release meaning.
  if (input.config?.evidenceBudgetBytes !== undefined || input.mode !== 'incremental') return { limit: configured };
  // The default is a per-build allowance above the immutable origin. Following
  // the release chain avoids resetting that allowance after each stage.
  const carried = originEvidenceBytes(input.outputRoot, input.baseReleaseId, input.buildId);
  return { limit: Math.min(EVIDENCE_BUDGET_MAX_BYTES, carried + DEFAULT_EVIDENCE_BUDGET_BYTES), originBytes: carried };
}
