import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataRoot } from './data-root.js'
import { resolveInside } from '../agent/path-guard.js'
import { syncScope } from './sync-performance.js'

const MAX_ENTRY_BYTES = 1024 * 1024
const MAX_BYTES = 128 * 1024 * 1024
const MAX_AGE = 7 * 24 * 3600_000
const gcAt = new Map<string, number>()
const cacheSize = new Map<string, number>()
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

function completePage(value: unknown, range: string, revision: string | number): boolean {
  const data = (value as any)?.data ?? value
  const bounds = /^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)$/.exec(range)
  if (
    !bounds ||
    String(data?.revision) !== String(revision) ||
    data?.has_more !== false ||
    data?.truncated === true ||
    data?.ranges?.length !== 1
  )
    return false
  const page = data.ranges[0]
  if (page?.actual_range !== range || page?.truncated === true) return false
  const column = (letters: string) =>
    [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
  const top = Number(bounds[2]),
    bottom = Number(bounds[4])
  const left = column(bounds[1]),
    right = column(bounds[3])
  const rows = bottom - top + 1,
    columns = right - left + 1
  return (
    rows > 0 &&
    columns > 0 &&
    rows * columns <= 2_000_000 &&
    Array.isArray(page.row_indices) &&
    page.row_indices.length === rows &&
    page.row_indices.every((row: unknown, i: number) => row === top + i) &&
    Array.isArray(page.col_indices) &&
    page.col_indices.length === columns &&
    page.col_indices.every(
      (letters: unknown, i: number) => typeof letters === 'string' && column(letters) === left + i,
    ) &&
    Array.isArray(page.cells) &&
    page.cells.length === rows &&
    page.cells.every(
      (row: unknown) =>
        Array.isArray(row) &&
        row.length === columns &&
        row.every(
          (cell: unknown) => cell !== null && typeof cell === 'object' && !Array.isArray(cell),
        ),
    )
  )
}

/** Revision-scoped raw pages only. Callers must still verify coverage and a fresh final revision. */
export async function versionedSheetRead<T>(
  options: {
    spreadsheetToken: string
    sheetId: string
    range: string
    formulas?: boolean
    revision?: string | number
  },
  read: () => Promise<T>,
): Promise<T> {
  const scope = syncScope()
  if (!scope || options.revision == null) return read()
  const key = digest(
    JSON.stringify([
      options.spreadsheetToken,
      options.sheetId,
      options.range,
      Boolean(options.formulas),
      String(options.revision),
    ]),
  )
  const root = resolveDataRoot()
  let file: string | undefined
  try {
    fs.mkdirSync(path.join(root, 'sync-cache'), { recursive: true })
    const directory = resolveInside(root, 'sync-cache', 'read')
    file = path.join(directory, `${key}.json`)
    if (fs.existsSync(file) && fs.lstatSync(file).isFile()) {
      const safe = resolveInside(root, `sync-cache/${key}.json`, 'read')
      const stat = fs.statSync(safe)
      if (stat.size <= MAX_ENTRY_BYTES && Date.now() - stat.mtimeMs < MAX_AGE) {
        const entry = JSON.parse(fs.readFileSync(safe, 'utf8'))
        if (entry.key === key && digest(entry.payload) === entry.sha256) {
          const cached = JSON.parse(entry.payload) as T
          if (completePage(cached, options.range, options.revision)) {
            scope.metrics.cacheHits++
            return cached
          }
        }
      }
    }
  } catch {
    /* Cache failures always fall through to the authorized API. */
  }
  const value = await read()
  if (!completePage(value, options.range, options.revision)) return value
  try {
    const payload = JSON.stringify(value)
    const entry = JSON.stringify({ key, payload, sha256: digest(payload) })
    if (file && Buffer.byteLength(entry) <= MAX_ENTRY_BYTES) {
      const safe = resolveInside(root, `sync-cache/${key}.json`, 'write')
      const previousSize = fs.existsSync(safe) ? fs.statSync(safe).size : 0
      const temp = `${safe}.${crypto.randomUUID()}.tmp`
      try {
        fs.writeFileSync(temp, entry, { flag: 'wx' })
        fs.renameSync(temp, safe)
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp)
      }
      const directory = path.dirname(safe)
      cacheSize.set(
        directory,
        (cacheSize.get(directory) ?? 0) + Buffer.byteLength(entry) - previousSize,
      )
      if (
        (gcAt.get(directory) ?? 0) < Date.now() - 60_000 ||
        cacheSize.get(directory)! > MAX_BYTES
      ) {
        gcAt.set(directory, Date.now())
        const entries = fs
          .readdirSync(directory, { withFileTypes: true })
          .filter((item) => item.isFile() && /^[a-f0-9]{64}\.json$/.test(item.name))
          .map((item) => {
            const p = path.join(directory, item.name)
            return { p, stat: fs.statSync(p) }
          })
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
        let bytes = 0
        for (const entry of entries) {
          if (bytes + entry.stat.size > MAX_BYTES || Date.now() - entry.stat.mtimeMs > MAX_AGE)
            fs.unlinkSync(entry.p)
          else bytes += entry.stat.size
        }
        cacheSize.set(directory, bytes)
      }
    }
  } catch {
    /* Optional cache writes cannot prevent a successful sync. */
  }
  return value
}
