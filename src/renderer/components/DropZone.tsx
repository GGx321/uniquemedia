import type { MediaInfo } from "../../core/types";
import { api } from "../api";

export interface Source {
  name: string;
  info: MediaInfo;
}

export function DropZone({
  source,
  analyzing,
  onPick,
  onDropFile,
}: {
  source: Source | null;
  analyzing?: boolean;
  onPick: () => void;
  onDropFile: (path: string) => void;
}) {
  return (
    <div
      className={`dropzone${analyzing ? " is-analyzing" : ""}${source ? " has-source" : ""}`}
      onClick={onPick}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) {
          const path = api.getDroppedPath(f);
          if (path) onDropFile(path);
        }
      }}
    >
      <span className="crop-mark tl" aria-hidden />
      <span className="crop-mark tr" aria-hidden />
      <span className="crop-mark bl" aria-hidden />
      <span className="crop-mark br" aria-hidden />
      {analyzing && <span className="scanline" aria-hidden />}
      {analyzing ? (
        <div className="analyzing">Анализ файла…</div>
      ) : source ? (
        <div className="source-info">
          <span className="source-thumb" aria-hidden>
            {source.info.kind === "photo" ? <StillGlyph /> : <PlayGlyph />}
            <span className="source-thumb-grid" />
          </span>
          <div className="source-meta">
            <span className="source-label">Источник</span>
            <div className="source-name">{source.name}</div>
            <div className="source-tags">
              <span className="chip">
                {source.info.width}×{source.info.height}
              </span>
              <span className="source-change">нажмите, чтобы сменить</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <UploadGlyph />
          <div className="dropzone-hint">
            <b>Перетащите видео или фото</b> сюда
          </div>
          <div className="dropzone-sub">или нажмите, чтобы выбрать</div>
        </>
      )}
    </div>
  );
}

function UploadGlyph() {
  return (
    <svg className="dropzone-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 16V4m0 0L7 9m5-5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PlayGlyph() {
  return (
    <svg data-glyph="play" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

/** A still has nothing to play. Framed mountain-and-sun, the conventional
 *  still-image mark, drawn at the play triangle's weight so the thumb chip
 *  reads the same either way. */
function StillGlyph() {
  return (
    <svg data-glyph="still" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="9" cy="10" r="1.6" fill="currentColor" />
      <path d="M4.5 16.5 9.5 12l3.5 3 2.5-2.2 4 3.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
