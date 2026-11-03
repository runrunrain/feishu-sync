import fs from 'node:fs';
import path from 'node:path';
import { parseCsvRecords } from './evidence-locator.js';
import { resolveInside } from '../agent/path-guard.js';
import type { CoverageItem } from './knowledge-schema.js';
import type { RawSourceSnapshot } from './raw-source-snapshot.js';

/** A blank workbook tab is a source placeholder, not an unread important rule.
 * Only reconcile a coverage item when the named tab exists, its CSV has no
 * nonempty cells, and the reconstructed Markdown tab has no inline content. */
export function reconcileBlankCsvCoverage(
  coverage: CoverageItem[], snapshot: RawSourceSnapshot, knowledgeBaseRoot: string,
): number {
  const bySource = new Map<string, ReturnType<RawSourceSnapshot['readVerified']>>();
  let changed = 0;
  for (const item of coverage) {
    if (item.disposition !== 'unresolved' || item.targetObjectIds.length > 0) continue;
    const sourceId = item.sourceRef.sourceId;
    if (!snapshot.get(sourceId)) continue;
    let verified = bySource.get(sourceId);
    if (!verified) {
      verified = snapshot.readVerified(knowledgeBaseRoot, sourceId);
      bySource.set(sourceId, verified);
    }
    const labels = [item.category, ...[...((item.reason ?? '').matchAll(/子表「([^」]+)」/g))].map((match) => match[1]!)];
    for (const label of labels) {
      const filename = label.endsWith('.csv') ? label : `${label}.csv`;
      const section = verified.content.match(new RegExp(`^## 子表: ${escapeRegExp(label.replace(/\.csv$/, ''))}\\s*$([\\s\\S]*?)(?=^## 子表: |$(?![\\s\\S]))`, 'm'))?.[1];
      if (section === undefined) continue;
      const attachment = verified.attachments.find((entry) => path.basename(entry.path) === filename)
        ?? readLinkedCsv(section, verified.realPath, filename, knowledgeBaseRoot);
      if (!attachment) continue;
      const records = parseCsvRecords(attachment.content).records;
      if (records.some((record) => record.some((cell) => cell.trim().length > 0))) continue;
      const inline = section.replace(/^\[CSV 原始数据\]\([^\n]+\)\s*$/gm, '').replace(/^---\s*$/gm, '').trim();
      if (inline) continue;
      item.disposition = 'excluded_template';
      item.reason = `源子表「${label.replace(/\.csv$/, '')}」及其 CSV 均为空，属于待回填占位；本次无可转换知识，来源填充后需重新构建。`;
      changed += 1;
      break;
    }
  }
  return changed;
}

function readLinkedCsv(section: string, sourcePath: string | undefined, filename: string, root: string): { path: string; content: string } | null {
  if (!sourcePath) return null;
  const href = section.match(/^\[CSV 原始数据\]\(([^\n)]+)\)\s*$/m)?.[1];
  if (!href) return null;
  try {
    const decoded = decodeURIComponent(href);
    const expectedDir = `${path.basename(sourcePath, '.md')}.csv-data`;
    if (path.basename(decoded) !== filename || path.basename(path.dirname(decoded)) !== expectedDir) return null;
    const candidate = path.resolve(path.dirname(sourcePath), decoded);
    const safe = resolveInside(root, path.relative(root, candidate), 'read');
    return { path: safe, content: fs.readFileSync(safe, 'utf8') };
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
