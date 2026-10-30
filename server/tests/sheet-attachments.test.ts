import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadWorkbookAttachment, renderWorkbookAttachments } from '../src/modules/sheet-attachments.js';

const dirs: string[] = [];
function temporary() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-attachments-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const source = { sheet: 'Sheet1', cell: 'G31', name: '数据.json', token: 'token', size: 2, mimeType: 'application/json', single: true };

describe('workbook source attachment validation', () => {
  it.each(['truncated', 'wrong-format'])('rejects %s preview artifacts and leaves no published attachment', async (mode) => {
    const dir = temporary();
    const client = {
      downloadMedia: async () => { throw new Error('denied'); },
      previewMedia: async (_token: string, target: string) => { fs.writeFileSync(target, mode === 'truncated' ? '{' : 'xx'); return target; },
    };
    await expect(downloadWorkbookAttachment(client, source, dir)).rejects.toThrow('未完整获取');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not retry an authentication failure using preview', async () => {
    const previewMedia = vi.fn();
    const authError = Object.assign(new Error('authentication expired'), { code: 'auth' });
    await expect(downloadWorkbookAttachment({ downloadMedia: async () => { throw authError; }, previewMedia }, source, temporary())).rejects.toBe(authError);
    expect(previewMedia).not.toHaveBeenCalled();
  });

  it('labels a complete JSON preview with different byte size without claiming original bytes', async () => {
    const dir = temporary();
    const result = await downloadWorkbookAttachment({
      downloadMedia: async () => { throw new Error('denied'); },
      previewMedia: async (_token, target) => { fs.writeFileSync(target, '{"value":1}'); return target; },
    }, { ...source, size: 30 }, dir);
    expect(result).toMatchObject({ sourceSize: 30, size: 11, representation: 'json-preview' });
    expect(result.relativePath).toContain('-preview-');
    expect(renderWorkbookAttachments([result])).toContain('非原件字节副本');
  });

  it('never treats a differently sized binary preview as a complete attachment', async () => {
    const dir = temporary();
    const bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0]);
    await expect(downloadWorkbookAttachment({
      downloadMedia: async () => { throw new Error('denied'); },
      previewMedia: async (_token, target) => { fs.writeFileSync(target, bytes); return target; },
    }, { ...source, size: 100, mimeType: 'video/mp4' }, dir)).rejects.toThrow('附件大小不符');
  });

  it('rejects an API error envelope returned as a JSON preview', async () => {
    await expect(downloadWorkbookAttachment({
      downloadMedia: async () => { throw new Error('denied'); },
      previewMedia: async (_token, target) => { fs.writeFileSync(target, '{"code":403,"msg":"denied"}'); return target; },
    }, source, temporary())).rejects.toThrow('未完整获取');
  });

  it('keeps an exact MP4 preview as a separate companion and escapes its visible label', async () => {
    const bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
    const dir = temporary();
    const result = await downloadWorkbookAttachment({
      downloadMedia: async () => { throw new Error('denied'); },
      previewMedia: async (_token, target) => { fs.writeFileSync(`${target}.mp4`, bytes); return `${target}.mp4`; },
    }, { ...source, name: '../[video](1).mp4', mimeType: 'video/mp4', size: bytes.length }, dir);
    expect(fs.readFileSync(path.join(dir, result.relativePath))).toEqual(bytes);
    expect(result.relativePath.split('/')).toHaveLength(2);
    expect(renderWorkbookAttachments([result])).toContain('\\[video\\]');
    expect(renderWorkbookAttachments([result])).toContain('%281%29');
    expect(fs.readdirSync(dir)).toEqual(['attachments']);
  });
});
