import type { KbIndex } from './index-types.js';
/** Settled indexes: at most two, LRU. Pending work is separately deduplicated, including across evictions. */
export class KbIndexCache {
  private readonly ready = new Map<string, KbIndex>();
  private readonly pending = new Map<string, Promise<KbIndex>>();
  get size(): number { return this.ready.size; }
  get pendingCount(): number { return this.pending.size; }
  keys(): string[] { return [...this.ready.keys()]; }
  get(key: string, build: () => Promise<KbIndex>): Promise<KbIndex> {
    const cached = this.ready.get(key);
    if (cached) { this.ready.delete(key); this.ready.set(key, cached); return Promise.resolve(cached); }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(build).then((index) => {
      this.ready.set(key, index);
      while (this.ready.size > 2) this.ready.delete(this.ready.keys().next().value!);
      return index;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }
  delete(key: string): void { this.ready.delete(key); }
}
