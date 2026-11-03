import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evidenceBudgetForPublication } from '../src/kb/evidence-budget.js';
import { planReleaseEvidenceFiles, type ImageEvidencePayload } from '../src/kb/evidence-resources.js';
import { DEFAULT_EVIDENCE_BUDGET_BYTES } from '../src/types/agent-knowledge.js';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function release(root: string, releaseId: string, buildId: string, baseReleaseId: string | null, evidenceFiles?: Array<{ path: string; bytes: number }>): void {
  const dir = path.join(root, 'releases', releaseId);
  fs.mkdirSync(dir, { recursive: true });
  const index = Buffer.from(`${JSON.stringify({ evidenceFiles })}\n`);
  if (evidenceFiles) fs.writeFileSync(path.join(dir, 'evidence-resources.json'), index);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2, releaseId, buildId, baseReleaseId, publishedAt: new Date().toISOString(),
    mode: 'incremental', model: null, docs: [], sourceSnapshot: [],
    organization: { path: 'knowledge.json', schemaVersion: 1, hash: 'sha256:fixture', coverageMode: 'managed' },
    ...(evidenceFiles ? { evidence: { resourcesPath: 'evidence-resources.json', hash: `sha256:${crypto.createHash('sha256').update(index).digest('hex')}` } } : {}),
  }));
}

describe('incremental evidence budget', () => {
  it('counts the origin release once across progressive stages and deduplicates shared image paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-evidence-budget-'));
    roots.push(root);
    release(root, 'origin', 'previous-build', null, [
      { path: 'evidence/one.bin', bytes: 18 * 1024 * 1024 },
      { path: 'evidence/one.bin', bytes: 18 * 1024 * 1024 },
      { path: 'evidence/two.bin', bytes: 200 },
    ]);
    release(root, 'stage1', 'current-build', 'origin');
    release(root, 'stage2', 'current-build', 'stage1');
    const input = { outputRoot: root, baseReleaseId: 'stage2', buildId: 'current-build', mode: 'incremental' as const };
    expect(evidenceBudgetForPublication({ ...input, config: {} })).toBe(18 * 1024 * 1024 + 200 + DEFAULT_EVIDENCE_BUDGET_BYTES);
    expect(evidenceBudgetForPublication({ ...input, config: { evidenceBudgetBytes: 1024 * 1024 } })).toBe(1024 * 1024);
    expect(evidenceBudgetForPublication({ ...input, mode: 'full', config: {} })).toBe(DEFAULT_EVIDENCE_BUDGET_BYTES);
  });

  it('charges identical image bytes once while retaining both resource IDs', () => {
    const bytes = Buffer.from('same image bytes');
    const imageHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const payloads = new Map<string, ImageEvidencePayload>();
    for (const resourceId of ['source-a#image:diagram', 'source-b#image:diagram']) {
      payloads.set(resourceId, {
        src: 'diagram', bytes,
        resource: { kind: 'image', resourceId, sourceId: resourceId.split('#')[0],
          sourceSnapshotHash: 'snapshot', resourceHash: imageHash, imageHash, caption: 'A diagram' },
      });
    }
    const evidence = [...payloads.keys()].map((resourceId, index) => ({
      evidenceId: `e${index}`, sourceRef: { sourceId: resourceId.split('#')[0], resourceId },
      selector: { kind: 'media_region' },
    })) as unknown as Parameters<typeof planReleaseEvidenceFiles>[0]['evidence'];
    const plan = planReleaseEvidenceFiles({ evidence, workbookPayloads: new Map(), imagePayloads: payloads });
    expect(plan.files).toHaveLength(2);
    expect(new Set(plan.files.map((file) => file.path)).size).toBe(1);
    expect(plan.totalBytes).toBe(bytes.length);
  });
});
