import type { Cell, Clip, Focus, MontageDraft } from "../../shared/engine/montage";
import { resolveFocus } from "../../shared/montage/crop";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import { LibraryError } from "../library/errors";
import type { Library } from "../library/library";
import type { PhotoSidecar } from "../library/schemas";
import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import { readFocusCache, rememberFocus, type FocusCacheEntry } from "./focusCache";
import { focusFromFace } from "./focusPoint";

// S8: focus is resolved when a photo is PLACED, not when the video is rendered,
// so the preview shows the crop the render will use (plan, "Focus").
//
//   focusFor(avatarId, photoId)  -> { focus, resolved }: the point to centre the crop on,
//                                   and whether the photo's pixels were actually judged.
//   fillMissingFocus(spec)       -> a headless spec (Stage 4's autopilot) with every
//                                   null focus filled, at render time, plus the cells
//                                   that could not be judged.
//
// `resolved` is the contract 3d relies on. `true`: YuNet looked at this photo and
// found a face (focus = its centre) or confirmed there is none (focus = the
// (0.5, 0.38) fallback, and that IS the right answer). `false`: nothing was judged —
// no gate, a broken gate, a timeout, an unreadable file — and `focus` is the
// fallback only so the caller has a point to show. A caller stores `resolved`
// focuses and stores `null` for the rest (legal in a draft; the preview's
// `resolveFocus(null)` shows the same point), so a later render tries again instead of
// freezing a stand-in into the montage for good.
//
// LOCAL ONLY and never paid: the face worker's detect request (YuNet on a
// normalised copy, no embedding) and files in the library. It cannot fail a caller
// for want of a face or of a detector. What it does refuse is a caller's mistake (a
// photo the avatar does not have) and the caller's own cancellation.
//
// Bounds. One `focusFor` computation — the cache read, the photo read, the queue
// for the face lane and the detection — lives under ONE bound (`detectTimeoutMs`),
// and every wait on disk or on the gate is raced against it, so a hung volume or a
// gate that ignores its signal cannot leave a caller (or the per-photo memo) pending.
// A detection is not started with less than `minStartMs(bound)` left: the worker gate
// would terminate it mid-computation, and a respawn costs more than it saves. Saving
// the cache is NOT awaited (an answer never waits for a disk), only ordered and logged;
// `flush()` awaits the saves in flight. A whole `fillMissingFocus` has `fillBudgetMs`:
// each cell races that budget, so a cell still working when it runs out takes the
// fallback at once, and the shared computation carries on for whoever else waits on it.
//
// What is cached, per photo id, in memory and in `avatars/<id>/focus.json`
// (focusCache.ts): answers about the pixels (`resolved`). Never a stand-in for a failure.

/** One `focusFor` computation, queueing behind the run's face checks included; the gate kills the worker when it fires. */
export const FOCUS_DETECT_TIMEOUT_MS = 20_000;
/** One `fillMissingFocus`; a cell reached (or still running) after it is spent takes the fallback. */
export const FOCUS_FILL_BUDGET_MS = 60_000;
/** Below this much of a bound, no new work is started under it (halved for a bound shorter than 2 s, so tests can use small ones). */
const MIN_START_MS = 1_000;
const minStartMs = (boundMs: number): number => Math.min(MIN_START_MS, boundMs / 2);

export type FocusFaceGate = Pick<WorkerFaceGate, "detect" | "isBroken">;
export type FocusLibrary = Pick<Library, "getPhoto" | "photosByAvatar" | "readPhotoVerified" | "focusCachePath">;

/** The persistence seam: the real one is focusCache.ts; tests pass one that hangs. */
export interface FocusCacheStore {
  read(path: string): Promise<ReadonlyMap<string, FocusCacheEntry>>;
  remember(path: string, photoId: string, entry: FocusCacheEntry, isLive: (photoId: string) => boolean): Promise<void>;
}

export interface FocusDeps {
  library: FocusLibrary;
  /** The face worker gate, or null when the face models did not load (`faceGateLoadError`): everything then falls back, unresolved. */
  faceGate: FocusFaceGate | null;
  /** `FOCUS_DETECT_TIMEOUT_MS` unless a test overrides it. */
  detectTimeoutMs?: number;
  /** `FOCUS_FILL_BUDGET_MS` unless a test overrides it. */
  fillBudgetMs?: number;
  /** Where answers are read and saved; focusCache.ts unless a test overrides it. */
  cache?: FocusCacheStore;
}

export interface FocusResult {
  focus: Focus;
  /** True when the photo's pixels were judged (a face, or a confirmed no-face); false when `focus` is only the stand-in fallback. */
  resolved: boolean;
}

/** A scene-photo cell of a filled spec whose focus is the stand-in fallback because its photo could not be judged. */
export interface UnresolvedCell {
  clipId: string;
  /** 0 for a photo clip, the position in `cells` for a collage. */
  cellIndex: number;
}

export interface FilledSpec {
  spec: MontageDraft;
  /**
   * The scene-photo cells left with the stand-in point (for a log line, and so a caller can decide
   * to retry). Cells with no photo, own-media cells and video clips are not listed: there is nothing
   * in the library to judge for them, so the fallback is all they can have.
   */
  unresolved: UnresolvedCell[];
}

export interface FocusResolver {
  /**
   * The focus for a scene photo of `avatarId`. Rejects with `LibraryError`
   * `photo-not-found` for a photo the avatar does not have, and with the
   * signal's reason when `signal` aborts (the shared computation itself carries on
   * for any other caller waiting on it).
   */
  focusFor(avatarId: string, photoId: string, signal?: AbortSignal): Promise<FocusResult>;
  /**
   * `spec` with every null focus filled (a scene photo's from `focusFor`, the fallback for the rest),
   * and the scene-photo cells that could not be judged. A focus that is already set is returned
   * untouched. `spec` itself is not modified.
   */
  fillMissingFocus(spec: MontageDraft, signal?: AbortSignal, options?: { budgetMs?: number }): Promise<FilledSpec>;
  /** Resolves when every cache save started so far has settled (successfully or not; failures are logged, not thrown). For shutdown and tests. */
  flush(): Promise<void>;
}

interface Computed extends FocusResult {
  /** Only a resolved answer that was also saved (or is being) is remembered in memory. */
  cacheable: boolean;
}

const fallback = (): Focus => resolveFocus(null);
const unresolved = (): Computed => ({ focus: fallback(), resolved: false, cacheable: false });

const realCache: FocusCacheStore = { read: readFocusCache, remember: rememberFocus };

export function createFocusResolver(deps: FocusDeps): FocusResolver {
  const { library, faceGate } = deps;
  const cache = deps.cache ?? realCache;
  const detectTimeoutMs = deps.detectTimeoutMs ?? FOCUS_DETECT_TIMEOUT_MS;
  const defaultFillBudgetMs = deps.fillBudgetMs ?? FOCUS_FILL_BUDGET_MS;
  /** In-memory answers (and computations still running, so concurrent callers share one), keyed by photo id and valid only for the sha256 they were made for. */
  const memo = new Map<string, { sha256: string; promise: Promise<FocusResult> }>();
  const saves = new Set<Promise<void>>();

  function save(avatarId: string, photo: PhotoSidecar, focus: Focus | null): void {
    const isLive = (id: string): boolean => {
      const current = library.getPhoto(id);
      return current !== undefined && current.avatarId === avatarId && (id !== photo.id || current.sha256 === photo.sha256);
    };
    const pending = cache
      .remember(library.focusCachePath(avatarId), photo.id, { sha256: photo.sha256, focus }, isLive)
      .catch((error: unknown) => {
        // Only the persistence failed (the folder is read-only, the avatar is gone): the answer itself is good.
        console.warn(`studio engine: could not save the focus of photo ${photo.id} (${error instanceof Error ? error.message : "unknown error"})`);
      })
      .finally(() => saves.delete(pending));
    saves.add(pending);
  }

  async function compute(avatarId: string, photo: PhotoSidecar): Promise<Computed> {
    const bound = timeoutSignal(detectTimeoutMs);
    const startedAt = performance.now();
    try {
      const cached = (await untilAborted(cache.read(library.focusCachePath(avatarId)), bound.signal)).get(photo.id);
      if (cached !== undefined && cached.sha256 === photo.sha256) return { focus: resolveFocus(cached.focus), resolved: true, cacheable: true };

      if (faceGate === null || faceGate.isBroken()) return unresolved();
      const bytes = await untilAborted(library.readPhotoVerified(photo.id), bound.signal);
      if (detectTimeoutMs - (performance.now() - startedAt) < minStartMs(detectTimeoutMs)) return unresolved();

      const detection = await untilAborted(faceGate.detect(bytes, bound.signal), bound.signal);
      const focus = detection.face === null ? null : focusFromFace(detection.face, detection);
      const answer = { focus: resolveFocus(focus), resolved: true };
      // The library's own record of the size is the cross-check: a detection made on an image of another size is not this photo's answer to keep.
      if (detection.width !== photo.width || detection.height !== photo.height) return { ...answer, cacheable: false };
      save(avatarId, photo, focus);
      return { ...answer, cacheable: true };
    } catch {
      // A dead or wedged worker, a timeout, a volume that hangs, a file that is gone or fails its sidecar, an image the decoder cannot read: all "nothing was judged", never an error for the caller.
      return unresolved();
    } finally {
      bound.clear();
    }
  }

  async function focusFor(avatarId: string, photoId: string, signal?: AbortSignal): Promise<FocusResult> {
    signal?.throwIfAborted();
    const photo = library.getPhoto(photoId);
    if (photo === undefined || photo.avatarId !== avatarId) throw new LibraryError("photo-not-found", `avatar ${avatarId} has no photo ${photoId}`);

    let entry = memo.get(photoId);
    if (entry === undefined || entry.sha256 !== photo.sha256) {
      const started: { sha256: string; promise: Promise<FocusResult> } = {
        sha256: photo.sha256,
        promise: compute(avatarId, photo).then(
          ({ focus, resolved, cacheable }) => {
            if (!cacheable && memo.get(photoId) === started) memo.delete(photoId);
            return { focus, resolved };
          },
          (error: unknown) => {
            if (memo.get(photoId) === started) memo.delete(photoId);
            throw error;
          },
        ),
      };
      memo.set(photoId, started);
      entry = started;
    }
    return signal === undefined ? entry.promise : untilAborted(entry.promise, signal);
  }

  async function fillMissingFocus(spec: MontageDraft, signal?: AbortSignal, options: { budgetMs?: number } = {}): Promise<FilledSpec> {
    signal?.throwIfAborted();
    // A caller with less time than the resolver's own budget (a command with a deadline) can only shorten it.
    const fillBudgetMs = Math.min(defaultFillBudgetMs, options.budgetMs ?? Number.POSITIVE_INFINITY);
    const budget = timeoutSignal(fillBudgetMs);
    const startedAt = performance.now();
    const left: UnresolvedCell[] = [];

    /** A scene photo's result, or null when the budget is (nearly) spent or runs out while it works — the computation itself is not cancelled. */
    async function withinBudget(avatarId: string, photoId: string): Promise<FocusResult | null> {
      if (fillBudgetMs - (performance.now() - startedAt) < minStartMs(fillBudgetMs)) return null;
      try {
        return await untilAborted(focusFor(avatarId, photoId, signal), budget.signal);
      } catch (error) {
        if (budget.signal.aborted && error === budget.signal.reason && signal?.aborted !== true) return null;
        throw error;
      }
    }

    async function fillCell(clipId: string, cellIndex: number, cell: Cell): Promise<Cell> {
      if (cell.focus !== null) return cell;
      signal?.throwIfAborted();
      const photo = cell.photo;
      if (photo?.source !== "scene") return { ...cell, focus: fallback() };
      const result = await withinBudget(spec.avatarId, photo.photoId);
      if (result === null || !result.resolved) left.push({ clipId, cellIndex });
      return { ...cell, focus: result === null ? fallback() : result.focus };
    }

    async function fillClip(clip: Clip): Promise<Clip> {
      switch (clip.kind) {
        case "photo":
          return { ...clip, cell: await fillCell(clip.clipId, 0, clip.cell) };
        case "collage": {
          const cells: Cell[] = [];
          for (const [index, cell] of clip.cells.entries()) cells.push(await fillCell(clip.clipId, index, cell));
          return { ...clip, cells };
        }
        case "video":
          return clip.focus === null ? { ...clip, focus: fallback() } : clip;
      }
    }

    try {
      const clips: Clip[] = [];
      for (const clip of spec.clips) clips.push(await fillClip(clip));
      return { spec: { ...spec, clips }, unresolved: left };
    } finally {
      budget.clear();
    }
  }

  async function flush(): Promise<void> {
    while (saves.size > 0) await Promise.allSettled([...saves]);
  }

  return { focusFor, fillMissingFocus, flush };
}
