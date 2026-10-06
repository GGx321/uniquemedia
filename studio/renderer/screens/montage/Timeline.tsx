import { type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Clip, MontageDraft, PhotoRef } from "../../../shared/engine";
import { MAX_CLIPS, MIN_CLIP_MS } from "../../../shared/montage";
import type { EngineClient } from "../../engine/client";
import { useEngine } from "../../engine/react";
import { ownPhotoUrl, photoUrl, placeholderGradient } from "../../lib/media";
import { NBSP } from "../../lib/format";
import { Icon, type IconName, PauseIcon, PlayIcon } from "../../ui/Icon";
import { addRefusal, cellsOf, clipStartMs, isEven, maxDurationMs, moveClip, setDuration, totalMs } from "./clipOps";
import { DRAG_THRESHOLD_PX, type GestureKit, SNAP_PX, trackPointer } from "./gesture";
import { isTextEntry, ownsKeys } from "./keys";
import { actionWhyLabel, clipAria, clockLabel, layerAddLabel, PHOTO_PROBLEM_TAGS, secondsLabel, VIDEO_PROBLEM_TAGS, videoTag } from "./labels";
import { addLayerRefusal, layerCap, layerCount } from "./layerOps";
import { laneHeight, laneLayout, LayerTracks } from "./LayerTracks";
import type { TrackVerdict } from "./musicOps";
import { MusicTrack, type TrackLookup } from "./MusicTrack";
import { type OwnVideos, type VideoProblem, videoLookup } from "./ownVideos";
import type { PhotoProblem } from "./renderBlock";
import { type ActionState, resolveSelection, selectionActions } from "./selection";
import type { DraftSession } from "./session";
import { boundaryAt, boundaryMs, clockMs, MAX_ZOOM, MIN_ZOOM, msAtFraction, rulerMarks, seekInto, snapEdge, snapTargets, stepPlayhead, tileCount, TIMELINE_MS, trimHandlePx } from "./timelineScale";
import { usePlayheadRest, usePlayheadStep, usePlaying } from "./usePlayhead";
import { playheadStep, type TimelineState, useSelectionCommands } from "./useTimeline";
import { durationLimitMs, trimStartTo } from "./videoTrim";

// 3d.3a: the timeline (Editor.dc.html's bottom band; the components sheet's «Линейка · плейхед · масштаб» and «Кадр на
// главном треке»). The toolbar, the ruler and a scrubbable playhead, the track headers with their caps, and the
// clip track: select, trim by the handles, reorder by drag, drop a photo from the bin, «+» after the last clip.
// 3d.3b: the text and sticker tracks (LayerTracks.tsx: add at the playhead, move, trim, z-order) and the music track
// (MusicTrack.tsx: the waveform from `music.peaks`, the highlights, where the music starts). 3d.5: the «Стикеры» «+» and
// «Добавить музыку» open the media panel's «GIF» and «Музыка» tabs (L10, L24).
//
// Keyboard: ←/→ move the playhead by 0.1 s (⇧: 1 s), Home/End to the ends; Delete removes the selection, Escape
// clears it (on a slider too: the zoom keeps only its arrows); ⌥←/⌥→ move the focused clip or layer (the music: where
// it starts), ⌥↑/⌥↓ step a focused layer up and down the z-order; the trim handles and the playhead are sliders.

/** The artboard's lanes at «Уместить»: 1048 px for 15 s. Used until the lanes are measured (and in tests). */
const FALLBACK_LANES_PX = 1048;

const pct = (ms: number): string => `${(ms / TIMELINE_MS) * 100}%`;

function ToolButton({ label, icon, size, state, onClick }: { label: string; icon: IconName; size: number; state: ActionState; onClick: () => void }) {
  return (
    <button type="button" className="ibtn" aria-label={label} disabled={!state.enabled} title={state.enabled ? label : actionWhyLabel(state.why)} onClick={onClick}>
      <Icon name={icon} size={size} strokeWidth={icon === "scissors" ? 1.9 : 2} />
    </button>
  );
}

/** One 24 px frame of a clip's strip: the photo, a stand-in in the mock, a dark cell when empty, an own video's film (3f.3b: the strip never reads its pixels). */
/** A strip frame's picture: a scene photo's or an own photo's (3-H1: by its id through main's media route), the stand-in of its id in the dev mock. */
function frameStyle(client: Pick<EngineClient, "kind">, avatarId: string, photo: PhotoRef | null, video: boolean): { background: string } | undefined {
  if (video) return { background: "var(--trim-frame)" };
  if (photo === null) return undefined;
  const seed = photo.source === "scene" ? photo.photoId : photo.mediaId;
  const url = photo.source === "own" ? ownPhotoUrl(client, photo.mediaId) : client.kind === "mock" ? null : photoUrl(avatarId, photo.photoId);
  return { background: url === null ? placeholderGradient(seed) : `url("${url}") center / cover no-repeat` };
}

/** A clip's film strip: its photos in turn, frame after frame, as the artboard draws the main track. */
function Strip({ clip, avatarId, widthPx }: { clip: Clip; avatarId: string; widthPx: number }) {
  const { client } = useEngine();
  const sources = clip.kind === "video" ? [null] : cellsOf(clip).map((cell) => cell.photo);
  const count = tileCount(widthPx);
  return (
    <span className="ed-strip" aria-hidden="true">
      {Array.from({ length: count }, (_, j) => {
        const photo = sources[j % sources.length] ?? null;
        const style = frameStyle(client, avatarId, photo, clip.kind === "video");
        return <span key={j} className={style === undefined ? "ed-strip-frame ed-strip-frame-empty" : "ed-strip-frame"} style={style} />;
      })}
    </span>
  );
}

/** «Воспроизвести» / «Пауза» (Space too, EditorScreen): re-renders when a playback starts or stops, nothing else. */
function PlayButton({ timeline, empty }: { timeline: TimelineState; empty: boolean }) {
  const playing = usePlaying(timeline.playhead);
  const label = playing ? "Пауза" : "Воспроизвести";
  return (
    <button type="button" className="ed-play" aria-label={label} aria-keyshortcuts="Space" title={`${label} · Пробел`} disabled={empty} onClick={timeline.togglePlay}>
      {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
    </button>
  );
}

/** «00:04.1 / 00:09.6»: follows the playing playhead a 100 ms step at a time. */
function TimelineClock({ timeline, total }: { timeline: TimelineState; total: number }) {
  const step = usePlayheadStep(timeline.playhead);
  return (
    <span className="mono ed-tl-clock">
      {clockLabel(step)} <span className="faint">/ {clockLabel(total)}</span>
    </span>
  );
}

interface PlayheadLineProps {
  readonly timeline: TimelineState;
  readonly total: number;
  readonly zoom: number;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly headRef: RefObject<HTMLDivElement | null>;
  readonly scrubbing: boolean;
  readonly onPointerDown: (press: ReactPointerEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** The playhead's line and its head (a slider), a 100 ms step at a time while playing; zoomed in, it keeps itself in view. */
function PlayheadLine({ timeline, total, zoom, scrollRef, headRef, scrubbing, onPointerDown, onKeyDown }: PlayheadLineProps) {
  const ph = usePlayheadStep(timeline.playhead);
  // The playhead stays in view when zoomed in: while playing, scrubbing or after a seek.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || zoom === MIN_ZOOM || scroller.clientWidth === 0) return;
    const x = (ph / TIMELINE_MS) * scroller.scrollWidth;
    if (x < scroller.scrollLeft + 24 || x > scroller.scrollLeft + scroller.clientWidth - 24) scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
  }, [ph, zoom, scrollRef]);
  return (
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
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      {scrubbing && <span className="mono ed-playhead-time">{secondsLabel(ph)}</span>}
    </div>
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
  /** Why the engine refuses a layer, by its id (3d.3b): the block says it. */
  readonly flaggedLayers: ReadonlyMap<string, string>;
  /** The draft's track as `music.list` describes it (3d.3b). */
  readonly musicLookup: TrackLookup;
  /** When the track list was last fetched: a new list asks for the waveform again (a missing track may be stored now). */
  readonly musicListVersion: string | null;
  /** The engine's verdict on the track for the spec on screen, or `judged: false` while it has not judged that spec. */
  readonly musicVerdict: TrackVerdict;
  readonly timeline: TimelineState;
  /** A bin photo being dragged, or null. */
  readonly dragPhoto: string | null;
  readonly onInsertPhoto: (photoId: string, boundary: number) => void;
  /** «Добавить кадр»: take the owner to the photos. */
  readonly onAddClip: () => void;
  /** «Добавить музыку»: the media panel's «Музыка» tab (3d.5). */
  readonly onAddMusic: () => void;
  /** The «Стикеры» «+»: the media panel's «GIF» tab (3d.5, L10), where a pick puts the sticker at the playhead. */
  readonly onAddSticker: () => void;
  /** Selects clip `index` and brings the playhead into it. */
  readonly onSelectClip: (index: number) => void;
  /** 3f.3b: the own videos the clips play (a clip's name and how long its video lets it get), and what the render refuses each video clip for. */
  readonly videos: OwnVideos;
  readonly videoProblems: ReadonlyMap<string, VideoProblem>;
}

export function Timeline({ session, spec, avatarId, flagged, highlighted, flaggedLayers, musicLookup, musicListVersion, musicVerdict, timeline, dragPhoto, onInsertPhoto, onAddClip, onAddMusic, onAddSticker, onSelectClip, videos, videoProblems }: TimelineProps) {
  const commands = useSelectionCommands(session, timeline);
  const lanesRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const clipButtons = useRef(new Map<string, HTMLButtonElement>());
  /** What to focus after the next render: a clip (by id, after a delete or a keyboard move), a new layer's block, the playhead. */
  const pendingFocus = useRef<string | { layerId: string } | "playhead" | null>(null);
  const suppressClick = useRef(false);
  const gesture = useRef<(() => void) | null>(null);
  /** The key holding a keyboard trim open: its release (not a modifier's) ends the undo step. */
  const heldKey = useRef<string | null>(null);
  const [lanesPx, setLanesPx] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [lift, setLift] = useState<{ clipId: string; dx: number; boundary: number } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const { zoom, selection } = timeline;
  // Where the playhead rests (3d.4): it moves on a seek, a pause and the end, never while playing, so a playback does not
  // re-render the timeline; the line and the clock follow the playing playhead on their own (`PlayheadLine`, `TimelineClock`).
  const playheadMs = usePlayheadRest(timeline.playhead);
  const total = totalMs(spec);
  const durations = spec.clips.map((c) => c.durationMs);
  const empty = spec.clips.length === 0;
  const resolved = resolveSelection(spec, selection);
  const actions = selectionActions(spec, selection, playheadMs);
  const addBlock = addRefusal(spec);
  const texts = layerCount(spec, "text");
  const stickers = layerCount(spec, "sticker");
  const textAdd = layerAddLabel("text", addLayerRefusal(spec, "text", playheadMs), total);
  const stickerAdd = layerAddLabel("sticker", addLayerRefusal(spec, "sticker", playheadMs), total);
  const textLane = laneLayout(spec, "text");
  const stickerLane = laneLayout(spec, "sticker");
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

  // Keyboard focus follows a deleted or moved clip, and goes to a layer just added (its «+» may have turned off at the cap).
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === "playhead") headRef.current?.focus();
    else if (typeof target === "string") clipButtons.current.get(target)?.focus();
    else lanesRef.current?.querySelector<HTMLButtonElement>(`button[data-layer-id="${CSS.escape(target.layerId)}"]`)?.focus();
  });

  /** How long an own video clip's video lets it get from its trim (3f.3b); none for any other clip, or a video not known yet. */
  function limitOf(clip: Clip): number | undefined {
    if (clip.kind !== "video") return undefined;
    const known = videoLookup(videos, clip.mediaId);
    return known.state === "known" ? durationLimitMs(clip, known.video.durationMs) : undefined;
  }

  /**
   * Clip `index` made `wantedMs` long by its `edge`: the right edge keeps the clip's start (an own video's start in its video too); the LEFT edge of an
   * own video clip moves its start in the video with its end kept, as «Обрезка»'s left edge does (3f.3b fix round 1, L7); any other clip just takes
   * the length (a photo has no source time to keep).
   */
  function resized(current: MontageDraft, index: number, edge: "start" | "end", wantedMs: number): MontageDraft {
    const clip = current.clips[index];
    if (clip === undefined) return current;
    if (clip.kind === "video" && edge === "start") {
      const known = videoLookup(videos, clip.mediaId);
      // The left edge's limits do not depend on the video's end: an unknown video is held to the room and its start alone.
      return trimStartTo(current, index, clip.trimStartMs + clip.durationMs - wantedMs, known.state === "known" ? known.video.durationMs : Number.POSITIVE_INFINITY);
    }
    return setDuration(current, index, wantedMs, limitOf(clip));
  }

  /** The longest clip `index` may get by its `edge`: an own video's left edge also stops at the video's start. */
  function edgeMax(current: MontageDraft, index: number, clip: Clip, edge: "start" | "end"): number {
    if (clip.kind === "video" && edge === "start") return Math.min(maxDurationMs(current, index), clip.trimStartMs + clip.durationMs);
    return maxDurationMs(current, index, limitOf(clip));
  }

  /** A layer the header's «+» just added: selected, and the focus goes to its block. */
  function focusAdded(layerId: string | null): void {
    if (layerId !== null) pendingFocus.current = { layerId };
  }

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

  function swallowClick(): void {
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }

  // What the layer and music tracks borrow for their gestures.
  const kit: GestureKit = { start: startGesture, pxPerMs: livePxPerMs, swallowClick, clickSwallowed: () => suppressClick.current };

  /** Selects a layer (3d.3b) and brings the playhead into it, as a click on a clip does. */
  function selectLayer(layerId: string): void {
    const layer = session.state.spec.layers.find((l) => l.layerId === layerId);
    if (layer === undefined) return;
    timeline.select({ kind: "layer", layerId });
    const now = playheadStep(timeline);
    const into = seekInto(now, layer.startMs, Math.min(layer.endMs, totalMs(session.state.spec)));
    if (into !== now) timeline.seek(into);
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
    const now = playheadStep(timeline);
    const moves: Record<string, () => number> = {
      ArrowLeft: () => stepPlayhead(now, total, -step),
      ArrowDown: () => stepPlayhead(now, total, -step),
      ArrowRight: () => stepPlayhead(now, total, step),
      ArrowUp: () => stepPlayhead(now, total, step),
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
        swallowClick();
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
    const playhead = playheadStep(timeline);
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
        const next = resized(current, now, edge, wanted);
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
      End: edgeMax(current, index, clip, edge),
    };
    const wanted = targets[event.key];
    if (wanted === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const next = resized(current, index, edge, wanted);
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
      // A trim handle goes with the selection: the focus moves to its block first, never to the page.
      if (event.target instanceof HTMLElement && event.target.classList.contains("hd")) event.target.parentElement?.querySelector("button")?.focus();
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
    const clipId = target instanceof HTMLElement ? target.dataset.clipId : undefined;
    if (event.altKey && clipId !== undefined && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      nudge(clipId, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.altKey) return;
    const step = event.shiftKey ? 1_000 : 100;
    const now = playheadStep(timeline);
    const moves: Record<string, () => number> = {
      ArrowLeft: () => stepPlayhead(now, total, -step),
      ArrowRight: () => stepPlayhead(now, total, step),
      Home: () => 0,
      End: () => total,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    timeline.seek(move());
  }

  const insertAt = lift !== null ? lift.boundary : dropAt;
  const clipCap = spec.clips.length >= MAX_CLIPS;
  const addLabel = addBlock === null ? "Добавить кадр" : addBlock === "clip-cap" ? `Добавить кадр: не больше ${MAX_CLIPS}` : "Добавить кадр: в ролике уже 15 с";
  const evenTitle = spec.clips.length < 2 ? "Нужно хотя бы два кадра" : isEven(spec) ? "Кадры уже одной длины" : "Разделить длину ролика между кадрами поровну";

  return (
    <section className="ed-timeline" aria-label="Таймлайн" onKeyDown={onKeyDown}>
      <div className="ed-tl-bar">
        <PlayButton timeline={timeline} empty={empty} />
        <TimelineClock timeline={timeline} total={total} />
        <span className="ed-tl-sep" aria-hidden="true" />
        <ToolButton label="Разрезать по плейхеду" icon="scissors" size={15} state={actions.split} onClick={() => void commands.split()} />
        <ToolButton label="Дублировать выбранное" icon="copy" size={14} state={actions.duplicate} onClick={() => void commands.duplicate()} />
        <ToolButton label="Удалить выбранное" icon="trash" size={14} state={actions.remove} onClick={() => void commands.remove()} />
        <ToolButton label="Слой выше" icon="layerUp" size={15} state={actions.raise} onClick={() => void commands.raise()} />
        <ToolButton label="Слой ниже" icon="layerDown" size={15} state={actions.lower} onClick={() => void commands.lower()} />
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
          <div className="th ed-th-text" style={{ height: laneHeight(textLane.count) }}>
            <Icon name="text" size={14} />
            Текст <span className={texts >= layerCap("text") ? "mono ed-th-full" : "mono faint"}>{texts}</span>
            <button type="button" className="tadd" aria-label={textAdd.name} disabled={textAdd.why !== null} title={textAdd.why ?? undefined} onClick={() => focusAdded(commands.addText())}>
              <Icon name="plus" size={11} strokeWidth={2.6} />
            </button>
          </div>
          <div className="th ed-th-sticker" style={{ height: laneHeight(stickerLane.count) }}>
            <Icon name="sparkle" size={14} />
            Стикеры <span className={stickers >= layerCap("sticker") ? "mono ed-th-full" : "mono faint"}>{stickers}</span>
            <button type="button" className="tadd" aria-label={stickerAdd.name} disabled={stickerAdd.why !== null} title={stickerAdd.why ?? "Выбрать стикер во вкладке «GIF»"} onClick={onAddSticker}>
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
            <LayerTracks
              session={session}
              spec={spec}
              timeline={timeline}
              kit={kit}
              pxPerMs={pxPerMs}
              text={textLane}
              sticker={stickerLane}
              targets={snapTargets(durations, playheadMs)}
              flagged={flaggedLayers}
              onSelect={selectLayer}
            />
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
                    // 3f.3b: an own video clip the render refuses (its video gone, or shorter than the clip asks) is flagged as a refused photo is.
                    const known = clip.kind === "video" ? videoLookup(videos, clip.mediaId) : null;
                    const engineProblem = clip.kind === "video" ? (videoProblems.get(clip.clipId) ?? null) : null;
                    // A video under the shortest clip is told apart (fix round 1, L3): no trim can help it.
                    const videoProblem = engineProblem === null ? null : videoTag(engineProblem, known?.state === "known" ? known.video.durationMs : null);
                    const lifted = lift?.clipId === clip.clipId;
                    const tag =
                      problem !== null
                        ? PHOTO_PROBLEM_TAGS[problem]
                        : videoProblem !== null
                          ? VIDEO_PROBLEM_TAGS[videoProblem]
                          : clip.kind === "collage"
                            ? `коллаж ${clip.cells.length}`
                            : clip.kind === "video"
                              ? "▶ видео"
                              : null;
                    const refused = problem !== null || videoProblem !== null;
                    const classes = ["ed-clip-slot", selected ? "ed-clip-on" : "", refused ? "ed-clip-flagged" : highlighted.includes(i) ? "ed-clip-warn" : "", lifted ? "ed-clip-lifted" : ""].filter(Boolean).join(" ");
                    // The slot is drawn 2 px narrower than its time (1 px each side); its handles fit inside it.
                    const handlePx = trimHandlePx(clip.durationMs * pxPerMs - 2);
                    const handle = (edge: "start" | "end") => (
                      <span
                        role="slider"
                        tabIndex={0}
                        className={edge === "start" ? (handlePx.start === 0 ? "hd hd-l hd-key" : "hd hd-l") : "hd hd-r"}
                        style={{ width: `${edge === "start" ? handlePx.start : handlePx.end}px` }}
                        aria-label={`Длительность кадра ${i + 1}: ${edge === "start" ? "левый" : "правый"} край`}
                        aria-valuemin={MIN_CLIP_MS}
                        aria-valuemax={edgeMax(spec, i, clip, edge)}
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
                          aria-label={clipAria(i, clip, problem ?? videoProblem, known?.state === "known" ? known.video.name : null)}
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
            <div className="trk ed-lane-music" onPointerDown={(e) => e.target === e.currentTarget && timeline.select(null)}>
              <MusicTrack
                session={session}
                spec={spec}
                timeline={timeline}
                kit={kit}
                pxPerMs={pxPerMs}
                lookup={musicLookup}
                listVersion={musicListVersion}
                verdict={musicVerdict}
                onSelect={() => timeline.select({ kind: "music" })}
                onAddMusic={onAddMusic}
              />
            </div>
            {!empty && <div className="ed-tl-after" style={{ left: pct(total) }} aria-hidden="true" />}
            <PlayheadLine timeline={timeline} total={total} zoom={zoom} scrollRef={scrollRef} headRef={headRef} scrubbing={scrubbing} onPointerDown={startScrub} onKeyDown={onHeadKey} />
          </div>
        </div>
      </div>
    </section>
  );
}
