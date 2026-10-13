import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LaunchPreview, type LaunchDraftInput } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { IDLE_STEPS } from "./autopilot/steps";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { command, engineSettings, failed, GOOD, KEY, network, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
useNativeGlobals();

setDefaultTimeout(30_000);

// 5a.3 (S5.9d, plan s5a3 §10.2, option B): a launch whose draft is «Смелая» with a «Смелая» category prices EVERY photo at the Seedream 2K unit; any other launch keeps the unit it
// had. The launch math is untouched: `autopilot.estimate` multiplies the photos it plans by the unit the engine reads, and the unit is the only thing that moves.

const dir = useEngineDir("studio-engine-autopilot-bold-");
const GROK_UNIT = 3 * 50_000;
const BOLD_UNIT = 3 * 93_000;

let seeded = 0;
async function boot() {
  const net = network();
  await mkdir(join(dir(), "export"), { recursive: true });
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const started = await startEngine(dir(), {
    key: KEY,
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off" }) },
    net,
    deps: { launchSteps: IDLE_STEPS },
  });
  await started.engine.settled();
  return { ...started, avatarId: avatar.id };
}

const draftOf = (avatarId: string, extra: Partial<LaunchDraftInput>): LaunchDraftInput => ({
  avatarIds: [avatarId],
  videosPerAvatar: 2,
  mix: { single: 0, collage: 0, slides: 100 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
  ...extra,
});

async function previewOf(started: Awaited<ReturnType<typeof boot>>, draft: LaunchDraftInput): Promise<LaunchPreview> {
  const answer = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
  if (answer.type !== "autopilot.estimate") throw new Error("not an estimate");
  return LaunchPreview.parse(answer.result.preview);
}

describe("autopilot.estimate and the Seedream unit", () => {
  test("a «Смелая» launch with a «Смелая» category prices every photo at three 2K attempts", async () => {
    const started = await boot();
    const preview = await previewOf(started, draftOf(started.avatarId, { level: "bold", categories: ["nightwear"] }));
    expect(preview.totals.toGenerate).toBeGreaterThan(0);
    expect(preview.estimate.worstMicros).toBe(preview.totals.toGenerate * BOLD_UNIT);
  });

  test("a mixed launch (a built-in with a «Смелая» category) prices every photo at the bold unit: option B", async () => {
    const started = await boot();
    const preview = await previewOf(started, draftOf(started.avatarId, { level: "bold", categories: ["home", "beach"] }));
    expect(preview.estimate.worstMicros).toBe(preview.totals.toGenerate * BOLD_UNIT);
  });

  test("«Смелая» with only the five keeps the unit it had", async () => {
    const started = await boot();
    const preview = await previewOf(started, draftOf(started.avatarId, { level: "bold", categories: ["home", "travel"] }));
    expect(preview.estimate.worstMicros).toBe(preview.totals.toGenerate * GROK_UNIT);
  });

  test("a «Смелая» category below «Смелая» is refused for free with bold-level-needed (I5.42): nothing is priced", async () => {
    const started = await boot();
    const before = started.net.calls.length;
    const refusal = failed(await started.engine.handle(command("autopilot.estimate", { draft: draftOf(started.avatarId, { level: "flirty", categories: ["nightwear"] }) })));
    expect(refusal.error).toMatchObject({ code: "VALIDATION", launchReason: "bold-level-needed" });
    expect(started.net.calls.slice(before).filter((c) => c.url.endsWith("/endpoints") || c.url.endsWith("/models"))).toEqual([]);
  });

  test("a launch with no level keeps the unit it had", async () => {
    const started = await boot();
    const preview = await previewOf(started, draftOf(started.avatarId, {}));
    expect(preview.estimate.worstMicros).toBe(preview.totals.toGenerate * GROK_UNIT);
  });
});
