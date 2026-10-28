/**
 * P1-S4 引用消费测试（设计 §2.4）：
 *  - raw_read 末页 <source_links> 追加（非末页不追加 / 无边不追加 /
 *    未注入引用图不追加 / 30 条截断 / XML 转义 / build 态 in_raw 口径）
 *  - raw_links 工具（out/in/both、200 上限与 truncated、kbDocs 解析、
 *    references_unavailable）
 *  - 工具面：discuss/work/build 三面包含 raw_links；子任务 allowedToolsOverride
 *    交集规则不变（task_ 族与 app_command 永不进子任务面）
 *  - 构建 prompt 含引用段规则（§2.4 用法）
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { toolsForRunKind } from '../src/types/agent-knowledge.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { RawSourceSnapshot } from '../src/kb/raw-source-snapshot.js';
import type { BuildRunState } from '../src/agent/agent-tool-service.js';
import type { DocumentRecord } from '../src/types/index.js';
import type { SourceReferenceInsert } from '../src/modules/local-map-store.js';

let root: string;
let kbRoot: string;
let outputRoot: string;
let store: LocalMapStore;

function docRow(overrides: Partial<DocumentRecord> & { objToken: string }): DocumentRecord {
  return {
    objToken: overrides.objToken,
    wikiNodeToken: overrides.wikiNodeToken ?? `wiki-${overrides.objToken}`,
    objType: 'docx',
    title: overrides.title ?? overrides.objToken,
    localRelPath: overrides.localRelPath ?? null,
    localMdPath: overrides.localRelPath ? path.join(kbRoot, overrides.localRelPath) : '',
    lastSyncedAt: overrides.lastSyncedAt ?? '2026-10-01T00:00:00Z',
    lastSyncedModifyTime: '100',
    status: overrides.status ?? 'synced',
    ...overrides,
  } as DocumentRecord;
}

function edge(targetToken: string, extra: Partial<SourceReferenceInsert> = {}): SourceReferenceInsert {
  return {
    targetToken,
    targetType: extra.targetType ?? 'docx',
    title: extra.title ?? null,
    origin: extra.origin ?? 'body',
    kind: extra.kind ?? 'link',
    occurrences: extra.occurrences ?? 1,
  };
}

function makeService(withLinks = true): AgentToolService {
  return new AgentToolService({
    dataRoot: root,
    documentsProvider: () => store.getAllDocuments(),
    ...(withLinks
      ? {
          sourceLinks: (objToken: string) => {
            const wiki = store.getDocumentByObjToken(objToken)?.wikiNodeToken ?? null;
            const tokens = [objToken, wiki].filter((token): token is string => Boolean(token));
            return {
              out: store.listSourceReferencesBySrc(objToken),
              in: store.listSourceReferencesByTarget(tokens),
            };
          },
        }
      : {}),
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1s4-raw-links-'));
  kbRoot = path.join(root, 'raw');
  outputRoot = path.join(root, 'standard');
  fs.mkdirSync(kbRoot, { recursive: true });
  store = new LocalMapStore(path.join(root, 'db.sqlite'));
  store.initialize();

  // A（本文档）→ B（wiki 链接，已同步）、未知外部文档、C（占位未同步）
  // B → A（obj 链接）；D → A（wiki 链接，验证入边双键并集）
  for (const [token, rel] of [['docA', 'a.md'], ['docB', 'b.md'], ['docD', 'd.md']] as const) {
    fs.writeFileSync(path.join(kbRoot, rel), `<!--\nfeishu_sync:\n  obj_token: ${token}\n  obj_type: docx\n-->\n# ${token}\n正文一行。`);
  }
  const docs = [
    docRow({ objToken: 'docA', wikiNodeToken: 'wikiA', title: 'A 文档', localRelPath: 'a.md' }),
    docRow({ objToken: 'docB', wikiNodeToken: 'wikiB', title: 'B "引用" <目标>', localRelPath: 'b.md' }),
    docRow({ objToken: 'docC', wikiNodeToken: 'wikiC', title: 'C 占位', localRelPath: null, lastSyncedAt: '', status: 'placeholder' }),
    docRow({ objToken: 'docD', wikiNodeToken: 'wikiD', title: 'D 文档', localRelPath: 'd.md' }),
  ];
  for (const doc of docs) store.upsertDocument(doc);
  store.replaceSourceReferences('docA', [
    edge('wikiB', { title: 'B "引用" <目标>', occurrences: 3 }),
    edge('extTokenNotInLib0000', { title: '外部文档', occurrences: 1 }),
    edge('docC', { title: 'C 占位', occurrences: 1 }),
  ]);
  store.replaceSourceReferences('docB', [edge('docA', { occurrences: 2 })]);
  store.replaceSourceReferences('docD', [edge('wikiA', { kind: 'cite', occurrences: 1 })]);
});

afterAll(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('raw_read 末页引用追加（§2.4）', () => {
  it('末页在 </untrusted_source> 之后追加 source_links：出入链、转义、双键入边', async () => {
    const service = makeService();
    const { token } = service.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot });
    const result = await service.executeTool(token, 'raw_read', { objToken: 'docA' });
    const text = result.content[0].text;
    // 整体位于 <untrusted_source> 之外
    const closeIndex = text.indexOf('</untrusted_source>');
    const linksIndex = text.indexOf('<source_links obj_token="docA"');
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(linksIndex).toBeGreaterThan(closeIndex);
    // 出边：wikiB 解析到本地 B 行（标题转义）；外部目标 in_raw=false；C 未同步
    expect(text).toContain('<out target="wikiB" title="B &quot;引用&quot; &lt;目标&gt;" path="b.md" in_raw="true"/>');
    expect(text).toContain('<out target="extTokenNotInLib0000" title="外部文档" in_raw="false"/>');
    expect(text).toContain('<out target="docC" title="C 占位" in_raw="false"/>');
    // 入边：obj 键与 wiki 键两种引用都出现（标题来自解析到的 B 文档行，转义）
    expect(text).toContain('<in source="docB" title="B &quot;引用&quot; &lt;目标&gt;" path="b.md"/>');
    expect(text).toContain('<in source="docD" title="D 文档" path="d.md"/>');
    expect(text.trimEnd().endsWith('</source_links>')).toBe(true);
    expect(result.details).toMatchObject({ sourceLinks: { out: 3, in: 2, outTruncated: false, inTruncated: false } });
  });

  it('非末页不追加（翻页去重）', async () => {
    const service = makeService();
    const { token } = service.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot });
    const result = await service.executeTool(token, 'raw_read', { objToken: 'docA', offset: 0, limit: 2 });
    expect(result.content[0].text).not.toContain('<source_links');
    expect(result.details).not.toHaveProperty('sourceLinks');
  });

  it('无引用边的文档不追加；未注入引用图不追加（输出与旧版一致）', async () => {
    fs.writeFileSync(path.join(kbRoot, 'e1.md'), '# e1\n正文。');
    store.upsertDocument(docRow({ objToken: 'docE1', wikiNodeToken: 'wikiE1', title: 'E1', localRelPath: 'e1.md' }));
    const withLinks = makeService();
    const { token } = withLinks.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot });
    const plain = await withLinks.executeTool(token, 'raw_read', { objToken: 'docE1' });
    expect(plain.content[0].text).not.toContain('<source_links');
    const withoutLinks = makeService(false);
    const { token: bareToken } = withoutLinks.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot });
    const bare = await withoutLinks.executeTool(bareToken, 'raw_read', { objToken: 'docA' });
    expect(bare.content[0].text).not.toContain('<source_links');
  });

  it('出边超过 30 条：截断到 30 并标 out_truncated（kb 属性来自 CURRENT manifest）', async () => {
    // 手工发布一个最小 CURRENT release：docs 含 docB 来源
    fs.mkdirSync(path.join(outputRoot, 'releases', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'CURRENT.json'), JSON.stringify({ releaseId: 'r1', publishedAt: '2026-10-28T00:00:00Z' }));
    fs.writeFileSync(path.join(outputRoot, 'releases', 'r1', 'manifest.json'), JSON.stringify({
      schemaVersion: 1, releaseId: 'r1', buildId: 'b1', mode: 'full', baseReleaseId: null,
      publishedAt: '2026-10-28T00:00:00Z', model: null, sourceSnapshot: [], skippedSources: [],
      docs: [{
        docId: 'kd_x', path: '规则/交叉.md', title: '交叉', summary: '', headings: [], tags: [],
        sources: ['docB'], contentHash: 'x', updatedInBuild: 'b1',
      }],
    }));
    const many: SourceReferenceInsert[] = [];
    for (let i = 0; i < 35; i += 1) many.push(edge(`tgt${String(i).padStart(4, '0')}padtopreventclash`, { occurrences: 100 - i }));
    many.push(edge('wikiB', { occurrences: 1 }));
    store.replaceSourceReferences('docE0', many);
    fs.writeFileSync(path.join(kbRoot, 'e0.md'), '# e0\n正文。');
    store.upsertDocument(docRow({ objToken: 'docE0', title: 'E0', localRelPath: 'e0.md' }));

    const service = makeService();
    const { token } = service.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot });
    const result = await service.executeTool(token, 'raw_read', { objToken: 'docE0' });
    const text = result.content[0].text;
    expect(text).toContain('out_truncated="true"');
    expect((text.match(/<out /g) ?? []).length).toBe(30);
    // occurrences 最低的 wikiB（1 次）被截掉；manifest 命中的出边带 kb 属性
    expect(text).not.toContain('target="wikiB"');
    store.replaceSourceReferences('docA', [
      edge('wikiB', { title: 'B "引用" <目标>', occurrences: 3 }),
      edge('extTokenNotInLib0000', { title: '外部文档', occurrences: 1 }),
      edge('docC', { title: 'C 占位', occurrences: 1 }),
    ]);
    const again = await service.executeTool(token, 'raw_read', { objToken: 'docA' });
    expect(again.content[0].text).toContain('target="wikiB" title="B &quot;引用&quot; &lt;目标&gt;" path="b.md" in_raw="true" kb="规则/交叉.md"');
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it('build 态：in_raw 按快照口径（快照内 true / 占位源 false）', async () => {
    const scan = RawSourceSnapshot.scan(kbRoot, store.getAllDocuments());
    const buildState: BuildRunState = {
      knowledgeBaseRoot: kbRoot,
      snapshot: new RawSourceSnapshot(scan.entries, { knowledgeBaseRoot: kbRoot }),
      mode: 'full',
      workset: new Map(scan.entries.map((entry) => [entry.objToken, 'rebuild' as const])),
      stagingRoot: path.join(root, 'staging'),
      docMeta: new Map(),
      finishInfo: null,
    };
    const service = makeService();
    const { token } = service.createRunContext({ runKind: 'build', outputRoot, knowledgeBaseRoot: kbRoot, buildState });
    const result = await service.executeTool(token, 'raw_read', { objToken: 'docA' });
    const text = result.content[0].text;
    expect(text).toContain('<out target="wikiB" title="B &quot;引用&quot; &lt;目标&gt;" path="b.md" in_raw="true"/>');
    expect(text).toContain('<out target="docC" title="C 占位" in_raw="false"/>');
  });
});

describe('raw_links 工具（§2.4）', () => {
  it('direction 缺省 both；out/in 各返回解析结果与 kbDocs', async () => {
    fs.mkdirSync(path.join(outputRoot, 'releases', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'CURRENT.json'), JSON.stringify({ releaseId: 'r1', publishedAt: '2026-10-28T00:00:00Z' }));
    fs.writeFileSync(path.join(outputRoot, 'releases', 'r1', 'manifest.json'), JSON.stringify({
      schemaVersion: 1, releaseId: 'r1', buildId: 'b1', mode: 'full', baseReleaseId: null,
      publishedAt: '2026-10-28T00:00:00Z', model: null, sourceSnapshot: [], skippedSources: [],
      docs: [{ docId: 'kd_x', path: '规则/交叉.md', title: '交叉', summary: '', headings: [], tags: [], sources: ['docB'], contentHash: 'x', updatedInBuild: 'b1' }],
    }));
    const service = makeService();
    const { token } = service.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot });
    const both = await service.executeTool(token, 'raw_links', { objToken: 'docA' });
    const payload = JSON.parse(both.content[0].text);
    expect(payload.direction).toBe('both');
    expect(payload.out.map((item: { token: string }) => item.token)).toEqual(['wikiB', 'docC', 'extTokenNotInLib0000']);
    expect(payload.out[0]).toMatchObject({ objToken: 'docB', localRelPath: 'b.md', synced: true, kbDocs: ['规则/交叉.md'] });
    expect(payload.out[2]).toMatchObject({ objToken: null, synced: false });
    expect(payload.in.map((item: { token: string }) => item.token).sort()).toEqual(['docB', 'docD']);
    const outOnly = await service.executeTool(token, 'raw_links', { objToken: 'docA', direction: 'out' });
    expect(JSON.parse(outOnly.content[0].text).in).toEqual([]);
    const inOnly = await service.executeTool(token, 'raw_links', { objToken: 'docA', direction: 'in' });
    expect(JSON.parse(inOnly.content[0].text).out).toEqual([]);
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it('单方向 200 条上限与 truncated 标记', async () => {
    // 250 篇外部文档引用 docA（每篇一行入边）
    for (let i = 0; i < 250; i += 1) {
      const src = `srcPad${String(i).padStart(4, '0')}Xpadpad`;
      store.replaceSourceReferences(src, [edge('docA', { occurrences: 1 })]);
    }
    const service = makeService();
    const { token } = service.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot });
    const result = await service.executeTool(token, 'raw_links', { objToken: 'docA', direction: 'in' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.in.length).toBe(200);
    expect(payload.inTruncated).toBe(true);
    expect(payload.out).toEqual([]);
  });

  it('未注入引用图 → references_unavailable', async () => {
    const service = makeService(false);
    const { token } = service.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot });
    await expect(service.executeTool(token, 'raw_links', { objToken: 'docA' }))
      .rejects.toMatchObject({ code: 'references_unavailable', status: 500 });
  });
});

describe('工具面与子任务交集（§2.4）', () => {
  it('raw_links 出现在 discuss/work/build 三面；task/probe 不出现', () => {
    for (const kind of ['discuss', 'work', 'build'] as const) {
      expect(toolsForRunKind(kind)).toContain('raw_links');
    }
    expect(toolsForRunKind('task')).not.toContain('raw_links');
    expect(toolsForRunKind('probe')).not.toContain('raw_links');
    const service = makeService();
    for (const kind of ['discuss', 'work', 'build'] as const) {
      const { token, context } = service.createRunContext({ runKind: kind, outputRoot, knowledgeBaseRoot: kbRoot });
      expect(context.allowedTools).toContain('raw_links');
      const specs = service.getToolSpecsForToken(token)!;
      expect(specs.map((spec) => spec.name)).toContain('raw_links');
    }
  });

  it('子任务交集规则不变：override 仅保留已知工具，task_*/app_command 永不进子任务面', () => {
    const service = makeService();
    const { context } = service.createRunContext({
      runKind: 'task',
      outputRoot,
      knowledgeBaseRoot: kbRoot,
      allowedToolsOverride: ['raw_links', 'kb_search', 'task_submit', 'app_command', 'no_such_tool'],
    });
    expect(context.allowedTools).toEqual(['raw_links', 'kb_search']);
  });
});

describe('构建 prompt 引用段（§2.4）', () => {
  it('standard-kb-build.md 含引用关系规则与 raw_links 工具说明', () => {
    const prompt = fs.readFileSync(
      path.resolve(__dirname, '../src/agent/prompts/standard-kb-build.md'),
      'utf-8',
    );
    expect(prompt).toContain('`raw_links`');
    expect(prompt).toContain('<source_links>');
    expect(prompt).toContain('in_raw="false"');
    expect(prompt).toContain('交叉链接');
  });
});
