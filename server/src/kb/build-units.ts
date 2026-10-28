/**
 * build-units — 并行构建工作单元划分（设计 §4.2，S4）
 *
 * 单元划分是纯函数：
 * - incremental：「文档↔源」二部图连通分量。工作集源与受影响文档所在
 *   分量为一个单元；分量内仍在 staging 的已有文档路径进 ownedDocs
 *   （预认领，防跨单元写冲突）。大分量不拆（正确性优先：同一已有文档
 *   只被一个单元改写）。
 * - full：按 relPath 一级目录聚类（`_custom/<文件夹>` 视为一级），目录内
 *   按 relPath 排序，每 batchSize×3 个源切一单元；ownedDocs 为空
 *   （full 从空 staging 重建，无既有文档需要认领）。
 * - 仅有删除的增量保底一个空单元（对应现状保底空批：删除影响必须明确
 *   告知模型，不能只存在于默认删除逻辑里）。
 *
 * 单元 id 稳定（u1、u2…按首源 relPath 排序）；返回顺序按 bytes 降序
 * （LPT：worker 拉取式调度从最大单元开始）。
 */

export interface BuildUnitDocRef {
  path: string;
  title: string;
  /** true = 仅引用已删除源、已被默认删除（提示模型可重建） */
  deletedByDefault?: boolean;
}

export interface BuildUnit {
  id: string;
  /** 本单元要处理的源（objToken，单元内批次按此切分） */
  sources: string[];
  /** 分量内仍在 staging 的已有文档路径（预认领进 PathClaims） */
  ownedDocs: string[];
  /** 分量涉及的受影响文档（含默认删除的），供单元提示词使用 */
  affectedDocs: BuildUnitDocRef[];
  bytes: number;
  batches: string[][];
}

export interface PlanUnitsInput {
  mode: 'full' | 'incremental';
  /** objToken → 元数据（relPath/bytes 来自快照） */
  workset: Map<string, { relPath: string; bytes: number }>;
  /** incremental：CURRENT manifest.docs（path + sources） */
  baseDocs: Array<{ path: string; sources: string[] }>;
  /** 基线文档标题（path → title；无则用 path） */
  baseDocTitles?: Map<string, string>;
  /** 受删除源影响需重写的文档（仍在 staging 的） */
  requiredRewrites: string[];
  /** 本轮删除的源（含被排除标记导致的移除） */
  removedSources: string[];
  /** standardKb.buildBatchSize（单元内每批源数） */
  batchSize: number;
}

/** relPath 一级目录键；`_custom/<文件夹>` 视为一级（自定义归档整夹一组）。 */
export function directoryClusterKey(relPath: string): string {
  const segments = relPath.split('/');
  if (segments.length <= 1) return '(root)';
  if (segments[0] === '_custom' && segments.length > 2) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/** 极简并查集（string 键）。 */
class UnionFind {
  private readonly parent = new Map<string, string>();

  find(key: string): string {
    let root = this.parent.get(key) ?? key;
    while (root !== (this.parent.get(root) ?? root)) root = this.parent.get(root)!;
    this.parent.set(key, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function planUnits(input: PlanUnitsInput): BuildUnit[] {
  const batchSize = Math.max(1, input.batchSize);

  if (input.mode === 'full') {
    const clusters = new Map<string, string[]>();
    for (const [token, meta] of [...input.workset.entries()].sort((a, b) => a[1].relPath.localeCompare(b[1].relPath))) {
      const key = directoryClusterKey(meta.relPath);
      const bucket = clusters.get(key) ?? [];
      bucket.push(token);
      clusters.set(key, bucket);
    }
    const units: BuildUnit[] = [];
    for (const [key, tokens] of [...clusters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      // 目录内按 relPath 排序后每 batchSize×3 个源切一单元
      const sorted = tokens
        .map((token) => ({ token, relPath: input.workset.get(token)!.relPath }))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))
        .map((item) => item.token);
      const perUnit = Math.max(1, batchSize * 3);
      for (const sources of chunk(sorted, perUnit)) {
        units.push(makeUnit(units.length, sources, input, [], []));
      }
      void key;
    }
    return sortByBytesDesc(units);
  }

  // ---- incremental：文档↔源 二部图连通分量 ----
  const worksetTokens = new Set(input.workset.keys());
  const removedSet = new Set(input.removedSources);
  const graphSources = new Set<string>([...worksetTokens, ...removedSet]);
  const requiredSet = new Set(input.requiredRewrites);
  const uf = new UnionFind();
  // 受影响文档 = sources ∩ (workset ∪ removed) 非空；或本身在 requiredRewrites。
  // 先建图（union），分量归属在全部 union 完成后再解析——中途的 root
  // 可能被后续 union 链改写，插入时记账会错桶。
  const affected: BuildUnitDocRef[] = [];
  for (const doc of input.baseDocs) {
    const linked = doc.sources.filter((token) => graphSources.has(token));
    if (linked.length === 0 && !requiredSet.has(doc.path)) continue;
    for (const token of linked) uf.union(`doc:${doc.path}`, `src:${token}`);
    const onlyRemoved = doc.sources.length > 0 && doc.sources.every((token) => removedSet.has(token));
    affected.push({
      path: doc.path,
      title: input.baseDocTitles?.get(doc.path) ?? doc.path,
      deletedByDefault: onlyRemoved && !requiredSet.has(doc.path),
    });
  }
  const affectedByComponent = new Map<string, BuildUnitDocRef[]>();
  const deletedDocsByComponent = new Map<string, BuildUnitDocRef[]>();
  for (const ref of affected) {
    const root = uf.find(`doc:${ref.path}`);
    const sink = ref.deletedByDefault ? deletedDocsByComponent : affectedByComponent;
    const bucket = sink.get(root) ?? [];
    bucket.push(ref);
    sink.set(root, bucket);
  }

  // 分量 → 单元（只收含工作集源的分量；纯删除分量没有要处理的源）
  const sourcesByComponent = new Map<string, string[]>();
  for (const token of worksetTokens) {
    const root = uf.find(`src:${token}`);
    const bucket = sourcesByComponent.get(root) ?? [];
    bucket.push(token);
    sourcesByComponent.set(root, bucket);
  }

  const units: BuildUnit[] = [];
  for (const [root, sources] of sourcesByComponent) {
    const owned = (affectedByComponent.get(root) ?? [])
      .filter((doc) => requiredSet.has(doc.path) && !doc.deletedByDefault)
      .map((doc) => doc.path);
    const affectedDocs = [
      ...(affectedByComponent.get(root) ?? []),
      ...(deletedDocsByComponent.get(root) ?? []),
    ];
    units.push(makeUnit(units.length, sources.sort(), input, owned, affectedDocs));
  }

  // 仅有删除（或删除影响全部走默认删除）→ 保底一个空单元
  if (units.length === 0 && (affected.length > 0 || input.requiredRewrites.length > 0)) {
    units.push(makeUnit(0, [], input, [...input.requiredRewrites], affected));
  }

  return sortByBytesDesc(units);
}

function makeUnit(
  index: number,
  sources: string[],
  input: PlanUnitsInput,
  ownedDocs: string[],
  affectedDocs: BuildUnitDocRef[],
): BuildUnit {
  let bytes = 0;
  for (const token of sources) bytes += input.workset.get(token)?.bytes ?? 0;
  const sortedSources = [...sources].sort();
  return {
    id: `u${index + 1}`,
    sources: sortedSources,
    ownedDocs: [...ownedDocs].sort(),
    affectedDocs: affectedDocs.sort((a, b) => a.path.localeCompare(b.path)),
    bytes,
    // 空单元保底一个空批（对应现状保底空批：删除影响必须进 prompt）
    batches: sortedSources.length === 0 ? [[]] : chunk(sortedSources, Math.max(1, input.batchSize)),
  };
}

function sortByBytesDesc(units: BuildUnit[]): BuildUnit[] {
  return units
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => (b.unit.bytes - a.unit.bytes) || (a.index - b.index))
    .map((item) => item.unit);
}
