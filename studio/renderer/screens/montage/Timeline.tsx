import { type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_STICKER_LAYERS, MAX_TEXT_LAYERS, type Clip, type MontageDraft } from "../../../shared/engine";
import { MAX_CLIPS, MIN_CLIP_MS } from "../../../shared/montage";
import { useEngine } from "../../engine/react";
import { photoUrl, placeholderGradient } from "../../lib/media";
import { NBSP } from "../../lib/format";
import { Icon, type IconName, PauseIcon, PlayIcon } from "../../ui/Icon";
import { addRefusal, cellsOf, clipStartMs, isEven, maxDurationMs, moveClip, setDuration, totalMs } from "./clipOps";
import { isTextEntry, ownsKeys } from "./keys";
import { actionWhyLabel, clipAria, clockLabel, PHOTO_PROBLEM_TAGS, secondsLabel } from "./labels";
import type { PhotoProblem } from "./renderBlock";
import { type ActionState, resolveSelection, selectionActions } from "./selection";
import type { DraftSession } from "./session";
import { boundaryAt, boundaryMs, clockMs, MAX_ZOOM, MIN_ZOOM, msAtFraction, rulerMarks, snapEdge, stepPlayhead, tileCount, TIMELINE_MS } from "./timelineScale";
import { type TimelineState, useSelectionCommands } from "./useTimeline";

// 3d.3a: the timeline (Editor.dc.html's bottom band; the components sheet's «Линейка · плейхед · масштаб» and «Кадр на
// главном треке»). The toolbar, the ruler and a scrubbable playhead, the track headers with their caps, and the
// clip track: select, trim by the handles, reorder by drag, drop a photo from the bin, «+» after the last clip.
// SLOT 3d.3b: the text and sticker blocks on their two lanes and the music block (waveform, `music.peaks`).
//
// Keyboard: ←/→ move the playhead by 0.1 s (⇧: 1 s), Home/End to the ends; Delete removes the selection, Escape
// clears it; ⌥←/⌥→ move the focused clip; the trim handles and the playhead are sliders.

/** The artboard's lanes at «Уместить»: 1048 px for 15 s. Used until the lanes are measured (and in tests). */
const FALLBACK_LANES_PX = 1048;
/** A pointer must travel this far before a press on a clip becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** A trimmed end edge this close to the playhead meets it. */
const SNAP_PX = 8;

const pct = (ms: number): string => `${(ms / TIMELINE_MS) * 100}%`;

/**
 * Window-wide pointer tracking from a press: the gesture keeps going wherever the pointer goes. `onEnd` gets the
 * release, or null when the gesture was cancelled (`pointercancel`, a new gesture, the timeline closing).
 */
function trackPointer(press: ReactPointerEvent, onMove: (event: PointerEvent) => void, onEnd: (event: PointerEvent | null) => void): () => void {
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

function ToolButton({ label, icon, size, state, onClick }: { label: string; icon: IconName; size: number; state: ActionState; onClick: () => void }) {
  return (
    <button type="button" className="ibtn" aria-label={label} disabled={!state.enabled} title={state.enabled ? label : actionWhyLabel(state.why)} onClick={onClick}>
      <Icon name={icon} size={size} strokeWidth={icon === "scissors" ? 1.9 : 2} />
    </button>
  );
}

/** One 24 px frame of a clip's strip: the photo, a stand-in in the mock, a dark cell when empty or own media. */
function frameStyle(mock: boolean, avatarId: string, photoId: string | null, video: boolean): { background: string } | undefined {
  if (video) return { background: "var(--photo-drawing)" };
  if (photoId === null) return undefined;
  const url = mock ? null : photoUrl(avatarId, photoId);
  return { background: url === null ? placeholderGradient(photoId) : `url("${url}") center / cover no-repeat` };
}

/** A clip's film strip: its photos in turn, frame after frame, as the artboard draws the main track. */
function Strip({ clip, avatarId, widthPx }: { clip: Clip; avatarId: string; widthPx: number }) {
  const { client } = useEngine();
  const sources = clip.kind === "video" ? [null] : cellsOf(clip).map((cell) => (cell.photo?.source === "scene" ? cell.photo.photoId : null));
  const count = tileCount(widthPx);
  return (
    <span className="ed-strip" aria-hidden="true">
      {Array.from({ length: count }, (_, j) => {
        const photoId = sources[j % sources.length] ?? null;
        const style = frameStyle(client.kind === "mock", avatarId, photoId, clip.kind === "video");
        return <span key={j} className={style === undefined ? "ed-strip-frame ed-strip-frame-empty" : "ed-strip-frame"} style={style} />;
      })}
    </span>
  );
}

export interface TimelineProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly avatarId: string;
  /** The first unusable photo of each clip, by clip index (the engine's verdict, `photoProblems`). */
  readonly flagged: ReadonlyMap<number, PhotoProblem>;
  /** Clips the render's first blocking reason is about (an empty cell, say): an amber edge, no tag. */
  readonly highlighted: readonly number[];
  readonly timeline: TimelineState;
  /** A bin photo being dragged, or null. */
  readonly dragPhoto: string | null;
  readonly onInsertPhoto: (photoId: string, boundary: number) => void;
  /** «Добавить кадр»: take the owner to the photos. */
  readonly onAddClip: () => void;
  /** Selects clip `index` and brings the playhead into it. */
  readonly onSelectClip: (index: number) => void;
}

export function Timeline({ session, spec, avatarId, flagged, highlighted, timeline, dragPhoto, onInsertPhoto, onAddClip, onSelectClip }: TimelineProps) {
  const commands = useSelectionCommands(session, timeline);
  const lanesRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const clipButtons = useRef(new Map<string, HTMLButtonElement>());
  /** A clip (by id) or the playhead to focus after the next render: a delete or a move by keyboard. */
  const pendingFocus = useRef<string | "playhead" | null>(null);
  const suppressClick = useRef(false);
  const gesture = useRef<(() => void) | null>(null);
  /** The key holding a keyboard trim open: its release (not a modifier's) ends the undo step. */
  const heldKey = useRef<string | null>(null);
  const [lanesPx, setLanesPx] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [lift, setLift] = useState<{ clipId: string; dx: number; boundary: number } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const { zoom, playheadMs, selection } = timeline;
  const total = totalMs(spec);
  const durations = spec.clips.map((c) => c.durationMs);
  const empty = spec.clips.length === 0;
  const resolved = resolveSelection(spec, selection);
  const actions = selectionActions(spec, selection, playheadMs);
  const addBlock = addRefusal(spec);
  const texts = spec.layers.filter((l) => l.kind === "text").length;
  const stickers = spec.layers.filter((l) => l.kind === "sticker").length;
  const pxPerMs = (lanesPx > 0 ? lanesPx : FALLBACK_LANES_PX * zoom) / TIMELINE_MS;
  const { ticks, labels } = rulerMarks(zoom, total);

  useLayoutEffect(() => {
    const lanes = lanesRef.current;
    if (lanes === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setLanesPx(width);
    });
    observer.observe(lanes);
    return () => observer.disconnect();
  }, []);

  // A gesture still running when the timeline goes (the draft closed mid-drag) ends with it.
  useEffect(() => () => gesture.current?.(), []);

  // Keyboard focus follows a deleted or moved clip.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === "playhead") headRef.current?.focus();
    else clipButtons.current.get(target)?.focus();
  });

  // The playhead stays in view when zoomed in: while playing, scrubbing or after a seek.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || zoom === MIN_ZOOM || scroller.clientWidth === 0) return;
    const x = (playheadMs / TIMELINE_MS) * scroller.scrollWidth;
    if (x < scroller.scrollLeft + 24 || x > scroller.scrollLeft + scroller.clientWidth - 24) scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
  }, [playheadMs, zoom]);

  /** The time under a pointer, on the whole 15 s scale. */
  function msAt(clientX: number): number {
    const rect = lanesRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0) return 0;
    return msAtFraction((clientX - rect.left) / rect.width);
  }

  const livePxPerMs = (): number => {
    const width = lanesRef.current?.getBoundingClientRect().width ?? 0;
    return (width > 0 ? width : FALLBACK_LANES_PX * zoom) / TIMELINE_MS;
  };

  function startGesture(press: ReactPointerEvent, onMove: (event: PointerEvent) => void, onEnd: (event: PointerEvent | null) => void): void {
    gesture.current?.();
    gesture.current = trackPointer(press, onMove, (event) => {
      gesture.current = null;
      onEnd(event);
    });
  }

  // ---------- the playhead ----------

  function startScrub(press: ReactPointerEvent<HTMLElement>): void {
    if (press.button !== 0) return;
    press.preventDefault();
    headRef.current?.focus();
    timeline.seek(msAt(press.clientX));
    setScrubbing(true);
    startGesture(
      press,
      (event) => timeline.seek(msAt(event.clientX)),
      () => setScrubbing(false),
    );
  }

  function onHeadKey(event: KeyboardEvent<HTMLElement>): void {
    const step = event.shiftKey ? 1_000 : 100;
    const moves: Record<string, () => number> = {
      ArrowLeft: () => stepPlayhead(playheadMs, total, -step),
      ArrowDown: () => stepPlayhead(playheadMs, total, -step),
      ArrowRight: () => stepPlayhead(playheadMs, total, step),
      ArrowUp: () => stepPlayhead(playheadMs, total, step),
      Home: () => 0,
      End: () => total,
    };
    const move = moves[event.key];
    if (move === undefined || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    timeline.seek(move());
  }

  // ---------- clips: select, reorder ----------

  function pressClip(press: ReactPointerEvent<HTMLButtonElement>, clipId: string): void {
    if (press.button !== 0) return;
    const startX = press.clientX;
    let moved = false;
    startGesture(
      press,
      (event) => {
        const dx = event.clientX - startX;
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        moved = true;
        setLift({ clipId, dx, boundary: boundaryAt(session.state.spec.clips.map((c) => c.durationMs), msAt(event.clientX)) });
      },
      (event) => {
        setLift(null);
        if (!moved) return;
        // The click that ends a drag is not a selection.
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
        if (event === null) return;
        const current = session.state.spec;
        const from = current.clips.findIndex((c) => c.clipId === clipId);
        if (from < 0) return;
        const next = moveClip(current, from, boundaryAt(current.clips.map((c) => c.durationMs), msAt(event.clientX)));
        if (next !== current) session.edit(next);
      },
    );
  }

  function nudge(clipId: string, direction: -1 | 1): void {
    const current = session.state.spec;
    const from = current.clips.findIndex((c) => c.clipId === clipId);
    if (from < 0) return;
    const boundary = direction < 0 ? from - 1 : from + 2;
    if (boundary < 0 || boundary > current.clips.length) return;
    if (session.edit(moveClip(current, from, boundary))) pendingFocus.current = clipId;
  }

  // ---------- clips: trim ----------

  function pressHandle(press: ReactPointerEvent<HTMLSpanElement>, clipId: string, edge: "start" | "end"): void {
    if (press.button !== 0) return;
    press.preventDefault();
    press.stopPropagation();
    const at = session.state.spec;
    const index = at.clips.findIndex((c) => c.clipId === clipId);
    const clip = at.clips[index];
    if (clip === undefined) return;
    const startX = press.clientX;
    const from = clip.durationMs;
    const start = clipStartMs(at, index);
    const playhead = clockMs(playheadMs);
    // One gesture, one undo step: a key unique to this press, sealed on release.
    const mergeKey = `trim:${clipId}:${edge}:${press.pointerId}:${press.timeStamp}`;
    startGesture(
      press,
      (event) => {
        const perMs = livePxPerMs();
        const deltaMs = (event.clientX - startX) / perMs;
        let wanted = edge === "end" ? from + deltaMs : from - deltaMs;
        if (edge === "end") wanted = snapEdge(start + wanted, [playhead], SNAP_PX / perMs) - start;
        const current = session.state.spec;
        const now = current.clips.findIndex((c) => c.clipId === clipId);
        if (now < 0) return;
        const next = setDuration(current, now, wanted);
        if (next !== current) session.edit(next, { mergeKey });
      },
      () => session.endMerge(),
    );
  }

  function onHandleKey(event: KeyboardEvent<HTMLSpanElement>, clipId: string, edge: "start" | "end"): void {
    const current = session.state.spec;
    const index = current.clips.findIndex((c) => c.clipId === clipId);
    const clip = current.clips[index];
    if (clip === undefined || event.altKey || event.metaKey || event.ctrlKey) return;
    const step = event.shiftKey ? 1_000 : 100;
    // ←/→ follow the edge the way a drag does: the left edge pulled left makes the clip longer. ↑/↓ follow the value.
    const outward = edge === "start" ? "ArrowLeft" : "ArrowRight";
    const inward = edge === "start" ? "ArrowRight" : "ArrowLeft";
    const targets: Record<string, number> = {
      [outward]: clip.durationMs + step,
      ArrowUp: clip.durationMs + step,
      [inward]: clip.durationMs - step,
      ArrowDown: clip.durationMs - step,
      Home: MIN_CLIP_MS,
      End: maxDurationMs(current, index),
    };
    const wanted = targets[event.key];
    if (wanted === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const next = setDuration(current, index, wanted);
    // Held keys repeat: one undo step until the key is let go.
    heldKey.current = event.key;
    if (next !== current) session.edit(next, { mergeKey: `trim-key:${clipId}` });
  }

  // ---------- the bin's photos dropped on the track ----------

  function dragOverClips(event: DragEvent<HTMLElement>): void {
    if (dragPhoto === null || addBlock !== null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDropAt(empty ? 0 : boundaryAt(durations, msAt(event.clientX)));
  }

  function dropOnClips(event: DragEvent<HTMLElement>): void {
    if (dragPhoto === null || addBlock !== null) return;
    event.preventDefault();
    const boundary = empty ? 0 : boundaryAt(durations, msAt(event.clientX));
    setDropAt(null);
    onInsertPhoto(dragPhoto, boundary);
  }

  // ---------- the keyboard ----------

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return;
    // Escape clears the selection from anywhere but text entry: a slider (the zoom) has no Escape of its own.
    if (event.key === "Escape" && selection !== null && !isTextEntry(event.target)) {
      event.preventDefault();
      timeline.select(null);
      return;
    }
    // A control (the zoom slider) keeps its own keys (keys.ts).
    if (ownsKeys(event.target)) return;
    const target = event.target;
    if (event.key === "Delete" || event.key === "Backspace") {
      if (resolved === null || !actions.remove.enabled) return;
      event.preventDefault();
      const neighbour = resolved.kind === "clip" ? (spec.clips[resolved.index + 1] ?? spec.clips[resolved.index - 1]) : undefined;
      if (commands.remove()) pendingFocus.current = neighbour?.clipId ?? "playhead";
      return;
    }
    if (event.key === "Escape" && selection !== null) {
      event.preventDefault();
      timeline.select(null);
      return;
    }
    const clipId = target instanceof HTMLElement ? target.dataset.clipId : undefined;
    if (event.altKey && clipId !== undefined && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      nudge(clipId, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.altKey) return;
    const step = event.shiftKey ? 1_000 : 100;
    const moves: Record<string, () => number> = {
      ArrowLeft: () => stepPlayhead(playheadMs, total, -step),
      ArrowRight: () => stepPlayhead(playheadMs, total, step),
      Home: () => 0,
      End: () => total,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    timeline.seek(move());
  }

  const insertAt = lift !== null ? lift.boundary : dropAt;
  const ph = clockMs(playheadMs);
  const clipCap = spec.clips.length >= MAX_CLIPS;
  const addLabel = addBlock === null ? "Добавить кадр" : addBlock === "clip-cap" ? `Добавить кадр: не больше ${MAX_CLIPS}` : "Добавить кадр: ролик уже почти 15 с";
  const evenTitle = spec.clips.length < 2 ? "Нужно хотя бы два кадра" : isEven(spec) ? "Кадры уже одной длины" : "Разделить длину ролика между кадрами поровну";

  return (
    <section className="ed-timeline" aria-label="Таймлайн" data-slot="timeline 3d.3b" onKeyDown={onKeyDown}>
      <div className="ed-tl-bar">
        <button type="button" className="ed-play" aria-label={timeline.playing ? "Пауза" : "Воспроизвести"} disabled={empty} onClick={timeline.togglePlay}>
          {timeline.playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <span className="mono ed-tl-clock">
          {clockLabel(ph)} <span className="faint">/ {clockLabel(total)}</span>
        </span>
        <span className="ed-tl-sep" aria-hidden="true" />
        <ToolButton label="Разрезать по плейхеду" icon="scissors" size={15} state={actions.split} onClick={() => void commands.split()} />
        <ToolButton label="Дублировать выбранное" icon="copy" size={14} state={actions.duplicate} onClick={() => void commands.duplicate()} />
        <ToolButton label="Удалить выбранное" icon="trash" size={14} state={actions.remove} onClick={() => void commands.remove()} />
        <button type="button" className="chip ed-tl-even" disabled={spec.clips.length < 2 || isEven(spec)} title={evenTitle} aria-label="Все кадры поровну" onClick={() => void commands.evenOut()}>
          Поровну
        </button>
        <span className="mono faint ed-tl-length">ролик {secondsLabel(total)} · от 4 до 15 с</span>
        <div className="ed-tl-zoom">
          <button type="button" className="ibtn" aria-label="Уменьшить масштаб" disabled={zoom <= MIN_ZOOM} onClick={() => timeline.setZoom(zoom - 1)}>
            <Icon name="minus" size={12} strokeWidth={2.6} />
          </button>
          <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={1} value={zoom} aria-label="Масштаб таймлайна" aria-valuetext={`${zoom}×`} onChange={(e) => timeline.setZoom(Number(e.target.value))} />
          <button type="button" className="ibtn" aria-label="Увеличить масштаб" disabled={zoom >= MAX_ZOOM} onClick={() => timeline.setZoom(zoom + 1)}>
            <Icon name="plus" size={12} strokeWidth={2.6} />
          </button>
          <button type="button" className="chip" disabled={zoom === MIN_ZOOM} onClick={() => timeline.setZoom(MIN_ZOOM)}>
            Уместить
          </button>
        </div>
      </div>
      <div className="ed-tl-body">
        <div className="ed-tl-heads">
          <div className="ed-tl-ruler-gap" />
          <div className="th ed-th-text">
            <Icon name="text" size={14} />
            Текст <span className={texts >= MAX_TEXT_LAYERS ? "mono ed-th-full" : "mono faint"}>{texts}</span>
            {/* SLOT 3d.3b: adds a text layer at the playhead. */}
            <button type="button" className="tadd" aria-label={texts >= MAX_TEXT_LAYERS ? `Добавить текст: не больше ${MAX_TEXT_LAYERS}` : "Добавить текст"} disabled title="Текст — скоро">
              <Icon name="plus" size={11} strokeWidth={2.6} />
            </button>
          </div>
          <div className="th ed-th-sticker">
            <Icon name="sparkle" size={14} />
            Стикеры <span className={stickers >= MAX_STICKER_LAYERS ? "mono ed-th-full" : "mono faint"}>{stickers}</span>
            <button type="button" className="tadd" aria-label={stickers >= MAX_STICKER_LAYERS ? `Добавить стикер: не больше ${MAX_STICKER_LAYERS}` : "Добавить стикер"} disabled title="Стикеры — скоро">
              <Icon name="plus" size={11} strokeWidth={2.6} />
            </button>
          </div>
          <div className="th ed-th-clips">
            <Icon name="film" size={14} />
            Кадры <span className={clipCap ? "mono ed-th-full" : "mono faint"}>{spec.clips.length}</span>
            <button type="button" className="tadd" aria-label={addLabel} disabled={addBlock !== null} title={addBlock === null ? undefined : actionWhyLabel(addBlock)} onClick={onAddClip}>
              <Icon name="plus" size={11} strokeWidth={2.6} />
            </button>
          </div>
          <div className="th ed-th-music">
            <Icon name="music" size={14} />
            Музыка
          </div>
        </div>
        <div className="ed-tl-scroll" ref={scrollRef}>
          <div className="ed-tl-lanes" ref={lanesRef} style={{ width: `${zoom * 100}%` }}>
            <div className="ed-ruler" aria-hidden="true" onPointerDown={startScrub}>
              {ticks.map((tick) => (
                <span key={tick.ms} className={tick.major ? "ed-tick ed-tick-major" : "ed-tick"} style={{ left: pct(tick.ms) }} />
              ))}
              {labels.map((label) => (
                <span
                  key={`l${label.ms}`}
                  className={label.after ? "mono ed-tick-label ed-tick-label-after" : "mono ed-tick-label"}
                  style={{ left: pct(label.ms), transform: label.align === "start" ? "none" : label.align === "end" ? "translateX(-100%)" : "translateX(-50%)" }}
                >
                  {label.text}
                </span>
              ))}
            </div>
            {/* SLOT 3d.3b: text blocks on two rows (packing only), sticker blocks. */}
            <div className="trk ed-lane-text" onPointerDown={(e) => e.target === e.currentTarget && timeline.select(null)} />
            <div className="trk ed-lane-text" onPointerDown={(e) => e.target === e.currentTarget && timeline.select(null)} />
            <div className="trk ed-lane-sticker" onPointerDown={(e) => e.target === e.currentTarget && timeline.select(null)} />
            <div
              className={dropAt !== null ? "trk ed-lane-clips ed-lane-clips-drop" : "trk ed-lane-clips"}
              onPointerDown={(e) => e.target === e.currentTarget && timeline.select(null)}
              onDragOver={dragOverClips}
              onDragLeave={(e) => {
                if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDropAt(null);
              }}
              onDrop={dropOnClips}
            >
              {empty ? (
                <button type="button" className="ed-lane-drop" onClick={onAddClip}>
                  <Icon name="plus" size={13} strokeWidth={2.4} />
                  Перетащите фото или видео сюда
                </button>
              ) : (
                <ol className="ed-clips" aria-label="Кадры">
                  {spec.clips.map((clip, i) => {
                    const start = boundaryMs(durations, i);
                    const selected = resolved?.kind === "clip" && resolved.index === i;
                    const problem = flagged.get(i) ?? null;
                    const lifted = lift?.clipId === clip.clipId;
                    const tag = problem !== null ? PHOTO_PROBLEM_TAGS[problem] : clip.kind === "collage" ? `коллаж ${clip.cells.length}` : clip.kind === "video" ? "▶ видео" : null;
                    const classes = ["ed-clip-slot", selected ? "ed-clip-on" : "", problem !== null ? "ed-clip-flagged" : highlighted.includes(i) ? "ed-clip-warn" : "", lifted ? "ed-clip-lifted" : ""].filter(Boolean).join(" ");
                    const max = maxDurationMs(spec, i);
                    const handle = (edge: "start" | "end") => (
                      <span
                        role="slider"
                        tabIndex={0}
                        className={edge === "start" ? "hd hd-l" : "hd hd-r"}
                        aria-label={`Длительность кадра ${i + 1}: ${edge === "start" ? "левый" : "правый"} край`}
                        aria-valuemin={MIN_CLIP_MS}
                        aria-valuemax={max}
                        aria-valuenow={clip.durationMs}
                        aria-valuetext={secondsLabel(clip.durationMs)}
                        onPointerDown={(e) => pressHandle(e, clip.clipId, edge)}
                        onKeyDown={(e) => onHandleKey(e, clip.clipId, edge)}
                        onKeyUp={(e) => {
                          if (e.key !== heldKey.current) return;
                          heldKey.current = null;
                          session.endMerge();
                        }}
                        onBlur={() => {
                          heldKey.current = null;
                          session.endMerge();
                        }}
                      />
                    );
                    return (
                      <li key={clip.clipId} className={classes} style={{ left: `calc(${pct(start)} + 1px)`, width: `calc(${pct(clip.durationMs)} - 2px)`, transform: lift !== null && lifted ? `translate(${lift.dx}px, -6px)` : undefined }}>
                        <button
                          ref={(node) => {
                            if (node === null) clipButtons.current.delete(clip.clipId);
                            else clipButtons.current.set(clip.clipId, node);
                          }}
                          type="button"
                          className="ed-clip"
                          data-clip-id={clip.clipId}
                          aria-pressed={selected}
                          aria-label={clipAria(i, clip, problem)}
                          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Delete"
                          onPointerDown={(e) => pressClip(e, clip.clipId)}
                          onClick={() => {
                            if (suppressClick.current) return;
                            onSelectClip(i);
                          }}
                        >
                          <Strip clip={clip} avatarId={avatarId} widthPx={clip.durationMs * pxPerMs} />
                          {tag !== null && <span className="ctag ed-ctag-top">{tag}</span>}
                          <span className="ctag ed-ctag-bottom">{secondsLabel(clip.durationMs)}</span>
                        </button>
                        {selected && (
                          <>
                            {handle("start")}
                            {handle("end")}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              {!empty && (
                <button
                  type="button"
                  className="ed-add-end"
                  aria-label={addBlock === null ? "Добавить кадр в конец" : addLabel}
                  title={addBlock === null ? undefined : actionWhyLabel(addBlock)}
                  disabled={addBlock !== null}
                  style={{ left: `calc(${pct(total)} + 4px)` }}
                  onClick={onAddClip}
                >
                  <Icon name="plus" size={14} strokeWidth={2.4} />
                </button>
              )}
              {insertAt !== null && !empty && <span className="ed-insert" aria-hidden="true" style={{ left: pct(boundaryMs(durations, Math.min(insertAt, durations.length))) }} />}
            </div>
            <div className="trk ed-lane-music">
              {/* SLOT 3d.3b: the music block with its waveform. */}
              {empty && (
                <button type="button" className="ed-lane-music-add" disabled title="Музыка — скоро">
                  <Icon name="plus" size={13} strokeWidth={2.4} />
                  Добавить музыку
                </button>
              )}
            </div>
            {!empty && <div className="ed-tl-after" style={{ left: pct(total) }} aria-hidden="true" />}
            <div className="ed-playhead" style={{ left: pct(ph) }}>
              <div
                ref={headRef}
                role="slider"
                tabIndex={0}
                className="ed-playhead-head"
                aria-label="Плейхед"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={ph}
                aria-valuetext={`${(ph / 1000).toFixed(1)}${NBSP}с`}
                onPointerDown={startScrub}
                onKeyDown={onHeadKey}
              />
              {scrubbing && <span className="mono ed-playhead-time">{secondsLabel(ph)}</span>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
