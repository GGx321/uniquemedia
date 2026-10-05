import { z } from "zod";
import { Count, Id } from "./primitives";
import { isSafeName } from "./video";

// «Удалить аватар» (owner request 2026-10-05): the avatar, all its photos, candidates, master, drafts and finished videos go to the
// system Trash (macOS Trash, Windows Recycle Bin), so the owner can restore them from there. The renderer names an avatar and nothing
// else: it never supplies a path. The engine resolves what goes, main moves it, and the answer carries counts only.

/**
 * `avatars.deletePreview`'s answer, for the confirmation: what would go with the avatar.
 * - `photos`: its gallery photos (the run photos `photos.list` shows).
 * - `candidates`: its stored photos that are neither a gallery photo nor the master (the unpicked candidates of a draft).
 * - `drafts`: its montage drafts (they live in the avatar's folder and go with it).
 * - `videos`: its video records, whatever state their files are in.
 * - `videoFilesFound`: how many of those records' files are in the current «Готовые видео» folder now, proved to be Studio's, and would go to the Trash too.
 * - `videoFilesUnchecked`: how many could not be proved in time (the hash budget or the time ran out): never moved on a guess, they stay where they are.
 *   The rest (`videos` minus both) are not in the folder now (moved, changed or in another folder) and stay where they are.
 */
export const AvatarDeletePreview = z
  .strictObject({
    avatarId: Id,
    photos: Count,
    candidates: Count,
    drafts: Count,
    videos: Count,
    videoFilesFound: Count,
    videoFilesUnchecked: Count,
  })
  .refine((p) => p.videoFilesFound + p.videoFilesUnchecked <= p.videos, { message: "a record names one file, so there cannot be more files than records", path: ["videoFilesFound"] });
export type AvatarDeletePreview = z.infer<typeof AvatarDeletePreview>;

/**
 * `avatars.delete`'s answer, once the avatar's folder is in the Trash: how many of its video files went there too, how many were found and could not be moved
 * (`videoFilesKept`: the Trash refused, a volume with no Trash, or main's own check failed), and how many the engine could not prove in time
 * (`videoFilesUnchecked`); both stay as plain files in the export folder and the owner is told. `videoFolder` is the avatar's folder NAME inside the export
 * folder (never a path), when a file was found there. The avatar itself is gone either way.
 */
export const AvatarDeleteResult = z.strictObject({
  avatarId: Id,
  videoFilesTrashed: Count,
  videoFilesKept: Count,
  videoFilesUnchecked: Count,
  videoFolder: z.string().max(255).refine(isSafeName, "must be a folder name").nullable(),
});
export type AvatarDeleteResult = z.infer<typeof AvatarDeleteResult>;
