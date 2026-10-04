import { type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { Focus, Layer, MontageDraft, TextLayer } from "../../../shared/engine";
import { FRAME_H, FRAME_W, progressSegments, type Rect, reelsSafeZones, segmentFillWidth, type Size, stickerBox, totalFrames, zonesHit } from "../../../shared/montage";
import { stickerById } from "../../../shared/stickers/manifest";
import { useEngine } from "../../engine/react";
import { previewLook, refusedNow } from "../../engine/textPreviewQueue";
import { ownStickerUrl, photoUrl, placeholderGradient, stickerUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";
import { Silhouette } from "../../ui/Portrait";
import { DRAG_THRESHOLD_PX, trackPointer } from "./gesture";
import { captionLine, layerName, stickerName } from "./labels";
import { type CellView, clipViewAt, stickerFrameOf, stickerLayerBox, textLayerBox, visibleLayers } from "./previewFrame";
import { dragFocus, dragLayerCentre, placeLayer, type Point, resizeFactor, setCellFocus } from "./previewDrag";
import { PreviewAudio } from "./PreviewAudio";
import { resolveSelection } from "./selection";
import type { DraftSession } from "./session";
import { StickerCanvas } from "./StickerCanvas";
import { type OwnSticker, useOwnStickers } from "./ownStickers";
import { ownStickerKey, StickerFrameCache, stickerFramesFrom } from "./stickerFrames";
import { setStickerSize } from "./stickerOps";
import { setTextScale } from "./textOps";
import { useLayerPreview, usePrefetchTextPreviews, useTextPreviews } from "./textPreviews";
import { usePlayheadFrame } from "./usePlayhead";
import { type TimelineState, useSelectionCommands } from "./useTimeline";

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

/** The artboard's preview width: what a pixel of the pointer is worth before the frame is laid out (and in tests). */
const PREVIEW_W = 306;
/** The dev mock has no pictures: its stand-ins are drawn at a scene photo's 9:16 size. */
const MOCK_PHOTO: Size = { w: 768, h: 1344 };
/** An arrow key moves a layer or a crop this many frame pixels (Shift: `BIG_STEP_PX`). */
const STEP_PX = 10;
const BIG_STEP_PX = 60;

const pct = (value: number, of: number): string => `${(value / of) * 100}%`;
const boxStyle = (box: Rect): CSSProperties => ({ left: pct(box.x, FRAME_W), top: pct(box.y, FRAME_H), width: pct(box.w, FRAME_W), height: pct(box.h, FRAME_H) });

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
    if (clip === undefined || clip.kind === "video") return spec;
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
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly timeline: TimelineState;
  /** Photos `montages.focus` is still judging: «ищем лицо…» on the selected cell. */
  readonly focusPending: ReadonlySet<string>;
  /** A free bin photo being dragged: an empty cell on screen takes it. */
  readonly dragPhoto: string | null;
  readonly onFillCell: (clip: number, cell: number, photoId: string) => void;
  /** Selects cell `cell` of clip `clip` (the playhead is in it already). */
  readonly onSelectCell: (clip: number, cell: number) => void;
}

export function Preview({ session, spec, timeline, focusPending, dragPhoto, onFillCell, onSelectCell }: PreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [zones, setZones] = useState(true);
  const [bars, setBars] = useState(true);
  const { client } = useEngine();
  // One decoder per built-in sticker, fed by main over IPC (`stickers.bytes`): the media scheme stays closed to script reads.
  const [cache] = useState(() => new StickerFrameCache(stickerFramesFrom(client)));
  // Every caption's picture is asked for up front, so it is there before the playhead reaches it.
  usePrefetchTextPreviews(spec.layers.filter((l): l is TextLayer => l.kind === "text"));
  const empty = spec.clips.length === 0;

  return (
    <section className="ed-preview" aria-label="Превью">
      <div className="ed-frame" ref={frameRef}>
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
          />
        )}
      </div>
      {!empty && (
        <div className="pv-hints" role="group" aria-label="Подсказки">
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
}

/** The frame at the playhead: the one part of the editor that re-renders on every frame of a playback. */
function PreviewStage({ session, spec, timeline, cache, frameRef, zones, bars, focusPending, dragPhoto, onFillCell, onSelectCell }: StageProps) {
  const { client } = useEngine();
  const textPreviews = useTextPreviews();
  // The owner's own stickers by media id (3f.5): the record each own-sticker layer is drawn from.
  const ownStickers = useOwnStickers(client);
  const commands = useSelectionCommands(session, timeline);
  const playheadFrame = usePlayheadFrame(timeline.playhead);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sizes, setSizes] = useState<ReadonlyMap<string, Size>>(() => new Map());
  const gesture = useRef<(() => void) | null>(null);
  /** The arrow key holding a keyboard nudge open: its release ends the undo step. */
  const heldKey = useRef<string | null>(null);
  useEffect(() => () => gesture.current?.(), []);

  const live = liveSpec(spec, drag);
  const frame = Math.min(playheadFrame, Math.max(0, totalFrames(live.clips) - 1));
  const mock = client.kind === "mock";
  const view = clipViewAt(live, frame, (photoId) => (mock ? MOCK_PHOTO : (sizes.get(photoId) ?? null)));
  const layers = visibleLayers(live, frame);
  const selected = resolveSelection(spec, timeline.selection);
  const selectedLayerId = selected?.kind === "layer" ? selected.layer.layerId : null;
  const selectedCell = selected?.kind === "clip" && view !== null && selected.index === view.index ? selected.cell : null;

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
    if (cell.content.kind !== "scene" || cell.source === null) return;
    press.preventDefault();
    const { focus, photoId } = cell.content;
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
        to = dragFocus(focus, t, size, source);
        setDrag({ kind: "crop", clip: clipIndex, cell: cell.index, focus: to });
      },
      (event) => {
        setDrag(null);
        const focusTo = to;
        if (event === null || !moved || focusTo === null) return;
        editCell(clipIndex, cell.index, photoId, () => focusTo);
      },
    );
  }

  /** One undo step of a new focus for the cell, if it still holds `photoId` (an undo or another window may have changed it). */
  function editCell(clipIndex: number, cellIndex: number, photoId: string, focus: (stored: Focus | null) => Focus, mergeKey?: string): void {
    const current = session.state.spec;
    const clip = current.clips[clipIndex];
    const cell = clip === undefined || clip.kind === "video" ? undefined : clip.kind === "photo" ? clip.cell : clip.cells[cellIndex];
    if (cell?.photo?.source !== "scene" || cell.photo.photoId !== photoId) return;
    const next = setCellFocus(current, clipIndex, cellIndex, focus(cell.focus));
    if (next !== current) session.edit(next, mergeKey === undefined ? {} : { mergeKey });
  }

  function keyCell(event: KeyboardEvent<HTMLElement>, cell: CellView): void {
    if (event.altKey || event.metaKey || event.ctrlKey || view === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      timeline.select(null);
      return;
    }
    const travel = arrowTravel(event);
    if (travel === null || selectedCell !== cell.index || cell.content.kind !== "scene" || cell.source === null) return;
    event.preventDefault();
    heldKey.current = event.key;
    const source = cell.source;
    const size = { w: cell.rect.w, h: cell.rect.h };
    // The photo moves with the arrow, as it follows a pointer.
    editCell(view.index, cell.index, cell.content.photoId, (stored) => dragFocus(stored, travel, size, source), `crop:${view.clipId}:${cell.index}`);
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

  function dropOn(event: DragEvent<HTMLElement>, cell: CellView): void {
    if (dragPhoto === null || cell.content.kind !== "empty" || view === null) return;
    event.preventDefault();
    onFillCell(view.index, cell.index, dragPhoto);
  }

  const resizing = drag?.kind === "resize" ? drag : null;

  return (
    <div className="pv-stage">
      {view?.cells.map((cell) => (
        <PreviewCell
          key={`${view.clipId}:${cell.index}`}
          clipNumber={view.index + 1}
          cellCount={view.cells.length}
          cell={cell}
          avatarId={spec.avatarId}
          mock={mock}
          selected={selectedCell === cell.index}
          pending={cell.content.kind === "scene" && focusPending.has(cell.content.photoId)}
          dropping={dragPhoto !== null && cell.content.kind === "empty"}
          onSize={(photoId, size) => setSizes((now) => (now.get(photoId)?.w === size.w && now.get(photoId)?.h === size.h ? now : new Map(now).set(photoId, size)))}
          onPointerDown={(e) => pressCell(e, cell)}
          onSelect={() => onSelectCell(view.index, cell.index)}
          onKeyDown={(e) => keyCell(e, cell)}
          onKeyUp={keyUp}
          onBlur={onBlur}
          onDragOver={(e) => {
            if (dragPhoto === null || cell.content.kind !== "empty") return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => dropOn(e, cell)}
        />
      ))}
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
    </div>
  );
}

/** «Текст 1: «sunday reset»», «Стикер 2: Сердце». */
function layerLabel(spec: MontageDraft, index: number): string {
  const layer = spec.layers[index];
  if (layer === undefined) return layerName(spec, index);
  return `${layerName(spec, index)}: ${layer.kind === "text" ? `«${captionLine(layer.value)}»` : stickerName(layer)}`;
}

interface CellProps {
  readonly clipNumber: number;
  readonly cellCount: number;
  readonly cell: CellView;
  readonly avatarId: string;
  readonly mock: boolean;
  readonly selected: boolean;
  /** `montages.focus` is still judging the photo. */
  readonly pending: boolean;
  /** A bin photo is being dragged and this empty cell can take it. */
  readonly dropping: boolean;
  readonly onSize: (photoId: string, size: Size) => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Enter or Space on the cell (a pointer selects it on its press). */
  readonly onSelect: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

function cellLabel(clipNumber: number, cellCount: number, cell: CellView): string {
  const where = cellCount > 1 ? `Кадр ${clipNumber}, ячейка ${cell.index + 1}` : `Кадр ${clipNumber}`;
  return cell.content.kind === "empty" ? `${where}: пустая` : cell.content.kind === "own" ? `${where}: своё видео` : where;
}

function PreviewCell({ clipNumber, cellCount, cell, avatarId, mock, selected, pending, dropping, onSize, onPointerDown, onSelect, onKeyDown, onKeyUp, onBlur, onDragOver, onDrop }: CellProps) {
  const { content, window, source } = cell;
  const classes = ["pv-cell", selected ? "pv-cell-on" : "", dropping ? "pv-cell-drop" : ""].filter(Boolean).join(" ");
  const style: CSSProperties = { ...boxStyle(cell.rect), opacity: cell.alphaPermille / 1000 };
  const url = content.kind === "scene" && !mock ? photoUrl(avatarId, content.photoId) : null;
  // Where the face point sits in the cell on this frame (the crop follows it until it meets the photo's edge).
  const ring = content.kind === "scene" && window !== null && source !== null ? ringAt(content.focus, window, source) : null;
  return (
    <button
      type="button"
      className={classes}
      style={style}
      aria-label={cellLabel(clipNumber, cellCount, cell)}
      aria-pressed={selected}
      aria-keyshortcuts={selected && content.kind === "scene" ? "ArrowLeft ArrowRight ArrowUp ArrowDown Escape" : undefined}
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
      {content.kind === "own" && <span className="pv-own" />}
      {content.kind === "empty" && (
        <span className="pv-empty">
          <Icon name="plus" size={16} />
          перетащите фото
        </span>
      )}
      {selected && (
        <span className="pv-cell-frame" aria-hidden="true">
          {ring !== null && content.kind === "scene" && (
            <>
              <span className="pv-face" style={{ left: pct(ring.x, 1), top: pct(ring.y, 1) }} />
              {/* Under the face point; above it when the point is low in the cell (the zones' own pill sits in the bottom band). */}
              <span className={ring.y > 0.7 ? "pill pv-face-pill pv-face-pill-up" : "pill pv-face-pill"} style={{ left: pct(ring.x, 1), top: pct(ring.y, 1) }}>
                {pending ? "ищем лицо…" : content.focus === null ? "лицо не найдено · тяните" : "по лицу · тяните"}
              </span>
            </>
          )}
        </span>
      )}
    </button>
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
  /** Enter or Space on the layer (a press selects it as it starts a drag). */
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
