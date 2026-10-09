import { describe, expect, test } from "bun:test";
import { IMAGE, MIA, runUntil, runWorld, startRun, toDone, unwrap } from "./mockLaunchRun.testkit";

// S4.6p: the mock answers `runs.estimateImages` as the real engine does: the figure the draw of that many photos is priced at (the same one `runs.estimateFromScenes` answers
// for a set of that many scenes), and for a launch the photos it still has to draw, held at its draw allocation. The parity suite pins the shape against the real engine.

const ATTEMPTS = 3;

describe("runs.estimateImages { avatarId, count }", () => {
  test("is the figure the mock prices the draw of that many scenes at: three attempts each, one expected", async () => {
    const mock = runWorld();
    const answer = await unwrap(mock.client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 12 }));
    expect(answer.photos).toBe(12);
    expect(answer.estimate.expectedMicros).toBe(12 * IMAGE);
    expect(answer.estimate.worstMicros).toBe(12 * ATTEMPTS * IMAGE);
  });

  test("is the very figure a set of that many scenes is drawn at", async () => {
    const mock = runWorld();
    await unwrap(mock.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 7, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 1_000_000 }));
    mock.scheduler.runAll();
    const { sceneSet } = await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }));
    if (sceneSet === null) throw new Error("no set");
    const drawn = (await unwrap(mock.client.request("runs.estimateFromScenes", { sceneSetId: sceneSet.sceneSetId, revision: sceneSet.revision }))).estimate;
    expect((await unwrap(mock.client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 7 }))).estimate).toEqual(drawn);
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    const mock = runWorld();
    const reply = await mock.client.request("runs.estimateImages", { avatarId: "avatar-nobody-0404", count: 3 });
    expect(reply).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("runs.estimateImages { launchId, avatarId }", () => {
  test("in the review it prices the photos «Продолжить запуск» would draw and stays inside the draw allocation", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { sceneReview: true });
    const waiting = await runUntil(mock, started.launchId, "awaiting-review", (v) => v.avatars.some((a) => a.phase === "awaiting-review"));
    const row = waiting.avatars[0];
    if (row === undefined) throw new Error("no row");
    const answer = await unwrap(mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: MIA.avatarId }));
    expect(answer.photos).toBe(row.continuePhotos ?? Number.NaN);
    expect(answer.estimate).toEqual((await unwrap(mock.client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: answer.photos }))).estimate);
    expect(answer.estimate.worstMicros).toBeLessThanOrEqual(row.drawAllocationMicros ?? Number.NaN);
  });

  test("an ended launch is no unfinished launch: NOT_FOUND, as the engine answers", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await toDone(mock, started.launchId);
    const reply = await mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: MIA.avatarId });
    expect(reply).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("while photos are being drawn it counts only those not drawn yet", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { videosPerAvatar: 4 });
    const drawing = await runUntil(mock, started.launchId, "drawing with some photos done", (v) => v.avatars.some((a) => a.phase === "drawing" && a.photos.done > 0 && a.photos.done < a.photos.total));
    const row = drawing.avatars[0];
    if (row === undefined) throw new Error("no row");
    const answer = await unwrap(mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: MIA.avatarId }));
    expect(answer.photos).toBe(row.photos.total - row.photos.done);
    expect(answer.estimate.worstMicros).toBeLessThanOrEqual(row.drawAllocationMicros ?? Number.NaN);
    // The price of those photos is the very price of that many photos of the avatar, the engine's rule while its first slice is active.
    expect(answer.estimate).toEqual((await unwrap(mock.client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: answer.photos }))).estimate);
  });

  test("an avatar the launch has parked at a paid hold before it has a set has no photo to draw, as the engine answers", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("credits");
    const started = await startRun(mock);
    const held = await runUntil(mock, started.launchId, "the credits hold", (v) => v.paidHold?.reason === "credits");
    expect(held.avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "paid-hold" } });
    const answer = await unwrap(mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: MIA.avatarId }));
    expect(answer).toMatchObject({ photos: 0, estimate: { expectedMicros: 0, worstMicros: 0 } });
  });

  test("a launch the mock does not hold, and an avatar it does not hold, are NOT_FOUND", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    expect(await mock.client.request("runs.estimateImages", { launchId: "launch-0a1b2c3d4e5f", avatarId: MIA.avatarId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: "avatar-nobody-0404" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
