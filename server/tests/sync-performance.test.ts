import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CliCommandQueue, isParallelCliRead } from '../src/modules/cli-command-queue.js'
import { withSyncPerformance, scopedRead } from '../src/modules/sync-performance.js'
import { versionedSheetRead } from '../src/modules/versioned-sheet-cache.js'
import { resolveDataRoot } from '../src/modules/data-root.js'
import { scheduleSnapshotRefresh, flushSnapshotRefresh } from '../src/modules/snapshot-refresh.js'
import { LarkCliClient } from '../src/modules/lark-cli-client.js'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-performance-'))
  vi.stubEnv('FEISHU_SYNC_HOME', home)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})
const tick = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve()
}

it('overlaps two reads, keeps FIFO exclusive writes and releases failed commands', async () => {
  const queue = new CliCommandQueue()
  const order: string[] = []
  let releaseA!: () => void, releaseB!: () => void
  const a = queue.run(true, async () => {
    order.push('a')
    await new Promise<void>((resolve) => {
      releaseA = resolve
    })
  })
  const b = queue.run(true, async () => {
    order.push('b')
    await new Promise<void>((resolve) => {
      releaseB = resolve
    })
  })
  const write = queue
    .run(false, async () => {
      order.push('write')
      throw new Error('failure')
    })
    .catch(() => undefined)
  const after = queue.run(true, async () => {
    order.push('after')
  })
  await tick()
  expect(order).toEqual(['a', 'b'])
  releaseA()
  await a
  await tick()
  expect(order).toEqual(['a', 'b'])
  releaseB()
  await Promise.all([b, write, after])
  expect(order).toEqual(['a', 'b', 'write', 'after'])
  expect(isParallelCliRead(['docs', '+update'])).toBe(false)
  expect(isParallelCliRead(['sheets', '+cells-get'])).toBe(true)
})

it('reuses workbook metadata in one document but always performs fresh version checks', async () => {
  const client = new LarkCliClient({ requiredScopes: [] })
  const execute = vi.spyOn(client, 'execute').mockResolvedValue({ data: { revision: 41 } })
  const measured = await withSyncPerformance('scoped-meta', async () => {
    await client.getWorkbookInfo('token')
    await client.getWorkbookInfo('token')
    await client.getWorkbookInfo('token', true)
    return true
  })
  expect(execute).toHaveBeenCalledTimes(2)
  expect(measured.performance.cacheHits).toBe(1)
})

it('keeps global and sheet rate ceilings with two active read slots', async () => {
  vi.useFakeTimers()
  const calls: Array<{ at: number; type: string }> = []
  const client = new LarkCliClient({ requiredScopes: [] })
  ;(client as any).execLarkCli = async (args: string[]) => {
    calls.push({ at: Date.now(), type: args[0] })
    return {}
  }
  const pending = ['sheets', 'sheets', 'docs', 'docs', 'sheets', 'sheets'].map((type) =>
    client.execute(
      [type, type === 'sheets' ? '+cells-get' : '+fetch'],
      type === 'sheets' ? 'sheets' : 'docx',
    ),
  )
  await vi.runAllTimersAsync()
  await Promise.all(pending)
  expect(calls).toHaveLength(6)
  for (const call of calls) {
    const window = calls.filter((other) => other.at >= call.at && other.at < call.at + 1000)
    expect(window.length).toBeLessThanOrEqual(3)
    expect(window.filter((other) => other.type === 'sheets').length).toBeLessThanOrEqual(2)
  }
})

it('caches only matching-version successful pages, separates formulas and rejects corrupted entries', async () => {
  const options = { spreadsheetToken: 'cache-fixture', sheetId: 's', range: 'A1:B1', revision: 41 }
  const read = vi.fn(async () => ({
    data: {
      revision: 41,
      has_more: false,
      ranges: [
        {
          actual_range: 'A1:B1',
          truncated: false,
          row_indices: [1],
          col_indices: ['A', 'B'],
          cells: [[{}, {}]],
        },
      ],
    },
  }))
  const run = () => withSyncPerformance('cache-fixture', () => versionedSheetRead(options, read))
  await run()
  const cached = await run()
  expect(read).toHaveBeenCalledTimes(1)
  expect(cached.performance.cacheHits).toBe(1)
  await withSyncPerformance('cache-fixture', () =>
    versionedSheetRead({ ...options, formulas: true }, read),
  )
  expect(read).toHaveBeenCalledTimes(2)
  const mismatch = vi.fn(async () => ({ data: { revision: 41, has_more: false } }))
  await withSyncPerformance('cache-fixture', () =>
    versionedSheetRead({ ...options, revision: 42 }, mismatch),
  )
  await withSyncPerformance('cache-fixture', () =>
    versionedSheetRead({ ...options, revision: 42 }, mismatch),
  )
  expect(mismatch).toHaveBeenCalledTimes(2)
  const incomplete = vi.fn(async () => ({
    data: {
      revision: 43,
      has_more: false,
      ranges: [{ actual_range: 'A1:B1', row_indices: [1], col_indices: ['A'], cells: [[{}]] }],
    },
  }))
  for (let n = 0; n < 2; n++)
    await withSyncPerformance('cache-fixture', () =>
      versionedSheetRead({ ...options, revision: 43 }, incomplete),
    )
  expect(incomplete).toHaveBeenCalledTimes(2)
  for (const file of fs.readdirSync(path.join(resolveDataRoot(), 'sync-cache')))
    fs.writeFileSync(path.join(resolveDataRoot(), 'sync-cache', file), '{}')
  await run()
  expect(read).toHaveBeenCalledTimes(3)
})

it('does not retain failed same-run reads', async () => {
  let calls = 0
  await withSyncPerformance('retry', async () => {
    await scopedRead('f', async () => {
      calls++
      throw new Error('temporary')
    }).catch(() => undefined)
    await scopedRead('f', async () => {
      calls++
      return true
    })
  })
  expect(calls).toBe(2)
})

it('coalesces snapshot writes and refreshes abandoned batches automatically', () => {
  vi.useFakeTimers()
  const refresh = vi.fn()
  scheduleSnapshotRefresh('fixture-root', refresh)
  scheduleSnapshotRefresh('fixture-root', refresh)
  flushSnapshotRefresh('fixture-root')
  expect(refresh).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(60_000)
  expect(refresh).toHaveBeenCalledTimes(1)
  scheduleSnapshotRefresh('fixture-root', refresh)
  vi.advanceTimersByTime(60_000)
  expect(refresh).toHaveBeenCalledTimes(2)
})
