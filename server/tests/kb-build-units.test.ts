/**
 * build-units 单测（S4 §4.2：单元划分纯函数）
 *
 * 覆盖：增量连通分量（跨源文档合并分量、ownedDocs 预认领、纯删除保底
 * 空单元）、全量目录聚类（_custom/<文件夹> 视为一级、batchSize×3 切块）、
 * LPT 拉取序（bytes 降序）、单元内批次切分。
 */

import { describe, expect, it } from 'vitest';
import { directoryClusterKey, planUnits } from '../src/kb/build-units.js';

function workset(entries: Record<string, [string, number]>): Map<string, { relPath: string; bytes: number }> {
  return new Map(Object.entries(entries).map(([token, [relPath, bytes]]) => [token, { relPath, bytes }]));
}

describe('planUnits · incremental（文档↔源连通分量）', () => {
  it('无共享文档的源 → 各自成单元；跨源文档把分量合并', () => {
    // tokenA 与 tokenB 无共享文档 → 2 单元
    let units = planUnits({
      mode: 'incremental',
      workset: workset({ A: ['a/a.md', 100], B: ['b/b.md', 50] }),
      baseDocs: [],
      requiredRewrites: [],
      removedSources: [],
      batchSize: 10,
    });
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.sources).flat().sort()).toEqual(['A', 'B']);

    // 文档 X 同时引用 A、B → 分量合并为 1 个单元（大分量不拆）
    units = planUnits({
      mode: 'incremental',
      workset: workset({ A: ['a/a.md', 100], B: ['b/b.md', 50] }),
      baseDocs: [{ path: 'X.md', sources: ['A', 'B'] }],
      requiredRewrites: ['X.md'],
      removedSources: [],
      batchSize: 10,
    });
    expect(units).toHaveLength(1);
    expect(units[0].sources.sort()).toEqual(['A', 'B']);
    expect(units[0].ownedDocs).toEqual(['X.md']);
  });

  it('仅引用已删除源的文档 → deletedByDefault，不进 ownedDocs；混合文档进 ownedDocs', () => {
    const units = planUnits({
      mode: 'incremental',
      workset: workset({ A: ['a/a.md', 10] }),
      baseDocs: [
        { path: '删除.md', sources: ['GONE'] },        // 全删 → 默认删除
        { path: '混合.md', sources: ['GONE', 'A'] },   // 部分删 → 保留需重写
      ],
      requiredRewrites: ['混合.md'],
      removedSources: ['GONE'],
      batchSize: 10,
    });
    expect(units).toHaveLength(1); // GONE 通过「混合.md」并入 A 的分量
    const unit = units[0];
    expect(unit.ownedDocs).toEqual(['混合.md']);
    const affected = new Map(unit.affectedDocs.map((doc) => [doc.path, doc]));
    expect(affected.get('删除.md')?.deletedByDefault).toBe(true);
    expect(affected.get('混合.md')?.deletedByDefault).toBe(false);
  });

  it('仅有删除（无工作集源）→ 保底一个空单元（对应现状保底空批）', () => {
    const units = planUnits({
      mode: 'incremental',
      workset: new Map(),
      baseDocs: [{ path: '删除.md', sources: ['GONE'] }],
      requiredRewrites: [],
      removedSources: ['GONE'],
      batchSize: 10,
    });
    expect(units).toHaveLength(1);
    expect(units[0].sources).toEqual([]);
    expect(units[0].batches).toEqual([[]]);
    expect(units[0].affectedDocs.map((doc) => doc.path)).toEqual(['删除.md']);
  });

  it('单元内批次按 batchSize 切分；返回序按 bytes 降序（LPT 拉取）', () => {
    // S1..S4 经共享文档合为一个分量；T1 独立分量
    const units = planUnits({
      mode: 'incremental',
      workset: workset({
        S1: ['a/s1.md', 10], S2: ['a/s2.md', 20], S3: ['a/s3.md', 30], S4: ['a/s4.md', 40],
        T1: ['b/t1.md', 500],
      }),
      baseDocs: [{ path: '合.md', sources: ['S1', 'S2', 'S3', 'S4'] }],
      requiredRewrites: ['合.md'],
      removedSources: [],
      batchSize: 2,
    });
    expect(units).toHaveLength(2);
    expect(units[0].sources).toEqual(['T1']); // bytes 最大先被拉取
    const aUnit = units.find((unit) => unit.sources.includes('S1'))!;
    expect(aUnit.batches).toHaveLength(2); // 4 源 / batchSize 2
    expect(aUnit.batches[0]).toEqual(['S1', 'S2']);
    expect(aUnit.batches[1]).toEqual(['S3', 'S4']);
    expect(aUnit.ownedDocs).toEqual(['合.md']);
  });
});

describe('planUnits · full（relPath 一级目录聚类）', () => {
  it('一级目录聚类；_custom/<文件夹> 视为一级；每 batchSize×3 个源切一单元', () => {
    const entries: Record<string, [string, number]> = {
      R1: ['根文档1.md', 5],
      R2: ['战斗/a.md', 1], R3: ['战斗/b.md', 1], R4: ['战斗/c.md', 1], R5: ['战斗/d.md', 1],
      C1: ['_custom/资料/x.md', 1], C2: ['_custom/资料/y.md', 1], C3: ['_custom/其他/z.md', 1],
    };
    const units = planUnits({
      mode: 'full',
      workset: workset(entries),
      baseDocs: [],
      requiredRewrites: [],
      removedSources: [],
      batchSize: 1, // 每单元 1×3=3 个源
    });
    // 根(1) | 战斗(4→2单元) | _custom/资料(2) | _custom/其他(1)
    const byCluster = new Map(units.map((unit) => [directoryClusterKey(entries[unit.sources[0]][0]), unit.sources.length]));
    expect(byCluster.get('(root)')).toBe(1);
    expect(units.filter((unit) => unit.sources.every((token) => entries[token][0].startsWith('战斗/'))).map((unit) => unit.sources.length)).toEqual([3, 1]);
    expect(byCluster.get('_custom/资料')).toBe(2);
    expect(byCluster.get('_custom/其他')).toBe(1);
    expect(units.every((unit) => unit.ownedDocs.length === 0)).toBe(true); // full 无既有文档
  });

  it('空 workset → 无单元（full 零源走收尾轮，发布空库由校验拦截）', () => {
    expect(planUnits({
      mode: 'full', workset: new Map(), baseDocs: [], requiredRewrites: [], removedSources: [], batchSize: 10,
    })).toEqual([]);
  });
});

describe('directoryClusterKey', () => {
  it('根文件 / 一级目录 / _custom 二级', () => {
    expect(directoryClusterKey('a.md')).toBe('(root)');
    expect(directoryClusterKey('战斗/规则.md')).toBe('战斗');
    expect(directoryClusterKey('战斗/子/规则.md')).toBe('战斗');
    expect(directoryClusterKey('_custom/资料/x.md')).toBe('_custom/资料');
    expect(directoryClusterKey('_custom/x.md')).toBe('_custom'); // _custom 根下散档归 _custom 键
  });
});
