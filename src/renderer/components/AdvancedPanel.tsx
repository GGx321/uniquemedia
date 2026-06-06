export interface AdvancedValue {
  keepTrendAudio: boolean;
  allowMirror: boolean;
  targetDistance: number;
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
      </div>
    </details>
  );
}
