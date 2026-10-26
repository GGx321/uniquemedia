import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sampleSet } from "./library/testing/sceneSetSample";
import type { FetchCall, Reply } from "./openrouter/testing/fakes";
import { plan as planScenes } from "./scenes";
import { buildRunPlan, RunPlanSchema } from "./runs/plan";
import type { QaGate } from "./runs/qa";
import { command, engineSettings, failed, GOOD, jobEnd, network, ok, OFFLINE, portraitPng, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(30_000);

// 5a.3 (S5.9d, plan s5a3 §10): the engine's money for the «Смелая» route, end to end through the commands: runs.estimate prices a «Смелая» category's photos at the Seedream
// 2K attempt, refuses with `priceScope: "bold"` when only that tier is missing, and a run started on a stale accepted worst case is PRICE_CHANGED when the 2K price rose.
// The settings' model is Grok quality (60 000 µ$ an attempt with the master as its reference), the model §10.3's examples are worked on.

const dir = useEngineDir("studio-engine-bold-");
const SEEDREAM_URL = "bytedance-seed/seedream-5-0-pro/endpoints";
const MONEY_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "money", "fixtures");

const faceGate = (): QaGate => ({ name: "face", paid: false, check: async () => ({ verdict: "pass" }) });

let seeded = 0;
async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

/** The Seedream fixture, edited: `pricing` rows and `supported_parameters` as the test needs them. */
function seedreamBody(edit: { pricing?: (rows: { variant?: string; cost_usd: number; billable: string; unit: string }[]) => unknown[]; params?: (p: Record<string, unknown>) => Record<string, unknown> } = {}): unknown {
  const body = JSON.parse(readFileSync(join(MONEY_FIXTURES, "endpoints-seedream-5-0-pro.json"), "utf8")) as { endpoints: { pricing: never[]; supported_parameters: Record<string, unknown> }[] };
  return {
    ...body,
    endpoints: body.endpoints.map((e) => ({ ...e, pricing: edit.pricing === undefined ? e.pricing : edit.pricing(e.pricing), supported_parameters: edit.params === undefined ? e.supported_parameters : edit.params(e.supported_parameters) })),
  };
}

const livePrices = (seedream: unknown) => (call: FetchCall): Reply => (call.url.endsWith(SEEDREAM_URL) ? { status: 200, body: seedream as object } : OFFLINE);

async function boot(prices?: (call: FetchCall) => Reply, image?: (call: FetchCall, n: number) => Reply) {
  const net = network({ ...(prices === undefined ? {} : { prices }), ...(image === undefined ? {} : { image }) });
  const settings = engineSettings(dir(), { imageAgeCheck: "off", imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null });
  const started = await startEngine(dir(), { init: { settings }, net, deps: { qaGates: [faceGate()] } });
  return { ...started, net };
}

function request(avatarId: string, categories: string[], count: number, level = "bold") {
  return { avatarId, count, categories, level, poses: { profile: false, back: false } };
}

async function estimateOf(engine: Awaited<ReturnType<typeof boot>>["engine"], avatarId: string, categories: string[], count: number, level = "bold") {
  const answer = ok(await engine.handle(command("runs.estimate", request(avatarId, categories, count, level))));
  if (answer.type !== "runs.estimate") throw new Error(`expected an estimate, got ${answer.type}`);
  return answer.result.estimate;
}

describe("runs.estimate for «Смелая» categories", () => {
  test("«Ночнушки и бельё» 10: worst 2 790 000 µ$, expected 930 000 µ$, at list", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect(await estimateOf(engine, avatarId, ["nightwear"], 10)).toMatchObject({ worstMicros: 2_790_000, expectedMicros: 930_000 });
  });

  // 5a.4 (S5.BA5, 2026-10-26, plan s5a4 §5.7, I5.77, BA3 review H-1): «Смелая» is every category's, so «Дом»'s 10 are on the route too and every photo is priced at the 2K attempt. This row
  // told the pre-5a.4 figure, «Дом» on the owner's model: worst 4 590 000 µ$, expected 1 530 000 µ$.
  test("«Дом» 10 + «Ночнушки и бельё» 10: worst 5 580 000 µ$, every photo at the 2K attempt", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect(await estimateOf(engine, avatarId, ["home", "nightwear"], 20)).toMatchObject({ worstMicros: 5_580_000, expectedMicros: 1_860_000, boldAttemptMicros: 93_000 });
  });

  // 5a.4 (S5.BA5, plan s5a4 §5.7, §8 S5.BA5, BA3 review H-1): the five at «Смелая» are drawn on the route, so 20 of them are priced at 93 000 µ$ an attempt, not at the owner's 60 000.
  test("the five 20 at «Смелая»: worst 5 580 000 µ$, expected 1 860 000 µ$, at the 2K attempt (was $3.60 / $1.20 on the owner's model)", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect(await estimateOf(engine, avatarId, ["home", "travel", "shoot", "glam", "fit"], 20)).toMatchObject({ worstMicros: 5_580_000, expectedMicros: 1_860_000, boldAttemptMicros: 93_000 });
  });

  test("«Дом» 20 at «Смелая» is priced exactly as the five 20", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect(await estimateOf(engine, avatarId, ["home"], 20)).toEqual(await estimateOf(engine, avatarId, ["home", "travel", "shoot", "glam", "fit"], 20));
  });

  test("«Ночнушки и бельё» 10 + «Пляж и бассейн» 10: worst 5 580 000 µ$", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect(await estimateOf(engine, avatarId, ["nightwear", "beach"], 20)).toMatchObject({ worstMicros: 5_580_000, expectedMicros: 1_860_000 });
  });

  test("carries the 2K attempt as boldAttemptMicros (93 000 µ$ from the dated table)", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect((await estimateOf(engine, avatarId, ["beach"], 4)).boldAttemptMicros).toBe(93_000);
  });

  // 5a.4 (S5.BA5, 2026-10-26, BA3 review H-1): this row asked «Смелая» over «Дом» and «Виды» and told the pre-5a.4 figure (the owner's model); «Смелая» is every category's now, so the
  // control is «Кокетливая», whose figure is the one it always had (I5.77: an ordinary or flirty money figure never moves).
  test("a «Кокетливая» run of the five has no boldAttemptMicros and the figure it always had", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const estimate = await estimateOf(engine, avatarId, ["home", "travel"], 10, "flirty");
    expect("boldAttemptMicros" in estimate).toBe(false);
    expect(estimate.worstMicros).toBe(10 * 3 * 60_000);
  });

  test("a «Кокетливая» run of the five 20 stays at $1.20 / $3.60", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const estimate = await estimateOf(engine, avatarId, ["home", "travel", "shoot", "glam", "fit"], 20, "flirty");
    expect({ worst: estimate.worstMicros, expected: estimate.expectedMicros, bold: "boldAttemptMicros" in estimate }).toEqual({ worst: 3_600_000, expected: 1_200_000, bold: false });
  });

  test("prices the 2K attempt from the live endpoint when it is listed", async () => {
    const avatarId = await seedAvatar();
    const dearer = seedreamBody({ pricing: (rows) => rows.map((row) => (row.variant === "high_resolution" ? { ...row, cost_usd: 0.12 } : row)) });
    const { engine } = await boot(livePrices(dearer));
    expect(await estimateOf(engine, avatarId, ["nightwear"], 2)).toMatchObject({ worstMicros: 2 * 3 * 123_000, boldAttemptMicros: 123_000, prices: "fallback" });
  });
});

describe("a Seedream price list without the 2K tier", () => {
  const noTier = () => seedreamBody({ pricing: (rows) => rows.filter((row) => row.variant !== "high_resolution") });
  const no2kParam = () => seedreamBody({ params: (p) => ({ ...p, resolution: { type: "enum", values: ["1K"] } }) });

  test.each([
    ["no 2K price line", noTier],
    ["no 2K in the supported resolutions", no2kParam],
  ])("refuses a «Смелая» estimate (%s) with PRICE_UNAVAILABLE for the bold scope", async (_name, body) => {
    const avatarId = await seedAvatar();
    const { engine } = await boot(livePrices(body()));
    const refusal = failed(await engine.handle(command("runs.estimate", request(avatarId, ["nightwear"], 4))));
    expect(refusal.error).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });

  test.each([
    ["no 2K price line", noTier],
    ["no 2K in the supported resolutions", no2kParam],
  ])("still estimates a «Кокетливая» run (%s)", async (_name, body) => {
    // 5a.4 (S5.BA5, 2026-10-26, BA3 review H-1): this row asked «Смелая» over «Дом», which needed no 2K price before 5a.4; «Дом» at «Смелая» is drawn on the route now (the row below),
    // so the run that needs no 2K price is «Кокетливая».
    const avatarId = await seedAvatar();
    const { engine } = await boot(livePrices(body()));
    expect(await estimateOf(engine, avatarId, ["home"], 4, "flirty")).toMatchObject({ worstMicros: 4 * 3 * 60_000 });
  });

  test.each([
    ["no 2K price line", noTier],
    ["no 2K in the supported resolutions", no2kParam],
  ])("refuses «Дом» at «Смелая» (%s) with PRICE_UNAVAILABLE for the bold scope: its photos are on the route", async (_name, body) => {
    const avatarId = await seedAvatar();
    const { engine } = await boot(livePrices(body()));
    const refusal = failed(await engine.handle(command("runs.estimate", request(avatarId, ["home"], 4))));
    expect(refusal.error).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });

  test("a missing 1K price has no priceScope", async () => {
    const avatarId = await seedAvatar();
    const noReference = seedreamBody({ pricing: (rows) => rows.filter((row) => row.billable !== "input_image") });
    const { engine } = await boot(livePrices(noReference));
    const refusal = failed(await engine.handle(command("runs.estimate", { avatarId, count: 4, categories: ["home"], poses: { profile: false, back: false } })));
    expect(refusal.error.code).toBe("PRICE_UNAVAILABLE");
    expect("priceScope" in refusal.error).toBe(false);
  });
});

// S5.R4-fix round 2: a count priced for a stored set (`sceneSetId`) takes the bold share from the set's ACTIVE scenes by their own routes, the very `routedScenes` path of
// `runs.estimateFromScenes`, so the strip never prices a frame on the wrong route (a split of the count over the categories cannot know which scenes were removed or gave up).
describe("runs.estimateImages { avatarId, count, sceneSetId } for a «Смелая» set", () => {
  /** A set of 10 written scenes over «Ночнушки и бельё» and «Дом»: every «Ночнушки и бельё» scene on the Seedream route. Returns the indexes of the routed ones and of the others. */
  async function seedBoldSet(avatarId: string, sceneSetId: string, removed: number[] = [], emptied: number[] = []): Promise<{ routed: number[]; plain: number[] }> {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seedset${++seeded}`) });
    const set = sampleSet({ sceneSetId, avatarId, runId: `run-${sceneSetId}`, count: 10, written: 10, categories: ["nightwear", "home"] });
    const bold = (i: number): boolean => set.scenes[i]?.origin === "planned" && set.scenes[i]?.slot.category === "nightwear";
    await library.sceneSets.create({
      ...set,
      request: { ...set.request, level: "bold" },
      scenes: set.scenes.map((scene, i) => ({ ...scene, removed: removed.includes(i), ...(emptied.includes(i) ? { text: null } : {}), ...(scene.origin === "planned" && bold(i) ? { slot: { ...scene.slot, route: "seedream" as const } } : {}) })),
    });
    const all = set.scenes.map((_, i) => i);
    return { routed: all.filter(bold), plain: all.filter((i) => !bold(i)) };
  }

  async function imagesFor(engine: Awaited<ReturnType<typeof boot>>["engine"], payload: Record<string, unknown>) {
    const answer = ok(await engine.handle(command("runs.estimateImages", payload)));
    if (answer.type !== "runs.estimateImages") throw new Error(`expected an images estimate, got ${answer.type}`);
    return answer.result.estimate;
  }

  test("prices the routed scenes at the 2K unit and the rest at the owner's model: the figure of «Отрисовать»", async () => {
    const avatarId = await seedAvatar();
    const { routed } = await seedBoldSet(avatarId, "set-bold-0001");
    expect(routed.length).toBeGreaterThan(0);
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 10, sceneSetId: "set-bold-0001" });
    expect(images.worstMicros).toBe(routed.length * 3 * 93_000 + (10 - routed.length) * 3 * 60_000);
    const set = await engine.library?.sceneSets.get(avatarId, "set-bold-0001");
    const drawn = ok(await engine.handle(command("runs.estimateFromScenes", { sceneSetId: "set-bold-0001", revision: set?.revision })));
    if (drawn.type !== "runs.estimateFromScenes") throw new Error("expected an estimate");
    expect(images).toEqual(drawn.result.estimate);
  });

  test("a removed scene on the owner's model leaves the Seedream scenes as they are (a split of the count would move one)", async () => {
    const avatarId = await seedAvatar();
    const probe = await seedBoldSet(avatarId, "set-bold-0002a");
    const dropped = probe.plain.slice(0, 2);
    expect(dropped).toHaveLength(2);
    await seedBoldSet(avatarId, "set-bold-0002", dropped);
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 10 - dropped.length, sceneSetId: "set-bold-0002" });
    expect(images.worstMicros).toBe(probe.routed.length * 3 * 93_000 + (10 - dropped.length - probe.routed.length) * 3 * 60_000);
  });

  test("a removed Seedream scene lowers the bold share by one", async () => {
    const avatarId = await seedAvatar();
    const probe = await seedBoldSet(avatarId, "set-bold-0003a");
    const first = probe.routed[0];
    if (first === undefined) throw new Error("no routed scene");
    await seedBoldSet(avatarId, "set-bold-0003", [first]);
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 9, sceneSetId: "set-bold-0003" });
    expect(images.worstMicros).toBe((probe.routed.length - 1) * 3 * 93_000 + (9 - probe.routed.length + 1) * 3 * 60_000);
  });

  test("a count below the active scenes counts only the scenes with text: an empty Seedream scene is not in the bold share", async () => {
    const avatarId = await seedAvatar();
    const probe = await seedBoldSet(avatarId, "set-bold-0005a");
    const empty = probe.routed[0];
    if (empty === undefined) throw new Error("no routed scene");
    await seedBoldSet(avatarId, "set-bold-0005", [], [empty]);
    const { engine } = await boot();
    // The strip sends the scenes WITH text (9 of 10 active); the run it prices is those 9, and the empty Seedream scene is not one of them.
    const images = await imagesFor(engine, { avatarId, count: 9, sceneSetId: "set-bold-0005" });
    expect(images.worstMicros).toBe((probe.routed.length - 1) * 3 * 93_000 + (9 - probe.routed.length + 1) * 3 * 60_000);
  });

  test("a set the avatar does not have is NOT_FOUND", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const refusal = failed(await engine.handle(command("runs.estimateImages", { avatarId, count: 3, sceneSetId: "set-nobody-0404" })));
    expect(refusal.error.code).toBe("NOT_FOUND");
  });
});

describe("a stored run with Seedream slots", () => {
  /** A run folder as a start would have left it, one slot of «Ночнушки и бельё» on the Seedream route, with a cap that covers its three attempts. */
  async function seedRun(avatarId: string): Promise<string> {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seedrun${++seeded}`) });
    const slots = planScenes({ seed: 3, count: 1, categories: ["nightwear"] }).slots.map((slot) => ({ ...slot, route: "seedream" as const }));
    const run = buildRunPlan({
      runId: "run-00000042",
      avatarId,
      createdAt: "2026-10-12T12:00:00.000Z",
      request: { avatarId, count: 1, categories: ["nightwear"], level: "bold", poses: { profile: false, back: false } },
      imageAgeCheck: "off",
      models: { imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null, textModel: "x-ai/grok-4.3" },
      capMicros: 3 * 93_000,
      plannedWorstMicros: 3 * 93_000,
      scenes: { version: 1, seed: 3, slots },
    });
    await library.createRun(run.runId, run, RunPlanSchema);
    return run.runId;
  }

  test("a resume is priced at the 2K attempt: 3 × 93 000 µ$", async () => {
    const avatarId = await seedAvatar();
    const runId = await seedRun(avatarId);
    const { engine } = await boot();
    const answer = ok(await engine.handle(command("runs.estimateResume", { runId })));
    if (answer.type !== "runs.estimateResume") throw new Error("expected a resume estimate");
    expect(answer.result.estimate.worstMicros).toBe(3 * 93_000);
  });

  test("a resume whose Seedream endpoint lost the 2K tier is PRICE_UNAVAILABLE for the bold scope", async () => {
    const avatarId = await seedAvatar();
    const runId = await seedRun(avatarId);
    const { engine } = await boot(livePrices(seedreamBody({ pricing: (rows) => rows.filter((row) => row.variant !== "high_resolution") })));
    expect(failed(await engine.handle(command("runs.estimateResume", { runId }))).error).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });
});

describe("a «Смелая» category below «Смелая» (I5.42)", () => {
  const priceReads = (net: { calls: readonly FetchCall[] }): FetchCall[] => net.calls.filter((c) => c.url.endsWith("/endpoints") || c.url.endsWith("/models"));

  test.each(["ordinary", "flirty"])("is refused for free at level %s before any price is fetched, by the estimate and by the start", async (level) => {
    const avatarId = await seedAvatar();
    const { engine, net } = await boot();
    const asked = { ...request(avatarId, ["nightwear"], 4), level };
    expect(failed(await engine.handle(command("runs.estimate", asked))).error).toMatchObject({ code: "VALIDATION", sceneReason: "bold-level-needed" });
    expect(failed(await engine.handle(command("runs.start", { ...asked, acceptedWorstMicros: 10_000_000 }))).error).toMatchObject({ code: "VALIDATION", sceneReason: "bold-level-needed" });
    expect(priceReads(net)).toEqual([]);
  });
});

describe("runs.start when the 2K price rose", () => {
  test("is PRICE_CHANGED: the worst case the owner accepted (at 93 000 µ$ an attempt) is below the new one", async () => {
    const avatarId = await seedAvatar();
    const dearer = seedreamBody({ pricing: (rows) => rows.map((row) => (row.variant === "high_resolution" ? { ...row, cost_usd: 0.12 } : row)) });
    const { engine, net } = await boot(livePrices(dearer));
    const refusal = failed(await engine.handle(command("runs.start", { ...request(avatarId, ["nightwear"], 2), acceptedWorstMicros: 2 * 3 * 93_000 })));
    expect(refusal.error.code).toBe("PRICE_CHANGED");
    expect(net.paidCalls()).toHaveLength(0);
  });
});

// 5a.4 (S5.BA5, plan s5a4 I5.77, BA3 review H-1): the run's cap is the estimate's worst case, so a «Смелая» run of the five accepted at the owner's-model figure (the one the estimate
// showed before 5a.4) is refused for free, and the 2K figure starts it with that very cap.
describe("runs.start of the five at «Смелая»", () => {
  test("accepted at the owner's-model figure (3 × 60 000 µ$ a photo) is PRICE_CHANGED for free", async () => {
    const avatarId = await seedAvatar();
    const { engine, net } = await boot();
    const refusal = failed(await engine.handle(command("runs.start", { ...request(avatarId, ["home"], 4), acceptedWorstMicros: 4 * 3 * 60_000 })));
    expect(refusal.error.code).toBe("PRICE_CHANGED");
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("accepted at the 2K figure starts, capped at it, every slot on the route", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await boot(undefined, () => ({ hang: true }));
    const answer = ok(await engine.handle(command("runs.start", { ...request(avatarId, ["home"], 4), acceptedWorstMicros: 4 * 3 * 93_000 })));
    if (answer.type !== "runs.start") throw new Error(`expected a start, got ${answer.type}`);
    const plan = RunPlanSchema.parse(JSON.parse(readFileSync(join(dir(), "library", "runs", answer.result.runId, "plan.json"), "utf8")));
    expect({ cap: plan.capMicros, routed: plan.scenes.slots.every((slot) => "route" in slot && slot.route === "seedream") }).toEqual({ cap: 4 * 3 * 93_000, routed: true });
    ok(await engine.handle(command("runs.cancel", { runId: answer.result.runId })));
    await jobEnd(events, answer.result.jobId);
  });
});

// S5.R4-fix: the free image price of a count (`runs.estimateImages { avatarId, count }`) prices the «Смелая» share at the 2K unit when the caller names the level and the categories,
// by the same split the run estimate uses; without them it is the figure it always was.
describe("runs.estimateImages { avatarId, count, level, categories } for «Смелая»", () => {
  async function imagesFor(engine: Awaited<ReturnType<typeof boot>>["engine"], payload: Record<string, unknown>) {
    const answer = ok(await engine.handle(command("runs.estimateImages", payload)));
    if (answer.type !== "runs.estimateImages") throw new Error(`expected an images estimate, got ${answer.type}`);
    return answer.result.estimate;
  }

  test("«Ночнушки и бельё» 10 + «Пляж и бассейн» 10 are priced at the 2K unit, as the run estimate prices them", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 20, level: "bold", categories: ["nightwear", "beach"] });
    expect(images).toMatchObject({ worstMicros: 5_580_000, expectedMicros: 1_860_000, boldAttemptMicros: 93_000 });
    expect(images).toEqual(await estimateOf(engine, avatarId, ["nightwear", "beach"], 20));
  });

  // 5a.4 (S5.BA5, 2026-10-26, plan s5a4 I5.77, BA3 review H-1): «Смелая» is every category's, so a count at «Смелая» is priced at the 2K unit for every photo, as the run estimate prices
  // it. The two rows below told the pre-5a.4 rule (only the two «Смелая» categories' share: 4 590 000 µ$ for this split, and the owner's model for the five).
  test("every photo of a «Смелая» count is priced at the 2K unit: «Дом» 10 + «Ночнушки и бельё» 10", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 20, level: "bold", categories: ["home", "nightwear"] });
    expect(images).toMatchObject({ worstMicros: 5_580_000, expectedMicros: 1_860_000, boldAttemptMicros: 93_000 });
    expect(images).toEqual(await estimateOf(engine, avatarId, ["home", "nightwear"], 20));
  });

  test("the five at «Смелая» are priced at the 2K unit", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 10, level: "bold", categories: ["home", "travel"] });
    expect(images).toMatchObject({ worstMicros: 10 * 3 * 93_000, expectedMicros: 10 * 93_000, boldAttemptMicros: 93_000 });
  });

  test("the five at «Кокетливая» keep the owner's model price", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 10, level: "flirty", categories: ["home", "travel"] });
    expect(images.worstMicros).toBe(10 * 3 * 60_000);
    expect("boldAttemptMicros" in images).toBe(false);
  });

  test("a count with no level and no categories is the figure it always was", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 10 });
    expect(images.worstMicros).toBe(10 * 3 * 60_000);
    expect("boldAttemptMicros" in images).toBe(false);
  });

  test("a «Смелая» category below «Смелая» is refused for free, as the run estimate refuses it", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const refusal = failed(await engine.handle(command("runs.estimateImages", { avatarId, count: 4, level: "flirty", categories: ["nightwear"] })));
    expect(refusal.error).toMatchObject({ code: "VALIDATION", sceneReason: "bold-level-needed" });
  });

  test("a Seedream list without the 2K tier is PRICE_UNAVAILABLE for the bold scope", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot(livePrices(seedreamBody({ pricing: (rows) => rows.filter((row) => row.variant !== "high_resolution") })));
    const refusal = failed(await engine.handle(command("runs.estimateImages", { avatarId, count: 4, level: "bold", categories: ["nightwear"] })));
    expect(refusal.error).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });
});

// 5a.4 (S5.BA5, plan s5a4 §5.7 «a custom category, 20 photos», I5.77, BA3 review M-1): at «Смелая» a custom category's scenes are on the route and the bold writer writes every one,
// so a category the template covers below «Смелая» is priced with its writer at it: a custom 20 is 5 580 000 µ$ of photos and one bold chunk, 97 500 µ$ («до $5.68»).
describe("a custom category at «Смелая»", () => {
  const CUSTOM = "cat-covered-fixture" as const;
  const COVERED_POOL = {
    locations: ["a quiet bookshop", "a flower stall", "a corner cafe", "a bridge over the river", "a sunny terrace"].map((name) => ({
      name,
      times: ["midday" as const],
      activities: [{ text: "holding a mug", twoHanded: false }, { text: "browsing the shelves", twoHanded: false }],
      mirror: false,
    })),
    outfits: ["a cozy cardigan", "jeans and a tee", "a linen dress"],
    shotDeck: ["friend" as const, "friend" as const, "friend" as const, "friend" as const, "friend" as const],
  };

  async function seedCovered(): Promise<void> {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`cov${++seeded}`) });
    await library.categories.create({ categoryId: CUSTOM, name: "Покрытая", description: "кофейни", label: "Covered cafes", style: "phone", pool: COVERED_POOL, model: "x-ai/grok-4.3", spentMicros: 5_000 });
  }

  test("runs.estimate of a covered custom 20 at «Смелая»: 5 677 500 µ$, the photos and one bold writer chunk", async () => {
    const avatarId = await seedAvatar();
    await seedCovered();
    const { engine } = await boot();
    expect((await estimateOf(engine, avatarId, [CUSTOM], 20)).worstMicros).toBe(20 * 3 * 93_000 + 2 * 48_750);
  });

  test("the same 20 at «Кокетливая»: 3 600 000 µ$, no writer, the template covers it", async () => {
    const avatarId = await seedAvatar();
    await seedCovered();
    const { engine } = await boot();
    expect((await estimateOf(engine, avatarId, [CUSTOM], 20, "flirty")).worstMicros).toBe(20 * 3 * 60_000);
  });

  test("scenes.estimateCompose of the covered custom 20 at «Смелая»: one bold chunk, 97 500 µ$; at «Кокетливая» nothing", async () => {
    const avatarId = await seedAvatar();
    await seedCovered();
    const { engine } = await boot();
    const compose = async (level: string) => {
      const answer = ok(await engine.handle(command("scenes.estimateCompose", { avatarId, count: 20, categories: [CUSTOM], level })));
      if (answer.type !== "scenes.estimateCompose") throw new Error(`expected a compose estimate, got ${answer.type}`);
      return answer.result.estimate.worstMicros;
    };
    expect([await compose("bold"), await compose("flirty")]).toEqual([2 * 48_750, 0]);
  });
});
