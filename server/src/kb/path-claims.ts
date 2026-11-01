/**
 * PathClaims — 构建内路径认领（设计 §4.3，S4）
 *
 * 同一路径只允许一个单元写：worker 上下文的 kb_write_doc / kb_delete_doc
 * 先 claim；首写者认领，单元重试不释放（认领只存内存，构建结束即销毁）。
 * 收尾轮（phase='final'）不受限制，可合并/删除任意 staging 文档——
 * 判定在 agent-tool-service 的写工具处做，本类只提供权威账本。
 */

export interface PathClaimPreload {
  path: string;
  unitId: string;
}

export type ClaimResult = { ok: true } | { ok: false; owner: string };

export class PathClaims {
  private readonly owners = new Map<string, string>();

  constructor(preclaimed: PathClaimPreload[] = []) {
    for (const claim of preclaimed) this.owners.set(claim.path, claim.unitId);
  }

  /**
   * 认领路径：首次认领者获胜（含 planUnits 预认领）；同单元重复认领幂等
   * 成功；他单元路径 → { ok:false, owner }（owner 为持有单元 id）。
   */
  claim(path: string, unitId: string): ClaimResult {
    const owner = this.owners.get(path);
    if (owner === undefined) {
      this.owners.set(path, unitId);
      return { ok: true };
    }
    if (owner === unitId) return { ok: true };
    return { ok: false, owner };
  }

  /** 当前持有者（未认领返回 null）。 */
  ownerOf(path: string): string | null {
    return this.owners.get(path) ?? null;
  }

  /** 某单元当前持有的全部路径（收尾轮提示/诊断用）。 */
  ownedBy(unitId: string): string[] {
    const result: string[] = [];
    for (const [path, owner] of this.owners) {
      if (owner === unitId) result.push(path);
    }
    return result.sort();
  }

  /** v2（设计 v2 §4.2）：释放单条认领（输出分配收回/撤销时同步；未认领
   * 时 no-op）。持有者从构建单元扩展到任务身份（ownerId 语义不变）。 */
  release(path: string): void {
    this.owners.delete(path);
  }

  /** v2（§4.2）：认领转移（续接继承/输出分配转移：新持有者接替旧持有者
 * 对同一路径的认领；路径未被认领时等价于 claim）。 */
  reassign(path: string, newOwnerId: string): void {
    this.owners.set(path, newOwnerId);
  }

  /** v2（§4.2）：按持有者释放全部认领（任务撤销时同步）。 */
  releaseAllBy(ownerId: string): number {
    let count = 0;
    for (const [path, owner] of this.owners) {
      if (owner === ownerId) {
        this.owners.delete(path);
        count += 1;
      }
    }
    return count;
  }

  /** 已认领路径总数。 */
  get size(): number {
    return this.owners.size;
  }
}
