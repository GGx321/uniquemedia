import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { plan } from "./planner";
import type { PlanSlot } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9b2, plan s5a3 §6.2-§6.3, I5.26, I5.32): the real planner deals the two «Смелая» decks by the owner's capture and angle rules, whatever level a slot is
// drawn at (the level picks moments and outfits, never the deck: the mix and the bold draw arrive with S5.9c, which sweeps those). At home she shoots herself and a
// third of the frames hide her face behind the phone; at the beach she mostly asks someone; a category holds at most ⌊n/5⌋ frames that face away (profile or
// back), and she lies on her stomach only on her bed.

const SEEDS = Array.from({ length: 200 }, (_, i) => i * 7919 + 11);
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const isAway = (slot: PlanSlot): boolean => slot.pose === "profile" || slot.pose === "back";

describe.each(["nightwear", "beach"] as const)("%s: the deck and the angles", (category) => {
  test("a category plan of 1 to 30 holds at most ⌊n/5⌋ frames that face away", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      for (let count = 1; count <= 30; count++) expect({ count, away: plan({ seed, count, categories: [category], level: "bold" }).slots.filter(isAway).length <= Math.floor(count / 5) }).toEqual({ count, away: true });
    }
  });

  test("a plan of one deck's length deals exactly the deck's captures", () => {
    const deck = BANKS[category].captureDeck;
    for (const seed of SEEDS.slice(0, 50)) expect(plan({ seed, count: deck.length, categories: [category], level: "bold" }).slots.map(captureOf).sort()).toEqual([...deck].sort());
  });
});

describe("«Ночнушки и бельё» under the real planner", () => {
  const slots = SEEDS.flatMap((seed) => plan({ seed, count: 24, categories: ["nightwear"], level: "bold" }).slots);

  test("at home she shoots herself: never a friend's or a candid photo", () => {
    expect(slots.filter((s) => ["friend", "candid", "low-feet"].includes(captureOf(s)))).toEqual([]);
  });

  test("a third of the frames hide her face behind the phone", () => {
    expect(slots.filter((s) => captureOf(s) === "mirror-hidden").length / slots.length).toBeCloseTo(1 / 3, 5);
  });

  test("she lies on her stomach, and is seen over her shoulder or from above, only on her bed", () => {
    expect(slots.filter((s) => (["prone", "over-shoulder", "above"].includes(captureOf(s)) || /\bstomach\b|\bprone\b/.test(s.activity)) && s.location !== "her bed").map((s) => `${captureOf(s)} ${s.location}: ${s.activity}`)).toEqual([]);
  });
});

describe("«Пляж и бассейн» under the real planner", () => {
  const slots = SEEDS.flatMap((seed) => plan({ seed, count: 24, categories: ["beach"], level: "bold" }).slots);

  test("she mostly asks someone: half the frames are a friend's, and none is a mirror or a prone frame", () => {
    expect(slots.filter((s) => captureOf(s) === "friend").length / slots.length).toBeCloseTo(1 / 2, 5);
    expect(slots.filter((s) => ["mirror", "mirror-hidden", "prone", "over-shoulder", "above"].includes(captureOf(s)))).toEqual([]);
  });

  test("some frames face away, as the outside rule wants, and never more than the cap", () => {
    const away = slots.filter(isAway).length / slots.length;
    expect(away).toBeGreaterThan(0.05);
    expect(away).toBeLessThanOrEqual(0.2);
  });
});
