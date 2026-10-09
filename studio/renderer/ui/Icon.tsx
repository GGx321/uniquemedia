import type { ReactNode } from "react";

// Paths are the sheet's own (Studio — макет, «Компоненты»), 24×24 stroke icons.
const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  back: <path d="M15 18l-6-6 6-6" />,
  /** `back` mirrored: the photo viewer's «Следующее фото». */
  forward: <path d="M9 18l6-6-6-6" />,
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" />
      <circle cx="15" cy="15" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  reload: (
    <>
      <path d="M20 11a8 8 0 10-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17.5v.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.01" />
    </>
  ),
  scale: (
    <>
      <path d="M12 3v17M7 20h10M5 7h14" />
      <path d="M5 7l-3 6a3 3 0 006 0zM19 7l-3 6a3 3 0 006 0z" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4M7 9l5-5 5 5" />
      <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A9.8 9.8 0 0112 5c5 0 8.5 4.5 9.5 7a13 13 0 01-2.6 3.9M6.3 6.3C4.3 7.7 3 9.8 2.5 12c1 2.5 4.5 7 9.5 7 1.8 0 3.4-.5 4.8-1.3" />
      <path d="M9.9 9.9a3 3 0 004.2 4.2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
    </>
  ),
  // Stage 3's montage editor (Editor.dc.html, EditorEmpty.dc.html).
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 000 12h3" />
    </>
  ),
  pencil: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  music: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </>
  ),
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  text: <path d="M5 6h14M12 6v13" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  /** CS.6: the scenes column's «N не составлены ↓», a link down to the first such scene. */
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
    </>
  ),
  face: (
    <>
      <path d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2" />
      <circle cx="12" cy="11" r="3" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  /** «Слой выше» / «Слой ниже» (3d.3b): two stacked sheets and the way the selected one goes. */
  layerUp: (
    <>
      <path d="M4 15l8 4 8-4" />
      <path d="M12 3v10M8 7l4-4 4 4" />
    </>
  ),
  layerDown: (
    <>
      <path d="M4 9l8-4 8 4" />
      <path d="M12 21V11M8 17l4 4 4-4" />
    </>
  ),
  /** «Звук видео не используется» (3f.3b, EditorMine): a speaker struck out. */
  soundOff: (
    <>
      <path d="M4 10v4h4l5 4V6L8 10z" />
      <path d="M17 9l4 6M21 9l-4 6" />
    </>
  ),
  /** «Автопилот» (S4.9a): the sidebar's own bolt, on «Запустить». */
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  /** S4.9a: «Активных аватаров нет», the sidebar's «Аватары» figure. */
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-3.9 3.6-6 8-6s8 2.1 8 6" />
    </>
  ),
  /** S4.9b: «Studio был закрыт — запуск ждёт вас» (ApPausedRestart). */
  pause: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 9v6M14 9v6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/** A stroke icon; decorative unless the caller labels its button. */
export function Icon({ name, size = 16, strokeWidth = 2 }: { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The sheet's filled play triangle («Рендер», «Воспроизвести»): a fill, not a stroke like the icons above. */
export function PlayIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

/** Two filled bars: «Пауза» on the timeline's play button while it plays. */
export function PauseIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
    </svg>
  );
}

/** The sheet's 14px spinner for a busy button; the button's own text says what is happening. */
export function Spin() {
  return <span className="spin" aria-hidden="true" />;
}
