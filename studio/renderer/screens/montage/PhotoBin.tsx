import { useId } from "react";
import type { MontageDraft, PhotoSummary } from "../../../shared/engine";
import { Icon } from "../../ui/Icon";
import { Portrait } from "../../ui/Portrait";
import { binFacets, type BinFilter, binTiles, type BinTile, tileAction } from "./bin";
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
  readonly filter: BinFilter;
  readonly onFilter: (filter: BinFilter) => void;
  /** A click on a photo: select its clip when it is placed, else fill `fillTarget` or add a clip at the end. */
  readonly onPick: (photoId: string) => void;
  /**
   * The selected clip's cell a click goes into instead of adding a clip: an empty one is filled; one the owner selected with a photo in it
   * (`replace`) has its photo replaced (slice review 5-M5).
   */
  readonly fillTarget: FillTarget;
  /** Why a click cannot add a clip (20 clips, or no 0.5 s left of 15 s). */
  readonly addBlock: AddRefusal | null;
  /** A free photo dragged out of the bin (onto the track or a cell), or null when the drag ends. */
  readonly onDragPhoto: (photoId: string | null) => void;
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

export function PhotoBin({ avatarName, avatarId, spec, photos, filter, onFilter, onPick, fillTarget, addBlock, onDragPhoto }: PhotoBinProps) {
  const hintId = useId();
  const categoryId = useId();
  const all = photos ?? [];
  const eligible = all.filter((p) => p.eligible).length;
  const tiles = binTiles(all, spec, filter);
  const facets = binFacets(all, filter);
  const filtered = filter.unusedOnly || filter.category !== null;

  return (
    <>
      <div className="ed-chips">
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
            {facets.categories.map(({ category, label, count }) => (
              <option key={category} value={category}>
                {`${label} · ${count}`}
              </option>
            ))}
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
        <p className="faint ed-bin-empty">Подходящих фото у аватара пока нет. Сгенерируйте их на экране «Фото».</p>
      ) : tiles.length === 0 && filtered ? (
        <div className="ed-bin-empty">
          <p className="faint">{filter.unusedOnly && filter.category === null ? "Свободных фото не осталось: все уже в видео или в рендере." : "Под эти фильтры фото нет."}</p>
          <button type="button" className="btn btn-s" onClick={() => onFilter({ unusedOnly: false, category: null })}>
            Показать все фото
          </button>
        </div>
      ) : (
        <ul className="ed-bin" aria-label="Фото аватара">
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
      {eligible > 0 && (
        <p id={hintId} className={addBlock !== null && fillTarget === null ? "ed-bin-hint ed-bin-hint-full" : "faint ed-bin-hint"}>
          {binHint(fillTarget, addBlock)}
        </p>
      )}
    </>
  );
}
