import type { UiCopy } from "../types";

export function CopyCard({
  copy,
  onOpen,
  onReveal,
}: {
  copy: UiCopy;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  const passed = copy.verify?.passed;
  const badge =
    copy.status === "error"
      ? { text: "Ошибка", bg: "#3d1f1f", fg: "#e08a8a" }
      : passed
      ? { text: "✓ Уникально", bg: "var(--ok-bg)", fg: "var(--ok)" }
      : copy.verify
      ? { text: "⚠ Слабо", bg: "#3a3320", fg: "var(--warn)" }
      : { text: "…", bg: "var(--panel)", fg: "var(--muted)" };

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", background: "var(--panel)", borderRadius: 8, padding: 8 }}>
      {copy.thumb ? (
        <img src={copy.thumb} alt="" style={{ width: 54, height: 96, objectFit: "cover", borderRadius: 8 }} />
      ) : (
        <div style={{ width: 54, height: 96, borderRadius: 8, background: "var(--bg)" }} />
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <b style={{ fontSize: 13 }}>{copy.name}</b>
        {copy.status === "rendering" ? (
          <div style={{ height: 6, borderRadius: 3, background: "var(--border)" }}>
            <div style={{ width: `${Math.round((copy.fraction ?? 0) * 100)}%`, height: 6, borderRadius: 3, background: "var(--accent)" }} />
          </div>
        ) : (
          <span style={{ alignSelf: "flex-start", background: badge.bg, color: badge.fg, borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>
            {badge.text}
          </span>
        )}
        {copy.status === "done" && (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => onOpen(copy.name)} style={btn}>▶ Открыть</button>
            <button onClick={() => onReveal(copy.name)} style={btn}>📁 Папка</button>
          </div>
        )}
      </div>
    </div>
  );
}

const btn = {
  fontSize: 11, padding: "3px 8px", borderRadius: 6,
  background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)",
} as const;
