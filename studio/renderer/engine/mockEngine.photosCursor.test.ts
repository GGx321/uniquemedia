import { describe, expect, test } from "bun:test";
import { MAX_LISTED_PHOTOS, type PhotoSummary } from "../../shared/engine";
import { makeMock, MIA, scenePhoto, unwrap, type Mock } from "./mockEngine.testkit";

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

});
