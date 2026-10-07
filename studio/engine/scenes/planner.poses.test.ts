import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { plan, planWithPools, type PlanInput } from "./planner";
import { POOLS, type Pool } from "./pools";
import { isPhoneInHandShot, type PlanSlot, type Pose } from "./schema";
import type { Shot } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.8a: a custom category whose pool carries `poses` draws every slot's pose from that list, whatever the run's «Ракурсы» toggles say; the toggles keep
// governing the built-ins and a custom category without `poses`. A selfie or a mirror shot faces the camera, so a slot that draws back or profile takes a
// shot nobody holds a phone for: another shot of the category's deck, or a friend when the deck has none.

const ANGLED = "cat-lying-down";
const PLAIN = "cat-paris-cafes";

const PLACES: Pool["locations"] = [
  { name: "a sunny bedroom", times: ["morning", "midday"], activities: [{ text: "lying on her stomach, texting", twoHanded: false }, { text: "lying on her stomach, writing", twoHanded: true }] },
  { name: "a bedroom with a tall mirror", times: ["evening"], activities: [{ text: "lying on her stomach, reading", twoHanded: false }], mirror: true },
  { name: "a living room rug", times: ["midday", "evening"], activities: [{ text: "lying on her stomach, drawing", twoHanded: true }, { text: "lying on her stomach, resting", twoHanded: false }] },
  { name: "a sofa by the window", times: ["golden hour"], activities: [{ text: "lying on her stomach, scrolling", twoHanded: false }] },
  { name: "a quiet balcony mat", times: ["morning"], activities: [{ text: "lying on her stomach, thinking", twoHanded: false }] },
];
const OUTFITS = ["home shorts and a tank top", "a soft hoodie and shorts", "a cotton tee and joggers"];

function poolWith(over: Partial<Pool> = {}): Pool {
  return { locations: PLACES, outfits: OUTFITS, shotDeck: ["friend", "selfie", "mirror", "candid", "friend"], ...over };
}

const OFF = { profile: false, back: false };
const ON = { profile: true, back: true };

function planOf(pool: Pool, over: Partial<PlanInput> = {}): PlanSlot[] {
  return planWithPools({ seed: 1, count: 20, categories: [ANGLED], ...over }, { ...POOLS, [ANGLED]: pool }).slots;
}

const seeds = Array.from({ length: 150 }, (_, i) => i * 7919 + 1);
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const slotsOf = (slots: readonly PlanSlot[]): unknown[] => slots.map(({ slotIndex: _i, attemptIdBase: _b, ...rest }) => rest);

describe("a category with poses [back]", () => {
  test("every slot of every seed faces away", () => {
    for (const seed of seeds) for (const slot of planOf(poolWith({ poses: ["back"] }), { seed })) expect(slot.pose).toBe("back");
  });

  test("every one of them is a shot nobody holds a phone for", () => {
    for (const seed of seeds) for (const slot of planOf(poolWith({ poses: ["back"] }), { seed })) expect(isPhoneInHandShot(slot.shot)).toBe(false);
  });

  test("the run's toggles do not matter: all off and all on plan the same scenes", () => {
    const pool = poolWith({ poses: ["back"] });
    for (const seed of [1, 42, 2026]) expect(planOf(pool, { seed, poses: OFF })).toEqual(planOf(pool, { seed, poses: ON }));
  });

  test("with no toggles given at all the poses still come from the category", () => {
    const slots = planOf(poolWith({ poses: ["back"] }));
    expect(new Set(slots.map((s) => s.pose))).toEqual(new Set<Pose>(["back"]));
  });

  test("the replacement shot is one of the deck's own non-selfie shots", () => {
    const shots = new Set<Shot>();
    for (const seed of seeds) for (const slot of planOf(poolWith({ poses: ["back"] }), { seed })) shots.add(slot.shot);
    expect([...shots].sort()).toEqual(["candid", "friend"]);
  });

  test("a deck of selfies and mirrors only falls back to a friend (the category is finished as a phone photo, so never the photographer)", () => {
    const pool = poolWith({ poses: ["back"], shotDeck: ["selfie", "mirror", "selfie", "mirror", "selfie"] });
    for (const seed of seeds.slice(0, 30)) for (const slot of planOf(pool, { seed })) expect(slot.shot).toBe("friend");
  });

  test("a deck of photographers keeps them", () => {
    const pool = poolWith({ poses: ["back"], shotDeck: ["photographer", "photographer", "photographer", "candid", "candid"] });
    const shots = new Set(planOf(pool, { count: 50 }).map((s) => s.shot));
    expect([...shots].sort()).toEqual(["candid", "photographer"]);
  });

  test("a two-handed activity may now appear: nobody holds a phone", () => {
    const twoHanded = new Set<string>();
    for (const seed of seeds) for (const slot of planOf(poolWith({ poses: ["back"] }), { seed })) twoHanded.add(slot.activity);
    expect(twoHanded.has("lying on her stomach, writing")).toBe(true);
  });
});

describe("a category with several poses", () => {
  test("draws only from its list, and uses every one over enough slots", () => {
    const seen = new Set<Pose>();
    for (const seed of seeds.slice(0, 20)) for (const slot of planOf(poolWith({ poses: ["front", "profile"] }), { seed, poses: OFF })) seen.add(slot.pose);
    expect([...seen].sort()).toEqual(["front", "profile"]);
  });

  test("a slot that draws front keeps the deck's shot, a selfie included", () => {
    const shots = new Set<Shot>();
    for (const seed of seeds.slice(0, 40)) for (const slot of planOf(poolWith({ poses: ["front", "back"] }), { seed })) if (slot.pose === "front") shots.add(slot.shot);
    expect(shots.has("selfie")).toBe(true);
    expect(shots.has("mirror")).toBe(true);
  });

  test("a list of front and three-quarter alone leaves the deck's shots as they are", () => {
    const withPoses = planOf(poolWith({ poses: ["front", "three-quarter"] }));
    const without = planOf(poolWith());
    expect(withPoses.map((s) => s.shot)).toEqual(without.map((s) => s.shot));
  });

  test("a selfie or a mirror shot never faces away or sideways, whatever the list, the deck, the seed or the toggles", () => {
    const lists: Pose[][] = [["back"], ["profile"], ["back", "profile"], ["front", "back"], ["three-quarter", "profile"], ["front", "three-quarter", "profile", "back"]];
    const decks: Shot[][] = [
      ["friend", "selfie", "mirror", "candid", "friend"],
      ["selfie", "mirror", "selfie", "mirror", "selfie"],
      ["selfie", "selfie", "selfie", "selfie", "selfie"],
      ["photographer", "photographer", "photographer", "candid", "candid"],
    ];
    for (const poses of lists) {
      for (const shotDeck of decks) {
        for (const seed of seeds.slice(0, 25)) {
          for (const toggles of [OFF, ON]) {
            for (const slot of planOf(poolWith({ poses, shotDeck }), { seed, poses: toggles, count: 12 })) {
              if (isPhoneInHandShot(slot.shot)) expect(["front", "three-quarter"]).toContain(slot.pose);
              expect(poses).toContain(slot.pose);
            }
          }
        }
      }
    }
  });

  test("a mirror shot stays on a mirror place", () => {
    for (const seed of seeds.slice(0, 60)) for (const slot of planOf(poolWith({ poses: ["front", "back"] }), { seed })) if (slot.shot === "mirror") expect(slot.location).toBe("a bedroom with a tall mirror");
  });

  test("the same seed plans the same scenes, another seed other ones", () => {
    const pool = poolWith({ poses: ["front", "three-quarter", "profile", "back"] });
    expect(planOf(pool, { seed: 5 })).toEqual(planOf(pool, { seed: 5 }));
    expect(planOf(pool, { seed: 5 })).not.toEqual(planOf(pool, { seed: 6 }));
  });
});

describe("what the poses do not touch", () => {
  test("a built-in category next to an angled one plans exactly as it does alone", () => {
    const mixed = planWithPools({ seed: 77, count: 20, categories: ["home", ANGLED], poses: OFF }, { ...POOLS, [ANGLED]: poolWith({ poses: ["back"] }) }).slots;
    const alone = plan({ seed: 77, count: 10, categories: ["home"], poses: OFF });
    expect(mixed.filter((s) => s.category === "home")).toEqual(alone.slots);
  });

  test("the run's toggles still govern the built-ins in the same plan", () => {
    const pools = { ...POOLS, [ANGLED]: poolWith({ poses: ["front"] }) };
    const poseOf = (toggles: typeof OFF) => planWithPools({ seed: 3, count: 200, categories: ["home", ANGLED], poses: toggles }, pools).slots.filter((s) => s.category === "home").map((s) => s.pose);
    expect(new Set(poseOf(OFF))).not.toContain("back");
    expect(new Set(poseOf(ON))).toContain("back");
  });

  test("a custom category without poses keeps today's plan, byte for byte (hash taken from main before CS.8a)", () => {
    const pool = poolWith();
    const all: unknown[] = [];
    for (const seed of [1, 7, 42, 2026, 123456789]) {
      for (const count of [1, 7, 20, 33]) {
        all.push(slotsOf(planOf(pool, { seed, count })));
        all.push(slotsOf(planOf(pool, { seed, count, poses: ON })));
      }
    }
    expect(sha(all)).toBe("87f82156af8ed1fcce12cc3abb15c42e8830a1c95e929e3897a992b9808d9553");
  });

  test("a custom category without poses still follows the toggles", () => {
    const off = planOf(poolWith(), { count: 100, poses: OFF }).map((s) => s.pose);
    const on = planOf(poolWith(), { count: 100, poses: ON }).map((s) => s.pose);
    expect(new Set(off)).not.toContain("back");
    expect(new Set(on)).toContain("back");
  });

  test("an unrelated custom category without poses is not turned around by its neighbour's poses", () => {
    const pools = { ...POOLS, [ANGLED]: poolWith({ poses: ["back"] }), [PLAIN]: poolWith() };
    const slots = planWithPools({ seed: 11, count: 40, categories: [ANGLED, PLAIN], poses: OFF }, pools).slots;
    expect(new Set(slots.filter((s) => s.category === PLAIN).map((s) => s.pose))).not.toContain("back");
    expect(new Set(slots.filter((s) => s.category === ANGLED).map((s) => s.pose))).toEqual(new Set<Pose>(["back"]));
  });
});
