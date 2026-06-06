export function NField({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>Copies</span>
      <input
        aria-label="copies"
        type="number"
        min={1}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        style={{
          padding: 8, borderRadius: 8, background: "var(--panel)",
          color: "var(--text)", border: "1px solid var(--border)",
        }}
      />
    </label>
  );
}
