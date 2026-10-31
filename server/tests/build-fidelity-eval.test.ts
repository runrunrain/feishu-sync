/** 构建保真评测（S4）测试。Synthetic only：不使用真实知识库、真实黄金标注、
 * 数据库或网络；黄金集与产物文本均为本文件/生成器内的虚构内容。 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateFidelity, extractNumbers, parseGoldenSet, type GoldenAssertion } from '../scripts/lib/build-fidelity-metrics.js';
import { SYNTHETIC_DOCS, SYNTHETIC_GOLDEN_JSONL, materializeSyntheticFidelity, syntheticGoldenAssertions } from '../scripts/lib/build-fidelity-synthetic.js';

const temporary: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-fidelity-test-')); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const provenance = { kind: 'synthetic' as const, source: 'unit-test' };
const assertion = (overrides: Partial<GoldenAssertion> & Pick<GoldenAssertion, 'id' | 'kind'>): GoldenAssertion => ({
  docPath: '战斗/护盾.md', source: { objToken: 'unit-src' }, expected: {}, provenance, ...overrides,
});
const docs = (entries: Array<[string, string]>) => new Map(entries);

describe('build-fidelity metrics', () => {
  it('computes hand-checked fidelity: partial loss is not omission, missing doc is', () => {
    const assertions = [
      assertion({ id: 't1', kind: 'text', expected: { text: '护盾值上限为 1200 点' } }),
      assertion({ id: 'n1', kind: 'number', expected: { numbers: [1500, 250] } }),   // 250 缺失 → 部分丢失
      assertion({ id: 'n2', kind: 'number', expected: { numbers: [200] } }),          // 200% → 200 命中
      assertion({ id: 'c1', kind: 'condition', expected: { text: '护盾被击破后重新展开', conditionTerm: '仅当' } }),
      assertion({ id: 'c2', kind: 'condition', expected: { text: '技能等级不得高于指挥官等级', conditionTerm: '超过' } }), // 限定词丢
      assertion({ id: 't2', kind: 'text', expected: { text: '星尘储备上限 99,999' } }), // 整条缺失
      assertion({ id: 't3', kind: 'text', docPath: 'missing.md', expected: { text: '任意' } }), // 产物文档缺失
    ];
    const report = evaluateFidelity(assertions, docs([
      ['战斗/护盾.md', [
        '**护盾值上限为 1200 点**',
        '升级需要 1,500 星尘。暴击率 200%。',
        '仅当护卫舰在场时，护盾被击破后重新展开。',
        '技能等级不得高于指挥官等级。',
      ].join('\n')],
    ]));
    // preserved: t1, n2, c1 = 3/7；omitted（零命中）: c2, t2, t3 = 3/7；n1 两者皆不计。
    expect(report.metrics).toEqual({
      assertions: 7,
      factFidelity: 3 / 7, // 同式浮点计算，位级一致；分母为空时才为 null
      omissionRate: 3 / 7,
      conflictHandlingCorrectness: null,
    });
    expect(report.rows.find((row) => row.id === 'n1')).toMatchObject({ coverage: 0.5, preserved: false, omitted: false, missing: ['number:250'] });
    expect(report.rows.find((row) => row.id === 'c1')?.preserved).toBe(true); // 同句共现
    expect(report.rows.find((row) => row.id === 't3')).toMatchObject({ docMissing: true, omitted: true });
    expect(report.missingDocs).toEqual(['missing.md']);
    expect(extractNumbers('1,500 星尘；99,999；200%；-5；v1.2')).toEqual([1500, 99999, 200, -5, 1.2]);
  });

  it('keeps the sign of negative thousand-group numbers (F02 回归：-1,500 不再丢负号)', () => {
    // 抽取层：负千分位与普通负数/正千分位同口径
    expect(extractNumbers('-1,500; -1500; -2,500.5')).toEqual([-1500, -1500, -2500.5]);
    expect(extractNumbers('1,500; 2,500.5; 5,000-6,000')).toEqual([1500, 2500.5, 5000, -6000]);
    // 指标层：产物合法千分位写法 -1,500 对断言 -1500 判命中；符号反转判失分
    const faithful = evaluateFidelity(
      [assertion({ id: 'signed-ok', kind: 'number', expected: { numbers: [-1500] } })],
      docs([['战斗/护盾.md', '衰减 -1,500 点']]),
    );
    expect(faithful.metrics).toEqual({ assertions: 1, factFidelity: 1, omissionRate: 0, conflictHandlingCorrectness: null });
    const flipped = evaluateFidelity(
      [assertion({ id: 'signed-flip', kind: 'number', expected: { numbers: [-1500] } })],
      docs([['战斗/护盾.md', '衰减 1,500 点']]),
    );
    expect(flipped.metrics).toEqual({ assertions: 1, factFidelity: 0, omissionRate: 1, conflictHandlingCorrectness: null });
    const negativeDecimal = evaluateFidelity(
      [assertion({ id: 'signed-dec', kind: 'number', expected: { numbers: [-2500.5] } })],
      docs([['战斗/护盾.md', '衰减 -2,500.5 点']]),
    );
    expect(negativeDecimal.metrics.factFidelity).toBe(1);
  });

  it('conflict correctness: juxtaposed sides pass, silently taking one side fails', () => {
    const conflict = {
      sides: [
        { objToken: 'src-manual', text: '记为每回合衰减 5%' },
        { objToken: 'src-notes', text: '记为每回合衰减 8%' },
      ],
    };
    const faithful = '衰减速率两个来源记录不一致：手册记为每回合衰减 5%，备忘记为每回合衰减 8%。';
    const silenced = '衰减速率两个来源记录不一致：手册记为每回合衰减 5%。'; // 静默取一方
    const report = evaluateFidelity([
      assertion({ id: 'ok', kind: 'text', expected: { text: '衰减速率两个来源记录不一致' }, conflict }),
      assertion({ id: 'silent', docPath: '养成/信使.md', kind: 'text', expected: { text: '衰减速率两个来源记录不一致' }, conflict }),
    ], docs([['战斗/护盾.md', faithful], ['养成/信使.md', silenced]]));
    const silent = report.rows.find((row) => row.id === 'silent')!;
    expect(silent).toMatchObject({ conflictCorrect: false, preserved: false, omitted: false, coverage: 2 / 3 });
    expect(silent.missing).toEqual(['conflict[src-notes:"记为每回合衰减 8%"]']);
    expect(report.metrics.conflictHandlingCorrectness).toBe(0.5);
    expect(report.metrics.factFidelity).toBe(0.5); // 静默取一方同时拖累保真率
  });

  it('golden set loader rejects duplicates, missing fields, mixed provenance and empty input', () => {
    const valid = JSON.parse(SYNTHETIC_GOLDEN_JSONL.split('\n')[0]) as GoldenAssertion;
    const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
    for (const [name, text] of [
      ['duplicate_id', lines([valid, { ...valid, docPath: '资源/星尘获取.md' }])],
      ['invalid_docPath', JSON.stringify({ ...valid, docPath: 'no-extension' })],
      ['invalid_kind', JSON.stringify({ ...valid, kind: 'vibe' })],
      ['text_assertion_requires_expected_text', JSON.stringify({ ...valid, expected: {} })],
      ['number_assertion_requires_finite_numbers', JSON.stringify({ ...valid, kind: 'number', expected: { numbers: [1, NaN] } })],
      ['condition_assertion_requires_text_and_conditionTerm', JSON.stringify({ ...valid, kind: 'condition', expected: { text: 'x' } })],
      ['invalid_source', JSON.stringify({ ...valid, source: {} })],
      ['invalid_conflict_sides', JSON.stringify({ ...valid, conflict: { sides: [] } })],
      ['provenance_required', JSON.stringify({ ...valid, provenance: undefined })],
      ['human_provenance_required', JSON.stringify({ ...valid, provenance: { kind: 'human', source: 'user' } })],
      ['mixed_provenance', lines([valid, { ...valid, id: 'h1', provenance: { kind: 'human', source: 'user', annotator: '甲', reference: '会话#1' } }])],
      ['empty_golden_set', '\n \n'],
      ['not_an_object', '[1,2]'],
    ] as Array<[string, string]>) {
      expect(() => parseGoldenSet(text, `${name}.jsonl`), name).toThrow(name);
    }
    // 好数据 + 行号定位：第 2 行报错带 label:2 前缀。
    expect(() => parseGoldenSet(lines([valid, { ...valid, id: '' }]), 'g.jsonl')).toThrow('g.jsonl:2');
    expect(parseGoldenSet(SYNTHETIC_GOLDEN_JSONL, 'synthetic')).toHaveLength(10);
  });

  it('is deterministic: repeated evaluation returns identical reports', () => {
    const assertions = syntheticGoldenAssertions();
    const docMap = docs(SYNTHETIC_DOCS.map((doc) => [doc.path, doc.text] as [string, string]));
    const first = JSON.stringify(evaluateFidelity(assertions, docMap));
    const second = JSON.stringify(evaluateFidelity(syntheticGoldenAssertions(), docs(SYNTHETIC_DOCS.map((doc) => [doc.path, doc.text] as [string, string]))));
    expect(second).toBe(first); // 相同输入 → 逐字节相同的报告（含行序与 missing 元素序）
    expect(JSON.parse(first).rows.map((row: { id: string }) => row.id)).toEqual(assertions.map((a) => a.id));
  });

  it('synthetic fixture materializes deterministically, scores perfectly, and senses a silenced conflict', () => {
    const one = materializeSyntheticFidelity(path.join(temp(), 'one'));
    const two = materializeSyntheticFidelity(path.join(temp(), 'two'));
    expect(fs.readFileSync(one.goldenFile, 'utf8')).toBe(fs.readFileSync(two.goldenFile, 'utf8'));
    for (const doc of SYNTHETIC_DOCS) {
      expect(fs.readFileSync(path.join(one.docsDir, ...doc.path.split('/')), 'utf8'))
        .toBe(fs.readFileSync(path.join(two.docsDir, ...doc.path.split('/')), 'utf8'));
    }
    expect(() => materializeSyntheticFidelity(one.docsDir)).toThrow('synthetic_target_not_empty');

    const faithful = evaluateFidelity(syntheticGoldenAssertions(), docs(SYNTHETIC_DOCS.map((doc) => [doc.path, doc.text] as [string, string])));
    expect(faithful.metrics).toEqual({ assertions: 10, factFidelity: 1, omissionRate: 0, conflictHandlingCorrectness: 1 });

    // 退化产物（冲突静默取一方）：敏感性验证——并列正确率降半；被删一侧的
    // 数值（8）随文本一并消失，护盾数值断言同时失分，保真率 8/10。
    const degraded = docs(SYNTHETIC_DOCS.map((doc) => [doc.path, doc.path === '战斗/星轨护盾.md'
      ? doc.text.replace('《远征备忘》记为每回合衰减 8%，并列呈现，未作统一。', '')
      : doc.text] as [string, string]));
    const degradedReport = evaluateFidelity(syntheticGoldenAssertions(), degraded);
    expect(degradedReport.metrics.conflictHandlingCorrectness).toBe(0.5);
    expect(degradedReport.metrics.factFidelity).toBe(0.8);
  });
});
