import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { ChatAttachmentStore, CHAT_MAX_FILE_BYTES } from '../src/agent/chat-attachments.js';
import { agentRoutes } from '../src/routes/agent.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attachments-'));
const store = new ChatAttachmentStore(root);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC', 'base64');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

export function textPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 30 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

describe('chat attachments', () => {
  it('keeps copies isolated by session, binds messages to attachments, and restores clean history', async () => {
    const file = await store.add('s-one', '../设计.md', Buffer.from('技能设计\n验证口令：FILE_7542\n第三行'));
    expect(file.name).toBe('设计.md');
    expect(() => store.readText('s-one', file.id)).toThrow('尚未发送');
    expect(() => store.original('s-other', file.id)).toThrow('附件不存在');
    const sent = store.prepare('s-one', '分析附件', [file.id]);
    store.commit('s-one', sent);
    expect(sent.message).toContain('FILE_7542');
    expect(sent.images).toEqual([]);
    const restored = new ChatAttachmentStore(root).decorate('s-one', [{ id: 'm1', role: 'user', at: new Date().toISOString(), text: sent.message }]);
    expect(restored[0]).toMatchObject({ text: '分析附件', attachments: [file] });
    expect(restored).toHaveLength(1);
    expect(store.decorate('s-one', [])[0]).toMatchObject({ text: '分析附件', attachments: [file] });
    expect(store.decorate('s-one', [{ id: 'wrapped', role: 'user', at: '', text: `插件附加上下文\n${sent.message}\n后续上下文` }])[0]).toMatchObject({ text: '分析附件', attachments: [file] });
    expect(store.removePending('s-one', file.id)).toBe(false);
    expect(store.readText('s-one', file.id, 1, 1)).toMatchObject({ text: '验证口令：FILE_7542', nextOffset: 2 });
    expect(() => store.prepare('s-one', 'x', [file.id, file.id])).toThrow('不同附件');
  });

  it('passes genuine images as multimodal content and removes unsent copies', async () => {
    const file = await store.add('s-image', '图.png', png);
    const sent = store.prepare('s-image', '', [file.id]);
    store.commit('s-image', sent);
    expect(sent.images).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
    expect(file.kind).toBe('image');
    const pending = await store.add('s-image', '待移除.txt', Buffer.from('pending'));
    expect(store.removePending('s-image', pending.id)).toBe(true);
    expect(() => store.original('s-image', pending.id)).toThrow();
    await expect(store.add('s-image', '伪造.png', Buffer.from('not an image'))).rejects.toThrow('图片格式无效');
    await expect(store.add('s-image', 'large.txt', Buffer.alloc(CHAT_MAX_FILE_BYTES + 1))).rejects.toThrow('20 MB');
  });

  it('reads documents through the existing session tool without losing long lines or exposing other sessions', async () => {
    const content = 'a'.repeat(50_000) + 'END_MARKER';
    const file = await store.add('s-long', 'large.json', Buffer.from(content));
    const sent = store.prepare('s-long', 'find the end', [file.id]);
    store.commit('s-long', sent);
    expect(sent.message).not.toContain('END_MARKER');
    expect(sent.message).toContain('chat_attachment_read');
    const tools = new AgentToolService({ dataRoot: root, documentsProvider: () => [] });
    const own = tools.createRunContext({ runKind: 'discuss', sessionId: 's-long', knowledgeBaseRoot: root, outputRoot: root }).token;
    const other = tools.createRunContext({ runKind: 'discuss', sessionId: 's-other', knowledgeBaseRoot: root, outputRoot: root }).token;
    const page = await tools.executeTool(own, 'chat_attachment_read', { attachmentId: file.id, offset: 12, limit: 1 });
    expect(page.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('END_MARKER') });
    await expect(tools.executeTool(other, 'chat_attachment_read', { attachmentId: file.id })).rejects.toMatchObject({ code: 'attachment_not_found' });
    expect(tools.createRunContext({ runKind: 'build', knowledgeBaseRoot: root, outputRoot: root }).context.allowedTools).not.toContain('chat_attachment_read');
  });

  it('extracts PDF, Word, PowerPoint and Excel text with type-specific boundaries', async () => {
    const pdf = await store.add('s-formats', 'report.pdf', textPdf('PDF_MARKER_8347'));
    store.commit('s-formats', store.prepare('s-formats', 'read', [pdf.id]));
    expect(store.readText('s-formats', pdf.id).text).toContain('PDF_MARKER_8347');
    for (const extension of ['docx', 'pptx']) {
      const zip = new JSZip(); zip.file('[Content_Types].xml', '<Types/>');
      zip.file(extension === 'docx' ? 'word/document.xml' : 'ppt/slides/slide1.xml',
        extension === 'docx' ? '<w:document><w:p><w:r><w:t>正文 &amp; WORD_MARKER</w:t></w:r></w:p></w:document>' : '<p:sld><a:p><a:r><a:t>SLIDE_MARKER</a:t></a:r></a:p></p:sld>');
      const file = await store.add('s-formats', `example.${extension}`, await zip.generateAsync({ type: 'nodebuffer' }));
      store.commit('s-formats', store.prepare('s-formats', '', [file.id]));
      expect(store.readText('s-formats', file.id).text).toContain(extension === 'docx' ? '正文 & WORD_MARKER' : 'SLIDE_MARKER');
    }
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('伤害表');
    sheet.addRow(['伤害', 300]); sheet.getCell('C1').value = { formula: 'B1*2', result: 600 };
    const xlsx = await store.add('s-formats', 'data.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
    store.commit('s-formats', store.prepare('s-formats', '', [xlsx.id]));
    expect(store.readText('s-formats', xlsx.id).text).toContain('[工作表：伤害表]');
    expect(store.readText('s-formats', xlsx.id).text).toContain('B1*2');
  });

  it('accepts browser multipart uploads, returns authenticated originals and rejects cross-session references', async () => {
    const routes = await agentRoutes({ sessionService: { attachments: store }, localMapStore: { getAgentSession: (id: string) => ['s-api', 's-api-other'].includes(id) ? { id } : null } } as never);
    const form = new FormData(); form.append('file', new File(['UPLOAD_MARKER'], '说明.txt', { type: 'text/plain' }));
    const uploaded = await routes.request('/api/agent/sessions/s-api/attachments', { method: 'POST', body: form });
    expect(uploaded.status).toBe(201);
    const { attachment } = await uploaded.json();
    const response = await routes.request(`/api/agent/sessions/s-api/attachments/${attachment.id}`);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(await response.text()).toBe('UPLOAD_MARKER');
    expect((await routes.request(`/api/agent/sessions/s-api-other/attachments/${attachment.id}`)).status).toBe(404);
  });
});
