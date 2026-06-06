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
  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } as const;
  return (
    <details style={{ background: "var(--panel)", borderRadius: 8, padding: "8px 12px" }}>
      <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Дополнительно</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Сила изменений</span>
            <span style={{ color: "var(--muted)" }}>{Math.round(value.strength * 100)}%</span>
          </span>
          <input
            aria-label="Сила изменений"
            type="range"
            min={0.5}
            max={1.5}
            step={0.1}
            value={value.strength}
            onChange={(e) => set({ strength: Number(e.target.value) })}
          />
        </label>
        <label style={row}>
          Сохранить оригинальный звук
          <input
            aria-label="Сохранить оригинальный звук"
            type="checkbox"
            checked={value.keepTrendAudio}
            onChange={(e) => set({ keepTrendAudio: e.target.checked })}
          />
        </label>
        <label style={row}>
          Зеркальное отражение (отражает текст)
          <input
            aria-label="Зеркальное отражение"
            type="checkbox"
            checked={value.allowMirror}
            onChange={(e) => set({ allowMirror: e.target.checked })}
          />
        </label>
        <label style={row}>
          Метаданные iPhone
          <input
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
