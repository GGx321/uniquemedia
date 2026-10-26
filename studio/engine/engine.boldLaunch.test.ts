import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunPlanSchema } from "./runs/plan";
import { plan as planScenes } from "./scenes";
import { ledgerLines, ok, useEngineDir } from "./testing/engineHarness";
import { crashKit, fakeRender } from "./testing/crashKit";
import { draftOf, network } from "./testing/wiringKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, round 3, option B): a «Смелая» autopilot launch with a «Смелая» category, over the real engine with the default wiring (the real paid steps and port, the real slicing),
// a real ledger and a fake OpenRouter. Every photo of the launch is priced at the Seedream unit (three 2K attempts), the slice's cap is its photos times that unit, and
// `runs.estimateImages` for the launch answers the very same unit.

setDefaultTimeout(180_000);

afterEach(() => kit.shutdownAll());
const dir = useEngineDir("studio-engine-bold-launch-");
const kit = crashKit(dir);
beforeEach(() => kit.reset());

/** An everyday sentence, as a pre-5a.4 «Кокетливая» scene of «Дом» could read. */
const SENTENCE = "She laughs in the doorway while the evening light falls across the hall floor behind her.";

/** Three 2K attempts with the master as the reference: 3 × (90 000 + 3 000) µ$ at list. */
const BOLD_UNIT = 3 * 93_000;

const boldDraft = (avatarId: string, over: Parameters<typeof draftOf>[1] = {}) => draftOf([avatarId], { level: "bold", categories: ["nightwear"], videosPerAvatar: 1, ...over });

describe("a «Смелая» launch", () => {
  test("is estimated, capped and sliced at the bold unit for every photo, and its slice run is capped at its photos times that unit", async () => {
    const avatarId = await kit.seedAvatar(0, "bold");
    const net = network();
    const started = await kit.boot(net, fakeRender());
    const draft = boldDraft(avatarId);
    const estimate = ok(await kit.call(started, "autopilot.estimate", { draft }));
    if (estimate.type !== "autopilot.estimate") throw new Error("wrong answer");
    const { preview } = estimate.result;
    expect(preview.totals.toGenerate).toBeGreaterThan(0);
    expect(preview.estimate.worstMicros).toBe(preview.totals.toGenerate * BOLD_UNIT);

    const launch = await kit.startLaunch(started, draft);
    expect(kit.fileOf(launch.launchId).plannedWorstMicros).toBe(preview.estimate.worstMicros);
    await kit.driveToDone(started, launch.launchId);

    const runs = ok(await kit.call(started, "runs.list", {}));
    if (runs.type !== "runs.list") throw new Error("wrong answer");
    expect(runs.result.runs.length).toBeGreaterThan(0);
    for (const run of runs.result.runs) {
      const plan = RunPlanSchema.parse(JSON.parse(readFileSync(join(kit.libraryDir(), "runs", run.runId, "plan.json"), "utf8")));
      expect({ runId: run.runId, cap: plan.capMicros }).toEqual({ runId: run.runId, cap: plan.scenes.slots.length * BOLD_UNIT });
    }
    expect(runs.result.runs.reduce((sum, r) => sum + r.capMicros, 0)).toBeLessThanOrEqual(kit.fileOf(launch.launchId).avatars[0]?.allocation.drawMicros ?? 0);
    expect(kit.fileOf(launch.launchId).spentMicros).toBeLessThanOrEqual(kit.fileOf(launch.launchId).plannedWorstMicros);
  });

  test("answers runs.estimateImages for the launch at the same unit, photo for photo", async () => {
    const avatarId = await kit.seedAvatar(0, "boldimg");
    const started = await kit.boot(network(), fakeRender());
    const launch = await kit.startLaunch(started, boldDraft(avatarId, { sceneReview: true }));
    const row = (await kit.waitView(started, launch.launchId, "the review wait", (v) => v.avatars[0]?.phase === "awaiting-review", 60_000)).avatars[0];
    expect(row).toBeDefined();

    const answer = ok(await kit.call(started, "runs.estimateImages", { launchId: launch.launchId, avatarId }));
    if (answer.type !== "runs.estimateImages") throw new Error("wrong answer");
    expect(answer.result.photos).toBeGreaterThan(0);
    expect(answer.result.estimate.worstMicros).toBe(answer.result.photos * BOLD_UNIT);
  });

  // 5a.4 (S5.BA5, 2026-10-26, plan s5a4 §5.7, §5.8, I5.77, BA3 review H-1): «Смелая» is every category's, so a launch of the five at «Смелая» draws every slot on the route and is priced at
  // the bold unit. This row told the pre-5a.4 rule (the five at «Смелая» kept the owner's-model unit, 3 × 50 000 µ$); the unit it had is now «Кокетливая»'s, the row after it.
  test("a launch of the five at «Смелая» is estimated at the bold unit", async () => {
    const avatarId = await kit.seedAvatar(0, "boldfive");
    const started = await kit.boot(network(), fakeRender());
    const estimate = ok(await kit.call(started, "autopilot.estimate", { draft: boldDraft(avatarId, { categories: ["home"] }) }));
    if (estimate.type !== "autopilot.estimate") throw new Error("wrong answer");
    expect(estimate.result.preview.totals.toGenerate).toBeGreaterThan(0);
    expect(estimate.result.preview.estimate.worstMicros).toBe(estimate.result.preview.totals.toGenerate * BOLD_UNIT);
  });

  test("a launch of the five at «Кокетливая» keeps the unit it had", async () => {
    const avatarId = await kit.seedAvatar(0, "flirtyfive");
    const started = await kit.boot(network(), fakeRender());
    const estimate = ok(await kit.call(started, "autopilot.estimate", { draft: boldDraft(avatarId, { level: "flirty", categories: ["home"] }) }));
    if (estimate.type !== "autopilot.estimate") throw new Error("wrong answer");
    expect(estimate.result.preview.estimate.worstMicros).toBe(estimate.result.preview.totals.toGenerate * 3 * 50_000);
  });
});

// 5a.4 (S5.BA5, plan s5a4 I5.77 «anything stored is priced by its routes», §5.7, §5.8, r2 M2): a launch whose set exists prices its images (`runs.estimateImages`) and its slices
// (`drawLaunchSlice`) by the set's routed scenes, never by the draft's level. A set of 5a.4 at «Смелая» over «Дом» is on the route, so the bold unit; a set composed before 5a.4 at
// «Смелая» over the five was drawn as «Кокетливая» with no route, its photos are drawn on the owner's model, and so are priced: its slices are never sized at a unit they do not spend.
describe("a «Смелая» launch of «Дом», priced by its set's routes", () => {
  /** The owner's-model unit of the kit's settings: three attempts at 50 000 µ$. */
  const GROK_UNIT = 3 * 50_000;

  /** Starts the launch with the review on and waits for it: the set exists, its scenes written, nothing drawn yet. Answers the set's id. */
  async function inReview(started: Awaited<ReturnType<typeof kit.boot>>, avatarId: string): Promise<{ launchId: string; sceneSetId: string }> {
    const launch = await kit.startLaunch(started, boldDraft(avatarId, { categories: ["home"], sceneReview: true }));
    const row = (await kit.waitView(started, launch.launchId, "the review wait", (v) => v.avatars[0]?.phase === "awaiting-review", 60_000)).avatars[0];
    if (row?.sceneSetId == null) throw new Error("the launch's avatar has no set");
    return { launchId: launch.launchId, sceneSetId: row.sceneSetId };
  }

  /**
   * The set's scenes as a compose before 5a.4 left them: «Дом» drawn from its ordinary bank as «Кокетливая», with no route and an everyday sentence (I5.73: a stored slot reads
   * as it did). Each scene keeps its index and ids; only what it draws is the pre-5a.4 one.
   */
  async function beforeRoutes(started: Awaited<ReturnType<typeof kit.boot>>, avatarId: string, sceneSetId: string): Promise<void> {
    const library = started.engine.library;
    if (library === null) throw new Error("no library");
    await library.sceneSets.update(avatarId, sceneSetId, (current) => {
      const flirty = planScenes({ seed: 11, count: current.scenes.length, categories: ["home"], level: "flirty" }).slots;
      return {
        ...current,
        scenes: current.scenes.map((scene, i) => {
          const drawn = flirty[i];
          if (scene.origin !== "planned" || drawn === undefined) return scene;
          return { ...scene, slot: { ...drawn, slotIndex: scene.slot.slotIndex, attemptIdBase: scene.slot.attemptIdBase }, text: SENTENCE };
        }),
      };
    });
  }

  async function imagesOf(started: Awaited<ReturnType<typeof kit.boot>>, launchId: string, avatarId: string): Promise<{ photos: number; worstMicros: number }> {
    const answer = ok(await kit.call(started, "runs.estimateImages", { launchId, avatarId }));
    if (answer.type !== "runs.estimateImages") throw new Error("wrong answer");
    return { photos: answer.result.photos, worstMicros: answer.result.estimate.worstMicros };
  }

  /** Every slice run's cap against its slots times `unit`, and whether its slots are on the route. */
  function slices(unit: number): { runId: string; cap: number; routed: boolean[] }[] {
    const runsDir = join(kit.libraryDir(), "runs");
    return readdirSync(runsDir).map((runId) => {
      const plan = RunPlanSchema.parse(JSON.parse(readFileSync(join(runsDir, runId, "plan.json"), "utf8")));
      return { runId, cap: plan.capMicros - plan.scenes.slots.length * unit, routed: [...new Set(plan.scenes.slots.map((slot) => "route" in slot && slot.route === "seedream"))] };
    });
  }

  test("a set on the route: its images and every slice run at the bold unit", async () => {
    const avatarId = await kit.seedAvatar(0, "routedset");
    const started = await kit.boot(network(), fakeRender());
    const { launchId } = await inReview(started, avatarId);

    const images = await imagesOf(started, launchId, avatarId);
    expect(images.photos).toBeGreaterThan(0);
    expect(images.worstMicros).toBe(images.photos * BOLD_UNIT);

    await kit.driveToDone(started, launchId);
    const drawn = slices(BOLD_UNIT);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn).toEqual(drawn.map(({ runId }) => ({ runId, cap: 0, routed: [true] })));
  });

  test("a set from before 5a.4 (no route): its images and every slice run at the owner's-model unit", async () => {
    const avatarId = await kit.seedAvatar(0, "plainset");
    const started = await kit.boot(network(), fakeRender());
    const { launchId, sceneSetId } = await inReview(started, avatarId);
    await beforeRoutes(started, avatarId, sceneSetId);

    const images = await imagesOf(started, launchId, avatarId);
    expect(images.photos).toBeGreaterThan(0);
    expect(images.worstMicros).toBe(images.photos * GROK_UNIT);

    // The review goes on at the set's own revision (the rewrite above moved it past the one the launch's view last told).
    const revision = (await started.engine.library?.sceneSets.get(avatarId, sceneSetId))?.revision;
    ok(await kit.call(started, "autopilot.continueAfterReview", { launchId, avatarId, sceneSetId, revision }));
    await kit.driveToDone(started, launchId);
    const drawn = slices(GROK_UNIT);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn).toEqual(drawn.map(({ runId }) => ({ runId, cap: 0, routed: [false] })));
  });

  // 5a.4 (S5.BA5, plan s5a4 r2.1 L1, §5.8, accepted as is, no port change): a slice is SIZED by the draft's level (`photoWorstMicros`, the port has no set), so a launch accepted
  // before 5a.4 at «Смелая» over the five, whose draw allocation holds its photos at the owner's unit, is sized at the bold unit: its slices are smaller (more of them), never more
  // than the allocation can pay at that unit. Each slice is still CAPPED by its scenes' routes (the owner's unit for a set with none), so no reserve passes its run's cap.
  test("a launch accepted before 5a.4 (the owner's unit, a set with no route): smaller slices, each capped at the owner's unit, no reserve above its cap", async () => {
    const avatarId = await kit.seedAvatar(0, "l1set");
    const first = await kit.boot(network(), fakeRender());
    const { launchId, sceneSetId } = await inReview(first, avatarId);
    await beforeRoutes(first, avatarId, sceneSetId);
    const photos = (await imagesOf(first, launchId, avatarId)).photos;
    expect(photos).toBeGreaterThan(2);
    expect(await first.engine.photoWorstMicros({ level: "bold", categories: ["home"] })).toBe(BOLD_UNIT);
    await kit.kill(first);

    // The draw allocation as a build before 5a.4 accepted it: the photos at the owner's unit (the planned worst case follows, A2).
    const file = kit.fileOf(launchId);
    const row = file.avatars[0];
    if (row === undefined) throw new Error("the launch has no avatar");
    const drawMicros = photos * GROK_UNIT;
    writeFileSync(kit.launchPath(launchId), JSON.stringify({ ...file, plannedWorstMicros: file.plannedWorstMicros - (row.allocation.drawMicros - drawMicros), avatars: [{ ...row, allocation: { ...row.allocation, drawMicros } }] }));

    const second = await kit.boot(network(), fakeRender());
    await kit.resumeLaunch(second, launchId);
    const revision = (await second.engine.library?.sceneSets.get(avatarId, sceneSetId))?.revision;
    ok(await kit.call(second, "autopilot.continueAfterReview", { launchId, avatarId, sceneSetId, revision }));
    await kit.driveToDone(second, launchId);

    const runsDir = join(kit.libraryDir(), "runs");
    const runs = readdirSync(runsDir).map((runId) => RunPlanSchema.parse(JSON.parse(readFileSync(join(runsDir, runId, "plan.json"), "utf8"))));
    // Sized at the bold unit: never more photos in a slice than the allocation pays at it, so the photos come in more than one slice.
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.every((run) => run.scenes.slots.length <= Math.floor(drawMicros / BOLD_UNIT))).toBe(true);
    expect(runs.reduce((sum, run) => sum + run.scenes.slots.length, 0)).toBe(photos);
    // Capped by the routes: the owner's unit, and every reserve of a run within its cap.
    expect(runs.map((run) => run.capMicros)).toEqual(runs.map((run) => run.scenes.slots.length * GROK_UNIT));
    const reserved = (runId: string) => ledgerLines(kit.root()).filter((l) => l.type === "reserve" && typeof l.scope === "object" && l.scope !== null && "runId" in l.scope && l.scope.runId === runId).reduce((sum, l) => sum + Number(l.worstMicros), 0);
    for (const run of runs) expect({ runId: run.runId, reserved: reserved(run.runId) > 0, within: reserved(run.runId) <= run.capMicros }).toEqual({ runId: run.runId, reserved: true, within: true });
  });
});
