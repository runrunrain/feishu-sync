import { useState } from 'react';

export interface KbReadingPreferences {
  fontSize: number;
  lineHeight: number;
}

export const DEFAULT_KB_READING: KbReadingPreferences = { fontSize: 18, lineHeight: 1.95 };
const STORAGE_KEY = 'feishu-sync:kb-reading-preferences';

function loadPreferences(): KbReadingPreferences {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      const { fontSize, lineHeight } = saved as Partial<KbReadingPreferences>;
      return {
        fontSize: typeof fontSize === 'number' && Number.isFinite(fontSize)
          ? Math.max(14, Math.min(28, Math.round(fontSize))) : DEFAULT_KB_READING.fontSize,
        lineHeight: typeof lineHeight === 'number' && Number.isFinite(lineHeight)
          ? Math.max(1.4, Math.min(2.4, Math.round(lineHeight * 20) / 20)) : DEFAULT_KB_READING.lineHeight,
      };
    }
  } catch {
    // 存储不可用或旧值损坏时仍可阅读、调节。
  }
  return DEFAULT_KB_READING;
}

export function useKbReadingPreferences() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const updatePreferences = (next: KbReadingPreferences) => {
    setPreferences(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setStorageUnavailable(false);
    } catch {
      setStorageUnavailable(true);
    }
  };
  return { preferences, updatePreferences, storageUnavailable };
}
