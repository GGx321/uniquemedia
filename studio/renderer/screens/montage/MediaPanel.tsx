import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { Icon, type IconName } from "../../ui/Icon";

// 3d.5: the editor's left panel (Editor.dc.html and its tab artboards; the reconciliation's P1–P5): the five tabs and the panel of
// the one chosen. «Фото» (the bin), «Мои» (the owner's own files, 3f.6), «Музыка» (the trending list), «GIF» (the built-in stickers)
// and «Текст» (the presets and the text layers). The tab is renderer state: choosing an item on the timeline never switches it (as on
// the artboard), but the timeline's «+» and the properties' «Заменить…» open the tab they need.

export type MediaTab = "photos" | "mine" | "music" | "gif" | "text";

const TABS: readonly { id: MediaTab; label: string; icon: IconName }[] = [
  { id: "photos", label: "Фото", icon: "image" },
  { id: "mine", label: "Мои", icon: "folder" },
  { id: "music", label: "Музыка", icon: "music" },
  { id: "gif", label: "GIF", icon: "sparkle" },
  { id: "text", label: "Текст", icon: "text" },
];

const OPEN: readonly MediaTab[] = TABS.map((t) => t.id);

export interface MediaPanelProps {
  readonly tab: MediaTab;
  readonly onTab: (tab: MediaTab) => void;
  /** Moves the keyboard focus to the chosen tab whenever it changes (the timeline's «+» asked for that tab). */
  readonly focusTick: number;
  readonly children: ReactNode;
}

export function MediaPanel({ tab, onTab, focusTick, children }: MediaPanelProps) {
  const base = useId();
  const buttons = useRef(new Map<MediaTab, HTMLButtonElement>());
  const tabId = (id: MediaTab): string => `${base}-tab-${id}`;
  const panelId = `${base}-panel`;

  // Only a new request moves the focus; a tab chosen by its own click keeps it where it is.
  const current = useRef(tab);
  current.current = tab;
  useEffect(() => {
    if (focusTick > 0) buttons.current.get(current.current)?.focus();
  }, [focusTick]);

  // The tabs pattern: ←/→ (and Home/End) move between the tabs and choose the one landed on.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const at = OPEN.indexOf(tab);
    const moves: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: OPEN.length - 1 };
    const to = moves[event.key];
    if (to === undefined || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const next = OPEN[(to + OPEN.length) % OPEN.length];
    if (next === undefined) return;
    onTab(next);
    buttons.current.get(next)?.focus();
  }

  return (
    <aside className="ed-media" aria-label="Медиа" data-slot="media 3d.5">
      <div className="ed-tabs" role="tablist" aria-label="Тип медиа" onKeyDown={onKeyDown}>
        {TABS.map((item) => {
          const id = item.id;
          const selected = id === tab;
          return (
            <button
              key={id}
              ref={(node) => {
                if (node === null) buttons.current.delete(id);
                else buttons.current.set(id, node);
              }}
              id={tabId(id)}
              type="button"
              role="tab"
              className={selected ? "mt mt-on" : "mt"}
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTab(id)}
            >
              <Icon name={item.icon} size={17} strokeWidth={1.9} />
              {item.label}
            </button>
          );
        })}
      </div>
      <div id={panelId} className={`ed-media-panel ed-media-${tab}`} role="tabpanel" aria-labelledby={tabId(tab)}>
        {children}
      </div>
    </aside>
  );
}
