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
// v5 stays open until Stage 3's first release: contract changes before that do not bump the version. Added within it since:
// 3e.2: `AvatarSummary.usage` (K16) with `videos.quarantineRecords` and `photos.rebuildRejected`; `FileState` `unchecked` (K15);
// `VideoSummary.title` (K12), `.music.trackId` (K13) and `.firstClip`; `videos.get`; main's `videos.revealFolder` (K17).
// 3c: `music.status`, `.refresh`, `.recoverQuotaLog`, `.list` and `.peaks`, the `music.changed` event, the error codes MUSIC_KEY_MISSING, MUSIC_KEY_REJECTED, MUSIC_QUOTA_EXHAUSTED and
// MUSIC_UNAVAILABLE with `EngineError.musicReason`; `Settings.musicKey` (the key's presence, never the key).
// 3d: `montages.textPreview` (TEXT_PREVIEW_SUPERSEDED), `TEXT_INVALID`'s `captionIssue` and the montage issue `caption-invalid`.
// 3e.3: `export.check` and main's `settings.setExportPath`; the export folder's reasons `overlaps-work-folder` and `invalid-marker-with-records`.
// 3f: own media: `media.list`, `.delete`, `.cancelImport`, main's `media.pickImport`, the `media.changed` event, the `import` job kind, MEDIA_UNSUPPORTED with
// `EngineError.mediaReason`, own sources in a montage spec (`source: "own"`), and the issue codes `media-unavailable` and `video-too-short`.
// The notice `engine-internal-error`.
// Review of the whole of Stage 3 (additive): `EngineError.photoReason` on PHOTO_UNAVAILABLE (why a photo was refused: in-video, held-by-render, index-stale,
// log-needs-repair); `montages.list`'s `notListedTotal` (draft files not read, absent when 0).
// Removed within it (owner decision 2026-10-05, personal-use app; no bump, for the same reason): the `confirmedAiPersona` field of
// `avatars.importAvatar` and the error code AGE_CHECK_FAILED (with its «already refused» detail). The parity golden never held either.
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
