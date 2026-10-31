/**
 * build-units — 并行构建工作单元划分（设计 §4.2，S4）
 *
 * 单元划分是纯函数：
 * - incremental：「文档↔源」二部图连通分量。工作集源与受影响文档所在
 *   分量为一个单元；分量内仍在 staging 的已有文档路径进 ownedDocs
 *   （预认领，防跨单元写冲突）。大分量不拆（正确性优先：同一已有文档
 *   只被一个单元改写）。
 * - full：按 relPath 一级目录聚类（`_custom/<文件夹>` 视为一级），目录内
 *   按 relPath 排序后装箱切单元；ownedDocs 为空（full 从空 staging 重建，
 *   无既有文档需要认领）。
 * - 仅有删除的增量保底一个空单元（对应现状保底空批：删除影响必须明确
 *   告知模型，不能只存在于默认删除逻辑里）。
 *
 * P2-S2（U42/U44）：批与单元改为「有效字数预算装箱」——packBatches 为
 * 单 worker 与并行路径共用的纯函数（wordBudget=0 时等价旧按源数 chunk）；
 * full 模式单元切分用 预算×3 / 个数×3，incremental 连通分量不变；单元
 * 排序键改为 words 降序 → bytes 降序 → 原序（大单元先启动的目的不变）。
 * 不变量：任何预算下 ∪ unit.sources = 工作集且互不相交、∪ batches =
 * unit.sources、受影响文档集合不变（划分只改调度，不改构建语义）。
 *
 * 单元 id 稳定（u1、u2…按首源 relPath 排序）。
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
  /** D5（A 案 §7.2）：闭包文档的支撑源（只读输入）。它们不在工作集（未
   * 变化、不计云端新增/不进批次/不要求 skipped 去向），仅供单元核对与
   * 引用（raw_read 可读快照内任意源）。 */
  readOnlySources?: string[];
  bytes: number;
  /** P2-S2：单元内源的有效字数合计（调度排序键；不进 manifest/哈希） */
  words: number;
  batches: string[][];
}

export interface PlanUnitsInput {
  mode: 'full' | 'incremental';
  /** objToken → 元数据（relPath/bytes 来自快照；words 为 P2-S2 有效字数，缺省 0） */
  workset: Map<string, { relPath: string; bytes: number; words?: number }>;
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
  /** P2-S2：每批有效字数预算（standardKb.buildBatchWordBudget）。
   * 0/缺省 = 旧行为（按源数切分）；full 模式单元上限 = 该值 ×3。 */
  wordBudget?: number;
  /** D5（A 案 §7.2）闭包文档归属：requiredRewrites 中由影响闭包/决定/
   * 迁移种子纳入的文档及其支撑源。seedPath 给出时并入种子文档所在分量
   *（语义闭包沿边传播）；否则并入自身支撑源分量，分量无工作集源时由
   * 兼底/归并机制归属到可执行单元——闭包文档不能成孤儿（必须有人重写）。 */
  closureDocLinks?: Array<{ path: string; sources: string[]; seedPath?: string }>;
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

/**
 * P2-S2（§2.3）批装箱纯函数——单 worker 路径与 planUnits（并行）共用。
 *
 * - wordBudget <= 0 → 等价 chunk(orderedTokens, maxCount)（旧行为，兼容
 *   回退开关 buildBatchWordBudget=0）。
 * - 否则顺序贪心：当前批非空且（累计字数 + w > wordBudget 或 批长 ===
 *   maxCount）→ 封批；单源 w > wordBudget 自然独占一批（不拆源，raw_read
 *   既有分页承接超长源）。
 * - 保持输入顺序、只改边界（不重排）：构建日志与批次可复现。
 */
export function packBatches(
  orderedTokens: string[],
  words: (token: string) => number,
  opts: { wordBudget: number; maxCount: number },
): string[][] {
  const maxCount = Math.max(1, Math.floor(opts.maxCount));
  if (!(opts.wordBudget > 0)) return chunk(orderedTokens, maxCount);
  const batches: string[][] = [];
  let current: string[] = [];
  let cumulative = 0;
  for (const token of orderedTokens) {
    const w = Math.max(0, Math.floor(words(token)));
    if (current.length > 0 && (cumulative + w > opts.wordBudget || current.length >= maxCount)) {
      batches.push(current);
      current = [];
      cumulative = 0;
    }
    current.push(token);
    cumulative += w;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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
  const wordBudget = Math.max(0, Math.floor(input.wordBudget ?? 0));
  const wordsOf = (token: string): number => input.workset.get(token)?.words ?? 0;

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
      // 目录内按 relPath 排序后装箱切单元：字数预算 ×3 + 个数上限 batchSize×3
      // （U44；wordBudget=0 时等价旧 chunk(sorted, batchSize*3)）
      const sorted = tokens
        .map((token) => ({ token, relPath: input.workset.get(token)!.relPath }))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))
        .map((item) => item.token);
      const perUnit = Math.max(1, batchSize * 3);
      for (const sources of packBatches(sorted, wordsOf, { wordBudget: wordBudget * 3, maxCount: perUnit })) {
        units.push(makeUnit(units.length, sources, input, wordBudget, wordsOf, [], []));
      }
      void key;
    }
    return sortUnitsByLoadDesc(units);
  }

  // ---- incremental：文档↔源 二部图连通分量 ----
  const worksetTokens = new Set(input.workset.keys());
  const removedSet = new Set(input.removedSources);
  const graphSources = new Set<string>([...worksetTokens, ...removedSet]);
  const requiredSet = new Set(input.requiredRewrites);
  const uf = new UnionFind();
  // D5（A 案 §7.2）：闭包文档先并入归属分量——有 seedPath 的并入种子
  // 文档分量（语义闭包沿边传播到同一执行单元）；无 seedPath 的（决定/
  // 迁移种子）并入自身支撑源分量，无工作集源时由下方孤儿归并/兼底处理。
  const closureReadOnly = new Map<string, string[]>();
  for (const link of input.closureDocLinks ?? []) {
    closureReadOnly.set(link.path, [...new Set(link.sources)]);
    if (link.seedPath) {
      uf.union(`doc:${link.path}`, `doc:${link.seedPath}`);
    } else {
      for (const token of link.sources) uf.union(`doc:${link.path}`, `src:${token}`);
    }
  }
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
    // D5（A 案 §7.2）：分量内闭包文档的支撑源归入单元只读输入
    const readOnly = [...new Set(affectedDocs.flatMap((doc) => closureReadOnly.get(doc.path) ?? []))];
    units.push(makeUnit(units.length, sources.sort(), input, wordBudget, wordsOf, owned, affectedDocs, readOnly));
    void root;
  }

  // D5（A 案 §7.2）：孤儿闭包文档归并——requiredRewrites 中未被任何分量
  // 单元认领的文档（决定/迁移种子且自身源不在工作集），归并到首个单元
  //（负载最大单元，sortUnitsByLoadDesc 后）；否则由下方兼底空单元承接。
  // 不归并就没有执行者重写它们，闭包会静默失效。
  const ownedByUnits = new Set(units.flatMap((unit) => unit.ownedDocs));
  const orphanDocs = units.length > 0
    ? [...requiredSet].filter((docPath) => !ownedByUnits.has(docPath))
    : [];
  if (orphanDocs.length > 0) {
    const target = units[0]!;
    for (const docPath of orphanDocs) {
      target.ownedDocs.push(docPath);
      if (!target.affectedDocs.some((doc) => doc.path === docPath)) {
        target.affectedDocs.push({ path: docPath, title: input.baseDocTitles?.get(docPath) ?? docPath });
      }
    }
    target.readOnlySources = [...new Set([...(target.readOnlySources ?? []), ...orphanDocs.flatMap((docPath) => closureReadOnly.get(docPath) ?? [])])];
  }

  // 仅有删除（或删除影响全部走默认删除）→ 保底一个空单元
  if (units.length === 0 && (affected.length > 0 || input.requiredRewrites.length > 0)) {
    units.push(makeUnit(0, [], input, wordBudget, wordsOf, [...input.requiredRewrites], affected,
      [...new Set(input.requiredRewrites.flatMap((docPath) => closureReadOnly.get(docPath) ?? []))]));
  }

  return sortUnitsByLoadDesc(units);
}

function makeUnit(
  index: number,
  sources: string[],
  input: PlanUnitsInput,
  wordBudget: number,
  wordsOf: (token: string) => number,
  ownedDocs: string[],
  affectedDocs: BuildUnitDocRef[],
  readOnlySources?: string[],
): BuildUnit {
  let bytes = 0;
  let words = 0;
  for (const token of sources) {
    const meta = input.workset.get(token);
    bytes += meta?.bytes ?? 0;
    words += meta?.words ?? 0;
  }
  const sortedSources = [...sources].sort();
  return {
    id: `u${index + 1}`,
    sources: sortedSources,
    ownedDocs: [...ownedDocs].sort(),
    affectedDocs: affectedDocs.sort((a, b) => a.path.localeCompare(b.path)),
    ...(readOnlySources && readOnlySources.length > 0 ? { readOnlySources: [...new Set(readOnlySources)].sort() } : {}),
    bytes,
    words,
    // 空单元保底一个空批（对应现状保底空批：删除影响必须进 prompt）。
    // P2-S2：批次装箱与单 worker 路径同一 packBatches（wordBudget=0 等价旧 chunk）
    batches: sortedSources.length === 0
      ? [[]]
      : packBatches(sortedSources, wordsOf, { wordBudget, maxCount: Math.max(1, input.batchSize) }),
  };
}

/** 返回序（LPT 拉取）：words 降序 → bytes 降序 → 原序（U44 排序键）。 */
function sortUnitsByLoadDesc(units: BuildUnit[]): BuildUnit[] {
  return units
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => (b.unit.words - a.unit.words) || (b.unit.bytes - a.unit.bytes) || (a.index - b.index))
    .map((item) => item.unit);
}
