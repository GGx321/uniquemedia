import { sameJson } from "./json";

// The editor's undo/redo stack (3d.2): spec versions kept in the renderer only, never sent anywhere. Immutable,
// so a React state or a session can hold it as a value.

/** At most this many spec versions are kept (the present included): 99 undos from the newest. */
export const MAX_SPEC_VERSIONS = 100;

export interface History<T> {
  /** Older versions, oldest first. */
  readonly past: readonly T[];
  readonly present: T;
  /** Versions undone, the nearest first: what redo brings back. */
  readonly future: readonly T[];
  /** The key of the edit that made `present`, when it was a keyed one; an edit with the same key replaces it. */
  readonly mergeKey: string | null;
}

export interface CommitOptions {
  /**
   * One version for a burst of the same edit (a slider drag, a trim handle): a keyed edit right after one with the
   * same key replaces the present instead of adding a version. The first keyed edit still adds one, so the state
   * before the burst stays one undo away.
   *
   * The key names ONE GESTURE, not a property: two drags of the same handle are two undo steps. So a caller either
   * makes the key unique per gesture (e.g. `trim:clip-001:<pointerId>:<pointerdown time>`), or seals the gesture
   * on pointerup with `sealVersion` (`DraftSession.endMerge`).
   */
  readonly mergeKey?: string;
  /** The cap on versions; `MAX_SPEC_VERSIONS` when absent. */
  readonly limit?: number;
}

export function startHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], mergeKey: null };
}

export const canUndo = <T,>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T,>(h: History<T>): boolean => h.future.length > 0;

/**
 * `next` as the new present. An edit equal to the present changes nothing (no empty undo steps); any real edit
 * drops the redo branch; the oldest versions go first once the cap is reached.
 */
export function commitVersion<T>(h: History<T>, next: T, options: CommitOptions = {}): History<T> {
  if (sameJson(h.present, next)) return h;
  const mergeKey = options.mergeKey ?? null;
  if (mergeKey !== null && mergeKey === h.mergeKey && h.future.length === 0) return { ...h, present: next };
  const keep = Math.max(0, (options.limit ?? MAX_SPEC_VERSIONS) - 1);
  const past = [...h.past, h.present];
  return { past: past.slice(Math.max(0, past.length - keep)), present: next, future: [], mergeKey };
}

/** Ends a keyed burst (pointerup at the end of a drag): the next edit starts a new version even with the same key. */
export function sealVersion<T>(h: History<T>): History<T> {
  return h.mergeKey === null ? h : { ...h, mergeKey: null };
}

export function undoVersion<T>(h: History<T>): History<T> {
  const previous = h.past.at(-1);
  if (previous === undefined || h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], mergeKey: null };
}

export function redoVersion<T>(h: History<T>): History<T> {
  const [next, ...rest] = h.future;
  if (next === undefined || h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: next, future: rest, mergeKey: null };
}
