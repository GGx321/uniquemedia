import type { PointerEvent as ReactPointerEvent } from "react";

// The timeline's pointer gestures (3d.3a, shared with 3d.3b's layer and music tracks): a press tracked on the window, so
// a drag keeps going wherever the pointer goes, and one gesture at a time.

/**
 * Window-wide pointer tracking from a press: the gesture keeps going wherever the pointer goes. `onEnd` gets the
 * release, or null when the gesture was cancelled (`pointercancel`, a new gesture, the timeline closing).
 */
export function trackPointer(press: ReactPointerEvent, onMove: (event: PointerEvent) => void, onEnd: (event: PointerEvent | null) => void): () => void {
  const id = press.pointerId;
  const move = (event: PointerEvent): void => {
    if (event.pointerId === id) onMove(event);
  };
  const stop = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
  };
  const up = (event: PointerEvent): void => {
    if (event.pointerId !== id) return;
    stop();
    onEnd(event);
  };
  // The system took the pointer (a gesture, a lost capture): the gesture is cancelled, never dropped where it stood.
  const cancel = (event: PointerEvent): void => {
    if (event.pointerId !== id) return;
    stop();
    onEnd(null);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  return () => {
    stop();
    onEnd(null);
  };
}

/** What the timeline lends its tracks for a gesture: one gesture at a time, and the pointer's place on the 15 s scale. */
export interface GestureKit {
  /** Starts a gesture from `press`, ending any other one first (it is cancelled). */
  start(press: ReactPointerEvent, onMove: (event: PointerEvent) => void, onEnd: (event: PointerEvent | null) => void): void;
  /** Pixels per ms of the lanes as they are laid out now (a zoom or a resize mid-drag included). */
  pxPerMs(): number;
  /** The click that ends a drag is not a selection: the track sets this, the block's click reads it. */
  swallowClick(): void;
  readonly clickSwallowed: () => boolean;
}

/** A pointer must travel this far before a press on a block becomes a drag. */
export const DRAG_THRESHOLD_PX = 4;
/** An edge this close to a snap target meets it. */
export const SNAP_PX = 8;
