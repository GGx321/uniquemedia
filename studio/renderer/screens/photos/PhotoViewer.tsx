import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PhotoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { errorText } from "../../lib/errors";
import { photoUrl } from "../../lib/media";
import { FocusEdge } from "../../ui/FocusEdge";
import { Icon, Spin } from "../../ui/Icon";
import { PortraitPlaceholder } from "../../ui/Portrait";
import { useAnnouncer } from "../../ui/useAnnouncer";
import { useMediaRetry } from "../../ui/useMediaRetry";
import { useBackdropClose, useModalDialog } from "../../ui/useModalDialog";
import { montagePickRefusal, PhotoBadges, type MarkControl } from "./photoState";
import { CATEGORY_LABEL } from "./runForm";
import { viewerStep, type ViewerPlace } from "./viewerModel";

// The «Фото» tab's photo viewer (no artboard draws one; built in the language of the video player, AvatarVideos.dc.html's
// cards and the Photos sheet's tile). A click on a tile's photo opens it full size: the file through main's
// `studio-media://photo/<avatarId>/<photoId>` route, as the tile shows it (the window names ids, never a path), fitted to the
// window and never enlarged past its own pixels. Beside it the tile's facts and actions: «Фото N из M», the category, the
// tile's badges, the pick for a montage and the reject mark, with the same handlers and the same refusals as the tile, and a
// mark the engine refused said on its photo. ← and → step through the gallery as its filter shows it, with no wrap. A dialog
// portalled to `body` (useModalDialog): the rest of the window is inert, the focus stays inside, Escape, «Закрыть» and a
// press on the dark around it close it, and the focus goes back to the grid.

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
  /** A photo's number in the viewer's list (as «Фото N из M» counts), or null when the list does not hold it. */
  readonly positionOf: (photoId: string) => number | null;
}

/** A refused mark said on another photo than its own: which one, by the viewer's own count. */
function refusedElsewhere(position: number | null): string {
  return position === null ? "Отметка другого фото не сохранена" : `Отметка фото ${position} не сохранена`;
}

export function PhotoViewer({ place, picked, refused, onToggle, mark, onShow, onClose, returnFocus, positionOf }: PhotoViewerProps) {
  const { photo, index, total, prevId, nextId } = place;
  const titleId = useId();
  const pickWhyId = useId();
  const markWhyId = useId();
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  /** The control inside the viewer that had the focus last. */
  const lastFocused = useRef<EventTarget | null>(null);
  /** The photo on screen came from the owner's own step (not from a list that changed under it): say which it is. */
  const stepped = useRef(false);
  const [stepNews, sayStep] = useAnnouncer();
  /** A refused mark is said once, when it comes: a refusal the viewer opened with is old news. */
  const [refusalNews, sayRefusal] = useAnnouncer();
  const seenFailure = useRef(mark.failure);
  useModalDialog({ dialog: dialogRef, initialFocus: closeRef, onClose, returnFocus: () => returnFocus(photo.photoId, index) });
  // The dialog's empty band round the arrows looks like the dark around it, and closes like it.
  const backdrop = useBackdropClose(onClose, [scrimRef, dialogRef]);

  const step = (photoId: string | null): void => {
    if (photoId === null) return;
    stepped.current = true;
    onShow(photoId);
  };

  // ← and →, wherever the focus is inside the viewer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const direction = viewerStep(event);
      if (direction === null) return;
      event.preventDefault();
      const target = direction === "prev" ? prevId : nextId;
      if (target === null) return;
      stepped.current = true;
      onShow(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevId, nextId, onShow]);

  const category = CATEGORY_LABEL[photo.category];
  const title = `Фото ${index + 1} из ${total}`;

  // Only the owner's own step is announced, once its photo is on screen: a running job's new photo moves the number too, and
  // would chatter. Keyed on the photo alone: its title and category come with it.
  useEffect(() => {
    if (!stepped.current) return;
    stepped.current = false;
    sayStep(`${title}: ${category}`);
  }, [photo.photoId]);

  // A refused mark, when it comes: on the photo on screen its own words; on another (the owner stepped on while the engine
  // answered) which photo it was for too. Shown afterwards without being said again.
  useEffect(() => {
    const failure = mark.failure;
    if (failure === seenFailure.current) return;
    seenFailure.current = failure;
    if (failure === null) return;
    const text = errorText(failure.error);
    sayRefusal(failure.photoId === photo.photoId ? text : `${refusedElsewhere(positionOf(failure.photoId))}: ${text}`);
  }, [mark.failure]);

  // A control that turns off under the focus drops it to the page in Chromium. An arrow at its end hands it to the other
  // arrow (stepping on is what the owner was doing); any other control (a pick a render now holds, say) to «Закрыть», so the
  // next Space or Enter never steps or marks by surprise.
  useEffect(() => {
    const root = dialogRef.current;
    if (root === null) return;
    const active = document.activeElement;
    const off = active instanceof HTMLButtonElement && active.disabled;
    if (active instanceof HTMLElement && root.contains(active) && !off) return;
    const was = off && root.contains(active) ? active : lastFocused.current;
    const other = was === prevRef.current ? nextRef.current : was === nextRef.current ? prevRef.current : null;
    (other !== null && !other.disabled ? other : closeRef.current)?.focus();
  });

  // A photo picked before it became unusable can still be unpicked, as on its tile.
  const why = montagePickRefusal(photo);
  const marking = mark.marking.has(photo.photoId);
  const failure = mark.failure;
  const failedHere = failure !== null && failure.photoId === photo.photoId ? errorText(failure.error) : null;
  const failedElsewhere = failure !== null && failure.photoId !== photo.photoId ? refusedElsewhere(positionOf(failure.photoId)) : null;
  const frame = ["viewer-frame", picked ? "viewer-frame-on" : "", refused ? "viewer-frame-refused" : ""].filter(Boolean).join(" ");

  return createPortal(
    <div ref={scrimRef} className="viewer-scrim" role="presentation" {...backdrop}>
      <div
        ref={dialogRef}
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onFocus={(event) => {
          lastFocused.current = event.target;
        }}
      >
        <FocusEdge edge="start" />
        <button ref={prevRef} type="button" className="viewer-nav" aria-label="Предыдущее фото" aria-keyshortcuts="ArrowLeft" disabled={prevId === null} onClick={() => step(prevId)}>
          <Icon name="back" size={20} strokeWidth={2.2} />
        </button>

        <div className="viewer-card">
          <div className={frame}>
            <ViewerPhoto key={photo.photoId} photo={photo} label={`${title}: ${category}`} />
          </div>

          <div className="viewer-side">
            <header className="viewer-head">
              <div className="viewer-title-row">
                <h2 id={titleId} className="viewer-title">
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
              <p className="sr-only" aria-live="polite">
                {stepNews}
              </p>
              <p className="sr-only" aria-live="assertive">
                {refusalNews}
              </p>
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
              {/* The gallery column says it too, but under the scrim and out of reach: here it is where the owner is. No alert
                  role: the assertive region above said it once, and a return to this photo must not say it again. */}
              {(failedHere ?? failedElsewhere) !== null && <p className="viewer-error">{failedHere ?? failedElsewhere}</p>}
            </div>

            <p className="viewer-keys" aria-hidden="true">
              <kbd>←</kbd>
              <kbd>→</kbd> листать · <kbd>Esc</kbd> закрыть
            </p>
          </div>
        </div>

        <button ref={nextRef} type="button" className="viewer-nav" aria-label="Следующее фото" aria-keyshortcuts="ArrowRight" disabled={nextId === null} onClick={() => step(nextId)}>
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
  const src = photoUrl(photo.avatarId, photo.photoId);
  const retry = useMediaRetry(src);
  const broken = retry.failed || src === null;
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
  return <img key={retry.key} className="viewer-img" src={src} alt={label} decoding="async" onError={retry.onError} />;
}
