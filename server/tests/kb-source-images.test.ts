/**
 * source-images 单测（S3 §3.3/§3.4：图片枚举、mediaHash、内联块）
 *
 * 覆盖：引用提取（![]()/<img>/<image>、忽略 http/data、去重）、围栏解析
 * （越界丢弃、缺失保留）、mediaHash（字节变化敏感、src 序无关、无图 null）、
 * enrichEntriesWithMedia、inlineImageBlocks（described/cached/unavailable、
 * 首次出现处、转义）、verifyEntryMediaHash。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeMediaHash,
  enrichEntriesWithMedia,
  extractImageRefs,
  inlineImageBlocks,
  resolveSourceImages,
  verifyEntryMediaHash,
} from '../src/kb/source-images.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let kbRoot: string;

beforeAll(() => {
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbimg-'));
});
afterAll(() => {
  fs.rmSync(kbRoot, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const full = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// 1×1 PNG（最小合法头 + IHDR/IDAT/IEND，供 magic bytes 嗅探与哈希）
const TINY_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-padding-fixture'),
]);

describe('extractImageRefs', () => {
  it('markdown 图片 / <img src> / <image token>；忽略 http(s)/data/锚点/绝对路径；去重保序', () => {
    const md = [
      '![](images/01-a)',
      '![白板](images/02-b "标题")',
      '<img src="images/03-c" />',
      '<image token="images/04-d"></image>',
      '普通链接 [附件](attachments/x.csv) 不算图片',
      '![远端](https://feishu.cn/file/t.png) 与 ![数据](data:image/png;base64,xx) 忽略',
      '![](images/01-a)',
    ].join('\n');
    expect(extractImageRefs(md)).toEqual(['images/01-a', 'images/02-b', 'images/03-c', 'images/04-d']);
  });
});

describe('resolveSourceImages', () => {
  it('相对源目录解析；缺失文件保留条目；越界引用丢弃', () => {
    write('目录/文档.md', '正文');
    write('目录/images/01-a.png', TINY_PNG);
    const md = '![](images/01-a.png)\n![](images/缺失.png)\n![](../../etc/passwd)';
    const refs = resolveSourceImages(kbRoot, '目录/文档.md', md);
    const srcs = refs.map((ref) => ref.src);
    expect(srcs).toEqual(['images/01-a.png', 'images/缺失.png']);
    expect(refs[0].file).toBe(fs.realpathSync.native(path.join(kbRoot, '目录/images/01-a.png')));
    expect(fs.existsSync(refs[1].file)).toBe(false); // 缺失保留（missing_file 语义）
  });
});

describe('computeMediaHash', () => {
  it('无图 null；字节变化敏感；src 顺序无关（按 src 排序）', () => {
    write('a/images/1.png', TINY_PNG);
    write('a/images/2.png', Buffer.concat([TINY_PNG, Buffer.from('more')]));
    const refs = (md: string) => resolveSourceImages(kbRoot, 'a/x.md', md);
    const one = computeMediaHash(refs('![](images/1.png)'));
    expect(one).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeMediaHash(refs('![](images/1.png)\n![](images/2.png)'))).not.toBe(one);
    // 顺序无关
    expect(computeMediaHash(refs('![](images/1.png)\n![](images/2.png)')))
      .toBe(computeMediaHash(refs('![](images/2.png)\n![](images/1.png)')));
    // 同名不同字节 → hash 变
    write('a/images/1.png', Buffer.concat([TINY_PNG, Buffer.from('changed')]));
    expect(computeMediaHash(refs('![](images/1.png)'))).not.toBe(one);
  });
});

describe('enrichEntriesWithMedia / verifyEntryMediaHash', () => {
  it('mediaHash/imageCount 写入条目；图片替换后复核失败', () => {
    write('enrich/文档.md', '# 文档\n![](images/e1.png)');
    write('enrich/images/e1.png', TINY_PNG);
    const entry: RawSourceSnapshotEntry = {
      objToken: 'tokE', objType: 'docx', title: '文档', relPath: 'enrich/文档.md',
      contentHash: 'sha256:x', objEditTime: null,
    };
    const { totalImages } = enrichEntriesWithMedia(kbRoot, [entry]);
    expect(totalImages).toBe(1);
    expect(entry.imageCount).toBe(1);
    expect(entry.mediaHash).toMatch(/^sha256:/);
    expect(verifyEntryMediaHash(kbRoot, entry)).toBe(true);
    write('enrich/images/e1.png', Buffer.concat([TINY_PNG, Buffer.from('replaced')]));
    expect(verifyEntryMediaHash(kbRoot, entry)).toBe(false);
    write('enrich/images/e1.png', TINY_PNG);
    expect(verifyEntryMediaHash(kbRoot, entry)).toBe(true);
  });

  it('无 mediaHash 的条目复核恒真（旧 manifest 兼容）', () => {
    const entry: RawSourceSnapshotEntry = {
      objToken: 't', objType: 'docx', title: 't', relPath: '不存在.md',
      contentHash: 'h', objEditTime: null,
    };
    expect(verifyEntryMediaHash(kbRoot, entry)).toBe(true);
  });
});

describe('inlineImageBlocks', () => {
  it('described 带文本；unavailable 自闭合带 reason；每 src 首次出现处插入；文本转义', () => {
    const md = '前一行\n![](images/1.png) 与 <img src="images/2.png">\n中间\n再次 ![](images/1.png)\n尾部';
    const refs = [
      { src: 'images/1.png', file: '/dev/null/1' },
      { src: 'images/2.png', file: '/dev/null/2' },
    ];
    const out = inlineImageBlocks(md, refs, (src) => {
      if (src === 'images/1.png') return { src, state: 'described', text: '图中有 <危险> "引号" 与 & 符号' };
      return { src, state: 'unavailable', reason: 'vision_unconfigured' };
    });
    // 首次出现行的下一行起是描述块
    expect(out).toContain('![](images/1.png) 与 <img src="images/2.png">\n<image_description src="images/1.png" state="described">');
    expect(out).toContain('\n图中有 &lt;危险&gt; &quot;引号&quot; 与 &amp; 符号\n</image_description>');
    expect(out).toContain('<image_description src="images/2.png" state="unavailable" reason="vision_unconfigured"/>');
    // 第二次出现不重复插入；尾部仍在末尾
    expect(out.match(/<image_description/g)).toHaveLength(2);
    expect(out.endsWith('尾部')).toBe(true);
  });
});
