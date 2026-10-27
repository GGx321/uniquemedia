import { describe, expect, test } from "bun:test";
import { planForAvatar } from "../../engine/scenes/planner";
import { POOLS } from "../../engine/scenes/pools";
import type { PlanSlot } from "../../engine/scenes/schema";
import type { PlannerCategory } from "../../engine/scenes/types";
import { splitCount, type AvatarSummary, type CategoryRef, type SceneSetView, type SceneView } from "../../shared/engine";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { BANKS } from "../../shared/scenes/banks";
import { BOLD_COMPANIONS } from "../../shared/scenes/banks/companions";
import type { BankCategory } from "../../shared/scenes/banks/types";
import { levelCountsOf, tierSpreadOf, type LevelCounts } from "../../shared/scenes/level";
import { slotCoverageOf } from "../../shared/scenes/template";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { BANK_OF } from "./mockBankScenes";
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

function mockOf(): Mock {
  return makeMock({ avatars: [MIA, STUDIO], photos: [] });
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
/** A scene as the bank lookup reads it. */
const lookupOf = (scene: SceneView) => ({ category: bankNameOf(scene), route: scene.route, location: scene.place?.location, activity: scene.place?.activity });

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
