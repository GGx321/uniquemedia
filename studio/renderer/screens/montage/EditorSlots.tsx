import { type Ref, useId } from "react";
import type { MontageDraft, PhotoSummary } from "../../../shared/engine";
import { MAX_CLIPS } from "../../../shared/montage";
import { Icon, type IconName } from "../../ui/Icon";
import { Portrait } from "../../ui/Portrait";
import type { AddRefusal } from "./clipOps";
import { ClipPoster } from "./ClipPoster";
import { addBlockedLabel } from "./labels";

// The editor's regions (Editor.dc.html), each a SLOT a later task fills. 3d.2 drew what was already true; 3d.3a
// places photos from the «Фото» tab, shows the clip under the playhead, and the timeline (Timeline.tsx) and the
// clip properties (ClipProperties.tsx) are their own files. Every control that needs a later task is either left
// out or disabled with «Скоро» (N9: text, stickers and music until their slices lift it; own media until 3f).

const MEDIA_TABS: readonly { id: string; label: string; icon: IconName; soon?: string }[] = [
  { id: "photos", label: "Фото", icon: "image" },
  { id: "mine", label: "Мои", icon: "folder", soon: "Свои файлы — скоро" },
  { id: "music", label: "Музыка", icon: "music", soon: "Музыка — скоро" },
  { id: "gif", label: "GIF", icon: "sparkle", soon: "Стикеры — скоро" },
  { id: "text", label: "Текст", icon: "text", soon: "Текст — скоро" },
];

/** Where each photo of the draft stands: the number of the first clip holding it (the bin's slot badge, P10). */
function slotsOf(spec: MontageDraft): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  spec.clips.forEach((clip, i) => {
    const cells = clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
    for (const cell of cells) if (cell.photo?.source === "scene" && !slots.has(cell.photo.photoId)) slots.set(cell.photo.photoId, i + 1);
  });
  return slots;
}

const VIDEO_FORMS = (n: number): string => `в ${n} видео`;

/** A photo that may go into the montage: eligible, and in no video and no render (one photo → one video, Q1). */
export function isFreePhoto(photo: PhotoSummary): boolean {
  return photo.eligible && !photo.used && !photo.reserved && photo.usedIn.length === 0;
}

export interface MediaPanelProps {
  readonly avatarName: string;
  readonly avatarId: string;
  readonly spec: MontageDraft;
  readonly photos: readonly PhotoSummary[] | null;
  readonly tabRef?: Ref<HTMLButtonElement>;
  /** A click on a photo: select its clip when it is placed, else fill `fillTarget` or add a clip at the end. */
  readonly onPick: (photoId: string) => void;
  /** An empty cell of the selected clip, which a click fills instead of adding a clip. */
  readonly fillTarget: { readonly clip: number; readonly cell: number } | null;
  /** Why a click cannot add a clip (20 clips, or no 0.5 s left of 15 s). */
  readonly addBlock: AddRefusal | null;
  /** A free photo dragged out of the bin (onto the track or a cell), or null when the drag ends. */
  readonly onDragPhoto: (photoId: string | null) => void;
}

/** The bin's line under the photos: what a click does now. */
function binHint(fillTarget: MediaPanelProps["fillTarget"], addBlock: AddRefusal | null): string {
  if (fillTarget !== null) return `Клик — фото в ячейку ${fillTarget.cell + 1} кадра ${fillTarget.clip + 1}. Перетащите фото на дорожку «Кадры», чтобы вставить новый кадр.`;
  if (addBlock !== null) return addBlockedLabel(addBlock);
  return "Клик — кадр в конец ролика. Перетащите фото на дорожку «Кадры», чтобы вставить его между кадрами.";
}

/**
 * The «Фото» tab (3d.3a places photos; SLOT 3d.5: the filters, the «Мои» / «Музыка» / «GIF» / «Текст» tabs): the
 * tabs, the draft's avatar as a read-only chip (CF15), and the avatar's eligible photos with their slot badges. A
 * click places a free photo (or selects the clip holding a placed one); a free photo can be dragged onto the track
 * or onto a cell. A photo in a video or a render is dimmed and cannot be added (one photo → one video, Q1).
 */
export function MediaPanel({ avatarName, avatarId, spec, photos, tabRef, onPick, fillTarget, addBlock, onDragPhoto }: MediaPanelProps) {
  const panelId = useId();
  const tabId = useId();
  const hintId = useId();
  const slots = slotsOf(spec);
  const bin = (photos ?? []).filter((p) => p.eligible);
  return (
    <aside className="ed-media" aria-label="Медиа" data-slot="media 3d.3a 3d.5">
      <div className="ed-tabs" role="tablist" aria-label="Тип медиа">
        {MEDIA_TABS.map((tab) => {
          const selected = tab.id === "photos";
          return (
            <button
              key={tab.id}
              ref={selected ? tabRef : undefined}
              id={selected ? tabId : undefined}
              type="button"
              role="tab"
              className={selected ? "mt mt-on" : "mt"}
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              disabled={tab.soon !== undefined}
              title={tab.soon}
            >
              <Icon name={tab.icon} size={17} strokeWidth={1.9} />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div id={panelId} className="ed-media-panel" role="tabpanel" aria-labelledby={tabId}>
        <div className="ed-chips">
          <span className="chip ed-chip-fixed" title="Аватар черновика не меняется">
            {avatarName}
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
        ) : bin.length === 0 ? (
          <p className="faint ed-bin-empty">Подходящих фото у аватара пока нет. Сгенерируйте их на экране «Фото».</p>
        ) : (
          <ul className="ed-bin" aria-label="Фото аватара">
            {bin.map((photo, i) => {
              const slot = slots.get(photo.photoId);
              const inVideos = photo.usedIn.length;
              const busy = slot === undefined && !isFreePhoto(photo);
              const state = slot !== undefined ? ` · в кадре ${slot}` : inVideos > 0 ? ` · использовано ${VIDEO_FORMS(inVideos)}` : photo.reserved ? " · в рендере" : " · не использовано";
              // A free photo is placed by a click (unless the clips are full and no cell waits for it); a placed one selects its clip.
              const blocked = busy || (slot === undefined && fillTarget === null && addBlock !== null);
              const action = slot !== undefined ? `Выбрать кадр ${slot}` : busy ? "Фото уже занято" : fillTarget !== null ? `В ячейку ${fillTarget.cell + 1} кадра ${fillTarget.clip + 1}` : "Добавить кадр в конец ролика";
              const draggable = slot === undefined && !busy;
              return (
                <li key={photo.photoId} className={slot !== undefined ? "ph ed-bin-tile ed-bin-tile-in" : "ph ed-bin-tile"} aria-label={`Фото ${i + 1}${state}`}>
                  <button
                    type="button"
                    className="ed-bin-pick"
                    aria-label={action}
                    aria-describedby={hintId}
                    disabled={blocked}
                    draggable={draggable}
                    onClick={() => onPick(photo.photoId)}
                    onDragStart={(e) => {
                      if (!draggable) return;
                      if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = "copy";
                        // Chromium needs some data to start a drag; the photo itself travels in renderer state.
                        e.dataTransfer.setData("text/plain", `Фото ${i + 1}`);
                      }
                      onDragPhoto(photo.photoId);
                    }}
                    onDragEnd={() => onDragPhoto(null)}
                  >
                    <Portrait avatarId={avatarId} photoId={photo.photoId} label={`Фото ${i + 1}`} />
                  </button>
                  {busy && (
                    <>
                      <span className="ed-bin-dim" aria-hidden="true" />
                      <span className="pill mono ed-bin-used">{inVideos > 0 ? VIDEO_FORMS(inVideos) : photo.used ? "в видео" : "в рендере"}</span>
                    </>
                  )}
                  {slot !== undefined && <span className="mono ed-bin-slot">{slot}</span>}
                </li>
              );
            })}
          </ul>
        )}
        {bin.length > 0 && (
          <p id={hintId} className={addBlock !== null && fillTarget === null ? "ed-bin-hint ed-bin-hint-full" : "faint ed-bin-hint"}>
            {binHint(fillTarget, addBlock)}
          </p>
        )}
      </div>
    </aside>
  );
}

/** The clip on screen at `ms` (half-open ranges); at or past the end, the last clip. Null for an empty draft. */
export function clipIndexAt(spec: MontageDraft, ms: number): number | null {
  if (spec.clips.length === 0) return null;
  let start = 0;
  for (const [i, clip] of spec.clips.entries()) {
    if (ms < start + clip.durationMs) return i;
    start += clip.durationMs;
  }
  return spec.clips.length - 1;
}

/**
 * SLOT 3d.4 (the live preview: motion, the focus drag, text and stickers, «Зоны Reels» and «Полоски слайдов»).
 * Here: the 9:16 frame at the artboard's 306 × 544 with a still of the clip under the playhead, or «Ролик пока пуст».
 */
export function PreviewSlot({ spec, playheadMs }: { spec: MontageDraft; playheadMs: number }) {
  const at = clipIndexAt(spec, playheadMs);
  const first = at === null ? undefined : spec.clips[at];
  return (
    <section className="ed-preview" aria-label="Превью" data-slot="preview 3d.4">
      <div className="ed-frame">
        {first === undefined ? (
          <div className="ed-frame-empty">
            <span className="tile-icon ed-frame-empty-icon" aria-hidden="true">
              <Icon name="image" size={20} />
            </span>
            <span className="ed-frame-empty-title">Ролик пока пуст</span>
            <span className="faint ed-frame-empty-text">Кликните фото слева — оно станет первым кадром. Длина ролика — от 4 до 15 с.</span>
          </div>
        ) : (
          <ClipPoster clip={first} avatarId={spec.avatarId} emptyCells />
        )}
      </div>
    </section>
  );
}

const COMPOSITION: readonly { icon: IconName; title: string; sub: string; tone: string }[] = [
  { icon: "film", title: "Кадры", sub: `фото, коллаж 2–4 или своё видео · до ${MAX_CLIPS}`, tone: "clip" },
  { icon: "text", title: "Текст", sub: "английский и эмодзи · до 10 слоёв", tone: "text" },
  { icon: "sparkle", title: "Стикеры", sub: "встроенные или свои · до 10", tone: "sticker" },
  { icon: "music", title: "Музыка", sub: "один трек из трендов на весь ролик", tone: "music" },
];

/** SLOT 3d.5 (the selected clip's, text's, sticker's or track's properties). Here: nothing can be selected yet (R1, R2). */
export function PropertiesSlot({ empty }: { empty: boolean }) {
  return (
    <aside className="ed-props" aria-label="Свойства" data-slot="properties 3d.5">
      <div className="ed-props-head">
        <span className="lbl">Свойства</span>
        <span className="mono faint ed-props-sub">{empty ? "ролик пуст" : "ничего не выбрано"}</span>
      </div>
      <p className="muted ed-props-text">Выберите кадр, текст, стикер или музыку на таймлайне — здесь появятся их настройки.</p>
      <ul className="ed-compose" aria-label="Из чего собирается ролик">
        {COMPOSITION.map((item) => (
          <li key={item.title} className={`ed-compose-item ed-compose-${item.tone}`}>
            <Icon name={item.icon} size={15} />
            <span className="ed-compose-body">
              <span className="ed-compose-title">{item.title}</span>
              <span className="faint">{item.sub}</span>
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
