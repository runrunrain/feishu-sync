import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataRoot } from './data-root.js'
import { CliCommandQueue } from './cli-command-queue.js'

export interface SyncPerformance {
  elapsedMs: number
  phasesMs: Record<string, number>
  cliCalls: number
  queueMs: number
  throttleMs: number
  executionMs: number
  cacheHits: number
}
interface Scope {
  metrics: SyncPerformance
  reads: Map<string, Promise<any>>
  media: Map<string, { bytes: Buffer; extension: string }>
  mediaBytes: number
}
const storage = new AsyncLocalStorage<Scope>()
const documents = new CliCommandQueue()
export const syncScope = () => storage.getStore()
export function recordSyncDuration(phase: string, started: number) {
  const scope = syncScope()
  if (scope)
    scope.metrics.phasesMs[phase] =
      (scope.metrics.phasesMs[phase] ?? 0) + performance.now() - started
}
export async function measureSyncPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const scope = syncScope()
  const started = performance.now()
  try {
    return await work()
  } finally {
    if (scope)
      scope.metrics.phasesMs[phase] =
        (scope.metrics.phasesMs[phase] ?? 0) + performance.now() - started
  }
}
export async function scopedRead<T>(key: string, work: () => Promise<T>): Promise<T> {
  const scope = syncScope()
  if (!scope) return work()
  const cached = scope.reads.get(key)
  if (cached) {
    scope.metrics.cacheHits++
    return cached
  }
  const pending = work()
  scope.reads.set(key, pending)
  try {
    return await pending
  } catch (error) {
    scope.reads.delete(key)
    throw error
  }
}
export async function withSyncPerformance<T>(
  objToken: string,
  work: () => Promise<T>,
): Promise<{ value: T; performance: SyncPerformance }> {
  const metrics: SyncPerformance = {
    elapsedMs: 0,
    phasesMs: {},
    cliCalls: 0,
    queueMs: 0,
    throttleMs: 0,
    executionMs: 0,
    cacheHits: 0,
  }
  const started = performance.now()
  return documents.run(true, () =>
    storage.run({ metrics, reads: new Map(), media: new Map(), mediaBytes: 0 }, async () => {
      metrics.phasesMs.admission = performance.now() - started
      let success = false
      try {
        const value = await work()
        success = true
        return { value, performance: metrics }
      } finally {
        metrics.elapsedMs = performance.now() - started
        try {
          const root = resolveDataRoot()
          fs.mkdirSync(root, { recursive: true })
          const file = path.join(root, 'sync-performance.jsonl')
          if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024)
            fs.renameSync(file, `${file}.previous`)
          fs.appendFileSync(
            file,
            JSON.stringify({ at: new Date().toISOString(), objToken, success, ...metrics }) + '\n',
          )
        } catch {
          /* Diagnostic IO cannot affect a content transaction. */
        }
      }
    }),
  )
}
