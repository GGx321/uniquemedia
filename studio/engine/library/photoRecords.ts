import { PhotoSummary, type PhotoQaSummary } from "../../shared/engine";
import type { PhotoQa, PhotoSidecar } from "./schemas";

// T8b (the Photos screen): mapping the library's own photo sidecars into the
// contract's PhotoSummary, mirroring avatars/records.ts's own mapping for
// avatars. Only a photo made by a photo run belongs in a gallery: a
// candidate portrait (avatars/candidateJob.ts's buildMeta) or an imported
// master (library.ts's createImportedAvatar) never carries a scene category,
// so those are excluded without being reported as a problem — they are
// simply not gallery photos, not broken records. A generated photo that DOES
// carry a category but still fails to fit the contract (an unknown
// category, or an attemptId with no readable runId) is a genuine "bad
// sidecar": `photoSummaryFrom` returns null for both cases alike, and
// `looksLikeRunPhoto` is how the caller (engine.ts's #photosFor) tells them
// apart to decide whether it is worth logging.

/** Halfway between the two sizes the app has ever requested (1K ~1024px, 2K ~2048px on the long side). Only used for a sidecar that predates the `resolution` field, so it never needs to be exact past those two sizes. */
const RESOLUTION_MIGRATION_THRESHOLD = 1536;

/**
 * `PhotoSidecar.resolution` (additive: runJob.ts's photoMeta now stores the
 * run's own requested resolution directly). A sidecar written before this
 * field existed has none — read here as a one-time migration: derived from
 * the stored pixel size, since the run that made it did not record which
 * resolution it asked for.
 */
export function resolutionOf(sidecar: Pick<PhotoSidecar, "resolution" | "width" | "height">): "1k" | "2k" {
  if (sidecar.resolution !== undefined) return sidecar.resolution;
  return Math.max(sidecar.width, sidecar.height) >= RESOLUTION_MIGRATION_THRESHOLD ? "2k" : "1k";
}

/** The gallery badge fields worth showing from a photo's own QA verdicts; undefined when neither applies, so `PhotoSummary.qa` can stay unset instead of an always-present empty object. */
function qaSummaryOf(qa: PhotoQa): PhotoQaSummary | undefined {
  const summary: PhotoQaSummary = {};
  if (qa.faceCos !== undefined) summary.faceCos = qa.faceCos;
  if (qa.age !== undefined) summary.age = qa.age;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** Whether `sidecar` looks like it was made by a photo run (a generated frame with a scene category): the only case where a failed `photoSummaryFrom` is a real problem worth logging, rather than simply "not a gallery photo". */
export function looksLikeRunPhoto(sidecar: PhotoSidecar): boolean {
  return sidecar.source.kind === "generated" && sidecar.source.category !== undefined;
}

/**
 * `photos.list`'s mapping from a stored sidecar to the contract's shape.
 * `runId` is not itself stored on the sidecar: it is the prefix of the
 * photo's own `attemptId`, `${runId}:slot-N#k` (runs/plan.ts's
 * `slotAttemptIds`/`writerAttemptIds`) — the run's own attempt-id format is
 * the one place a generated run photo's run is recorded today. Null for a
 * photo that is not a run photo at all (see `looksLikeRunPhoto`), or one
 * that is but still fails this shape (an unknown category, or a runId that
 * does not fit the id pattern) — defensive; this should never happen for
 * anything this engine itself wrote.
 */
export function photoSummaryFrom(sidecar: PhotoSidecar): PhotoSummary | null {
  if (!looksLikeRunPhoto(sidecar) || sidecar.source.kind !== "generated") return null;
  const runId = sidecar.source.attemptId.split(":")[0] ?? "";
  const parsed = PhotoSummary.safeParse({
    photoId: sidecar.id,
    avatarId: sidecar.avatarId,
    runId,
    category: sidecar.source.category,
    resolution: resolutionOf(sidecar),
    createdAt: sidecar.createdAt,
    qa: qaSummaryOf(sidecar.qa),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Newest first (createdAt descending, ties broken by photoId descending so
 * the order is deterministic across calls), capped at `limit`. Takes the
 * limit as a parameter rather than reading `MAX_LISTED_PHOTOS` itself, so
 * the boundary is easy to pin in isolation; engine.ts's #photosFor supplies
 * the contract's own constant.
 */
export function finalizePhotoList(photos: readonly PhotoSummary[], limit: number): PhotoSummary[] {
  return [...photos]
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.photoId < b.photoId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}
