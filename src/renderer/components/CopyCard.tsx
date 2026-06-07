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

  const rendering = copy.status === "rendering";
  const pct = Math.round((copy.fraction ?? 0) * 100);

  return (
    <div className="copy-card">
      <div className={`copy-thumb-frame${rendering ? " is-rendering" : ""}`}>
        {copy.thumb ? (
          <img src={copy.thumb} alt="" className="copy-thumb" />
        ) : (
          <div className="copy-thumb placeholder" />
        )}
        <span className="copy-thumb-play" aria-hidden>
          <PlayGlyph />
        </span>
      </div>

      <div className="copy-body">
        <span className="copy-name">{copy.name}</span>

        {rendering ? (
          <div className="copy-progress">
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="copy-pct">{pct}%</span>
          </div>
        ) : (
          <div className="copy-status">
            <span className={`badge ${badge.cls}`}>{badge.text}</span>
            {copy.verify && (
              <span className="copy-distance" title="PDQ-дистанция">
                Δ{copy.verify.minDistance}
              </span>
            )}
          </div>
        )}

        {copy.status === "done" && (
          <div className="copy-actions">
            <button className="ghost-btn" onClick={() => onOpen(copy.name)}>
              <PlayGlyph />
              Открыть
            </button>
            <button className="ghost-btn" onClick={() => onReveal(copy.name)}>
              <FolderGlyph />
              Папка
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PlayGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}
