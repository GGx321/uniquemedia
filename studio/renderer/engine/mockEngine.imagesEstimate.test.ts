import { describe, expect, test } from "bun:test";
import { MOCK_BOLD_IMAGE } from "./mockEngine";
import { IMAGE, MIA, ON_THE_WRITER, runUntil, runWorld, startRun, toDone, unwrap } from "./mockLaunchRun.testkit";

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

describe("runs.estimateImages { avatarId, count, level, categories } (S5.R4-fix)", () => {
  const NO_POSES = { profile: false, back: false };
  const estimateOfRun = async (mock: ReturnType<typeof runWorld>, categories: ("home" | "nightwear" | "beach")[], count: number) =>
    (await unwrap(mock.client.request("runs.estimate", { avatarId: MIA.avatarId, count, categories, level: "bold", poses: NO_POSES }))).estimate;

  test("prices «Ночнушки и бельё» 10 + «Пляж и бассейн» 10 at the 2K unit, the run estimate's figure", async () => {
    const mock = runWorld();
    const answer = await unwrap(mock.client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 20, level: "bold", categories: ["nightwear", "beach"] }));
    expect(answer.photos).toBe(20);
    expect(answer.estimate).toEqual(await estimateOfRun(mock, ["nightwear", "beach"], 20));
    expect(answer.estimate.worstMicros).toBe(20 * ATTEMPTS * MOCK_BOLD_IMAGE);
  });

  test("prices only the bold share at the 2K unit: «Дом» 10 + «Ночнушки и бельё» 10", async () => {
    const mock = runWorld();
    const answer = await unwrap(mock.client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 20, level: "bold", categories: ["home", "nightwear"] }));
    expect(answer.estimate).toEqual(await estimateOfRun(mock, ["home", "nightwear"], 20));
  });

  test("a count with no level and no categories keeps the figure it always had", async () => {
    const mock = runWorld();
    const answer = await unwrap(mock.client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 10 }));
    expect(answer.estimate.worstMicros).toBe(10 * ATTEMPTS * IMAGE);
    expect("boldAttemptMicros" in answer.estimate).toBe(false);
  });

  test("a «Смелая» category below «Смелая» is refused, as the engine refuses it", async () => {
    const mock = runWorld();
    const reply = await mock.client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 4, level: "flirty", categories: ["nightwear"] });
    expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "bold-level-needed" } });
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
    // 5a.2 (S5.6e, m11): the first paid step of a template launch is a photo, so the refusal that parks the avatar before it has a drawn set is the compose WRITER's: the fixture's.
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("credits");
    const started = await startRun(mock, ON_THE_WRITER);
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
