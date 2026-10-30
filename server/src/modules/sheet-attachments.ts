/** Preserve sheet attachments as local companions, never as thumbnails. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SheetMediaDownloadClient } from './sheet-media.js';

export interface PendingWorkbookAttachment {
  sheet: string;
  cell: string;
  name: string;
  token: string;
  size: number;
  mimeType?: string;
  single: boolean;
}

export interface WorkbookAttachment {
  sheet: string;
  cell: string;
  name: string;
  token: string;
  size: number;
  relativePath: string;
  sha256: string;
  acquisition: 'download' | 'preview';
  /** JSON source previews may be reserialized by the service. */
  representation: 'source-file' | 'json-preview';
  sourceSize: number;
}

function validatePreview(bytes: Buffer, mimeType?: string) {
  // Preview endpoints can return a thumbnail/transcoded artifact. Accept only
  // recognized source formats, in addition to the exact source size check.
  if (mimeType === 'video/mp4') return bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  if (mimeType === 'application/json') {
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      // A JSON error response is not a JSON attachment, even with HTTP 200.
      if (value && typeof value === 'object' && !Array.isArray(value)
        && ((value.ok === false && value.error != null)
          || (typeof value.code === 'number' && value.code !== 0
            && (typeof value.msg === 'string' || typeof value.message === 'string')))) return false;
      return true;
    } catch { return false; }
  }
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return false;
}

export async function downloadWorkbookAttachment(
  client: SheetMediaDownloadClient, source: PendingWorkbookAttachment, stagingDir: string,
): Promise<WorkbookAttachment> {
  const parent = path.resolve(stagingDir);
  const scratch = fs.mkdtempSync(path.join(parent, '.workbook-attachment-'));
  try {
    if (source.size <= 0 || source.size > 128 * 1024 * 1024) throw new Error('附件大小无效或超过 128 MB 上限');
    let lastError: unknown;
    for (const acquisition of ['download', 'preview'] as const) {
      try {
        const target = path.join(scratch, acquisition);
        const downloaded = acquisition === 'download'
          ? await client.downloadMedia(source.token, target, 'media')
          : await client.previewMedia(source.token, target);
        if (path.dirname(fs.realpathSync(downloaded)) !== fs.realpathSync(scratch)) throw new Error('附件下载路径超出临时目录');
        const stat = fs.statSync(downloaded);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 128 * 1024 * 1024) throw new Error('附件下载为空或超过大小上限');
        const bytes = fs.readFileSync(downloaded);
        if (acquisition === 'preview' && !validatePreview(bytes, source.mimeType)) throw new Error('预览内容不能确认为源附件格式');
        // The authorized SOURCE_FILE preview returns complete JSON documents,
        // but may normalize whitespace/key ordering. Keep the received bytes
        // separately and disclose this representation; never apply this
        // exception to videos, images or a truncated/invalid JSON response.
        const jsonPreview = acquisition === 'preview' && source.mimeType === 'application/json' && stat.size !== source.size;
        if (stat.size !== source.size && !jsonPreview) throw new Error(`附件大小不符，预期 ${source.size} 字节，实际 ${stat.size} 字节`);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        // Content-addressed names prevent overwriting shared or user files.
        const name = source.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(-90) || 'attachment';
        const relativePath = `attachments/${sha256}-${jsonPreview ? 'preview-' : ''}${name}`;
        const destination = path.join(parent, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (fs.existsSync(destination)) {
          if (crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== sha256) throw new Error('本地附件路径冲突');
        } else fs.writeFileSync(destination, bytes, { flag: 'wx' });
        return { sheet: source.sheet, cell: source.cell, name: source.name, token: source.token,
          size: stat.size, sourceSize: source.size, relativePath, sha256, acquisition,
          representation: jsonPreview ? 'json-preview' : 'source-file' };
      } catch (error) {
        if ((error as { code?: string })?.code === 'auth') throw error;
        lastError = error;
      }
    }
    throw new Error(`工作表 ${source.sheet} 单元格 ${source.cell} 的附件“${source.name}”未完整获取：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  } finally {
    if (path.dirname(path.resolve(scratch)) === parent && path.basename(scratch).startsWith('.workbook-attachment-')) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** Expose downloaded companions in the document's normal attachment UI. */
export function renderWorkbookAttachments(attachments: WorkbookAttachment[]): string {
  if (!attachments.length) return '';
  const escape = (text: string) => text.replace(/[\\[\]*_`<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  return '\n\n## 表格附件\n\n' + attachments.map((item) =>
    `- ${escape(item.sheet)} · ${item.cell}：[${escape(item.name)}](${item.relativePath.split('/').map(encodeURIComponent).join('/').replace(/\(/g, '%28').replace(/\)/g, '%29')})${item.representation === 'json-preview' ? '（JSON 预览副本：云端返回大小与原件记录不同，保留返回内容，非原件字节副本）' : ''}`,
  ).join('\n') + '\n';
}
