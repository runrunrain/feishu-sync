import { useEffect, useRef } from 'react';
import { Type } from 'lucide-react';
import { DEFAULT_KB_READING, type KbReadingPreferences } from '../../hooks/useKbReadingPreferences';

interface KbReadingControlsProps {
  preferences: KbReadingPreferences;
  onChange: (next: KbReadingPreferences) => void;
  storageUnavailable: boolean;
  active: boolean;
}

/** 紧凑阅读入口，展开时临时覆盖正文，不占用阅读栏宽度。 */
export function KbReadingControls({ preferences, onChange, storageUnavailable, active }: KbReadingControlsProps) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!active && ref.current) ref.current.open = false;
  }, [active]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details ref={ref} className="relative shrink-0" onKeyDown={(event) => {
    if (event.key === 'Escape' && ref.current?.open) {
      ref.current.open = false;
      ref.current.querySelector('summary')?.focus();
      event.stopPropagation();
    }
  }}>
    <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer flex items-center gap-1.5 rounded px-2 py-1 text-xs text-ink-soft hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-jade"
      aria-label="阅读设置" title="调整正文字号和行距">
      <Type className="w-4 h-4" /> 阅读
    </summary>
    <div className="absolute right-0 top-full z-30 mt-2 w-64 max-w-[calc(100vw-100px)] rounded-md border border-line bg-card-bg p-4 shadow-lg space-y-4" aria-label="正文阅读设置">
      <div>
        <label htmlFor="kb-reading-font-size" className="flex justify-between text-sm text-ink mb-2">
          字号 <output htmlFor="kb-reading-font-size" className="font-sans tabular-nums">{preferences.fontSize}px</output>
        </label>
        <input id="kb-reading-font-size" type="range" min={14} max={28} step={1} value={preferences.fontSize}
          aria-valuetext={`${preferences.fontSize}像素`} className="w-full accent-jade cursor-pointer"
          onChange={(event) => onChange({ ...preferences, fontSize: Number(event.target.value) })} />
      </div>
      <div>
        <label htmlFor="kb-reading-line-height" className="flex justify-between text-sm text-ink mb-2">
          行距 <output htmlFor="kb-reading-line-height" className="font-sans tabular-nums">{preferences.lineHeight.toFixed(2)}倍</output>
        </label>
        <input id="kb-reading-line-height" type="range" min={1.4} max={2.4} step={0.05} value={preferences.lineHeight}
          aria-valuetext={`${preferences.lineHeight.toFixed(2)}倍`} className="w-full accent-jade cursor-pointer"
          onChange={(event) => onChange({ ...preferences, lineHeight: Number(event.target.value) })} />
      </div>
      <div className="border-t border-line/60 pt-3 flex items-center justify-between gap-2 text-xs">
        <span className={storageUnavailable ? 'text-seal' : 'text-ink-faint'} role="status">{storageUnavailable ? '无法保存，仅本次生效' : '自动记住阅读设置'}</span>
        <button type="button" className="shrink-0 text-jade hover:underline focus-visible:outline-2 focus-visible:outline-jade"
          onClick={() => onChange({ ...DEFAULT_KB_READING })}>恢复默认</button>
      </div>
    </div>
  </details>;
}
