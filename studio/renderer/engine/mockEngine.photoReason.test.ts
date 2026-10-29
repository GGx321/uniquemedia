import { describe, expect, test } from "bun:test";
import { makeMock, MIA, scenePhoto } from "./mockEngine.testkit";

// The mock names WHY a photo was refused (`photoReason`) as the engine does: a photo already in a video, a photo a queued or running render holds,
// and none for a cause the owner cannot act on (a rejected photo) or for photos refused for different causes.


describe("PHOTO_UNAVAILABLE photoReason", () => {
  test("montages.create: a photo already in a video is in-video", async () => {
    const photos = [scenePhoto(1), scenePhoto(2, { used: true, usedIn: ["video-seeded-0001"] })];
    const mock = makeMock({ photos });

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: photos.map((p) => p.photoId) });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "in-video" } });
  });

});
