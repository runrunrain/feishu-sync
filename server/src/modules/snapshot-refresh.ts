const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; refresh: () => void }>()
/** A UI batch flushes once at completion; abandoned batches still refresh automatically. */
export function scheduleSnapshotRefresh(root: string, refresh: () => void) {
  const old = pending.get(root)
  if (old) clearTimeout(old.timer)
  const timer = setTimeout(() => flushSnapshotRefresh(root), 60_000)
  timer.unref?.()
  pending.set(root, { timer, refresh })
}
export function flushSnapshotRefresh(root: string, fallback?: () => void) {
  const entry = pending.get(root)
  if (entry) {
    clearTimeout(entry.timer)
    pending.delete(root)
  }
  try {
    ;(entry?.refresh ?? fallback)?.()
  } catch (error) {
    console.warn('[sync] snapshot refresh failed:', error)
  }
}
