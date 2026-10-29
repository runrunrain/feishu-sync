import fs from 'node:fs';
import path from 'node:path';

export function workbookPathForMarkdown(mdPath: string): string {
  return mdPath.replace(/\.md$/i, '') + '.xlsx';
}

/** Enumerate only workbook files explicitly owned by this text derivative. */
export function managedWorkbookCompanions(mdPath: string): string[] {
  if (!fs.existsSync(mdPath)) return [];
  const header = fs.readFileSync(mdPath, 'utf-8').slice(0, 16_384);
  const marker = /^\s+(?:source_workbook|previous_workbook): ("[^\n]+")\s*$/m.exec(header)?.[1];
  if (!marker) return [];
  try {
    const workbookPath = workbookPathForMarkdown(mdPath);
    if (JSON.parse(marker) !== path.basename(workbookPath)) return [];
    return [workbookPath, `${workbookPath}.metadata.json`];
  } catch { return []; }
}
