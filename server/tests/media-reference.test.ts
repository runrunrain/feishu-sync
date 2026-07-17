import { describe, expect, it } from 'vitest';
import {
  extractFeishuMediaReferences,
  findFeishuMediaReferenceOccurrences,
  isSafeMediaRelativePath,
  rewriteFeishuMediaReferences,
} from '../src/modules/media-reference.js';

const imageToken = 'ImageToken1234567890';
const fileToken = 'FileToken12345678901';
const sourceToken = 'SourceToken123456789';
const boardToken = 'BoardToken1234567890';
const queryToken = 'QueryToken1234567890';
const apiToken = 'ApiToken123456789012';

describe('media-reference parser', () => {
  it('parses the docs +fetch XML media contract and retains filename/span metadata', () => {
    const content = [
      `<image token="${imageToken}" name="cover.png"/>`,
      `<img src='${imageToken}'/>`,
      `<file token="${fileToken}" name="设计说明.pdf"/>`,
      `<source token="${sourceToken}" filename="recording.mp4"/>`,
      `<whiteboard token="${boardToken}"></whiteboard>`,
    ].join('\n');

    const all = findFeishuMediaReferenceOccurrences(content);
    expect(all).toHaveLength(5);
    expect(all.map((reference) => reference.kind)).toEqual([
      'image',
      'image',
      'attachment',
      'attachment',
      'whiteboard',
    ]);
    expect(all.map((reference) => reference.source)).toEqual([
      'xml-image',
      'xml-image',
      'xml-file',
      'xml-source',
      'xml-whiteboard',
    ]);
    expect(all[0]).toMatchObject({
      original: imageToken,
      sourceUrl: null,
      filename: 'cover.png',
    });
    expect(content.slice(all[2].start, all[2].end)).toBe(fileToken);
    expect(all[3].filename).toBe('recording.mp4');

    const unique = extractFeishuMediaReferences(content);
    expect(unique.map((reference) => reference.token)).toEqual([
      imageToken,
      fileToken,
      sourceToken,
      boardToken,
    ]);
    expect(unique[0].filename).toBe('cover.png');
  });

  it('recognizes Markdown images/links and safe known Feishu drive media URL forms', () => {
    const content = [
      `![截图](https://feishu.cn/file/${imageToken}?from=wiki)`,
      `[附件](https://www.feishu.cn/drive/file/${fileToken}?open=1)`,
      `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/?file_token=${queryToken}`,
      `https://open.feishu.cn/open-apis/drive/v1/medias/${apiToken}/download`,
    ].join('\n');

    const references = extractFeishuMediaReferences(content);
    expect(references.map((reference) => [reference.token, reference.kind, reference.source])).toEqual([
      [imageToken, 'image', 'markdown-image'],
      [fileToken, 'attachment', 'markdown-link'],
      [queryToken, 'attachment', 'url'],
      [apiToken, 'attachment', 'url'],
    ]);
    expect(references[0].sourceUrl).toContain('?from=wiki');
    expect(references[1].sourceUrl).toContain('/drive/file/');
  });

  it('rejects non-Feishu, auth-code-only, and malformed tokens instead of guessing them', () => {
    const content = [
      `![external](https://example.com/file/${imageToken})`,
      'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=opaque-auth-code',
      'https://feishu.cn/file/short-token',
      '<file token="../../not-a-token" name="unsafe"/>',
    ].join('\n');

    expect(extractFeishuMediaReferences(content)).toEqual([]);
  });
});

describe('media-reference rewriter', () => {
  it('rewrites every recognized span while preserving markdown/XML wrappers and unknown links', () => {
    const content = [
      `![图](https://feishu.cn/file/${imageToken}?from=wiki)`,
      `[附件](https://feishu.cn/drive/file/${fileToken})`,
      `<whiteboard token="${boardToken}"></whiteboard>`,
      `![外链](https://example.com/file/${sourceToken})`,
      `重复: https://feishu.cn/file/${imageToken}`,
    ].join('\n');

    const rewritten = rewriteFeishuMediaReferences(content, new Map([
      [imageToken, 'images/01-image.png'],
      [fileToken, 'attachments/设计说明.pdf'],
      [boardToken, 'whiteboards/01-board.json'],
      [sourceToken, 'attachments/ignored.bin'],
    ]));

    expect(rewritten).toContain('![图](images/01-image.png)');
    expect(rewritten).toContain('[附件](attachments/设计说明.pdf)');
    expect(rewritten).toContain('<whiteboard token="whiteboards/01-board.json"></whiteboard>');
    expect(rewritten).toContain('![外链](https://example.com/file/' + sourceToken + ')');
    expect(rewritten).toContain('重复: images/01-image.png');
  });

  it('leaves mappings with unsafe local paths unchanged', () => {
    const content = [
      `![图](https://feishu.cn/file/${imageToken})`,
      `[附件](https://feishu.cn/file/${fileToken})`,
      `<file token="${sourceToken}" name="x"/>`,
    ].join('\n');

    const rewritten = rewriteFeishuMediaReferences(content, {
      [imageToken]: '../escape.png',
      [fileToken]: 'https://attacker.example/file',
      [sourceToken]: 'attachments/ok.bin',
    });

    expect(rewritten).toContain(`https://feishu.cn/file/${imageToken}`);
    expect(rewritten).toContain(`https://feishu.cn/file/${fileToken}`);
    expect(rewritten).toContain(`<file token="attachments/ok.bin" name="x"/>`);
  });

  it('accepts only simple local POSIX-relative media paths', () => {
    expect(isSafeMediaRelativePath('images/01-token.png')).toBe(true);
    expect(isSafeMediaRelativePath('attachments/设计说明.pdf')).toBe(true);
    expect(isSafeMediaRelativePath('../escape.png')).toBe(false);
    expect(isSafeMediaRelativePath('/absolute/path.png')).toBe(false);
    expect(isSafeMediaRelativePath('images\\windows.png')).toBe(false);
    expect(isSafeMediaRelativePath('images/%2e%2e/escape.png')).toBe(false);
    expect(isSafeMediaRelativePath('https://example.com/image.png')).toBe(false);
  });
});
