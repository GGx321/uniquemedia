import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import type { FetchCall, Reply } from "./openrouter/testing/fakes";
import { plan as planScenes } from "./scenes";
import { buildRunPlan, RunPlanSchema } from "./runs/plan";
import type { QaGate } from "./runs/qa";
import { command, engineSettings, failed, GOOD, network, ok, OFFLINE, portraitPng, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
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

async function boot(prices?: (call: FetchCall) => Reply) {
  const net = network(prices === undefined ? {} : { prices });
  const settings = engineSettings(dir(), { imageAgeCheck: "off", imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null });
  const started = await startEngine(dir(), { init: { settings }, net, deps: { qaGates: [faceGate()] } });
  return { ...started, net };
}

function request(avatarId: string, categories: string[], count: number) {
  return { avatarId, count, categories, level: "bold", poses: { profile: false, back: false } };
}

async function estimateOf(engine: Awaited<ReturnType<typeof boot>>["engine"], avatarId: string, categories: string[], count: number) {
  const answer = ok(await engine.handle(command("runs.estimate", request(avatarId, categories, count))));
  if (answer.type !== "runs.estimate") throw new Error(`expected an estimate, got ${answer.type}`);
  return answer.result.estimate;
}

describe("runs.estimate for «Смелая» categories", () => {
  test("«Ночнушки и бельё» 10: worst 2 790 000 µ$, expected 930 000 µ$, at list", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect(await estimateOf(engine, avatarId, ["nightwear"], 10)).toMatchObject({ worstMicros: 2_790_000, expectedMicros: 930_000 });
  });

  test("«Дом» 10 + «Ночнушки и бельё» 10: worst 4 590 000 µ$", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect(await estimateOf(engine, avatarId, ["home", "nightwear"], 20)).toMatchObject({ worstMicros: 4_590_000, expectedMicros: 1_530_000 });
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

  test("a run with no «Смелая» category has no boldAttemptMicros and the figure it always had", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const estimate = await estimateOf(engine, avatarId, ["home", "travel"], 10);
    expect("boldAttemptMicros" in estimate).toBe(false);
    expect(estimate.worstMicros).toBe(10 * 3 * 60_000);
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
  ])("still estimates a run with no «Смелая» category (%s)", async (_name, body) => {
    const avatarId = await seedAvatar();
    const { engine } = await boot(livePrices(body()));
    expect(await estimateOf(engine, avatarId, ["home"], 4)).toMatchObject({ worstMicros: 4 * 3 * 60_000 });
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

  test("only the «Смелая» share is priced at the 2K unit: «Дом» 10 + «Ночнушки и бельё» 10", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    expect(await imagesFor(engine, { avatarId, count: 20, level: "bold", categories: ["home", "nightwear"] })).toMatchObject({ worstMicros: 4_590_000, expectedMicros: 1_530_000 });
  });

  test("a «Смелая» level with only ordinary categories keeps the owner's model price", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await boot();
    const images = await imagesFor(engine, { avatarId, count: 10, level: "bold", categories: ["home", "travel"] });
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
