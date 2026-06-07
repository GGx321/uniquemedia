import type { MediaInfo } from "../../core/types";

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
        const f = e.dataTransfer.files[0] as (File & { path?: string }) | undefined;
        if (f?.path) onDropFile(f.path);
      }}
    >
      <span className="crop-mark tl" aria-hidden />
      <span className="crop-mark tr" aria-hidden />
      <span className="crop-mark bl" aria-hidden />
      <span className="crop-mark br" aria-hidden />
      {analyzing && <span className="scanline" aria-hidden />}
      {analyzing ? (
        <div className="analyzing">Анализ видео…</div>
      ) : source ? (
        <div className="source-info">
          <span className="source-glyph" aria-hidden>
            <PlayGlyph />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="source-name">{source.name}</div>
            <span className="chip">{source.info.width}×{source.info.height}</span>
          </div>
        </div>
      ) : (
        <>
          <UploadGlyph />
          <div className="dropzone-hint">
            <b>Перетащите видео</b> сюда
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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}
