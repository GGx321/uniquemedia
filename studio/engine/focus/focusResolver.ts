import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cell, Clip, Focus, MontageDraft } from "../../shared/engine/montage";
import { resolveFocus } from "../../shared/montage/crop";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import { LibraryError } from "../library/errors";
import type { Library } from "../library/library";
import { AVATARS_DIR } from "../library/layout";
import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import { FOCUS_FILE, readFocusCache, rememberFocus } from "./focusCache";
import { focusFromFace } from "./focusPoint";

// S8: focus is resolved when a photo is PLACED, not when the video is rendered,
// so the preview shows the crop the render will use (plan, "Focus").
//
//   focusFor(avatarId, photoId)  -> the point to centre the crop on, always: the
//                                   photo's face centre, or (0.5, 0.38) when it has
//                                   no face or no detector is available.
//   fillMissingFocus(spec)       -> a headless spec (Stage 4's autopilot) with every
//                                   null focus resolved, at render time.
//
// LOCAL ONLY and never paid: it uses the face worker's detect request (YuNet on
// a normalised copy; no embedding) and files in the library. It cannot fail a
// caller for want of a face or of a detector: those are the fallback. What it does
// refuse is a caller's mistake (a photo the avatar does not have) and its own
// cancellation.
//
// Bounds: one detection is bounded by `detectTimeoutMs` (the worker gate really
// terminates the worker when it fires), and a whole fill by `fillBudgetMs`, after
// which the remaining cells take the fallback.
//
// What is cached, per photo id, in memory and in `avatars/<id>/focus.json`
// (focusCache.ts): a face centre, and "no face" (both are answers about the
// pixels). What is NOT cached is the fallback that stands in for a failure — an
// unavailable or broken gate, a timeout, an undecodable or mismatching file — so
// the next call tries again.

/** One detection, queueing behind the run's face checks included; the gate kills the worker when it fires. */
export const FOCUS_DETECT_TIMEOUT_MS = 20_000;
/** One `fillMissingFocus`; a cell reached after it is spent takes the fallback. */
export const FOCUS_FILL_BUDGET_MS = 60_000;

export type FocusFaceGate = Pick<WorkerFaceGate, "detect" | "isBroken">;
export type FocusLibrary = Pick<Library, "root" | "getPhoto" | "photosByAvatar">;

export interface FocusDeps {
  library: FocusLibrary;
  /** The face worker gate, or null when the face models did not load (`faceGateLoadError`): everything then falls back. */
  faceGate: FocusFaceGate | null;
  /** `FOCUS_DETECT_TIMEOUT_MS` unless a test overrides it. */
  detectTimeoutMs?: number;
  /** `FOCUS_FILL_BUDGET_MS` unless a test overrides it. */
  fillBudgetMs?: number;
}

export interface FocusResolver {
  /**
   * The focus for a scene photo of `avatarId`. Rejects with `LibraryError`
   * `photo-not-found` for a photo the avatar does not have, and with the
   * signal's reason when `signal` aborts (the shared detection itself carries on
   * for any other caller waiting on it).
   */
  focusFor(avatarId: string, photoId: string, signal?: AbortSignal): Promise<Focus>;
  /**
   * `spec` with every null focus filled: a scene photo's from `focusFor`, and the
   * fallback for a cell with no photo, an own-media cell and a video clip (their
   * pixels are not in the library; the own-media focus arrives with slice 3f). A
   * focus that is already set is returned untouched. `spec` itself is not modified.
   */
  fillMissingFocus(spec: MontageDraft, signal?: AbortSignal): Promise<MontageDraft>;
}

interface Computed {
  focus: Focus;
  /** False for a fallback that stands in for a failure. */
  cacheable: boolean;
}

const fallback = (): Focus => resolveFocus(null);

export function createFocusResolver(deps: FocusDeps): FocusResolver {
  const { library, faceGate } = deps;
  const detectTimeoutMs = deps.detectTimeoutMs ?? FOCUS_DETECT_TIMEOUT_MS;
  /** In-memory answers (and detections still running, so concurrent callers share one), keyed by photo id and valid only for the sha256 they were made for. */
  const memo = new Map<string, { sha256: string; promise: Promise<Focus> }>();

  async function compute(avatarId: string, photo: { id: string; sha256: string; bytes: number; file: string }): Promise<Computed> {
    const avatarDir = join(library.root, AVATARS_DIR, avatarId);
    const focusPath = join(avatarDir, FOCUS_FILE);

    const cached = (await readFocusCache(focusPath)).get(photo.id);
    if (cached !== undefined && cached.sha256 === photo.sha256) return { focus: resolveFocus(cached.focus), cacheable: true };

    if (faceGate === null || faceGate.isBroken()) return { focus: fallback(), cacheable: false };

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(avatarDir, "photos", photo.file)));
    } catch {
      return { focus: fallback(), cacheable: false }; // the file is gone or unreadable: nothing to look at
    }
    // The sidecar's own check, as `loadMasterOriginal` does it: a file that rotted since the survey is not a photo to trust.
    if (bytes.length !== photo.bytes || createHash("sha256").update(bytes).digest("hex") !== photo.sha256) {
      return { focus: fallback(), cacheable: false };
    }

    const bound = timeoutSignal(detectTimeoutMs);
    let face: Focus | null;
    try {
      const detection = await faceGate.detect(bytes, bound.signal);
      face = detection.face === null ? null : focusFromFace(detection.face, detection);
    } catch {
      // A dead or wedged worker, a timeout, a file the decoder cannot read: all "no answer", never an error for the caller.
      return { focus: fallback(), cacheable: false };
    } finally {
      bound.clear();
    }

    try {
      const live = new Set(library.photosByAvatar(avatarId).map((p) => p.id));
      await rememberFocus(focusPath, photo.id, { sha256: photo.sha256, focus: face }, live);
    } catch (error) {
      // Only the persistence failed (the folder is read-only, or the avatar is gone): the answer itself is good.
      console.warn(`studio engine: could not save the focus of photo ${photo.id} (${error instanceof Error ? error.message : "unknown error"})`);
    }
    return { focus: resolveFocus(face), cacheable: true };
  }

  async function focusFor(avatarId: string, photoId: string, signal?: AbortSignal): Promise<Focus> {
    signal?.throwIfAborted();
    const photo = library.getPhoto(photoId);
    if (photo === undefined || photo.avatarId !== avatarId) throw new LibraryError("photo-not-found", `avatar ${avatarId} has no photo ${photoId}`);

    let entry = memo.get(photoId);
    if (entry === undefined || entry.sha256 !== photo.sha256) {
      const started: { sha256: string; promise: Promise<Focus> } = {
        sha256: photo.sha256,
        promise: compute(avatarId, photo).then(
          (result) => {
            if (!result.cacheable && memo.get(photoId) === started) memo.delete(photoId);
            return result.focus;
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

  async function fillMissingFocus(spec: MontageDraft, signal?: AbortSignal): Promise<MontageDraft> {
    signal?.throwIfAborted();
    const budget = timeoutSignal(deps.fillBudgetMs ?? FOCUS_FILL_BUDGET_MS);

    async function fillCell(cell: Cell): Promise<Cell> {
      if (cell.focus !== null) return cell;
      signal?.throwIfAborted();
      const photo = cell.photo;
      if (photo?.source === "scene" && !budget.signal.aborted) return { ...cell, focus: await focusFor(spec.avatarId, photo.photoId, signal) };
      return { ...cell, focus: fallback() };
    }

    async function fillClip(clip: Clip): Promise<Clip> {
      switch (clip.kind) {
        case "photo":
          return { ...clip, cell: await fillCell(clip.cell) };
        case "collage": {
          const cells: Cell[] = [];
          for (const cell of clip.cells) cells.push(await fillCell(cell));
          return { ...clip, cells };
        }
        case "video":
          return clip.focus === null ? { ...clip, focus: fallback() } : clip;
      }
    }

    try {
      const clips: Clip[] = [];
      for (const clip of spec.clips) clips.push(await fillClip(clip));
      return { ...spec, clips };
    } finally {
      budget.clear();
    }
  }

  return { focusFor, fillMissingFocus };
}
