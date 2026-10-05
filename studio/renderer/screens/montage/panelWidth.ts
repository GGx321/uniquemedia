// The media panel's width (the owner's feedback, 2026-10-05): the border between the panel and the stage is a splitter (PanelSplitter.tsx).
// The width is the viewer's own, kept in localStorage; every access to that storage may throw (a blocked or private profile) and the editor
// works the same without it. The panel is never narrower than the artboard's 280 px, which its rows were drawn for (the «Обновить список —
// в Настройках» button needs all of it on one line; a narrower panel would not give the preview more room either, as the preview is as tall
// as the stage long before it is as wide), and never so wide that the stage loses the room the preview needs.

export const MEDIA_WIDTH: { readonly min: number; readonly default: number; readonly max: number } = { min: 280, default: 280, max: 560 };
/** The properties panel's width: montage.css `.ed-props`, pinned to it by a test (EditorSplitter.test.tsx). */
export const PROPS_PX = 300;
/** What the stage keeps beside the two panels, at least: room for the preview and the «Подсказки» switches. */
export const STAGE_ROOM_PX = 360;
/** ←/→ on the splitter; with ⇧, `BIG_KEY_STEP_PX`. */
export const KEY_STEP_PX = 16;
export const BIG_KEY_STEP_PX = 64;
/** The viewer's width in localStorage. */
export const MEDIA_WIDTH_KEY = "studio.editor.mediaWidth";

/** What the panel needs of a storage. */
export type WidthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const hold = (px: number, min: number, max: number): number => Math.min(max, Math.max(min, px));

/** The widest the panel may be in an editor body `bodyPx` wide (null or 0: not laid out yet): the stage keeps `STAGE_ROOM_PX`. */
export function mediaWidthMax(bodyPx: number | null): number {
  if (bodyPx === null || !(bodyPx > 0)) return MEDIA_WIDTH.max;
  return hold(Math.floor(bodyPx - PROPS_PX - STAGE_ROOM_PX), MEDIA_WIDTH.min, MEDIA_WIDTH.max);
}

/** `px` as a width the panel can take under `max`: whole pixels, never below the minimum; not a number is the default. */
export function clampMediaWidth(px: number, max: number): number {
  const top = Math.max(MEDIA_WIDTH.min, max);
  return hold(Number.isFinite(px) ? Math.round(px) : MEDIA_WIDTH.default, MEDIA_WIDTH.min, top);
}

/** The width a key on the splitter asks for: ←/→ a step (⇧ a big one), Home/End the ends, Enter the default; null for any other key. */
export function keyedWidth(key: string, shift: boolean, width: number, max: number): number | null {
  const step = shift ? BIG_KEY_STEP_PX : KEY_STEP_PX;
  const wanted: Record<string, number> = { ArrowLeft: width - step, ArrowRight: width + step, Home: MEDIA_WIDTH.min, End: max, Enter: MEDIA_WIDTH.default };
  const to = wanted[key];
  return to === undefined ? null : clampMediaWidth(to, max);
}

/** The viewer's storage, or null where reading it throws (a blocked profile). */
export function viewerStorage(): WidthStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The viewer's stored width, held to the absolute range; null when none is stored, it is not a whole number, or the storage throws. */
export function readMediaWidth(storage: WidthStorage | null): number | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(MEDIA_WIDTH_KEY);
  } catch {
    return null;
  }
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return hold(Number(raw), MEDIA_WIDTH.min, MEDIA_WIDTH.max);
}

/** The width the viewer chose (the default when none is kept, or the storage cannot be read). */
export function storedMediaWidth(): number {
  return readMediaWidth(viewerStorage()) ?? MEDIA_WIDTH.default;
}

/** Keeps `px` as the viewer's width (whole pixels); null forgets it. A storage that throws keeps nothing, silently: the width is a convenience. */
export function writeMediaWidth(storage: WidthStorage | null, px: number | null): void {
  if (storage === null) return;
  try {
    if (px === null) storage.removeItem(MEDIA_WIDTH_KEY);
    else storage.setItem(MEDIA_WIDTH_KEY, String(Math.round(px)));
  } catch {
    // Blocked, full or gone: the panel keeps the width for this editor only.
  }
}
