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
      ? { text: "Ошибка", cls: "err" }
      : passed
      ? { text: "✓ Уникально", cls: "ok" }
      : copy.verify
      ? { text: "⚠ Слабо", cls: "warn" }
      : { text: "…", cls: "pending" };

  return (
    <div className="copy-card">
      {copy.thumb ? (
        <img src={copy.thumb} alt="" className="copy-thumb" />
      ) : (
        <div className="copy-thumb placeholder" />
      )}
      <div className="copy-body">
        <span className="copy-name">{copy.name}</span>
        {copy.status === "rendering" ? (
          <div className="bar">
            <div className="bar-fill" style={{ width: `${Math.round((copy.fraction ?? 0) * 100)}%` }} />
          </div>
        ) : (
          <span className={`badge ${badge.cls}`}>{badge.text}</span>
        )}
        {copy.status === "done" && (
          <div className="copy-actions">
            <button className="ghost-btn" onClick={() => onOpen(copy.name)}>▶ Открыть</button>
            <button className="ghost-btn" onClick={() => onReveal(copy.name)}>📁 Папка</button>
          </div>
        )}
      </div>
    </div>
  );
}
