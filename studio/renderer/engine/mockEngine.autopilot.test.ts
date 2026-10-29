import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EngineError, EventMessage, LaunchDraftInput, PhotoSummary } from "../../shared/engine";
import { LLM_ONLY_CATEGORY_RECORD } from "../../engine/scenes/testing/llmOnlyFixture";
import type { MockEngineOptions } from "./mockEngine";
import { freePhotos, makeMock, MIA, NORA, SOFIA, unwrap, type Mock } from "./mockEngine.testkit";

// Stage 4, S4.1: the mock's stubs of the autopilot. They answer typed data for the screens (S4.9) to be built on, validate as the engine will (the contract's own schemas at the
// client, then the same refusals in the same order), and hold a launch in a canned, consistent mid-run state: pause, resume, stop and the review hand-off move it, and nothing
// advances on a timer. S4.8 made the mock RUN a launch on its scheduler (mockEngine.launchRun*.test.ts); this file keeps the S4.1 fixture's tests, which are about the CANNED launch
// (`launchRun: "canned"`), unchanged. The plan's and the preview's tests here do not depend on the mode.

const IMAGE = 50_000;
// 5a.2 (S5.6e, m11): the code template writes a built-in category («home» below) for nothing, so a plan on it prices no writer; the writer's money is the fixture's (`cat-llm-only-fixture`), the category
// whose scenes only the model writes.
const FIXTURE = { ...LLM_ONLY_CATEGORY_RECORD, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z" };

/** Mia has 6 free scene photos (category home), Sofia 12; Nora is archived. The image attempt is fixed at $0.05. */
function world(over: MockEngineOptions = {}): Mock {
  const photos: PhotoSummary[] = [...freePhotos(6, MIA), ...freePhotos(12, SOFIA)];
  const countOf = (a: AvatarSummary) => photos.filter((p) => p.avatarId === a.avatarId).length;
  const avatars = [MIA, SOFIA, NORA].map((a) => ({ ...a, photoCount: countOf(a), eligibleUnusedCount: countOf(a) }));
  const mock = makeMock({ avatars, photos, launchRun: "canned", categories: [FIXTURE], ...over });
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
    expect(preview.estimate.worstMicros).toBe(4 * 3 * IMAGE);
    expect(preview.estimate.expectedMicros).toBe(4 * IMAGE);
    expect(preview.perShapeExpectedMicros).toEqual({ single: IMAGE, collage: 3 * IMAGE, slides: 5 * IMAGE });
    expect(preview.blockers).toEqual([]);
  });

  // S5.6R: the engine splits an avatar's new photos by VIDEO, round-robin over the launch's categories (planner.ts, `generate`): every photo of one video comes from one category.
  // The mock priced them on an even split of the photos, so it spread one slides video over two categories and charged the writer for a share of it.

  // The worst case here is 4 photos at 3 attempts: $0.60 (the template writes «Дом», so no writer chunk is in it). A raise names the budget that covers it, in whole dollars: $1.

});

// S4.10 fix B: the mock answers the plan card's music line through the SAME rule as the engine's dry run (shared/autopilot/autoRefresh.ts). It differed in four places: at exactly 10 requests
// left it said «will» (the engine refuses), it knew nothing of the 72 h age of the list, of the 72 h spacing, or of the cap of 10 automatic sends.

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

  test("a ledger that needs a reconcile is RECONCILE_REQUIRED", async () => {
    const mock = world();
    mock.engine.requireReconcile(["open-reserves"]);
    expect((await errorOf(startWith(mock, { ...baseDraft(), planSeed: 1 }, 10_000_000_000))).code).toBe("RECONCILE_REQUIRED");
  });

  test("a forged amount never reaches the mock: the client refuses it", async () => {
    const mock = world();
    const draft = { ...baseDraft(), planSeed: 1 };
    expect((await errorOf(startWith(mock, draft, 1.5))).code).toBe("VALIDATION");
    expect((await errorOf(startWith(mock, draft, -1))).code).toBe("VALIDATION");
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

});

// S4.6v: the engine's `unsettled` and `inFlight` are disjoint, and the mock plays them the same way.

