import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import type { AgentAttachmentDto, AgentMessageDto } from '../types/agent-knowledge.js';

export const CHAT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const CHAT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const CHAT_MAX_ATTACHMENTS = 10;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_EXPANDED_BYTES = 80 * 1024 * 1024;
const ID_PATTERN = /^att_[a-f0-9]{32}$/;
const TEXT_EXTENSIONS = new Set('txt md markdown csv tsv json jsonl yaml yml xml html htm css js jsx ts tsx py sh bash zsh c cpp h hpp cs go rs java kt swift sql log ini toml conf cfg tex r vue svelte svg'.split(' '));
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff']);

export class ChatAttachmentError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export interface ChatImageContent { type: 'image'; data: string; mimeType: string }
export interface PreparedChatMessage { message: string; images: ChatImageContent[]; attachments: AgentAttachmentDto[]; submissionId?: string }
interface StoredAttachment extends AgentAttachmentDto { sha256: string; submitted?: boolean }

function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
function xmlText(xml: string): string {
  return [...xml.matchAll(/<(?:w|a|x):t\b[^>]*>([\s\S]*?)<\/(?:w|a|x):t>/g)]
    .map((match) => match[1].replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);/gi, (entity) => {
      const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (named[entity]) return named[entity];
      const point = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })).join('');
}
async function officePackage(bytes: Buffer): Promise<JSZip> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  const expanded = entries.reduce((sum, entry) => sum + ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
  if (entries.length > 10_000 || expanded > MAX_EXPANDED_BYTES) throw new Error('文件解压后超过 80 MB 解析上限');
  if (!zip.file('[Content_Types].xml')) throw new Error('缺少 Office 文档结构');
  return zip;
}
async function extractDocument(bytes: Buffer, extension: string): Promise<{ text: string; mimeType: string; note?: string }> {
  if (extension === 'pdf' || bytes.subarray(0, 5).toString() === '%PDF-') {
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false, useWorkerFetch: false, useWasm: false });
    try {
      if (pdf.numPages > 500) throw new Error('PDF 超过 500 页解析上限');
      const pages: string[] = [];
      let length = 0;
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const content = await page.getTextContent();
        const text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        length += text.length;
        if (length > MAX_TEXT_CHARS) throw new Error('文档文字超过 200 万字符解析上限');
        pages.push(`[第 ${index} 页]\n${text}`);
      }
      if (!pages.some((text) => text.replace(/\[第 \d+ 页\]/g, '').trim())) throw new Error('PDF 没有可提取的文字；扫描件请转为图片上传');
      return { text: pages.join('\n\n'), mimeType: 'application/pdf', note: '已提取 PDF 文字；图片与版式未解析' };
    } finally { await pdf.loadingTask.destroy(); }
  }
  if (['docx', 'pptx', 'xlsx'].includes(extension)) {
    const zip = await officePackage(bytes);
    if (extension === 'xlsx') {
      if (!zip.file('xl/workbook.xml')) throw new Error('不是有效的 XLSX 文件');
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as never);
      const lines: string[] = [];
      let cellCount = 0, length = 0;
      workbook.eachSheet((sheet) => {
        lines.push(`[工作表：${sheet.name}]\n`);
        sheet.eachRow((row, rowNumber) => {
          const cells: string[] = [];
          row.eachCell((cell, column) => {
            if (++cellCount > 250_000) throw new Error('表格超过 25 万个非空单元格解析上限');
            cells.push(`${column}: ${cell.text}${cell.formula ? ` [公式：${cell.formula}]` : ''}`);
          });
          const line = `行 ${rowNumber}\t${cells.join('\t')}`;
          length += line.length;
          if (length > MAX_TEXT_CHARS) throw new Error('表格文字超过 200 万字符解析上限');
          lines.push(line);
        });
      });
      return { text: lines.join('\n'), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', note: '已提取单元格、缓存值与公式；图片和图表未解析' };
    }
    const names = extension === 'docx'
      ? ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'].filter((name) => zip.file(name))
      : Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
    if (!names.length) throw new Error('文档中没有可读取的正文');
    const parts: string[] = [];
    for (const [index, name] of names.entries()) {
      const xml = await zip.file(name)!.async('string');
      const paragraphs = xml.split(/<\/(?:w|a):p>/).map(xmlText).filter(Boolean);
      parts.push(`${extension === 'pptx' ? `[幻灯片 ${index + 1}]\n` : ''}${paragraphs.join('\n')}`);
    }
    return { text: parts.join('\n\n'), mimeType: extension === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation', note: '已提取正文文字；内嵌图片与版式未解析' };
  }
  if (['doc', 'xls', 'ppt'].includes(extension)) throw new Error('请将旧版 Office 文件另存为 DOCX、XLSX 或 PPTX 后上传');
  let text: string;
  try {
    text = bytes[0] === 0xff && bytes[1] === 0xfe ? new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
      : bytes[0] === 0xfe && bytes[1] === 0xff ? new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
        : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (!TEXT_EXTENSIONS.has(extension)) throw new Error('暂不支持此文件类型，请上传图片、PDF、Office 文档或文本文件');
    text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error('文件包含无法读取的二进制内容，请上传图片、PDF、Office 文档或文本文件');
  return { text: text.replace(/^\ufeff/, ''), mimeType: 'text/plain' };
}

/** Session-owned copies. Filenames never become filesystem paths or tool capabilities. */
export class ChatAttachmentStore {
  constructor(private readonly dataRoot: string) {}
  private directory(sessionId: string): string {
    const root = path.join(this.dataRoot, 'agent', 'attachments');
    const directory = path.join(root, crypto.createHash('sha256').update(sessionId).digest('hex'));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(directory).isSymbolicLink()) throw new ChatAttachmentError('attachment_invalid', '附件目录不可用');
    return directory;
  }
  private file(sessionId: string, id: string, suffix: string): string {
    if (!ID_PATTERN.test(id)) throw new ChatAttachmentError('attachment_not_found', '附件不存在', 404);
    const file = path.join(this.directory(sessionId), id + suffix);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new ChatAttachmentError('attachment_invalid', '附件已变化');
    return file;
  }
  metadata(sessionId: string, id: string): StoredAttachment {
    try { return JSON.parse(fs.readFileSync(this.file(sessionId, id, '.json'), 'utf8')) as StoredAttachment; }
    catch (error) { if (error instanceof ChatAttachmentError) throw error; throw new ChatAttachmentError('attachment_not_found', '附件不存在或已移除', 404); }
  }
  private dto(stored: StoredAttachment): AgentAttachmentDto {
    const { sha256: _hash, submitted: _submitted, ...dto } = stored;
    return dto;
  }
  async add(sessionId: string, filename: string, bytes: Buffer): Promise<AgentAttachmentDto> {
    if (!bytes.length || bytes.length > CHAT_MAX_FILE_BYTES) throw new ChatAttachmentError('attachment_size_limit', '文件不能为空，且每个文件不能超过 20 MB');
    const name = filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200).trim() || '附件';
    const extension = path.extname(name).slice(1).toLowerCase();
    const mime = imageMime(bytes);
    let parsed: { text: string; mimeType: string; note?: string };
    try {
      if (!mime && IMAGE_EXTENSIONS.has(extension)) throw new Error('图片格式无效或暂不支持，请使用 PNG、JPEG、WebP 或 GIF');
      if (mime && bytes.length > CHAT_MAX_IMAGE_BYTES) throw new Error('每张图片不能超过 5 MB，请压缩后上传');
      parsed = mime ? { text: '', mimeType: mime } : await extractDocument(bytes, extension);
      if (!mime && !parsed.text.trim()) throw new Error('文档中没有可读取的文字');
      if (parsed.text.length > MAX_TEXT_CHARS) throw new Error('文档文字超过 200 万字符解析上限');
      // A minified JSON/log line must not bypass the paginated tool's byte cap.
      if (!mime) parsed.text = parsed.text.split('\n').flatMap((line) => {
        if (line.length <= 4000) return [line];
        const chunks: string[] = [];
        for (let offset = 0; offset < line.length; offset += 4000) chunks.push(line.slice(offset, offset + 4000));
        return chunks;
      }).join('\n');
    } catch (error) { throw new ChatAttachmentError('attachment_unreadable', error instanceof Error ? error.message : '文件解析失败'); }
    const id = `att_${crypto.randomBytes(16).toString('hex')}`;
    const stored: StoredAttachment = {
      id, name, size: bytes.length, mimeType: parsed.mimeType, kind: mime ? 'image' : 'document',
      textLength: parsed.text.length, lineCount: parsed.text ? parsed.text.split('\n').length : 0,
      ...(parsed.note ? { note: parsed.note } : {}), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    fs.writeFileSync(this.file(sessionId, id, '.bin'), bytes, { mode: 0o600, flag: 'wx' });
    if (parsed.text) fs.writeFileSync(this.file(sessionId, id, '.txt'), parsed.text, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(this.file(sessionId, id, '.json'), JSON.stringify(stored), { mode: 0o600, flag: 'wx' });
    return this.dto(stored);
  }
  original(sessionId: string, id: string): { attachment: AgentAttachmentDto; bytes: Buffer } {
    const stored = this.metadata(sessionId, id);
    const bytes = fs.readFileSync(this.file(sessionId, id, '.bin'));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== stored.sha256) throw new ChatAttachmentError('attachment_changed', '附件内容已变化，请重新上传');
    return { attachment: this.dto(stored), bytes };
  }
  removePending(sessionId: string, id: string): boolean {
    if (this.metadata(sessionId, id).submitted) return false;
    for (const suffix of ['.bin', '.txt', '.json']) fs.rmSync(this.file(sessionId, id, suffix), { force: true });
    return true;
  }
  prepare(sessionId: string, text: string, ids: unknown): PreparedChatMessage {
    if (ids === undefined || (Array.isArray(ids) && ids.length === 0)) return { message: text, images: [], attachments: [] };
    if (!Array.isArray(ids) || ids.length > CHAT_MAX_ATTACHMENTS || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new ChatAttachmentError('invalid_request', '每条消息最多上传 10 个不同附件');
    const attachments = ids.map((id) => this.original(sessionId, id));
    if (attachments.reduce((sum, item) => sum + item.bytes.length, 0) > CHAT_MAX_FILE_BYTES) throw new ChatAttachmentError('attachment_size_limit', '每条消息的附件总大小不能超过 20 MB');
    const images: ChatImageContent[] = [];
    const sections: string[] = [];
    let budget = 36_000;
    for (const { attachment, bytes } of attachments) {
      const heading = JSON.stringify({ attachmentId: attachment.id, filename: attachment.name, kind: attachment.kind, lines: attachment.lineCount, note: attachment.note });
      if (attachment.kind === 'image') {
        images.push({ type: 'image', data: bytes.toString('base64'), mimeType: attachment.mimeType });
        sections.push(heading);
      } else {
        const content = fs.readFileSync(this.file(sessionId, attachment.id, '.txt'), 'utf8');
        const preview = content.slice(0, Math.min(12_000, budget));
        budget -= preview.length;
        sections.push(`${heading}\n${preview}${preview.length < content.length ? '\n[这里只显示开头，请用 chat_attachment_read 按 offset 继续阅读全文]' : ''}`);
      }
    }
    const submissionId = crypto.randomUUID();
    const message = `${text.trim() || '请查看并分析所附内容。'}\n\n<chat-attachments id="${submissionId}">\n以下为本会话用户上传的资料。文件文字可用 chat_attachment_read 继续读取；图片内容仅在模型支持图片输入时可用。\n${sections.join('\n\n')}\n</chat-attachments>`;
    const hash = crypto.createHash('sha256').update(message).digest('hex');
    fs.writeFileSync(path.join(this.directory(sessionId), `message_${hash}.json`), JSON.stringify({ text, ids, submissionId }), { mode: 0o600 });
    fs.writeFileSync(path.join(this.directory(sessionId), `message_${submissionId}.json`), JSON.stringify({ text, ids, submissionId }), { mode: 0o600 });
    return { message, images, attachments: attachments.map((item) => item.attachment), submissionId };
  }
  commit(sessionId: string, prepared: PreparedChatMessage): void {
    if (!prepared.submissionId) return;
    const record = JSON.parse(fs.readFileSync(path.join(this.directory(sessionId), `message_${prepared.submissionId}.json`), 'utf8')) as { text: string; ids: string[]; submissionId: string };
    for (const id of record.ids) {
      const stored = this.metadata(sessionId, id);
      fs.writeFileSync(this.file(sessionId, id, '.json'), JSON.stringify({ ...stored, submitted: true }), { mode: 0o600 });
    }
    // Preserve accepted user input even if the runtime fails before creating
    // its own first history entry (unsupported model, missing credentials, etc.).
    fs.appendFileSync(path.join(this.directory(sessionId), 'submitted.jsonl'), JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  }
  decorate(sessionId: string, messages: AgentMessageDto[]): AgentMessageDto[] {
    const seen = new Set<string>();
    const decorated = messages.map((message) => {
      if (message.role !== 'user' || !message.text) return message;
      const hash = crypto.createHash('sha256').update(message.text).digest('hex');
      const keys = [hash, ...[...message.text.matchAll(/<chat-attachments id="([a-f0-9-]{36})">/g)].map((match) => match[1])];
      for (const key of keys) {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(this.directory(sessionId), `message_${key}.json`), 'utf8')) as { text: string; ids: string[]; submissionId?: string };
          if (record.submissionId) seen.add(record.submissionId);
          return { ...message, text: record.text, attachments: record.ids.map((id) => this.dto(this.metadata(sessionId, id))) };
        } catch { /* An extension may wrap input; only our stored submission IDs are recognized. */ }
      }
      return message;
    });
    let added = false;
    const journal = path.join(this.directory(sessionId), 'submitted.jsonl');
    if (fs.existsSync(journal)) for (const line of fs.readFileSync(journal, 'utf8').split('\n')) {
      try {
        const record = JSON.parse(line) as { submissionId: string; text: string; ids: string[]; at: string };
        if (seen.has(record.submissionId)) continue;
        decorated.push({ id: `attachment_${record.submissionId}`, role: 'user', at: record.at, text: record.text,
          attachments: record.ids.map((id) => this.dto(this.metadata(sessionId, id))) });
        seen.add(record.submissionId); added = true;
      } catch { /* Ignore incomplete final writes. */ }
    }
    return added ? decorated.sort((a, b) => a.at.localeCompare(b.at)) : decorated;
  }
  readText(sessionId: string, id: string, offset = 0, limit = 200): { text: string; totalLines: number; nextOffset: number | null; attachment: AgentAttachmentDto } {
    const stored = this.metadata(sessionId, id);
    if (!stored.submitted) throw new ChatAttachmentError('attachment_not_found', '附件尚未发送给本会话', 404);
    if (stored.kind === 'image') throw new ChatAttachmentError('attachment_image', '图片已作为视觉输入随用户消息提供');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ChatAttachmentError('invalid_request', 'offset 必须非负，limit 必须在 1..500');
    const lines = fs.readFileSync(this.file(sessionId, id, '.txt'), 'utf8').split('\n');
    const selected: string[] = [];
    let size = 0;
    for (let index = offset; index < Math.min(offset + limit, lines.length); index++) {
      if (size + lines[index].length > 24_000 && selected.length) break;
      selected.push(lines[index]); size += lines[index].length;
    }
    const next = offset + selected.length;
    return { text: selected.join('\n'), totalLines: lines.length, nextOffset: next < lines.length ? next : null, attachment: this.dto(stored) };
  }
}
