import { describe, expect, test } from "bun:test";
import { planForAvatar } from "../../engine/scenes/planner";
import { poolOf } from "../../engine/scenes/poolGen";
import { POOLS } from "../../engine/scenes/pools";
import { PlanSlotSchema, type PlanSlot } from "../../engine/scenes/schema";
import type { PlannerCategory } from "../../engine/scenes/types";
import { boldReader, PLACE_PREPOSITIONS } from "../../engine/scenes/writer";
import { splitCount, type AvatarSummary, type CategoryPool, type CategoryRef, type CategorySummary, type SceneSetView, type SceneView } from "../../shared/engine";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { BANKS } from "../../shared/scenes/banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import type { BankCategory } from "../../shared/scenes/banks/types";
import { isWaterPlaceName } from "../../shared/scenes/custom";
import { levelCountsOf, tierSpreadOf, type LevelCounts } from "../../shared/scenes/level";
import { slotCoverageOf } from "../../shared/scenes/template";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { BANK_OF, MOCK_PLACE_OPENERS } from "./mockBankScenes";
import { MIA, makeMock, unwrap, type Mock } from "./mockEngine.testkit";
useNativeGlobals();

// 5a.4 (S5.BA7, plan s5a4 §5.11, §8 BA7, I5.71-I5.74): the mock's «Смелая» on every category is the engine's. The mock keeps its own deterministic dealing (it cannot read the engine's seeded
// streams), so what is held equal is what both engines are bound to: the tiers counted over the whole request (`tierSpreadOf`), every scene of the five drawn from its companion on the
// route, the origin rule (an imported avatar, or one of unknown origin, never draws an implied cover; a Studio-created one can), and the coverage a template-written scene ends with.
// Each row plans the same request with the engine's own planner (`planForAvatar`) beside the mock's compose.

const WORST = 100_000_000;
/** An avatar made in Studio (the engine's `studioCreated`): the mock's summary says so. */
const STUDIO: AvatarSummary = { ...MIA, avatarId: "avatar-ava-0009", name: "Ava", masterPhotoId: "photo-ava-master", origin: "studio" };
/** The contract's refs of the five, and the engine's names for them. */
const FIVE = ["home", "travel", "shoot", "glam", "fit"] as const;
const PLANNER: Readonly<Record<(typeof FIVE)[number] | "nightwear" | "beach", PlannerCategory>> = { home: "home", travel: "travel", shoot: "photoshoot", glam: "glamour", fit: "fitness", nightwear: "nightwear", beach: "beach" };
const SEEDS = Array.from({ length: 12 }, (_, i) => 3 + i * 7_919);

/** A custom category with two water places of five (the world a custom «Смелая» scene is set in), as a library stores it. */
const TRIP = "cat-trip-fixture";
const TRIP_POOL: CategoryPool = {
  locations: [
    { name: "a corner cafe in Paris", times: ["morning"], activities: [{ text: "reading a menu", twoHanded: false }], mirror: false },
    { name: "a hotel pool in Nice", times: ["midday"], activities: [{ text: "floating on her back", twoHanded: false }], mirror: false },
    { name: "a bridge over the Seine", times: ["evening"], activities: [{ text: "leaning on the railing", twoHanded: false }], mirror: false },
    { name: "the sundeck of a sailing yacht", times: ["golden hour"], activities: [{ text: "watching the waves", twoHanded: false }], mirror: false },
    { name: "a tiny bookshop", times: ["midday"], activities: [{ text: "browsing a shelf", twoHanded: false }], mirror: true },
  ],
  outfits: ["a beige trench coat and jeans", "a long cardigan and trousers"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};
const TRIP_CATEGORY: CategorySummary = { categoryId: TRIP, name: "Поездка", description: "поездка", label: "Trip", style: "phone", pool: TRIP_POOL, model: "x-ai/grok-4.3", spentMicros: 0, createdAt: "2026-10-27T10:00:00.000Z", updatedAt: "2026-10-27T10:00:00.000Z" };
const WORLDS = TRIP_POOL.locations.map((l) => l.name);
const WATER_WORLDS = WORLDS.filter(isWaterPlaceName);

function mockOf(): Mock {
  return makeMock({ avatars: [MIA, STUDIO], photos: [], categories: [TRIP_CATEGORY] });
}

async function composed(m: Mock, avatar: AvatarSummary, count: number, categories: readonly CategoryRef[]): Promise<SceneSetView> {
  const made = await m.client.request("scenes.compose", { avatarId: avatar.avatarId, count, categories: [...categories], level: "bold", acceptedWorstMicros: WORST });
  if (!made.ok) throw new Error(`compose refused: ${made.error.code} ${made.error.detail ?? ""}`);
  m.scheduler.runAll();
  const got = await unwrap(m.client.request("scenes.get", { avatarId: avatar.avatarId }));
  if (got.sceneSet === null) throw new Error("no set");
  const view = got.sceneSet;
  await unwrap(m.client.request("scenes.discard", { sceneSetId: view.sceneSetId }));
  return view;
}

const tiersOf = (rows: readonly { level?: string | undefined }[]): LevelCounts => ({
  bold: rows.filter((s) => s.level === "bold").length,
  flirty: rows.filter((s) => s.level === "flirty").length,
  ordinary: rows.filter((s) => s.level === undefined).length,
});

/** The bank name of a contract ref (the mock's `BANK_OF`). */
const bankNameOf = (scene: SceneView): BankCategory => BANK_OF[scene.category as keyof typeof BANK_OF];
/** A scene as the bank lookup reads it: a built-in by its bank's name, a custom category by its id. */
const lookupOf = (scene: SceneView) => ({ category: scene.category in BANK_OF ? bankNameOf(scene) : scene.category, route: scene.route, location: scene.place?.location, activity: scene.place?.activity });

/** Whether a scene (mock) or a slot (engine) drew an implied cover: its moment, or its outfit, is `tier: "implied"`. */
function drewImplied(item: { category: string; route: "seedream" | undefined; location: string | undefined; activity: string | undefined; outfit: string | undefined }): boolean {
  const hit = bankPlaceOf(item);
  return hit?.moment?.tier === "implied" || hit?.bank.outfits.find((o) => o.text === item.outfit)?.tier === "implied";
}
const sceneImplied = (scene: SceneView): boolean => drewImplied({ ...lookupOf(scene), outfit: scene.place?.outfit });
const slotImplied = (slot: PlanSlot): boolean => drewImplied({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity, outfit: slot.outfit });

function engineSlots(seed: number, count: number, categories: readonly (keyof typeof PLANNER)[], studio: boolean): PlanSlot[] {
  return planForAvatar({ seed, count, categories: categories.map((c) => PLANNER[c]), level: "bold" }, POOLS, studio).slots;
}

describe("the five at «Смелая» on the mock are the engine's", () => {
  test.each([...FIVE])("%s alone, 1 to 30 scenes: the mix is levelCountsOf(n) on both engines, every scene is on the route and in its companion", async (ref) => {
    const m = mockOf();
    for (let n = 1; n <= 30; n++) {
      const view = await composed(m, MIA, n, [ref]);
      expect({ n, tiers: tiersOf(view.scenes) }).toEqual({ n, tiers: levelCountsOf(n) });
      expect({ n, engine: tiersOf(engineSlots(SEEDS[0] ?? 1, n, [ref], false)) }).toEqual({ n, engine: levelCountsOf(n) });
      for (const scene of view.scenes) {
        const hit = bankPlaceOf(lookupOf(scene));
        expect({ n, scene: scene.sceneId, route: scene.route, companion: hit?.moment !== undefined && hit.bank === BOLD_COMPANIONS[bankNameOf(scene) as keyof typeof BOLD_COMPANIONS] }).toEqual({ n, scene: scene.sceneId, route: "seedream", companion: true });
        expect(hit?.bank.outfits.some((o) => o.text === scene.place?.outfit)).toBe(true);
      }
    }
  });

  // r2.2 D1: the tiers are counted over the WHOLE request and spread over its categories. Requests whose spread has no tie to break, so the engine's seeded tie order cannot matter.
  test.each([
    [50, ["home", "travel", "shoot", "glam", "fit"]],
    [20, ["home", "travel"]],
    [30, ["home", "nightwear", "beach"]],
    [20, ["nightwear", "beach"]],
    [25, ["home", "travel", "shoot", "glam", "fit"]],
  ] as const)("%i scenes over %p: each category's tiers are the request's spread, on the mock and the engine", async (count, categories) => {
    const m = mockOf();
    const view = await composed(m, MIA, count, categories);
    const split = splitCount(count, [...categories]);
    const spread = tierSpreadOf(split);
    expect(tiersOf(view.scenes)).toEqual(levelCountsOf(count));
    for (const [i, { ref }] of split.entries()) {
      const own = view.scenes.filter((s) => s.category === ref);
      expect({ ref, tiers: tiersOf(own) }).toEqual({ ref, tiers: spread[i] });
    }
    for (const seed of SEEDS) {
      const slots = engineSlots(seed, count, categories, false);
      for (const [i, { ref }] of split.entries()) expect({ seed, ref, tiers: tiersOf(slots.filter((s) => s.category === PLANNER[ref as keyof typeof PLANNER])) }).toEqual({ seed, ref, tiers: spread[i] });
    }
  });

  test("20 over the five: 8 / 8 / 4 over the request on both engines, whatever the tie order gives each category", async () => {
    const view = await composed(mockOf(), MIA, 20, FIVE);
    expect(tiersOf(view.scenes)).toEqual({ bold: 8, flirty: 8, ordinary: 4 });
    for (const seed of SEEDS) expect(tiersOf(engineSlots(seed, 20, FIVE, false))).toEqual({ bold: 8, flirty: 8, ordinary: 4 });
  });

  test("every scene of a request over the five, nightwear and beach is on the route", async () => {
    const view = await composed(mockOf(), MIA, 70, [...FIVE, "nightwear", "beach"]);
    expect(view.scenes.every((s) => s.route === "seedream")).toBe(true);
    expect(engineSlots(SEEDS[1] ?? 1, 70, [...FIVE, "nightwear", "beach"], false).every((s) => s.route === "seedream")).toBe(true);
  });
});

describe("the origin rule on the mock is the engine's (I5.74)", () => {
  test("an imported avatar (no origin: the fail-closed side) never draws an implied cover, on the mock or the engine", async () => {
    const m = mockOf();
    for (const ref of [...FIVE, "nightwear"] as const) {
      const view = await composed(m, MIA, 100, [ref]);
      expect({ ref, implied: view.scenes.filter(sceneImplied).length }).toEqual({ ref, implied: 0 });
      for (const seed of SEEDS) expect({ ref, seed, implied: engineSlots(seed, 100, [ref], false).filter(slotImplied).length }).toEqual({ ref, seed, implied: 0 });
    }
  });

  test("a Studio-created avatar can draw one: the sheet in nightwear, and a cover in «Дом», on both engines", async () => {
    const m = mockOf();
    for (const ref of ["nightwear", "home"] as const) {
      const view = await composed(m, STUDIO, 100, [ref]);
      expect({ ref, mock: view.scenes.some(sceneImplied) }).toEqual({ ref, mock: true });
      expect({ ref, engine: SEEDS.some((seed) => engineSlots(seed, 100, [ref], true).some(slotImplied)) }).toEqual({ ref, engine: true });
    }
    const nightwear = await composed(m, STUDIO, 100, ["nightwear"]);
    expect(nightwear.scenes.some((s) => /\bsheet\b/.test(s.place?.outfit ?? "") || /\bsheet\b/.test(s.place?.activity ?? ""))).toBe(true);
  });

  test("every template-written scene ends with its coverage sentence by the avatar's origin", async () => {
    const m = mockOf();
    for (const avatar of [MIA, STUDIO]) {
      const studio = avatar.origin === "studio";
      const view = await composed(m, avatar, 70, [...FIVE, "nightwear", "beach"]);
      let differs = 0;
      for (const scene of view.scenes) {
        const slot = { ...lookupOf(scene), outfit: scene.place?.outfit ?? "" };
        const mine = slotCoverageOf(slot, studio);
        const other = slotCoverageOf(slot, !studio);
        const text = scene.text ?? "";
        if (mine !== other) differs += 1;
        // Where the two origins' sentences differ the scene says its own (none, for a Studio-created avatar whose class P-BA drew open) and never the other's.
        const ends = mine === other ? mine === undefined || text.endsWith(mine) : mine === undefined ? other === undefined || !text.endsWith(other) : text.endsWith(mine);
        expect({ origin: avatar.origin ?? "unknown", scene: scene.sceneId, written: scene.text !== null, ends }).toEqual({ origin: avatar.origin ?? "unknown", scene: scene.sceneId, written: true, ends: true });
      }
      // Not vacuous: the request holds scenes whose two origins say different things.
      expect({ origin: avatar.origin ?? "unknown", differs: differs > 0 }).toEqual({ origin: avatar.origin ?? "unknown", differs: true });
    }
  });
});

describe("below «Смелая» nothing moves", () => {
  test("a «Кокетливая» «Дом» set draws the ordinary bank, round(0.6 × n) flirty, no route", async () => {
    const m = mockOf();
    const made = await m.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 10, categories: ["home"], level: "flirty", acceptedWorstMicros: WORST });
    expect(made.ok).toBe(true);
    m.scheduler.runAll();
    const view = (await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    expect(view?.scenes.filter((s) => s.level === "flirty")).toHaveLength(6);
    for (const scene of view?.scenes ?? []) {
      expect(scene.route).toBeUndefined();
      expect(BANKS.home.places.some((p) => p.name === scene.place?.location && p.moments.some((mo) => mo.text === scene.place?.activity))).toBe(true);
    }
  });
});

/** The engine's plan slot of a mock scene (what its bold reader reads). */
function slotOfScene(scene: SceneView): PlanSlot {
  const place = scene.place;
  if (place === null) throw new Error("an own scene has no slot");
  return PlanSlotSchema.parse({
    slotIndex: scene.sceneId,
    category: scene.category,
    location: place.location,
    timeOfDay: place.timeOfDay,
    activity: place.activity,
    outfit: place.outfit,
    shot: scene.shot,
    pose: scene.pose,
    attemptIdBase: `slot-${scene.sceneId}`,
    repeatedPair: false,
    ...(scene.capture === undefined ? {} : { capture: scene.capture }),
    ...(scene.level === undefined ? {} : { level: scene.level }),
    ...(scene.route === undefined ? {} : { route: scene.route }),
    ...(place.world === undefined ? {} : { world: place.world }),
  });
}

const branchOf = (scene: { location: string | undefined }): "rooms" | "water" | undefined =>
  CUSTOM_BOLD_BANKS.water.places.some((p) => p.name === scene.location) ? "water" : CUSTOM_BOLD_BANKS.rooms.places.some((p) => p.name === scene.location) ? "rooms" : undefined;

describe("a custom category at «Смелая» on the mock is the engine's (plan s5a4 §5.3)", () => {
  const pools = { ...POOLS, [TRIP]: poolOf(TRIP_POOL) };
  const engineCustom = (seed: number, n: number, studio: boolean): PlanSlot[] => planForAvatar({ seed, count: n, categories: [TRIP], level: "bold" }, pools, studio).slots;
  /** w = ⌊(n × W + ⌊P/2⌋) / P⌋: the scenes «by the water» of n (W water places of P). */
  const wetOf = (n: number): number => Math.floor((n * WATER_WORLDS.length + Math.floor(WORLDS.length / 2)) / WORLDS.length);

  test("1 to 30 scenes: every scene is on the route with a world of the category's own; the split, the water worlds and the tiers are the engine's", async () => {
    const m = mockOf();
    expect(WATER_WORLDS).toEqual(["a hotel pool in Nice", "the sundeck of a sailing yacht"]);
    for (let n = 1; n <= 30; n++) {
      const view = await composed(m, MIA, n, [TRIP]);
      const scenes = view.scenes;
      const wet = scenes.filter((s) => branchOf({ location: s.place?.location }) === "water");
      expect({ n, routed: scenes.every((s) => s.route === "seedream"), branched: scenes.every((s) => branchOf({ location: s.place?.location }) !== undefined), wet: wet.length, tiers: tiersOf(scenes) }).toEqual({ n, routed: true, branched: true, wet: wetOf(n), tiers: levelCountsOf(n) });
      expect({ n, worlds: scenes.every((s) => WORLDS.includes(s.place?.world ?? "")), waterWorlds: wet.every((s) => WATER_WORLDS.includes(s.place?.world ?? "")) }).toEqual({ n, worlds: true, waterWorlds: true });
      for (const seed of SEEDS.slice(0, 3)) {
        const slots = engineCustom(seed, n, false);
        const engineWet = slots.filter((s) => branchOf({ location: s.location }) === "water");
        expect({ n, seed, routed: slots.every((s) => s.route === "seedream"), wet: engineWet.length, tiers: tiersOf(slots), waterWorlds: engineWet.every((s) => WATER_WORLDS.includes(s.world ?? "")) }).toEqual({ n, seed, routed: true, wet: wetOf(n), tiers: levelCountsOf(n), waterWorlds: true });
      }
    }
  });

  test("a «by the water» scene wears swimwear, never lingerie: every one of its outfits is the water bank's", async () => {
    const view = await composed(mockOf(), MIA, 30, [TRIP]);
    const wet = view.scenes.filter((s) => branchOf({ location: s.place?.location }) === "water");
    expect(wet.length).toBeGreaterThan(0);
    expect(wet.every((s) => CUSTOM_BOLD_BANKS.water.outfits.some((o) => o.text === s.place?.outfit))).toBe(true);
  });

  test("the set's view echoes each custom scene's world in its place (ScenePlace.world), and no other scene has one", async () => {
    const view = await composed(mockOf(), MIA, 30, ["home", TRIP]);
    const custom = view.scenes.filter((s) => s.category === TRIP);
    expect(custom.length).toBeGreaterThan(0);
    expect(custom.every((s) => typeof s.place?.world === "string")).toBe(true);
    expect(view.scenes.filter((s) => s.category !== TRIP).every((s) => s.place !== null && !("world" in s.place))).toBe(true);
  });

  test("an imported avatar draws no implied cover in the custom banks; a Studio-created one can", async () => {
    const m = mockOf();
    const imported = await composed(m, MIA, 100, [TRIP]);
    expect(imported.scenes.filter(sceneImplied)).toHaveLength(0);
    const studio = await composed(m, STUDIO, 100, [TRIP]);
    expect(studio.scenes.some(sceneImplied)).toBe(true);
  });

  test("every custom scene is the writer's, and its sentence passes the engine's bold reader, opens with its place's own preposition and ends with the coverage by origin", async () => {
    const m = mockOf();
    for (const avatar of [MIA, STUDIO]) {
      const studio = avatar.origin === "studio";
      const view = await composed(m, avatar, 40, [TRIP]);
      for (const scene of view.scenes) {
        const slot = slotOfScene(scene);
        const text = scene.text ?? "";
        const coverage = slotCoverageOf({ ...slot, route: slot.route }, studio);
        const sentence = coverage === undefined ? text : text.slice(0, text.length - coverage.length - 1);
        expect({ scene: scene.sceneId, ends: coverage === undefined || text.endsWith(` ${coverage}`) }).toEqual({ scene: scene.sceneId, ends: true });
        const read = boldReader(studio)(JSON.stringify({ scenes: [{ slotIndex: slot.slotIndex, sentence }] }), [slot]);
        expect({ scene: scene.sceneId, location: slot.location, read: read.ok ? "ok" : `${read.problems.join(",")}: ${sentence}` }).toEqual({ scene: scene.sceneId, location: slot.location, read: "ok" });
        if (read.ok) expect(read.sentences.get(slot.slotIndex)).toBe(text);
        const own = PLACE_PREPOSITIONS[slot.location]?.[0];
        if (own !== undefined) expect(sentence.toLowerCase().startsWith(`${own} ${slot.location}`)).toBe(true);
      }
    }
  });

  test("the mock's openers are the engine's: each «rooms» place opens with the first preposition PLACE_PREPOSITIONS gives it", () => {
    for (const place of CUSTOM_BOLD_BANKS.rooms.places) expect({ place: place.name, opener: MOCK_PLACE_OPENERS[place.name] }).toEqual({ place: place.name, opener: PLACE_PREPOSITIONS[place.name]?.[0] });
    expect(Object.keys(PLACE_PREPOSITIONS).every((name) => MOCK_PLACE_OPENERS[name] !== undefined)).toBe(true);
  });

  test("«Другая сцена» keeps a custom scene on the route in its branch and redraws its world; an old custom scene (no route) redraws with neither", async () => {
    const m = mockOf();
    const made = await m.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 10, categories: [TRIP], level: "bold", acceptedWorstMicros: WORST });
    expect(made.ok).toBe(true);
    m.scheduler.runAll();
    const before = (await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    if (before === null) throw new Error("no set");
    const ids = before.scenes.slice(0, 5).map((s) => s.sceneId);
    const sent = await m.client.request("scenes.write", { sceneSetId: before.sceneSetId, revision: before.revision, target: { kind: "rewrite", sceneIds: ids, redraw: true }, acceptedWorstMicros: WORST });
    expect(sent.ok).toBe(true);
    m.scheduler.runAll();
    const after = (await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    for (const id of ids) {
      const was = before.scenes.find((s) => s.sceneId === id);
      const now = after?.scenes.find((s) => s.sceneId === id);
      const wasBranch = branchOf({ location: was?.place?.location });
      expect({ id, route: now?.route, branch: branchOf({ location: now?.place?.location }), world: WORLDS.includes(now?.place?.world ?? ""), wetWorld: wasBranch !== "water" || WATER_WORLDS.includes(now?.place?.world ?? "") }).toEqual({ id, route: "seedream", branch: wasBranch, world: true, wetWorld: true });
    }
  });

  test("a scene stored before 5a.4 (no route) redraws in the category's own pool with neither a route nor a world, and a routed one keeps both", async () => {
    const m = makeMock({
      avatars: [MIA],
      photos: [],
      categories: [TRIP_CATEGORY],
      sceneSets: [
        {
          avatarId: MIA.avatarId,
          sceneSetId: "set-old-0001",
          count: 2,
          level: "bold",
          categories: [TRIP],
          scenes: [
            { category: TRIP, shot: "friend", pose: "front", place: { location: "a corner cafe in Paris", timeOfDay: "morning", activity: "reading a menu", outfit: "a beige trench coat and jeans" }, text: "An old sentence of the cafe." },
            { category: TRIP, shot: "friend", pose: "front", level: "bold", route: "seedream", place: { location: "her room", timeOfDay: "evening", activity: "sits up in bed, knees drawn up", outfit: "a sheer babydoll over a lace set", world: "a corner cafe in Paris" }, text: "In her room, she sits up in bed, knees drawn up." },
          ],
        },
      ],
    });
    const before = (await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    if (before === null) throw new Error("no set");
    const sent = await m.client.request("scenes.write", { sceneSetId: before.sceneSetId, revision: before.revision, target: { kind: "rewrite", sceneIds: [1, 2], redraw: true }, acceptedWorstMicros: WORST });
    expect(sent.ok).toBe(true);
    m.scheduler.runAll();
    const after = (await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    const [old, routed] = after?.scenes ?? [];
    expect({ route: old?.route, world: old?.place?.world, own: TRIP_POOL.locations.some((l) => l.name === old?.place?.location) }).toEqual({ route: undefined, world: undefined, own: true });
    expect({ route: routed?.route, branch: branchOf({ location: routed?.place?.location }), world: WORLDS.includes(routed?.place?.world ?? "") }).toEqual({ route: "seedream", branch: "rooms", world: true });
  });
});
