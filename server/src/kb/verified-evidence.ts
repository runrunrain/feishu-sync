import { createHash } from 'node:crypto';
import type { Evidence } from './knowledge-schema.js';

/** Process-local proof key, recorded only after the server verifies and commits
 * a declaration. It is intentionally not accepted from the draft or model. */
export function verifiedEvidenceKey(evidence: Evidence): string {
  return createHash('sha256').update(JSON.stringify([
    evidence.evidenceId, evidence.objectId, evidence.claimKey, evidence.sourceRef,
    evidence.selector, evidence.quoteHash, evidence.role, evidence.nature, evidence.readReceiptId ?? null,
  ])).digest('hex');
}
