import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import type { Layer, MontageDraft } from "../../../shared/engine";
import { FPS } from "../../../shared/montage";
import { stickerById } from "../../../shared/stickers/manifest";
import { useEngine } from "../../engine/react";
import { stickerUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";
import { DRAG_THRESHOLD_PX, type GestureKit, SNAP_PX } from "./gesture";
import { captionLine, dragRangeLabel, layerAria, layerEdgeLabel, secondsLabel, stickerName } from "./labels";
import { clampEdge, clampStart, edgeRange, type LayerEdge, type LayerKind, layerRows, lowerLayer, moveLayer, raiseLayer, trimLayer } from "./layerOps";
import type { DraftSession } from "./session";
import { snapEdge, snapMove, TIMELINE_MS } from "./timelineScale";
import type { TimelineState } from "./useTimeline";

// 3d.3b: the text and sticker tracks (Editor.dc.html's two text rows and the sticker row; the components sheet's «Слой
// текста и стикера · .blk · ручки .hd»). Each layer is a block over its time range: «T» and the caption for a text, the
// sticker's picture, name and «петля» (with a tick at every loop) for a sticker. A kind's blocks are packed into rows so
// none covers another (packing only, AM11; the z-order is the array's and has its own «Слой выше» / «Слой ниже»).
//
// A block is a button: a click selects it, a drag moves it (100 ms steps, its length kept, the edges sticking to the
// playhead and the clip boundaries, never further past the montage's end). A selected block has a trim handle at each
// edge, a slider. A drag is drawn as it goes and is ONE edit when it is let go (a cancelled pointer moves nothing).
// Keyboard: ⌥←/⌥→ move the focused block by 0.1 s (⇧: 1 s), ⌥↑/⌥↓ step it up and down the z-order; the handles take
// ←/→ (⇧: 1 s), Home and End; a held key is one undo step.

/** Rows a lane always shows: the artboard's two text rows and one sticker row. */
export const MIN_ROWS: Record<LayerKind, number> = { text: 2, sticker: 1 };
/** One row of a layer lane, and the gap between rows, as drawn. */
export const ROW_PX = 26;
export const ROW_GAP_PX = 4;
/** A block's inset from its row's top and bottom (the sheet's .blk: 3 px). */
const BLOCK_INSET_PX = 3;

/** A lane's height for `rows` rows: the track header beside it takes the same. */
export const laneHeight = (rows: number): number => rows * ROW_PX + Math.max(0, rows - 1) * ROW_GAP_PX;

/** A kind's blocks in the lane: the layers' indexes in the draft, the row of each, and how many rows the lane shows. */
export interface LaneLayout {
  readonly indexes: readonly number[];
  readonly rows: readonly number[];
  readonly count: number;
}

export function laneLayout(spec: MontageDraft, kind: LayerKind): LaneLayout {
  const indexes = spec.layers.flatMap((layer, i) => (layer.kind === kind ? [i] : []));
  const packed = layerRows(indexes.map((i) => spec.layers[i]).filter((l): l is Layer => l !== undefined));
  return { indexes, rows: packed.rows, count: Math.max(MIN_ROWS[kind], packed.count) };
}

const pct = (ms: number): string => `${(ms / TIMELINE_MS) * 100}%`;

/** A block being dragged, as it would land: drawn at once, made an edit only when it is let go. */
interface LayerDrag {
  readonly layerId: string;
  readonly startMs: number;
  readonly endMs: number;
  /** The snap target an edge sits on, for the accent line. */
  readonly snapAt: number | null;
}

export interface LayerTracksProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly timeline: TimelineState;
  readonly kit: GestureKit;
  /** The lanes' scale as laid out now: a sticker's loop ticks. */
  readonly pxPerMs: number;
  readonly text: LaneLayout;
  readonly sticker: LaneLayout;
  /** What a layer's edges stick to (`snapTargets`). */
  readonly targets: readonly number[];
  /** Why the engine refuses a layer, by its id («надпись не проходит проверку»): the block says it. */
  readonly flagged: ReadonlyMap<string, string>;
  /** Selects the layer and brings the playhead into it. */
  readonly onSelect: (layerId: string) => void;
}

export function LayerTracks({ session, spec, timeline, kit, pxPerMs, text, sticker, targets, flagged, onSelect }: LayerTracksProps) {
  const { client } = useEngine();
  const [drag, setDrag] = useState<LayerDrag | null>(null);
  /** The key holding a keyboard move or trim open: its release (not a modifier's) ends the undo step. */
  const heldKey = useRef<string | null>(null);
  const total = spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);

  const indexOf = (layerId: string): number => session.state.spec.layers.findIndex((l) => l.layerId === layerId);

  function endHeld(key?: string): void {
    if (heldKey.current === null || (key !== undefined && key !== heldKey.current)) return;
    heldKey.current = null;
    session.endMerge();
  }

  // ---------- pointer ----------

  function pressBlock(press: ReactPointerEvent<HTMLButtonElement>, layer: Layer): void {
    if (press.button !== 0) return;
    const startX = press.clientX;
    const length = layer.endMs - layer.startMs;
    const snaps = targets;
    let moved = false;
    let last = layer.startMs;
    kit.start(
      press,
      (event) => {
        const dx = event.clientX - startX;
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        moved = true;
        const perMs = kit.pxPerMs();
        const index = indexOf(layer.layerId);
        if (index < 0) return;
        last = clampStart(session.state.spec, index, snapMove(layer.startMs + dx / perMs, length, snaps, SNAP_PX / perMs));
        const snapAt = snaps.find((t) => t === last || t === last + length) ?? null;
        setDrag({ layerId: layer.layerId, startMs: last, endMs: last + length, snapAt });
      },
      (event) => {
        setDrag(null);
        if (!moved) return;
        kit.swallowClick();
        // A cancelled pointer (the system took it) moves nothing.
        if (event === null) return;
        const current = session.state.spec;
        const index = indexOf(layer.layerId);
        if (index < 0) return;
        const edit = moveLayer(current, index, last);
        if (edit.ok && edit.spec !== current) session.edit(edit.spec);
        // The moved block is the one being worked on; the playhead stays where the owner left it.
        timeline.select({ kind: "layer", layerId: layer.layerId });
      },
    );
  }

  function pressHandle(press: ReactPointerEvent<HTMLSpanElement>, layer: Layer, edge: LayerEdge): void {
    if (press.button !== 0) return;
    press.preventDefault();
    press.stopPropagation();
    const startX = press.clientX;
    const from = edge === "start" ? layer.startMs : layer.endMs;
    const snaps = targets;
    let last = from;
    kit.start(
      press,
      (event) => {
        const perMs = kit.pxPerMs();
        const index = indexOf(layer.layerId);
        if (index < 0) return;
        last = clampEdge(session.state.spec, index, edge, snapEdge(from + (event.clientX - startX) / perMs, snaps, SNAP_PX / perMs));
        setDrag({ layerId: layer.layerId, startMs: edge === "start" ? last : layer.startMs, endMs: edge === "end" ? last : layer.endMs, snapAt: snaps.includes(last) ? last : null });
      },
      (event) => {
        setDrag(null);
        if (event === null || last === from) return;
        const current = session.state.spec;
        const index = indexOf(layer.layerId);
        if (index < 0) return;
        const edit = trimLayer(current, index, edge, last);
        if (edit.ok && edit.spec !== current) session.edit(edit.spec);
      },
    );
  }

  // ---------- keyboard ----------

  function onBlockKey(event: KeyboardEvent<HTMLButtonElement>, layerId: string): void {
    if (!event.altKey || event.metaKey || event.ctrlKey) return;
    const current = session.state.spec;
    const index = indexOf(layerId);
    const layer = current.layers[index];
    if (layer === undefined) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      // The block may change rows; it stays the same element (lanes are flat, keyed by layer), so it keeps the focus.
      const edit = event.key === "ArrowUp" ? raiseLayer(current, index) : lowerLayer(current, index);
      if (edit.ok) session.edit(edit.spec);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const step = (event.shiftKey ? 1_000 : 100) * (event.key === "ArrowLeft" ? -1 : 1);
    const edit = moveLayer(current, index, clampStart(current, index, layer.startMs + step));
    heldKey.current = event.key;
    // Held keys repeat: one undo step until the key is let go.
    if (edit.ok && edit.spec !== current) session.edit(edit.spec, { mergeKey: `move-key:${layerId}` });
  }

  function onHandleKey(event: KeyboardEvent<HTMLSpanElement>, layerId: string, edge: LayerEdge): void {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const current = session.state.spec;
    const index = indexOf(layerId);
    const layer = current.layers[index];
    if (layer === undefined) return;
    const range = edgeRange(current, index, edge);
    const at = edge === "start" ? layer.startMs : layer.endMs;
    const step = event.shiftKey ? 1_000 : 100;
    const targetsByKey: Record<string, number> = { ArrowRight: at + step, ArrowUp: at + step, ArrowLeft: at - step, ArrowDown: at - step, Home: range.min, End: range.max };
    const wanted = targetsByKey[event.key];
    if (wanted === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const edit = trimLayer(current, index, edge, clampEdge(current, index, edge, wanted));
    heldKey.current = event.key;
    if (edit.ok && edit.spec !== current) session.edit(edit.spec, { mergeKey: `trim-key:${layerId}:${edge}` });
  }

  // ---------- drawing ----------

  function block(index: number, row: number) {
    const layer = spec.layers[index];
    if (layer === undefined) return null;
    const dragged = drag?.layerId === layer.layerId ? drag : null;
    const startMs = dragged?.startMs ?? layer.startMs;
    const endMs = dragged?.endMs ?? layer.endMs;
    const selected = timeline.selection?.kind === "layer" && timeline.selection.layerId === layer.layerId;
    const problem = flagged.get(layer.layerId) ?? null;
    const outside = endMs > total;
    const kindClass = layer.kind === "text" ? "ed-blk-text" : "ed-blk-sticker";
    const slot = ["ed-blk-slot", kindClass, selected ? "ed-blk-on" : "", dragged !== null ? "ed-blk-lifted" : "", outside ? "ed-blk-out" : "", problem !== null ? "ed-blk-flagged" : ""].filter(Boolean).join(" ");
    const entry = layer.kind === "sticker" && layer.sticker.source === "builtin" ? stickerById(layer.sticker.stickerId) : undefined;
    const loopPx = entry === undefined ? 0 : (entry.loopFrames / FPS) * 1000 * pxPerMs;
    // A sticker's loop: a short tick along the block's foot at each repeat, under the label (none when too dense to read).
    const loopStyle =
      loopPx >= 6
        ? { backgroundImage: `repeating-linear-gradient(90deg, transparent 0 ${loopPx - 1}px, var(--info) ${loopPx - 1}px ${loopPx}px)`, backgroundSize: "100% 4px", backgroundPosition: "0 100%", backgroundRepeat: "no-repeat" }
        : undefined;
    const aria = problem === null ? layerAria(spec, index, total) : `${layerAria(spec, index, total)}, ${problem}`;

    const handle = (edge: LayerEdge) => {
      const range = edgeRange(spec, index, edge);
      const value = edge === "start" ? layer.startMs : layer.endMs;
      return (
        <span
          role="slider"
          tabIndex={0}
          className={edge === "start" ? "hd hd-l" : "hd hd-r"}
          aria-label={layerEdgeLabel(spec, index, edge)}
          aria-valuemin={range.min}
          aria-valuemax={range.max}
          aria-valuenow={value}
          aria-valuetext={secondsLabel(value)}
          onPointerDown={(e) => pressHandle(e, layer, edge)}
          onKeyDown={(e) => onHandleKey(e, layer.layerId, edge)}
          onKeyUp={(e) => endHeld(e.key)}
          onBlur={() => endHeld()}
        />
      );
    };

    return (
      <div key={layer.layerId} className={slot} style={{ top: row * (ROW_PX + ROW_GAP_PX) + BLOCK_INSET_PX, left: `calc(${pct(startMs)} + 1px)`, width: `calc(${pct(endMs - startMs)} - 2px)` }}>
        <button
          type="button"
          className="blk ed-blk"
          data-layer-id={layer.layerId}
          aria-pressed={selected}
          aria-label={aria}
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Delete"
          style={loopStyle}
          onPointerDown={(e) => pressBlock(e, layer)}
          onClick={() => {
            if (kit.clickSwallowed()) return;
            onSelect(layer.layerId);
          }}
          onKeyDown={(e) => onBlockKey(e, layer.layerId)}
          onKeyUp={(e) => endHeld(e.key)}
          onBlur={() => endHeld()}
        >
          {problem !== null && <span className="ed-blk-warn">⚠</span>}
          {layer.kind === "text" ? (
            <>
              <span className="ed-blk-t" aria-hidden="true">
                T
              </span>
              <span className="ed-blk-label" lang="en">
                {captionLine(layer.value)}
              </span>
            </>
          ) : (
            <>
              <StickerThumb client={client} layer={layer} />
              <span className="ed-blk-label">
                {stickerName(layer)}
                {entry !== undefined && " · петля"}
              </span>
            </>
          )}
        </button>
        {selected && (
          <>
            {handle("start")}
            {handle("end")}
          </>
        )}
        {dragged !== null && <span className="mono ed-blk-range">{dragRangeLabel(startMs, endMs)}</span>}
      </div>
    );
  }

  // A lane is flat: its rows are drawn as stripes, and every block sits in the lane itself, keyed by its layer and placed
  // on its row. The blocks are in a STABLE DOM order (by layer id), never the z-order: a block whose row or z-order
  // changes (a move, a trim, a z-order step, an undo) is neither remounted nor moved. Chromium drops the focus of a node
  // React moves (`insertBefore` detaches it first), so this is what keeps the keyboard focus and a held key's undo step.
  // Blocks of one lane never overlap, and the selected or lifted one has a z-index of its own.
  function lane(kind: LayerKind, layout: LaneLayout) {
    const placed = layout.indexes
      .map((index, i) => ({ index, row: layout.rows[i] ?? 0, layerId: spec.layers[index]?.layerId ?? "" }))
      .sort((a, b) => (a.layerId < b.layerId ? -1 : a.layerId > b.layerId ? 1 : 0));
    return (
      <div className={`ed-layer-lane ed-layer-lane-${kind}`} role="group" aria-label={kind === "text" ? "Тексты" : "Стикеры"} style={{ height: laneHeight(layout.count) }}>
        {Array.from({ length: layout.count }, (_, row) => (
          <div
            key={row}
            className={kind === "text" ? "trk ed-lane-text ed-lane-row" : "trk ed-lane-sticker ed-lane-row"}
            style={{ top: row * (ROW_PX + ROW_GAP_PX) }}
            onPointerDown={(e) => e.target === e.currentTarget && timeline.select(null)}
          />
        ))}
        {placed.map(({ index, row }) => block(index, row))}
      </div>
    );
  }

  return (
    <>
      {lane("text", text)}
      {lane("sticker", sticker)}
      {drag?.snapAt !== null && drag?.snapAt !== undefined && <span className="ed-snap" aria-hidden="true" style={{ left: pct(drag.snapAt) }} />}
    </>
  );
}

/** A sticker block's picture: the built-in set's own (an APNG that plays its loop), a sparkle for an own or a vanished one. */
function StickerThumb({ client, layer }: { client: ReturnType<typeof useEngine>["client"]; layer: Extract<Layer, { kind: "sticker" }> }) {
  const url = layer.sticker.source === "builtin" && stickerById(layer.sticker.stickerId) !== undefined ? stickerUrl(client, layer.sticker.stickerId) : null;
  if (url === null) {
    return (
      <span className="ed-blk-icon" aria-hidden="true">
        <Icon name="sparkle" size={11} />
      </span>
    );
  }
  return <img className="ed-blk-thumb" src={url} alt="" draggable={false} />;
}
