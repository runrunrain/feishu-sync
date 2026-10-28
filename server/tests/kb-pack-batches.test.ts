/**
 * P2-S2 装箱与单元测试（设计 §2.3/§2.4/§2.6/§2.8）
 *
 * - packBatches：§2.6 算例逐批锚定；budget=0 与旧 chunk 字节级等价；
 *   恰好等于预算 / 超预算单源独占 / maxCount 先到 / 空输入 / 顺序保持。
 * - planUnits：不变量 2 性质测试（随机工作集 × 多预算）；incremental
 *   分量与预算无关；full 预算×3 切单元；排序键 words→bytes→原序。
 * - 单 worker 与并行路径同一装箱（单连通分量时 unit.batches === 单进程
 *   路径的 packBatches 全局批切分）。
 * - effectiveWords（§2.2 口径）与 buildBatchWordBudget 配置钳制（§2.5）。
 */

import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packBatches, planUnits } from '../src/kb/build-units.js';
import { effectiveWords } from '../src/kb/kb-build-service.js';
import { countText } from '../src/kb/text-stats.js';
import { ConfigManager } from '../src/modules/config-manager.js';

type Meta = { relPath: string; bytes: number; words?: number };

function workset(entries: Record<string, [string, number, number?]>): Map<string, Meta> {
  return new Map(
    Object.entries(entries).map(([token, [relPath, bytes, words]]) => [
      token,
      words === undefined ? { relPath, bytes } : { relPath, bytes, words },
    ]),
  );
}

/** 旧按源数切分（重构前 chunkTokens 同语义），用于字节级等价比对。 */
function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

// ---------------------------------------------------------------------------
// packBatches（§2.3/§2.6）
// ---------------------------------------------------------------------------

describe('packBatches', () => {
  it('§2.6 算例：8 源 3k/2k/35k/8k/70k/1k/1k/30k，budget=40000 → 4 批', () => {
    const tokens = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
    const words: Record<string, number> = {
      S1: 3000, S2: 2000, S3: 35000, S4: 8000, S5: 70000, S6: 1000, S7: 1000, S8: 30000,
    };
    const batches = packBatches(tokens, (t) => words[t], { wordBudget: 40000, maxCount: 10 });
    expect(batches).toEqual([
      ['S1', 'S2', 'S3'], // 40k：下一个 8k 会超预算
      ['S4'],             // 8k：下一个 70k 会超预算
      ['S5'],             // 70k：单源超预算，独占
      ['S6', 'S7', 'S8'], // 32k：工作集结束
    ]);
  });

  it('budget=0 → 与旧 chunk 逐批相等（多个 maxCount）', () => {
    const tokens = Array.from({ length: 23 }, (_, i) => `t${i}`);
    const words = new Map(tokens.map((t, i) => [t, (i * 7919) % 100000]));
    const wordsOf = (t: string) => words.get(t) ?? 0;
    for (const maxCount of [1, 3, 10, 50]) {
      expect(packBatches(tokens, wordsOf, { wordBudget: 0, maxCount })).toEqual(chunk(tokens, maxCount));
    }
  });

  it('恰好等于预算可同批；预算不含全部剩余源则继续切', () => {
    const batches = packBatches(['a', 'b', 'c', 'd'], () => 10000, { wordBudget: 30000, maxCount: 10 });
    expect(batches).toEqual([['a', 'b', 'c'], ['d']]); // 10k×3 = 30k 恰好等于预算
  });

  it('超预算单源独占一批（首位 / 中位 / 末位 / 唯一源）', () => {
    const w = { big: 100000, s1: 10000, s2: 20000 };
    const wordsOf = (t: string) => (w as Record<string, number>)[t];
    expect(packBatches(['big', 's1'], wordsOf, { wordBudget: 40000, maxCount: 10 })).toEqual([['big'], ['s1']]);
    expect(packBatches(['s1', 'big', 's2'], wordsOf, { wordBudget: 40000, maxCount: 10 })).toEqual([['s1'], ['big'], ['s2']]);
    expect(packBatches(['s1', 'big'], wordsOf, { wordBudget: 40000, maxCount: 10 })).toEqual([['s1'], ['big']]);
    expect(packBatches(['big'], wordsOf, { wordBudget: 40000, maxCount: 10 })).toEqual([['big']]);
  });

  it('maxCount 先到 → 封批（预算未超）', () => {
    const batches = packBatches(['a', 'b', 'c', 'd', 'e'], () => 1, { wordBudget: 100000, maxCount: 2 });
    expect(batches).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('maxCount 与预算同时满足上限 → 封批（等于不算超）', () => {
    // 20k+20k=40k 恰好等于预算且批长=2=maxCount：先按任一条件封批
    const batches = packBatches(['a', 'b', 'c'], () => 20000, { wordBudget: 40000, maxCount: 2 });
    expect(batches).toEqual([['a', 'b'], ['c']]);
  });

  it('空输入 → 空批列表（budget>0 与 0 一致）', () => {
    expect(packBatches([], () => 0, { wordBudget: 40000, maxCount: 10 })).toEqual([]);
    expect(packBatches([], () => 0, { wordBudget: 0, maxCount: 10 })).toEqual([]);
  });

  it('保持输入顺序（输出展平 = 输入序列）', () => {
    const tokens = ['t5', 't3', 't9', 't1', 't7'];
    const words = new Map([['t5', 15000], ['t3', 30000], ['t9', 5000], ['t1', 9000], ['t7', 40000]]);
    const batches = packBatches(tokens, (t) => words.get(t) ?? 0, { wordBudget: 20000, maxCount: 3 });
    expect(batches.flat()).toEqual(tokens);
  });
});

// ---------------------------------------------------------------------------
// planUnits（§2.4 不变量 / U44）
// ---------------------------------------------------------------------------

describe('planUnits · P2-S2 装箱改造', () => {
  /** 确定性伪随机（LCG），保证性质测试可复现。 */
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function randomWorkset(rand: () => number, size: number): Map<string, Meta> {
    const entries: Record<string, [string, number, number]> = {};
    for (let i = 0; i < size; i += 1) {
      const cluster = `dir${Math.floor(rand() * 4)}`;
      entries[`tok${i}`] = [`${cluster}/s${String(i).padStart(3, '0')}.md`, Math.floor(rand() * 50000), Math.floor(rand() * 90000)];
    }
    return workset(entries);
  }

  /** 不变量 2：∪sources=工作集且互不相交；∪batches=unit.sources。 */
  function assertPartitionInvariants(units: ReturnType<typeof planUnits>, keys: string[]): void {
    const seen = new Set<string>();
    for (const unit of units) {
      expect(unit.batches.flat().sort()).toEqual([...unit.sources].sort());
      for (const token of unit.sources) {
        expect(seen.has(token)).toBe(false);
        seen.add(token);
      }
      expect(Number.isFinite(unit.words)).toBe(true);
      expect(Number.isFinite(unit.bytes)).toBe(true);
    }
    expect([...seen].sort()).toEqual([...keys].sort());
  }

  it('不变量 2 性质测试：full 模式随机工作集 × 多预算', () => {
    for (const seed of [1, 7, 42, 2026]) {
      const rand = lcg(seed);
      const ws = randomWorkset(rand, 12 + Math.floor(rand() * 20));
      const keys = [...ws.keys()];
      for (const budget of [0, 4000, 40000, 250000]) {
        const units = planUnits({
          mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [],
          batchSize: 5, wordBudget: budget,
        });
        assertPartitionInvariants(units, keys);
        // full 单元字数上限 = 预算×3（超预算单源独占除外）；个数上限 = 15
        if (budget > 0) {
          for (const unit of units) {
            const oversize = unit.sources.filter((t) => (ws.get(t)?.words ?? 0) > budget * 3);
            if (oversize.length === 0) expect(unit.words).toBeLessThanOrEqual(budget * 3);
            expect(unit.sources.length).toBeLessThanOrEqual(15);
          }
        }
      }
    }
  });

  it('不变量 2 性质测试：incremental 随机工作集 × 多预算；分量划分与预算无关', () => {
    for (const seed of [3, 11, 99]) {
      const rand = lcg(seed);
      const ws = randomWorkset(rand, 10);
      const tokens = [...ws.keys()];
      // 基线文档：把源两两分组共享，形成若干连通分量
      const baseDocs: Array<{ path: string; sources: string[] }> = [];
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        baseDocs.push({ path: `doc${i}.md`, sources: [tokens[i], tokens[i + 1]] });
      }
      const groupOf = (units: ReturnType<typeof planUnits>): string[][] =>
        units.map((u) => [...u.sources].sort()).sort();
      let baselineGrouping: string[][] | null = null;
      let baselineAffected: string[] | null = null;
      for (const budget of [0, 4000, 40000, 250000]) {
        const units = planUnits({
          mode: 'incremental', workset: ws, baseDocs,
          requiredRewrites: baseDocs.map((d) => d.path), removedSources: [],
          batchSize: 3, wordBudget: budget,
        });
        assertPartitionInvariants(units, tokens);
        // 分量（源分组）、ownedDocs、affectedDocs 与预算无关
        if (baselineGrouping === null) {
          baselineGrouping = groupOf(units);
          baselineAffected = units.flatMap((u) => u.affectedDocs.map((d) => d.path)).sort();
        } else {
          expect(groupOf(units)).toEqual(baselineGrouping);
          expect(units.flatMap((u) => u.affectedDocs.map((d) => d.path)).sort()).toEqual(baselineAffected);
        }
        // 预算内批次字数 ≤ budget（超预算单源独占除外）
        if (budget > 0) {
          for (const unit of units) {
            for (const batch of unit.batches) {
              const sum = batch.reduce((acc, t) => acc + (ws.get(t)?.words ?? 0), 0);
              if (!batch.some((t) => (ws.get(t)?.words ?? 0) > budget)) expect(sum).toBeLessThanOrEqual(budget);
            }
          }
        }
      }
    }
  });

  it('full 模式：单元字数上限 = 预算×3（§2.6 工作集 → 2 单元，批内再按预算切）', () => {
    // relPath 排序后顺序 S1..S8；字数同 §2.6 算例
    const ws = workset({
      S1: ['a/01.md', 1, 3000], S2: ['a/02.md', 1, 2000], S3: ['a/03.md', 1, 35000],
      S4: ['a/04.md', 1, 8000], S5: ['a/05.md', 1, 70000], S6: ['a/06.md', 1, 1000],
      S7: ['a/07.md', 1, 1000], S8: ['a/08.md', 1, 30000],
    });
    const units = planUnits({
      mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [],
      batchSize: 10, wordBudget: 40000,
    });
    // 单元预算 120000：S1..S7 合计 120k（恰等）成单元 1；S8(30k) 单元 2
    expect(units.map((u) => u.sources)).toEqual([
      ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'],
      ['S8'],
    ]);
    // words 降序：单元1 120k 先于单元2 30k
    expect(units[0].words).toBe(120000);
    expect(units[1].words).toBe(30000);
    // 单元内批次按 §2.6 同一算例切分
    expect(units[0].batches).toEqual([
      ['S1', 'S2', 'S3'], ['S4'], ['S5'], ['S6', 'S7'],
    ]);
  });

  it('full 模式：budget=0 等价旧 chunk(sorted, batchSize×3)', () => {
    const ws = workset({
      A: ['d/1.md', 1], B: ['d/2.md', 1], C: ['d/3.md', 1], D: ['d/4.md', 1], E: ['d/5.md', 1], F: ['d/6.md', 1], G: ['d/7.md', 1],
    });
    const units = planUnits({
      mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [],
      batchSize: 1, wordBudget: 0, // 每单元 1×3=3 个源
    });
    expect(units.map((u) => u.sources)).toEqual([
      ['A', 'B', 'C'], ['D', 'E', 'F'], ['G'],
    ]);
    // wordBudget 缺省（不传）同 0
    const unitsNoBudget = planUnits({
      mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [], batchSize: 1,
    });
    expect(unitsNoBudget.map((u) => u.sources)).toEqual(units.map((u) => u.sources));
  });

  it('full 模式：个数上限 batchSize×3 在预算开启时仍保留', () => {
    const ws = workset({
      A: ['d/1.md', 1, 10], B: ['d/2.md', 1, 10], C: ['d/3.md', 1, 10],
      D: ['d/4.md', 1, 10], E: ['d/5.md', 1, 10], F: ['d/6.md', 1, 10], G: ['d/7.md', 1, 10],
    });
    const units = planUnits({
      mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [],
      batchSize: 1, wordBudget: 40000, // 预算远未超 → 仍按 3 个/单元切
    });
    expect(units.map((u) => u.sources.length)).toEqual([3, 3, 1]);
  });

  it('排序键：words 降序 → bytes 降序 → 原序', () => {
    // 三个簇 → 三个单元：W(100 词/1B) < X(100 词/5B) < Y(50 词/999B)
    const ws = workset({
      w1: ['w/1.md', 1, 100],
      x1: ['x/1.md', 5, 100],
      y1: ['y/1.md', 999, 50],
    });
    const units = planUnits({
      mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [],
      batchSize: 10, wordBudget: 0,
    });
    // words 并列 100 → bytes 降序（x 单元先）；50 词最后
    expect(units.map((u) => u.sources[0])).toEqual(['x1', 'w1', 'y1']);

    // words/bytes 全并列 → 原序（簇名字典序：a 先于 b）
    const ws2 = workset({ p: ['a/1.md', 7, 42], q: ['b/1.md', 7, 42] });
    const units2 = planUnits({
      mode: 'full', workset: ws2, baseDocs: [], requiredRewrites: [], removedSources: [],
      batchSize: 10, wordBudget: 0,
    });
    expect(units2.map((u) => u.sources[0])).toEqual(['p', 'q']);
  });

  it('无 words 元数据 + 预算开启 → 行为同旧 chunk、unit.words=0（兼容旧调用方）', () => {
    const ws = workset({
      A: ['d/1.md', 1], B: ['d/2.md', 1], C: ['d/3.md', 1], D: ['d/4.md', 1], E: ['d/5.md', 1],
    });
    const units = planUnits({
      mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [],
      batchSize: 2, wordBudget: 40000,
    });
    expect(units).toHaveLength(1); // 全 0 字 → 单元预算永不触发，仅个数上限生效
    expect(units[0].words).toBe(0);
    expect(units[0].batches).toEqual([['A', 'B'], ['C', 'D'], ['E']]);
  });

  it('单 worker 与并行路径同一装箱：单一单元时 unit.batches === 单进程全局批切分', () => {
    const ws = workset({
      A: ['d/1.md', 10, 3000], B: ['d/2.md', 20, 2000], C: ['d/3.md', 30, 35000],
      D: ['d/4.md', 40, 8000], E: ['d/5.md', 50, 70000], F: ['d/6.md', 60, 1000], G: ['d/7.md', 70, 1000], H: ['d/8.md', 80, 30000],
    });
    const budget = 50000; // 总 150k = 单元预算 150k → 恰成一个单元
    const batchSize = 10;
    // 并行路径（full 单簇 → 单单元，makeUnit 内 packBatches 切批）
    const units = planUnits({
      mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [],
      batchSize, wordBudget: budget,
    });
    expect(units).toHaveLength(1);
    // 单 worker 路径的批切分：[...workset.keys()].sort() + packBatches（同一算法）
    const singleWorkerBatches = packBatches(
      [...ws.keys()].sort(),
      (t) => ws.get(t)?.words ?? 0,
      { wordBudget: budget, maxCount: batchSize },
    );
    expect(units[0].batches).toEqual(singleWorkerBatches);
    expect(units[0].batches).toEqual([
      ['A', 'B', 'C', 'D'], // 48k ≤ 50k；下一个 70k 超预算
      ['E'],               // 70k 单源超预算，独占
      ['F', 'G', 'H'],     // 32k：工作集结束
    ]);
  });

  it('BuildUnit.words = 单元内源有效字数合计', () => {
    const ws = workset({
      A: ['d/1.md', 10, 1200], B: ['d/2.md', 20, 3400], C: ['d/3.md', 30, 56],
    });
    const units = planUnits({
      mode: 'full', workset: ws, baseDocs: [], requiredRewrites: [], removedSources: [],
      batchSize: 10, wordBudget: 0,
    });
    expect(units).toHaveLength(1);
    expect(units[0].words).toBe(4656);
    expect(units[0].bytes).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// effectiveWords（§2.2 有效字数口径）
// ---------------------------------------------------------------------------

describe('effectiveWords（§2.2）', () => {
  it('源正文 + 已描述图片文本；unavailable / 空文本不计；正文不可读计 0', () => {
    const content = '# 标题\n\n正文包含中文与 English words。';
    const base = effectiveWords({ content });
    expect(base).toBe(countText(content).words);
    // 两张已描述图片 + 一张 unavailable + 一张空文本 → 只计前两张
    const withImages = effectiveWords({
      content,
      imageDescriptions: [
        { state: 'described', text: '截图展示了战斗公式的推导过程' },
        { state: 'cached', text: 'flow chart of damage calculation' },
        { state: 'unavailable', text: '不应计入的失败占位文本' },
        { state: 'described', text: '' },
      ],
    });
    expect(withImages).toBe(
      countText(content).words
        + countText('截图展示了战斗公式的推导过程').words
        + countText('flow chart of damage calculation').words,
    );
    // 正文不可读（null）→ 仅图片项
    expect(effectiveWords({
      content: null,
      imageDescriptions: [{ state: 'described', text: '只有图片' }],
    })).toBe(countText('只有图片').words);
    // 空输入
    expect(effectiveWords({ content: null })).toBe(0);
  });

  it('头部注释不计入正文（countText 口径透传）', () => {
    const withHeader = '<!--\nfeishu_sync:\n  obj_token: t\n-->\n规则正文六字';
    expect(effectiveWords({ content: withHeader })).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// buildBatchWordBudget 配置钳制（§2.5，经 ConfigManager.load）
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('standardKb.buildBatchWordBudget 钳制（§2.5）', () => {
  async function loadWith(budget: unknown): Promise<number> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2s2-cfg-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      llm: {
        openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm',
        temperature: 0.2, primaryChannel: 'direct', fallbackOnFailure: false,
      },
      standardKb: { buildBatchWordBudget: budget },
      watchedRoots: [],
    }));
    const config = await new ConfigManager(configPath).load();
    return config.standardKb.buildBatchWordBudget;
  }

  it('缺失/非数字 → 缺省 40000；0 与负数 → 0', async () => {
    expect(await loadWith(undefined)).toBe(40000);
    expect(await loadWith('40000')).toBe(40000);
    expect(await loadWith(null)).toBe(40000);
    expect(await loadWith(0)).toBe(0);
    expect(await loadWith(-5)).toBe(0);
  });

  it('[4000, 400000] 越界钳制到边界；区间内取整', async () => {
    expect(await loadWith(2000)).toBe(4000);
    expect(await loadWith(3999.7)).toBe(4000);
    expect(await loadWith(4000)).toBe(4000);
    expect(await loadWith(40500.9)).toBe(40500);
    expect(await loadWith(400000)).toBe(400000);
    expect(await loadWith(999999)).toBe(400000);
  });

  it('缺省值来自 buildDefaultStandardKbConfig（40000，与新库默认一致）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2s2-cfg-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ watchedRoots: [] }));
    const config = await new ConfigManager(configPath).load();
    expect(config.standardKb.buildBatchWordBudget).toBe(40000);
    expect(config.standardKb.buildBatchSize).toBe(10);
  });
});
