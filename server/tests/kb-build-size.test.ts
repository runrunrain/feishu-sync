import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateStagingDocs } from '../src/kb/kb-build-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import type { BuildRunState } from '../src/agent/agent-tool-service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(count = 1, attachment = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-size-')); roots.push(root);
  const raw = path.join(root, 'raw'), stagingRoot = path.join(root, 'stage');
  fs.mkdirSync(raw); fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  if (attachment) fs.writeFileSync(path.join(raw, 'data.csv'), attachment);
  const csvs = () => attachment ? ['data.csv'] : [];
  const entries = Array.from({ length: count }, (_, i) => {
    const relPath = `${i}.md`; fs.writeFileSync(path.join(raw, relPath), '# 图示\n![](diagram.png)\n');
    return { objToken: `tok${i}`, objType: 'docx', title: '图示', relPath,
      contentHash: computeSourceHash(path.join(raw, relPath), csvs(), raw), objEditTime: null };
  });
  const snapshot = RawSourceSnapshot.fromEntries(entries, { sheetCsvPaths: csvs });
  const state: BuildRunState = { knowledgeBaseRoot: raw, snapshot, mode: 'full', stagingRoot,
    workset: new Map(entries.map((source) => [source.objToken, 'rebuild'])), finishInfo: { summary: '完成', skipped: [] } };
  const write = (body: string, name = '规则.md') => fs.writeFileSync(path.join(stagingRoot, 'docs', name),
    `<!--\nfeishu_sync_kb:\n  doc_id: kd_test\n  sources:\n${entries.map((entry) => `    - ${entry.objToken}`).join('\n')}\n  build_id: b_size\n-->\n${body}`);
  return { state, write, issues: () => validateStagingDocs(state, snapshot) };
}

it.each([1, 2])('allows structured content from %i short sources without charging generated headers', (count) => {
  const f = fixture(count); f.write('a'.repeat(4096 * count));
  expect(f.issues()).toEqual([]);
});

it.each(['described', 'cached'] as const)('counts %s vision text instead of comparing only the tiny image Markdown', (state) => {
  const f = fixture();
  f.state.imageDescriptions = new Map([['tok0', new Map([['diagram.png', { src: 'diagram.png', imageHash: 'fixture', state, text: '图中信息'.repeat(200) }]])]]);
  f.write('知识正文'.repeat(500)); // 6000 bytes: over the small-source floor, supported by vision text.
  expect(f.issues()).toEqual([]);
});

it('counts CSV companions and whiteboard text, without double counting vision or unavailable text', () => {
  const f = fixture(1, '1,2,3\n'.repeat(600)); f.write('a'.repeat(10000));
  expect(f.issues()).toEqual([]);
  const g = fixture(); g.write('a'.repeat(6000));
  g.state.whiteboardTexts = new Map([['tok0', new Map([['diagram.png', { origin: 'svg', text: '图中文字'.repeat(200), truncated: false }]])]]);
  expect(g.issues()).toEqual([]);
  g.state.whiteboardTexts.get('tok0')!.get('diagram.png')!.text = '短说明';
  g.state.imageDescriptions = new Map([['tok0', new Map([['diagram.png', { src: 'diagram.png', imageHash: 'fixture', state: 'described', text: '重复描述'.repeat(200) }]])]]);
  expect(g.issues().map((issue) => issue.code)).toContain('total_too_large');
  g.state.whiteboardTexts.clear();
  g.state.imageDescriptions.get('tok0')!.get('diagram.png')!.state = 'unavailable';
  expect(g.issues().map((issue) => issue.code)).toContain('total_too_large');
});

it('still blocks genuine expansion, splitting to inflate the floor, and files above 1 MiB', () => {
  const f = fixture(); f.write('a'.repeat(4097));
  expect(f.issues().map((issue) => issue.code)).toContain('total_too_large');
  f.write('a'.repeat(2500)); f.write('a'.repeat(2500), '另一篇.md');
  expect(f.issues().map((issue) => issue.code)).toContain('total_too_large');
  f.write('a'.repeat(1024 * 1024 + 1));
  expect(f.issues().map((issue) => issue.code)).toContain('file_too_large');
});

it('refuses changed source content instead of letting it inflate the budget', () => {
  const f = fixture(); f.write('a'.repeat(6000));
  fs.appendFileSync(path.join(f.state.knowledgeBaseRoot, '0.md'), 'expanded'.repeat(2000));
  expect(f.issues).toThrow(/构建期间被修改/);
});
