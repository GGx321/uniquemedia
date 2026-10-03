import type { MontageDraft } from "../../../shared/engine";
import { MAX_CLIPS } from "../../../shared/montage";
import { Icon, type IconName } from "../../ui/Icon";
import { ClipPoster } from "./ClipPoster";

// The editor's regions (Editor.dc.html), each a SLOT a later task fills. 3d.2 drew what was already true; 3d.3a showed the clip
// under the playhead; the timeline (Timeline.tsx), the media panel (MediaPanel.tsx and its tabs, 3d.5) and the properties
// (ClipProperties.tsx, LayerProperties.tsx, MusicCard.tsx) are their own files. What is left here: the preview (3d.4 fills it)
// and the properties panel with nothing selected.

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

/** The properties panel with nothing selected (R1, R2): what a montage is made of, and its caps. */
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
