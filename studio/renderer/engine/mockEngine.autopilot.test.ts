import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EngineError, EventMessage, LaunchDraftInput, PhotoSummary } from "../../shared/engine";
import type { MockEngineOptions } from "./mockEngine";
import { draftOf, freePhotos, makeMock, MIA, NORA, PHOTO_IDS, renderDraft, SOFIA, unwrap, type Mock } from "./mockEngine.testkit";

// Stage 4, S4.1: the mock's stubs of the autopilot. They answer typed data for the screens (S4.9) to be built on, validate as the engine will (the contract's own schemas at the
// client, then the same refusals in the same order), and hold a launch in a canned, consistent mid-run state: pause, resume, stop and the review hand-off move it, and nothing
// advances on a timer until S4.8. The real engine answers «not implemented yet» for all of it until S4.6; parity plays these stories against the mock only (see the parity suite).

const IMAGE = 50_000;
const WRITER_CHUNK = 75_000;
const WRITER_PER_PHOTO = 458;

/** Mia has 6 free scene photos (category home), Sofia 12; Nora is archived. The image attempt is fixed at $0.05. */
function world(over: MockEngineOptions = {}): Mock {
  const photos: PhotoSummary[] = [...freePhotos(6, MIA), ...freePhotos(12, SOFIA)];
  const countOf = (a: AvatarSummary) => photos.filter((p) => p.avatarId === a.avatarId).length;
  const avatars = [MIA, SOFIA, NORA].map((a) => ({ ...a, photoCount: countOf(a), eligibleUnusedCount: countOf(a) }));
  const mock = makeMock({ avatars, photos, ...over });
  mock.engine.setRunImagePrice(IMAGE);
  return mock;
}

const baseDraft = (over: Partial<LaunchDraftInput> = {}): LaunchDraftInput => ({
  avatarIds: [MIA.avatarId, SOFIA.avatarId],
  videosPerAvatar: 4,
  mix: { single: 50, collage: 25, slides: 25 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: true,
  generate: true,
  sceneReview: false,
  stickers: false,
  ...over,
});

const estimate = async (mock: Mock, over: Partial<LaunchDraftInput> = {}) => (await unwrap(mock.client.request("autopilot.estimate", { draft: baseDraft(over) }))).preview;

/** Estimates, then starts the launch with exactly the worst case the preview showed. */
async function start(mock: Mock, over: Partial<LaunchDraftInput> = {}) {
  const preview = await estimate(mock, over);
  const draft = { ...baseDraft(over), planSeed: preview.planSeed };
  return (await unwrap(mock.client.request("autopilot.start", { draft, acceptedWorstMicros: preview.estimate.worstMicros }))).launch;
}

async function errorOf<T>(reply: Promise<{ ok: true; result: T } | { ok: false; error: EngineError }>): Promise<EngineError> {
  const r = await reply;
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

const startWith = (mock: Mock, draft: LaunchDraftInput & { planSeed: number }, acceptedWorstMicros: number) => mock.client.request("autopilot.start", { draft, acceptedWorstMicros });
const changed = (events: EventMessage[]) => events.flatMap((e) => (e.type === "autopilot.changed" ? [e.payload.launch] : []));

describe("autopilot.estimate", () => {
  test("plans the draft per avatar and prices it as the mock prices a run: library first, the rest generated", async () => {
    const preview = await estimate(world());
    // Mia: 4 videos are 2 singles, a collage of 3 and slides of 5 = 10 photos; her 6 free photos fill the slides and one single, the other 4 are new.
    // Sofia: 12 free photos fill all 10.
    const [mia, sofia] = preview.avatars;
    expect(mia).toMatchObject({ avatarId: MIA.avatarId, videos: 4, shapes: { single: 2, collage: 1, slides: 1 }, free: 6, fromLibrary: 6, toGenerate: 4, busy: false, blocked: null, usage: { state: "ok" } });
    expect(sofia).toMatchObject({ avatarId: SOFIA.avatarId, videos: 4, shapes: { single: 2, collage: 1, slides: 1 }, free: 12, fromLibrary: 10, toGenerate: 0, blocked: null });
    expect(preview.totals).toEqual({ videos: 8, photosNeeded: 20, fromLibrary: 16, toGenerate: 4 });
    expect(preview.estimate.worstMicros).toBe(WRITER_CHUNK + 4 * 3 * IMAGE);
    expect(preview.estimate.expectedMicros).toBe(4 * WRITER_PER_PHOTO + 4 * IMAGE);
    expect(preview.perShapeExpectedMicros).toEqual({ single: IMAGE, collage: 3 * IMAGE, slides: 5 * IMAGE });
    expect(preview.blockers).toEqual([]);
  });

  test("draws a plan seed when the draft has none, and keeps the one it is given", async () => {
    const mock = world();
    const drawn = await estimate(mock);
    expect(Number.isInteger(drawn.planSeed) && drawn.planSeed >= 0 && drawn.planSeed <= 4_294_967_295).toBe(true);
    const kept = (await unwrap(mock.client.request("autopilot.estimate", { draft: { ...baseDraft(), planSeed: 77 } }))).preview;
    expect(kept.planSeed).toBe(77);
  });

  test.each([
    [1, [1, 0, 0]],
    [3, [2, 1, 0]],
    [10, [7, 2, 1]],
    [50, [35, 10, 5]],
  ])("%i videos at 70/20/10 are %j singles, collages and slides (largest remainder, ties to the earlier shape)", async (videosPerAvatar, shapes) => {
    const preview = await estimate(world(), { avatarIds: [SOFIA.avatarId], videosPerAvatar, mix: { single: 70, collage: 20, slides: 10 }, library: false });
    const row = preview.avatars[0];
    expect([row?.shapes.single, row?.shapes.collage, row?.shapes.slides]).toEqual(shapes);
  });

  test("with the library off every photo is new", async () => {
    const preview = await estimate(world(), { library: false });
    expect(preview.totals).toEqual({ videos: 8, photosNeeded: 20, fromLibrary: 0, toGenerate: 20 });
  });

  test("with generation off the videos the library cannot fill are dropped, and a library-only plan is free", async () => {
    const preview = await estimate(world(), { generate: false });
    const mia = preview.avatars[0];
    // 6 free photos: the slides (5) and one single (1); the collage and the second single have no photos.
    expect(mia).toMatchObject({ videos: 2, shapes: { single: 1, collage: 0, slides: 1 }, fromLibrary: 6, toGenerate: 0 });
    expect(preview.estimate).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
    expect(preview.month.fit).toBe("fits");
    expect(preview.blockers).toEqual([]);
  });

  test("both switches off is a blocker, not an error: there is nothing to make", async () => {
    const preview = await estimate(world(), { library: false, generate: false });
    expect(preview.blockers).toContainEqual({ code: "nothing-enabled" });
    expect(preview.totals.videos).toBe(0);
  });

  test("an avatar the library does not hold, and an archived one, are NOT_FOUND", async () => {
    const mock = world();
    expect((await errorOf(mock.client.request("autopilot.estimate", { draft: baseDraft({ avatarIds: ["avatar-nobody-0404"] }) }))).code).toBe("NOT_FOUND");
    expect((await errorOf(mock.client.request("autopilot.estimate", { draft: baseDraft({ avatarIds: [NORA.avatarId] }) }))).code).toBe("NOT_FOUND");
  });

  test("a draft that breaks the contract is VALIDATION, as at the engine", async () => {
    const mock = world();
    expect((await errorOf(mock.client.request("autopilot.estimate", { draft: baseDraft({ mix: { single: 60, collage: 25, slides: 25 } }) }))).code).toBe("VALIDATION");
    expect((await errorOf(mock.client.request("autopilot.estimate", { draft: baseDraft({ videosPerAvatar: 51 }) }))).code).toBe("VALIDATION");
    expect((await errorOf(mock.client.request("autopilot.estimate", { draft: baseDraft({ avatarIds: [] }) }))).code).toBe("VALIDATION");
  });

  test("no library open is LIBRARY_UNAVAILABLE", async () => {
    const mock = world();
    mock.engine.setLibraryAvailable(false);
    expect((await errorOf(mock.client.request("autopilot.estimate", { draft: baseDraft() }))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("an avatar that needs new photos and has an open scene set of its own is blocked; one that needs none is not", async () => {
    const mock = world();
    await unwrap(mock.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 2, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 10_000_000 }));
    mock.scheduler.runAll();
    const blocked = await estimate(mock);
    expect(blocked.avatars[0]?.blocked).toBe("open-set");
    expect(blocked.blockers).toContainEqual({ code: "open-set", avatarId: MIA.avatarId });
    // The blocked avatar counts for nothing: Sofia alone is in the totals.
    expect(blocked.totals).toEqual({ videos: 4, photosNeeded: 10, fromLibrary: 10, toGenerate: 0 });
    const libraryOnly = await estimate(mock, { generate: false });
    expect(libraryOnly.avatars[0]?.blocked).toBeNull();
  });

  test("an avatar that would need more than 100 new photos is blocked, with the number it needs", async () => {
    const preview = await estimate(world(), { avatarIds: [MIA.avatarId], videosPerAvatar: 50, mix: { single: 0, collage: 0, slides: 100 }, library: false });
    expect(preview.avatars[0]).toMatchObject({ blocked: "too-many-photos", toGenerate: 250 });
    expect(preview.blockers).toContainEqual({ code: "too-many-photos", avatarId: MIA.avatarId });
    expect(preview.totals).toEqual({ videos: 0, photosNeeded: 0, fromLibrary: 0, toGenerate: 0 });
  });

  test("an avatar whose usage cannot be read gives no library photos, and blocks only a plan that uses the library", async () => {
    const unknown: AvatarSummary = { ...SOFIA, photoCount: 12, eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["index-stale"] } };
    const photos = [...freePhotos(6, MIA), ...freePhotos(12, SOFIA)];
    const mock = makeMock({ avatars: [{ ...MIA, photoCount: 6, eligibleUnusedCount: 6 }, unknown], photos });
    const preview = await estimate(mock);
    expect(preview.avatars[1]).toMatchObject({ avatarId: SOFIA.avatarId, blocked: "usage-unknown", free: 0, fromLibrary: 0, usage: { state: "unknown", reasons: ["index-stale"] } });
    expect(preview.blockers).toContainEqual({ code: "usage-unknown", avatarId: SOFIA.avatarId });
    const withoutLibrary = await estimate(mock, { library: false });
    expect(withoutLibrary.avatars[1]?.blocked).toBeNull();
  });

  test.each([
    [10_000_000, "fits"],
    [300_000, "fits-expected"],
    [100_000, "short"],
  ] as const)("with a budget of %i µ$ the month's fit is %s", async (budget, fit) => {
    const mock = world();
    await unwrap(mock.client.request("settings.setBudget", { monthlyBudgetMicros: budget }));
    const preview = await estimate(mock);
    expect(preview.month).toMatchObject({ budgetMicros: budget, committedMicros: 0, freeMicros: budget, fit });
  });

  test("the balance is known with a key and unknown without; no key blocks a plan that needs generating, not a library-only one", async () => {
    const withKey = await estimate(world());
    expect(withKey.balance).not.toBeNull();
    const noKey = world({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    const without = await estimate(noKey);
    expect(without.balance).toBeNull();
    expect(without.blockers).toContainEqual({ code: "no-key" });
    expect((await estimate(noKey, { generate: false })).blockers).toEqual([]);
  });

  test("the music line counts the stored tracks, and says how the trends would be refreshed", async () => {
    const preview = await estimate(world());
    expect(preview.music).toMatchObject({ candidates: 0, ownFlagged: 0, explicitSkipped: 0, autoRefresh: "no-key" });
    expect(preview.music.quotaRemaining).toBe(30);
  });

  test("a finished or running launch blocks a second: launch-active", async () => {
    const mock = world();
    await start(mock);
    expect((await estimate(mock)).blockers).toContainEqual({ code: "launch-active" });
  });
});

describe("autopilot.start", () => {
  test("accepts the preview's worst case, answers a running launch and announces it", async () => {
    const mock = world();
    const preview = await estimate(mock);
    const draft = { ...baseDraft(), planSeed: preview.planSeed };
    const launch = (await unwrap(startWith(mock, draft, preview.estimate.worstMicros))).launch;

    expect(launch).toMatchObject({ status: "running", paused: null, draft, acceptedMicros: preview.estimate.worstMicros, plannedWorstMicros: preview.estimate.worstMicros, plannedExpectedMicros: preview.estimate.expectedMicros });
    expect(launch.plan).toEqual({ videos: 8, photos: 20, fromLibrary: 16, toGenerate: 4 });
    expect(launch.avatars.map((a) => a.avatarId)).toEqual([MIA.avatarId, SOFIA.avatarId]);
    expect(launch.remainingMicros).toBe(launch.plannedWorstMicros - launch.spentMicros);
    expect(changed(mock.events).at(-1)).toEqual(launch);
    const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
    expect(snapshot.autopilot).toEqual(launch);
  });

  test("the launch it plans is the preview's: the same videos for the same seed", async () => {
    const mock = world();
    const preview = await estimate(mock);
    const launch = await start(mock);
    expect(launch.draft.planSeed).not.toBeUndefined();
    expect(preview.totals.videos).toBe(launch.plan.videos);
  });

  test("a worst case below the engine's is PRICE_CHANGED, free: no launch, no event", async () => {
    const mock = world();
    const preview = await estimate(mock);
    const draft = { ...baseDraft(), planSeed: preview.planSeed };
    const before = changed(mock.events).length;
    expect((await errorOf(startWith(mock, draft, preview.estimate.worstMicros - 1))).code).toBe("PRICE_CHANGED");
    expect(changed(mock.events).length).toBe(before);
    expect((await unwrap(mock.client.request("engine.snapshot", {}))).autopilot ?? null).toBeNull();
    expect((await unwrap(startWith(mock, draft, preview.estimate.worstMicros))).launch.status).toBe("running");
  });

  test("a month that cannot hold even the expected cost is BUDGET_EXCEEDED", async () => {
    const mock = world();
    await unwrap(mock.client.request("settings.setBudget", { monthlyBudgetMicros: 100_000 }));
    const preview = await estimate(mock);
    expect(preview.month.fit).toBe("short");
    const draft = { ...baseDraft(), planSeed: preview.planSeed };
    expect((await errorOf(startWith(mock, draft, preview.estimate.worstMicros))).code).toBe("BUDGET_EXCEEDED");
  });

  test("a second launch while one is unfinished is IN_FLIGHT", async () => {
    const mock = world();
    const preview = await estimate(mock);
    await start(mock);
    const draft = { ...baseDraft(), planSeed: preview.planSeed };
    expect((await errorOf(startWith(mock, draft, preview.estimate.worstMicros))).code).toBe("IN_FLIGHT");
  });

  test.each([
    ["open-set", async (mock: Mock) => {
      await unwrap(mock.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 2, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 10_000_000 }));
      mock.scheduler.runAll();
      return baseDraft();
    }],
    ["too-many-photos", async () => baseDraft({ avatarIds: [MIA.avatarId], videosPerAvatar: 50, mix: { single: 0, collage: 0, slides: 100 }, library: false })],
    ["nothing-enabled", async () => baseDraft({ library: false, generate: false })],
  ] as const)("the VALIDATION refusal %s names its reason, before anything is written or spent", async (reason, prepare) => {
    const mock = world();
    const draft = { ...(await prepare(mock)), planSeed: 1 };
    const error = await errorOf(startWith(mock, draft, 10_000_000_000));
    expect(error).toMatchObject({ code: "VALIDATION", launchReason: reason });
    expect((await unwrap(mock.client.request("engine.snapshot", {}))).autopilot ?? null).toBeNull();
  });

  test("an unreadable usage is VALIDATION usage-unknown for a plan that uses the library", async () => {
    const unknown: AvatarSummary = { ...SOFIA, photoCount: 12, eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["record-unreadable"] } };
    const mock = makeMock({ avatars: [unknown], photos: freePhotos(12, SOFIA) });
    const error = await errorOf(startWith(mock, { ...baseDraft({ avatarIds: [SOFIA.avatarId] }), planSeed: 1 }, 10_000_000_000));
    expect(error).toMatchObject({ code: "VALIDATION", launchReason: "usage-unknown" });
  });

  test("an unreadable launch file blocks a start until it is removed", async () => {
    const mock = world({ unreadableLaunches: [{ entryId: "0123456789abcdef", reason: "invalid" }] });
    const draft = { ...baseDraft(), planSeed: 1 };
    expect(await errorOf(startWith(mock, draft, 10_000_000_000))).toMatchObject({ code: "VALIDATION", launchReason: "launch-unreadable" });
    await unwrap(mock.client.request("autopilot.removeUnreadable", { entryId: "0123456789abcdef" }));
    expect((await unwrap(startWith(mock, draft, 10_000_000_000))).launch.status).toBe("running");
  });

  test("a key is needed only when photos are to be generated: a library-only launch is free and starts without one", async () => {
    const mock = world({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    expect((await errorOf(startWith(mock, { ...baseDraft(), planSeed: 1 }, 10_000_000_000))).code).toBe("AUTH_INVALID");
    const free = await start(mock, { generate: false });
    expect(free).toMatchObject({ acceptedMicros: 0, plannedWorstMicros: 0, plannedExpectedMicros: 0, remainingMicros: 0 });
  });

  test("a ledger that needs a reconcile is RECONCILE_REQUIRED", async () => {
    const mock = world();
    mock.engine.requireReconcile(["open-reserves"]);
    expect((await errorOf(startWith(mock, { ...baseDraft(), planSeed: 1 }, 10_000_000_000))).code).toBe("RECONCILE_REQUIRED");
  });

  test("an unusable export folder is EXPORT_UNAVAILABLE", async () => {
    const mock = world();
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    expect(await errorOf(startWith(mock, { ...baseDraft(), planSeed: 1 }, 10_000_000_000))).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
  });

  test("an unknown avatar is NOT_FOUND and no library is LIBRARY_UNAVAILABLE", async () => {
    const mock = world();
    expect((await errorOf(startWith(mock, { ...baseDraft({ avatarIds: ["avatar-nobody-0404"] }), planSeed: 1 }, 10_000_000_000))).code).toBe("NOT_FOUND");
    mock.engine.setLibraryAvailable(false);
    expect((await errorOf(startWith(mock, { ...baseDraft(), planSeed: 1 }, 10_000_000_000))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("a forged amount never reaches the mock: the client refuses it", async () => {
    const mock = world();
    const draft = { ...baseDraft(), planSeed: 1 };
    expect((await errorOf(startWith(mock, draft, 1.5))).code).toBe("VALIDATION");
    expect((await errorOf(startWith(mock, draft, -1))).code).toBe("VALIDATION");
  });

  test("an avatar that generates carries its draw allocation (for «в пределах запуска · до $Y»); a library-only one carries none", async () => {
    const launch = await start(world(), { library: true });
    // Mia needs 4 new photos: the allocation is the worst case of drawing them (3 attempts each); Sofia needs none.
    expect(launch.avatars[0]?.drawAllocationMicros).toBe(4 * 3 * IMAGE);
    expect(launch.avatars[1]?.drawAllocationMicros).toBeNull();
  });

  test("with the scene review on, the first avatar that generates waits for the owner's review of its set; with it off it draws", async () => {
    const reviewed = await start(world(), { sceneReview: true });
    const mia = reviewed.avatars[0];
    expect(mia).toMatchObject({ phase: "awaiting-review", setRevision: 1, scenes: 4, scenesWithoutText: 0, continuePhotos: 4 });
    expect(mia?.sceneSetId).not.toBeNull();
    expect(reviewed.avatars[1]?.phase).toBe("montage");
    const direct = await start(world(), { sceneReview: false });
    expect(direct.avatars[0]).toMatchObject({ phase: "drawing", slice: { index: 1, total: 1 } });
  });
});

describe("pause, resume and stop", () => {
  test("a pause moves a running launch to paused by the owner and announces it", async () => {
    const mock = world();
    const launch = await start(mock);
    const paused = (await unwrap(mock.client.request("autopilot.pause", { launchId: launch.launchId }))).launch;
    expect(paused.status).toBe("paused");
    expect(paused.paused).toMatchObject({ cause: "owner" });
    expect(changed(mock.events).at(-1)?.status).toBe("paused");
  });

  test("pausing twice, and pausing an unknown launch, are refused", async () => {
    const mock = world();
    const launch = await start(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: launch.launchId }));
    expect((await errorOf(mock.client.request("autopilot.pause", { launchId: launch.launchId }))).code).toBe("VALIDATION");
    expect((await errorOf(mock.client.request("autopilot.pause", { launchId: "launch-nobody0404" }))).code).toBe("NOT_FOUND");
    expect((await errorOf(mock.client.request("autopilot.stop", { launchId: "launch-nobody0404" }))).code).toBe("NOT_FOUND");
  });

  test("a resume needs the remaining worst case R the screen showed: below it is PRICE_CHANGED, at it the launch runs", async () => {
    const mock = world();
    const launch = await start(mock);
    const paused = (await unwrap(mock.client.request("autopilot.pause", { launchId: launch.launchId }))).launch;
    const remaining = paused.remainingMicros;
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: remaining - 1 }))).code).toBe("PRICE_CHANGED");
    expect((await unwrap(mock.client.request("autopilot.get", { launchId: launch.launchId }))).launch.status).toBe("paused");
    const resumed = (await unwrap(mock.client.request("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: remaining }))).launch;
    expect(resumed.status).toBe("running");
    expect(resumed.paused).toBeNull();
  });

  test("a resume of a launch that is not paused is VALIDATION", async () => {
    const mock = world();
    const launch = await start(mock);
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: 10_000_000 }))).code).toBe("VALIDATION");
  });

  test("a resume while the ledger needs a reconcile is RECONCILE_REQUIRED, and a forged sum is VALIDATION", async () => {
    const mock = world();
    const launch = await start(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: launch.launchId }));
    mock.engine.requireReconcile(["open-reserves"]);
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: 10_000_000 }))).code).toBe("RECONCILE_REQUIRED");
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: 1.5 }))).code).toBe("VALIDATION");
  });

  test("a stop ends the launch for good; the next launch may start", async () => {
    const mock = world();
    const launch = await start(mock);
    const stopped = (await unwrap(mock.client.request("autopilot.stop", { launchId: launch.launchId }))).launch;
    expect(stopped.status).toBe("stopped");
    expect(stopped.endedAt).not.toBeNull();
    expect((await errorOf(mock.client.request("autopilot.stop", { launchId: launch.launchId }))).code).toBe("VALIDATION");
    expect((await errorOf(mock.client.request("autopilot.pause", { launchId: launch.launchId }))).code).toBe("VALIDATION");
    expect((await start(mock)).launchId).not.toBe(launch.launchId);
  });

  test("a stop may come from a pause", async () => {
    const mock = world();
    const launch = await start(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: launch.launchId }));
    expect((await unwrap(mock.client.request("autopilot.stop", { launchId: launch.launchId }))).launch.status).toBe("stopped");
  });
});

describe("autopilot.continueAfterReview", () => {
  async function reviewed() {
    const mock = world();
    const launch = await start(mock, { sceneReview: true });
    const row = launch.avatars[0];
    if (row === undefined || row.sceneSetId === null || row.setRevision === null) throw new Error("expected a set to review");
    return { mock, launch, avatarId: row.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision };
  }

  test("starts the draw of an avatar that waits for its review", async () => {
    const { mock, launch, avatarId, sceneSetId, revision } = await reviewed();
    const answer = await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision }));
    expect(answer.draw).toBe("started");
    expect(answer.launch.avatars[0]?.phase).toBe("drawing");
    expect(changed(mock.events).at(-1)?.avatars[0]?.phase).toBe("drawing");
  });

  test("during a pause it only records the approval; the draw waits for «Продолжить»", async () => {
    const { mock, launch, avatarId, sceneSetId, revision } = await reviewed();
    await unwrap(mock.client.request("autopilot.pause", { launchId: launch.launchId }));
    const answer = await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision }));
    expect(answer.draw).toBe("waits-for-resume");
    expect(answer.launch.avatars[0]?.phase).toBe("approved-waiting");
    const resumed = (await unwrap(mock.client.request("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: answer.launch.remainingMicros }))).launch;
    expect(resumed.avatars[0]?.phase).toBe("drawing");
  });

  test("a revision that moved is SCENES_CHANGED; an avatar or a set that is not waiting is VALIDATION not-awaiting; an unknown launch is NOT_FOUND", async () => {
    const { mock, launch, avatarId, sceneSetId, revision } = await reviewed();
    expect((await errorOf(mock.client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision: revision + 1 }))).code).toBe("SCENES_CHANGED");
    expect(await errorOf(mock.client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId: SOFIA.avatarId, sceneSetId, revision }))).toMatchObject({ code: "VALIDATION", sceneReason: "not-awaiting" });
    expect(await errorOf(mock.client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId: "set-other-0000001", revision }))).toMatchObject({ code: "VALIDATION", sceneReason: "not-awaiting" });
    expect((await errorOf(mock.client.request("autopilot.continueAfterReview", { launchId: "launch-nobody0404", avatarId, sceneSetId, revision }))).code).toBe("NOT_FOUND");
    await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision }));
    expect(await errorOf(mock.client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision }))).toMatchObject({ code: "VALIDATION", sceneReason: "not-awaiting" });
  });
});

describe("autopilot.list, autopilot.get and autopilot.removeUnreadable", () => {
  test("the list holds the launches, newest first, and the unreadable entries by opaque id", async () => {
    const mock = world({ unreadableLaunches: [{ entryId: "0123456789abcdef", reason: "too-new" }] });
    await unwrap(mock.client.request("autopilot.removeUnreadable", { entryId: "0123456789abcdef" }));
    const first = await start(mock);
    await unwrap(mock.client.request("autopilot.stop", { launchId: first.launchId }));
    const second = await start(mock);
    const listed = await unwrap(mock.client.request("autopilot.list", {}));
    expect(listed.launches.map((l) => l.launchId)).toEqual([second.launchId, first.launchId]);
    expect(listed.launches[0]).toMatchObject({ status: "running", avatarIds: [MIA.avatarId, SOFIA.avatarId], avatarCount: 2, plannedWorstMicros: second.plannedWorstMicros });
    expect(listed.launches[1]).toMatchObject({ status: "stopped" });
    expect(listed.unreadable).toEqual([]);
  });

  test("an unreadable entry is listed and then removed; an id nobody holds is NOT_FOUND", async () => {
    const mock = world({ unreadableLaunches: [{ entryId: "0123456789abcdef", reason: "invalid" }] });
    expect((await unwrap(mock.client.request("autopilot.list", {}))).unreadable).toEqual([{ entryId: "0123456789abcdef", reason: "invalid" }]);
    expect((await errorOf(mock.client.request("autopilot.removeUnreadable", { entryId: "fedcba9876543210" }))).code).toBe("NOT_FOUND");
    await unwrap(mock.client.request("autopilot.removeUnreadable", { entryId: "0123456789abcdef" }));
    expect((await unwrap(mock.client.request("autopilot.list", {}))).unreadable).toEqual([]);
    expect((await errorOf(mock.client.request("autopilot.removeUnreadable", { entryId: "0123456789abcdef" }))).code).toBe("NOT_FOUND");
  });

  test("a path or a name for an entry is VALIDATION and never looked up", async () => {
    const mock = world();
    expect((await errorOf(mock.client.request("autopilot.removeUnreadable", { entryId: "../../etc/passwd" }))).code).toBe("VALIDATION");
  });

  test("get answers the launch, its log and a canned set of videos that agree with the avatars' rows", async () => {
    const mock = world();
    const launch = await start(mock);
    const detail = await unwrap(mock.client.request("autopilot.get", { launchId: launch.launchId }));
    expect(detail.launch).toEqual(launch);
    expect(detail.log[0]).toMatchObject({ kind: "start", acceptedMicros: launch.acceptedMicros });
    expect(new Set(detail.videos.map((v) => v.key)).size).toBe(detail.videos.length);
    for (const row of detail.launch.avatars) {
      const done = detail.videos.filter((v) => v.avatarId === row.avatarId && v.state === "done").length;
      expect(row.videos.done).toBe(done);
    }
    expect((await errorOf(mock.client.request("autopilot.get", { launchId: "launch-nobody0404" }))).code).toBe("NOT_FOUND");
  });
});

describe("the marks on videos and tracks", () => {
  async function oneVideo() {
    const mock = world();
    const draft = await draftOf(mock, PHOTO_IDS.slice(0, 2));
    const { videoId } = await renderDraft(mock, draft.montageId);
    mock.scheduler.runAll();
    return { mock, videoId };
  }

  test("a published mark is set, listed with the time, announced and cleared", async () => {
    const { mock, videoId } = await oneVideo();
    const listed = async () => (await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos.find((v) => v.videoId === videoId);
    expect(await listed()).not.toHaveProperty("publishedAt");
    const before = mock.events.length;
    const marked = (await unwrap(mock.client.request("videos.setPublished", { videoId, published: true }))).video;
    expect(marked.publishedAt).toEqual(expect.any(String));
    expect((await listed())?.publishedAt).toBe(marked.publishedAt);
    expect(mock.events.slice(before).some((e) => e.type === "video.changed" && e.payload.change === "upserted" && e.payload.video.publishedAt === marked.publishedAt)).toBe(true);
    const cleared = (await unwrap(mock.client.request("videos.setPublished", { videoId, published: false }))).video;
    expect(cleared.publishedAt ?? null).toBeNull();
    expect((await listed())?.publishedAt ?? null).toBeNull();
  });

  test("the list says the marks could be read once there are marks; before that it is the listing it always was", async () => {
    const { mock, videoId } = await oneVideo();
    expect("published" in (await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId })))).toBe(false);
    await unwrap(mock.client.request("videos.setPublished", { videoId, published: true }));
    expect((await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).published).toBe("ok");
    await unwrap(mock.client.request("videos.setPublished", { videoId, published: false }));
    expect((await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).published).toBe("ok");
  });

  test("an unknown video is NOT_FOUND", async () => {
    const mock = world();
    expect((await errorOf(mock.client.request("videos.setPublished", { videoId: "video-nobody-0404", published: true }))).code).toBe("NOT_FOUND");
  });

  test("a delete that rejects the photos marks every scene photo of the video rejected first and lists them", async () => {
    const { mock, videoId } = await oneVideo();
    const answer = await unwrap(mock.client.request("videos.delete", { videoId, mode: "video", rejectPhotos: true }));
    expect(answer.rejectedPhotoIds).toEqual(PHOTO_IDS.slice(0, 2));
    const photos = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos;
    for (const id of PHOTO_IDS.slice(0, 2)) expect(photos.find((p) => p.photoId === id)).toMatchObject({ rejected: true, eligible: false, used: false });
  });

  test("a delete without the flag rejects nothing and says nothing of photos", async () => {
    const { mock, videoId } = await oneVideo();
    const answer = await unwrap(mock.client.request("videos.delete", { videoId, mode: "video" }));
    expect("rejectedPhotoIds" in answer).toBe(false);
    const photos = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos;
    expect(photos.filter((p) => p.rejected)).toEqual([]);
  });

  test("a delete the export folder refuses changes nothing: the folder is asked FIRST (§8.5 step 1), so no photo is rejected and the video stays", async () => {
    const { mock, videoId } = await oneVideo();
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    const error = await errorOf(mock.client.request("videos.delete", { videoId, mode: "video", rejectPhotos: true }));
    expect(error.code).toBe("EXPORT_UNAVAILABLE");
    mock.engine.setExportDisk({ status: "ok" });
    expect((await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos.map((v) => v.videoId)).toContain(videoId);
    const photos = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos;
    expect(photos.filter((p) => p.rejected)).toEqual([]);
  });

  describe("«для автопилота» on an own track", () => {
    async function withTracks() {
      const mock = world();
      mock.engine.seedOwnMedia([
        { kind: "audio", name: "summer-loop.m4a", bytes: 900_000, facts: { durationMs: 42_000 } },
        { kind: "audio", name: "intro-theme.mp3", bytes: 900_000, facts: { durationMs: 30_000 } },
        { kind: "photo", name: "a.jpg", bytes: 100_000, facts: { width: 100, height: 100 } },
      ]);
      const media = (await unwrap(mock.client.request("media.list", {}))).media;
      const idOf = (name: string): string => media.find((m) => m.name === name)?.mediaId ?? "";
      return { mock, m4a: idOf("summer-loop.m4a"), mp3: idOf("intro-theme.mp3"), photo: idOf("a.jpg") };
    }

    test("is set, shown in the list and cleared; a record never marked says nothing", async () => {
      const { mock, m4a } = await withTracks();
      const flag = async () => (await unwrap(mock.client.request("media.list", { kind: "audio" }))).media.find((m) => m.mediaId === m4a)?.forAutopilot;
      expect(await flag()).toBeUndefined();
      const on = (await unwrap(mock.client.request("media.setForAutopilot", { mediaId: m4a, on: true }))).media;
      expect(on.forAutopilot).toBe(true);
      expect(await flag()).toBe(true);
      await unwrap(mock.client.request("media.setForAutopilot", { mediaId: m4a, on: false }));
      expect(await flag()).toBeFalsy();
    });

    // S4.5d: the first version of the mock refused a track NAMED «.mp3» as MEDIA_UNSUPPORTED (format). The engine stores every imported track as an m4a whatever the file was
    // called, so an mp3-named track is flagged there like any other, and parity (the story «an own track is flagged for the autopilot») showed the two answering differently.
    test("a track named .mp3 is flagged like any other: the importer stores every track as an m4a", async () => {
      const { mock, mp3 } = await withTracks();
      expect((await unwrap(mock.client.request("media.setForAutopilot", { mediaId: mp3, on: true }))).media.forAutopilot).toBe(true);
    });

    test("a photo and an unknown media are NOT_FOUND", async () => {
      const { mock, photo } = await withTracks();
      expect((await errorOf(mock.client.request("media.setForAutopilot", { mediaId: photo, on: true }))).code).toBe("NOT_FOUND");
      expect((await errorOf(mock.client.request("media.setForAutopilot", { mediaId: "media-nobody-0404", on: true }))).code).toBe("NOT_FOUND");
    });

    test("a flagged track counts in the preview's music line", async () => {
      const { mock, m4a } = await withTracks();
      await unwrap(mock.client.request("media.setForAutopilot", { mediaId: m4a, on: true }));
      expect((await estimate(mock)).music).toMatchObject({ ownFlagged: 1, candidates: 1 });
    });
  });
});
