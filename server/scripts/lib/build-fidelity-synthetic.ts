/** 构建保真评测（S4）的显式合成 fixture——「星轨远征」虚构规则集。
 *
 * 只用虚构内容：不触碰任何真实知识库、数据库、网络；不复制 kb-eval
 * 检索 fixture 的语料。与 kb-eval-synthetic 同一纪律：只物化到调用方
 * 自有的空临时目录，不覆盖任何既有内容；扩展只加行，不改语义。
 *
 * 忠实产物（SYNTHETIC_DOCS）按黄金集逐条可验证地保真表达全部断言，
 * 包括两条多源冲突的并列呈现；退化产物（遗漏/改值/冲突静默取一方）
 * 由测试在忠实文本上做字符串手术构造，不在此重复维护。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseGoldenSet, type GoldenAssertion } from './build-fidelity-metrics.js';

export const SYNTHETIC_DOC_PATHS = ['战斗/星轨护盾.md', '养成/信使培养.md', '资源/星尘获取.md'] as const;

/** 黄金集（10 条断言：4 文本类、3 数值类、2 条件类，其中 2 条带冲突并列期望）。 */
export const SYNTHETIC_GOLDEN_JSONL = [
  {
    id: 'synthetic-fid-shield-cap', docPath: '战斗/星轨护盾.md', kind: 'text',
    source: { objToken: 'synthetic-src-shield-manual', quote: '护盾值上限 1200 点' },
    expected: { text: '护盾值上限为 1200 点' },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-shield-numbers', docPath: '战斗/星轨护盾.md', kind: 'number',
    source: { objToken: 'synthetic-src-shield-manual' },
    expected: { numbers: [1200, 5, 8] },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-shield-condition', docPath: '战斗/星轨护盾.md', kind: 'condition',
    source: { objToken: 'synthetic-src-shield-manual', quote: '仅当存在护卫舰时重新展开' },
    expected: { text: '护盾被击破后会在下一回合重新展开', conditionTerm: '仅当' },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-shield-conflict', docPath: '战斗/星轨护盾.md', kind: 'text',
    source: { objToken: 'synthetic-src-shield-manual' },
    expected: { text: '衰减速率两个来源记录不一致' },
    conflict: {
      sides: [
        { objToken: 'synthetic-src-shield-manual', text: '记为每回合衰减 5%' },
        { objToken: 'synthetic-src-herald-notes', text: '记为每回合衰减 8%' },
      ],
    },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-herald-cost', docPath: '养成/信使培养.md', kind: 'number',
    source: { objToken: 'synthetic-src-herald-notes' },
    expected: { numbers: [1500, 4000] },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-herald-level', docPath: '养成/信使培养.md', kind: 'condition',
    source: { objToken: 'synthetic-src-herald-notes', quote: '技能等级不得高于指挥官等级' },
    expected: { text: '信使技能等级不得高于舰队指挥官等级', conditionTerm: '不得' },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-herald-refund', docPath: '养成/信使培养.md', kind: 'text',
    source: { objToken: 'synthetic-src-herald-notes' },
    expected: { text: '技能重置返还 80% 的星尘消耗' },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-stardust-daily', docPath: '资源/星尘获取.md', kind: 'text',
    source: { objToken: 'synthetic-src-stardust-ledger' },
    expected: { text: '每日巡逻固定产出 200 星尘' },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-stardust-numbers', docPath: '资源/星尘获取.md', kind: 'number',
    source: { objToken: 'synthetic-src-stardust-ledger' },
    expected: { numbers: [200, 99999] },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
  {
    id: 'synthetic-fid-stardust-conflict', docPath: '资源/星尘获取.md', kind: 'text',
    source: { objToken: 'synthetic-src-stardust-ledger' },
    expected: { text: '储备上限两个来源记录不一致' },
    conflict: {
      sides: [
        { objToken: 'synthetic-src-stardust-ledger', text: '记为 99,999' },
        { objToken: 'synthetic-src-supply-notice', text: '记为 120,000' },
      ],
    },
    provenance: { kind: 'synthetic', source: 'hand-authored-fixture' },
  },
].map((a) => JSON.stringify(a)).join('\n') + '\n';

/** 忠实构建产物：全部断言可验证保真（冲突双方并列，不裁决）。 */
export const SYNTHETIC_DOCS: ReadonlyArray<{ path: string; text: string }> = [
  {
    path: '战斗/星轨护盾.md',
    text: [
      '# 星轨护盾',
      '',
      '护盾为舰队提供可吸收伤害的临时屏障，**护盾值上限为 1200 点**。',
      '护盾在每回合结束时衰减。衰减速率两个来源记录不一致：《星轨手册》记为每回合衰减 5%，《远征备忘》记为每回合衰减 8%，并列呈现，未作统一。',
      '仅当舰队中存在至少一艘护卫舰时，护盾被击破后会在下一回合重新展开。',
      '',
    ].join('\n'),
  },
  {
    path: '养成/信使培养.md',
    text: [
      '# 信使培养',
      '',
      '信使升星消耗星尘：一星升至二星需要 1,500 星尘，二星升至三星需要 4,000 星尘。',
      '信使技能等级不得高于舰队指挥官等级。',
      '技能重置返还 80% 的星尘消耗。',
      '',
    ].join('\n'),
  },
  {
    path: '资源/星尘获取.md',
    text: [
      '# 星尘获取',
      '',
      '每日巡逻固定产出 200 星尘。',
      '储备上限两个来源记录不一致：《星尘台账》记为 99,999，《补给站公告》记为 120,000，并列呈现，未作统一。',
      '',
    ].join('\n'),
  },
];

export function syntheticGoldenAssertions(): GoldenAssertion[] {
  return parseGoldenSet(SYNTHETIC_GOLDEN_JSONL, 'synthetic-golden.jsonl');
}

/** 物化合成评测骨架到调用方自有的空目录：
 * `<dir>/golden.jsonl` + `<dir>/docs/<docPath>`。只接受空目录（含不存在）。 */
export function materializeSyntheticFidelity(dir: string): { goldenFile: string; docsDir: string } {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error('synthetic_target_not_empty');
  const goldenFile = path.join(dir, 'golden.jsonl');
  const docsDir = path.join(dir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(goldenFile, SYNTHETIC_GOLDEN_JSONL);
  for (const doc of SYNTHETIC_DOCS) {
    const file = path.join(docsDir, ...doc.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, doc.text);
  }
  return { goldenFile, docsDir };
}
