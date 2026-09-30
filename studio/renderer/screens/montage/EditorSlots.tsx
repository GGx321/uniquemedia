import { type Ref, useId } from "react";
import type { MontageDraft, PhotoSummary } from "../../../shared/engine";
import { MAX_CLIPS, MAX_TOTAL_MS } from "../../../shared/montage";
import { useEngine } from "../../engine/react";
import { photoUrl, placeholderGradient } from "../../lib/media";
import { Icon, type IconName } from "../../ui/Icon";
import { Portrait } from "../../ui/Portrait";
import { ClipPoster } from "./ClipPoster";
import { clockLabel, secondsLabel } from "./labels";

// The editor's four regions (Editor.dc.html), each a SLOT a later task fills. 3d.2 draws what is already true:
// the tabs and the avatar's photos read-only, a still of the first clip, the «nothing selected» properties, and
// the timeline's frame with its tracks. Every control that needs a later task is either left out or disabled with
// «Скоро» (N9: text, stickers and music until their slices lift it; own media until 3f).

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

/**
 * SLOT 3d.5 (media panel: filters, the «Мои» / «Музыка» / «GIF» / «Текст» tabs) and 3d.3a (a click or a drag
 * places a photo). Here: the tabs, the draft's avatar as a read-only chip (CF15), and the avatar's eligible
 * photos with their slot badges; a photo already in a video is dimmed (one photo → one video, Q1).
 */
export function MediaPanel({ avatarName, avatarId, spec, photos, tabRef }: { avatarName: string; avatarId: string; spec: MontageDraft; photos: readonly PhotoSummary[] | null; tabRef?: Ref<HTMLButtonElement> }) {
  const panelId = useId();
  const tabId = useId();
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
              const busy = slot === undefined && (inVideos > 0 || photo.used || photo.reserved);
              const state = slot !== undefined ? ` · в кадре ${slot}` : inVideos > 0 ? ` · использовано ${VIDEO_FORMS(inVideos)}` : photo.reserved ? " · в рендере" : " · не использовано";
              return (
                <li key={photo.photoId} className={slot !== undefined ? "ph ed-bin-tile ed-bin-tile-in" : "ph ed-bin-tile"} aria-label={`Фото ${i + 1}${state}`}>
                  <Portrait avatarId={avatarId} photoId={photo.photoId} label={`Фото ${i + 1}`} />
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
      </div>
    </aside>
  );
}

/**
 * SLOT 3d.4 (the live preview: motion, the focus drag, text and stickers, «Зоны Reels» and «Полоски слайдов»).
 * Here: the 9:16 frame at the artboard's 306 × 544 with a still of the first clip, or «Ролик пока пуст».
 */
export function PreviewSlot({ spec }: { spec: MontageDraft }) {
  const first = spec.clips[0];
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

const pctOfMax = (ms: number): string => `${(ms / MAX_TOTAL_MS) * 100}%`;

/** A clip's film strip: its photos repeated along the block, as the artboard draws the main track. */
function stripOf(kind: string, avatarId: string, photoId: string | null): string {
  if (photoId === null) return "var(--photo-queued)";
  const url = kind === "mock" ? null : photoUrl(avatarId, photoId);
  // The mock has no images: its placeholder gradient is tiled in the artboard's 24 px frames instead.
  return url === null ? `${placeholderGradient(photoId)} 0 0 / 24px 100% repeat-x` : `url("${url}") 0 0 / auto 100% repeat-x`;
}

const LAYOUT_TAG = { collage2: "коллаж 2", collage3: "коллаж 3", collage4: "коллаж 4" } as const;

/**
 * SLOT 3d.3a (toolbar, selection, trim, reorder, split, the playhead) and 3d.3b (text and sticker blocks, the music
 * block). Here: the clock and the length, the track headers with their counts, the ruler, the clips read-only,
 * and the empty draft's dashed «Перетащите фото или видео сюда» and «Добавить музыку» (EditorNew).
 */
export function TimelineSlot({ spec, flagged, onAddClip }: { spec: MontageDraft; flagged: readonly number[]; onAddClip: () => void }) {
  const { client } = useEngine();
  const totalMs = spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
  const texts = spec.layers.filter((l) => l.kind === "text").length;
  const stickers = spec.layers.filter((l) => l.kind === "sticker").length;
  const empty = spec.clips.length === 0;
  let start = 0;
  return (
    <section className="ed-timeline" aria-label="Таймлайн" data-slot="timeline 3d.3a 3d.3b">
      <div className="ed-tl-bar">
        <span className="mono ed-tl-clock">
          {clockLabel(0)} <span className="faint">/ {clockLabel(totalMs)}</span>
        </span>
        <span className="ed-tl-sep" aria-hidden="true" />
        <span className="mono faint">
          ролик {secondsLabel(totalMs)} · от 4 до 15 с
        </span>
      </div>
      <div className="ed-tl-body">
        <div className="ed-tl-heads">
          <div className="ed-tl-ruler-gap" />
          <div className="th ed-th-text">
            <Icon name="text" size={14} />
            Текст <span className="mono faint">{texts}</span>
            <button type="button" className="tadd" aria-label="Добавить текст" disabled title="Текст — скоро">
              <Icon name="plus" size={11} strokeWidth={2.6} />
            </button>
          </div>
          <div className="th ed-th-sticker">
            <Icon name="sparkle" size={14} />
            Стикеры <span className="mono faint">{stickers}</span>
            <button type="button" className="tadd" aria-label="Добавить стикер" disabled title="Стикеры — скоро">
              <Icon name="plus" size={11} strokeWidth={2.6} />
            </button>
          </div>
          <div className="th ed-th-clips">
            <Icon name="film" size={14} />
            Кадры <span className="mono faint">{spec.clips.length}</span>
            <button type="button" className="tadd" aria-label="Добавить кадр" onClick={onAddClip}>
              <Icon name="plus" size={11} strokeWidth={2.6} />
            </button>
          </div>
          <div className="th ed-th-music">
            <Icon name="music" size={14} />
            Музыка
          </div>
        </div>
        <div className="ed-tl-lanes">
          <div className="ed-ruler" aria-hidden="true">
            {Array.from({ length: 31 }, (_, i) => (
              <span key={i} className={i % 2 === 0 ? "ed-tick ed-tick-major" : "ed-tick"} style={{ left: pctOfMax(i * 500) }} />
            ))}
            {Array.from({ length: 16 }, (_, s) => (
              <span
                key={`l${s}`}
                className={s * 1000 > totalMs ? "mono ed-tick-label ed-tick-label-after" : "mono ed-tick-label"}
                // The first label starts at its tick, the last ends at it, the rest are centred on theirs.
                style={{ left: pctOfMax(s * 1000), transform: s === 0 ? "none" : s === 15 ? "translateX(-100%)" : "translateX(-50%)" }}
              >
                {s === 0 ? "0 с" : s === 15 ? "15 с" : s}
              </span>
            ))}
          </div>
          <div className="trk ed-lane-text" />
          <div className="trk ed-lane-text" />
          <div className="trk ed-lane-sticker" />
          <div className="trk ed-lane-clips">
            {empty ? (
              <button type="button" className="ed-lane-drop" onClick={onAddClip}>
                <Icon name="plus" size={13} strokeWidth={2.4} />
                Перетащите фото или видео сюда
              </button>
            ) : (
              <ol className="ed-clips" aria-label="Кадры">
                {spec.clips.map((clip, i) => {
                  const left = start;
                  start += clip.durationMs;
                  const cells = clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
                  const first = cells.find((c) => c.photo?.source === "scene")?.photo;
                  const photoId = first?.source === "scene" ? first.photoId : null;
                  const tag = clip.kind === "collage" ? LAYOUT_TAG[clip.layout] : clip.kind === "video" ? "▶ видео" : null;
                  return (
                    <li
                      key={clip.clipId}
                      className={flagged.includes(i) ? "ed-clip ed-clip-flagged" : "ed-clip"}
                      style={{ left: `calc(${pctOfMax(left)} + 1px)`, width: `calc(${pctOfMax(clip.durationMs)} - 2px)`, background: stripOf(client.kind, spec.avatarId, photoId) }}
                      aria-label={`Кадр ${i + 1}${tag === null ? "" : `, ${tag}`}, ${secondsLabel(clip.durationMs)}`}
                    >
                      {tag !== null && <span className="ctag ed-ctag-top">{tag}</span>}
                      <span className="ctag ed-ctag-bottom">{secondsLabel(clip.durationMs)}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          <div className="trk ed-lane-music">
            {empty && (
              <button type="button" className="ed-lane-music-add" disabled title="Музыка — скоро">
                <Icon name="plus" size={13} strokeWidth={2.4} />
                Добавить музыку
              </button>
            )}
          </div>
          {!empty && <div className="ed-tl-after" style={{ left: pctOfMax(totalMs) }} aria-hidden="true" />}
          <div className="ed-playhead" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
