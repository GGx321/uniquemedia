import { MAX_CLIPS } from "../../../shared/montage";
import { Icon, type IconName } from "../../ui/Icon";

// The editor's regions (Editor.dc.html), each a SLOT a later task fills. 3d.2 drew what was already true; the timeline
// (Timeline.tsx), the media panel (MediaPanel.tsx and its tabs, 3d.5), the properties (ClipProperties.tsx, LayerProperties.tsx,
// MusicCard.tsx) and the preview (Preview.tsx, 3d.4) are their own files. What is left here: the properties panel with nothing
// selected.

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
