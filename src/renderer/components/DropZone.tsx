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
      onClick={onPick}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0] as (File & { path?: string }) | undefined;
        if (f?.path) onDropFile(f.path);
      }}
      style={{
        border: "1px dashed var(--border)", borderRadius: 8, padding: 18,
        textAlign: "center", color: "var(--muted)", cursor: "pointer",
      }}
    >
      {analyzing ? (
        <div style={{ color: "var(--accent)" }}>Анализ видео…</div>
      ) : source ? (
        <div>
          <div style={{ color: "var(--text)", fontWeight: 600 }}>{source.name}</div>
          <div style={{ fontSize: 12 }}>{source.info.width}×{source.info.height}</div>
        </div>
      ) : (
        "⬇︎ Перетащите видео или нажмите, чтобы выбрать"
      )}
    </div>
  );
}
