/** FIFO reads may overlap; a mutation is an exclusive barrier. */
export class CliCommandQueue {
  private active = 0
  private exclusive = false
  private pending: Array<{ read: boolean; start: () => void }> = []
  run<T>(read: boolean, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        read,
        start: () => {
          this.active++
          if (!read) this.exclusive = true
          void Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              this.active--
              if (!read) this.exclusive = false
              this.drain()
            })
        },
      })
      this.drain()
    })
  }
  private drain() {
    while (!this.exclusive && this.pending.length && this.active < 2) {
      const next = this.pending[0]
      if (!next.read && this.active) return
      this.pending.shift()
      next.start()
    }
  }
}
// Deliberate allowlist: unknown commands and auth changes remain exclusive.
export function isParallelCliRead(args: string[]): boolean {
  return (
    (args[0] === 'sheets' &&
      [
        '+workbook-info',
        '+workbook-export',
        '+sheet-info',
        '+cells-get',
        '+csv-get',
        '+float-image-list',
        '+chart-list',
      ].includes(args[1])) ||
    (args[0] === 'docs' && ['+fetch', '+media-download', '+media-preview'].includes(args[1]))
  )
}
