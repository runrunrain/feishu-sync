/**
 * Parse the change-time formats emitted across the application.
 *
 * The current API returns ISO-8601 strings in `cloudModifiedTime`, while
 * older callers and fixtures may still provide Unix seconds or milliseconds.
 * Parsing an ISO string with `parseInt` produces its year (for example 2026),
 * which is then incorrectly rendered as 1970-01-01. Keep this conversion in
 * one place so every change list renders the same, real cloud timestamp.
 */
export function toCloudEpochMilliseconds(value: string | number | null | undefined): number | null {
  if (value == null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  let milliseconds: number;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    // Feishu Wiki emits seconds; tolerate historical millisecond values.
    milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  } else {
    milliseconds = Date.parse(raw);
  }

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : milliseconds;
}

/** Render a compact, user-facing relative cloud modification time. */
export function formatCloudModifiedTime(value: string | number | null | undefined): string {
  const milliseconds = toCloudEpochMilliseconds(value);
  if (milliseconds == null) return '--';

  const diffSeconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000));
  if (diffSeconds < 3600) return `${Math.max(1, Math.floor(diffSeconds / 60))} 分钟前`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)} 小时前`;
  if (diffSeconds < 86400 * 30) return `${Math.floor(diffSeconds / 86400)} 天前`;

  const date = new Date(milliseconds);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
