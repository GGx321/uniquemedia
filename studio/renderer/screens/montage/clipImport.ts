import type { ClipSummary, EngineError, MediaImportClipResult, MediaSummary, MontageDraft } from "../../../shared/engine";
import type { OwnVideoFacts } from "./clipOps";

// 5b.2 part A (S5.WA4; plan §5.1.1): a clip reaches the montage as its own media copy. A click on a clip (or a drop on «Кадры») asks `media.importClip`:
// a live copy answers its media id and is placed at once, by the own video's placement (from its start, up to 2 s; `EditorScreen.placeOwnVideo`); otherwise
// the answer names an import job, and the copy is placed where it was asked for when the job's `job.done` brings its record. The engine starts the job as it
// answers, so the job may end before the answer reaches the window: the copies of clip imports that ended are kept a while, and the answer finds its own.
// What the editor waits for is its own; the tile's «Готовим для монтажа…» is read from the job list instead (it outlives a window reload).

/** Where a clip's copy goes once it is made: the end of the montage (`null`), or the boundary on «Кадры» it was dropped at. */
export interface ClipPlacement {
  readonly clipId: string;
  readonly boundary: number | null;
}

/** What `media.importClip` answered: place the live copy now, wait for the job, or a refusal to tell (57c). */
export type ImportAnswer = { readonly kind: "place"; readonly mediaId: string } | { readonly kind: "wait"; readonly jobId: string } | { readonly kind: "refused"; readonly error: EngineError };

export function importAnswerOf(reply: { ok: true; result: MediaImportClipResult } | { ok: false; error: EngineError }): ImportAnswer {
  if (!reply.ok) return { kind: "refused", error: reply.error };
  return "mediaId" in reply.result ? { kind: "place", mediaId: reply.result.mediaId } : { kind: "wait", jobId: reply.result.jobId };
}

/**
 * A live copy's facts from the clip it copies, for the placement at once: the clip's length (the copy is the same picture at 30 fps; the placement takes up to
 * 2 s of it) and its frame, which is the copy's `origin` exactly.
 */
export function readyCopyFacts(clip: Pick<Extract<ClipSummary, { status: "ready" }>, "clipId" | "avatarId" | "photoId" | "durationMs">, mediaId: string): OwnVideoFacts {
  return { mediaId, durationMs: clip.durationMs, origin: { kind: "clip", avatarId: clip.avatarId, clipId: clip.clipId, photoId: clip.photoId } };
}

/** A made copy's facts from its record (`job.done`'s `result.media`). */
export function copyFactsOf(media: MediaSummary): OwnVideoFacts {
  return { mediaId: media.mediaId, durationMs: media.durationMs ?? 0, ...(media.origin === undefined ? {} : { origin: media.origin }) };
}

/** The boundary a waited copy goes in at, held to the montage as it is when the copy is ready (kadrs may have gone meanwhile); undefined is the end. */
export function placeBoundary(spec: MontageDraft, boundary: number | null): number | undefined {
  if (boundary === null) return undefined;
  return Math.max(0, Math.min(boundary, spec.clips.length));
}

/** The clip import jobs that ended before an answer named them, remembered at most (the oldest forgotten first). */
export const MAX_EARLY_ENDS = 50;

type Early = { readonly kind: "done"; readonly media: MediaSummary } | { readonly kind: "failed"; readonly error: EngineError } | { readonly kind: "cancelled" };

/** The editor's copies on their way: each job its answer named, and where its copy goes. */
export class ClipPlacements {
  readonly #waiting = new Map<string, ClipPlacement>();
  readonly #early = new Map<string, Early>();

  /** Where copies are on their way, in the order they were asked for: the drop marks on «Кадры» (57a `#drop`). */
  get pending(): readonly (ClipPlacement & { readonly jobId: string })[] {
    return [...this.#waiting].map(([jobId, placement]) => ({ jobId, ...placement }));
  }

  /** The answer named job `jobId`: its copy when the job already ended done (placed at once), its end when it failed or was cancelled, else it waits. */
  wait(jobId: string, placement: ClipPlacement): { kind: "waiting" } | { kind: "place"; media: MediaSummary } | { kind: "failed"; error: EngineError } | { kind: "cancelled" } {
    const early = this.#early.get(jobId);
    if (early !== undefined) {
      this.#early.delete(jobId);
      return early.kind === "done" ? { kind: "place", media: early.media } : early;
    }
    this.#waiting.set(jobId, placement);
    return { kind: "waiting" };
  }

  /** A clip import's `job.done`: the placement that waited for it, with its copy; null for a job no answer named yet (remembered a while). */
  done(jobId: string, media: MediaSummary): { placement: ClipPlacement; media: MediaSummary } | null {
    const placement = this.#take(jobId, { kind: "done", media });
    return placement === null ? null : { placement, media };
  }

  /** A clip import's `job.failed`: the placement that waited for it (nothing is placed), or null. */
  failed(jobId: string, error: EngineError): ClipPlacement | null {
    return this.#take(jobId, { kind: "failed", error });
  }

  /** A clip import's `job.cancelled` (the clip or its avatar went meanwhile): the placement that waited for it, or null. */
  cancelled(jobId: string): ClipPlacement | null {
    return this.#take(jobId, { kind: "cancelled" });
  }

  /** Forgets every wait and every early end (another library, another engine: their jobs never end here). */
  clear(): void {
    this.#waiting.clear();
    this.#early.clear();
  }

  #take(jobId: string, end: Early): ClipPlacement | null {
    const placement = this.#waiting.get(jobId);
    if (placement !== undefined) {
      this.#waiting.delete(jobId);
      return placement;
    }
    if (this.#early.has(jobId)) return null;
    this.#early.set(jobId, end);
    for (const old of this.#early.keys()) {
      if (this.#early.size <= MAX_EARLY_ENDS) break;
      this.#early.delete(old);
    }
    return null;
  }
}
