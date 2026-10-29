/**
 * P0-S7 白板旁路文字单测（设计 P0 §5.4 抽取 / §5.5 svgHash 四象限 /
 * §5.6 构建与会话消费 + P0-S1 双源裁定：svg 主 + raw 降级）
 *
 * 覆盖：SVG 抽取器（真实 P0-S1 样本、实体、script/style/注释/CDATA 跳过、
 * 嵌套 tspan、foreignObject、顺序、去重、截断、超限）；raw 抽取器
 * （nodes[].text.text + connector.captions.data[].text、未知结构宽容）；
 * 旁路寻址（svg 优先 raw 降级、围栏、空抽取/超限跳过）；whiteboardTextHash；
 * 四象限变更判定；enrich/verify；inlineImageBlocks 白板块；raw_read 内联；
 * vision 跳过（describeWorksetImages 过滤）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeWhiteboardTextHash,
  collectWhiteboardTextsForEntries,
  enrichEntriesWithMedia,
  enrichEntriesWithWhiteboardTextHash,
  extractWhiteboardBypassTexts,
  extractWhiteboardRawText,
  extractWhiteboardSvgText,
  inlineImageBlocks,
  resolveWhiteboardBypassRefs,
  verifyEntryWhiteboardTextHash,
  WHITEBOARD_INPUT_MAX_BYTES,
} from '../src/kb/source-images.js';
import { computeChangeset, effectiveWords, KbBuildService, verifySnapshotIntact } from '../src/kb/kb-build-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { ImageDescription } from '../src/agent/vision/vision-describer.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'p0s1-lark-cli');

let kbRoot: string;
let dataRoot: string;

beforeAll(() => {
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtext-kb-'));
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtext-data-'));
});
afterAll(() => {
  fs.rmSync(kbRoot, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const full = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const TINY_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-fixture'),
]);

// ---------------------------------------------------------------------------
// §5.4 SVG 抽取器
// ---------------------------------------------------------------------------

describe('extractWhiteboardSvgText', () => {
  it('真实 P0-S1 样本：甲/乙节点两行，无截断', () => {
    const svg = fs.readFileSync(path.join(FIXTURES, 'whiteboard-min-sample.wb.svg'), 'utf-8');
    const result = extractWhiteboardSvgText(svg);
    expect(result.text.split('\n')).toEqual(['甲节点', '乙节点']);
    expect(result.truncated).toBe(false);
  });

  it('实体解码：预定义实体 + 十/十六进制数字引用；未知实体原样保留', () => {
    const svg = '<svg><text>A &amp; B &lt;x&gt; &quot;q&quot; &apos;a&apos; &#20013;&#x6587; &nbsp;</text></svg>';
    expect(extractWhiteboardSvgText(svg).text).toBe('A & B <x> "q" \'a\' 中文 &nbsp;');
  });

  it('script/style/注释/CDATA 内容跳过', () => {
    const svg = [
      '<svg><script>var s="脚本文字"</script>',
      '<style>.a { content: "样式文字" }</style>',
      '<!-- 注释文字 -->',
      '<![CDATA[ CDATA 文字 ]]>',
      '<text>正文</text>',
      '<style>text { fill: red }</style>',
      '<text>后文</text></svg>',
    ].join('');
    expect(extractWhiteboardSvgText(svg).text.split('\n')).toEqual(['正文', '后文']);
  });

  it('嵌套 tspan 并入同一行；foreignObject 单独成行；保持文档顺序', () => {
    const svg = '<svg><g><text>甲<tspan>乙</tspan>丙</text></g>'
      + '<foreignObject><div>卡片文字</div></foreignObject>'
      + '<text>丁</text></svg>';
    expect(extractWhiteboardSvgText(svg).text.split('\n')).toEqual(['甲乙丙', '卡片文字', '丁']);
  });

  it('相邻重复行去重；非相邻保留；空白归一', () => {
    const svg = '<svg><text> 同 </text><text>同</text><text>多   空\t白 </text><text>同</text></svg>';
    expect(extractWhiteboardSvgText(svg).text.split('\n')).toEqual(['同', '多 空 白', '同']);
  });

  it('maxChars 截断：整行丢弃并置 truncated', () => {
    const svg = '<svg><text>AAAA</text><text>BBBB</text><text>CCCC</text></svg>';
    const result = extractWhiteboardSvgText(svg, { maxChars: 9 });
    expect(result).toEqual({ text: 'AAAA\nBBBB', truncated: true });
  });

  it('输入超 8 MiB → 空（不可用）', () => {
    const oversize = `<svg><text>${'x'.repeat(WHITEBOARD_INPUT_MAX_BYTES)}</text></svg>`;
    expect(extractWhiteboardSvgText(oversize)).toEqual({ text: '', truncated: false });
  });

  it('空输入 / 无文本节点 → 空', () => {
    expect(extractWhiteboardSvgText('')).toEqual({ text: '', truncated: false });
    expect(extractWhiteboardSvgText('<svg><path d="M 0 0"/></svg>').text).toBe('');
  });

  it('未闭合标签有界终止（尾段兜底成行）', () => {
    expect(extractWhiteboardSvgText('<svg><text>尾巴文字').text).toBe('尾巴文字');
  });
});

// ---------------------------------------------------------------------------
// §5.4 raw 抽取器（P0-S1 验证路径）
// ---------------------------------------------------------------------------

describe('extractWhiteboardRawText', () => {
  it('真实 P0-S1 raw 样本：形状文字 + 连线标注，保持节点顺序', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'whiteboard-export-raw-nodes.json'), 'utf-8');
    expect(extractWhiteboardRawText(raw).text.split('\n')).toEqual([
      '否',
      '检测链下一轮',
      '是',
      '同步引擎 SyncEngine',
      '原子提交成功?',
      '推进 synced 基线',
      '保留 blocker 不推进',
    ]);
  });

  it('未知结构宽容（不抛错，返回空）', () => {
    expect(extractWhiteboardRawText('not json').text).toBe('');
    expect(extractWhiteboardRawText('').text).toBe('');
    expect(extractWhiteboardRawText('{}').text).toBe('');
    expect(extractWhiteboardRawText('{"nodes": {}}').text).toBe('');
    expect(extractWhiteboardRawText(null).text).toBe('');
    expect(extractWhiteboardRawText(undefined).text).toBe('');
    expect(extractWhiteboardRawText(42).text).toBe('');
  });

  it('字段类型不符跳过；对象输入同样工作', () => {
    const parsed = {
      nodes: [
        42,
        null,
        { text: { text: '形状' } },
        { text: { text: 3 } },
        { section: { title: '节标题' } },
        { connector: { captions: { data: [{ text: '连线' }, { text: null }, '垃圾'] } } },
      ],
    };
    expect(extractWhiteboardRawText(parsed).text.split('\n')).toEqual(['形状', '连线']);
    expect(extractWhiteboardRawText(JSON.stringify(parsed)).text).toBe('形状\n连线');
  });

  it('截断同 SVG 口径', () => {
    const parsed = { nodes: [{ text: { text: 'AAAA' } }, { text: { text: 'BBBB' } }] };
    expect(extractWhiteboardRawText(parsed, { maxChars: 4 })).toEqual({ text: 'AAAA', truncated: true });
  });
});

// ---------------------------------------------------------------------------
// §5.2 旁路寻址 + §5.4 抽取消费
// ---------------------------------------------------------------------------

describe('resolveWhiteboardBypassRefs / extractWhiteboardBypassTexts', () => {
  it('缺失旁路文件时不误读重复源目录下的同名文件', () => {
    write('nested/nested/images/missing.wb.svg', '<svg><text>无关文档</text></svg>');
    expect(resolveWhiteboardBypassRefs(kbRoot, 'nested/doc.md', '![白板](images/missing.png)')).toEqual([]);
  });
  it('svg 优先、raw 降级、无旁路无条目、越界引用跳过', () => {
    write('wb/文档.md', [
      '![飞书白板](images/01-t.png)',
      '![](images/02-u.png)',
      '![](images/03-v.png)',
      '![](../逃逸.png)',
      '![](images/01-t.png)',
    ].join('\n'));
    write('wb/images/01-t.png', TINY_PNG);
    write('wb/images/01-t.wb.svg', '<svg><text>甲</text><text>乙</text></svg>');
    write('wb/images/01-t.wb.raw.json', '{"nodes":[{"text":{"text":"raw备胎"}}]}');
    write('wb/images/02-u.png', TINY_PNG);
    write('wb/images/02-u.wb.raw.json', '{"nodes":[{"text":{"text":"降级文字"}}]}');
    write('wb/images/03-v.png', TINY_PNG);

    const refs = resolveWhiteboardBypassRefs(kbRoot, 'wb/文档.md', fs.readFileSync(path.join(kbRoot, 'wb/文档.md'), 'utf-8'));
    expect(refs.map((ref) => [ref.src, ref.origin])).toEqual([
      ['images/01-t.png', 'svg'],
      ['images/02-u.png', 'raw'],
    ]);

    const texts = extractWhiteboardBypassTexts(kbRoot, 'wb/文档.md', refsRawMd('wb/文档.md'));
    expect(texts.map((item) => [item.src, item.origin, item.text])).toEqual([
      ['images/01-t.png', 'svg', '甲\n乙'],
      ['images/02-u.png', 'raw', '降级文字'],
    ]);
  });

  it('空抽取与超 8 MiB 旁路跳过（降级语义，不进 hash）', () => {
    write('wb/空板.md', '![](images/04-w.png)\n![](images/05-big.png)');
    write('wb/images/04-w.png', TINY_PNG);
    write('wb/images/04-w.wb.svg', '<svg><path d="M 0 0 L 9 9"/></svg>');
    write('wb/images/05-big.png', TINY_PNG);
    write('wb/images/05-big.wb.svg', Buffer.concat([
      Buffer.from('<svg><text>'), Buffer.alloc(WHITEBOARD_INPUT_MAX_BYTES + 1, 0x78), Buffer.from('</text></svg>'),
    ]));
    expect(extractWhiteboardBypassTexts(kbRoot, 'wb/空板.md', refsRawMd('wb/空板.md'))).toEqual([]);
  });

  function refsRawMd(rel: string): string {
    return fs.readFileSync(path.join(kbRoot, rel), 'utf-8');
  }
});

// ---------------------------------------------------------------------------
// §5.4/§5.5 whiteboardTextHash + 快照 additive
// ---------------------------------------------------------------------------

describe('computeWhiteboardTextHash', () => {
  const base = [{ src: 'images/01-t.png', origin: 'svg' as const, text: '甲\n乙' }];
  it('空 → 空串；内容稳定', () => {
    expect(computeWhiteboardTextHash([])).toBe('');
    expect(computeWhiteboardTextHash(base)).toBe(computeWhiteboardTextHash([...base]));
    expect(computeWhiteboardTextHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('text / origin / src 任一变化 → hash 变', () => {
    expect(computeWhiteboardTextHash([{ src: 'images/01-t.png', origin: 'svg', text: '甲' }]))
      .not.toBe(computeWhiteboardTextHash(base));
    expect(computeWhiteboardTextHash([{ src: 'images/01-t.png', origin: 'raw', text: '甲\n乙' }]))
      .not.toBe(computeWhiteboardTextHash(base));
    expect(computeWhiteboardTextHash([{ src: 'images/02.png', origin: 'svg', text: '甲\n乙' }]))
      .not.toBe(computeWhiteboardTextHash(base));
  });
});

describe('enrichEntriesWithMedia / verifyEntryWhiteboardTextHash', () => {
  it('enrich 写入 whiteboardTextHash；旁路不进 mediaHash；复核随旁路文字变化', () => {
    write('hash/板.md', '![](images/01-h.png)');
    write('hash/images/01-h.png', TINY_PNG);
    write('hash/images/01-h.wb.svg', '<svg><text>版本一</text></svg>');
    const entry: RawSourceSnapshotEntry = {
      objToken: 'tokWB', objType: 'docx', title: '板', relPath: 'hash/板.md',
      contentHash: 'sha256:x', objEditTime: null,
    };
    enrichEntriesWithMedia(kbRoot, [entry]);
    expect(entry.whiteboardTextHash).toMatch(/^sha256:/);
    const hashBefore = entry.whiteboardTextHash;
    const mediaHashBefore = entry.mediaHash;

    // 旁路文件变化：whiteboardTextHash 变、mediaHash 不变（旁路不进图片哈希）
    write('hash/images/01-h.wb.svg', '<svg><text>版本二</text></svg>');
    enrichEntriesWithMedia(kbRoot, [entry]);
    expect(entry.whiteboardTextHash).not.toBe(hashBefore);
    expect(entry.mediaHash).toBe(mediaHashBefore);
    expect(verifyEntryWhiteboardTextHash(kbRoot, entry)).toBe(true);

    // 快照后再改旁路 → 复核失败（构建期间变更语义）
    write('hash/images/01-h.wb.svg', '<svg><text>版本三</text></svg>');
    expect(verifyEntryWhiteboardTextHash(kbRoot, entry)).toBe(false);
  });

  it('旧快照无 whiteboardTextHash → 复核恒真（additive 兼容）', () => {
    write('hash/旧.md', '无白板正文');
    const entry: RawSourceSnapshotEntry = {
      objToken: 'tokOld', objType: 'docx', title: '旧', relPath: 'hash/旧.md',
      contentHash: 'sha256:x', objEditTime: null,
    };
    enrichEntriesWithMedia(kbRoot, [entry]);
    expect(entry.whiteboardTextHash).toBe('');
    const legacy: RawSourceSnapshotEntry = { ...entry, whiteboardTextHash: undefined };
    delete (legacy as { whiteboardTextHash?: string }).whiteboardTextHash;
    expect(verifyEntryWhiteboardTextHash(kbRoot, legacy)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §5.5 四象限变更判定
// ---------------------------------------------------------------------------

describe('computeChangeset whiteboardTextHash 四象限', () => {
  const token = 'tokQ';
  const H = 'sha256:same-content';
  function quad(baseWb: string | undefined, curWb: string): string[] {
    const current = [{ objToken: token, objType: 'docx', title: 'q', relPath: 'q.md', contentHash: H, objEditTime: null, whiteboardTextHash: curWb } as RawSourceSnapshotEntry];
    const baseEntry = { objToken: token, objType: 'docx', title: 'q', relPath: 'q.md', contentHash: H, objEditTime: null } as RawSourceSnapshotEntry;
    if (baseWb !== undefined) baseEntry.whiteboardTextHash = baseWb;
    return computeChangeset(current, { sourceSnapshot: [baseEntry] } as never).changed;
  }

  it('旧缺失 × 新空 → 不变（升级不触发全量 changed）', () => {
    expect(quad(undefined, '')).toEqual([]);
  });
  it('旧缺失 × 新非空 → changed（首获旁路文字只重建一次）', () => {
    expect(quad(undefined, 'sha256:abc')).toEqual([token]);
  });
  it('旧空 × 新空 → 不变；旧空 × 新非空 → changed', () => {
    expect(quad('', '')).toEqual([]);
    expect(quad('', 'sha256:abc')).toEqual([token]);
  });
  it('旧非空 × 新同 → 不变；新异 → changed', () => {
    expect(quad('sha256:abc', 'sha256:abc')).toEqual([]);
    expect(quad('sha256:abc', 'sha256:def')).toEqual([token]);
  });
  it('旧非空 × 新空 → changed（旁路文字消失，内容变化语义）', () => {
    expect(quad('sha256:abc', '')).toEqual([token]);
  });
  it('不依赖 visionEnabled（vision 关闭同样生效）', () => {
    const current = [{ objToken: token, objType: 'docx', title: 'q', relPath: 'q.md', contentHash: H, objEditTime: null, whiteboardTextHash: 'sha256:new' } as RawSourceSnapshotEntry];
    const base = { sourceSnapshot: [{ objToken: token, objType: 'docx', title: 'q', relPath: 'q.md', contentHash: H, objEditTime: null, whiteboardTextHash: 'sha256:old' } as RawSourceSnapshotEntry] } as never;
    expect(computeChangeset(current, base, { visionEnabled: false }).changed).toEqual([token]);
  });
});

// ---------------------------------------------------------------------------
// §5.6 inlineImageBlocks 白板块 + effectiveWords
// ---------------------------------------------------------------------------

describe('inlineImageBlocks 白板文字块', () => {
  const md = '# 文\n![飞书白板](images/01-t.png)\n中间\n![](images/02-n.png)\n';
  const refs = [
    { src: 'images/01-t.png', file: '/dev/null/1' },
    { src: 'images/02-n.png', file: '/dev/null/2' },
  ];

  it('whiteboard_text 先于 image_description；转义与 truncated 属性', () => {
    const out = inlineImageBlocks(md, refs, () => ({ src: 'x', state: 'described', text: '描述' }),
      (src) => src === 'images/01-t.png'
        ? { origin: 'svg', text: '文字 <含> "引号" & 符号', truncated: false }
        : undefined);
    const wbIndex = out.indexOf('<whiteboard_text src="images/01-t.png" origin="svg" truncated="false">');
    const descIndex = out.indexOf('<image_description src="images/01-t.png"');
    expect(wbIndex).toBeGreaterThan(out.indexOf('![飞书白板](images/01-t.png)'));
    expect(descIndex).toBeGreaterThan(wbIndex);
    expect(out).toContain('文字 &lt;含&gt; &quot;引号&quot; &amp; 符号');
    expect(out).toContain('</whiteboard_text>');
  });

  it('旁路命中时 resolve 返回 undefined → 不插该图描述；空文字不插白板块', () => {
    const out = inlineImageBlocks(md, refs, (src) => src === 'images/01-t.png' ? undefined : { src, state: 'described', text: '描述' },
      (src) => src === 'images/01-t.png' ? { origin: 'raw', text: '', truncated: false } : undefined);
    expect(out).not.toContain('whiteboard_text');
    expect(out).not.toContain('<image_description src="images/01-t.png"');
    expect(out).toContain('<image_description src="images/02-n.png"');
  });
});

describe('effectiveWords 计入白板旁路文字', () => {
  it('whiteboardTexts 计入有效字数', () => {
    const base = effectiveWords({ content: '正文四个字' });
    expect(base).toBeGreaterThan(0);
    const withWb = effectiveWords({ content: '正文四个字', whiteboardTexts: [{ text: '甲节点 乙节点' }] });
    expect(withWb).toBeGreaterThan(base);
    expect(effectiveWords({ content: null, whiteboardTexts: [{ text: '只有白板' }] })).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §5.6 raw_read 内联（构建态 + 会话态）
// ---------------------------------------------------------------------------

const WB_TOKEN = 'tokWBRaw';

function setupRawReadFixture(): void {
  write('raw/白板文档.md', '# 白板文档\n![飞书白板](images/01-r.png)\n\n![普通图](images/02-r.png)\n');
  write('raw/images/01-r.png', TINY_PNG);
  write('raw/images/01-r.wb.svg', '<svg><text>白板内中文节点</text></svg>');
  write('raw/images/02-r.png', TINY_PNG);
}

function docRecord(token: string, rel: string): DocumentRecord {
  return {
    objToken: token,
    objType: 'docx',
    title: token,
    wikiNodeToken: null,
    localRelPath: rel,
    localMdPath: path.join(kbRoot, rel),
    lastSyncedModifyTime: '',
    lastSyncedAt: new Date().toISOString(),
    status: 'synced',
  } as DocumentRecord;
}

describe('raw_read 内联（构建态）', () => {
  it('白板引用后内联 whiteboard_text 且不插该图描述；普通图描述照常', async () => {
    setupRawReadFixture();
    const mdRel = 'raw/白板文档.md';
    const snapshot = RawSourceSnapshot.fromEntries([{
      objToken: WB_TOKEN, objType: 'docx', title: '白板文档', relPath: mdRel,
      contentHash: computeSourceHash(path.join(kbRoot, mdRel), []), objEditTime: null,
    }], { knowledgeBaseRoot: kbRoot });
    const whiteboardTexts = collectWhiteboardTextsForEntries(kbRoot, snapshot.entries);
    expect(whiteboardTexts.has(WB_TOKEN)).toBe(true);
    const imageDescriptions = new Map([
      [WB_TOKEN, new Map<string, ImageDescription>([
        ['images/01-r.png', { src: 'images/01-r.png', imageHash: 'h', state: 'described', text: '白板识图描述（应被跳过）' }],
        ['images/02-r.png', { src: 'images/02-r.png', imageHash: 'h2', state: 'described', text: '普通图描述' }],
      ])],
    ]);
    const stagingRoot = path.join(dataRoot, 'staging-rawread');
    fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
    const toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    const { token } = toolService.createRunContext({
      runKind: 'build', buildId: 'b_wb_rawread',
      outputRoot: path.join(dataRoot, 'out-rawread'),
      knowledgeBaseRoot: kbRoot,
      buildState: {
        knowledgeBaseRoot: kbRoot, snapshot, mode: 'incremental',
        workset: new Map([[WB_TOKEN, 'added']]), stagingRoot, finishInfo: null,
        imageDescriptions, visionReady: true, whiteboardTexts,
      },
    });
    const result = await toolService.executeTool(token, 'raw_read', { objToken: WB_TOKEN });
    const text = result.content[0]!.text;
    const wbIndex = text.indexOf('<whiteboard_text src="images/01-r.png" origin="svg" truncated="false">');
    expect(wbIndex).toBeGreaterThan(text.indexOf('![飞书白板](images/01-r.png)'));
    expect(text).toContain('白板内中文节点');
    expect(text).toContain('</whiteboard_text>');
    expect(text).not.toContain('whiteboard_text src="images/01-r.png" origin="svg" truncated="false">\n</whiteboard_text>');
    // 旁路命中 → 该图不插描述（省额度语义）
    expect(text).not.toContain('<image_description src="images/01-r.png"');
    expect(text).not.toContain('白板识图描述（应被跳过）');
    // 普通图照常
    expect(text).toContain('<image_description src="images/02-r.png" state="described">');
    expect(text).toContain('普通图描述');
  });
});

describe('raw_read 内联（会话态）', () => {
  it('vision 未配置：仍内联 whiteboard_text，不插任何 image_description', async () => {
    setupRawReadFixture();
    const toolService = new AgentToolService({ dataRoot, documentsProvider: () => [docRecord(WB_TOKEN, 'raw/白板文档.md')] });
    const { token } = toolService.createRunContext({
      runKind: 'discuss', outputRoot: path.join(dataRoot, 'out-sess'),
      knowledgeBaseRoot: kbRoot,
    });
    const result = await toolService.executeTool(token, 'raw_read', { objToken: WB_TOKEN });
    const text = result.content[0]!.text;
    expect(text).toContain('<whiteboard_text src="images/01-r.png" origin="svg"');
    expect(text).toContain('白板内中文节点');
    expect(text).not.toContain('<image_description');
  });

  it('vision 就绪：旁路命中图跳过描述查询，普通图走缓存', async () => {
    const lookedUp: string[] = [];
    const visionDescriber = {
      status: async () => ({ state: 'ready' as const, model: 'fake', message: '' }),
      lookup: async (imageHash: string) => {
        lookedUp.push(imageHash);
        return '缓存描述';
      },
      describeOne: async (): Promise<ImageDescription> => {
        throw new Error('不应触发按需描述');
      },
      describeMany: async (): Promise<Map<string, ImageDescription>> => new Map(),
    };
    const toolService = new AgentToolService({
      dataRoot,
      documentsProvider: () => [docRecord(WB_TOKEN, 'raw/白板文档.md')],
      visionDescriber,
    });
    const { token } = toolService.createRunContext({
      runKind: 'discuss', outputRoot: path.join(dataRoot, 'out-sess2'),
      knowledgeBaseRoot: kbRoot,
    });
    const result = await toolService.executeTool(token, 'raw_read', { objToken: WB_TOKEN });
    const text = result.content[0]!.text;
    expect(text).toContain('<whiteboard_text src="images/01-r.png" origin="svg"');
    expect(text).toContain('缓存描述'); // 普通图命中缓存
    expect(text).not.toContain('<image_description src="images/01-r.png"');
    expect(lookedUp).toHaveLength(1); // 白板图未做描述查询
  });
});

// ---------------------------------------------------------------------------
// 任务 4：vision 跳过断言（preflight describeWorksetImages 过滤）
// ---------------------------------------------------------------------------

describe('describeWorksetImages 白板旁路跳过 vision', () => {
  it('旁路文字命中的白板不进 describeMany（省额度）；普通图照常', async () => {
    write('skip/白板.md', '![飞书白板](images/01-s.png)\n![](images/02-s.png)\n');
    write('skip/images/01-s.png', TINY_PNG);
    write('skip/images/01-s.wb.svg', '<svg><text>跳过识图的文字</text></svg>');
    write('skip/images/02-s.png', TINY_PNG);
    const mdRel = 'skip/白板.md';
    const snapshot = RawSourceSnapshot.fromEntries([{
      objToken: 'tokSkip', objType: 'docx', title: '白板', relPath: mdRel,
      contentHash: computeSourceHash(path.join(kbRoot, mdRel), []), objEditTime: null,
    }], { knowledgeBaseRoot: kbRoot });
    const buildState = {
      knowledgeBaseRoot: kbRoot, snapshot, mode: 'incremental' as const,
      workset: new Map([['tokSkip', 'added' as const]]),
      stagingRoot: path.join(dataRoot, 'staging-skip'), finishInfo: null,
    };
    buildState.whiteboardTexts = collectWhiteboardTextsForEntries(kbRoot, snapshot.entries);

    const described: string[] = [];
    const describer = {
      status: async () => ({ state: 'ready' as const, model: 'fake', message: '' }),
      lookup: async () => null,
      describeOne: async (): Promise<ImageDescription> => ({ src: '', imageHash: '', state: 'unavailable', reason: 'vision_failed' }),
      describeMany: async (items: Array<{ file: string; src: string }>) => {
        for (const item of items) described.push(item.src);
        const map = new Map<string, ImageDescription>();
        for (const item of items) {
          map.set(item.src, { src: item.src, imageHash: `h:${item.src}`, state: 'described', text: `描述:${item.src}` });
        }
        return map;
      },
    };
    const service = new KbBuildService({
      dataRoot,
      pool: new AgentProcessPool({ maxConcurrentProcesses: 1 }),
      toolService: new AgentToolService({ dataRoot, documentsProvider: () => [] }),
      resolver: new PiRuntimeResolver(),
      configProvider: () => null,
      documentsProvider: () => [],
      sheetCsvPaths: () => [],
      internalBaseUrl: () => 'http://127.0.0.1:39999',
      extensionPath: () => null,
      promptAssets: () => null,
      visionDescriber: describer,
    });
    const entry = {
      buildState,
      images: { total: 0, described: 0, cached: 0, unavailable: 0 },
    } as never;
    const result = await (service as unknown as {
      describeWorksetImages(input: {
        buildId: string;
        entry: never;
        snapshot: RawSourceSnapshot;
        workset: Map<string, 'added'>;
        describer: typeof describer;
        visionReady: boolean;
        signal: AbortSignal;
      }): Promise<Map<string, Map<string, ImageDescription>>>;
    }).describeWorksetImages({
      buildId: 'b_skip', entry, snapshot,
      workset: buildState.workset, describer, visionReady: true,
      signal: new AbortController().signal,
    });

    expect(described).toEqual(['tokSkip::images/02-s.png']);
    const bucket = result.get('tokSkip')!;
    expect(bucket.get('images/01-s.png')).toBeUndefined(); // 白板不产生描述条目
    expect(bucket.get('images/02-s.png')?.state).toBe('described');
  });
});

// ---------------------------------------------------------------------------
// 发布前复核：旁路文字构建期间变更
// ---------------------------------------------------------------------------

describe('verifySnapshotIntact 旁路文字复核', () => {
  it('构建期间旁路文字被改 → source_changed_during_build', () => {
    write('verify/板.md', '![飞书白板](images/01-v.png)');
    write('verify/images/01-v.png', TINY_PNG);
    write('verify/images/01-v.wb.svg', '<svg><text>快照时文字</text></svg>');
    const mdRel = 'verify/板.md';
    const entry: RawSourceSnapshotEntry = {
      objToken: 'tokVerify', objType: 'docx', title: '板', relPath: mdRel,
      contentHash: computeSourceHash(path.join(kbRoot, mdRel), []), objEditTime: null,
    };
    enrichEntriesWithMedia(kbRoot, [entry]);
    const snapshot = RawSourceSnapshot.fromEntries([entry], { knowledgeBaseRoot: kbRoot });
    expect(() => verifySnapshotIntact(snapshot, kbRoot, () => [])).not.toThrow();
    write('verify/images/01-v.wb.svg', '<svg><text>构建中被改</text></svg>');
    expect(() => verifySnapshotIntact(snapshot, kbRoot, () => [])).toThrow(/白板旁路文字/);
  });
});

// ---------------------------------------------------------------------------
// /api/kb/status 预览兼容（compareSources 先补算 whiteboardTextHash）
// ---------------------------------------------------------------------------

describe('status 预览：scan 条目补算后不虚报 changed', () => {
  it('未补算的当前条目与非空 manifest 恒差；enrichEntriesWithWhiteboardTextHash 后一致', () => {
    write('status/板.md', '![飞书白板](images/01-st.png)');
    write('status/images/01-st.png', TINY_PNG);
    write('status/images/01-st.wb.svg', '<svg><text>状态预览文字</text></svg>');
    const mdRel = 'status/板.md';
    const enriched: RawSourceSnapshotEntry = {
      objToken: 'tokStatus', objType: 'docx', title: '板', relPath: mdRel,
      contentHash: computeSourceHash(path.join(kbRoot, mdRel), []), objEditTime: null,
    };
    enrichEntriesWithMedia(kbRoot, [enriched]);
    expect(enriched.whiteboardTextHash).not.toBe('');

    // scan 形态的当前条目（无 whiteboardTextHash）→ 虚报 changed（修复动机）
    const scanLike: RawSourceSnapshotEntry = { ...enriched, whiteboardTextHash: undefined };
    delete (scanLike as { whiteboardTextHash?: string }).whiteboardTextHash;
    const base = { sourceSnapshot: [enriched] } as never;
    expect(computeChangeset([scanLike], base).changed).toEqual(['tokStatus']);

    // 补算（compareSources 现行为）→ 一致
    enrichEntriesWithWhiteboardTextHash(kbRoot, [scanLike]);
    expect(scanLike.whiteboardTextHash).toBe(enriched.whiteboardTextHash);
    expect(computeChangeset([scanLike], base).changed).toEqual([]);
  });
});
