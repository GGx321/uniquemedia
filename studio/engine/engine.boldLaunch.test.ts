import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RunPlanSchema } from "./runs/plan";
import { ok, useEngineDir } from "./testing/engineHarness";
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
