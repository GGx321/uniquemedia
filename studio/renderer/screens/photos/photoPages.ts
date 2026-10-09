import { type CommandResult, type EngineError, newestFirstPhotos, type PhotoSummary } from "../../../shared/engine";
import type { EngineReply } from "../../engine/client";

// S4.P2: an avatar's photos past photos.list's 500 (MAX_LISTED_PHOTOS). The engine answers newest first, a page at a time, and names
// where the next page starts with a cursor the window never reads or makes: it only sends it back. «Показать ещё» appends the next
// page; a reload (a run's photo landed, `avatar.changed`) reads from page 1 again, since a new photo is newer than any cursor and so
// never turns up on a page already read. Pure, so the paging rules are tested apart from the screens that show them.

/** Every page of photos.list read so far, newest first, and where the next one would start. */
export interface PhotoPages {
  readonly photos: readonly PhotoSummary[];
  /** Photos the engine could not read (`skippedTotal`): never the photos beyond a page, which `remainingTotal` counts. */
  readonly skippedTotal: number;
  /** Where the next (older) page starts, as the engine named it; null once every listable photo is here. */
  readonly nextCursor: string | null;
  /** How many listable photos lie beyond `photos`. */
  readonly remainingTotal: number;
  /**
   * How far the owner has paged: null while the list is its first page alone; else the last photo of the last page he asked for (when
   * `nextCursor` is set, it names this photo's place). A reload reads down to it again, so photos added in front neither push a photo he
   * has on screen back behind «Показать ещё» nor bring in more than he asked for.
   */
  readonly depth: PhotoSummary | null;
}

/** One answer of photos.list. */
export type PhotoPage = CommandResult<"photos.list">;

/** photos.list for the avatar from `cursor` (null: the first page). */
export type ReadPage = (cursor: string | null) => Promise<EngineReply<"photos.list">>;

export type PagesRead = { readonly ok: true; readonly list: PhotoPages } | { readonly ok: false; readonly error: EngineError };

/** The list as its first page alone has it. */
export function firstPage(page: PhotoPage): PhotoPages {
  return { photos: page.photos, skippedTotal: page.skippedTotal, nextCursor: page.nextCursor, remainingTotal: page.remainingTotal, depth: null };
}

/**
 * `page` after `list` («Показать ещё»). Pages cut by a key never overlap, so a photo is never listed twice; a photo the list already
 * holds is left out all the same, as a tile's key and a pick are its id. The owner is now as deep as the page's last photo.
 */
export function appendPage(list: PhotoPages, page: PhotoPage): PhotoPages {
  const held = new Set(list.photos.map((p) => p.photoId));
  return {
    photos: [...list.photos, ...page.photos.filter((p) => !held.has(p.photoId))],
    skippedTotal: page.skippedTotal,
    nextCursor: page.nextCursor,
    remainingTotal: page.remainingTotal,
    depth: page.photos.at(-1) ?? list.depth ?? list.photos.at(-1) ?? null,
  };
}

/** The photos `list` brought that `before` did not hold, in order: what a «Показать ещё» added. */
export function addedPhotos(before: PhotoPages, after: PhotoPages): readonly PhotoSummary[] {
  const held = new Set(before.photos.map((p) => p.photoId));
  return after.photos.filter((p) => !held.has(p.photoId));
}

/** A photo as the engine answered it since (a mark set), in its place; the same list when it holds no such photo. */
export function replacePhoto(list: PhotoPages, photo: PhotoSummary): PhotoPages {
  if (!list.photos.some((p) => p.photoId === photo.photoId)) return list;
  return { ...list, photos: list.photos.map((p) => (p.photoId === photo.photoId ? photo : p)) };
}

/** Whether a page has come down to `photo`: its last photo is that photo or an older one (an empty page ends the reading too). */
function reaches(page: PhotoPage, photo: PhotoSummary): boolean {
  const last = page.photos.at(-1);
  return last === undefined || newestFirstPhotos(last, photo) >= 0;
}

/** Always wanted: a read no one calls off. */
const always = (): boolean => true;

/** What a read says of an engine whose next page would not move on (LOW-5): read on, it would never end. */
export const CURSOR_STUCK: EngineError = { code: "INTERNAL", detail: "photos.list named a next page that does not move on" };

/** Whether the page read from `cursor` moves on: it names another cursor than the one it was read from, or none — and has photos if it names one. */
export function advances(cursor: string, page: PhotoPage): boolean {
  return page.nextCursor !== cursor && (page.nextCursor === null || page.photos.length > 0);
}

type ChainRead = { readonly ok: true; readonly list: PhotoPages } | { readonly ok: false; readonly error: EngineError };

/**
 * Page 1, then page after page from the cursor each one names, until `enough` says of the last one read that it is, or there is no
 * next. A cursor that does not move on (or comes round again) ends it as an error. Null as soon as `isCurrent` says the reading is no
 * longer wanted: it is asked after every answer, so nothing more is sent once the screen has gone.
 */
async function readChain(read: ReadPage, enough: (page: PhotoPage) => boolean, isCurrent: () => boolean): Promise<ChainRead | null> {
  const first = await read(null);
  if (!isCurrent()) return null;
  if (!first.ok) return first;
  let list = firstPage(first.result);
  let last = first.result;
  const asked = new Set<string>();
  while (last.nextCursor !== null && !enough(last)) {
    const cursor = last.nextCursor;
    if (asked.has(cursor)) return { ok: false, error: CURSOR_STUCK };
    asked.add(cursor);
    const next = await read(cursor);
    if (!isCurrent()) return null;
    if (!next.ok) return next;
    if (!advances(cursor, next.result)) return { ok: false, error: CURSOR_STUCK };
    list = appendPage(list, next.result);
    last = next.result;
  }
  return { ok: true, list };
}

/**
 * The list read again from page 1, down to where `held` had it: page 1 alone while the owner has not paged; else page after page, each
 * from the cursor the page before it named, until one comes down to `held.depth`. Never from a cursor kept from before: a photo added
 * in front moves where every page starts, so a page read from an old cursor would leave a gap between the pages.
 *
 * The last page read usually runs on past the depth: those photos are cut off again, and «Показать ещё» resumes where it did —
 * `held.nextCursor` still names the depth's place (a cursor is a place, good whether or not its photo still is) — with them counted
 * in what remains. Only when the owner had paged to the very end (no cursor to resume from) is what turned up past it kept.
 *
 * It reads every page the owner opened, so it is for a change that may touch any of them (a mark, a render, the usage); new photos in
 * front need only `readTop`. Null once `isCurrent` says it is no longer wanted.
 */
export async function readThrough(read: ReadPage, held: PhotoPages | null, isCurrent: () => boolean = always): Promise<PagesRead | null> {
  const depth = held?.depth ?? null;
  const chain = await readChain(read, (page) => depth === null || reaches(page, depth), isCurrent);
  if (chain === null || !chain.ok || held === null || depth === null) return chain;
  const { list } = chain;
  const kept = list.photos.filter((p) => newestFirstPhotos(p, depth) <= 0);
  const cut = list.photos.length - kept.length;
  if (cut === 0) return { ok: true, list: { ...list, depth } };
  if (held.nextCursor === null) return { ok: true, list: { ...list, depth: list.photos.at(-1) ?? depth } };
  return { ok: true, list: { photos: kept, skippedTotal: list.skippedTotal, nextCursor: held.nextCursor, remainingTotal: list.remainingTotal + cut, depth } };
}

/**
 * New photos in front (a run's photo landed): only the top is read, from page 1 down to the page that reaches the first photo held,
 * and what it brings newer than that photo goes in front. The pages the owner opened further down are not read again: a new photo is
 * newer than every one of them and moves none, nor where «Показать ещё» resumes, nor what remains. The held photos the top pages bring
 * again are taken as answered now; one they should bring and do not (unreadable since) leaves. While the owner has not paged, this is
 * page 1 alone, like any reload. Null once `isCurrent` says it is no longer wanted.
 */
export async function readTop(read: ReadPage, held: PhotoPages | null, isCurrent: () => boolean = always): Promise<PagesRead | null> {
  const top = held?.photos[0];
  if (held === null || held.depth === null || top === undefined) return readThrough(read, held, isCurrent);
  const chain = await readChain(read, (page) => reaches(page, top), isCurrent);
  if (chain === null || !chain.ok) return chain;
  const brought = chain.list.photos;
  const lastBrought = brought.at(-1);
  const now = new Map(brought.map((p) => [p.photoId, p]));
  const kept = held.photos.flatMap((p) => {
    const fresh = now.get(p.photoId);
    if (fresh !== undefined) return [fresh];
    return lastBrought !== undefined && newestFirstPhotos(p, lastBrought) <= 0 ? [] : [p];
  });
  const newer = brought.filter((p) => newestFirstPhotos(p, top) < 0);
  return { ok: true, list: { photos: [...newer, ...kept], skippedTotal: chain.list.skippedTotal, nextCursor: held.nextCursor, remainingTotal: held.remainingTotal, depth: held.depth } };
}

