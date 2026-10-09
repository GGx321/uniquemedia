import { decodePhotoCursor, encodePhotoCursor } from "./commands";
import type { PhotoSummary } from "./state";

// S4.P2: how photos.list pages. Pure, so the engine and the mock engine run the very same rule.

/** Newest first: createdAt descending, ties broken by photoId descending, so the order is total and the same on every call. */
export function newestFirstPhotos(a: PhotoSummary, b: PhotoSummary): number {
  if (a.createdAt === b.createdAt) return a.photoId < b.photoId ? 1 : a.photoId > b.photoId ? -1 : 0;
  return a.createdAt < b.createdAt ? 1 : -1;
}

/** One page of photos.list (S4.P2). */
export type PhotoPage = { photos: PhotoSummary[]; nextCursor: string | null; remainingTotal: number };

/**
 * One page of the newest-first list: the `limit` photos that come after `cursor` (the first page when it is null).
 *
 * Why pages neither overlap nor skip while photos are added: the cursor is a KEY, the (createdAt, photoId) of the last photo
 * shown, and the order is total (`newestFirstPhotos`). A page is "everything strictly after that key", so a photo added newer
 * than the key stays in front of it and never moves a later page; one added older than the key simply turns up on a later
 * page. An offset would shift by one for every photo added in front. A cursor needs no live photo behind it: one from a photo
 * deleted since still names a position, and the page resumes right after it.
 *
 * `remainingTotal` is every listable photo beyond the page (not only the next page); `nextCursor` is null exactly when it is 0.
 * A cursor that does not decode is a caller bug (the request schema refuses it first): it throws rather than answering page one.
 */
export function pagePhotoList(photos: readonly PhotoSummary[], limit: number, cursor: string | null): PhotoPage {
  const after = cursor === null ? null : decodePhotoCursor(cursor);
  if (cursor !== null && after === null) throw new Error("pagePhotoList: the cursor does not decode");
  const sorted = [...photos].sort(newestFirstPhotos);
  const candidates = after === null ? sorted : sorted.filter((p) => p.createdAt < after.createdAt || (p.createdAt === after.createdAt && p.photoId < after.photoId));
  const page = candidates.slice(0, limit);
  const remainingTotal = candidates.length - page.length;
  const last = page.at(-1);
  return { photos: page, nextCursor: remainingTotal > 0 && last !== undefined ? encodePhotoCursor(last.createdAt, last.photoId) : null, remainingTotal };
}
