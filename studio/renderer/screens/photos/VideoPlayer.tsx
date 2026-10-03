import { useEffect, useId, useRef, useState } from "react";
import type { VideoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { videoUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";
import { draftName } from "../montage/labels";

// 3e.2: «Смотреть» on a video card (the plan's "play"; no artboard draws a player). The file plays through main's
// `studio-media://video/<avatarId>/<videoId>` route, which resolves it through its record and serves only a file in the current
// export folder (invariant 28): the window names ids, never a path. A dialog over the screen: Escape and the scrim close it,
// and the focus comes back to the card's button.

export function VideoPlayer({ video, onClose }: { video: VideoSummary; onClose: () => void }) {
  const { client } = useEngine();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  const src = videoUrl(video.avatarId, video.videoId);
  const name = draftName(video.title);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [onClose]);

  // The dev mock serves no media: say so instead of a black frame.
  const playable = src !== null && client.kind !== "mock" && !failed;
  return (
    <div className="player-scrim" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="player" role="dialog" aria-modal="true" aria-labelledby={titleId}>
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
      </div>
    </div>
  );
}
