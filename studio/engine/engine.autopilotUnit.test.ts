import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LaunchPreview, type LaunchDraftInput } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { IDLE_STEPS } from "./autopilot/steps";
import { unitPricesOf } from "./autopilot/prices";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { PriceBook } from "./money/prices";
import { fakeFetch } from "./openrouter/testing/fakes";
import { command, engineSettings, GOOD, KEY, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
useNativeGlobals();

// 5a.4 (S5.BA8a): `LaunchPreview.unitPhotoWorstMicros` is the launch math's own unit for one new photo at the draft's level (`unitPricesOf(…).photoWorstMicros`), which the «Смелая» month line
// divides the budget by. The real engine, a temp library, the dated fallback prices (the network is a double that answers nothing).

setDefaultTimeout(30_000);
const dir = useEngineDir("studio-engine-autopilot-unit-");

async function seedAvatar(withCustom: boolean): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("unit") });
  if (withCustom) await library.categories.create({ categoryId: CUSTOM, name: "Покрытая", description: "кофейни", label: "Covered cafes", style: "phone", pool: CUSTOM_POOL, model: "x-ai/grok-4.3", spentMicros: 5_000 });
  const avatar = await library.createAvatar({ name: "Ava", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

const CUSTOM = "cat-unit-fixture" as const;
const CUSTOM_POOL = {
  locations: ["a quiet bookshop", "a flower stall", "a corner cafe", "a bridge over the river", "a sunny terrace"].map((name) => ({
    name,
    times: ["midday" as const],
    activities: [{ text: "holding a mug", twoHanded: false }, { text: "browsing the shelves", twoHanded: false }],
    mirror: false,
  })),
  outfits: ["a cozy cardigan", "jeans and a tee", "a linen dress"],
  shotDeck: ["friend" as const, "friend" as const, "friend" as const, "friend" as const, "friend" as const],
};

async function previewOf(check: "off" | "on", over: Partial<LaunchDraftInput>, withCustom = false) {
  await mkdir(join(dir(), "export"), { recursive: true });
  const avatarId = await seedAvatar(withCustom);
  const net = fakeFetch(Array.from({ length: 64 }, () => () => ({ reject: new TypeError("fetch failed") })));
  const started = await startEngine(dir(), { key: KEY, init: { settings: engineSettings(dir(), { imageAgeCheck: check }) }, deps: { launchSteps: IDLE_STEPS, fetch: net.fetch } });
  await started.engine.settled();
  const draft: LaunchDraftInput = { avatarIds: [avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["home"], poses: { profile: false, back: false }, library: false, generate: true, sceneReview: false, stickers: false, ...over };
  const answer = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
  if (answer.type !== "autopilot.estimate") throw new Error("not an estimate");
  return LaunchPreview.parse(answer.result.preview);
}

const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", imageQuality: "low", textModel: "x-ai/grok-4.3" } as const;
const PRICED = { book: PriceBook.fallback(), asOf: "2026-10-12" };
const ownerUnit = (check: "off" | "on") => unitPricesOf(PRICED, MODELS, check, () => true, false).photoWorstMicros;

describe("the launch preview's unit for one new photo", () => {
  test("«Смелая» with «Дом» and the age check off: 279 000", async () => {
    expect((await previewOf("off", { level: "bold" })).unitPhotoWorstMicros).toBe(279_000);
  });

  test("«Смелая» with «Дом» and the age check on: 294 750", async () => {
    expect((await previewOf("on", { level: "bold" })).unitPhotoWorstMicros).toBe(294_750);
  });

  test("«Кокетливая»: the owner's model, not the Seedream unit", async () => {
    const unit = (await previewOf("off", { level: "flirty" })).unitPhotoWorstMicros;
    expect(unit).toBe(ownerUnit("off"));
    expect(unit).not.toBe(279_000);
  });

  // Review L-5: a custom category at «Смелая» is routed like the rest, so its photo is the same unit.
  test("«Смелая» with a custom category: the same unit as «Дом»", async () => {
    const preview = await previewOf("off", { level: "bold", categories: [CUSTOM] }, true);
    expect(preview.unitPhotoWorstMicros).toBe(279_000);
  });

  test("a launch that draws no new photo carries none", async () => {
    const preview = await previewOf("off", { level: "bold", generate: false, library: true });
    expect("unitPhotoWorstMicros" in preview).toBe(false);
  });
});
