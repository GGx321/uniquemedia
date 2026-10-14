import { lstat } from "node:fs/promises";
import type { CommandPayload, MediaSummary } from "../../shared/engine";
import { EngineFailure } from "../engineFailure";
import { pickedIdentityOf } from "../media/identity";
import type { MediaImportCall, MediaImportResult } from "../media/imports";
import { hashFile } from "../videos/fileBytes";
import type { ClipRecord } from "./schemas";
import { clipFilePath } from "./store";

// Stage 5, 5b.2, S5.WA2 (plan s5b2 §5.1, I5.59): `media.importClip`, a ready clip becoming the montage editor's own video as its own copy, one per clip.
//
// The clip is read, never written (I5.54): the media service stages its own copy of the provider's file and the video importer's ordinary encode makes the mezzanine from it (30 fps CFR, no
// audio, inside 1080 x 1920). What this module adds is the clip's side of it:
//   - the CLIP LOCK: the whole decision runs inside the clip's lock (`ClipRecords.withClipLock`), and the clip joins the busy set until the import job has ended, so a `clips.delete` or a
//     `clips.export` meanwhile answers `job-running` (on Windows an open file cannot be removed: EBUSY), and so does a second import;
//   - the REFUSALS, in the contract's order: LIBRARY_UNAVAILABLE, NOT_FOUND (the clip, or an avatar being deleted), VALIDATION `not-ready`, [a live copy answers its media id], IN_FLIGHT
//     `job-running`, VALIDATION `file-damaged` (the sha256 check, INSIDE the lock), then the importer's own rules (a full disk is MEDIA_UNSUPPORTED `no-space`; every other outcome is INTERNAL);
//   - the LAST LOOK before the record (`stillWanted`): an avatar delete that became pending, an avatar or a clip that is gone, cancels the import, which leaves no record and no file.

/** What the import needs of the media service. */
export interface ClipMediaPort {
  import(call: MediaImportCall, signal?: AbortSignal): Promise<MediaImportResult>;
  /** The live copy of a clip: the media record whose `origin.clipId` is this clip. */
  copyOfClip(avatarId: string, clipId: string): Promise<MediaSummary | undefined>;
}

export interface ClipImportsDeps {
  readonly media: ClipMediaPort;
  /** LIBRARY_UNAVAILABLE with no library, NOT_FOUND for an avatar that is not in it or is being deleted and for a clip it does not have (`ClipRecords.locate`). */
  readonly locate: (avatarId: string, clipId: string) => Promise<{ clipsDir: string; record: ClipRecord }>;
  readonly withClipLock: <T>(clipId: string, work: () => Promise<T>) => Promise<T>;
  readonly host: { busy: (clipId: string) => boolean; begin: (clipId: string) => () => void; stop: AbortSignal };
  readonly log: (line: string) => void;
}

/** The copy's display name, «Клип <YYYY-MM-DD> <HH-MM>.mp4», from the clip's creation time in the owner's local time. */
export function copyNameOf(createdAt: string): string {
  const at = new Date(createdAt);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `Клип ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}.mp4`;
}

export class ClipImports {
  readonly #deps: ClipImportsDeps;
  /** The clip imports running, by avatar: an avatar delete waits for them (`importingFor`). */
  readonly #running = new Map<string, number>();

  constructor(deps: ClipImportsDeps) {
    this.#deps = deps;
  }

  /** An import of one of this avatar's clips runs: its delete must wait, because the import has no avatar of its own in the job registry. */
  importingFor(avatarId: string): boolean {
    return (this.#running.get(avatarId) ?? 0) > 0;
  }

  async start(payload: CommandPayload<"media.importClip">): Promise<{ mediaId: string } | { jobId: string }> {
    const { avatarId, clipId } = payload;
    const deps = this.#deps;
    return deps.withClipLock(clipId, async () => {
      const { clipsDir, record } = await deps.locate(avatarId, clipId);
      const { outcome } = record;
      if (outcome.status !== "ready") throw new EngineFailure({ code: "VALIDATION", clipReason: "not-ready", detail: `clip ${clipId} is not ready, so it has no file to prepare` });
      // One copy per clip: a live copy is answered at once, whoever else works on the clip.
      const live = await deps.media.copyOfClip(avatarId, clipId);
      if (live !== undefined) return { mediaId: live.mediaId };
      if (deps.host.busy(clipId)) throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });

      // From here the clip is held until the import job has ended, and every way out below gives it back.
      let held = true;
      const release = deps.host.begin(clipId);
      this.#running.set(avatarId, (this.#running.get(avatarId) ?? 0) + 1);
      const end = (): void => {
        if (!held) return;
        held = false;
        const left = (this.#running.get(avatarId) ?? 1) - 1;
        if (left <= 0) this.#running.delete(avatarId);
        else this.#running.set(avatarId, left);
        release();
      };
      try {
        const file = clipFilePath(clipsDir, clipId);
        // The sha256 check, inside the lock: the file must be the one the record names (a file in Studio's folder may have been touched by something else).
        // The identity is taken BEFORE the hash: the importer opens the file and compares its handle with it, so a file swapped after the hash is refused there (no gap between the check and the use).
        const identity = await lstat(file, { bigint: true }).then(pickedIdentityOf, () => null);
        const sha256 = identity === null ? null : await hashFile(file).catch(() => null);
        if (sha256 === null || sha256 !== outcome.sha256) {
          // A file that cannot be read may be gone because the avatar's folder went to the Trash meanwhile: that is NOT_FOUND (this throws it), not a damaged file.
          if (sha256 === null) await deps.locate(avatarId, clipId);
          throw new EngineFailure({ code: "VALIDATION", clipReason: "file-damaged", detail: sha256 === null ? `the file of clip ${clipId} cannot be read` : `the file of clip ${clipId} is not the one its record names` });
        }
        if (identity === null) throw new EngineFailure({ code: "VALIDATION", clipReason: "file-damaged", detail: `the file of clip ${clipId} cannot be read` });

        const result = await deps.media.import(
          {
            pick: "video",
            path: file,
            name: copyNameOf(record.createdAt),
            expected: identity,
            origin: { kind: "clip", avatarId, clipId, photoId: record.sourcePhotoId },
            stillWanted: () => this.#wanted(avatarId, clipId),
            onEnd: end,
          },
          deps.host.stop,
        );
        if (!result.ok) {
          // The contract: only a full disk keeps its reason (there is no DISK_FULL code); every other outcome of the importer is one INTERNAL.
          if (result.reason === "no-space") throw new EngineFailure({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space", detail: result.detail });
          throw new EngineFailure({ code: "INTERNAL", detail: result.detail });
        }
        return { jobId: result.jobId };
      } catch (error) {
        end();
        throw error;
      }
    });
  }

  /** Whether the copy that is about to be recorded is still wanted: the avatar is in the library and not being deleted, and the clip is still there and ready. Never throws. */
  async #wanted(avatarId: string, clipId: string): Promise<boolean> {
    try {
      const { record } = await this.#deps.locate(avatarId, clipId);
      return record.outcome.status === "ready";
    } catch {
      return false;
    }
  }
}
