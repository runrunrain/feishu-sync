/**
 * DocumentIR — normalized intermediate representation for Feishu documents.
 * Renderers (profile-aware) consume this; they never parse raw CLI output.
 */

import path from 'node:path';

export type DocumentObjType = 'docx' | 'sheet' | 'slides' | 'unknown';

export interface DocumentImageRef {
  /** Relative path from the markdown file's directory, e.g. images/01.png */
  relativePath: string;
  token?: string;
  sourceUrl?: string;
  sha256?: string;
}

export interface DocumentAttachmentRef {
  relativePath: string;
  name: string;
  token?: string;
  sha256?: string;
}

export interface DocumentSheetRef {
  sheetId: string;
  title: string;
  /** Relative path from markdown dir, e.g. Title.csv-data/主表.csv */
  csvRelativePath: string;
  /** Non-empty CSV text required before commit. */
  csvContent: string;
  sha256?: string;
}

export interface DocumentIR {
  objToken: string;
  wikiNodeToken: string | null;
  spaceId: string | null;
  objType: DocumentObjType;
  title: string;
  originalLink: string | null;
  observedObjEditTime: number | null;
  /** Body markdown without the feishu_sync HTML header. */
  bodyMarkdown: string;
  images: DocumentImageRef[];
  attachments: DocumentAttachmentRef[];
  sheets: DocumentSheetRef[];
}

export interface RenderedDocument {
  markdown: string;
  /** All relative paths that must exist after commit (images, csv, attachments). */
  requiredRelativePaths: string[];
}

/**
 * Render a DocumentIR into canonical markdown for the knowledge base.
 * Sheet bodies get H1 + `## 子表:` sections with CSV relative links.
 */
export function renderDocumentMarkdown(ir: DocumentIR, options?: {
  fetchDate?: string;
}): RenderedDocument {
  const fetchDate = options?.fetchDate ?? new Date().toISOString().slice(0, 10);
  const header = [
    '<!--',
    'feishu_sync:',
    `  obj_token: "${ir.objToken}"`,
    ir.wikiNodeToken ? `  wiki_node_token: "${ir.wikiNodeToken}"` : null,
    ir.spaceId ? `  space_id: "${ir.spaceId}"` : null,
    `  obj_type: "${ir.objType}"`,
    ir.originalLink ? `  original_link: "${ir.originalLink}"` : null,
    `  fetch_date: "${fetchDate}"`,
    ir.observedObjEditTime != null
      ? `  last_synced_modify_time: "${new Date(ir.observedObjEditTime).toISOString()}"`
      : null,
    '-->',
    '',
  ]
    .filter((line) => line != null)
    .join('\n');

  const requiredRelativePaths: string[] = [];
  for (const image of ir.images) requiredRelativePaths.push(image.relativePath);
  for (const attachment of ir.attachments) {
    requiredRelativePaths.push(attachment.relativePath);
  }
  for (const sheet of ir.sheets) requiredRelativePaths.push(sheet.csvRelativePath);

  let body = ir.bodyMarkdown.trim();
  const bodyHasSheetSections = /##\s*子表\s*:/.test(body);
  if ((ir.objType === 'sheet' || ir.sheets.length > 0) && !bodyHasSheetSections) {
    const parts: string[] = [`# ${ir.title}`, ''];
    if (body && !body.startsWith('#')) {
      parts.push(body, '');
    } else if (body) {
      // Drop a leading H1 that duplicates the title.
      const withoutH1 = body.replace(/^#\s+.+\n+/, '');
      if (withoutH1.trim()) parts.push(withoutH1.trim(), '');
    }
    for (const sheet of ir.sheets) {
      parts.push(`## 子表: ${sheet.title}`, '');
      parts.push(`[CSV 原始数据](${sheet.csvRelativePath})`, '');
    }
    body = parts.join('\n').trim() + '\n';
  } else if (!/^#\s+/m.test(body)) {
    body = `# ${ir.title}\n\n${body}\n`;
  } else if (!body.endsWith('\n')) {
    body += '\n';
  }

  return {
    markdown: header + body,
    requiredRelativePaths,
  };
}

/** Fail if any required relative path is missing or empty under baseDir. */
export function validateRenderedResources(
  baseDir: string,
  requiredRelativePaths: string[],
  exists: (absolutePath: string) => boolean,
  readSize: (absolutePath: string) => number,
): string[] {
  const errors: string[] = [];
  for (const relative of requiredRelativePaths) {
    const absolute = path.join(baseDir, ...relative.split('/'));
    if (!exists(absolute)) {
      errors.push(`缺失资源: ${relative}`);
      continue;
    }
    if (readSize(absolute) <= 0) {
      errors.push(`空资源文件: ${relative}`);
    }
  }
  return errors;
}
