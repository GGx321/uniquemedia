import { MAX_TOTAL_MS, STEP_MS } from "../../../shared/montage";

// 3d.3a: the timeline's scale and the playhead, as plain numbers. The ruler always spans 0–15 s (the longest
// montage); the zoom (1–8) only widens it, and «Уместить» brings it back to 1. The playhead is the renderer's
// clock: whole 100 ms steps (`STEP_MS`, 3 frames) within the montage, never saved.

/** The ruler's span: the longest montage. */
export const TIMELINE_MS = MAX_TOTAL_MS;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** One frame of a clip's film strip, as the artboard draws it. */
export const STRIP_FRAME_PX = 24;

export interface Tick {
  readonly ms: number;
  /** A taller tick, where a label may stand. */
  readonly major: boolean;
}

export interface RulerLabel {
  readonly ms: number;
  readonly text: string;
  /** The first label starts at its tick, the last ends at it, the rest are centred on theirs. */
  readonly align: "start" | "center" | "end";
  /** Past the montage's end: drawn dim over the hatching. */
  readonly after: boolean;
}

/** A selected clip's trim handle at full size (montage.css `.hd`), and the narrowest one still drawn beside its pair. */
const HANDLE_PX = 9;
const HANDLE_MIN_PX = 3;

/**
 * How wide a selected clip's two trim handles are in a slot `slotPx` wide, so they never cover each other or reach a neighbour:
 * 9 px, at most 40% of the slot each, at least 3 px. A slot too narrow for two of those (a 0.1 s clip at fit zoom is ~5 px) draws
 * only the right one, no wider than the slot; the left one stays a keyboard slider (0 px, seen by its focus ring).
 */
export function trimHandlePx(slotPx: number): { start: number; end: number } {
  const each = Math.min(HANDLE_PX, Math.max(HANDLE_MIN_PX, Math.floor(slotPx * 0.4)));
  if (2 * each <= slotPx) return { start: each, end: each };
  return { start: 0, end: Math.max(0, Math.min(HANDLE_MIN_PX, slotPx)) };
}

/** A whole zoom step from 1 to 8; anything else (NaN included) lands on the nearest bound. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
}

const clampToMontage = (ms: number, totalMs: number): number => Math.min(Math.max(0, totalMs), Math.max(0, ms));

/** A pointer's time as the playhead takes it: the nearest 100 ms, within the montage. */
export function snapPlayhead(ms: number, totalMs: number): number {
  return clampToMontage(Math.round(ms / STEP_MS) * STEP_MS, totalMs);
}

/** The 100 ms step a (possibly playing) playhead is in: what the clock reads. */
export function clockMs(ms: number): number {
  return Math.max(0, Math.floor(ms / STEP_MS) * STEP_MS);
}

/** An arrow key's move: `deltaMs` from the clock's step, within the montage. */
export function stepPlayhead(ms: number, totalMs: number, deltaMs: number): number {
  return clampToMontage(clockMs(ms) + deltaMs, totalMs);
}

/**
 * Where the playhead goes when an item is selected (the artboard's rule): it stays when it is already inside
 * `[startMs, endMs)`; otherwise it moves 1 s into the item, or to its middle when the item is shorter than 2 s.
 */
export function seekInto(playheadMs: number, startMs: number, endMs: number): number {
  if (playheadMs >= startMs && playheadMs < endMs) return playheadMs;
  return clockMs(startMs + Math.min(1_000, (endMs - startMs) / 2));
}

/** A place along the whole ruler (0 = its start, 1 = 15 s) as a time. */
export function msAtFraction(fraction: number): number {
  return Math.min(1, Math.max(0, fraction)) * TIMELINE_MS;
}

/** The ruler at `zoom`: fit, a tick every 0.5 s and a label every second; zoomed, 0.25 s ticks (0.1 s from 5×) and 0.5 s labels. */
export function rulerMarks(zoom: number, totalMs: number): { ticks: readonly Tick[]; labels: readonly RulerLabel[] } {
  const z = clampZoom(zoom);
  const tickMs = z === 1 ? 500 : z < 5 ? 250 : 100;
  const labelMs = z === 1 ? 1_000 : 500;
  const ticks: Tick[] = [];
  for (let ms = 0; ms <= TIMELINE_MS; ms += tickMs) ticks.push({ ms, major: ms % labelMs === 0 });
  const labels: RulerLabel[] = [];
  for (let ms = 0; ms <= TIMELINE_MS; ms += labelMs) {
    const seconds = ms / 1000;
    const text = ms === 0 ? "0 с" : ms === TIMELINE_MS ? `${seconds} с` : String(seconds);
    labels.push({ ms, text, align: ms === 0 ? "start" : ms === TIMELINE_MS ? "end" : "center", after: ms > totalMs });
  }
  return { ticks, labels };
}

/** Where boundary `boundary` of back-to-back clips is: 0 before the first, the total after the last. */
export function boundaryMs(durations: readonly number[], boundary: number): number {
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > durations.length) throw new RangeError(`boundary must be 0..${durations.length}, got ${boundary}`);
  return durations.slice(0, boundary).reduce((sum, d) => sum + d, 0);
}

/** The boundary nearest to `ms` (a drop's insertion line); past the end, the end. */
export function boundaryAt(durations: readonly number[], ms: number): number {
  let best = 0;
  let bestDistance = Math.abs(ms);
  let at = 0;
  durations.forEach((d, i) => {
    at += d;
    const distance = Math.abs(ms - at);
    if (distance < bestDistance) {
      best = i + 1;
      bestDistance = distance;
    }
  });
  return best;
}

/** `edgeMs` moved onto the nearest of `targets` within `toleranceMs` (a trimmed edge meeting the playhead). */
export function snapEdge(edgeMs: number, targets: readonly number[], toleranceMs: number): number {
  let best = edgeMs;
  let bestDistance = toleranceMs;
  for (const target of targets) {
    const distance = Math.abs(target - edgeMs);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * What a dragged layer's edges stick to (3d.3b, the components sheet: «края липнут к плейхеду и границам кадров»): the
 * playhead on the step the clock shows, and every clip boundary, the montage's start and end included. Ascending, once each.
 */
export function snapTargets(durations: readonly number[], playheadMs: number): number[] {
  const targets = new Set<number>([0, clockMs(playheadMs)]);
  let at = 0;
  for (const d of durations) {
    at += d;
    targets.add(at);
  }
  return [...targets].sort((a, b) => a - b);
}

/**
 * A moved block's start (its length `lengthMs`), shifted so that whichever of its edges is nearer a target within
 * `toleranceMs` meets it; the start edge wins a tie. Unchanged when neither edge is near one.
 */
export function snapMove(startMs: number, lengthMs: number, targets: readonly number[], toleranceMs: number): number {
  /** The nearest target's distance from `edge` within the tolerance (0: on one), or null when none is that near. */
  const nearest = (edge: number): number | null => {
    let best: number | null = null;
    for (const target of targets) {
      const distance = Math.abs(target - edge);
      if (distance <= toleranceMs && (best === null || distance < best)) best = distance;
    }
    return best;
  };
  const startGap = nearest(startMs);
  const endGap = nearest(startMs + lengthMs);
  if (startGap !== null && (endGap === null || startGap <= endGap)) return snapEdge(startMs, targets, toleranceMs);
  if (endGap !== null) return snapEdge(startMs + lengthMs, targets, toleranceMs) - lengthMs;
  return startMs;
}

/** How many 24 px frames a clip's film strip of `widthPx` draws: one more than fit, so it never ends short. */
export function tileCount(widthPx: number): number {
  return Math.ceil(Math.max(0, widthPx) / STRIP_FRAME_PX) + 1;
}
