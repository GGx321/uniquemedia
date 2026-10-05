import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { VideoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { videoUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";
import { FocusEdge, useBackdropClose, useModalDialog } from "../../ui/useModalDialog";
import { draftName } from "../montage/labels";

// 3e.2: «Смотреть» on a video card (the plan's "play"; no artboard draws a player). The file plays through main's
// `studio-media://video/<avatarId>/<videoId>` route, which resolves it through its record and serves only a file in the current
// export folder (invariant 28): the window names ids, never a path. A dialog portalled to `body` (useModalDialog, the same
// keyboard as the photo viewer's): the rest of the window is inert, the focus stays inside it while Tab still walks the
// video's own controls, Escape and a press on the scrim close it, and the focus comes back to the card's button.

export function VideoPlayer({ video, onClose }: { video: VideoSummary; onClose: () => void }) {
  const { client } = useEngine();
  const titleId = useId();
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  const src = videoUrl(video.avatarId, video.videoId);
  const name = draftName(video.title);
  useModalDialog({ dialog: dialogRef, initialFocus: closeRef, onClose });
  const backdrop = useBackdropClose(onClose, [scrimRef]);

  // The dev mock serves no media: say so instead of a black frame.
  const playable = src !== null && client.kind !== "mock" && !failed;
  return createPortal(
    <div ref={scrimRef} className="player-scrim" role="presentation" {...backdrop}>
      <div ref={dialogRef} className="player" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <FocusEdge edge="start" />
        <div className="player-head">
          <h2 id={titleId} className="player-title">
            {name}
          </h2>
          <button ref={closeRef} type="button" className="ibtn" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="player-frame">
          {playable ? (
            // The file has no captions track: on-video text is burnt in.
            <video className="player-video" src={src ?? undefined} controls autoPlay playsInline onError={() => setFailed(true)} />
          ) : (
            <p className="player-none">{failed ? "Файл не открылся: он изменён, переименован или папка «Готовые видео» недоступна." : "Видео показывает только приложение с движком."}</p>
          )}
        </div>
        <FocusEdge edge="end" />
      </div>
    </div>,
    document.body,
  );
}
