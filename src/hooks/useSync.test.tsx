// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({
  syncDocs: vi.fn(),
  flushSyncSnapshot: vi.fn(async () => {}),
  syncIndex: vi.fn(),
}))
vi.mock('../api/client', () => api)
import { SyncProvider, useSync } from './useSync'
import type { ChangedDocument, SyncResult } from '../types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('runs two workers, reports actual completed count and flushes the snapshot once', async () => {
  const resolvers: Array<(value: SyncResult) => void> = []
  api.syncDocs.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
  const docs = ['a', 'b', 'c'].map((objToken) => ({
    objToken,
    title: objToken,
  })) as ChangedDocument[]
  let latest: ReturnType<typeof useSync>
  function View() {
    latest = useSync()
    return <p>{latest.done}</p>
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = (id: string): SyncResult => ({
    success: true,
    syncedDocuments: [
      {
        objToken: id,
        title: id,
        localMdPath: `${id}.md`,
        cloudModifiedTime: '',
        size: 1,
        imagesCount: 0,
        attachmentsCount: 0,
        sheetsCount: 0,
      },
    ],
    failedDocuments: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    duration: 1,
  })
  try {
    await act(async () =>
      root.render(
        <SyncProvider>
          <View />
        </SyncProvider>,
      ),
    )
    let finished!: Promise<SyncResult | null>
    await act(async () => {
      finished = latest!.syncDocuments(docs)
    })
    expect(api.syncDocs).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolvers[1](result('b'))
    })
    expect(latest!.done).toBe(1)
    expect(api.syncDocs).toHaveBeenCalledTimes(3)
    expect(api.flushSyncSnapshot).not.toHaveBeenCalled()
    await act(async () => {
      resolvers[0](result('a'))
      resolvers[2](result('c'))
      await finished
    })
    expect(latest!.done).toBe(3)
    expect(latest!.syncing).toBe(false)
    expect(api.flushSyncSnapshot).toHaveBeenCalledTimes(1)
    expect(latest!.syncResult?.syncedDocuments.map((doc) => doc.objToken).sort()).toEqual([
      'a',
      'b',
      'c',
    ])
  } finally {
    act(() => root.unmount())
  }
})
