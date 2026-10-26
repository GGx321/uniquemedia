import { describe, expect, test } from "bun:test";
import { SceneSetView } from "../../shared/engine";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import { isWaterPlaceName } from "../../shared/scenes/custom";
import { StoredCategory } from "../library/categories";
import type { StoredSceneSet } from "../library/sceneSets";
import { POOLS, type Pool } from "../scenes";
import { poolOf } from "../scenes/poolGen";
import { fakeLedger } from "./testing/fakeLedger";
import { planSceneSet, type ComposeInput } from "./compose";
import { planReviewWrite } from "./reviewPlan";
import { buildSceneSetView } from "./view";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA3, plan s5a4 §5.1.2, §8 BA3, BA1 review hand-off): «Другая сцена» on a «Смелая» set draws through `poolOfSlot`. A routed scene of the five stays in its companion, a scene stored
// before 5a.4 stays in the ordinary pool, a routed custom scene keeps its branch and redraws its world (the redraw drops the world exactly when it drops the route), and an imported avatar's
// redraw holds no implied cover. The scene review shows the world of a routed custom scene (r2.2 D6).

const BASE = { schemaVersion: 1 as const, revision: 4, createdAt: "2026-10-26T10:00:00.000Z", updatedAt: "2026-10-26T10:00:00.000Z" };
const CUSTOM = "cat-paris-trip";
const PARIS_POOL: Pool = {
  locations: [
    { name: "a corner cafe in Paris", times: ["morning"], activities: [{ text: "reading a menu", twoHanded: false }, { text: "browsing the menu", twoHanded: false }], mirror: true },
    { name: "a hotel pool in Nice", times: ["midday"], activities: [{ text: "floating on her back", twoHanded: false }, { text: "sitting by the edge", twoHanded: false }] },
    { name: "a bridge over the Seine", times: ["evening"], activities: [{ text: "leaning on the railing", twoHanded: false }, { text: "taking a slow walk", twoHanded: false }] },
    { name: "the sundeck of a sailing yacht", times: ["golden hour"], activities: [{ text: "watching the waves", twoHanded: false }, { text: "coiling a rope", twoHanded: false }] },
    { name: "a tiny bookshop", times: ["midday"], activities: [{ text: "browsing a shelf", twoHanded: false }, { text: "reading a spine", twoHanded: false }] },
  ],
  outfits: ["a beige trench coat and jeans", "a long cardigan and trousers", "a striped tee and a midi skirt"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};

const STORED_CATEGORY: StoredCategory = StoredCategory.parse({
  schemaVersion: 1,
  categoryId: CUSTOM,
  name: "Paris",
  description: "a trip to Paris and Nice",
  label: "Paris trip",
  style: "phone",
  pool: {
    locations: PARIS_POOL.locations.map((l) => ({ name: l.name, times: l.times, activities: l.activities, mirror: l.mirror === true })),
    outfits: PARIS_POOL.outfits,
    shotDeck: PARIS_POOL.shotDeck,
  },
  model: "x-ai/grok-4.3",
  spentMicros: 0,
  createdAt: "2026-10-26T10:00:00.000Z",
  updatedAt: "2026-10-26T10:00:00.000Z",
});

function compose(over: Partial<ComposeInput>): StoredSceneSet {
  const planned = planSceneSet({
    sceneSetId: "set-aaaa-0001",
    avatarId: "avatar-aaaa-0001",
    runId: "run-aaaa-0001",
    jobId: "job-aaaa-0001",
    count: 20,
    categories: ["home"],
    pools: { ...POOLS, [CUSTOM]: poolOf(STORED_CATEGORY.pool) },
    snapshots: [],
    recentPairs: [],
    textModel: "x-ai/grok-4.3",
    ...over,
  });
  return { ...BASE, ...planned };
}

async function redrawn(set: StoredSceneSet, impliedNudity?: boolean) {
  const ids = set.scenes.map((s) => s.sceneId);
  const plan = await planReviewWrite({ set, target: { kind: "rewrite", sceneIds: ids, redraw: true }, ledger: fakeLedger({}), customCategories: async () => [STORED_CATEGORY], ...(impliedNudity === undefined ? {} : { impliedNudity }) });
  const record = plan.begin(set, "job-aaaa-0002").reviewWrites?.find((r) => r.k === plan.k);
  if (record === undefined || record.kind !== "rewrite") throw new Error("the plan recorded no rewrite");
  return record;
}

describe("«Другая сцена» on a «Смелая» set", () => {
  test("a routed scene of the five redraws inside its companion, at its level, on the route", async () => {
    const set = compose({ level: "bold", impliedNudity: true, categories: ["home", "travel", "shoot", "glam", "fit"] });
    expect(set.scenes.every((s) => s.origin === "planned" && s.slot.route === "seedream")).toBe(true);
    const record = await redrawn(set, true);
    expect(record.slots).toHaveLength(set.scenes.length);
    for (const slot of record.slots) {
      const was = set.scenes.find((s) => s.sceneId === slot.slotIndex);
      const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
      const category = slot.category as keyof typeof BOLD_COMPANIONS;
      expect({ companion: hit?.bank === BOLD_COMPANIONS[category], route: slot.route, level: slot.level }).toEqual({ companion: true, route: "seedream", level: was?.origin === "planned" ? was.slot.level : undefined });
    }
  });

  test("a scene stored before 5a.4, drawn as «Кокетливая» at a «Смелая» request, redraws in the ordinary pool at its flirty level", async () => {
    const set = compose({ level: "flirty", categories: ["home"] });
    const old: StoredSceneSet = { ...set, request: { ...set.request, level: "bold" } };
    const record = await redrawn(old);
    for (const slot of record.slots) {
      const was = old.scenes.find((s) => s.sceneId === slot.slotIndex);
      expect({ route: slot.route, level: slot.level }).toEqual({ route: undefined, level: was?.origin === "planned" ? was.slot.level : undefined });
      expect(POOLS.home.locations.some((l) => l.name === slot.location)).toBe(true);
    }
  });

  test("a routed custom scene keeps its branch, redraws its world inside the category's own places, and parses", async () => {
    const set = compose({ level: "bold", impliedNudity: true, categories: [CUSTOM], count: 20, snapshots: [{ ref: CUSTOM, name: "Paris", label: "Paris trip", style: "phone" }] });
    const record = await redrawn(set, true);
    const waterBank = (location: string): boolean => CUSTOM_BOLD_BANKS.water.places.some((p) => p.name === location);
    expect(set.scenes.some((s) => s.origin === "planned" && waterBank(s.slot.location))).toBe(true);
    for (const slot of record.slots) {
      const was = set.scenes.find((s) => s.sceneId === slot.slotIndex);
      if (was?.origin !== "planned") throw new Error("not planned");
      expect({ water: waterBank(slot.location), route: slot.route }).toEqual({ water: waterBank(was.slot.location), route: "seedream" });
      expect(PARIS_POOL.locations.map((l) => l.name)).toContain(slot.world as string);
      if (waterBank(slot.location)) expect(isWaterPlaceName(slot.world as string)).toBe(true);
    }
  });

  test("an imported avatar's redraw holds no implied cover; the flag is read from the plan's input, default false", async () => {
    const set = compose({ level: "bold", impliedNudity: true, categories: ["home", "travel", "glam"], count: 30 });
    const isImpliedAt = (s: { category: string; location: string; activity: string; outfit: string; route?: "seedream" | undefined }): boolean => {
      const hit = bankPlaceOf({ category: s.category, route: s.route, location: s.location, activity: s.activity });
      return hit?.moment?.tier === "implied" || hit?.bank.outfits.find((o) => o.text === s.outfit)?.tier === "implied";
    };
    for (const flag of [undefined, false] as const) {
      const record = await redrawn(set, flag);
      expect(record.slots.filter(isImpliedAt)).toEqual([]);
    }
  });
});

describe("the scene review shows the world (r2.2 D6)", () => {
  const view = (set: StoredSceneSet) => {
    const built = buildSceneSetView(set, { ledger: fakeLedger({}), inFlight: new Set(), live: null, used: false });
    expect(SceneSetView.safeParse(built).success).toBe(true);
    return built;
  };

  test("a routed custom scene's place carries its slot's world", () => {
    const set = compose({ level: "bold", categories: [CUSTOM], snapshots: [{ ref: CUSTOM, name: "Paris", label: "Paris trip", style: "phone" }] });
    const scenes = view(set).scenes;
    for (const scene of scenes) {
      const stored = set.scenes.find((s) => s.sceneId === scene.sceneId);
      if (stored?.origin !== "planned" || scene.place === null) throw new Error("a planned scene has a place");
      expect(scene.place.world).toBe(stored.slot.world);
      expect(scene.place.world).toBeDefined();
    }
  });

  test("every other scene's place has no world", () => {
    for (const set of [compose({ level: "bold", categories: ["home", "nightwear", "beach"] }), compose({ level: "flirty", categories: ["home"] })]) {
      for (const scene of view(set).scenes) expect(scene.place !== null && "world" in scene.place).toBe(false);
    }
  });
});
