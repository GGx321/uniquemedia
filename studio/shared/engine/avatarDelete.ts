import { z } from "zod";
import { Count, Id } from "./primitives";

// «Удалить аватар» (owner request 2026-10-05): the avatar, all its photos, candidates, master, drafts and finished videos go to the
// system Trash (macOS Trash, Windows Recycle Bin), so the owner can restore them from there. The renderer names an avatar and nothing
// else: it never supplies a path. The engine resolves what goes, main moves it, and the answer carries counts only.

/**
 * `avatars.deletePreview`'s answer, for the confirmation: what would go with the avatar.
 * - `photos`: its gallery photos (the run photos `photos.list` shows).
 * - `candidates`: its stored photos that are neither a gallery photo nor the master (the unpicked candidates of a draft).
 * - `drafts`: its montage drafts (they live in the avatar's folder and go with it).
 * - `videos`: its video records, whatever state their files are in.
 * - `videoFilesFound`: how many of those records' files are in the current «Готовые видео» folder now and would go to the Trash too;
 *   the rest (moved, changed or unreachable files) stay where they are.
 */
export const AvatarDeletePreview = z
  .strictObject({
    avatarId: Id,
    photos: Count,
    candidates: Count,
    drafts: Count,
    videos: Count,
    videoFilesFound: Count,
  })
  .refine((p) => p.videoFilesFound <= p.videos, { message: "a record names one file, so there cannot be more files than records", path: ["videoFilesFound"] });
export type AvatarDeletePreview = z.infer<typeof AvatarDeletePreview>;

/**
 * `avatars.delete`'s answer, once the avatar's folder is in the Trash: how many of its video files went there too, and how many were
 * found but could not be moved (they stay as plain files in «Готовые видео»; the owner is told). The avatar itself is gone either way.
 */
export const AvatarDeleteResult = z.strictObject({
  avatarId: Id,
  videoFilesTrashed: Count,
  videoFilesKept: Count,
});
export type AvatarDeleteResult = z.infer<typeof AvatarDeleteResult>;
