import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PhotoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { photoUrl } from "../../lib/media";
import { Icon, Spin } from "../../ui/Icon";
import { PortraitPlaceholder } from "../../ui/Portrait";
import { FocusEdge, useBackdropClose, useModalDialog } from "../../ui/useModalDialog";
import { montagePickRefusal, PhotoBadges, type MarkControl } from "./photoState";
import { CATEGORY_LABEL } from "./runForm";
import { viewerStep, type ViewerPlace } from "./viewerModel";

// The «Фото» tab's photo viewer (no artboard draws one; built in the language of the video player, AvatarVideos.dc.html's
// cards and the Photos sheet's tile). A click on a tile's photo opens it full size: the file through main's
// `studio-media://photo/<avatarId>/<photoId>` route, as the tile shows it (the window names ids, never a path), fitted to the
// window and never enlarged past its own pixels. Beside it the tile's facts and actions: «Фото N из M», the category, the
// tile's badges, the pick for a montage and the reject mark, with the same handlers and the same refusals as the tile.
// ← and → step through the gallery as its filter shows it, with no wrap. A dialog portalled to `body` (useModalDialog): the
// rest of the window is inert, the focus stays inside, Escape, «Закрыть» and a press on the dark around it close it, and the
// focus goes back to the grid.

interface PhotoViewerProps {
  readonly place: ViewerPlace;
  readonly picked: boolean;
  /** `montages.create` just refused the photo (K11): marked as on its tile. */
  readonly refused: boolean;
  readonly onToggle: (photoId: string) => void;
  readonly mark: MarkControl;
  /** Show another photo of the gallery, by id. */
  readonly onShow: (photoId: string) => void;
  readonly onClose: () => void;
  /** The element to hand the focus to when the viewer closes on this photo, at this place. */
  readonly returnFocus: (photoId: string, index: number) => HTMLElement | null;
}

export function PhotoViewer({ place, picked, refused, onToggle, mark, onShow, onClose, returnFocus }: PhotoViewerProps) {
  const { photo, index, total, prevId, nextId } = place;
  const titleId = useId();
  const pickWhyId = useId();
  const markWhyId = useId();
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  useModalDialog({ dialog: dialogRef, initialFocus: closeRef, onClose, returnFocus: () => returnFocus(photo.photoId, index) });
  // The dialog's empty band round the arrows looks like the dark around it, and closes like it.
  const backdrop = useBackdropClose(onClose, [scrimRef, dialogRef]);

  // ← and →, wherever the focus is inside the viewer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const step = viewerStep(event);
      if (step === null) return;
      event.preventDefault();
      const target = step === "prev" ? prevId : nextId;
      if (target !== null) onShow(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevId, nextId, onShow]);

  // A control that turns off under the focus (the arrow at an end, a pick a render now holds) drops it to the page in
  // Chromium: hand it to the other arrow, else «Закрыть», so the keyboard stays in the viewer.
  useEffect(() => {
    const root = dialogRef.current;
    if (root === null) return;
    const active = document.activeElement;
    const held = active instanceof HTMLElement && root.contains(active) && !(active instanceof HTMLButtonElement && active.disabled);
    if (held) return;
    [prevRef.current, nextRef.current, closeRef.current].find((button) => button !== null && !button.disabled)?.focus();
  });

  const category = CATEGORY_LABEL[photo.category];
  const title = `Фото ${index + 1} из ${total}`;
  // A photo picked before it became unusable can still be unpicked, as on its tile.
  const why = montagePickRefusal(photo);
  const marking = mark.marking.has(photo.photoId);
  const frame = ["viewer-frame", picked ? "viewer-frame-on" : "", refused ? "viewer-frame-refused" : ""].filter(Boolean).join(" ");

  return createPortal(
    <div ref={scrimRef} className="viewer-scrim" role="presentation" {...backdrop}>
      <div ref={dialogRef} className="viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <FocusEdge edge="start" />
        <button ref={prevRef} type="button" className="viewer-nav" aria-label="Предыдущее фото" aria-keyshortcuts="ArrowLeft" disabled={prevId === null} onClick={() => prevId !== null && onShow(prevId)}>
          <Icon name="back" size={20} strokeWidth={2.2} />
        </button>

        <div className="viewer-card">
          <div className={frame}>
            <ViewerPhoto key={photo.photoId} photo={photo} label={`${title}: ${category}`} />
          </div>

          <div className="viewer-side">
            <header className="viewer-head">
              <div className="viewer-title-row">
                <h2 id={titleId} className="viewer-title" aria-live="polite">
                  {title}
                </h2>
                <button ref={closeRef} type="button" className="ibtn" aria-label="Закрыть" aria-keyshortcuts="Escape" onClick={onClose}>
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="viewer-meta">
                <span className="tag viewer-category">{category}</span>
                <PhotoBadges photo={photo} />
                {refused && <span className="pill photo-badge viewer-refused">недоступно</span>}
              </div>
            </header>

            <div className="viewer-actions">
              <button
                type="button"
                className="btn btn-s viewer-pick"
                aria-pressed={picked}
                aria-describedby={why === null ? undefined : pickWhyId}
                disabled={why !== null && !picked}
                onClick={() => onToggle(photo.photoId)}
              >
                <span className="viewer-check" aria-hidden="true">
                  {picked && <Icon name="check" size={12} strokeWidth={3} />}
                </span>
                Выбрать для монтажа
              </button>
              {why !== null && (
                <p id={pickWhyId} className="viewer-why">
                  {why}
                </p>
              )}
              {/* Busy is aria-disabled, not disabled: the button keeps the focus while the engine answers. */}
              <button
                type="button"
                className={photo.rejected ? "btn btn-s viewer-mark viewer-mark-on" : "btn btn-s viewer-mark"}
                title={mark.blocked ?? (photo.rejected ? "Вернуть: фото снова можно брать в видео" : "Отклонить: это фото не пойдёт в видео")}
                aria-busy={marking}
                aria-disabled={marking || undefined}
                aria-describedby={mark.blocked === null ? undefined : markWhyId}
                disabled={mark.blocked !== null}
                onClick={() => !marking && mark.onMark(photo, !photo.rejected)}
              >
                {marking ? <Spin /> : <Icon name={photo.rejected ? "reload" : "close"} size={14} strokeWidth={2.2} />}
                {photo.rejected ? "Вернуть из отклонённых" : "Отклонить"}
              </button>
              {mark.blocked !== null && (
                <p id={markWhyId} className="viewer-why">
                  {mark.blocked}
                </p>
              )}
            </div>

            <p className="viewer-keys" aria-hidden="true">
              <kbd>←</kbd>
              <kbd>→</kbd> листать · <kbd>Esc</kbd> закрыть
            </p>
          </div>
        </div>

        <button ref={nextRef} type="button" className="viewer-nav" aria-label="Следующее фото" aria-keyshortcuts="ArrowRight" disabled={nextId === null} onClick={() => nextId !== null && onShow(nextId)}>
          <Icon name="forward" size={20} strokeWidth={2.2} />
        </button>
        <FocusEdge edge="end" />
      </div>
    </div>,
    document.body,
  );
}

/** The photo at full size, or the placeholder, large: always in the dev mock (it has no pictures), and when the file will not load. */
function ViewerPhoto({ photo, label }: { photo: PhotoSummary; label: string }) {
  const { client } = useEngine();
  const [failed, setFailed] = useState(false);
  const src = photoUrl(photo.avatarId, photo.photoId);
  const broken = failed || src === null;
  if (client.kind === "mock" || broken) {
    return (
      <div className="viewer-ph">
        <PortraitPlaceholder seed={photo.photoId} label={label} />
        {broken && (
          <span className="pill viewer-failed" role="status">
            Фото не открылось
          </span>
        )}
      </div>
    );
  }
  return <img className="viewer-img" src={src} alt={label} decoding="async" onError={() => setFailed(true)} />;
}
