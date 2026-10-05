import { describe, expect, test } from "bun:test";
import { freePhotos, makeMock, MIA, PHOTO_IDS, renderDraft, draftOf, scenePhoto, unwrap } from "./mockEngine.testkit";

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

  test("videos.render: the reason is judged over EVERY refused cell, not only the 64 the answer lists (the engine's commonPhotoReason)", async () => {
    // 68 photos: the first 64 are in a video, the last 4 are rejected. The answer lists 64 cells (all in-video), but the causes differ, so there is no single reason.
    const photos = Array.from({ length: 68 }, (_, i) => (i < 64 ? scenePhoto(i + 1, { used: true, usedIn: ["video-seeded-0001"] }) : scenePhoto(i + 1, { rejected: true, eligible: false })));
    const mock = makeMock({ photos });
    const clips = Array.from({ length: 17 }, (_, c) => ({
      clipId: `clip-${String(c + 1).padStart(8, "0")}`,
      kind: "collage" as const,
      layout: "collage4" as const,
      cells: [0, 1, 2, 3].map((j) => ({ photo: { source: "scene" as const, photoId: photos[c * 4 + j]?.photoId ?? "" }, focus: null })),
      motion: "static" as const,
      stagger: false,
      durationMs: 800,
      transitionIn: "cut" as const,
    }));

    const reply = await mock.client.request("videos.render", { spec: { schemaVersion: 1, avatarId: MIA.avatarId, layers: [], music: null, seed: 7, clips } });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE" } });
    expect(reply.ok ? 0 : reply.error.issues?.length).toBe(64);
    expect(reply.ok ? "ok" : reply.error.photoReason).toBeUndefined();
  });

  test("videos.render: a draft naming a photo only an unfinished video's intent holds is refused with pending-video", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    mock.engine.holdPendingVideoPhotos(MIA.avatarId, [P2]);

    const reply = await mock.client.request("videos.render", { montageId: draft.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "pending-video" } });
  });

  test("holding photos moves the avatar's unused count and announces the avatar, as the engine does when its holds change", async () => {
    const mock = makeMock();
    const before = (await unwrap(mock.client.request("avatars.list", {}))).avatars[0]?.eligibleUnusedCount ?? -1;
    const mark = mock.events.length;

    mock.engine.holdPendingVideoPhotos(MIA.avatarId, [P1, P2]);

    const after = (await unwrap(mock.client.request("avatars.list", {}))).avatars[0]?.eligibleUnusedCount ?? -1;
    expect(after).toBe(before - 2);
    expect(mock.events.slice(mark).filter((e) => e.type === "avatar.changed")).toHaveLength(1);
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
