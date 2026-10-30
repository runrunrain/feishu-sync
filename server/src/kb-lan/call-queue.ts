/** Bounded fair admission, independent of pi process slots. */
export class KbBusyError extends Error {
  readonly code = 'kb_busy';
  readonly retryAfterMs = 1000;
  constructor() { super('知识库繁忙，请稍后重试'); }
}
interface Waiting {
  session: string; regex: boolean; enqueued: number;
  run: (queueMs: number) => void; reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class LanCallQueue {
  inflight = 0;
  private regexActive = false;
  private active = new Map<string, number>();
  private waiting: Waiting[] = [];
  private closed = false;
  constructor(private limits = { global: 4, session: 2, queued: 32, waitMs: 10_000 }) {}
  get queued(): number { return this.waiting.length; }
  run<T>(session: string, regex: boolean, execute: (queueMs: number) => Promise<T>): Promise<T> {
    if (this.closed || this.waiting.length >= this.limits.queued) return Promise.reject(new KbBusyError());
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        session, regex, enqueued: performance.now(), reject,
        timer: setTimeout(() => { this.waiting = this.waiting.filter((e) => e !== entry); reject(new KbBusyError()); this.drain(); }, this.limits.waitMs),
        run: (queueMs) => {
          this.inflight++;
          this.active.set(session, (this.active.get(session) ?? 0) + 1);
          if (regex) this.regexActive = true;
          Promise.resolve().then(() => execute(queueMs)).then(resolve, reject).finally(() => {
            this.inflight--;
            const count = (this.active.get(session) ?? 1) - 1;
            if (count) this.active.set(session, count); else this.active.delete(session);
            if (regex) this.regexActive = false;
            this.drain();
          });
        },
      };
      this.waiting.push(entry);
      this.drain();
    });
  }
  private drain(): void {
    while (this.inflight < this.limits.global) {
      // Oldest eligible request; a saturated session never head-of-line blocks
      // another client, and eligible requests never overtake their predecessor.
      const i = this.waiting.findIndex((e) => (this.active.get(e.session) ?? 0) < this.limits.session && (!e.regex || !this.regexActive));
      if (i < 0) break;
      const [entry] = this.waiting.splice(i, 1);
      clearTimeout(entry.timer);
      entry.run(performance.now() - entry.enqueued);
    }
  }
  cancelSession(session: string): void {
    for (const entry of this.waiting.filter((e) => e.session === session)) { clearTimeout(entry.timer); entry.reject(new KbBusyError()); }
    this.waiting = this.waiting.filter((e) => e.session !== session);
  }
  close(): void { this.closed = true; for (const e of this.waiting) { clearTimeout(e.timer); e.reject(new KbBusyError()); } this.waiting = []; }
}
