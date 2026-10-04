import { type Cell, type Clip, type Focus, MAX_SOURCE_OFFSET_MS, type MontageDraft, type Motion } from "../../../shared/engine";
import { MAX_CLIPS, MAX_TOTAL_MS, MIN_CLIP_MS, splitEvenly, STEP_MS } from "../../../shared/montage";

// 3d.3a: the clip track's edits, as pure functions over a draft. The editor sends each result through
// `DraftSession.edit`, so every one is an undo step and is saved like any other edit; nothing here touches the
// session. What every result keeps (the tests pin it):
// - the contract's draft rules (`MontageDraft`): no scene photo twice, unique ids, at most 20 clips, layer caps;
// - the editor's own limits, which a draft alone does not enforce: every clip a whole number of 100 ms steps and at
//   least 0.5 s, and the clips together never longer than 15 s (a render's bound, kept while editing);
// - CF4: a photo or collage clip is never split, and its copy has empty cells, because both would repeat a photo.
//
// A refusal the owner can meet (a cap, no room, a photo already placed) is a `Refusal`; an index outside the
// draft is a programming error and throws a RangeError, like the shared geometry does.

/** «1 фото», «Коллаж 2», «Коллаж 3», «Коллаж 4». */
export type ClipLayout = "photo" | "collage2" | "collage3" | "collage4";

/**
 * Why an edit was not made:
 * - `clip-cap`: 20 clips already;
 * - `no-room`: less than 0.5 s is left of the 15 s;
 * - `photo-in-draft`: the scene photo is already in the montage (one photo, once);
 * - `layer-cap`: 10 layers of that kind already;
 * - `not-splittable`: a photo or collage clip (CF4), or a point not strictly inside the item;
 * - `too-short`: a part of a split would be under its minimum (0.5 s for a clip, 0.3 s for a layer);
 * - `not-a-photo-clip`: a layout, motion or stagger change on a clip that has none.
 */
export type Refusal = "clip-cap" | "no-room" | "photo-in-draft" | "layer-cap" | "not-splittable" | "too-short" | "not-a-photo-clip";

/** An edit's result: the new draft, and the id of the clip or layer it created (to select it), or why not. */
export type Edit = { readonly ok: true; readonly spec: MontageDraft; readonly id?: string } | { readonly ok: false; readonly reason: Refusal };

/** A new clip lasts this long when there is room for it (AM7). */
export const ADD_CLIP_MS = 2_000;

type CollageLayout = Extract<Clip, { kind: "collage" }>["layout"];
const CELL_COUNT: Record<CollageLayout, number> = { collage2: 2, collage3: 3, collage4: 4 };
const EMPTY_CELL: Cell = { photo: null, focus: null };

const refuse = (reason: Refusal): Edit => ({ ok: false, reason });
const done = (spec: MontageDraft, id?: string): Edit => (id === undefined ? { ok: true, spec } : { ok: true, spec, id });

function assertIndex(index: number, length: number, what: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError(`${what} must be 0..${length - 1}, got ${index}`);
}

function clipAt(spec: MontageDraft, index: number): Clip {
  assertIndex(index, spec.clips.length, "clip index");
  const clip = spec.clips[index];
  if (clip === undefined) throw new RangeError(`no clip at ${index}`);
  return clip;
}

const withClips = (spec: MontageDraft, clips: Clip[]): MontageDraft => ({ ...spec, clips });
const replaceClip = (spec: MontageDraft, index: number, clip: Clip): MontageDraft => withClips(spec, spec.clips.map((c, i) => (i === index ? clip : c)));

/** The montage's length: its clips back to back. */
export function totalMs(spec: MontageDraft): number {
  return spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
}

/** What is left of the 15 s; 0, never negative, for a draft that is already longer. */
export function roomMs(spec: MontageDraft): number {
  return Math.max(0, MAX_TOTAL_MS - totalMs(spec));
}

/** Where clip `index` starts on the timeline. */
export function clipStartMs(spec: MontageDraft, index: number): number {
  assertIndex(index, spec.clips.length, "clip index");
  return spec.clips.slice(0, index).reduce((sum, clip) => sum + clip.durationMs, 0);
}

/** Why no clip can be added now. */
export type AddRefusal = Extract<Refusal, "clip-cap" | "no-room">;

/** Why no clip can be added now, or null. */
export function addRefusal(spec: MontageDraft): AddRefusal | null {
  if (spec.clips.length >= MAX_CLIPS) return "clip-cap";
  if (roomMs(spec) < MIN_CLIP_MS) return "no-room";
  return null;
}

/** The next `<prefix>NNN` after the highest one in `ids`; ids of another form are never reused, only skipped. */
function nextId(prefix: string, ids: readonly string[]): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let highest = 0;
  for (const id of ids) {
    const n = Number(pattern.exec(id)?.[1] ?? 0);
    if (n > highest) highest = n;
  }
  return `${prefix}${String(highest + 1).padStart(3, "0")}`;
}

export const nextClipId = (spec: MontageDraft): string => nextId("clip-", spec.clips.map((c) => c.clipId));
export const nextLayerId = (spec: MontageDraft): string => nextId("layer-", spec.layers.map((l) => l.layerId));

/** A clip's cells: one for a photo clip, two to four for a collage, none for a video. */
export function cellsOf(clip: Clip): readonly Cell[] {
  return clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
}

/** Every scene photo the montage holds. */
export function scenePhotoIds(spec: MontageDraft): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const clip of spec.clips) for (const cell of cellsOf(clip)) if (cell.photo?.source === "scene") ids.add(cell.photo.photoId);
  return ids;
}

const sceneCell = (photoId: string, focus: Focus | null): Cell => ({ photo: { source: "scene", photoId }, focus });

/** A new photo clip of `photoId` before the clip at `boundary` (0 = the start, the clip count = the end). */
export function insertPhotoClip(spec: MontageDraft, boundary: number, photoId: string, focus: Focus | null = null): Edit {
  assertIndex(boundary, spec.clips.length + 1, "boundary");
  const why = addRefusal(spec);
  if (why !== null) return refuse(why);
  if (scenePhotoIds(spec).has(photoId)) return refuse("photo-in-draft");
  const clipId = nextClipId(spec);
  const clip: Clip = { clipId, durationMs: Math.min(ADD_CLIP_MS, roomMs(spec)), transitionIn: "cut", kind: "photo", cell: sceneCell(photoId, focus), motion: "kenburns" };
  return done(withClips(spec, [...spec.clips.slice(0, boundary), clip, ...spec.clips.slice(boundary)]), clipId);
}

/** «Клик — кадр в конец ролика». */
export function appendPhotoClip(spec: MontageDraft, photoId: string, focus: Focus | null = null): Edit {
  return insertPhotoClip(spec, spec.clips.length, photoId, focus);
}

export function removeClip(spec: MontageDraft, index: number): MontageDraft {
  clipAt(spec, index);
  return withClips(spec, spec.clips.filter((_, i) => i !== index));
}

/**
 * Moves clip `from` to `boundary`, a boundary of the CURRENT order (0 = before the first clip, the clip count =
 * after the last), as a drop line on the track names it. The clip's own two boundaries leave the draft as it is.
 */
export function moveClip(spec: MontageDraft, from: number, boundary: number): MontageDraft {
  const clip = clipAt(spec, from);
  assertIndex(boundary, spec.clips.length + 1, "boundary");
  if (boundary === from || boundary === from + 1) return spec;
  const rest = spec.clips.filter((_, i) => i !== from);
  const at = boundary > from ? boundary - 1 : boundary;
  return withClips(spec, [...rest.slice(0, at), clip, ...rest.slice(at)]);
}

/**
 * The longest clip `index` may become: its length plus the room (only its own length once the room is gone). `limitMs` is a cap of the clip's own: an
 * own video clip's, from its trim to its video's end (3f.3b, `durationLimitMs`), once the video is known.
 */
export function maxDurationMs(spec: MontageDraft, index: number, limitMs?: number): number {
  const max = clipAt(spec, index).durationMs + roomMs(spec);
  return limitMs === undefined ? max : Math.min(max, limitMs);
}

/** `wantedMs` as clip `index` may take it: the nearest 100 ms, at least 0.5 s, the total at most 15 s, and within `limitMs` when given. */
export function clampDuration(spec: MontageDraft, index: number, wantedMs: number, limitMs?: number): number {
  if (!Number.isFinite(wantedMs)) throw new RangeError(`a duration must be a finite number, got ${wantedMs}`);
  const max = maxDurationMs(spec, index, limitMs);
  const snapped = Math.round(wantedMs / STEP_MS) * STEP_MS;
  return Math.max(MIN_CLIP_MS, Math.min(max, snapped));
}

/** Clip `index` at `wantedMs` (clamped, and within `limitMs` when given); the same draft when its length does not change. */
export function setDuration(spec: MontageDraft, index: number, wantedMs: number, limitMs?: number): MontageDraft {
  const clip = clipAt(spec, index);
  const durationMs = clampDuration(spec, index, wantedMs, limitMs);
  return durationMs === clip.durationMs ? spec : replaceClip(spec, index, { ...clip, durationMs });
}

/** No two clips more than one 100 ms step apart: as even as the grid allows. True for zero or one clip. */
export function isEven(spec: MontageDraft): boolean {
  if (spec.clips.length < 2) return true;
  const lengths = spec.clips.map((c) => c.durationMs);
  return Math.max(...lengths) - Math.min(...lengths) <= STEP_MS;
}

/** The same total over every clip (`splitEvenly`: the longer parts first); the same draft when already even. */
export function evenOut(spec: MontageDraft): MontageDraft {
  if (isEven(spec)) return spec;
  const lengths = splitEvenly(totalMs(spec), spec.clips.length);
  return withClips(
    spec,
    spec.clips.map((clip, i) => ({ ...clip, durationMs: lengths[i] ?? clip.durationMs })),
  );
}

/**
 * Splits an own video clip at `atMs` on the montage's timeline (snapped to 100 ms): the second part is a new clip
 * that continues the source where the first stops, never further into it than the contract's `MAX_SOURCE_OFFSET_MS`
 * (3f.3b). Never a photo or collage clip (CF4).
 */
export function splitClipAt(spec: MontageDraft, index: number, atMs: number): Edit {
  const clip = clipAt(spec, index);
  if (clip.kind !== "video") return refuse("not-splittable");
  const start = clipStartMs(spec, index);
  const at = Math.round(atMs / STEP_MS) * STEP_MS - start;
  if (at <= 0 || at >= clip.durationMs || clip.trimStartMs + at > MAX_SOURCE_OFFSET_MS) return refuse("not-splittable");
  if (at < MIN_CLIP_MS || clip.durationMs - at < MIN_CLIP_MS) return refuse("too-short");
  if (spec.clips.length >= MAX_CLIPS) return refuse("clip-cap");
  const clipId = nextClipId(spec);
  const first: Clip = { ...clip, durationMs: at };
  const second: Clip = { ...clip, clipId, durationMs: clip.durationMs - at, trimStartMs: clip.trimStartMs + at };
  return done(withClips(spec, [...spec.clips.slice(0, index), first, second, ...spec.clips.slice(index + 1)]), clipId);
}

/**
 * A copy of clip `index` right after it, cut to the room. A photo or collage copy keeps its layout, motion and
 * stagger with EMPTY cells (CF4: one photo, once); a video copy is the same video.
 */
export function duplicateClip(spec: MontageDraft, index: number): Edit {
  const clip = clipAt(spec, index);
  const why = addRefusal(spec);
  if (why !== null) return refuse(why);
  const clipId = nextClipId(spec);
  const durationMs = Math.min(clip.durationMs, roomMs(spec));
  const copy: Clip =
    clip.kind === "photo"
      ? { ...clip, clipId, durationMs, cell: EMPTY_CELL }
      : clip.kind === "collage"
        ? { ...clip, clipId, durationMs, cells: clip.cells.map(() => EMPTY_CELL) }
        : { ...clip, clipId, durationMs };
  return done(withClips(spec, [...spec.clips.slice(0, index + 1), copy, ...spec.clips.slice(index + 1)]), clipId);
}

/** The clip's layout, or null for a video clip. */
export function layoutOf(clip: Clip): ClipLayout | null {
  return clip.kind === "photo" ? "photo" : clip.kind === "collage" ? clip.layout : null;
}

/**
 * «Раскладка»: one photo ↔ a collage of 2–4. Cells are kept in order, cut from the end or padded with empty ones;
 * the motion is kept, a collage keeps its stagger and a new one starts with it on (as `defaultSpec` does).
 */
export function setLayout(spec: MontageDraft, index: number, layout: ClipLayout): Edit {
  const clip = clipAt(spec, index);
  if (clip.kind === "video") return refuse("not-a-photo-clip");
  if (layoutOf(clip) === layout) return done(spec);
  const cells = cellsOf(clip);
  const base = { clipId: clip.clipId, durationMs: clip.durationMs, transitionIn: clip.transitionIn, motion: clip.motion };
  if (layout === "photo") return done(replaceClip(spec, index, { ...base, kind: "photo", cell: cells[0] ?? EMPTY_CELL }));
  const count = CELL_COUNT[layout];
  const next = Array.from({ length: count }, (_, i) => cells[i] ?? EMPTY_CELL);
  const stagger = clip.kind === "collage" ? clip.stagger : true;
  return done(replaceClip(spec, index, { ...base, kind: "collage", layout, cells: next, stagger }));
}

/** «Анимация»: Ken Burns, a pan or still, for a photo or collage clip. */
export function setMotion(spec: MontageDraft, index: number, motion: Motion): Edit {
  const clip = clipAt(spec, index);
  if (clip.kind === "video") return refuse("not-a-photo-clip");
  return done(clip.motion === motion ? spec : replaceClip(spec, index, { ...clip, motion }));
}

/** «Ячейки по очереди»: a collage's alone. */
export function setStagger(spec: MontageDraft, index: number, on: boolean): Edit {
  const clip = clipAt(spec, index);
  if (clip.kind !== "collage") return refuse("not-a-photo-clip");
  return done(clip.stagger === on ? spec : replaceClip(spec, index, { ...clip, stagger: on }));
}

/** Puts scene photo `photoId` (with `focus`) into cell `cell` of clip `clipIndex`; null empties the cell. */
export function setCellPhoto(spec: MontageDraft, clipIndex: number, cell: number, photoId: string | null, focus: Focus | null = null): Edit {
  const clip = clipAt(spec, clipIndex);
  if (clip.kind === "video") throw new RangeError(`clip ${clipIndex} is a video and has no cells`);
  const cells = cellsOf(clip);
  assertIndex(cell, cells.length, "cell index");
  const current = cells[cell]?.photo;
  if (photoId !== null && current?.source === "scene" && current.photoId === photoId) return done(spec);
  if (photoId !== null && scenePhotoIds(spec).has(photoId)) return refuse("photo-in-draft");
  const next = photoId === null ? EMPTY_CELL : sceneCell(photoId, focus);
  if (clip.kind === "photo") return done(replaceClip(spec, clipIndex, { ...clip, cell: next }));
  return done(replaceClip(spec, clipIndex, { ...clip, cells: clip.cells.map((c, i) => (i === cell ? next : c)) }));
}

/**
 * The focus `montages.focus` found for a placed photo (K6), written into every cell holding that photo whose focus
 * is still null; a stored focus is never replaced. The same draft when nothing changes.
 */
export function fillFocus(spec: MontageDraft, photoId: string, focus: Focus): MontageDraft {
  let changed = false;
  const fill = (cell: Cell): Cell => {
    if (cell.focus !== null || cell.photo?.source !== "scene" || cell.photo.photoId !== photoId) return cell;
    changed = true;
    return { ...cell, focus };
  };
  const clips = spec.clips.map((clip): Clip => {
    if (clip.kind === "photo") {
      const cell = fill(clip.cell);
      return cell === clip.cell ? clip : { ...clip, cell };
    }
    if (clip.kind === "collage") {
      const cells = clip.cells.map(fill);
      return cells.every((c, i) => c === clip.cells[i]) ? clip : { ...clip, cells };
    }
    return clip;
  });
  return changed ? withClips(spec, clips) : spec;
}

