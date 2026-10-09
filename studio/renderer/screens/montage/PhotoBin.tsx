import { useCallback, useId, useRef } from "react";
import type { MontageDraft, PhotoSummary } from "../../../shared/engine";
import { Icon } from "../../ui/Icon";
import { Portrait } from "../../ui/Portrait";
import { MorePhotos } from "../photos/MorePhotos";
import type { PhotoPages } from "../photos/photoPages";
import type { MoreState } from "../photos/usePhotoPages";
import { binFacets, type BinFilter, binTiles, type BinTile, isBuiltInCategory, tileAction } from "./bin";
import type { AddRefusal } from "./clipOps";
import { addBlockedLabel } from "./labels";
import { type FillTarget, fillWords } from "./mine";

// The «Фото» tab (Editor.dc.html, EditorNew.dc.html; P6–P15). 3d.3a placed photos from it; 3d.5 adds the chips: the draft's avatar
// (read-only, CF15), «Неиспользованные N» (free photos only) and the category. The bin holds the avatar's eligible photos only, each
// with the clip it is in (the slot badge). One photo → one video (Q1): a photo in a video or a render is dimmed and cannot be added.

export interface PhotoBinProps {
  readonly avatarName: string;
  readonly avatarId: string;
  readonly spec: MontageDraft;
  readonly photos: readonly PhotoSummary[] | null;
  /** S4.P2: the pages of photos.list behind `photos`, and «Показать ещё» for the next; null until the first answer. */
  readonly paging?: BinPaging | null;
  readonly filter: BinFilter;
  readonly onFilter: (filter: BinFilter) => void;
  /** A click on a photo: select its clip when it is placed, else fill `fillTarget` or add a clip at the end. */
  readonly onPick: (photoId: string) => void;
  /**
   * The selected clip's cell a click goes into instead of adding a clip: an empty one is filled; one the owner selected with a photo in it
   * (`replace`) has its photo replaced (slice review 5-M5).
   */
  readonly fillTarget: FillTarget;
  /** Why a click cannot add a clip (20 clips, or nothing left of 15 s). */
  readonly addBlock: AddRefusal | null;
  /** A free photo dragged out of the bin (onto the track or a cell), or null when the drag ends. */
  readonly onDragPhoto: (photoId: string | null) => void;
}

/** The bin's «Показать ещё» (S4.P2): the bin is a picker of the avatar's photos, so the photos past the first 500 must be reachable too. */
export interface BinPaging {
  readonly pages: PhotoPages;
  readonly state: MoreState;
  /** The photos the last press brought, in order: the focus goes to the first one the chips show and a click can take. */
  readonly added: readonly string[] | null;
  readonly onMore: () => void;
}

const inVideos = (n: number): string => `в ${n} видео`;

/** The bin's line under the photos: what a click does now. */
function binHint(fillTarget: PhotoBinProps["fillTarget"], addBlock: AddRefusal | null): string {
  if (fillTarget !== null) return `Клик — ${fillTarget.replace === true ? "" : "фото "}${fillWords(fillTarget)}. Перетащите фото на дорожку «Кадры», чтобы вставить новый кадр.`;
  if (addBlock !== null) return addBlockedLabel(addBlock);
  return "Клик — кадр в конец ролика. Перетащите фото на дорожку «Кадры», чтобы вставить его между кадрами.";
}

/** The tile's state after its number: «Фото 3 · в кадре 2». */
function stateLabel(tile: BinTile): string {
  switch (tile.state) {
    case "placed":
      return ` · в кадре ${tile.slot ?? ""}`;
    case "used":
      return ` · использовано ${inVideos(Math.max(1, tile.photo.usedIn.length))}`;
    case "reserved":
      return " · в рендере";
    case "free":
      return " · не использовано";
  }
}

/** What a click does, after the photo's name: «Фото 3: добавить кадр в конец ролика». */
function actionLabel(tile: BinTile, fillTarget: PhotoBinProps["fillTarget"], addBlock: AddRefusal | null): string {
  switch (tileAction(tile, fillTarget, addBlock)) {
    case "select":
      return `выбрать кадр ${tile.slot ?? ""}`;
    case "taken":
      return "уже занято";
    case "fill":
      return fillTarget === null ? "в ячейку" : fillWords(fillTarget);
    case "full":
      return "кадров больше не добавить";
    case "append":
      return "добавить кадр в конец ролика";
  }
}

export function PhotoBin({ avatarName, avatarId, spec, photos, paging = null, filter, onFilter, onPick, fillTarget, addBlock, onDragPhoto }: PhotoBinProps) {
  const hintId = useId();
  const categoryId = useId();
  const binRef = useRef<HTMLUListElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  /** After «Показать ещё»: the first photo it brought that the chips show and a click can take (a taken one's button is off). */
  const firstShown = useCallback((photoIds: readonly string[]): HTMLElement | null => {
    const picks = new Map(Array.from(binRef.current?.querySelectorAll<HTMLButtonElement>("button.ed-bin-pick:not(:disabled)") ?? []).map((pick) => [pick.dataset.photoId, pick]));
    for (const photoId of photoIds) {
      const pick = picks.get(photoId);
      if (pick !== undefined) return pick;
    }
    return null;
  }, []);
  /** None of them shown, and the button gone with the last page: the bin's last photo a click can take, else «Неиспользованные». */
  const lastPick = useCallback((): HTMLElement | null => {
    const picks = Array.from(binRef.current?.querySelectorAll<HTMLElement>("button.ed-bin-pick:not(:disabled)") ?? []);
    return picks.at(-1) ?? chipsRef.current?.querySelector<HTMLElement>("button") ?? null;
  }, []);
  const all = photos ?? [];
  const eligible = all.filter((p) => p.eligible).length;
  const tiles = binTiles(all, spec, filter);
  const facets = binFacets(all, filter);
  const builtIns = facets.categories.filter((c) => isBuiltInCategory(c.category));
  const owners = facets.categories.filter((c) => !isBuiltInCategory(c.category));
  const filtered = filter.unusedOnly || filter.category !== null;
  /** S4.P2: more photos beyond the pages read, where an empty bin may yet find some. */
  const partial = paging !== null && paging.pages.nextCursor !== null;

  return (
    <>
      <div ref={chipsRef} className="ed-chips">
        <span className="chip ed-chip-fixed" title="Аватар черновика не меняется">
          {avatarName}
        </span>
        <button type="button" className={filter.unusedOnly ? "chip chip-on" : "chip"} aria-pressed={filter.unusedOnly} disabled={photos === null} onClick={() => onFilter({ ...filter, unusedOnly: !filter.unusedOnly })}>
          Неиспользованные
          <span className="mono ed-chip-count">{facets.unused}</span>
        </button>
        <span className={filter.category === null ? "chip ed-chip-select" : "chip chip-on ed-chip-select"}>
          <label htmlFor={categoryId} className="sr-only">
            Категория
          </label>
          <select
            id={categoryId}
            value={filter.category ?? ""}
            disabled={photos === null}
            onChange={(e) => {
              const value = e.target.value;
              const category = facets.categories.find((c) => c.category === value)?.category ?? null;
              onFilter({ ...filter, category });
            }}
          >
            <option value="">Все категории</option>
            {builtIns.map(({ category, label, count }) => (
              <option key={category} value={category}>
                {`${label} · ${count}`}
              </option>
            ))}
            {/* CS.7 L1 (decision 6): the owner's own — custom categories by name, «Своя сцена» last — apart from the built-ins, under a line. */}
            {owners.length > 0 && (
              <optgroup label="Свои">
                {owners.map(({ category, label, count }) => (
                  <option key={category} value={category}>
                    {`${label} · ${count}`}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <Icon name="chevronDown" size={12} strokeWidth={2.4} />
        </span>
      </div>
      {photos === null ? (
        <div className="ed-bin" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="ph ed-bin-tile">
              <div className="shim" />
            </div>
          ))}
        </div>
      ) : eligible === 0 ? (
        <p className="faint ed-bin-empty">
          {partial ? "Среди загруженных фото подходящих нет — нажмите «Показать ещё»." : "Подходящих фото у аватара пока нет. Сгенерируйте их на экране «Фото»."}
        </p>
      ) : tiles.length === 0 && filtered ? (
        <div className="ed-bin-empty">
          <p className="faint">
            {partial
              ? "Среди загруженных фото под эти фильтры ничего нет — нажмите «Показать ещё»."
              : filter.unusedOnly && filter.category === null
                ? "Свободных фото не осталось: все уже в видео или в рендере."
                : "Под эти фильтры фото нет."}
          </p>
          <button type="button" className="btn btn-s" onClick={() => onFilter({ unusedOnly: false, category: null })}>
            Показать все фото
          </button>
        </div>
      ) : (
        <ul ref={binRef} className="ed-bin" aria-label="Фото аватара">
          {tiles.map((tile) => {
            const { photo, n, slot } = tile;
            const does = tileAction(tile, fillTarget, addBlock);
            const taken = does === "taken";
            const draggable = tile.state === "free";
            return (
              <li key={photo.photoId} className={slot !== null ? "ph ed-bin-tile ed-bin-tile-in" : "ph ed-bin-tile"} aria-label={`Фото ${n}${stateLabel(tile)}`}>
                <button
                  type="button"
                  className="ed-bin-pick"
                  data-photo-id={photo.photoId}
                  aria-label={`Фото ${n}: ${actionLabel(tile, fillTarget, addBlock)}`}
                  aria-describedby={hintId}
                  disabled={taken || does === "full"}
                  draggable={draggable}
                  onClick={() => onPick(photo.photoId)}
                  onDragStart={(e) => {
                    if (!draggable) return;
                    if (e.dataTransfer) {
                      e.dataTransfer.effectAllowed = "copy";
                      // Chromium needs some data to start a drag; the photo itself travels in renderer state.
                      e.dataTransfer.setData("text/plain", `Фото ${n}`);
                    }
                    onDragPhoto(photo.photoId);
                  }}
                  onDragEnd={() => onDragPhoto(null)}
                >
                  <Portrait avatarId={avatarId} photoId={photo.photoId} label={`Фото ${n}`} />
                </button>
                {taken && (
                  <>
                    <span className="ed-bin-dim" aria-hidden="true" />
                    <span className="pill mono ed-bin-used">{tile.state === "used" ? (photo.usedIn.length > 0 ? inVideos(photo.usedIn.length) : "в видео") : "в рендере"}</span>
                  </>
                )}
                {slot !== null && <span className="mono ed-bin-slot">{slot}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {paging !== null && (
        <MorePhotos pages={paging.pages} more={paging.state} added={paging.added} onMore={paging.onMore} firstShown={firstShown} fallback={lastPick} variant="bin" />
      )}
      {eligible > 0 && (
        <p id={hintId} className={addBlock !== null && fillTarget === null ? "ed-bin-hint ed-bin-hint-full" : "faint ed-bin-hint"}>
          {binHint(fillTarget, addBlock)}
        </p>
      )}
    </>
  );
}
