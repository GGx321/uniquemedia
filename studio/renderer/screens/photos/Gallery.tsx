import { useId } from "react";
import type { EngineError, PhotoSummary } from "../../../shared/engine";
import { countOf } from "../../lib/format";
import { Icon } from "../../ui/Icon";
import { ErrorNotice } from "../../ui/Notice";
import { Portrait, Silhouette } from "../../ui/Portrait";
import { CATEGORY_LABEL } from "./runForm";
import { FACE_GATE_THRESHOLD } from "./shared";

/** What photos.list last answered: the photos it could list, and how many more it could not. */
export interface GalleryList {
  photos: readonly PhotoSummary[];
  skippedTotal: number;
}

/** The slots of the run still drawing: how many there are, and how many of them the network can be drawing at once. */
export interface PendingSlots {
  remaining: number;
  drawing: number;
}

const SKIPPED_FORMS = ["фото не читается", "фото не читаются", "фото не читаются"] as const;

/** "лицо 0.86": the similarity to the master portrait, rounded to what the badge shows. */
function faceLabel(faceCos: number): string {
  return `лицо ${faceCos.toFixed(2)}`;
}

/**
 * Why a photo cannot be picked for a montage, or null when it can: one photo goes into one video (the owner's Q1),
 * so a photo already in a video or held by a render in flight is not offered, nor a rejected or ineligible one.
 */
export function montagePickRefusal(photo: PhotoSummary): string | null {
  if (photo.rejected) return "Фото отклонено — в монтаж не попадает";
  if (photo.used || photo.usedIn.length > 0) return "Фото уже в видео: одно фото — одно видео";
  if (photo.reserved) return "Фото сейчас в рендере";
  if (!photo.eligible) return "Это фото не подходит для видео";
  return null;
}

function PhotoTile({ photo, position, picked, refused, onToggle }: { photo: PhotoSummary; position: number; picked: boolean; refused: boolean; onToggle: (photoId: string) => void }) {
  const label = CATEGORY_LABEL[photo.category];
  const faceCos = photo.qa?.faceCos;
  // Compared on the same rounded value the badge displays (L2): a raw score
  // just under the line that rounds up to the line itself (0.549 shows
  // «0.55») must read the same as the line, never as low.
  const low = faceCos !== undefined && Number(faceCos.toFixed(2)) < FACE_GATE_THRESHOLD;
  // A photo picked before it became unusable can still be unpicked.
  const why = montagePickRefusal(photo);
  // One photo, one video (Q1): a photo a video or a render holds is dimmed with how it is held, as in the editor's bin.
  const inVideos = photo.usedIn.length;
  const held = inVideos > 0 ? `в ${inVideos} видео` : photo.used ? "в видео" : photo.reserved ? "в рендере" : null;
  const classes = ["ph", "photo-tile", picked ? "photo-tile-on" : "", refused ? "photo-tile-refused" : "", held !== null ? "photo-tile-used" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <Portrait avatarId={photo.avatarId} photoId={photo.photoId} label={`Фото ${position}: ${label}`} />
      {held !== null && <span className="photo-held-dim" aria-hidden="true" />}
      <button
        type="button"
        className="photo-pick"
        aria-pressed={picked}
        aria-label={`Выбрать для монтажа: фото ${position}, ${label}${why === null ? "" : ` · ${why}`}`}
        title={why ?? undefined}
        disabled={why !== null && !picked}
        onClick={() => onToggle(photo.photoId)}
      >
        {picked && <Icon name="check" size={16} strokeWidth={3} />}
      </button>
      {refused && <span className="pill photo-refused">недоступно</span>}
      <div className="photo-badges">
        {faceCos !== undefined ? (
          <span className={low ? "pill mono photo-badge photo-face photo-face-low" : "pill mono photo-badge photo-face"}>{faceLabel(faceCos)}</span>
        ) : (
          <span className="pill mono photo-badge photo-face-none">лицо не проверялось</span>
        )}
        {held !== null && <span className="pill mono photo-badge photo-held">{held}</span>}
      </div>
      <span className="pill photo-label">{label}</span>
    </div>
  );
}

/** A slot of the running job: drawing now (at most the network's concurrency), or waiting its turn — the rest summed up in one tile. */
function PendingTiles({ pending }: { pending: PendingSlots }) {
  const queued = pending.remaining - pending.drawing;
  return (
    <>
      {Array.from({ length: pending.drawing }, (_, i) => (
        <div key={`drawing-${i}`} className="ph photo-tile photo-tile-drawing" aria-hidden="true">
          <Silhouette />
          <div className="shim" />
          <span className="pill photo-status photo-status-drawing">Рисуется</span>
        </div>
      ))}
      {queued > 0 && (
        <div className="ph photo-tile photo-tile-queued" aria-hidden="true">
          <span className="pill photo-status photo-status-queued">В очереди</span>
          <span className="pill photo-label">ещё {queued}</span>
        </div>
      )}
    </>
  );
}

interface GalleryProps {
  /** Null until photos.list first answers. */
  gallery: GalleryList | null;
  /** The last photos.list failure, shown above whatever list is already on screen. */
  error: EngineError | null;
  pending: PendingSlots | null;
  picked: ReadonlySet<string>;
  /** Photos `montages.create` just refused (`PHOTO_UNAVAILABLE` at `["photoIds", i]`, K11): marked on their tiles. */
  refused?: ReadonlySet<string>;
  onToggle: (photoId: string) => void;
  onRetry: () => void;
}

/**
 * The avatar's run photos, newest first (`photos.list`), each with its face
 * similarity badge — or «лицо не проверялось» when the gate did not judge it
 * (a profile or back shot, or a photo from before the gate). The filter's
 * «Неиспользованные» and «Отклонённые» need usage and rejection data the
 * contract does not carry yet, so only «Все» works.
 */
export function Gallery({ gallery, error, pending, picked, refused, onToggle, onRetry }: GalleryProps) {
  const titleId = useId(); // L12: was the hardcoded "gallery-title"
  const loading = gallery === null && error === null;
  const photos = gallery?.photos ?? [];
  const skipped = gallery?.skippedTotal ?? 0;
  const empty = gallery !== null && photos.length === 0 && skipped === 0 && pending === null;

  return (
    <section className="photos-gallery" aria-labelledby={titleId} aria-busy={loading}>
      <div className="photos-sec-head">
        <h2 id={titleId} className="card-title">
          Галерея
        </h2>
        <div className="seg photos-sec-action" role="group" aria-label="Фильтр галереи">
          <button type="button" className="on" aria-pressed="true">
            Все
          </button>
          <button type="button" aria-pressed="false" disabled title="Скоро">
            Неиспользованные
          </button>
          <button type="button" aria-pressed="false" disabled title="Скоро">
            Отклонённые
          </button>
        </div>
      </div>

      {error && (
        <ErrorNotice
          error={error}
          actions={
            <button type="button" className="btn btn-s" onClick={onRetry}>
              Повторить
            </button>
          }
        />
      )}

      {loading ? (
        <div className="photos-grid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="ph photo-tile">
              <div className="shim" />
            </div>
          ))}
        </div>
      ) : empty ? (
        <div className="photos-empty">
          <span className="cand-slot-title">Фото пока нет</span>
          <span className="cand-slot-sub">Задайте запуск выше — готовые кадры появятся здесь.</span>
        </div>
      ) : (
        (gallery !== null || pending !== null) && (
          <div className="photos-grid">
            {pending && <PendingTiles pending={pending} />}
            {photos.map((photo, i) => (
              <PhotoTile key={photo.photoId} photo={photo} position={i + 1} picked={picked.has(photo.photoId)} refused={refused?.has(photo.photoId) ?? false} onToggle={onToggle} />
            ))}
            {skipped > 0 && (
              <div className="ph photo-tile photo-tile-skipped" role="note" aria-label="Показаны не все фото">
                <span className="flag" aria-hidden="true">
                  <Icon name="alert" size={15} />
                </span>
                <span className="cand-slot-title">Показаны не все фото</span>
                <span className="cand-slot-sub">Ещё {countOf(skipped, SKIPPED_FORMS)}.</span>
              </div>
            )}
          </div>
        )
      )}
    </section>
  );
}
