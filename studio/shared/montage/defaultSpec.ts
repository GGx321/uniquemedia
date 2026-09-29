import type { Cell, Clip, MontageDraft } from "../engine/montage";
import { MAX_CLIPS, MAX_TOTAL_MS, MIN_TOTAL_MS } from "./constants";
import { splitEvenly } from "./split";

// The default montage for a set of photos, shared by «Монтаж из выбранных · N»,
// «Новый монтаж» and the autopilot (plan: "defaultSpec"). Pure: the seed comes
// from the caller, and ids are derived from the position, so the same input
// always gives the same spec.
//
// | photos | result                                                              |
// | 0      | an EMPTY draft (no clips, no layers, no music): «Новый монтаж»      |
// | 1      | one photo clip, 8.0 s, Ken Burns                                    |
// | 2 to 4 | one collage of that size, 8.0 s, Ken Burns, stagger on              |
// | 5 to 20| N photo clips (slides), Ken Burns, over clamp(N x 1.3 s, 4, 15) s,  |
// |        | split by `splitEvenly` on the 100 ms grid                           |
// | > 20   | refused                                                             |
//
// Every focus is null: the engine (or the editor, on placing a photo) resolves it.

const SINGLE_CLIP_MS = 8_000;
/** A slide montage lasts N x 1.3 s, kept between the contract's 4.0 s and 15.0 s. */
const SLIDE_MS = 1_300;
const MAX_SEED = 4_294_967_295;

const cell = (photoId: string): Cell => ({ photo: { source: "scene", photoId }, focus: null });

/** Clip ids by position: `clip-001` matches the contract's Id (8 to 64 of a-z, 0-9, `-`). */
const clipId = (index: number): string => `clip-${String(index + 1).padStart(3, "0")}`;

/**
 * The default draft for `photoIds` (scene photos of `avatarId`, in order).
 * Refuses more than 20 photos, a repeated photo and a seed that is not a
 * uint32, all with a `RangeError`. With 1 or more photos the result is a
 * complete, renderable spec; with 0 it is an empty draft.
 */
export function defaultSpec(avatarId: string, photoIds: readonly string[], seed: number): MontageDraft {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) throw new RangeError(`seed must be a uint32, got ${seed}`);
  if (photoIds.length > MAX_CLIPS) throw new RangeError(`at most ${MAX_CLIPS} photos, got ${photoIds.length}`);
  if (new Set(photoIds).size !== photoIds.length) throw new RangeError("a photo can appear only once in a montage");

  const base = { schemaVersion: 1 as const, avatarId, layers: [], music: null, seed };
  const n = photoIds.length;
  const first = photoIds[0];
  if (n === 0 || first === undefined) return { ...base, clips: [] };

  const common = { transitionIn: "cut" as const, motion: "kenburns" as const };
  if (n === 1) {
    return { ...base, clips: [{ ...common, clipId: clipId(0), durationMs: SINGLE_CLIP_MS, kind: "photo", cell: cell(first) }] };
  }
  if (n <= 4) {
    const layout = n === 2 ? "collage2" : n === 3 ? "collage3" : "collage4";
    return { ...base, clips: [{ ...common, clipId: clipId(0), durationMs: SINGLE_CLIP_MS, kind: "collage", layout, cells: photoIds.map(cell), stagger: true }] };
  }
  const totalMs = Math.min(MAX_TOTAL_MS, Math.max(MIN_TOTAL_MS, n * SLIDE_MS));
  const durations = splitEvenly(totalMs, n);
  const clips: Clip[] = photoIds.map((photoId, i) => {
    const durationMs = durations[i];
    if (durationMs === undefined) throw new Error("splitEvenly returns one duration per photo");
    return { ...common, clipId: clipId(i), durationMs, kind: "photo", cell: cell(photoId) };
  });
  return { ...base, clips };
}
