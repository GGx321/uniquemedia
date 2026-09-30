import { z } from "zod";

/**
 * Wire protocol version carried by every message as `v`.
 *
 * - 2 (2026-09-29): 2K removed: `RunRequest` and `PhotoSummary` no longer carry a `resolution`.
 * - 3 (2026-09-29): `job.progress`, `job.failed` and `job.cancelled` carry the job's `kind`, `avatarId` and (a run) `runId`.
 * - 4 (2026-09-29): `RunSummary.capExhausted`; a run whose cap cannot fund one more attempt is no longer `resumable`.
 * - 5 (2026-09-29): Stage 3's render contract: the `render` job kind (queued jobs, frames as progress) with its identity in the job events;
 *   `videos.*`, `photos.setRejected`, `montages.*` (create, get, list, save, delete, focus), the `video.changed`, `montage.changed` and `export.status` events,
 *   `MontageSpec`/`MontageDraft`, a draft's nullable name and the engine-only montage issue codes (caption-invalid, media-unavailable, sticker-unavailable, track-unavailable, track-too-short);
 *   `Settings.exportPath` and `.renderConcurrency`; `Snapshot.exportStatus`; `PhotoSummary.used`/`usedIn`/`rejected`/`reserved`/`eligible`; `AvatarSummary.videoCount`/`eligibleUnusedCount`;
 *   `EngineError.issues`, `.exportReason` and `.captionIssue`; the error codes MONTAGE_INVALID, PHOTO_UNAVAILABLE, EXPORT_UNAVAILABLE, RENDER_FAILED, RENDER_VERIFY_FAILED, RENDER_QUEUE_FULL (`detail` names the limit), LIBRARY_TOO_NEW, TEXT_INVALID.
 */
// v5 stays open until Stage 3's first release: contract changes before that do not bump the version.
export const PROTOCOL_VERSION = 5;
export const ProtocolVersion = z.literal(PROTOCOL_VERSION);

/** An event's position in the engine's event stream; starts at 1 and only grows. */
export const Seq = z.number().int().positive();

/** Turns a literal list into the non-empty tuple Zod's unions and enums expect. */
export function nonEmpty<T>(items: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error("expected at least one item");
  return [first, ...rest];
}
