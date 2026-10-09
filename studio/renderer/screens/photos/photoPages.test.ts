import { describe, expect, test } from "bun:test";
import { MAX_LISTED_PHOTOS, type PhotoSummary } from "../../../shared/engine";
import { makeMock, MIA, scenePhoto } from "../../engine/mockEngine.testkit";
import { addedPhotos, appendPage, firstPage, type PhotoPages, readThrough, readTop, type ReadPage, replacePhoto } from "./photoPages";

// S4.P2: the gallery's paging rules on the mock's own photos.list (the engine's page rule, `pagePhotoList`). A cursor is a place, not
// a session: one a mock gave is good on another mock holding the same photos plus newer ones, which is how photos "arrive" here.

const BASE = Date.UTC(2026, 8, 20, 10, 0, 0);

/** Photos `from`..`to` of Mia, one second apart: a higher number is newer. */
function photos(from: number, to: number, patch: (n: number) => Partial<PhotoSummary> = () => ({})): PhotoSummary[] {
  return Array.from({ length: to - from + 1 }, (_unused, i) => {
    const n = from + i;
    return scenePhoto(n, { createdAt: new Date(BASE + n * 1000).toISOString(), ...patch(n) });
  });
}

/** A mock engine holding `library`, and photos.list on it, every call recorded with its cursor. */
function engineWith(library: PhotoSummary[]): { read: ReadPage; cursors: (string | null)[] } {
  const { client } = makeMock({ photos: library, avatars: [{ ...MIA, photoCount: library.length, eligibleUnusedCount: library.length }] });
  const cursors: (string | null)[] = [];
  const read: ReadPage = (cursor) => {
    cursors.push(cursor);
    return client.request("photos.list", cursor === null ? { avatarId: MIA.avatarId } : { avatarId: MIA.avatarId, cursor });
  };
  return { read, cursors };
}

async function page(read: ReadPage, cursor: string | null) {
  const reply = await read(cursor);
  if (!reply.ok) throw new Error(`photos.list: ${reply.error.code}`);
  return reply.result;
}

/** The list as the gallery holds it after the first page and `more` presses of «Показать ещё». */
async function paged(read: ReadPage, more: number): Promise<PhotoPages> {
  let list = firstPage(await page(read, null));
  for (let i = 0; i < more; i++) list = appendPage(list, await page(read, list.nextCursor));
  return list;
}

const ids = (list: readonly PhotoSummary[]): string[] => list.map((p) => p.photoId);
/** Newest first: `to` down to `from`. */
const newestFirst = (from: number, to: number): string[] => ids(photos(from, to)).reverse();

describe("a page and the next", () => {
  test("500 photos are one page: nothing more, and the owner has not paged", async () => {
    const list = firstPage(await page(engineWith(photos(1, MAX_LISTED_PHOTOS)).read, null));
    expect(list.photos).toHaveLength(MAX_LISTED_PHOTOS);
    expect(list).toMatchObject({ nextCursor: null, remainingTotal: 0, depth: null });
  });

  test("501 photos: the first page names the next and says one more; appending it lists all 501, newest first, each once", async () => {
    const { read } = engineWith(photos(1, 501));
    const first = firstPage(await page(read, null));
    expect(first.nextCursor).not.toBeNull();
    expect(first.remainingTotal).toBe(1);
    const all = appendPage(first, await page(read, first.nextCursor));
    expect(ids(all.photos)).toEqual(newestFirst(1, 501));
    expect(new Set(ids(all.photos)).size).toBe(501);
    expect(all).toMatchObject({ nextCursor: null, remainingTotal: 0 });
    expect(all.depth?.photoId).toBe("photo-mia-0001");
    expect(ids(addedPhotos(first, all))).toEqual(["photo-mia-0001"]);
  });

  test("a page that repeats a photo the list holds adds it once", () => {
    const [newest, middle, oldest] = photos(1, 3).reverse();
    if (newest === undefined || middle === undefined || oldest === undefined) throw new Error("three photos");
    const list = firstPage({ photos: [newest, middle], skippedTotal: 2, nextCursor: null, remainingTotal: 1 });
    const next = appendPage(list, { photos: [middle, oldest], skippedTotal: 2, nextCursor: null, remainingTotal: 0 });
    expect(ids(next.photos)).toEqual([newest.photoId, middle.photoId, oldest.photoId]);
    expect(ids(addedPhotos(list, next))).toEqual([oldest.photoId]);
  });

  test("skippedTotal stays what the engine could not read; the photos beyond the page are counted apart", async () => {
    const { client } = makeMock({ photos: photos(1, 501), skippedPhotos: { [MIA.avatarId]: 3 }, avatars: [{ ...MIA, photoCount: 501 }] });
    const reply = await client.request("photos.list", { avatarId: MIA.avatarId });
    if (!reply.ok) throw new Error(reply.error.code);
    expect(firstPage(reply.result)).toMatchObject({ skippedTotal: 3, remainingTotal: 1 });
  });
});

describe("a reload reads from page 1", () => {
  test("a list the owner never paged is read again as page 1 alone, without a cursor", async () => {
    const before = await paged(engineWith(photos(1, 1200)).read, 0);
    const after = engineWith(photos(1, 1203));
    const result = await readThrough(after.read, before);
    if (result === null || !result.ok) throw new Error("no list");
    expect(after.cursors).toEqual([null]);
    expect(ids(result.list.photos)).toEqual(newestFirst(704, 1203));
    expect(result.list).toMatchObject({ remainingTotal: 703, depth: null });
  });

  test("photos added in front come first; every photo the owner had stays on screen, none twice, and «Показать ещё» resumes where it did", async () => {
    const owner = engineWith(photos(1, 1500));
    const before = await paged(owner.read, 1); // photos 1500..501 on screen, 500 more
    expect(before.remainingTotal).toBe(500);

    const after = engineWith(photos(1, 1503)); // three new photos, newer than any cursor
    const result = await readThrough(after.read, before);
    if (result === null || !result.ok) throw new Error("no list");
    const list = result.list;
    // From page 1, then each page from the cursor the page before named: never the cursor held from before.
    expect(after.cursors[0]).toBeNull();
    expect(after.cursors.slice(1)).not.toContain(before.nextCursor);
    expect(ids(list.photos)).toEqual(newestFirst(501, 1503));
    expect(list.nextCursor).toBe(before.nextCursor);
    expect(list.remainingTotal).toBe(500);
    expect(list.depth?.photoId).toBe(before.depth?.photoId);

    // The next «Показать ещё» brings exactly the rest: no gap after the reload, no photo twice.
    const rest = appendPage(list, await page(after.read, list.nextCursor));
    expect(ids(rest.photos)).toEqual(newestFirst(1, 1503));
    expect(rest.nextCursor).toBeNull();
  });

  test("a photo on an appended page is read again with the reload: a mark set since shows", async () => {
    const before = await paged(engineWith(photos(1, 1000)).read, 1);
    expect(before.photos.find((p) => p.photoId === "photo-mia-0002")?.rejected).toBe(false);
    const after = engineWith(photos(1, 1001, (n) => (n === 2 ? { rejected: true, eligible: false } : {})));
    const result = await readThrough(after.read, before);
    if (result === null || !result.ok) throw new Error("no list");
    expect(result.list.photos.find((p) => p.photoId === "photo-mia-0002")?.rejected).toBe(true);
    expect(result.list.photos).toHaveLength(1001);
    expect(result.list).toMatchObject({ nextCursor: null, remainingTotal: 0 });
  });

  test("an owner who paged to the very end has the whole gallery again, the new photos included", async () => {
    const before = await paged(engineWith(photos(1, 1001)).read, 2);
    expect(before.nextCursor).toBeNull();
    const result = await readThrough(engineWith(photos(1, 1004)).read, before);
    if (result === null || !result.ok) throw new Error("no list");
    expect(ids(result.list.photos)).toEqual(newestFirst(1, 1004));
    expect(result.list).toMatchObject({ nextCursor: null, remainingTotal: 0 });
  });

  test("a page that fails on the way down fails the reload: no list cut short in its place", async () => {
    const before = await paged(engineWith(photos(1, 1200)).read, 1);
    const after = engineWith(photos(1, 1201));
    const failing: ReadPage = async (cursor) => (cursor === null ? after.read(null) : { ok: false, error: { code: "INTERNAL", detail: "disk" } });
    const result = await readThrough(failing, before);
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", detail: "disk" } });
  });
});

describe("new photos in front (a run's photo landed)", () => {
  test("only the top is read, down to the first photo held: the new ones go in front, the pages the owner opened stay as they are", async () => {
    const before = await paged(engineWith(photos(1, 1500)).read, 1); // 1500..501 on screen
    const after = engineWith(photos(1, 1503, (n) => (n === 1499 ? { rejected: true, eligible: false } : {})));
    const result = await readTop(after.read, before);
    if (result === null || !result.ok) throw new Error("no list");
    // One page from the top reaches photo 1500, the first held: nothing deeper is read.
    expect(after.cursors).toEqual([null]);
    expect(ids(result.list.photos)).toEqual(newestFirst(501, 1503));
    expect(result.list).toMatchObject({ nextCursor: before.nextCursor, remainingTotal: before.remainingTotal });
    expect(result.list.depth?.photoId).toBe(before.depth?.photoId);
    // The held photos the top page brought again are taken as it answers them now.
    expect(result.list.photos.find((p) => p.photoId === "photo-mia-1499")?.rejected).toBe(true);
  });

  test("a held photo gone from the top pages leaves; one held deeper than them is not touched", async () => {
    const before = await paged(engineWith(photos(1, 1000)).read, 1);
    const library = photos(1, 1001).filter((p) => p.photoId !== "photo-mia-0999");
    const result = await readTop(engineWith(library).read, before);
    if (result === null || !result.ok) throw new Error("no list");
    expect(result.list.photos.some((p) => p.photoId === "photo-mia-0999")).toBe(false);
    expect(result.list.photos).toHaveLength(1000);
    expect(result.list.photos.at(-1)?.photoId).toBe("photo-mia-0001");
  });

  test("a list the owner never paged is read as page 1 alone", async () => {
    const before = await paged(engineWith(photos(1, 1200)).read, 0);
    const after = engineWith(photos(1, 1201));
    const result = await readTop(after.read, before);
    if (result === null || !result.ok) throw new Error("no list");
    expect(after.cursors).toEqual([null]);
    expect(ids(result.list.photos)).toEqual(newestFirst(702, 1201));
  });
});

describe("a read that must stop", () => {
  test("once it is no longer wanted (the screen went), it stops after the page in flight and asks nothing more", async () => {
    const before = await paged(engineWith(photos(1, 2000)).read, 3);
    const after = engineWith(photos(1, 2003));
    let wanted = true;
    const read: ReadPage = async (cursor) => {
      const reply = await after.read(cursor);
      wanted = false;
      return reply;
    };
    expect(await readThrough(read, before, () => wanted)).toBeNull();
    expect(after.cursors).toEqual([null]);
  });

  test("a cursor that does not move on is an error, not a loop", async () => {
    const real = engineWith(photos(1, 1500));
    const before = await paged(real.read, 1);
    let calls = 0;
    // Page 1 over and over, each naming as the next the very cursor it was asked with: read on, it would never end.
    const stuck: ReadPage = async (cursor) => {
      calls++;
      const reply = await real.read(null);
      return reply.ok ? { ok: true, result: { ...reply.result, nextCursor: cursor ?? reply.result.nextCursor } } : reply;
    };
    const result = await readThrough(stuck, before);
    expect(result?.ok).toBe(false);
    if (result !== null && !result.ok) expect(result.error.code).toBe("INTERNAL");
    expect(calls).toBe(2);
  });
});

describe("a photo answered since", () => {
  test("takes its own place; a photo the list does not hold changes nothing", async () => {
    const list = await paged(engineWith(photos(1, 501)).read, 1);
    const marked = { ...scenePhoto(1, { createdAt: new Date(BASE + 1000).toISOString() }), rejected: true };
    const next = replacePhoto(list, marked);
    expect(next.photos.at(-1)).toEqual(marked);
    expect(ids(next.photos)).toEqual(ids(list.photos));
    expect(replacePhoto(list, scenePhoto(9999))).toBe(list);
  });
});
