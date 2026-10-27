import { describe, expect, test } from "bun:test";
import { unitPricesOf } from "../../engine/autopilot/prices";
import { WRITER_BOLD_CALL, writerChunksMicros, writerExpectedMicros } from "../../engine/money/estimate";
import type { PricedBook } from "../../engine/money/priceCache";
import { PriceBook } from "../../engine/money/prices";
import { runEstimate, type RunModels } from "../../engine/runs/plan";
import { composeEstimate, reviewWriteEstimate } from "../../engine/sceneSets/estimate";
import { launchEstimate } from "../../shared/autopilot/estimate";
import type { CategoryPool, CategoryRef, CategorySummary, SceneLevel } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MIA, makeMock, unwrap, type Mock } from "./mockEngine.testkit";
useNativeGlobals();

// 5a.4 (S5.BA7, plan s5a4 §5.7, I5.77; BA5 review L-5): the mock prices «Смелая» as the engine does, figure for figure. Before, it priced it by CATEGORY: «Дом» × 20 at «Смелая» showed
// $1.20 / $3.60 (the owner's Grok quality model, as «Кокетливая») against the engine's $1.86 / $5.58, and a custom category's writer at the ordinary call. Now: every photo of a request at
// «Смелая» at the Seedream 2K unit, anything stored by its routes, the writer by mode (the bold call: 48 750 µ$ an attempt, its typical cost a term per request plus one per scene), no custom
// category covered by the template at «Смелая», and the launch unit by requests and scenes (`writerTypicalByRequests`). Each row asks the mock through its client and the engine through its
// own estimate functions at the bundled (fallback) prices, the owner's image model at Grok quality (60 000 µ$ an attempt).

const PRICED: PricedBook = { book: PriceBook.fallback(), asOf: "2026-09-24" };
const MODELS: RunModels = { imageModel: "x-ai/grok-imagine-image-quality", textModel: "x-ai/grok-4.3" };
const OWNER_IMAGE = 60_000;
const NO_POSES = { profile: false, back: false };

const TRIP = "cat-trip-fixture";
const TRIP_POOL: CategoryPool = {
  locations: [
    { name: "a corner cafe in Paris", times: ["morning"], activities: [{ text: "reading a menu", twoHanded: false }], mirror: false },
    { name: "a hotel pool in Nice", times: ["midday"], activities: [{ text: "floating on her back", twoHanded: false }], mirror: false },
    { name: "a bridge over the Seine", times: ["evening"], activities: [{ text: "leaning on the railing", twoHanded: false }], mirror: false },
    { name: "the sundeck of a sailing yacht", times: ["golden hour"], activities: [{ text: "watching the waves", twoHanded: false }], mirror: false },
    { name: "a quiet bookshop", times: ["midday"], activities: [{ text: "browsing a shelf", twoHanded: false }], mirror: true },
  ],
  outfits: ["a beige trench coat and jeans", "a long cardigan and trousers"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};
const TRIP_CATEGORY: CategorySummary = { categoryId: TRIP, name: "Поездка", description: "поездка", label: "Trip", style: "phone", pool: TRIP_POOL, model: "x-ai/grok-4.3", spentMicros: 0, createdAt: "2026-10-27T10:00:00.000Z", updatedAt: "2026-10-27T10:00:00.000Z" };
/** The template covers the fixture's pool below «Смелая» (every activity renders), so a row that reads the cover says what «Смелая» takes away. */
const covers = (ref: string): boolean => ref === TRIP;

function mockOf(): Mock {
  const m = makeMock({ avatars: [MIA], photos: [], categories: [TRIP_CATEGORY] });
  m.engine.setRunImagePrice(OWNER_IMAGE);
  return m;
}

const money = (e: { expectedMicros: number; worstMicros: number }) => ({ expected: e.expectedMicros, worst: e.worstMicros });

describe("runs.estimate: the mock's figure is the engine's", () => {
  test.each([
    ["«Дом» × 20 at «Смелая»", 20, ["home"], "bold", { expected: 1_860_000, worst: 5_580_000 }],
    ["the five, 4 each, at «Смелая»", 20, ["home", "travel", "shoot", "glam", "fit"], "bold", { expected: 1_860_000, worst: 5_580_000 }],
    ["a custom category × 20 at «Смелая»: one bold writer chunk on top", 20, [TRIP], "bold", { expected: 1_871_265, worst: 5_677_500 }],
    ["«Дом» × 20 at «Кокетливая»: the owner's model, as before", 20, ["home"], "flirty", { expected: 1_200_000, worst: 3_600_000 }],
  ] as const)("%s", async (_name, count, categories, level, figure) => {
    const request = { count, categories: [...categories] as CategoryRef[], level: level as SceneLevel };
    const engine = money(runEstimate(PRICED, MODELS, request, "off", covers));
    const mock = money((await unwrap(mockOf().client.request("runs.estimate", { avatarId: MIA.avatarId, poses: NO_POSES, ...request }))).estimate);
    expect({ engine, mock }).toEqual({ engine: figure, mock: figure });
  });
});

describe("scenes.estimateCompose: the mock's figure is the engine's", () => {
  test.each([
    ["a custom category × 20 at «Смелая»: one bold chunk, two attempts", 20, "bold", { expected: 11_265, worst: 97_500 }],
    ["a custom category × 30 at «Смелая»: two bold chunks", 30, "bold", { expected: composeEstimate(PRICED, MODELS.textModel, [{ ref: TRIP, count: 30 }], covers, "bold").expectedMicros, worst: 195_000 }],
    ["the same × 20 at «Кокетливая»: the template covers it, nothing to price", 20, "flirty", { expected: 0, worst: 0 }],
  ] as const)("%s", async (_name, count, level, figure) => {
    const engine = money(composeEstimate(PRICED, MODELS.textModel, [{ ref: TRIP, count }], covers, level));
    const mock = money((await unwrap(mockOf().client.request("scenes.estimateCompose", { avatarId: MIA.avatarId, count, categories: [TRIP], level }))).estimate);
    expect({ engine, mock }).toEqual({ engine: figure, mock: figure });
  });
});

describe("autopilot.estimate: the mock's launch figure is the engine's (the unit by requests and scenes)", () => {
  test.each([
    ["«Дом» at «Смелая»", ["home"], "bold"],
    ["a custom category at «Смелая»", [TRIP], "bold"],
    ["«Дом» at «Кокетливая»", ["home"], "flirty"],
  ] as const)("%s, 20 new photos", async (_name, categories, level) => {
    const m = mockOf();
    const draft = { avatarIds: [MIA.avatarId], videosPerAvatar: 4, mix: { single: 0, collage: 0, slides: 100 }, categories: [...categories] as CategoryRef[], level: level as SceneLevel, poses: NO_POSES, library: false, generate: true, sceneReview: false, stickers: false };
    const preview = (await unwrap(m.client.request("autopilot.estimate", { draft }))).preview;
    expect(preview.totals.toGenerate).toBe(20);
    const unit = unitPricesOf(PRICED, MODELS, "off", covers, level === "bold");
    const engine = money(launchEstimate([{ avatarId: MIA.avatarId, photos: 20, split: [{ ref: categories[0], count: 20 }] }], unit));
    expect({ mock: money(preview.estimate) }).toEqual({ mock: engine });
  });
});

describe("a stored «Смелая» set's writes: the mock's figure is the engine's", () => {
  test("«Дописать» of a custom set at «Смелая» left unwritten: one bold chunk at its two attempts", async () => {
    const m = makeMock({ avatars: [MIA], photos: [], categories: [TRIP_CATEGORY], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-bold-0001", count: 10, written: 0, stopped: "closed", level: "bold", categories: [TRIP] }] });
    const view = (await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    if (view === null) throw new Error("no set");
    const mock = money((await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target: { kind: "unwritten" } }))).estimate);
    const engine = { expected: Math.min(writerExpectedMicros(PRICED.book, WRITER_BOLD_CALL, 1, 10), writerChunksMicros(PRICED.book, WRITER_BOLD_CALL, 1)), worst: writerChunksMicros(PRICED.book, WRITER_BOLD_CALL, 1) };
    expect({ mock }).toEqual({ mock: engine });
    expect(engine.worst).toBe(97_500);
  });

  test("a rewrite of two custom «Смелая» scenes: one bold request at its two attempts (6 743 / 97 500)", async () => {
    const m = mockOf();
    const made = await m.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 10, categories: [TRIP], level: "bold", acceptedWorstMicros: 10_000_000 });
    expect(made.ok).toBe(true);
    m.scheduler.runAll();
    const view = (await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    if (view === null) throw new Error("no set");
    const mock = money((await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target: { kind: "rewrite", sceneIds: [1, 2], redraw: false } }))).estimate);
    const engine = money(reviewWriteEstimate(PRICED, MODELS.textModel, 2, 2, 2, "bold"));
    expect({ engine, mock }).toEqual({ engine: { expected: 6_743, worst: 97_500 }, mock: { expected: 6_743, worst: 97_500 } });
  });
});
