/**
 * S3 切片 B 单测：机械预检纯模块。
 * 用例与风险一一对应：数值缺失/新增真阳性、规范化等价与噪声排除真阴性、
 * 条件词丢失与「当/若干」消歧、术语变体与大小写/全半角归一、空输入与
 * 未登记源、截断与确定性排序、合成集精确率/召回率下限（下限如实测得，
 * 详见 /tmp/slice-B-report.md）。
 */
import { describe, expect, it } from 'vitest';
import {
  precheck,
  formatFindingsForPrompt,
  type PrecheckDraftInput,
  type PrecheckFinding,
  type PrecheckFindingKind,
} from '../src/kb/mechanical-precheck.js';

const kinds = (fs: PrecheckFinding[], k: PrecheckFindingKind) => fs.filter((f) => f.kind === k);

describe('mechanical-precheck 数值比对', () => {
  it('number_missing：源数值未出现在引用草稿（含源行号与草稿对齐行号）', () => {
    const sources = new Map([
      ['tok1', '技能冷却时间为 12 秒，充能上限 3 层。\n伤害加成为 150%。'],
    ]);
    const r = precheck({
      sources,
      drafts: [{ path: 'docs/skill.md', text: '技能冷却时间为 12 秒。\n伤害加成很高。', sources: ['tok1'] }],
    });
    const missing = kinds(r.findings, 'number_missing');
    expect(missing.some((f) => f.detail.includes('3层') && f.sourceLine === 1)).toBe(true);
    expect(missing.some((f) => f.detail.includes('150%') && f.sourceLine === 2)).toBe(true);
    // 源与草稿一致的数值（12秒）不报
    expect(missing.some((f) => f.detail.includes('12'))).toBe(false);
    expect(missing.every((f) => f.draftPath === 'docs/skill.md' && f.sourceToken === 'tok1')).toBe(true);
    // 可句级对齐的缺失给出草稿侧行号与片段
    const byLayer = missing.find((f) => f.detail.includes('3层'));
    expect(byLayer?.draftLine).toBe(1);
    expect(byLayer?.draftSnippet).toContain('冷却');
    expect(byLayer?.sourceSnippet).toContain('充能');
    expect(kinds(r.findings, 'number_added')).toHaveLength(0);
  });

  it('number_added：草稿出现源中不存在的数值', () => {
    const sources = new Map([['s1', '基础伤害 100 点。']]);
    const r = precheck({
      sources,
      drafts: [{ path: 'a.md', text: '基础伤害 100 点，暴击后 250 点。', sources: ['s1'] }],
    });
    const added = kinds(r.findings, 'number_added');
    expect(added).toHaveLength(1);
    expect(added[0].detail).toContain('250');
    expect(added[0].draftLine).toBe(1);
    expect(kinds(r.findings, 'number_missing')).toHaveLength(0);
  });

  it('规范化等价（千分位/全角/百分号/单位中拉等价/范围连接词）不产生 finding', () => {
    const sources = new Map([
      ['s1', '注册用户 1,234 人；在线率 50％；延迟 ０．５ 秒；范围 3-5 米；距离 10 m。'],
    ]);
    const r = precheck({
      sources,
      drafts: [{ path: 'a.md', text: '注册用户1234人，在线率50%，延迟0.5秒，范围3至5 米，距离10米。', sources: ['s1'] }],
    });
    expect(r.findings).toHaveLength(0);
  });

  it('噪声排除：头注释/围栏/列表序号/标题序号/链接URL/日期不进入比对', () => {
    const sources = new Map([['s1', '系统包含装备强化，需要至少 3 名成员。']]);
    const draftText = [
      '<!--',
      'feishu_sync:',
      '  obj_token: tok42',
      '-->',
      '## 3.2 装备',
      '系统包含装备强化，需要至少 3 名成员。',
      '',
      '```',
      'const x = 150 + 42;',
      '```',
      '1. 列表项一',
      '2. 列表项二',
      '',
      '更新日期：2026-10-01；见[附录](#sec3)。',
    ].join('\n');
    const r = precheck({ sources, drafts: [{ path: 'a.md', text: draftText, sources: ['s1'] }] });
    expect(r.findings).toHaveLength(0);
  });
});

describe('mechanical-precheck 条件词', () => {
  it('condition_dropped：对齐句丢失条件词；保留时不报', () => {
    const sources = new Map([['s1', '若目标等级超过 50，则必须进入第二阶段。']]);
    const r = precheck({
      sources,
      drafts: [
        { path: 'dropped.md', text: '目标等级超过 50 时进入第二阶段。', sources: ['s1'] },
        { path: 'kept.md', text: '若目标等级超过 50，必须进入第二阶段。', sources: ['s1'] },
      ],
    });
    const dropped = kinds(r.findings.filter((f) => f.draftPath === 'dropped.md'), 'condition_dropped');
    expect(dropped.map((f) => f.detail)).toEqual(
      expect.arrayContaining([expect.stringContaining('「若」'), expect.stringContaining('「必须」')]),
    );
    expect(dropped.every((f) => f.draftLine === 1 && f.sourceLine === 1)).toBe(true);
    expect(kinds(r.findings.filter((f) => f.draftPath === 'kept.md'), 'condition_dropped')).toHaveLength(0);
  });

  it('「当…时」结构与「若干」消歧：非条件用法不报', () => {
    const sources = new Map([['s1', '当天开放的副本有若干个。']]);
    const r = precheck({
      sources,
      drafts: [{ path: 'a.md', text: '副本当天开放，数量若干。', sources: ['s1'] }],
    });
    expect(kinds(r.findings, 'condition_dropped')).toHaveLength(0);
  });
});

describe('mechanical-precheck 术语变体', () => {
  it('term_variant：编辑距离 1 变体命中；大小写/全半角归一不算变体', () => {
    const sources = new Map([['s1', '攻击力上限由 atk 决定。']]);
    const r = precheck({
      sources,
      drafts: [
        { path: 'a.md', text: '攻击效上限由 ATK 决定，crits 也计入。', sources: ['s1'] },
      ],
      terms: [
        { canonical: '攻击力', aliases: ['atk'] },
        { canonical: '会心一击', aliases: ['crit'] },
      ],
    });
    const variants = kinds(r.findings, 'term_variant');
    expect(variants.some((f) => f.detail.includes('攻击效') && f.detail.includes('攻击力'))).toBe(true);
    expect(variants.some((f) => f.detail.includes('crits'))).toBe(true);
    // 归一后精确相等（ATK→atk）是合法用法，不作为变体上报
    expect(variants.some((f) => f.detail.toLowerCase().includes('atk'))).toBe(false);
    expect(kinds(r.findings, 'number_missing')).toHaveLength(0);
  });
});

describe('mechanical-precheck 边界与输出契约', () => {
  it('空输入与未登记源：不产出 finding、不抛错', () => {
    expect(precheck({ sources: new Map(), drafts: [] })).toEqual({ findings: [], truncated: 0, total: 0 });
    const r = precheck({
      sources: new Map([['s1', '数值 42。']]),
      drafts: [{ path: 'a.md', text: '数值 42。', sources: ['ghost'] }],
    });
    expect(r.findings).toHaveLength(0);
  });

  it('maxFindings 截断报计数；输出稳定排序；formatFindingsForPrompt 可读', () => {
    const sources = new Map([['s1', '库存 101 个，102 个，103 个，104 个，105 个，106 个。']]);
    const drafts: PrecheckDraftInput[] = [{ path: 'inv.md', text: '库存详情见源文档。', sources: ['s1'] }];
    const r = precheck({ sources, drafts }, { maxFindings: 3 });
    expect(r.total).toBe(6);
    expect(r.truncated).toBe(3);
    expect(r.findings).toHaveLength(3);
    // 纯函数：同输入两次调用逐字节一致
    expect(precheck({ sources, drafts }, { maxFindings: 3 })).toEqual(r);
    const details = r.findings.map((f) => f.detail);
    expect([...details].sort()).toEqual(details);
    const text = formatFindingsForPrompt(r.findings, 2);
    expect(text).toContain('数值缺失');
    expect(text).toContain('省略');
    expect(formatFindingsForPrompt([])).toBe('机械预检未发现疑点。');
  });
});

describe('mechanical-precheck 合成集精确率/召回率', () => {
  it('达标下限（测量值如实记录在切片报告，不为通过放水）', () => {
    interface Planted {
      kind: PrecheckFindingKind;
      draftPath: string;
      /** detail 的唯一子串 */
      marker: string;
    }
    interface Item {
      sources: Map<string, string>;
      drafts: PrecheckDraftInput[];
      terms?: Array<{ canonical: string; aliases: string[] }>;
      planted: Planted[];
    }
    const d = (path: string, text: string, refs: string[]): PrecheckDraftInput => ({ path, text, sources: refs });
    const corpus: Item[] = [
      {
        sources: new Map([['s', '技能冷却 12 秒，充能 3 层，加成 150%。']]),
        drafts: [d('a.md', '技能的冷却与充能参数见源文档。', ['s'])],
        planted: [
          { kind: 'number_missing', draftPath: 'a.md', marker: '12秒' },
          { kind: 'number_missing', draftPath: 'a.md', marker: '3层' },
          { kind: 'number_missing', draftPath: 'a.md', marker: '150%' },
        ],
      },
      {
        sources: new Map([['s', '基础伤害 100 点。']]),
        drafts: [d('a.md', '基础伤害 100 点，暴击后 250 点。', ['s'])],
        planted: [{ kind: 'number_added', draftPath: 'a.md', marker: '250' }],
      },
      {
        sources: new Map([['s', '若目标等级超过 50，必须进入二阶段。']]),
        drafts: [d('dropped.md', '目标等级超过 50 时进入二阶段。', ['s'])],
        planted: [
          { kind: 'condition_dropped', draftPath: 'dropped.md', marker: '「若」' },
          { kind: 'condition_dropped', draftPath: 'dropped.md', marker: '「必须」' },
        ],
      },
      {
        sources: new Map([['s', '攻击力上限由 atk 决定。']]),
        drafts: [d('a.md', '攻击效上限由 atk 决定。', ['s'])],
        terms: [{ canonical: '攻击力', aliases: ['atk'] }],
        planted: [{ kind: 'term_variant', draftPath: 'a.md', marker: '攻击效' }],
      },
      {
        sources: new Map([['s', '连击 3-5 次。']]),
        drafts: [d('a.md', '连击 3 次。', ['s'])],
        planted: [
          { kind: 'number_missing', draftPath: 'a.md', marker: '3~5次' },
          { kind: 'number_missing', draftPath: 'a.md', marker: '5次' },
        ],
      },
      {
        sources: new Map([['s', '系统包含装备强化与技能升级。']]),
        drafts: [d('a.md', '本系统提供装备强化、技能升级功能。', ['s'])],
        planted: [],
      },
      {
        sources: new Map([['s', '系统包含装备强化，需要至少 3 名成员。']]),
        drafts: [
          d('a.md', '## 3.2 装备\n系统包含装备强化，需要至少 3 名成员。\n\n```\nx = 150\n```\n\n1. 列表\n\n更新日期：2026-10-01；见[附录](#sec3)。', ['s']),
        ],
        planted: [],
      },
      {
        sources: new Map([['s', '必须达到 10 级。']]),
        drafts: [d('a.md', '必须达到 10 级才能进入。', ['s'])],
        planted: [],
      },
      {
        sources: new Map([['s', 'CRIT 触发会心一击。']]),
        drafts: [d('a.md', 'CRIT 触发会心一击。', ['s'])],
        terms: [{ canonical: '会心一击', aliases: ['crit'] }],
        planted: [],
      },
      {
        sources: new Map([['s', '成本１２０元。']]),
        drafts: [d('a.md', '成本较高。', ['s'])],
        planted: [{ kind: 'number_missing', draftPath: 'a.md', marker: '120元' }],
      },
      {
        sources: new Map([['s', '掉落率 5%。']]),
        drafts: [d('a.md', '掉落率 5%，暴击率 8%。', ['s'])],
        planted: [{ kind: 'number_added', draftPath: 'a.md', marker: '8%' }],
      },
      {
        sources: new Map([['s', '除非持有钥匙，否则无法开启。']]),
        drafts: [d('a.md', '持有钥匙可以开启。', ['s'])],
        planted: [
          { kind: 'condition_dropped', draftPath: 'a.md', marker: '「除非」' },
          { kind: 'condition_dropped', draftPath: 'a.md', marker: '「无法」' },
        ],
      },
    ];
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const item of corpus) {
      const r = precheck({ sources: item.sources, drafts: item.drafts, terms: item.terms });
      const open = new Set(item.planted.map((_, i) => i));
      for (const f of r.findings) {
        const hit = item.planted.findIndex(
          (p, i) => open.has(i) && p.kind === f.kind && p.draftPath === f.draftPath && f.detail.includes(p.marker),
        );
        if (hit >= 0) {
          open.delete(hit);
          tp++;
        } else {
          fp++;
        }
      }
      fn += open.size;
    }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    console.log(`[kb-mechanical-precheck] 合成集 P=${precision.toFixed(3)} R=${recall.toFixed(3)} (tp=${tp} fp=${fp} fn=${fn})`);
    expect(precision).toBeGreaterThanOrEqual(0.85);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });
});

// ---------------------------------------------------------------------------
// F01 修复回归：候选索引对齐（与全扫描参考实现等价）、计算预算降级标注、
// 大文档耗时上界（diting 取证：修复前 8 万字符重复文档同步占用 5–6 秒）
// ---------------------------------------------------------------------------

describe('mechanical-precheck F01：对齐候选索引与计算预算', () => {
  it('大文档（8 万字符重复规则，n=16000，同 diting 取证程序）零 finding 且耗时有上界（实测 <500ms，断言放宽到 2s 防抖）', () => {
    const text = '必须执行。'.repeat(16000);
    const t0 = performance.now();
    const r = precheck(
      { sources: new Map([['s', text]]), drafts: [{ path: 'a.md', text, sources: ['s'] }] },
      { maxFindings: 0 },
    );
    const ms = performance.now() - t0;
    console.log(`[kb-mechanical-precheck] 8 万字符重复文档（n=16000）耗时 ${Math.round(ms)}ms`);
    expect(r.total).toBe(0);
    expect(r.findings).toHaveLength(0);
    expect(r.truncated).toBe(0);
    expect('degraded' in r).toBe(false);
    expect(ms).toBeLessThan(2000);
  });

  it('候选索引对齐与全扫描参考实现逐条一致（同输入 findings 等价）', () => {
    // 构造纯文本语料（单行、句号分隔、句末裸数值、不用有消歧歧义的条件词、
    // 无 markdown 装饰），在测试内复刻修复前的全扫描对齐算法（共享数值×3 +
    // CJK 二元组×1 + 拉丁词×2，阈值 3，首个最大者胜出），逐条对照新实现的
    // 对齐产物（draftLine/draftSnippet 完全由对齐结果决定）。
    const srcLine = [
      '护盾充能必须完成，数值 12',
      '冷却时间禁止重置，数值 7',
      '反击无法触发，数值 12',
      '闪避突进按等级生效',
      '治疗优先级必须遵守',
      '充能护盾可以叠加',
      '引擎标记 shield 部署，数值 90',
      '引擎标记 booster 部署',
      '暴击率计算规则说明',
      '突进距离为 30',
      '闪避距离为 30',
      '护盾被击破后重新展开',
    ].join('。') + '。';
    const draftLine = [
      '护盾充能完成，数值 12',
      '冷却时间可以重置，数值 7',
      '反击无法触发，数值 15',
      '闪避突进按等级生效',
      '治疗优先级必须遵守',
      '护盾充能可以快速叠加',
      '引擎 shield 部署说明',
      '引擎 marker 部署说明',
      '暴击率计算规则说明',
      '突进距离为 40',
    ].join('。') + '。';

    // —— 参考实现（修复前算法；本语料无 markdown/非语义掩码干扰，仅与模块
    // 同样做全角→半角归一，避免片段比对受标点宽度影响） ——
    const CJK_RUN = /[\u4e00-\u9fff]{2,}/g;
    const LATIN = /[A-Za-z][A-Za-z0-9-]{2,}/g;
    const toHalfWidthRef = (s: string): string => {
      let out = '';
      for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0;
        out += c >= 0xff01 && c <= 0xff5e ? String.fromCharCode(c - 0xfee0) : ch === '　' ? ' ' : ch;
      }
      return out;
    };
    const clipRef = (s: string): string => {
      const t = s.replace(/\s+/g, ' ').trim();
      return t.length > 48 ? t.slice(0, 47) + '…' : t;
    };
    interface RefSent {
      text: string;
      numbers: Set<string>;
      bigrams: Set<string>;
      latin: Set<string>;
    }
    const refSentences = (line: string): RefSent[] =>
      line.split(/[。！？；!?;]/).map((s) => s.trim()).filter(Boolean).map((raw) => {
        const t = toHalfWidthRef(raw);
        return {
          text: t,
          numbers: new Set(t.match(/\d+/g) ?? []),
          bigrams: (() => {
            const b = new Set<string>();
            for (const m of t.matchAll(CJK_RUN)) {
              for (let i = 0; i + 2 <= m[0].length; i++) b.add(m[0].slice(i, i + 2));
            }
            return b;
          })(),
          latin: new Set((t.match(LATIN) ?? []).map((w) => w.toLowerCase())),
        };
      });
    const refAlign = (src: RefSent, drafts: RefSent[]): RefSent | null => {
      let best: RefSent | null = null;
      let bestScore = 0;
      for (const ds of drafts) {
        let score = 0;
        for (const n of src.numbers) if (ds.numbers.has(n)) score += 3;
        for (const b of src.bigrams) if (ds.bigrams.has(b)) score += 1;
        for (const w of src.latin) if (ds.latin.has(w)) score += 2;
        if (score > bestScore) {
          bestScore = score;
          best = ds;
        }
      }
      return bestScore >= 3 ? best : null;
    };
    const srcSents = refSentences(srcLine);
    const draftSents = refSentences(draftLine);
    const srcKeys = new Set(srcSents.flatMap((s) => [...s.numbers]));
    const draftKeys = new Set(draftSents.flatMap((s) => [...s.numbers]));
    const COND_WORDS = ['必须', '禁止', '无法'];

    const expected: string[] = [];
    const seen = new Set<string>();
    for (const s of srcSents) {
      for (const n of s.numbers) {
        if (seen.has(n) || draftKeys.has(n)) continue;
        seen.add(n);
        const holder = srcSents.find((x) => x.numbers.has(n))!;
        const aligned = refAlign(holder, draftSents);
        expected.push(`number_missing|数值「${n}」|${aligned ? 1 : 0}|${aligned ? clipRef(aligned.text) : ''}`);
      }
      const words = COND_WORDS.filter((w) => s.text.includes(w));
      if (!words.length) continue;
      const aligned = refAlign(s, draftSents);
      if (!aligned) continue;
      for (const w of words) {
        if (aligned.text.includes(w)) continue;
        expected.push(`condition_dropped|条件词「${w}」|1|${clipRef(aligned.text)}`);
      }
    }
    // 预期非空：等价性检查必须有内容才有意义
    expect(expected.length).toBeGreaterThanOrEqual(4);

    const r = precheck({
      sources: new Map([['s1', srcLine]]),
      drafts: [{ path: 'eq.md', text: draftLine, sources: ['s1'] }],
    });
    expect('degraded' in r).toBe(false);
    const actual = r.findings
      .filter((f) => f.kind === 'number_missing' || f.kind === 'condition_dropped')
      .map((f) => `${f.kind}|${f.detail}|${f.draftLine}|${f.draftSnippet}`)
      .sort();
    expect(actual).toEqual([...expected].sort());
    // number_added 与对齐无关，但也一并对账（集合语义）
    const addedActual = r.findings.filter((f) => f.kind === 'number_added').map((f) => f.detail).sort();
    expect(addedActual).toEqual(
      [...draftKeys].filter((n) => !srcKeys.has(n)).map((n) => `数值「${n}」`).sort(),
    );
  });

  it('预算耗尽：如实标注 degraded/skippedReason；数值比对照常、条件词按未对齐不报', () => {
    const r = precheck(
      {
        sources: new Map([['s1', '必须执行数值 12。']]),
        drafts: [{ path: 'a.md', text: '执行数值 15。', sources: ['s1'] }],
      },
      { alignWorkBudget: 0 },
    );
    expect(r.degraded).toBe(true);
    expect(r.skippedReason).toContain('预算');
    expect(kinds(r.findings, 'number_missing')).toHaveLength(1); // 12 缺失照常报
    expect(kinds(r.findings, 'number_added')).toHaveLength(1);   // 15 新增照常报
    expect(kinds(r.findings, 'condition_dropped')).toHaveLength(0); // 对齐失败 → 宁漏报
    const missing = kinds(r.findings, 'number_missing')[0];
    expect(missing.detail).toBe('数值「12」');
    expect(missing.draftLine).toBe(0);
    expect(missing.draftSnippet).toBe('');
    const text = formatFindingsForPrompt(r.findings, 40, { skippedReason: r.skippedReason });
    expect(text).toContain('⚠');
    expect(text).toContain('不完整');
  });

  it('输入字符超限：句级对齐整体跳过并如实标注；线性比对照常', () => {
    const r = precheck(
      {
        sources: new Map([['s1', '必须执行数值 12。']]),
        drafts: [{ path: 'a.md', text: '必须执行数值 15。', sources: ['s1'] }],
      },
      { inputCharCap: 4 },
    );
    expect(r.degraded).toBe(true);
    expect(r.skippedReason).toContain('上限');
    expect(kinds(r.findings, 'number_missing')).toHaveLength(1);
    expect(kinds(r.findings, 'number_added')).toHaveLength(1);
    expect(kinds(r.findings, 'number_missing')[0].draftLine).toBe(0);
    expect(kinds(r.findings, 'condition_dropped')).toHaveLength(0);
    // 空清单 + 降级 → 警告而非「未发现疑点」；未降级调用输出与旧版一致
    const empty = formatFindingsForPrompt([], 40, { skippedReason: r.skippedReason });
    expect(empty).toContain('⚠');
    expect(empty).not.toContain('未发现疑点');
    expect(formatFindingsForPrompt([])).toBe('机械预检未发现疑点。');
  });

  it('批量唯一语句对齐在预算内完成（候选索引可扩展性，2500 句全对齐）', () => {
    const n = 2500;
    const srcParts: string[] = [];
    const draftParts: string[] = [];
    for (let i = 0; i < n; i++) {
      const base = 0x4e00 + i * 4; // 每句 4 个互不重复的 CJK 字符（独占二元组）
      const uniq = String.fromCodePoint(base, base + 1, base + 2, base + 3);
      srcParts.push(`${uniq} ${i}。`);
      draftParts.push(`${uniq} ${i + 100000}。`);
    }
    const src = srcParts.join('');
    const draft = draftParts.join('');
    const t0 = performance.now();
    const r = precheck(
      { sources: new Map([['s', src]]), drafts: [{ path: 'a.md', text: draft, sources: ['s'] }] },
      { maxFindings: n * 2 + 1 },
    );
    const ms = performance.now() - t0;
    console.log(`[kb-mechanical-precheck] 2500 句唯一语料对齐耗时 ${Math.round(ms)}ms`);
    expect(r.degraded).toBeUndefined();
    expect(r.total).toBe(n * 2); // 每句 1 缺失 + 1 新增
    expect(ms).toBeLessThan(2000);
    const missing = kinds(r.findings, 'number_missing');
    expect(missing).toHaveLength(n);
    for (const f of missing) {
      expect(f.draftLine).toBe(1); // 全部句级对齐成功
      expect(f.draftSnippet.length).toBeGreaterThan(0);
    }
  });
});
