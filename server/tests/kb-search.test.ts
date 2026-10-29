/** P0/L1 合成语料单测；不读取生产知识库，也不复用 E0 评测 fixture。 */
import { describe, expect, it, vi } from 'vitest';
import { legacySearchDocs, parseSearchQuery, searchDocs, type SearchableDoc } from '../src/kb/kb-search.js';

const doc = (path: string, fields: Partial<SearchableDoc> = {}): SearchableDoc => ({
  docId: path, path, title: '条目', summary: '', headings: [], ...fields,
});
const paths = (hits: ReturnType<typeof searchDocs>) => hits.map((hit) => hit.path);

describe('P0/L1 查询单元', () => {
  it('按空白/中英文标点切分、去重、保留顺序', () => {
    expect(parseSearchQuery(' 战斗，结算;战斗\tBuff/规则\\消耗。')).toEqual(['战斗', '结算', 'buff', '规则', '消耗']);
  });

  it('三种引号内的空白与标点保留为短语', () => {
    expect(parseSearchQuery('战斗 "Critical Hit" “结算，顺序” 「升星 消耗」')).toEqual([
      '战斗', 'critical hit', '结算，顺序', '升星 消耗',
    ]);
    expect(parseSearchQuery('"" “ ” 「」 ,；')).toEqual([]);
    expect(parseSearchQuery('"战斗 结算')).toEqual(['战斗', '结算']);
  });

  it('英文 ID、版本、数值与单字符查询兼容（不套用 lex-v1 丢弃规则）', () => {
    expect(parseSearchQuery('SKILL_ID v1.2 hp+10% atk-5 #1001 0 A 中')).toEqual([
      'skill_id', 'v1.2', 'hp+10%', 'atk-5', '#1001', '0', 'a', '中',
    ]);
    expect(parseSearchQuery('单元1 单元2 单元3 单元4 单元5 单元6 单元7 单元8 单元9')).toHaveLength(9);
  });
});

describe('searchDocs L1（L0 保留用于基线对照）', () => {
  it('多词在不同字段命中；L0 整串零命中，L1 返回结果与正文片段', () => {
    const docs = [doc('pets.md', { title: '宠物', headings: ['升星'] })];
    const body = vi.fn(() => '升星需要消耗星尘。');
    expect(legacySearchDocs(docs, '宠物 升星 消耗', 20, body)).toEqual([]);
    body.mockClear();
    expect(searchDocs(docs, '宠物 升星 消耗', 20, body)).toEqual([{
      docId: 'pets.md', path: 'pets.md', title: '宠物', summary: '', snippet: '升星需要消耗星尘。',
    }]);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('覆盖率改变排名；部分命中仍保留（非 AND），重复单元不加权', () => {
    const docs = [
      doc('partial.md', { title: '关于战斗' }), // 100 × 1
      doc('full.md', { summary: '结算' }), // (60 + 20) × 1.5
    ];
    const body = (item: SearchableDoc) => item.path === 'full.md' ? '战斗' : null;
    expect(paths(searchDocs(docs, '战斗 结算', 20, body))).toEqual(['full.md', 'partial.md']);
    expect(searchDocs(docs, '战斗 结算 战斗', 20, body)).toEqual(searchDocs(docs, '战斗 结算', 20, body));
    expect(paths(searchDocs(docs, '战斗 未收录', 20, body))).toContain('partial.md');
  });

  it('引号短语须连续，单术语保持 L0 的结果/片段行为', () => {
    const docs = [doc('a.md', { title: 'Critical Hit' }), doc('b.md', { title: 'Critical big Hit' })];
    expect(paths(searchDocs(docs, '"critical hit"'))).toEqual(['a.md']);
    expect(paths(searchDocs(docs, '“critical hit”'))).toEqual(['a.md']);
    expect(paths(searchDocs(docs, '「critical hit」'))).toEqual(['a.md']);
    expect(paths(searchDocs(docs, 'critical hit'))).toEqual(['a.md', 'b.md']);
    const body = () => '前言\n' + 'x'.repeat(90) + ' HIT ' + 'y'.repeat(180);
    expect(searchDocs(docs, ' HIT ', 20, body)).toEqual(legacySearchDocs(docs, ' HIT ', 20, body));
  });

  it.each(['skill_id', '1001', 'hp+10%', 'v1.2', 'atk-5', '0', 'a'])('精确值 %s 仍可单独查', (query) => {
    const docs = [doc('entry.md')];
    expect(paths(searchDocs(docs, query.toUpperCase(), 20, () => `| ${query} |`))).toEqual(['entry.md']);
  });

  it('并列按 path 码元字典序（非 locale），排序后再 limit', () => {
    const docs = ['z.md', 'a.md', 'A.md', '中.md'].map((name) => doc(name, { summary: '结算' }));
    expect(paths(searchDocs(docs, '结算', 2))).toEqual(['A.md', 'a.md']);
    expect(searchDocs([...docs].reverse(), '结算')).toEqual(searchDocs(docs, '结算'));
  });

  it('空白/纯分隔符零结果且不读正文；无命中、缺正文与异常传播', () => {
    const docs = [doc('a.md', { summary: '摘要' })];
    const fetch = vi.fn(() => null);
    expect(searchDocs(docs, ' \t，； ', 20, fetch)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(searchDocs(docs, '未命中', 20, fetch)).toEqual([]);
    expect(searchDocs(docs, '摘要', 20, fetch)[0].snippet).toBe('摘要');
    expect(() => searchDocs(docs, '摘要', 20, () => { throw new Error('read failed'); })).toThrow('read failed');
  });

  it('沿用返回条数夹取边界（1..50）', () => {
    const docs = Array.from({ length: 55 }, (_, i) => doc(`${i}.md`, { title: '结算' }));
    expect(searchDocs(docs, '结算', 0)).toHaveLength(1);
    expect(searchDocs(docs, '结算', 99)).toHaveLength(50);
  });
});
