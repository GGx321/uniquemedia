import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DRAG_THRESHOLD_PX, trackPointer } from "./gesture";
import { clampMediaWidth, keyedWidth, MEDIA_WIDTH, mediaWidthMax, storedMediaWidth, viewerStorage, writeMediaWidth } from "./panelWidth";

// The owner's feedback (2026-10-05): the media panel is resized by the border between it and the stage. The border is a splitter, a focusable
// vertical separator (the WAI-ARIA window splitter): dragged (live, stored when let go; a cancelled drag puts the width back), keyed (←/→ by 16 px,
// ⇧ by 64, Home/End to the ends, Enter back to the default) or double-clicked back to the default. The width is the viewer's own (panelWidth.ts);
// a window too narrow for it draws the panel narrower without forgetting it.

/** The class on the document root while a drag is under way: the col-resize cursor everywhere, and no text selection. */
const RESIZING = "ed-col-resizing";

export interface MediaWidth {
  /** The width the panel is drawn at now. */
  readonly width: number;
  /** The viewer's choice, which a narrow window draws narrower (`width`) without forgetting it. */
  readonly chosen: number;
  /** The widest it may be in the editor as it is laid out now. */
  readonly max: number;
  /** The viewer's chosen width, held to the room there is when drawn; `store` also keeps it (null: back to the default, nothing kept). */
  choose(px: number | null, store: boolean): void;
  /** The editor body's width as laid out (null until it is): it sets `max`. */
  measured(bodyPx: number | null): void;
}

/** The media panel's width: the viewer's stored one (or the default), held to the room the editor has now. */
export function useMediaWidth(): MediaWidth {
  const [chosen, setChosen] = useState<number>(storedMediaWidth);
  const [bodyPx, setBodyPx] = useState<number | null>(null);
  const max = mediaWidthMax(bodyPx);
  return {
    width: clampMediaWidth(chosen, max),
    chosen,
    max,
    choose(px, store) {
      setChosen(px ?? MEDIA_WIDTH.default);
      if (store) writeMediaWidth(viewerStorage(), px);
    },
    measured: setBodyPx,
  };
}

/**
 * The editor body `node` sits in (its row of panels): what sets the panel's room. Measured at once, before the first frame is painted (an
 * observer reports only after a layout, which drew one frame at the unheld width in a narrow window), and on every resize after.
 */
function useBodyWidth(node: RefObject<HTMLElement | null>, measured: (bodyPx: number | null) => void): void {
  useLayoutEffect(() => {
    const body = node.current?.parentElement;
    if (body === null || body === undefined) return;
    const now = body.getBoundingClientRect().width;
    if (now > 0) measured(now);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const px = entries[0]?.contentRect.width;
      if (px !== undefined) measured(px > 0 ? px : null);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [node, measured]);
}

/** The panel's stand-in while the draft loads: already at the width the panel will be drawn at, so nothing jumps when the draft comes. */
export function MediaStandIn() {
  const node = useRef<HTMLDivElement>(null);
  const { width, measured } = useMediaWidth();
  useBodyWidth(node, measured);
  return <div ref={node} className="ed-media" style={{ width }} />;
}

export interface PanelSplitterProps {
  readonly size: MediaWidth;
  /** The id of the panel it sizes. */
  readonly controls: string;
}

export function PanelSplitter({ size, controls }: PanelSplitterProps) {
  const node = useRef<HTMLDivElement>(null);
  const gesture = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const { width, chosen, max, choose, measured } = size;
  useBodyWidth(node, measured);

  useEffect(
    () => () => {
      gesture.current?.();
      document.documentElement.classList.remove(RESIZING);
    },
    [],
  );

  function press(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    // The drag moves the panel from where it is DRAWN; what goes back on a cancel, a press that never became a drag or a drag that changed
    // nothing on screen is the viewer's choice (review rounds 1 and 2), which a narrow window draws narrower. A drag starts past the
    // threshold, so a HiDPI pointer's sub-pixel jitter is no drag.
    const from = width;
    const before = chosen;
    const startX = event.clientX;
    let dragged = false;
    const widthAt = (x: number): number => clampMediaWidth(from + x - startX, max);
    gesture.current?.();
    setDragging(true);
    document.documentElement.classList.add(RESIZING);
    gesture.current = trackPointer(
      event,
      (move) => {
        if (!dragged && Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) return;
        dragged = true;
        choose(widthAt(move.clientX), false);
      },
      (end) => {
        gesture.current = null;
        setDragging(false);
        document.documentElement.classList.remove(RESIZING);
        const to = end === null || !dragged ? from : widthAt(end.clientX);
        if (to === from) choose(before, false);
        else choose(to, true);
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const to = keyedWidth(event.key, event.shiftKey, width, max);
    if (to === null) return;
    event.preventDefault();
    // Enter is the default again: nothing of the viewer's is kept.
    if (event.key === "Enter") choose(null, true);
    // A key at the limit changes nothing on screen, so it keeps nothing either: the viewer's wider choice stays (review round 2).
    else if (to !== width) choose(to, true);
  }

  return (
    <div
      ref={node}
      role="separator"
      tabIndex={0}
      className={dragging ? "ed-split ed-split-on" : "ed-split"}
      aria-label="Ширина панели медиа"
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={MEDIA_WIDTH.min}
      aria-valuemax={max}
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End Enter"
      title="Тяните, чтобы изменить ширину панели · двойной щелчок — как было"
      onPointerDown={press}
      onKeyDown={onKeyDown}
      onDoubleClick={() => choose(null, true)}
    >
      <span className="ed-split-grip" aria-hidden="true" />
    </div>
  );
}
