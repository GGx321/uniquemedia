import { describe, expect, test } from "bun:test";
import { encodePhotoCursor, MAX_LISTED_PHOTOS, type PhotoSummary } from "../../shared/engine";
import { freePhotos, makeMock, MIA, scenePhoto, unwrap, type Mock } from "./mockEngine.testkit";

// S4.P2: the mock pages photos.list the way the engine does (parity scenario "photos list pages by cursor" holds the two together).

/** `count` photos with distinct, increasing timestamps (the testkit's own are one second apart in one minute only). */
function manyPhotos(count: number): PhotoSummary[] {
  return Array.from({ length: count }, (_unused, i) => scenePhoto(i + 1, { createdAt: new Date(Date.UTC(2026, 8, 24, 10, 0, 0) + (i + 1) * 1000).toISOString() }));
}

function mockWith(photos: PhotoSummary[]): Mock {
  return makeMock({ photos, avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length }] });
}

async function page(mock: Mock, cursor?: string) {
  return unwrap(mock.client.request("photos.list", cursor === undefined ? { avatarId: MIA.avatarId } : { avatarId: MIA.avatarId, cursor }));
}

describe("mock photos.list cursor", () => {
  test("a library of 0 photos answers an empty page with no cursor", async () => {
    const answer = await page(mockWith([]));
    expect(answer).toMatchObject({ photos: [], nextCursor: null, remainingTotal: 0 });
  });

  test("exactly one page of photos has no next cursor", async () => {
    const answer = await page(mockWith(manyPhotos(MAX_LISTED_PHOTOS)));
    expect(answer.photos).toHaveLength(MAX_LISTED_PHOTOS);
    expect(answer.nextCursor).toBeNull();
  });

  test("one photo past the page: a cursor and one remaining", async () => {
    const answer = await page(mockWith(manyPhotos(MAX_LISTED_PHOTOS + 1)));
    expect(answer.photos).toHaveLength(MAX_LISTED_PHOTOS);
    expect(answer.nextCursor).not.toBeNull();
    expect(answer.remainingTotal).toBe(1);
  });

  test("1000 + 1 photos page as 500, 500, 1 newest first with no overlap and no gap", async () => {
    const photos = manyPhotos(2 * MAX_LISTED_PHOTOS + 1);
    const mock = mockWith(photos);
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    do {
      const answer = await page(mock, cursor);
      sizes.push(answer.photos.length);
      seen.push(...answer.photos.map((p) => p.photoId));
      cursor = answer.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(sizes).toEqual([500, 500, 1]);
    expect(seen).toEqual(photos.map((p) => p.photoId).reverse());
  });

  test("a cursor from a deleted photo resumes right after its position", async () => {
    const photos = manyPhotos(5);
    const gone = photos[2];
    const answer = await page(mockWith(photos.filter((p) => p !== gone)), encodePhotoCursor(gone?.createdAt ?? "", gone?.photoId ?? ""));
    expect(answer.photos.map((p) => p.photoId)).toEqual([photos[1]?.photoId, photos[0]?.photoId]);
  });

  test("a cursor the contract cannot read is refused with VALIDATION and the mock keeps answering", async () => {
    const mock = mockWith(freePhotos(3));
    const refused = await mock.client.request("photos.list", { avatarId: MIA.avatarId, cursor: "forged" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("VALIDATION");
    expect((await page(mock)).photos).toHaveLength(3);
  });

  test("a call without a cursor keeps skippedTotal as it was and reports nothing beyond a small library", async () => {
    const answer = await page(mockWith(freePhotos(3)));
    expect(answer).toMatchObject({ skippedTotal: 0, nextCursor: null, remainingTotal: 0 });
  });
});
