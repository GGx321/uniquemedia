import { describe, expect, test } from "bun:test";
import * as shared from "../../shared/engine";
import type { PhotoSummary } from "../../shared/engine";
import * as records from "./photoRecords";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S4.P2: one page of the newest-first list, keyed by the last shown photo's position (createdAt, photoId), never by an offset.

function photo(n: number, createdAt = `2026-09-24T11:00:00.${String(n).padStart(3, "0")}Z`): PhotoSummary {
  return {
    photoId: `photo-${String(n).padStart(6, "0")}`,
    avatarId: "avatar-0001",
    runId: "run-00000001",
    category: "home",
    createdAt,
    used: false,
    usedIn: [],
    rejected: false,
    reserved: false,
    eligible: true,
  };
}

// Distinct, increasing timestamps up to 1001 photos (millisecond field holds 0..999, so seconds carry the rest).
function library(count: number): PhotoSummary[] {
  return Array.from({ length: count }, (_unused, i) => {
    const n = i + 1;
    const createdAt = `2026-09-24T11:${String(Math.floor(n / 1000)).padStart(2, "0")}:00.${String(n % 1000).padStart(3, "0")}Z`;
    return photo(n, createdAt);
  });
}

const ids = (photos: readonly PhotoSummary[]): string[] => photos.map((p) => p.photoId);

function page(all: readonly PhotoSummary[], limit: number, cursor: string | null) {
  return records.pagePhotoList(all, limit, cursor);
}

function walk(all: readonly PhotoSummary[], limit: number): PhotoSummary[][] {
  const pages: PhotoSummary[][] = [];
  let cursor: string | null = null;
  do {
    const next: ReturnType<typeof page> = page(all, limit, cursor);
    pages.push(next.photos);
    cursor = next.nextCursor;
  } while (cursor !== null);
  return pages;
}

describe("pagePhotoList", () => {
  test("0 photos: an empty page, no next cursor, nothing remaining", () => {
    expect(page([], 500, null)).toEqual({ photos: [], nextCursor: null, remainingTotal: 0 });
  });

  test("exactly the limit: everything on one page and no next cursor", () => {
    const result = page(library(500), 500, null);
    expect(result.photos).toHaveLength(500);
    expect(result.nextCursor).toBeNull();
    expect(result.remainingTotal).toBe(0);
  });

  test("one past the limit: a full page, a cursor, and exactly one photo remaining", () => {
    const result = page(library(501), 500, null);
    expect(result.photos).toHaveLength(500);
    expect(result.nextCursor).not.toBeNull();
    expect(result.remainingTotal).toBe(1);
  });

  test("the cursor of the first page leads to the one photo left, the oldest", () => {
    const all = library(501);
    const second = page(all, 500, page(all, 500, null).nextCursor);
    expect(ids(second.photos)).toEqual([ids(all)[0] ?? ""]);
    expect(second.nextCursor).toBeNull();
    expect(second.remainingTotal).toBe(0);
  });

  test("1000 + 1 photos page as 500, 500, 1 with no overlap and no gap", () => {
    const all = library(1001);
    const pages = walk(all, 500);
    expect(pages.map((p) => p.length)).toEqual([500, 500, 1]);
    expect(ids(pages.flat())).toEqual([...ids(all)].reverse());
  });

  test("remainingTotal counts every photo beyond the page, not only the next page", () => {
    expect(page(library(1001), 500, null).remainingTotal).toBe(501);
  });

  test("photos sharing one createdAt are neither skipped nor repeated across page boundaries", () => {
    const same = "2026-09-24T11:00:00.000Z";
    const all = [1, 2, 3, 4, 5].map((n) => photo(n, same));
    expect(ids(walk(all, 2).flat())).toEqual([...ids(all)].reverse());
  });

  test("photos added newer than the cursor between calls do not shift the next page", () => {
    const all = library(6);
    const first = page(all, 3, null);
    const withNewer = [...all, photo(7, "2026-09-24T12:00:00.000Z"), photo(8, "2026-09-24T12:00:01.000Z")];
    expect(ids(page(withNewer, 3, first.nextCursor).photos)).toEqual(ids(all).slice(0, 3).reverse());
  });

  test("a photo added older than the cursor between calls turns up later and nothing is repeated or lost", () => {
    const all = library(6);
    const first = page(all, 3, null);
    const older = photo(99, "2026-09-24T10:00:00.000Z");
    const rest: PhotoSummary[] = [];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = page([...all, older], 3, cursor);
      rest.push(...next.photos);
      cursor = next.nextCursor;
    }
    expect(ids([...first.photos, ...rest])).toEqual([...ids(all).reverse(), older.photoId]);
  });

  test("a cursor from a photo deleted since still resumes right after its position", () => {
    const all = library(6);
    const first = page(all, 3, null);
    const lastShown = first.photos.at(-1)?.photoId;
    const withoutIt = all.filter((p) => p.photoId !== lastShown);
    expect(ids(page(withoutIt, 3, first.nextCursor).photos)).toEqual(ids(all).slice(0, 3).reverse());
  });

  test("a cursor at the oldest photo answers an empty page with no next cursor", () => {
    const all = library(3);
    const oldest = page(all, 3, null).photos.at(-1);
    const cursor = shared.encodePhotoCursor(oldest?.createdAt ?? "", oldest?.photoId ?? "");
    expect(page(all, 3, cursor)).toEqual({ photos: [], nextCursor: null, remainingTotal: 0 });
  });

  test("with no cursor the page is what finalizePhotoList always answered", () => {
    const all = library(7);
    expect(page(all, 5, null).photos).toEqual(records.finalizePhotoList(all, 5));
  });
});
