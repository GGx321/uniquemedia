import type { Library } from "../library";
import { looksLikeRunPhoto } from "../library/photoRecords";

// «Удалить аватар»: the counts the confirmation shows. Derived from the library's own answers, so what the dialog says is what the delete moves.

export interface AvatarDeleteCounts {
  /** Gallery photos: the run photos `photos.list` shows. */
  photos: number;
  /** Stored photos that are neither a gallery photo nor the master: the unpicked candidates of a draft. */
  candidates: number;
  /** Montage drafts in the avatar's folder. */
  drafts: number;
  /** Video records, whatever state their files are in. */
  videos: number;
}

export async function avatarDeleteCounts(library: Pick<Library, "photosByAvatar" | "getAvatar" | "montageCount" | "videoCount">, avatarId: string): Promise<AvatarDeleteCounts> {
  const masterPhotoId = library.getAvatar(avatarId)?.masterPhotoId ?? null;
  const stored = library.photosByAvatar(avatarId);
  const photos = stored.filter(looksLikeRunPhoto).length;
  const candidates = stored.filter((photo) => !looksLikeRunPhoto(photo) && photo.id !== masterPhotoId).length;
  return { photos, candidates, drafts: await library.montageCount(avatarId), videos: library.videoCount(avatarId) };
}
