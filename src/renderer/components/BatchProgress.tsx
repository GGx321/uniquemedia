export function BatchProgress({
  index,
  count,
  fraction,
}: {
  index: number;
  count: number;
  fraction: number;
}) {
  if (count <= 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>
        copy {Math.min(index + 1, count)}/{count}
      </span>
      <div style={{ height: 6, borderRadius: 3, background: "var(--border)" }}>
        <div style={{ width: `${Math.round(fraction * 100)}%`, height: 6, borderRadius: 3, background: "var(--accent)" }} />
      </div>
    </div>
  );
}
