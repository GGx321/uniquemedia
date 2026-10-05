import { type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Focus, Layer, MontageDraft, TextLayer } from "../../../shared/engine";
import { clipRanges, FRAME_H, FRAME_W, ownPhotoCells, progressSegments, type Rect, reelsSafeZones, segmentFillWidth, type Size, stickerBox, totalFrames, videoClipWindow, zonesHit } from "../../../shared/montage";
import { ownStickerCells } from "../../../shared/montage/ownStickers";
import { stickerById } from "../../../shared/stickers/manifest";
import { useEngine } from "../../engine/react";
import { previewLook, refusedNow } from "../../engine/textPreviewQueue";
import { ownPhotoUrl, ownStickerUrl, photoUrl, placeholderGradient, stickerUrl } from "../../lib/media";
import { Icon, PauseIcon, PlayIcon } from "../../ui/Icon";
import { Silhouette } from "../../ui/Portrait";
import { useDevicePixelRatio } from "../../ui/useDevicePixelRatio";
import { useMediaRetry } from "../../ui/useMediaRetry";
import { DRAG_THRESHOLD_PX, trackPointer } from "./gesture";
import { captionLine, layerName, stickerName } from "./labels";
import { type CellView, clipViewAt, stickerFrameOf, stickerLayerBox, textLayerBox, visibleLayers } from "./previewFrame";
import { dragFocus, dragLayerCentre, placeLayer, type Point, resizeFactor, setCellFocus, setVideoFocus } from "./previewDrag";
import { PreviewAudio } from "./PreviewAudio";
import { PreviewVideo } from "./PreviewVideo";
import { ownPhotoSize, useOwnPhotos } from "./ownPhotos";
import { type OwnVideos, videoLookup } from "./ownVideos";
import { DOCK_INSET_PX, dockPlacement, fitPreview, PREVIEW_ARTBOARD_W, previewScale, roomAboveFrame } from "./previewFit";
import { storedFrames } from "./videoSync";
import type { TrimPeekStore } from "./trimPeek";
import { resolveSelection } from "./selection";
import type { DraftSession } from "./session";
import { StickerCanvas } from "./StickerCanvas";
import { clockMs } from "./timelineScale";
import { type OwnSticker, useOwnStickers } from "./ownStickers";
import { ownStickerKey, StickerFrameCache, stickerFramesFrom } from "./stickerFrames";
import { setStickerSize } from "./stickerOps";
import { setTextScale } from "./textOps";
import { useLayerPreview, usePrefetchTextPreviews, useTextPreviews } from "./textPreviews";
import { usePlayheadFrame, usePlayheadRest, usePlayheadStep, usePlaying } from "./usePlayhead";
import { focusKey, type TimelineState, useSelectionCommands } from "./useTimeline";

// 3d.4: the editor's live preview (Editor.dc.html's centre: the 9:16 frame at 306 × 544), drawn at the playhead's frame from the
// SHARED geometry the engine renders with (previewFrame.ts):
// - the clip under the playhead, its cells where the render puts them, each photo cropped and moving as the render's crop and
//   `zp4` motion show it on that frame (the photo at its STORED size: `image-orientation: none`), a collage cell's stagger fade;
// - text as the engine's own PNG (`montages.textPreview`, through the window's one per-layer queue that the panel shares),
//   placed by the engine's `textBox`; stickers on a canvas, a decoded frame per 30 fps tick on the loop stored with the sticker;
// - the music from an `<audio>` kept in step with the clock (PreviewAudio.tsx);
// - «Зоны Reels» and «Полоски слайдов», preview-only and switchable.
// A layer drags (one undo step when let go) and scales by its corners; the selected cell's crop drags by its face point (Q3: no
// zoom). Nothing is saved until a drag ends, and a cancelled one changes nothing. Only this part re-renders per frame.
// The owner's feedback (2026-10-05): the frame fits the stage (previewFit.ts), live as the window resizes or moves to a screen of another
// pixel ratio; `--pv-k` (its width over the artboard's 306 px) scales the overlays' pixel-sized parts, while everything placed in montage
// coordinates is drawn in percent of the frame and scales by itself.

/** The artboard's preview width: what a pixel of the pointer is worth before the frame is laid out (and in tests). */
const PREVIEW_W = PREVIEW_ARTBOARD_W;
/** The space kept between the «Подсказки» block and the frame. */
const HINTS_GAP_PX = 12;

/**
 * The frame's size fitted to the preview area as laid out (`fitPreview`), on every resize of the area or of the hints (which drop their words in
 * a narrow area) and on a new pixel ratio: the area's content box, and the hints' reach into it from the left (the frame keeps that much clear on
 * both sides, so it stays centred). Only a new FITTED size is news: a resize that fits the same frame (a splitter drag past a frame as tall as
 * the stage) re-renders nothing (review round 1, LOW 4). Null until the area is laid out. Where the notices' dock goes is written on the area
 * itself (`data-dock`, `--pv-room`), so it re-renders nothing either: in the room above the frame when the dock as drawn fits there (review r1
 * MEDIUM-2, r2 LOW-3), measured again as its cards come, go or fold, and as the stage resizes.
 */
function useFittedFrame(area: RefObject<HTMLElement | null>, hints: RefObject<HTMLElement | null>, withHints: boolean, ratio: number): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const node = area.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    let content: { width: number; height: number } | null = null;
    let room = 0;
    const dock = node.querySelector<HTMLElement>(":scope > .ed-dock");
    /** The dock's place for the room there is and the dock as it is drawn now (its content's height, whatever its box is held to). */
    const place = (): void => {
      node.dataset.dock = dockPlacement(room, dock?.scrollHeight ?? 0);
      node.style.setProperty("--pv-room", `${Math.floor(room)}px`);
    };
    const observer = new ResizeObserver((entries) => {
      const own = entries.find((entry) => entry.target === node);
      if (own !== undefined) content = { width: own.contentRect.width, height: own.contentRect.height };
      if (content === null) return;
      const reach = hints.current?.getBoundingClientRect();
      const left = node.getBoundingClientRect().left + (Number.parseFloat(getComputedStyle(node).paddingLeft) || 0);
      const gutter = reach === undefined || reach.width <= 0 ? 0 : Math.max(0, reach.right + HINTS_GAP_PX - left);
      const next = fitPreview({ stage: { w: content.width, h: content.height }, render: { w: FRAME_W, h: FRAME_H }, dpr: ratio, gutter });
      room = next === null ? 0 : roomAboveFrame(content.height, next.h);
      place();
      setSize((now) => (now !== null && next !== null && now.w === next.w && now.h === next.h ? now : next));
    });
    observer.observe(node);
    if (withHints && hints.current !== null) observer.observe(hints.current);
    if (dock !== null) observer.observe(dock);
    // A card that comes, goes, folds or unfolds changes the dock's height without its box changing (it may be held to the room).
    const cards = dock === null || typeof MutationObserver === "undefined" ? null : new MutationObserver(place);
    if (dock !== null) cards?.observe(dock, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => {
      observer.disconnect();
      cards?.disconnect();
    };
  }, [area, hints, withHints, ratio]);
  return size;
}

/** The frame's inline size and the overlays' scale; nothing while the stage is not laid out (the stylesheet's own size stands). */
type FrameStyle = CSSProperties & { readonly "--pv-k": number };
/** The dock's inset for the stylesheet, from the number its placement counts (review r3 LOW-1). */
const AREA_STYLE: CSSProperties & { readonly "--pv-dock-inset": string } = { "--pv-dock-inset": `${DOCK_INSET_PX}px` };
/** The dev mock has no pictures: its stand-ins are drawn at a scene photo's 9:16 size. */
const MOCK_PHOTO: Size = { w: 768, h: 1344 };
/** An arrow key moves a layer or a crop this many frame pixels (Shift: `BIG_STEP_PX`). */
const STEP_PX = 10;
const BIG_STEP_PX = 60;

const pct = (value: number, of: number): string => `${(value / of) * 100}%`;
const boxStyle = (box: Rect): CSSProperties => ({ left: pct(box.x, FRAME_W), top: pct(box.y, FRAME_H), width: pct(box.w, FRAME_W), height: pct(box.h, FRAME_H) });

/** What a crop drag moves: a scene or an own photo in a cell (the cell's face focus, 3-H1 for an own one), or an own video clip's video (its focus, 3f.3b). */
type Framed = Extract<CellView["content"], { kind: "scene" | "ownPhoto" | "video" }>;

/** What a crop drag of the cell moves; null when nothing can move (an empty cell, an own video already 9:16 that fills the frame whole). */
function framedOf(cell: CellView): Framed | null {
  if (cell.content.kind === "video" && cell.window !== null && cell.source !== null && !cropMoves(cell.window, cell.source)) return null;
  return cell.content.kind === "empty" ? null : cell.content;
}

/** A drag under way: what the preview draws instead of the draft until it ends. */
type Drag = { readonly kind: "move"; readonly layerId: string; readonly centre: Point } | { readonly kind: "resize"; readonly layerId: string; readonly factor: number } | { readonly kind: "crop"; readonly clip: number; readonly cell: number; readonly focus: Focus };

/** A layer scaled by `factor` about its centre: the size or scale the contract keeps (rounded to a hundredth, within its range). */
function scaled(spec: MontageDraft, index: number, factor: number): MontageDraft {
  const layer = spec.layers[index];
  if (layer === undefined) return spec;
  return layer.kind === "sticker" ? setStickerSize(spec, index, layer.size * factor) : setTextScale(spec, index, layer.scale * factor);
}

/** The draft as the preview draws it during `drag`. A text's scale is not changed live: its picture is scaled instead (one ask, on release). */
function liveSpec(spec: MontageDraft, drag: Drag | null): MontageDraft {
  if (drag === null) return spec;
  if (drag.kind === "crop") {
    const clip = spec.clips[drag.clip];
    if (clip === undefined) return spec;
    // 3f.3b: an own video's crop moves by the clip's own focus.
    if (clip.kind === "video") return setVideoFocus(spec, drag.clip, drag.focus);
    const cell = clip.kind === "photo" ? clip.cell : clip.cells[drag.cell];
    return cell?.photo === null || cell === undefined ? spec : setCellFocus(spec, drag.clip, drag.cell, drag.focus);
  }
  const index = spec.layers.findIndex((l) => l.layerId === drag.layerId);
  if (index < 0) return spec;
  if (drag.kind === "move") return placeLayer(spec, index, drag.centre);
  return spec.layers[index]?.kind === "sticker" ? scaled(spec, index, drag.factor) : spec;
}

/** How much a text being resized is drawn larger: the factor its scale really takes (kept within 0.5–2 and to a hundredth). */
function textFactor(spec: MontageDraft, index: number, factor: number): number {
  const layer = spec.layers[index];
  if (layer?.kind !== "text") return 1;
  const next = scaled(spec, index, factor).layers[index];
  return next?.kind === "text" ? next.scale / layer.scale : 1;
}

/** Frame pixels per pointer pixel. */
function frameScale(frame: HTMLElement | null): number {
  const width = frame?.getBoundingClientRect().width ?? 0;
  return FRAME_W / (width > 0 ? width : PREVIEW_W);
}

/** A key's travel in frame pixels; null for any other key. */
function arrowTravel(event: KeyboardEvent): { dx: number; dy: number } | null {
  const step = event.shiftKey ? BIG_STEP_PX : STEP_PX;
  const moves: Record<string, { dx: number; dy: number }> = { ArrowLeft: { dx: -step, dy: 0 }, ArrowRight: { dx: step, dy: 0 }, ArrowUp: { dx: 0, dy: -step }, ArrowDown: { dx: 0, dy: step } };
  return moves[event.key] ?? null;
}

const pictureStyle = (window: Rect, source: Size): CSSProperties => ({
  left: pct(-window.x, window.w),
  top: pct(-window.y, window.h),
  width: pct(source.w, window.w),
  height: pct(source.h, window.h),
});

export interface PreviewProps {
  /** The editor's notices (slice review 5-L1): drawn over the top of the stage, so they never take the frame's room. */
  readonly dock?: ReactNode;
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly timeline: TimelineState;
  /** Photos `montages.focus` is still judging, by `focusKey`: «ищем лицо…» on the selected cell. */
  readonly focusPending: ReadonlySet<string>;
  /** A photo being dragged from the media panel: a photo cell on screen takes it (an empty one is filled, a filled one's photo replaced). */
  readonly dragPhoto: string | null;
  readonly onFillCell: (clip: number, cell: number, photoId: string) => void;
  /** Selects cell `cell` of clip `clip` (the playhead is in it already). */
  readonly onSelectCell: (clip: number, cell: number) => void;
  /** 3f.3b: the own videos the draft's clips play (their records: the stored size the crop is cut from). */
  readonly videos: OwnVideos;
  /** 3f.3b fix round 1 (L8): the frame «Обрезка» is dragging to, shown while the drag lasts. */
  readonly trimPeek: TrimPeekStore;
}

export function Preview({ dock, session, spec, timeline, focusPending, dragPhoto, onFillCell, onSelectCell, videos, trimPeek }: PreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLElement>(null);
  const hintsRef = useRef<HTMLDivElement>(null);
  const [zones, setZones] = useState(true);
  const [bars, setBars] = useState(true);
  const { client } = useEngine();
  // One decoder per built-in sticker, fed by main over IPC (`stickers.bytes`): the media scheme stays closed to script reads.
  const [cache] = useState(() => new StickerFrameCache(stickerFramesFrom(client)));
  // Every caption's picture is asked for up front, so it is there before the playhead reaches it.
  usePrefetchTextPreviews(spec.layers.filter((l): l is TextLayer => l.kind === "text"));
  const empty = spec.clips.length === 0;
  const ratio = useDevicePixelRatio();
  const size = useFittedFrame(areaRef, hintsRef, !empty, ratio);
  const frameStyle: FrameStyle | undefined = size === null ? undefined : { width: size.w, height: size.h, "--pv-k": previewScale(size.w) };

  return (
    <section ref={areaRef} className="ed-preview" aria-label="Превью" style={AREA_STYLE}>
      {dock}
      <div className="ed-frame" ref={frameRef} style={frameStyle}>
        {empty ? (
          <div className="ed-frame-empty">
            <span className="tile-icon ed-frame-empty-icon" aria-hidden="true">
              <Icon name="image" size={20} />
            </span>
            <span className="ed-frame-empty-title">Ролик пока пуст</span>
            <span className="faint ed-frame-empty-text">Кликните фото слева — оно станет первым кадром. Длина ролика — от 4 до 15 с.</span>
          </div>
        ) : (
          <PreviewStage
            session={session}
            spec={spec}
            timeline={timeline}
            cache={cache}
            frameRef={frameRef}
            zones={zones}
            bars={bars}
            focusPending={focusPending}
            dragPhoto={dragPhoto}
            onFillCell={onFillCell}
            onSelectCell={onSelectCell}
            videos={videos}
            trimPeek={trimPeek}
          />
        )}
      </div>
      {!empty && (
        <div ref={hintsRef} className="pv-hints" role="group" aria-label="Подсказки">
          <span className="lbl">Подсказки</span>
          <HintSwitch label="Зоны Reels" on={zones} onChange={setZones} />
          <HintSwitch label="Полоски слайдов" on={bars} onChange={setBars} />
          <span className="faint pv-hints-note">только в превью, в видео их нет</span>
        </div>
      )}
      <PreviewAudio spec={spec} playhead={timeline.playhead} />
    </section>
  );
}

function HintSwitch({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <span className="pv-hint">
      <button type="button" role="switch" className={on ? "sw sw-on pv-sw" : "sw pv-sw"} aria-checked={on} aria-label={label} title={`${label} · только в превью`} onClick={() => onChange(!on)} />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

interface StageProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly timeline: TimelineState;
  readonly cache: StickerFrameCache;
  readonly frameRef: RefObject<HTMLDivElement | null>;
  readonly zones: boolean;
  readonly bars: boolean;
  readonly focusPending: ReadonlySet<string>;
  readonly dragPhoto: string | null;
  readonly onFillCell: (clip: number, cell: number, photoId: string) => void;
  readonly onSelectCell: (clip: number, cell: number) => void;
  readonly videos: OwnVideos;
  readonly trimPeek: TrimPeekStore;
}

/** The frame at the playhead: the one part of the editor that re-renders on every frame of a playback. */
function PreviewStage({ session, spec, timeline, cache, frameRef, zones, bars, focusPending, dragPhoto, onFillCell, onSelectCell, videos, trimPeek }: StageProps) {
  const { client } = useEngine();
  const textPreviews = useTextPreviews();
  // The owner's own stickers by media id (3f.5): the record each own-sticker layer is drawn from.
  const ownStickers = useOwnStickers(client, ownStickerCells(spec).map((cell) => cell.mediaId));
  // The own photos in the draft's cells by media id (3-H1): the stored size each is cropped from.
  const ownPhotos = useOwnPhotos(client, ownPhotoCells(spec).map((cell) => cell.mediaId));
  const commands = useSelectionCommands(session, timeline);
  const playheadFrame = usePlayheadFrame(timeline.playhead);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sizes, setSizes] = useState<ReadonlyMap<string, Size>>(() => new Map());
  const gesture = useRef<(() => void) | null>(null);
  /** The arrow key holding a keyboard nudge open: its release ends the undo step. */
  const heldKey = useRef<string | null>(null);
  useEffect(() => () => gesture.current?.(), []);

  // 3f.3b fix round 1 (L8): while «Обрезка» is dragged, the stage shows the clip being trimmed (from its first frame on the timeline, whatever the
  // playhead), and its video the frame the drag is at.
  const peek = useSyncExternalStore(trimPeek.subscribe, trimPeek.get);
  const live = liveSpec(spec, drag);
  const peekIndex = peek === null ? -1 : live.clips.findIndex((c) => c.kind === "video" && c.clipId === peek.clipId);
  const peekRange = peekIndex < 0 ? undefined : clipRanges(live.clips)[peekIndex];
  const frame = peekRange !== undefined ? peekRange.startFrame : Math.min(playheadFrame, Math.max(0, totalFrames(live.clips) - 1));
  const peekFrame = peek !== null && peekRange !== undefined ? peek.frame : null;
  const mock = client.kind === "mock";
  // An own video's stored size is its record's (3f.3b): the crop is cut from it before the element has a frame, and in the mock, which has none.
  const videoSize = (mediaId: string): Size | null => {
    const known = videoLookup(videos, mediaId);
    return known.state === "known" ? { w: known.video.width, h: known.video.height } : null;
  };
  // 3-H1: an own photo's stored size is its record's, the size the render crops it from; the mock's records have one too.
  const view = clipViewAt(live, frame, (photoId) => (mock ? MOCK_PHOTO : (sizes.get(photoId) ?? null)), videoSize, (mediaId) => ownPhotoSize(ownPhotos, mediaId));
  const videoCell = view?.kind === "video" ? view.cells[0] : undefined;
  const layers = visibleLayers(live, frame);
  const selected = resolveSelection(spec, timeline.selection);
  const selectedLayerId = selected?.kind === "layer" ? selected.layer.layerId : null;
  const selectedCell = selected?.kind === "clip" && view !== null && selected.index === view.index ? selected.cell : null;
  /** The selected cell on screen, whose point and hint are drawn over everything. */
  const hinted = selectedCell === null ? undefined : view?.cells[selectedCell];

  function startGesture(press: ReactPointerEvent, onMove: (event: PointerEvent) => void, onEnd: (event: PointerEvent | null) => void): void {
    gesture.current?.();
    gesture.current = trackPointer(press, onMove, (event) => {
      gesture.current = null;
      onEnd(event);
    });
  }

  /** The travel of a drag in frame pixels, and whether it is past the threshold yet. */
  function travelFrom(press: ReactPointerEvent): (event: PointerEvent) => { dx: number; dy: number; moved: boolean } {
    const scale = frameScale(frameRef.current);
    return (event) => {
      const sx = event.clientX - press.clientX;
      const sy = event.clientY - press.clientY;
      return { dx: sx * scale, dy: sy * scale, moved: Math.hypot(sx, sy) >= DRAG_THRESHOLD_PX };
    };
  }

  /** One undo step of `edit` on the layer `layerId` as it is in the draft NOW (it may have moved in z-order meanwhile). */
  function editLayer(layerId: string, edit: (current: MontageDraft, index: number) => MontageDraft, mergeKey?: string): void {
    const current = session.state.spec;
    const index = current.layers.findIndex((l) => l.layerId === layerId);
    if (index < 0) return;
    const next = edit(current, index);
    if (next !== current) session.edit(next, mergeKey === undefined ? {} : { mergeKey });
  }

  // ---------- layers: select, move, scale ----------

  function pressLayer(press: ReactPointerEvent<HTMLElement>, layerId: string, box: Rect): void {
    if (press.button !== 0) return;
    press.preventDefault();
    press.currentTarget.focus();
    if (selectedLayerId !== layerId) timeline.select({ kind: "layer", layerId });
    const travel = travelFrom(press);
    let moved = false;
    let centre: Point | null = null;
    startGesture(
      press,
      (event) => {
        const t = travel(event);
        if (!moved && !t.moved) return;
        moved = true;
        centre = dragLayerCentre(box, t);
        setDrag({ kind: "move", layerId, centre });
      },
      (event) => {
        setDrag(null);
        const to = centre;
        if (event === null || !moved || to === null) return;
        editLayer(layerId, (current, index) => placeLayer(current, index, to));
      },
    );
  }

  function pressCorner(press: ReactPointerEvent<HTMLElement>, layerId: string, box: Rect): void {
    if (press.button !== 0) return;
    press.preventDefault();
    press.stopPropagation();
    const frameBox = frameRef.current?.getBoundingClientRect();
    const scale = frameScale(frameRef.current);
    // The layer's centre on screen, the point it scales about.
    const centre = { x: (frameBox?.left ?? 0) + (box.x + box.w / 2) / scale, y: (frameBox?.top ?? 0) + (box.y + box.h / 2) / scale };
    const from = { x: press.clientX, y: press.clientY };
    let factor = 1;
    startGesture(
      press,
      (event) => {
        factor = resizeFactor(centre, from, { x: event.clientX, y: event.clientY });
        setDrag({ kind: "resize", layerId, factor });
      },
      (event) => {
        setDrag(null);
        if (event === null || factor === 1) return;
        editLayer(layerId, (current, index) => scaled(current, index, factor));
      },
    );
  }

  function keyLayer(event: KeyboardEvent<HTMLElement>, layerId: string, box: Rect): void {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      timeline.select(null);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (selectedLayerId !== layerId) timeline.select({ kind: "layer", layerId });
      else commands.remove();
      return;
    }
    const travel = arrowTravel(event);
    if (travel === null) return;
    event.preventDefault();
    heldKey.current = event.key;
    if (selectedLayerId !== layerId) timeline.select({ kind: "layer", layerId });
    // A held key is one undo step, closed when it is let go.
    editLayer(layerId, (current, index) => placeLayer(current, index, dragLayerCentre(box, travel)), `nudge:${layerId}`);
  }

  // ---------- cells: select, the crop by its face point, a bin photo dropped in ----------

  function pressCell(press: ReactPointerEvent<HTMLElement>, cell: CellView): void {
    if (press.button !== 0 || view === null) return;
    const clipIndex = view.index;
    const wasSelected = selectedCell === cell.index;
    if (!wasSelected) {
      onSelectCell(clipIndex, cell.index);
      return;
    }
    const framed = framedOf(cell);
    if (framed === null || cell.source === null) return;
    press.preventDefault();
    const clipId = view.clipId;
    const source = cell.source;
    const size = { w: cell.rect.w, h: cell.rect.h };
    const travel = travelFrom(press);
    let moved = false;
    let to: Focus | null = null;
    startGesture(
      press,
      (event) => {
        const t = travel(event);
        if (!moved && !t.moved) return;
        moved = true;
        to = dragFocus(framed.focus, t, size, source);
        setDrag({ kind: "crop", clip: clipIndex, cell: cell.index, focus: to });
      },
      (event) => {
        setDrag(null);
        const focusTo = to;
        if (event === null || !moved || focusTo === null) return;
        editCell(clipIndex, clipId, cell.index, framed, () => focusTo);
      },
    );
  }

  /**
   * One undo step of a new focus for the cell, if it still holds what was framed (an undo or another window may have changed it): the scene photo
   * `framed.photoId` or the own photo `framed.mediaId` in a cell (3-H1: the cell's focus, which the render crops it around), or the own video
   * `framed.mediaId` as clip `clipId` (3f.3b).
   */
  function editCell(clipIndex: number, clipId: string, cellIndex: number, framed: Framed, focus: (stored: Focus | null) => Focus, mergeKey?: string): void {
    const current = session.state.spec;
    const clip = current.clips[clipIndex];
    const options = mergeKey === undefined ? {} : { mergeKey };
    if (framed.kind === "video") {
      if (clip?.kind !== "video" || clip.clipId !== clipId || clip.mediaId !== framed.mediaId) return;
      const next = setVideoFocus(current, clipIndex, focus(clip.focus));
      if (next !== current) session.edit(next, options);
      return;
    }
    const cell = clip === undefined || clip.kind === "video" ? undefined : clip.kind === "photo" ? clip.cell : clip.cells[cellIndex];
    const holds = framed.kind === "scene" ? cell?.photo?.source === "scene" && cell.photo.photoId === framed.photoId : cell?.photo?.source === "own" && cell.photo.mediaId === framed.mediaId;
    if (cell === undefined || !holds) return;
    const next = setCellFocus(current, clipIndex, cellIndex, focus(cell.focus));
    if (next !== current) session.edit(next, options);
  }

  function keyCell(event: KeyboardEvent<HTMLElement>, cell: CellView): void {
    if (event.altKey || event.metaKey || event.ctrlKey || view === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      timeline.select(null);
      return;
    }
    const travel = arrowTravel(event);
    const framed = framedOf(cell);
    if (travel === null || selectedCell !== cell.index || framed === null || cell.source === null) return;
    event.preventDefault();
    heldKey.current = event.key;
    const source = cell.source;
    const size = { w: cell.rect.w, h: cell.rect.h };
    // The photo (or the video) moves with the arrow, as it follows a pointer.
    editCell(view.index, view.clipId, cell.index, framed, (stored) => dragFocus(stored, travel, size, source), `crop:${view.clipId}:${cell.index}`);
  }

  function keyUp(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== heldKey.current) return;
    heldKey.current = null;
    session.endMerge();
  }

  function onBlur(): void {
    if (heldKey.current === null) return;
    heldKey.current = null;
    session.endMerge();
  }

  /** A photo cell takes a dragged photo: an empty one is filled, a filled one's photo replaced (slice review 5-M5); an own video's frame takes none. */
  const takesPhoto = (cell: CellView): boolean => dragPhoto !== null && cell.content.kind !== "video";

  function dropOn(event: DragEvent<HTMLElement>, cell: CellView): void {
    if (dragPhoto === null || !takesPhoto(cell) || view === null) return;
    event.preventDefault();
    onFillCell(view.index, cell.index, dragPhoto);
  }

  const resizing = drag?.kind === "resize" ? drag : null;

  return (
    <div className="pv-stage">
      {view !== null && videoCell?.content.kind === "video" && (
        // Keyed by the media, not the clip: the two parts of a split clip go on playing on one element.
        <PreviewVideo
          key={videoCell.content.mediaId}
          spec={spec}
          playhead={timeline.playhead}
          mediaId={videoCell.content.mediaId}
          video={videoLookup(videos, videoCell.content.mediaId)}
          window={videoCell.window}
          sourceFrame={peekFrame ?? videoSourceFrame(live, view.index, view.localFrame, videos)}
          peekFrame={peekFrame}
        />
      )}
      {view?.cells.map((cell) => (
        <PreviewCell
          key={`${view.clipId}:${cell.index}`}
          clipNumber={view.index + 1}
          cellCount={view.cells.length}
          cell={cell}
          pictureUrl={cell.content.kind === "scene" ? (mock ? null : photoUrl(spec.avatarId, cell.content.photoId)) : cell.content.kind === "ownPhoto" ? ownPhotoUrl(client, cell.content.mediaId) : null}
          selected={selectedCell === cell.index}
          dropping={takesPhoto(cell)}
          onSize={(photoId, size) => setSizes((now) => (now.get(photoId)?.w === size.w && now.get(photoId)?.h === size.h ? now : new Map(now).set(photoId, size)))}
          onPointerDown={(e) => pressCell(e, cell)}
          onSelect={() => onSelectCell(view.index, cell.index)}
          onKeyDown={(e) => keyCell(e, cell)}
          onKeyUp={keyUp}
          onBlur={onBlur}
          onDragOver={(e) => {
            if (!takesPhoto(cell)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => dropOn(e, cell)}
        />
      ))}
      {/* After the cells and before the layers: drawn above the picture, under every caption and sticker (they keep their presses). Over an
          empty cell's drop hint in the middle of the frame it stays mounted (a keyboard focus on it survives) but inert. */}
      <PreviewPlay timeline={timeline} gesture={drag !== null || dragPhoto !== null} blocked={emptyUnderCentre(view?.cells ?? [])} />
      {layers.map(({ index, layer }) => {
        const handlers = {
          label: layerLabel(live, index),
          selected: selectedLayerId === layer.layerId,
          onSelect: () => {
            if (selectedLayerId !== layer.layerId) timeline.select({ kind: "layer", layerId: layer.layerId });
          },
          onPress: (e: ReactPointerEvent<HTMLElement>, box: Rect) => pressLayer(e, layer.layerId, box),
          onCorner: (e: ReactPointerEvent<HTMLElement>, box: Rect) => pressCorner(e, layer.layerId, box),
          onKey: (e: KeyboardEvent<HTMLElement>, box: Rect) => keyLayer(e, layer.layerId, box),
          onKeyUp: keyUp,
          onBlur,
        };
        return layer.kind === "text" ? (
          <TextLayerView key={layer.layerId} layer={layer} factor={resizing?.layerId === layer.layerId ? textFactor(spec, index, resizing.factor) : 1} onReload={() => textPreviews.reload(layer.layerId)} {...handlers} />
        ) : (
          <StickerLayerView
            key={layer.layerId}
            layer={layer}
            frame={frame}
            cache={cache}
            url={layer.sticker.source === "builtin" ? stickerUrl(client, layer.sticker.stickerId) : ownStickerUrl(client, layer.sticker.mediaId)}
            own={layer.sticker.source === "own" ? ownStickers.get(layer.sticker.mediaId) : undefined}
            {...handlers}
          />
        );
      })}
      {zones && <ReelsZones />}
      {bars && <SlideBars spec={live} frame={frame} />}
      {hinted !== undefined && <CellHint cell={hinted} pending={isPending(hinted.content, focusPending)} />}
    </div>
  );
}

/** How long the ❚❚ stays after a playback starts, and after the pointer last moved over the frame (playhead time, so it follows the clock). */
const PLAY_PEEK_MS = 1_000;
const PLAY_IDLE_MS = 1_600;

/** Whether an empty cell lies under the middle of the frame, where the play control sits: its «перетащите фото» must stay uncovered. */
function emptyUnderCentre(cells: readonly CellView[]): boolean {
  const x = FRAME_W / 2;
  const y = FRAME_H / 2;
  return cells.some((cell) => cell.content.kind === "empty" && x >= cell.rect.x && x < cell.rect.x + cell.rect.w && y >= cell.rect.y && y < cell.rect.y + cell.rect.h);
}

/**
 * The preview's own play control (the owner's feedback, 2026-10-05; review round 1): ▶ in the middle of the frame while paused, shown only while
 * the pointer is over the frame (so it never rests on the face, and a press in the middle of the frame reaches the cell otherwise); while
 * playing, ❚❚ for a moment after the start and while the pointer moves over the frame (and a little after). Hovered or keyboard-focused (the
 * stylesheet) it stays; otherwise it is gone and takes no press. It is `timeline.togglePlay`, the one playback the timeline's button drives. Any
 * drag on the frame or from the bin (`gesture`) hides it, so a drop in the middle of the frame lands on the cell there. Over an empty cell's drop
 * hint (`blocked`) it is inert: never shown for the pointer and click-through, yet still mounted and shown for a keyboard focus (review round 2).
 * A touch screen has no hover: after a touch the paused ▶ stays up, and while playing a tap brings the ❚❚ up, until a mouse moves again.
 */
function PreviewPlay({ timeline, gesture, blocked }: { timeline: TimelineState; gesture: boolean; blocked: boolean }) {
  const playing = usePlaying(timeline.playhead);
  const step = usePlayheadStep(timeline.playhead);
  const rest = usePlayheadRest(timeline.playhead);
  const wrap = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  /** The pointer is over the frame. */
  const [over, setOver] = useState(false);
  /** The frame was last touched rather than pointed at (a touch screen: no hover to show the ▶ by). */
  const [touch, setTouch] = useState(false);
  /** The playhead's step when the pointer last moved over the frame in THIS playback. */
  const [movedAt, setMovedAt] = useState<number | null>(null);
  // Every playback starts with no pointer move of its own: they are told apart by their starts, not by where they started (review round 1).
  const [wasPlaying, setWasPlaying] = useState(playing);
  if (playing !== wasPlaying) {
    setWasPlaying(playing);
    if (playing) setMovedAt(null);
  }

  // The pointer over the frame, and moving there (not dragging): listened to on the stage, so only this control re-renders.
  useEffect(() => {
    const stage = wrap.current?.parentElement;
    if (stage === null || stage === undefined) return;
    /** While playing, the ❚❚ comes up for a while from now. */
    const reveal = (): void => {
      const now = timeline.playhead.get();
      if (now.playing) setMovedAt(clockMs(now.ms));
    };
    const onEnter = (event: PointerEvent): void => {
      setOver(true);
      if (event.pointerType === "touch") setTouch(true);
    };
    const onLeave = (): void => setOver(false);
    const onMove = (event: PointerEvent): void => {
      setOver(true);
      if (event.pointerType !== "touch") setTouch(false);
      if (event.buttons === 0) reveal();
    };
    const onDown = (event: PointerEvent): void => {
      if (event.pointerType === "touch") setTouch(true);
    };
    // A tap has no move before it: its release is what brings the ❚❚ up.
    const onUp = (event: PointerEvent): void => {
      if (event.pointerType !== "touch") return;
      setTouch(true);
      reveal();
    };
    stage.addEventListener("pointerenter", onEnter);
    stage.addEventListener("pointerleave", onLeave);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointerup", onUp);
    return () => {
      stage.removeEventListener("pointerenter", onEnter);
      stage.removeEventListener("pointerleave", onLeave);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointerup", onUp);
    };
  }, [timeline.playhead]);

  const inert = gesture || blocked;
  const sinceMove = movedAt !== null && step >= movedAt ? step - movedAt : Number.POSITIVE_INFINITY;
  const shown = !inert && (hovered || (playing ? step - rest < PLAY_PEEK_MS || sinceMove < PLAY_IDLE_MS : over || touch));
  const label = playing ? "Пауза" : "Воспроизвести";
  return (
    <span ref={wrap} className="pv-play-wrap">
      <button
        type="button"
        className={playing ? "pv-play pv-play-on" : "pv-play"}
        data-shown={shown}
        data-inert={inert}
        aria-label={label}
        aria-keyshortcuts="Space"
        title={`${label} · Пробел`}
        tabIndex={gesture ? -1 : undefined}
        onClick={timeline.togglePlay}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {playing ? <PauseIcon size={24} /> : <PlayIcon size={26} />}
      </button>
    </span>
  );
}

/** The stored video's frame on screen for own video clip `index` at its frame `localFrame`: the trim plus the frame, never past the video's last. */
function videoSourceFrame(spec: MontageDraft, index: number, localFrame: number, videos: OwnVideos): number {
  const clip = spec.clips[index];
  if (clip?.kind !== "video") return 0;
  const frame = videoClipWindow(clip).startFrame + localFrame;
  const known = videoLookup(videos, clip.mediaId);
  return known.state === "known" ? Math.min(frame, Math.max(0, storedFrames(known.video.durationMs) - 1)) : frame;
}

/** «Текст 1: «sunday reset»», «Стикер 2: Сердце». */
function layerLabel(spec: MontageDraft, index: number): string {
  const layer = spec.layers[index];
  if (layer === undefined) return layerName(spec, index);
  return `${layerName(spec, index)}: ${layer.kind === "text" ? `«${captionLine(layer.value)}»` : stickerName(layer)}`;
}

/** Whether the face of the photo a cell holds is still being judged («ищем лицо…»): a scene photo's or an own one's (3-H1). */
function isPending(content: CellView["content"], pending: ReadonlySet<string>): boolean {
  if (content.kind === "scene") return pending.has(focusKey({ source: "scene", photoId: content.photoId }));
  if (content.kind === "ownPhoto") return pending.has(focusKey({ source: "own", mediaId: content.mediaId }));
  return false;
}

interface CellProps {
  readonly clipNumber: number;
  readonly cellCount: number;
  readonly cell: CellView;
  /** The photo's picture: a scene photo's or an own photo's through main's media route; null in the dev mock (its stand-in is drawn). */
  readonly pictureUrl: string | null;
  readonly selected: boolean;
  /** A photo is being dragged and this cell can take it (filled, or its photo replaced). */
  readonly dropping: boolean;
  readonly onSize: (photoId: string, size: Size) => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Enter on the cell (a pointer selects it on its press; Space plays the montage, EditorScreen). */
  readonly onSelect: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

function cellLabel(clipNumber: number, cellCount: number, cell: CellView): string {
  const where = cellCount > 1 ? `Кадр ${clipNumber}, ячейка ${cell.index + 1}` : `Кадр ${clipNumber}`;
  const what: Record<CellView["content"]["kind"], string | null> = { empty: "пустая", video: "своё видео", ownPhoto: "своё фото", scene: null };
  const said = what[cell.content.kind];
  return said === null ? where : `${where}: ${said}`;
}

/** Whether a crop can move at all: the window is smaller than the picture on some axis (an own video already 9:16 fills the frame whole). */
const cropMoves = (window: Rect, source: Size): boolean => window.w < source.w || window.h < source.h;

/**
 * A cell's own photo (3-H1) at its window. With no window (its record not read yet, or no longer in the library) or a picture that would not
 * load, a stand-in (review r1 LOW-5). A failed load is asked for once more after a pause, as every `studio-media://` picture is (a busy or
 * slow disk answers 503/504, useMediaRetry.ts); the stand-in covers the pause, so the errored picture is never drawn. The dev mock stores no
 * picture: a placeholder at the window.
 */
function OwnPhotoPicture({ url, mediaId, window, source }: { url: string | null; mediaId: string; window: Rect | null; source: Size | null }) {
  const retry = useMediaRetry(url);
  if (window === null || source === null || retry.failed || retry.waiting) {
    return (
      <span className="pv-photo-standin" aria-hidden="true">
        <Silhouette />
      </span>
    );
  }
  if (url === null) {
    return (
      <span className="pv-photo pv-photo-mock" style={{ ...pictureStyle(window, source), background: placeholderGradient(mediaId) }}>
        <Silhouette />
      </span>
    );
  }
  return <img key={retry.key} className="pv-photo" src={url} alt="" draggable={false} style={pictureStyle(window, source)} onError={retry.onError} />;
}

function PreviewCell({ clipNumber, cellCount, cell, pictureUrl: url, selected, dropping, onSize, onPointerDown, onSelect, onKeyDown, onKeyUp, onBlur, onDragOver, onDrop }: CellProps) {
  const { content, window, source } = cell;
  const classes = ["pv-cell", content.kind === "video" ? "pv-cell-video" : "", selected ? "pv-cell-on" : "", dropping ? "pv-cell-drop" : ""].filter(Boolean).join(" ");
  const style: CSSProperties = { ...boxStyle(cell.rect), opacity: cell.alphaPermille / 1000 };
  return (
    <button
      type="button"
      className={classes}
      style={style}
      aria-label={cellLabel(clipNumber, cellCount, cell)}
      aria-pressed={selected}
      // The arrows move only what can move (fix round 1, L9: never on an own video already 9:16).
      aria-keyshortcuts={selected && framedOf(cell) !== null ? "ArrowLeft ArrowRight ArrowUp ArrowDown Escape" : undefined}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        // A pointer's click came with its press; a key's (detail 0) did not.
        if (e.detail === 0 && !selected) onSelect();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {content.kind === "scene" &&
        (url !== null ? (
          <img
            className="pv-photo"
            src={url}
            alt=""
            draggable={false}
            style={window !== null && source !== null ? pictureStyle(window, source) : { visibility: "hidden" }}
            onLoad={(e) => onSize(content.photoId, { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        ) : (
          window !== null &&
          source !== null && (
            <span className="pv-photo pv-photo-mock" style={{ ...pictureStyle(window, source), background: placeholderGradient(content.photoId) }}>
              <Silhouette />
            </span>
          )
        ))}
      {/* 3-H1: an own photo's window comes from its RECORD's size (the render's), so it is placed before its picture arrives. */}
      {content.kind === "ownPhoto" && <OwnPhotoPicture url={url} mediaId={content.mediaId} window={window} source={source} />}
      {content.kind === "empty" && (
        <span className="pv-empty">
          <Icon name="plus" size={16} />
          перетащите фото
        </span>
      )}
      {selected && <span className="pv-cell-frame" aria-hidden="true" />}
    </button>
  );
}

/**
 * The selected cell's face point (an own video's focus) and what dragging it does (V13), drawn OVER the layers and the hints (fix round 1, L6: a
 * caption across the cell never covers it), in the cell's place on the frame; it takes no pointer.
 */
function CellHint({ cell, pending }: { cell: CellView; pending: boolean }) {
  const { content, window, source } = cell;
  if (content.kind === "empty") return null;
  if (window === null || source === null) return null;
  // Where the point sits in the cell on this frame (the crop follows it until it meets the picture's edge). A photo's always can.
  const moves = content.kind !== "video" || cropMoves(window, source);
  const ring = moves ? ringAt(content.focus, window, source) : null;
  const pill = content.kind === "video" ? (moves ? "тяните, чтобы сдвинуть" : "видео 9:16 · весь кадр") : pending ? "ищем лицо…" : content.focus === null ? "лицо не найдено · тяните" : "по лицу · тяните";
  return (
    <span className="pv-cell-hint" aria-hidden="true" style={boxStyle(cell.rect)}>
      {ring !== null ? (
        <>
          <span className="pv-face" style={{ left: pct(ring.x, 1), top: pct(ring.y, 1) }} />
          {/* Under the face point; above it when the point is low in the cell (the zones' own pill sits in the bottom band). */}
          <span className={ring.y > 0.7 ? "pill pv-face-pill pv-face-pill-up" : "pill pv-face-pill"} style={{ left: pct(ring.x, 1), top: pct(ring.y, 1) }}>
            {pill}
          </span>
        </>
      ) : (
        <span className="pill pv-face-pill pv-video-pill">{pill}</span>
      )}
    </span>
  );
}

/** The face point's place in a cell (0–1 of its width and height) on a frame that shows `window` of the photo. */
function ringAt(focus: Focus | null, window: Rect, source: Size): Point {
  const f = focus ?? { x: 0.5, y: 0.38 };
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  return { x: clamp01((f.x * source.w - window.x) / window.w), y: clamp01((f.y * source.h - window.y) / window.h) };
}

interface LayerViewProps {
  readonly label: string;
  readonly selected: boolean;
  /** Enter on the layer (a press selects it as it starts a drag; Space plays the montage, EditorScreen). */
  readonly onSelect: () => void;
  readonly onPress: (event: ReactPointerEvent<HTMLElement>, box: Rect) => void;
  readonly onCorner: (event: ReactPointerEvent<HTMLElement>, box: Rect) => void;
  readonly onKey: (event: KeyboardEvent<HTMLElement>, box: Rect) => void;
  readonly onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
}

/** A layer on the frame: its box, the selection's dashed outline and two corner handles, yellow when it reaches a Reels zone. */
function LayerBox({ box, kind, extra, label, selected, onSelect, onPress, onCorner, onKey, onKeyUp, onBlur, children }: LayerViewProps & { box: Rect; kind: "text" | "sticker"; extra?: string; children: ReactNode }) {
  const inZone = zonesHit(box, reelsSafeZones()).length > 0;
  const classes = ["pv-layer", `pv-layer-${kind}`, selected ? "pv-layer-on" : "", selected && inZone ? "pv-layer-zone" : "", extra ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes} style={boxStyle(box)}>
      <button
        type="button"
        className="pv-layer-hit"
        aria-label={label}
        aria-pressed={selected}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Delete Escape"
        onClick={onSelect}
        onPointerDown={(e) => onPress(e, box)}
        onKeyDown={(e) => onKey(e, box)}
        onKeyUp={onKeyUp}
        onBlur={onBlur}
      >
        {children}
      </button>
      {selected && (
        <>
          <span className="pv-corner pv-corner-tl" aria-hidden="true" onPointerDown={(e) => onCorner(e, box)} />
          <span className="pv-corner pv-corner-br" aria-hidden="true" onPointerDown={(e) => onCorner(e, box)} />
        </>
      )}
    </div>
  );
}

/** A caption: the engine's own picture of it, placed by the engine's box; scaled live while a corner is dragged. */
function TextLayerView({ layer, factor, onReload, ...view }: LayerViewProps & { layer: TextLayer; factor: number; onReload: () => void }) {
  const preview = useLayerPreview(layer);
  const picture = preview.picture;
  const previewId = picture?.answer.previewId ?? null;
  const missing = picture !== null && picture.answer.url === null;
  /** The picture already asked for again: the engine keeps 64 and may have evicted it, but one more ask per picture is enough. */
  const reloaded = useRef<string | null>(null);
  const reload = (): void => {
    if (previewId === null || reloaded.current === previewId) return;
    reloaded.current = previewId;
    onReload();
  };
  // The mock answers no address for a picture it no longer holds.
  useEffect(() => {
    if (missing) reload();
  });
  if (picture === null || picture.answer.url === null) return null;
  const { width, height, url } = picture.answer;
  const box = textLayerBox(layer, { width: Math.min(FRAME_W, Math.max(1, Math.round(width * factor))), height: Math.min(FRAME_H, Math.max(1, Math.round(height * factor))) });
  // The ENGINE refused this caption as it is now (a rule, or a drawing that failed): the last good picture stays, marked (the
  // panel says why). Giving up after asks from another window is no refusal and marks nothing.
  const refused = refusedNow(preview, previewLook(layer));
  return (
    <LayerBox box={box} kind="text" extra={refused ? "pv-text-refused" : undefined} {...view}>
      <img className="pv-text" src={url} alt="" draggable={false} onError={reload} />
    </LayerBox>
  );
}

/**
 * A sticker: its picture on a canvas, the frame its stored loop puts at this tick. A built-in sticker's picture is the set's (a square, one frame per
 * 30 fps tick); an OWN one's (3f.5) is on its record's canvas and loop and its per-frame delays pick the frame, its bytes coming over `media.stickerBytes`.
 */
function StickerLayerView({ layer, frame, cache, url, own, ...view }: LayerViewProps & { layer: Extract<Layer, { kind: "sticker" }>; frame: number; cache: StickerFrameCache; url: string | null; own: OwnSticker | undefined }) {
  if (layer.sticker.source === "own") {
    const ownBox = stickerLayerBox(layer, own) ?? stickerBox(layer);
    if (own === undefined || url === null) {
      // An own sticker whose record is not known (the library no longer holds it, or the list has not come yet): its place, with nothing to draw.
      return (
        <LayerBox box={ownBox} kind="sticker" extra="pv-sticker-missing" {...view}>
          <Icon name="sparkle" size={14} />
        </LayerBox>
      );
    }
    return (
      <LayerBox box={ownBox} kind="sticker" {...view}>
        <StickerCanvas cache={cache} stickerId={ownStickerKey(own.mediaId)} url={url} side={own.width} height={own.height} frameIndex={stickerFrameOf(own, layer, frame)} />
      </LayerBox>
    );
  }
  const entry = stickerById(layer.sticker.stickerId);
  const box = stickerLayerBox(layer) ?? stickerBox(layer);
  if (entry === undefined || url === null) {
    // A sticker gone from the set: its place, with nothing to draw.
    return (
      <LayerBox box={box} kind="sticker" extra="pv-sticker-missing" {...view}>
        <Icon name="sparkle" size={14} />
      </LayerBox>
    );
  }
  return (
    <LayerBox box={box} kind="sticker" {...view}>
      <StickerCanvas cache={cache} stickerId={entry.id} url={url} side={entry.size} frameIndex={stickerFrameOf(entry, layer, frame)} />
    </LayerBox>
  );
}

/** «Зоны Reels» (V12): where Instagram's own caption, sound and buttons cover the video. */
function ReelsZones() {
  return (
    <span className="pv-zones" aria-hidden="true">
      {reelsSafeZones().map((zone) => (
        <span key={zone.id} className={`pv-zone pv-zone-${zone.id}`} style={boxStyle(zone.rect)}>
          {zone.id === "bottom" && <span className="pill pv-zone-pill">подпись и аудио</span>}
        </span>
      ))}
    </span>
  );
}

/** «Полоски слайдов» (V5): one bar per clip, filled up to the playhead (the shared segments; never rendered into the video). */
function SlideBars({ spec, frame }: { spec: MontageDraft; frame: number }) {
  return (
    <span className="pv-bars" aria-hidden="true">
      {progressSegments(spec.clips).map((segment) => (
        <span key={segment.clipId} className="pv-bar" style={boxStyle(segment.rect)}>
          <span className="pv-bar-fill" style={{ width: pct(segmentFillWidth(segment, frame), segment.rect.w) }} />
        </span>
      ))}
    </span>
  );
}
