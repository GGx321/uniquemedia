import { describe, expect, test } from "bun:test";
import { freePhotos, makeMock, MIA, PHOTO_IDS, renderDraft, draftOf, scenePhoto } from "./mockEngine.testkit";

// The mock names WHY a photo was refused (`photoReason`) as the engine does: a photo already in a video, a photo a queued or running render holds,
// and none for a cause the owner cannot act on (a rejected photo) or for photos refused for different causes.

const [P1 = "", P2 = "", P3 = ""] = PHOTO_IDS;

describe("PHOTO_UNAVAILABLE photoReason", () => {
  test("montages.create: a photo already in a video is in-video", async () => {
    const photos = [scenePhoto(1), scenePhoto(2, { used: true, usedIn: ["video-seeded-0001"] })];
    const mock = makeMock({ photos });

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: photos.map((p) => p.photoId) });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "in-video" } });
  });

  test("montages.create: a photo a queued render holds is held-by-render", async () => {
    const mock = makeMock();
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [P2, P3] });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render" } });
  });

  test("montages.create: a photo only an unfinished video's intent holds is pending-video", async () => {
    const mock = makeMock();
    mock.engine.holdPendingVideoPhotos(MIA.avatarId, [P1]);

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [P1, P2] });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "pending-video" } });
  });

  test("montages.create: a photo a queued render also holds stays held-by-render", async () => {
    const mock = makeMock();
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.engine.holdPendingVideoPhotos(MIA.avatarId, [P2]);

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [P2, P3] });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render" } });
  });

  test("montages.create: a rejected photo carries no reason", async () => {
    const photos = [scenePhoto(1), scenePhoto(2, { rejected: true, eligible: false })];
    const mock = makeMock({ photos });

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: photos.map((p) => p.photoId) });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE" } });
    expect(reply.ok ? null : reply.error.photoReason).toBeUndefined();
  });

  test("montages.create: photos refused for different causes carry no single reason", async () => {
    const photos = [scenePhoto(1, { used: true, usedIn: ["video-seeded-0001"] }), scenePhoto(2, { rejected: true, eligible: false })];
    const mock = makeMock({ photos });

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: photos.map((p) => p.photoId) });

    expect(reply.ok ? null : reply.error.photoReason).toBeUndefined();
  });

  test("videos.render: a photo already in a video is in-video", async () => {
    const mock = makeMock({ photos: freePhotos(4) });
    const first = await draftOf(mock, [P1, P2]);
    const second = await draftOf(mock, [P1]);
    await renderDraft(mock, first.montageId);
    mock.scheduler.runAll();

    const reply = await mock.client.request("videos.render", { montageId: second.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "in-video" } });
  });

  test("videos.render: a photo another queued render holds is held-by-render", async () => {
    const mock = makeMock();
    const first = await draftOf(mock, [P1, P2]);
    const second = await draftOf(mock, [P2, P3]);
    await renderDraft(mock, first.montageId);

    const reply = await mock.client.request("videos.render", { montageId: second.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render" } });
  });
});
