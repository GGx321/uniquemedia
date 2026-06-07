export interface AdvancedValue {
  strength: number;
  keepTrendAudio: boolean;
  allowMirror: boolean;
  targetDistance: number;
  spoofMetadata: boolean;
}

export function AdvancedPanel({
  value,
  onChange,
}: {
  value: AdvancedValue;
  onChange: (v: AdvancedValue) => void;
}) {
  const set = (patch: Partial<AdvancedValue>) => onChange({ ...value, ...patch });
  const pct = ((value.strength - 0.5) / 1.0) * 100;
  return (
    <details className="advanced">
      <summary>
        <span className="chev" aria-hidden />
        Дополнительно
      </summary>
      <div className="advanced-body">
        <label className="field">
          <span className="adv-slider-head">
            <span className="micro-label">Сила изменений</span>
            <span className="val">{Math.round(value.strength * 100)}%</span>
          </span>
          <input
            aria-label="Сила изменений"
            type="range"
            min={0.5}
            max={1.5}
            step={0.1}
            value={value.strength}
            onChange={(e) => set({ strength: Number(e.target.value) })}
            style={{ ["--pct" as string]: `${pct}%` }}
          />
        </label>
        <label className="adv-row">
          Сохранить оригинальный звук
          <input
            className="switch"
            aria-label="Сохранить оригинальный звук"
            type="checkbox"
            checked={value.keepTrendAudio}
            onChange={(e) => set({ keepTrendAudio: e.target.checked })}
          />
        </label>
        <label className="adv-row">
          Зеркальное отражение (отражает текст)
          <input
            className="switch"
            aria-label="Зеркальное отражение"
            type="checkbox"
            checked={value.allowMirror}
            onChange={(e) => set({ allowMirror: e.target.checked })}
          />
        </label>
        <label className="adv-row">
          Метаданные iPhone
          <input
            className="switch"
            aria-label="Метаданные iPhone"
            type="checkbox"
            checked={value.spoofMetadata}
            onChange={(e) => set({ spoofMetadata: e.target.checked })}
          />
        </label>
      </div>
    </details>
  );
}
