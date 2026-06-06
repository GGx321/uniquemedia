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
      <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Advanced</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
        <label style={row}>
          Keep trend audio
          <input
            aria-label="Keep trend audio"
            type="checkbox"
            checked={value.keepTrendAudio}
            onChange={(e) => set({ keepTrendAudio: e.target.checked })}
          />
        </label>
        <label style={row}>
          Allow mirror (flips text)
          <input
            aria-label="Allow mirror"
            type="checkbox"
            checked={value.allowMirror}
            onChange={(e) => set({ allowMirror: e.target.checked })}
          />
        </label>
        <label style={row}>
          Target distance
          <input
            aria-label="Target distance"
            type="number"
            min={1}
            max={256}
            value={value.targetDistance}
            onChange={(e) => set({ targetDistance: Math.max(1, Math.min(256, Number(e.target.value) || 1)) })}
            style={{ width: 80, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: 4 }}
          />
        </label>
      </div>
    </details>
  );
}
