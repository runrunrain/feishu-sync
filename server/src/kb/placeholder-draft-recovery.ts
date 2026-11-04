import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeDraftFile } from '../agent/agent-tool-service.js';
import { isBlankWorkbookPlaceholder } from './blank-csv-coverage.js';
import type { RawSourceSnapshot } from './raw-source-snapshot.js';
import { isPermissionDeniedSourcePlaceholder } from './source-availability.js';
import { parseStdHeader } from './standard-kb-store.js';

/** Remove mechanically verified empty/denied sources from recovered drafts.
 * Evidence-backed citations are never changed automatically. The Markdown
 * body remains byte-identical; the new header hash requires a fresh review. */
export function repairPlaceholderDraftSources(input: {
  stagingRoot: string;
  snapshot: RawSourceSnapshot;
  knowledgeBaseRoot: string;
  workset: ReadonlyMap<string, unknown>;
}): Array<{ path: string; removedSources: string[] }> {
  const placeholders = new Set<string>();
  for (const [token] of input.workset) {
    if (!input.snapshot.has(token)) continue;
    const verified = input.snapshot.readVerified(input.knowledgeBaseRoot, token);
    if (isPermissionDeniedSourcePlaceholder(verified.content)
      || (verified.entry.objType === 'sheet' && isBlankWorkbookPlaceholder(verified))) placeholders.add(token);
  }
  if (placeholders.size === 0) return [];

  const draftFile = path.join(input.stagingRoot, 'knowledge-draft.json');
  if (!fs.existsSync(draftFile)) return [];
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8')) as KnowledgeDraftFile;
  const docsRoot = path.join(input.stagingRoot, 'docs');
  const repaired: Array<{ path: string; removedSources: string[] }> = [];
  const visit = (directory: string, prefix: string) => {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      const fullPath = path.join(directory, name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { visit(fullPath, `${prefix}${name}/`); continue; }
      if (!stat.isFile() || !name.endsWith('.md')) continue;
      const docPath = `${prefix}${name}`;
      const content = fs.readFileSync(fullPath, 'utf8');
      const header = parseStdHeader(content);
      if (!header) continue;
      const removedSources = header.sources.filter((token) => placeholders.has(token));
      if (removedSources.length === 0 || removedSources.length === header.sources.length) continue;
      const objectIds = new Set(draft.objects.filter((object) => !object.tombstone && object.canonical?.path === docPath)
        .map((object) => object.objectId));
      if (objectIds.size === 0) continue;
      if (draft.evidence.some((evidence) => objectIds.has(evidence.objectId) && placeholders.has(evidence.sourceRef.sourceId))) continue;
      if (draft.coverage.some((item) => placeholders.has(item.sourceRef.sourceId)
        && item.targetObjectIds.some((objectId) => objectIds.has(objectId)))) continue;

      const retained = header.sources.filter((token) => !placeholders.has(token));
      if (!retained.every((token) => {
        if (!input.snapshot.has(token)) return false;
        const verified = input.snapshot.readVerified(input.knowledgeBaseRoot, token);
        return !isPermissionDeniedSourcePlaceholder(verified.content)
          && !(verified.entry.objType === 'sheet' && isBlankWorkbookPlaceholder(verified));
      })) continue;
      const next = content.replace(/(^ {2}sources:\n)(?: {4}- [^\n]+\n)+/m,
        (_, label: string) => `${label}${retained.map((token) => `    - ${token}\n`).join('')}`);
      if (next === content || parseStdHeader(next)?.sources.join('\0') !== retained.join('\0')) continue;
      const temp = `${fullPath}.placeholder-repair.tmp`;
      fs.writeFileSync(temp, next);
      fs.renameSync(temp, fullPath);
      for (const object of draft.objects) {
        if (object.tombstone || object.canonical?.path !== docPath) continue;
        object.reviewStatus = 'pending';
        delete object.reviewActorKind;
        delete object.reviewerId;
        delete object.reviewedAt;
      }
      repaired.push({ path: docPath, removedSources });
    }
  };
  visit(docsRoot, '');
  if (repaired.length > 0) {
    const temp = `${draftFile}.placeholder-repair.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(draft, null, 2)}\n`);
    fs.renameSync(temp, draftFile);
  }
  return repaired;
}
