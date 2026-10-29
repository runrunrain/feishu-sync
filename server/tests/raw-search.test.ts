/** P0 raw_search 真实工具入口 + 临时文件；全部文档是专用合成 fixture。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot } from '../src/kb/raw-source-snapshot.js';
import type { DocumentRecord } from '../src/types/index.js';
import { KB_SEARCH_SPEC, RAW_SEARCH_SPEC } from '../src/agent/tool-specs.js';

describe('raw_search L1：完整扫描 → 评分 → 排序 → limit', () => {
  let root: string;
  let raw: string;
  let records: DocumentRecord[];
  let service: AgentToolService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-search-p0-'));
    raw = path.join(root, 'raw');
    fs.mkdirSync(raw);
    records = [];
    service = new AgentToolService({ dataRoot: root, documentsProvider: () => records });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function add(relPath: string, title: string, content: string): DocumentRecord {
    const full = path.join(raw, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    const record: DocumentRecord = {
      objToken: `fixture_${records.length}`, wikiNodeToken: null, objType: 'docx',
      title, localMdPath: full, localRelPath: relPath,
      lastSyncedModifyTime: '', lastSyncedAt: '', status: 'synced',
    };
    records.push(record);
    return record;
  }
  function context(runKind: 'discuss' | 'work' | 'build') {
    let buildState: BuildRunState | undefined;
    if (runKind === 'build') {
      buildState = {
        knowledgeBaseRoot: raw,
        snapshot: RawSourceSnapshot.fromEntries(RawSourceSnapshot.scan(raw, records).entries),
        mode: 'full', workset: new Map(), stagingRoot: path.join(root, 'staging'), finishInfo: null,
      };
    }
    return service.createRunContext({
      runKind, outputRoot: path.join(root, 'out'), knowledgeBaseRoot: raw, buildState,
    });
  }
  async function search(token: string, query: string, limit = 20) {
    const result = await service.executeTool(token, 'raw_search', { query, limit });
    return JSON.parse(result.content[0].text).results as Array<{ objToken: string; relPath: string; title: string; snippet?: string }>;
  }

  it.each(['discuss', 'work', 'build'] as const)('%s：晚到的最高分命中不被 limit=1 提前截断', async (runKind) => {
    add('a.md', '普通条目', '战斗'); // body: 20
    add('b.md', '战斗规则', '无命中正文'); // title: 10
    add('战斗.md', '战斗结算', '这里是战斗规则。'); // title + path + body: 35
    const { token } = context(runKind);
    expect((await search(token, '战斗', 1)).map((hit) => hit.relPath)).toEqual(['战斗.md']);
    expect((await search(token, '战斗')).map((hit) => hit.relPath)).toEqual(['战斗.md', 'a.md', 'b.md']);
    const hits = await search(token, '战斗', 1);
    expect(hits[0].snippet).toContain('战斗规则');
    expect(Object.keys(hits[0]).sort()).toEqual(['objToken', 'relPath', 'snippet', 'title']);
  });

  it('多词覆盖率优先于只中一词；不要求整串相邻；重复词不改变得分', async () => {
    add('a.md', '普通条目', '战斗'); // 20 × 1
    add('b/结算.md', '战斗', '无命中正文'); // (10 + 5) × 1.5
    const { token } = context('discuss');
    expect((await search(token, '战斗 结算')).map((hit) => hit.relPath)).toEqual(['b/结算.md', 'a.md']);
    expect(await search(token, '战斗 结算 战斗')).toEqual(await search(token, '战斗 结算'));
  });

  it('并列按路径码元顺序，候选顺序反转也一致', async () => {
    for (const name of ['z.md', 'a.md', 'A.md']) add(name, '普通', '结算');
    const { token } = context('discuss');
    const first = await search(token, '结算', 2);
    expect(first.map((hit) => hit.relPath)).toEqual(['A.md', 'a.md']);
    records.reverse();
    expect(await search(token, '结算', 2)).toEqual(first);
  });

  it('引号保留短语、英文 ID/数值兼容，无命中/纯标点返回空', async () => {
    add('a.md', '条目', 'Critical Hit skill_id 1001 hp+10% v1.2 0');
    add('b.md', '条目', 'Critical big Hit');
    const { token } = context('discuss');
    for (const query of ['"critical hit"', '“Critical Hit”', '「Critical Hit」', 'SKILL_ID 1001', 'hp+10% v1.2', '0']) {
      expect((await search(token, query)).map((hit) => hit.relPath)).toEqual(['a.md']);
    }
    expect(await search(token, '未命中')).toEqual([]);
    expect(await search(token, ',，;；')).toEqual([]);
  });

  it('快照越过 limit 的源变化仍会毒化构建，不因找到首条就漏校验', async () => {
    add('a.md', '战斗', '战斗');
    const changed = add('b.md', '战斗', '战斗');
    const { token, context: run } = context('build');
    fs.writeFileSync(changed.localMdPath, '源已变化');
    await search(token, '战斗', 1);
    expect(run.options.buildState?.poisoned).toMatchObject({ code: 'source_changed_during_build' });
    await expect(service.executeTool(token, 'raw_read', { objToken: changed.objToken }))
      .rejects.toMatchObject({ code: 'source_changed_during_build' });
  });

  it('不可读/逃逸文件仍不暴露正文，元字段命中按既有语义保留', async () => {
    add('a.md', '战斗', '正常正文');
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, '只在围栏外存在的私密词');
    const escaped = add('escape.md', '战斗', '待替换');
    fs.unlinkSync(escaped.localMdPath);
    fs.symlinkSync(outside, escaped.localMdPath);
    const { token } = context('discuss');
    expect(await search(token, '私密词')).toEqual([]);
    expect(await search(token, '战斗')).toHaveLength(2);
    expect((await search(token, '战斗')).every((hit) => hit.snippet === undefined)).toBe(true);
  });

  it('只读工具描述引导空格多词，不改变 schema', () => {
    for (const spec of [KB_SEARCH_SPEC, RAW_SEARCH_SPEC]) {
      expect(spec.description).toContain('用空格分隔');
      expect(spec.description).toContain('引号');
      expect(spec.parameters.required).toEqual(['query']);
    }
  });
});
