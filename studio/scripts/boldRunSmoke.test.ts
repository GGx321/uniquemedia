import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestTraits } from "../engine/avatars/records";
import { openLibrary } from "../engine/library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "../engine/library/testing/helpers";
import { sampleSet } from "../engine/library/testing/sceneSetSample";
import { OPENROUTER_API_BASE } from "../engine/money/prices";
import type { QaGate } from "../engine/runs/qa";
import { command, engineSettings, GOOD, jobEnd, ok, portraitPng, startEngine, TRAITS } from "../engine/testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../testing/nativeHttp";
import { BOLD_MODEL, boldRequestProblems, expectedBilledMicros, failedReasonsOf, ownerRequestProblems, type SentImageRequest } from "./boldSmoke";
import { startMockOpenRouter, type MockOpenRouter, type MockRequest } from "./mockOpenRouter";
useNativeGlobals();
useNativeHttp();

// 5a.3 (S5.9f, plan s5a3 §12): the packaged smoke's «Смелая» scenario (smoke-engine.ts, `runBoldRouteScenario`) needs Electron and runs in CI only. What does not need it is held here: the mock
// OpenRouter serving EVERY route the REAL engine's «Смелая» run asks for (the price routes with the 2K tier, the images), and the smoke's assertions made over what the engine really sent. A
// route or a tier the mock does not know would fail in CI only (the wave-2 lesson); here it fails in seconds.

const PHOTOS = 10;
const POSES = { profile: false, back: false };
const ATTEMPT = 93_000;

const faceGate = (): QaGate => ({ name: "face", paid: false, check: async () => ({ verdict: "pass" }) });
const sentOf = (request: MockRequest): SentImageRequest => ({ model: request.model, resolution: request.resolution, body: typeof request.body === "object" && request.body !== null ? Object.fromEntries(Object.entries(request.body)) : {} });

describe("the mock OpenRouter serves a real engine's «Смелая» run", () => {
  let tmp = "";
  let mock: MockOpenRouter | null = null;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "studio-bold-smoke-"));
    await mkdir(join(tmp, "library"));
  });
  afterEach(async () => {
    await mock?.stop();
    mock = null;
    await rm(tmp, { recursive: true, force: true });
  });

  /**
   * `mixedSet`: the avatar also holds a set stored before 5a.4, ten written scenes of «Ночнушки и бельё» on the Seedream route and «Дом» with no route (QB-5: an old set keeps none), so a run
   * from its scenes meets the owner's model and Seedream in one run (5a.4, S5.BA3, 2026-10-26, plan s5a4 §7.4, BA2 part 2 review L1).
   */
  async function setup(mixedSet = false) {
    mock = await startMockOpenRouter({ descriptorText: GOOD, distinctImages: true });
    const { library } = await openLibrary(join(tmp, "library"), { now: steppingClock(), newId: sequentialIds("bsm") });
    const avatar = await library.createAvatar({ name: "Bea", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    if (mixedSet) {
      const set = sampleSet({ sceneSetId: "set-mixed-0001", avatarId: avatar.id, runId: "run-set-mixed-0001", count: PHOTOS, written: PHOTOS, categories: ["nightwear", "home"] });
      await library.sceneSets.create({
        ...set,
        request: { ...set.request, level: "bold" },
        scenes: set.scenes.map((scene) => (scene.origin === "planned" && scene.slot.category === "nightwear" ? { ...scene, slot: { ...scene.slot, route: "seedream" as const } } : scene)),
      });
    }
    const base = mock.url;
    const started = await startEngine(tmp, {
      init: { settings: engineSettings(tmp, { imageAgeCheck: "off" }) },
      deps: { fetch: (url, init) => nativeFetch(String(url).replace(OPENROUTER_API_BASE, base), init), qaGates: [faceGate()] },
    });
    return { ...started, avatarId: avatar.id, mock };
  }

  /**
   * 5a.4 (S5.BA2, 2026-10-26, Q-A2): every nightwear slot is on the Seedream route, so a run over nightwear alone is all Seedream.
   * 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, L1): «Смелая» plans «Дом» on the route too, so the run that also meets the owner's model is `runFromSet`'s, over the set stored before 5a.4.
   */
  async function runOnce(setupResult: Awaited<ReturnType<typeof setup>>, categories: readonly string[] = ["nightwear"]) {
    const request = { avatarId: setupResult.avatarId, count: PHOTOS, categories: [...categories], level: "bold", poses: POSES };
    const estimate = ok(await setupResult.engine.handle(command("runs.estimate", request)));
    if (estimate.type !== "runs.estimate") throw new Error("wrong answer");
    const started = ok(await setupResult.engine.handle(command("runs.start", { ...request, acceptedWorstMicros: estimate.result.estimate.worstMicros })));
    if (started.type !== "runs.start") throw new Error("wrong answer");
    const end = await jobEnd(setupResult.events, started.result.jobId);
    return { estimate: estimate.result.estimate, end, runId: started.result.runId };
  }

  /** The run of the mixed set stored before 5a.4, started from its scenes. */
  async function runFromSet(setupResult: Awaited<ReturnType<typeof setup>>) {
    const got = ok(await setupResult.engine.handle(command("scenes.get", { avatarId: setupResult.avatarId })));
    if (got.type !== "scenes.get" || got.result.sceneSet === null) throw new Error("no set");
    const set = got.result.sceneSet;
    const estimate = ok(await setupResult.engine.handle(command("runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision })));
    if (estimate.type !== "runs.estimateFromScenes") throw new Error("wrong answer");
    const started = ok(await setupResult.engine.handle(command("runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision, acceptedWorstMicros: estimate.result.estimate.worstMicros })));
    if (started.type !== "runs.startFromScenes") throw new Error("wrong answer");
    const end = await jobEnd(setupResult.events, started.result.jobId);
    return { estimate: estimate.result.estimate, end, runId: started.result.runId };
  }

  test("the estimate names the 2K attempt and prices every photo at no less than it", async () => {
    const world = await setup();
    const { estimate } = await runOnce(world, ["nightwear"]);
    expect(estimate.boldAttemptMicros).toBe(ATTEMPT);
    expect(estimate.worstMicros).toBeGreaterThanOrEqual(PHOTOS * 3 * ATTEMPT);
    // Read from the mock's endpoints, not from the engine's dated table: a Seedream endpoint the engine could not read would price the run «fallback».
    expect(estimate.prices).toBe("live");
  });

  test("the run ends done with all ten photos, and the smoke's request checks find nothing wrong in what the engine sent", async () => {
    const world = await setup(true);
    const { end } = await runFromSet(world);
    expect(end.type).toBe("job.done");
    expect(end.type === "job.done" && end.payload.result.kind === "run" && end.payload.result.photoIds).toHaveLength(PHOTOS);
    const sent = world.mock.imageRequests();
    const seedream = sent.filter((r) => r.model === BOLD_MODEL);
    const owner = sent.filter((r) => r.model !== BOLD_MODEL);
    expect(seedream.length).toBeGreaterThan(0);
    expect(owner.length).toBeGreaterThan(0);
    expect(seedream.flatMap((r) => boldRequestProblems(sentOf(r)))).toEqual([]);
    expect(owner.flatMap((r) => ownerRequestProblems(sentOf(r)))).toEqual([]);
    expect(world.mock.unexpected).toEqual([]);
  });

  test("an armed refusal and an armed empty answer end one slot each, the run goes on, and the ledger ends where the mock's bill does", async () => {
    const world = await setup();
    world.mock.armRefusal(BOLD_MODEL);
    world.mock.armEmptyAnswer(BOLD_MODEL);
    const { end } = await runOnce(world);
    expect(end.type).toBe("job.done");
    expect(end.type === "job.done" && end.payload.result.kind === "run" && end.payload.result.photoIds).toHaveLength(PHOTOS - 2);
    expect([...failedReasonsOf(end)].sort()).toEqual(["model-empty", "model-refused"]);
    const money = ok(await world.engine.handle(command("money.status", {})));
    if (money.type !== "money.status" || money.result.ledger !== "open") throw new Error("the ledger is not open");
    expect(money.result.unsettledMicros).toBe(0);
    expect(Math.abs(money.result.spentMicros - Math.round(world.mock.totalUsageUsd() * 1_000_000))).toBeLessThanOrEqual(1);
    // The smoke's own sum: every request the run sent but the refused one is billed (the empty answer included), to the micro-dollar.
    expect(expectedBilledMicros(world.mock.imageRequests().map(sentOf), 1)).toBe(Math.round(world.mock.totalUsageUsd() * 1_000_000));
    expect(world.mock.unexpected).toEqual([]);
  });

  test("the library's photos say which came from the Seedream route", async () => {
    const world = await setup(true);
    const { runId } = await runFromSet(world);
    const listed = ok(await world.engine.handle(command("photos.list", { avatarId: world.avatarId })));
    if (listed.type !== "photos.list") throw new Error("wrong answer");
    const ofRun = listed.result.photos.filter((p) => p.runId === runId);
    const plan: unknown = JSON.parse(readFileSync(join(tmp, "library", "runs", runId, "plan.json"), "utf8"));
    const slots = typeof plan === "object" && plan !== null && "scenes" in plan && typeof plan.scenes === "object" && plan.scenes !== null && "slots" in plan.scenes && Array.isArray(plan.scenes.slots) ? plan.scenes.slots : [];
    const routed = slots.filter((slot: unknown) => typeof slot === "object" && slot !== null && "route" in slot && slot.route === "seedream").length;
    expect(ofRun).toHaveLength(PHOTOS);
    expect(routed).toBeGreaterThan(0);
    expect(routed).toBeLessThan(PHOTOS);
    expect(ofRun.filter((p) => p.route === "seedream")).toHaveLength(routed);
  });
});
