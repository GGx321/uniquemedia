import { useEffect, useId, useRef, useState } from "react";
import type { AvatarSummary, EngineError, PhotoSummary } from "../../../shared/engine";
import { countOf } from "../../lib/format";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice } from "../../ui/Notice";
import { Portrait, Silhouette } from "../../ui/Portrait";
import { PhotoViewer } from "./PhotoViewer";
import { heldLabel, montagePickRefusal, PhotoBadges, type MarkControl } from "./photoState";
import { CATEGORY_LABEL } from "./runForm";
import { viewerPhotos, viewerPlace } from "./viewerModel";
import { galleryPhotos, type GalleryFilter } from "./videosModel";

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

const FILTERS: readonly { id: GalleryFilter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "unused", label: "Неиспользованные" },
  { id: "rejected", label: "Отклонённые" },
];

interface PhotoTileProps {
  photo: PhotoSummary;
  position: number;
  picked: boolean;
  refused: boolean;
  onToggle: (photoId: string) => void;
  mark: MarkControl;
  /** Open the photo in the viewer. */
  onOpen: (photoId: string) => void;
}

function PhotoTile({ photo, position, picked, refused, onToggle, mark, onOpen }: PhotoTileProps) {
  const label = CATEGORY_LABEL[photo.category];
  // A photo picked before it became unusable can still be unpicked.
  const why = montagePickRefusal(photo);
  // One photo, one video (Q1): a photo a video or a render holds is dimmed with how it is held, as in the editor's bin.
  const held = heldLabel(photo);
  const marking = mark.marking.has(photo.photoId);
  const classes = [
    "ph",
    "photo-tile",
    picked ? "photo-tile-on" : "",
    refused ? "photo-tile-refused" : "",
    held !== null ? "photo-tile-used" : "",
    photo.rejected ? "photo-tile-rejected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      {/* The photo itself opens the viewer; the pick and the mark below are its siblings, never inside it. */}
      <button type="button" className="photo-open" data-photo-id={photo.photoId} aria-label={`Открыть фото ${position}: ${label}`} aria-haspopup="dialog" onClick={() => onOpen(photo.photoId)}>
        <Portrait avatarId={photo.avatarId} photoId={photo.photoId} label={`Фото ${position}: ${label}`} />
      </button>
      {(held !== null || photo.rejected) && <span className="photo-held-dim" aria-hidden="true" />}
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
        <PhotoBadges photo={photo} />
      </div>
      <span className="pill photo-label">{label}</span>
      <button
        type="button"
        className={photo.rejected ? "photo-mark photo-mark-on" : "photo-mark"}
        aria-label={`Фото ${position}: ${photo.rejected ? "вернуть из отклонённых" : "отклонить — в видео не брать"}`}
        title={mark.blocked ?? (photo.rejected ? "Вернуть: фото снова можно брать в видео" : "Отклонить: это фото не пойдёт в видео")}
        disabled={marking || mark.blocked !== null}
        onClick={() => mark.onMark(photo, !photo.rejected)}
      >
        {marking ? <Spin /> : <Icon name={photo.rejected ? "reload" : "close"} size={13} strokeWidth={2.4} />}
      </button>
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

/** What the gallery says when a filter leaves nothing. */
function emptyText(filter: GalleryFilter, usage: AvatarSummary["usage"]): { title: string; text: string } {
  if (filter === "unused") {
    return usage.state === "unknown"
      ? { title: "Свободные фото не известны", text: "Пока использование фото неизвестно, Studio не считает ни одно фото свободным." }
      : { title: "Неиспользованных фото нет", text: "Все подходящие фото уже в видео или в рендере. Новые кадры появятся после запуска выше." };
  }
  if (filter === "rejected") return { title: "Отклонённых фото нет", text: "Отклонённое фото не попадает в видео. Отклонить можно кнопкой на фото." };
  return { title: "Фото пока нет", text: "Задайте запуск выше — готовые кадры появятся здесь." };
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
  /** «Все / Неиспользованные / Отклонённые» (F4). */
  filter: GalleryFilter;
  onFilter: (filter: GalleryFilter) => void;
  /** Whether the avatar's usage can be trusted: «Неиспользованные» is empty while it cannot. */
  usage: AvatarSummary["usage"];
  mark: MarkControl;
}

/**
 * The avatar's run photos, newest first (`photos.list`), each with its face
 * similarity badge — or «лицо не проверялось» when the gate did not judge it
 * (a profile or back shot, or a photo from before the gate). The filter
 * (3e.2) shows every photo, the ones a montage may still take, or the owner's
 * rejected ones; a tile's own button rejects or restores it. A click on a
 * tile's photo opens it in the viewer (PhotoViewer), which steps through the
 * photos as the filter shows them.
 */
export function Gallery({ gallery, error, pending, picked, refused, onToggle, onRetry, filter, onFilter, usage, mark }: GalleryProps) {
  const titleId = useId(); // L12: was the hardcoded "gallery-title"
  const sectionRef = useRef<HTMLElement>(null);
  /** The photo open in the viewer, by id: a list that changes under it moves its number, never what it shows. */
  const [viewing, setViewing] = useState<string | null>(null);
  const loading = gallery === null && error === null;
  const photos = galleryPhotos(gallery?.photos ?? [], filter, usage);
  const skipped = filter === "all" ? (gallery?.skippedTotal ?? 0) : 0;
  const slots = filter === "all" ? pending : null;
  const empty = gallery !== null && photos.length === 0 && skipped === 0 && slots === null;
  const nothing = emptyText(filter, usage);
  // A photo's number is its place in the whole gallery, whatever the filter shows.
  const positions = new Map((gallery?.photos ?? []).map((p, i) => [p.photoId, i + 1]));
  const place = viewing === null ? null : viewerPlace(viewerPhotos(gallery?.photos ?? [], photos, viewing), viewing);
  // The photo on screen left the gallery (its sidecar unreadable now, say): the viewer closes, and stays closed if it returns.
  const gone = viewing !== null && place === null;
  useEffect(() => {
    if (gone) setViewing(null);
  }, [gone]);

  /** Where the focus goes when the viewer closes: the tile of the photo it showed, else the tile now in that photo's place. */
  const tileFor = (photoId: string, index: number): HTMLElement | null => {
    const tiles = Array.from(sectionRef.current?.querySelectorAll<HTMLButtonElement>("button.photo-open") ?? []);
    return tiles.find((tile) => tile.dataset.photoId === photoId) ?? tiles[Math.min(index, tiles.length - 1)] ?? null;
  };

  return (
    <section ref={sectionRef} className="photos-gallery" aria-labelledby={titleId} aria-busy={loading}>
      <div className="photos-sec-head">
        <h2 id={titleId} className="card-title">
          Галерея
        </h2>
        <div className="seg photos-sec-action" role="group" aria-label="Фильтр галереи">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={filter === f.id ? "on" : undefined} aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}>
              {f.label}
            </button>
          ))}
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
          <span className="cand-slot-title">{nothing.title}</span>
          <span className="cand-slot-sub">{nothing.text}</span>
        </div>
      ) : (
        (gallery !== null || slots !== null) && (
          <div className="photos-grid">
            {slots && <PendingTiles pending={slots} />}
            {photos.map((photo) => (
              <PhotoTile
                key={photo.photoId}
                photo={photo}
                position={positions.get(photo.photoId) ?? 0}
                picked={picked.has(photo.photoId)}
                refused={refused?.has(photo.photoId) ?? false}
                onToggle={onToggle}
                mark={mark}
                onOpen={setViewing}
              />
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

      {place !== null && (
        <PhotoViewer
          place={place}
          picked={picked.has(place.photo.photoId)}
          refused={refused?.has(place.photo.photoId) ?? false}
          onToggle={onToggle}
          mark={mark}
          onShow={setViewing}
          onClose={() => setViewing(null)}
          returnFocus={tileFor}
        />
      )}
    </section>
  );
}
