import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import type { BankCategory, BankPlace, Level, Moment, Outfit } from "../../shared/scenes/banks/types";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { atOrBelow, atSlotLevel, levelCountsOf } from "../../shared/scenes/level";
import { plan } from "./planner";
import type { PlanSlot } from "./schema";
import { ORDINARY_BUILT_INS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9c, plan s5a3 §7.2, I5.36-I5.38): the real planner draws «Смелая». Inside the two «Смелая» categories the mix is 20 / 40 / 40 (exact), a bold slot draws bold
// items and the rest draw up to their own level, never above it; stockings ride on bold slots only and only with the outfits the bank's bold legwear names; a slot is
// drawn on Seedream exactly when one of its items is. The five ordinary built-ins under «Смелая» plan as «Кокетливая», byte for byte.

const BOLD_BANKS = ["nightwear", "beach"] as const satisfies readonly BankCategory[];
const SEEDS = Array.from({ length: 24 }, (_, i) => i * 7919 + 5);
const SHARES = [0, 15, 30] as const;

interface Drawn {
  slot: PlanSlot;
  place: BankPlace;
  moment: Moment;
  outfit: Outfit;
  capture: Capture;
}

function drawnOf(category: BankCategory, slot: PlanSlot): Drawn {
  const bank = BANKS[category];
  const place = bank.places.find((p) => p.name === slot.location);
  const moment = place?.moments.find((m) => m.text === slot.activity);
  const outfit = bank.outfits.find((o) => o.text === slot.outfit);
  if (place === undefined || moment === undefined || outfit === undefined) throw new Error(`${category}: slot ${slot.slotIndex} names an item the bank does not have`);
  return { slot, place, moment, outfit, capture: slot.capture ?? captureOfShot(slot.shot) };
}

const levelOf = (slot: PlanSlot): Level => slot.level ?? "ordinary";
const boldPlan = (category: BankCategory, seed: number, count: number, legsShare: 0 | 15 | 30 = 0): Drawn[] => plan({ seed, count, categories: [category], level: "bold", legsShare }).slots.map((slot) => drawnOf(category, slot));

describe("the mix inside a «Смелая» category is exact (I5.36)", () => {
  for (const category of BOLD_BANKS) {
    test(`${category}: 1 to 40 slots hold levelCountsOf(n) bold, flirty and ordinary slots, at every legs share`, () => {
      for (const seed of SEEDS.slice(0, 8)) {
        for (const legsShare of SHARES) {
          for (let count = 1; count <= 40; count++) {
            const levels = boldPlan(category, seed, count, legsShare).map((d) => levelOf(d.slot));
            const got = { ordinary: levels.filter((l) => l === "ordinary").length, flirty: levels.filter((l) => l === "flirty").length, bold: levels.filter((l) => l === "bold").length };
            expect({ count, legsShare, got }).toEqual({ count, legsShare, got: levelCountsOf(count) });
          }
        }
      }
    });

    test(`${category}: 100 slots are 40 bold, 40 flirty and 20 ordinary`, () => {
      for (const seed of SEEDS) {
        const levels = boldPlan(category, seed, 100).map((d) => levelOf(d.slot));
        expect([levels.filter((l) => l === "bold").length, levels.filter((l) => l === "flirty").length, levels.filter((l) => l === "ordinary").length]).toEqual([40, 40, 20]);
      }
    });
  }

  test("a run of both «Смелая» categories holds each category's own counts", () => {
    for (const seed of SEEDS) {
      const slots = plan({ seed, count: 25, categories: ["nightwear", "beach"], level: "bold" }).slots;
      for (const category of BOLD_BANKS) {
        const own = slots.filter((s) => s.category === category);
        const counts = levelCountsOf(own.length);
        expect(own.filter((s) => s.level === "bold")).toHaveLength(counts.bold);
        expect(own.filter((s) => s.level === "flirty")).toHaveLength(counts.flirty);
      }
    }
  });

  test("bold slots are drawn uniformly over the category: legs and face-hidden frames are among them", () => {
    const frames = SEEDS.flatMap((seed) => boldPlan("nightwear", seed, 30, 30)).filter((d) => levelOf(d.slot) === "bold");
    expect(frames.some((d) => d.slot.framing === "legs")).toBe(true);
    expect(frames.some((d) => d.capture === "mirror-hidden")).toBe(true);
    expect(frames.some((d) => d.capture === "above")).toBe(true);
  });

  test("the same input plans the same slots", () => {
    for (const category of BOLD_BANKS) expect(boldPlan(category, 77, 40, 15).map((d) => d.slot)).toEqual(boldPlan(category, 77, 40, 15).map((d) => d.slot));
  });

  test("a «Смелая» category planned at «Кокетливая» or «Обычная» holds no bold slot and no Seedream stockings: the level is the request's", () => {
    for (const category of BOLD_BANKS) {
      for (const level of ["ordinary", "flirty"] as const) {
        const slots = SEEDS.flatMap((seed) => plan({ seed, count: 30, categories: [category], level }).slots);
        expect(slots.filter((s) => s.level === "bold")).toEqual([]);
        expect(slots.filter((s) => s.level !== undefined && s.level !== level)).toEqual([]);
      }
    }
  });
});

describe("the five ordinary built-ins under «Смелая» are «Кокетливая», byte for byte (I5.36)", () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i * 104729 + 3);
  for (const category of ORDINARY_BUILT_INS) {
    test(`${category}: every size from 1 to 30, 200 seeds`, () => {
      for (const seed of seeds) for (let count = 1; count <= 30; count++) expect(plan({ seed, count, categories: [category], level: "bold" })).toEqual(plan({ seed, count, categories: [category], level: "flirty" }));
    });
  }

  test("a run of the five and the two «Смелая» categories plans the five exactly as «Кокетливая» does", () => {
    for (const seed of SEEDS) {
      const mixed = plan({ seed, count: 28, categories: [...ORDINARY_BUILT_INS, "nightwear", "beach"], level: "bold", legsShare: 15 });
      const flirty = plan({ seed, count: 28, categories: [...ORDINARY_BUILT_INS, "nightwear", "beach"], level: "flirty", legsShare: 15 });
      const five = (slots: readonly PlanSlot[]): PlanSlot[] => slots.filter((s) => s.category !== "nightwear" && s.category !== "beach");
      expect(five(mixed.slots)).toEqual(five(flirty.slots));
      expect(five(mixed.slots).length).toBeGreaterThan(0);
    }
  });
});

describe("no slot takes an item above its level (I5.37)", () => {
  for (const category of BOLD_BANKS) {
    test(`${category}: moment, outfit and legwear are at the slot's level or below, whatever the size and the legs share`, () => {
      const bank = BANKS[category];
      const frames = SEEDS.flatMap((seed) => SHARES.flatMap((legsShare) => [3, 12, 30].flatMap((count) => boldPlan(category, seed, count, legsShare))));
      const above = frames.filter((d) => !atOrBelow(d.moment.level, levelOf(d.slot)) || !atOrBelow(d.outfit.level, levelOf(d.slot)));
      expect(above.map((d) => `${levelOf(d.slot)} | ${d.slot.location} | ${d.slot.activity} | ${d.slot.outfit}`)).toEqual([]);
      const stockings = new Set(bank.legwear?.bold?.items ?? []);
      expect(frames.filter((d) => d.slot.legwear !== undefined && stockings.has(d.slot.legwear) && levelOf(d.slot) !== "bold")).toEqual([]);
    });
  }

  test("a wide sweep: 10 000 seeds of 12 slots, nothing above its level", () => {
    for (const category of BOLD_BANKS) {
      let above = 0;
      for (let seed = 1; seed <= 10_000; seed++) for (const d of boldPlan(category, seed, 12, seed % 2 === 0 ? 15 : 0)) if (!atOrBelow(d.moment.level, levelOf(d.slot)) || !atOrBelow(d.outfit.level, levelOf(d.slot))) above++;
      expect({ category, above }).toEqual({ category, above: 0 });
    }
  }, 60_000);

  test("a bold slot wears a bold outfit wherever the moment lets it", () => {
    const bold = SEEDS.flatMap((seed) => boldPlan("nightwear", seed, 30)).filter((d) => levelOf(d.slot) === "bold" && d.moment.outfits === undefined);
    expect(bold.length).toBeGreaterThan(50);
    expect(bold.filter((d) => d.outfit.level !== "bold")).toEqual([]);
  });

  test("an ordinary slot of the nightwear bank is cotton nightwear on the owner's model: no satin, no lingerie, no Seedream", () => {
    const ordinary = SEEDS.flatMap((seed) => boldPlan("nightwear", seed, 40)).filter((d) => levelOf(d.slot) === "ordinary");
    expect(ordinary.length).toBeGreaterThan(50);
    expect(ordinary.filter((d) => d.outfit.level !== undefined || d.outfit.route !== undefined || d.slot.route !== undefined)).toEqual([]);
  });

  test("a beach slot wears the cut of its level: ordinary, flirty and bold swimwear stay apart", () => {
    const frames = SEEDS.flatMap((seed) => boldPlan("beach", seed, 40));
    const wrong = frames.filter((d) => d.moment.outfits === undefined && (d.outfit.level ?? "ordinary") !== levelOf(d.slot));
    expect(wrong.map((d) => `${levelOf(d.slot)} | ${d.slot.outfit}`)).toEqual([]);
  });
});

describe("stockings (the bold legwear): bold slots only, and only with the outfits the bank names", () => {
  const bank = BANKS.nightwear;
  const stockingsOf = bank.legwear?.bold;

  test("the bank has bold stockings to read", () => {
    expect(stockingsOf?.items.length).toBeGreaterThan(0);
  });

  test("every stocking is on a bold slot, with an outfit of legwear.bold.outfits", () => {
    const frames = SEEDS.flatMap((seed) => SHARES.flatMap((legsShare) => [10, 30].flatMap((count) => boldPlan("nightwear", seed, count, legsShare))));
    const worn = frames.filter((d) => d.slot.legwear !== undefined && (stockingsOf?.items ?? []).includes(d.slot.legwear));
    expect(worn.length).toBeGreaterThan(20);
    expect(worn.filter((d) => levelOf(d.slot) !== "bold")).toEqual([]);
    expect(worn.filter((d) => !(stockingsOf?.outfits ?? []).includes(d.outfit.text)).map((d) => d.outfit.text)).toEqual([]);
  });

  test("on a legs frame the stockings go with satin nightwear, never lingerie or cotton (P-5a3 #6)", () => {
    const legs = SEEDS.flatMap((seed) => boldPlan("nightwear", seed, 30, 30)).filter((d) => d.slot.framing === "legs");
    const stockinged = legs.filter((d) => d.slot.legwear !== undefined && (stockingsOf?.items ?? []).includes(d.slot.legwear));
    expect(stockinged.length).toBeGreaterThan(10);
    expect(stockinged.filter((d) => !/satin/.test(d.outfit.text))).toEqual([]);
  });

  test("no ordinary or flirty plan of the bank ever draws the stockings", () => {
    for (const level of ["ordinary", "flirty"] as const) {
      const slots = SEEDS.flatMap((seed) => plan({ seed, count: 40, categories: ["nightwear"], level, legsShare: 30 }).slots);
      expect(slots.filter((s) => s.legwear !== undefined && (stockingsOf?.items ?? []).includes(s.legwear))).toEqual([]);
    }
  });

  // S5.R4 (the whole-slice review, MEDIUM 4): split by framing. Plan §6.2 r3.1: «a bold legs slot wears satin nightwear with stockings (the stockings make it bold)», so a bold legs slot
  // always wears them; every other bold slot that may wear them does at the bank's share, as before. The test this replaces ran without legs slots, so it neither saw nor guarded a
  // bold legs frame drawn at the share (the review measured 90 of 233 with stockings: the rest read as flirty).
  test("bold slots that are not legs frames and may wear them do, at about the bank's share, and every 100-slot plan has some", () => {
    let eligible = 0;
    let wearing = 0;
    for (const seed of SEEDS) {
      for (const legsShare of [0, 30] as const) {
        const frames = boldPlan("nightwear", seed, 100, legsShare).filter((d) => d.slot.framing !== "legs");
        const candidates = frames.filter((d) => levelOf(d.slot) === "bold" && d.outfit.showsLegs === true && (stockingsOf?.outfits ?? []).includes(d.outfit.text) && d.moment.noLegwear !== true);
        const worn = candidates.filter((d) => d.slot.legwear !== undefined);
        expect(worn.length).toBeGreaterThan(0);
        eligible += candidates.length;
        wearing += worn.length;
      }
    }
    expect(wearing / eligible).toBeGreaterThan((stockingsOf?.share ?? 0) - 0.12);
    expect(wearing / eligible).toBeLessThan((stockingsOf?.share ?? 0) + 0.12);
  });

  test("every bold legs slot wears them, with its satin, at every legs share and size", () => {
    const boldLegs = SEEDS.flatMap((seed) => ([15, 30] as const).flatMap((legsShare) => [10, 20, 30, 100].flatMap((count) => boldPlan("nightwear", seed, count, legsShare)))).filter((d) => d.slot.framing === "legs" && levelOf(d.slot) === "bold");
    expect(boldLegs.length).toBeGreaterThan(200);
    expect(boldLegs.filter((d) => d.slot.legwear === undefined || !(stockingsOf?.items ?? []).includes(d.slot.legwear) || !/\bsatin\b/.test(d.outfit.text)).map((d) => `${d.slot.activity} | ${d.slot.outfit}`)).toEqual([]);
  });

  test("the beach bank has none: no beach slot wears legwear", () => {
    expect(SEEDS.flatMap((seed) => boldPlan("beach", seed, 30)).filter((d) => d.slot.legwear !== undefined)).toEqual([]);
  });
});

// S5.R4 (the whole-slice review, MEDIUM 3): a «Смелая» run never pays twice for one scene (place, moment and outfit). A slot whose place and moment already went with the outfit it
// would draw takes another one it may wear; a scene comes twice only when every outfit the slot may wear there is taken. Before, a 20-photo beach run drew one twice in about 2 % of
// runs even with its legs moments apart. The five ordinary banks keep their draws (their goldens are frozen).
describe("a «Смелая» run never draws one scene twice while the slot has another outfit to wear", () => {
  const sceneOf = (d: Drawn): string => `${d.slot.location} | ${d.slot.activity} | ${d.slot.outfit}`;
  /** The outfits the slot may wear at its moment: the moment's pins, or the general draw, at the slot's level (its own level preferred, never above). */
  const wearable = (category: BankCategory, d: Drawn): readonly string[] => {
    const levelOfText = (text: string): Level | undefined => BANKS[category].outfits.find((o) => o.text === text)?.level;
    const list = d.moment.outfits ?? BANKS[category].outfits.filter((o) => o.pinOnly !== true).map((o) => o.text);
    return atSlotLevel(list, levelOfText, levelOf(d.slot));
  };

  for (const category of BOLD_BANKS) {
    test(`${category}: no scene twice in a run of 10 or 20, at every legs share, over 300 seeds`, () => {
      const twice: string[] = [];
      for (let seed = 1; seed <= 300; seed++) {
        for (const count of [10, 20]) {
          for (const legsShare of SHARES) {
            const scenes = boldPlan(category, seed, count, legsShare).map(sceneOf);
            for (const [i, scene] of scenes.entries()) if (scenes.indexOf(scene) !== i) twice.push(`seed ${seed}, ${count} at ${legsShare} %: ${scene}`);
          }
        }
      }
      expect(twice.slice(0, 5)).toEqual([]);
    });

    test(`${category}: in a run of 30 or 100 a scene comes twice only when every outfit the slot may wear there is taken`, () => {
      const avoidable: string[] = [];
      for (const seed of SEEDS) {
        for (const count of [30, 100]) {
          for (const legsShare of SHARES) {
            const drawn = boldPlan(category, seed, count, legsShare);
            drawn.forEach((d, i) => {
              const before = new Set(drawn.slice(0, i).map(sceneOf));
              if (!before.has(sceneOf(d))) return;
              const free = wearable(category, d).filter((o) => !before.has(`${d.slot.location} | ${d.slot.activity} | ${o}`));
              if (free.length > 0) avoidable.push(`seed ${seed}, ${count} at ${legsShare} %: ${sceneOf(d)} (free: ${free.join(", ")})`);
            });
          }
        }
      }
      expect(avoidable.slice(0, 5)).toEqual([]);
    });
  }
});

describe("a slot is on the Seedream route exactly when it drew a Seedream item (I5.38)", () => {
  for (const category of BOLD_BANKS) {
    test(`${category}: route ⇔ the moment, the outfit or the stockings is a Seedream item`, () => {
      const bank = BANKS[category];
      const stockings = new Set(bank.legwear?.bold?.items ?? []);
      const frames = SEEDS.flatMap((seed) => SHARES.flatMap((legsShare) => [5, 20].flatMap((count) => boldPlan(category, seed, count, legsShare))));
      const seedream = (d: Drawn): boolean => d.moment.route === "seedream" || d.outfit.route === "seedream" || (d.slot.legwear !== undefined && stockings.has(d.slot.legwear));
      expect(frames.filter((d) => seedream(d) !== (d.slot.route === "seedream")).map((d) => `${levelOf(d.slot)} | ${d.slot.activity} | ${d.slot.outfit} | ${String(d.slot.route)}`)).toEqual([]);
      expect(frames.some((d) => d.slot.route === undefined)).toBe(category === "nightwear");
      expect(frames.some((d) => d.slot.route === "seedream")).toBe(true);
    });
  }

  test("every beach slot is on Seedream: every beach outfit is swimwear", () => {
    expect(SEEDS.flatMap((seed) => boldPlan("beach", seed, 30)).filter((d) => d.slot.route !== "seedream")).toEqual([]);
  });

  test("the five carry no route", () => {
    for (const seed of SEEDS) expect(plan({ seed, count: 30, categories: [...ORDINARY_BUILT_INS], level: "bold", legsShare: 15 }).slots.filter((s) => s.route !== undefined)).toEqual([]);
  });
});

describe("the owner's rules hold in the mix", () => {
  test("she lies on her stomach, is seen over her shoulder or from above, only on her bed", () => {
    const frames = SEEDS.flatMap((seed) => [12, 30].flatMap((count) => boldPlan("nightwear", seed, count, 15)));
    expect(frames.filter((d) => (["prone", "over-shoulder", "above"].includes(d.capture) || /\bstomach\b|\bprone\b/.test(d.slot.activity)) && d.slot.location !== "her bed").map((d) => `${d.capture} ${d.slot.location}`)).toEqual([]);
  });

  test("side or back to the mirror, only her reflection: a mirrorBack moment is the phone-over-face frame", () => {
    const back = SEEDS.flatMap((seed) => boldPlan("nightwear", seed, 30)).filter((d) => d.moment.mirrorBack === true);
    expect(back.length).toBeGreaterThan(20);
    expect(back.filter((d) => d.capture !== "mirror-hidden")).toEqual([]);
  });

  test("a category holds at most ⌊n/5⌋ frames that face away, at any size", () => {
    for (const category of BOLD_BANKS) {
      for (const seed of SEEDS.slice(0, 10)) {
        for (let count = 1; count <= 40; count++) {
          const away = boldPlan(category, seed, count).filter((d) => d.slot.pose === "profile" || d.slot.pose === "back").length;
          expect({ category, count, ok: away <= Math.floor(count / 5) }).toEqual({ category, count, ok: true });
        }
      }
    }
  });

  test("the deck is dealt whole: a plan of the deck's length without legs holds exactly the deck's captures", () => {
    for (const category of BOLD_BANKS) {
      const deck = BANKS[category].captureDeck;
      for (const seed of SEEDS) expect(boldPlan(category, seed, deck.length).map((d) => d.capture).sort()).toEqual([...deck].sort());
    }
  });

  test("a bold plan deals the very captures the ordinary plan deals: the level changes moments and outfits, never the deck", () => {
    for (const category of BOLD_BANKS) {
      for (const seed of SEEDS.slice(0, 10)) {
        const ordinary = plan({ seed, count: 24, categories: [category], level: "ordinary" }).slots.map((s) => s.capture ?? captureOfShot(s.shot));
        const bold = boldPlan(category, seed, 24).map((d) => d.capture);
        expect(bold).toEqual(ordinary);
      }
    }
  });
});
