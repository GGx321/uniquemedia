import { describe, expect, test } from "bun:test";
import { BOLD_CATEGORIES, SCENE_TEXT_MAX, type BoldCategory } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { swimwearWordsIn } from "../../shared/scenes/banks/boldRules";
import { explicitActsIn, exposureWordsIn } from "../../shared/scenes/banks/boldDesign.testkit";
import type { Level, Moment, Outfit } from "../../shared/scenes/banks/types";
import { captureOfShot, isHandCapture, posesFor, shotOf, type Capture } from "../../shared/scenes/captures";
import { boldContentLevel, contentProblems } from "../../shared/scenes/contentLine";
import { atOrBelow, type LevelCounts } from "../../shared/scenes/level";
import { momentAllowed } from "../../shared/scenes/render";
import { templateSentence } from "../../shared/scenes/template";
import { isOwnerBannedOutfit } from "../../shared/scenes/words";
import { plan } from "./planner";
import type { PlanSlot } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9c, plan s5a3 §6.4 r3, §7.3, I5.24, I5.32, I5.37): the two «Смелая» banks' sweeps on the REAL planner, which replaces the planner stand-in the same sweeps ran on in
// S5.9b2 (shared/scenes/boldBanks.sweep.test.ts, retired with this file: every assertion is here). A plan is drawn at the planner's three levels: «Обычная» and «Кокетливая»
// (every slot at that level) and «Смелая» (the 20 / 40 / 40 mix), at three legs shares. The owner's rules: at home she shoots herself and a third of the frames hide her face
// behind the phone; at the beach she mostly asks someone and wears swimwear on every frame; she lies on her stomach only on her bed; side or back to the mirror, only her reflection;
// nothing above the slot's level; no youth word (the exempt garment name spared), no exposure word and no explicit act in any sentence; every plan renders, with no slot left to the
// LLM writer (0 null slots), the coverage once, within the scene bound.

type PlannerLevel = "ordinary" | "flirty" | "bold";
const PLANNER_LEVELS: readonly PlannerLevel[] = ["ordinary", "flirty", "bold"];
const SHARES = [0, 15, 30] as const;
const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const N = 100;

interface Frame {
  slot: PlanSlot;
  category: BoldCategory;
  key: string;
  moment: Moment;
  outfit: Outfit;
  capture: Capture;
}

function framesOf(category: BoldCategory, level: PlannerLevel, seed: number, count: number, legsShare: 0 | 15 | 30): Frame[] {
  const bank = BANKS[category];
  return plan({ seed, count, categories: [category], level, legsShare }).slots.map((slot) => {
    const moment = bank.places.find((p) => p.name === slot.location)?.moments.find((m) => m.text === slot.activity);
    const outfit = bank.outfits.find((o) => o.text === slot.outfit);
    if (moment === undefined || outfit === undefined) throw new Error(`${category}: slot ${slot.slotIndex} names an item the bank does not have`);
    return { slot, category, key: `run-${seed}:${slot.attemptIdBase}`, moment, outfit, capture: slot.capture ?? captureOfShot(slot.shot) };
  });
}

const cache = new Map<string, Frame[][]>();
/** The 50 plans of 100 slots of a bank at a planner level and legs share, built once. */
function plansOf(category: BoldCategory, level: PlannerLevel, legsShare: 0 | 15 | 30 = 15): Frame[][] {
  const key = `${category}:${level}:${legsShare}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const built = SEEDS.map((seed) => framesOf(category, level, seed, N, legsShare));
  cache.set(key, built);
  return built;
}
const allFrames = (category: BoldCategory, level: PlannerLevel): Frame[] => SHARES.flatMap((share) => plansOf(category, level, share).flat());

/** Renders a plan the way a run would: in slot order, each slot seeing the sentences before it (dedup on), or each alone (dedup off). */
function render(frames: readonly Frame[], dedup: boolean): string[] {
  const seen = new Set<string>();
  return frames.map((f) => {
    const sentence = templateSentence(f.slot, { key: f.key, ...(dedup ? { seen } : {}) });
    if (sentence === null) throw new Error(`${f.category}/${f.slot.location}: «${f.slot.activity}» did not render on ${f.capture} ${f.slot.pose} in ${f.slot.outfit}`);
    seen.add(sentence);
    return sentence;
  });
}

/** A repeat the dedup contract allows: only when the first draw and all 8 redraws are taken. */
function unjustifiedRepeats(frames: readonly Frame[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of frames) {
    const sentence = templateSentence(f.slot, { key: f.key, seen }) ?? "";
    if (seen.has(sentence)) {
      const variants = [f.key, ...Array.from({ length: 8 }, (_, i) => `${f.key}:dedup:${i + 1}`)].map((key) => templateSentence(f.slot, { key }));
      if (variants.some((v) => v !== null && !seen.has(v))) out.push(sentence);
    }
    seen.add(sentence);
  }
  return out;
}

/** The ceiling level of the slots a planner level draws: «Смелая» draws all three. */
const ceilingOf = (level: PlannerLevel): Level => level;

/** The moments a slot of the bank can draw at the planner level: a legs moment through a legs frame, the others through a deck capture and a pose, at a place the capture can land on. */
function drawableMoments(category: BoldCategory, level: PlannerLevel): { place: string; moment: Moment }[] {
  const captures = [...new Set(BANKS[category].captureDeck)];
  return BANKS[category].places.flatMap((place) =>
    place.moments
      .filter((m) =>
        m.legs !== undefined
          ? m.captures.some((capture) => (shotOf(capture) !== "mirror" || place.mirror === true) && momentAllowed(m, capture, m.angle ?? "front", ceilingOf(level), "legs"))
          : captures.some((capture) => (shotOf(capture) !== "mirror" || place.mirror === true) && posesFor(capture).some((pose) => momentAllowed(m, capture, pose, ceilingOf(level)))),
      )
      .map((moment) => ({ place: place.name, moment })),
  );
}

/** The outfits a slot at the planner level can wear: the general ones at or below its level, and those the moments it can draw pin. */
function wearableOutfits(category: BoldCategory, level: PlannerLevel): Outfit[] {
  const pinned = new Set(drawableMoments(category, level).flatMap(({ moment }) => moment.outfits ?? []));
  return BANKS[category].outfits.filter((o) => atOrBelow(o.level, ceilingOf(level)) && (o.pinOnly !== true || pinned.has(o.text)));
}

/** What a failing sweep shows: how many frames broke the rule, and a few of them. */
function offenders(frames: readonly Frame[], broken: (frame: Frame) => boolean): { count: number; sample: string[] } {
  const hits = frames.filter(broken);
  return { count: hits.length, sample: hits.slice(0, 3).map((f) => `${f.category} | ${f.capture} | ${f.slot.pose} | ${f.slot.location} | ${f.slot.activity} | ${f.slot.outfit}`) };
}
const NONE = { count: 0, sample: [] };
const levelOf = (f: Frame): Level => f.slot.level ?? "ordinary";

describe.each([...BOLD_CATEGORIES])("%s: the real planner's plans (I5.24, I5.37)", (category) => {
  test.each([...PLANNER_LEVELS])("at %s: no slot is left to the writer: every slot of 1 to 30 renders, at every legs share (0 null slots)", (level) => {
    for (const legsShare of SHARES) {
      for (let seed = 1; seed <= 40; seed++) for (let count = 1; count <= 30; count++) render(framesOf(category, level, seed, count, legsShare), true);
    }
  }, 60_000);

  test.each([...PLANNER_LEVELS])("at %s: a wide sweep of 3000 seeds renders every slot of a 12-slot plan with legs", (level) => {
    for (let seed = 1; seed <= 3000; seed++) render(framesOf(category, level, seed * 31, 12, 15), false);
  }, 60_000);

  test.each([...PLANNER_LEVELS])("at %s: the coverage of what a slot shows is said once, and no sentence outgrows the scene bound", (level) => {
    const frames = allFrames(category, level);
    let longest = 0;
    for (const plans of SHARES.map((share) => plansOf(category, level, share))) {
      for (const slots of plans) {
        const rendered = render(slots, false);
        slots.forEach((f, i) => {
          const sentence = rendered[i] as string;
          longest = Math.max(longest, sentence.length);
          const coverage = f.moment.coverage ?? f.outfit.coverage;
          if (coverage !== undefined) {
            expect(sentence.endsWith(coverage)).toBe(true);
            expect(sentence.split(coverage)).toHaveLength(2);
          }
        });
      }
    }
    expect(frames.length).toBeGreaterThan(0);
    expect(longest).toBeLessThanOrEqual(SCENE_TEXT_MAX);
  });

  test.each([...PLANNER_LEVELS])("at %s: ≥ 0.8 of a 100-slot plan's sentences are distinct without the dedup, and with it a sentence repeats only when every redraw is taken", (level) => {
    let worst = 1;
    for (const slots of plansOf(category, level)) {
      worst = Math.min(worst, new Set(render(slots, false)).size / N);
      render(slots, true);
      expect(unjustifiedRepeats(slots)).toEqual([]);
    }
    expect(worst).toBeGreaterThanOrEqual(0.8);
  });

  // The planner balances place first, then moment (I5.24), so a place with few moments repeats each one more than the category's average does: the bound is twice the fair share of the
  // frames that are not legs frames, plus one. The legs frames go round the legs moments, so their bound is the fair share, plus one.
  // Only the mix is checked: a plan of one lower level is refused by the engine (bold-level-needed) and exists here as the 20 and 40 per cent of the mix, where a category's few ordinary
  // frames lean on the few ordinary moments that fit their captures.
  test.each(["bold"] as const)("at %s: no moment is drawn more than twice its fair share + 1, and the legs moments go round", (level) => {
    const drawable = drawableMoments(category, level);
    const legsMoments = drawable.filter(({ moment }) => moment.legs !== undefined).length;
    const otherMoments = drawable.length - legsMoments;
    const tally = (frames: readonly Frame[]): number => {
      const counts = new Map<string, number>();
      for (const f of frames) counts.set(`${f.slot.location}|${f.slot.activity}`, (counts.get(`${f.slot.location}|${f.slot.activity}`) ?? 0) + 1);
      return Math.max(0, ...counts.values());
    };
    for (const slots of plansOf(category, level)) {
      const legs = slots.filter((f) => f.slot.framing === "legs");
      const others = slots.filter((f) => f.slot.framing !== "legs");
      expect(tally(others)).toBeLessThanOrEqual(2 * Math.ceil(others.length / otherMoments) + 1);
      if (legs.length > 0) expect(tally(legs)).toBeLessThanOrEqual(Math.ceil(legs.length / legsMoments) + 1);
    }
  });

  test.each([...PLANNER_LEVELS])("at %s: no slot takes a moment or an outfit above its own level", (level) => {
    expect(offenders(allFrames(category, level), (f) => !atOrBelow(f.moment.level, levelOf(f)) || !atOrBelow(f.outfit.level, levelOf(f)))).toEqual(NONE);
  });

  test.each([...PLANNER_LEVELS])("at %s: every moment and every outfit a slot of the level can draw is reached over the seeds", (level) => {
    const frames = allFrames(category, level);
    const seenMoments = new Set(frames.map((f) => `${f.slot.location} | ${f.slot.activity}`));
    const seenOutfits = new Set(frames.map((f) => f.slot.outfit));
    expect(drawableMoments(category, level).map((m) => `${m.place} | ${m.moment.text}`).filter((m) => !seenMoments.has(m))).toEqual([]);
    expect(wearableOutfits(category, level).map((o) => o.text).filter((o) => !seenOutfits.has(o))).toEqual([]);
  });

  test.each([...PLANNER_LEVELS])("at %s: every sentence holds to the bold content line and names no exposure word, explicit act or denim", (level) => {
    const sentences = [...new Set(SHARES.flatMap((share) => plansOf(category, level, share).flatMap((slots) => render(slots, true))))];
    expect(sentences.length).toBeGreaterThan(300);
    expect(sentences.filter((s) => contentProblems(s, boldContentLevel()).length > 0)).toEqual([]);
    expect(sentences.filter((s) => exposureWordsIn(s).length > 0 || explicitActsIn(s).length > 0 || isOwnerBannedOutfit(s))).toEqual([]);
  });

  test("a front sentence never says «looking back» (S5.6R round D)", () => {
    for (const level of PLANNER_LEVELS) {
      const front = plansOf(category, level).flatMap((slots) => {
        const rendered = render(slots, false);
        return slots.map((f, i) => ({ f, text: rendered[i] as string }));
      }).filter((s) => s.f.slot.pose === "front");
      expect(front.length).toBeGreaterThan(500);
      expect(front.filter((s) => /looking back/i.test(s.text)).map((s) => s.text)).toEqual([]);
    }
  });

  test("a prone or over-the-shoulder frame wears no legwear, and a hand-held frame takes no two-handed moment", () => {
    const all = PLANNER_LEVELS.flatMap((level) => allFrames(category, level));
    expect(offenders(all, (f) => (f.capture === "prone" || f.capture === "over-shoulder") && f.slot.legwear !== undefined)).toEqual(NONE);
    expect(offenders(all, (f) => isHandCapture(f.capture) && f.moment.twoHanded)).toEqual(NONE);
  });
});

describe("«Ночнушки и бельё»: the owner's rules on the real planner's plans", () => {
  const all = PLANNER_LEVELS.flatMap((level) => allFrames("nightwear", level));
  const isSelfShot = (capture: Capture): boolean => capture !== "friend" && capture !== "candid" && capture !== "low-feet";

  test("at home she shoots herself: no frame is a friend's or a candid photo, at any level", () => {
    expect(all.length).toBe(PLANNER_LEVELS.length * SHARES.length * SEEDS.length * N);
    expect(offenders(all, (f) => !isSelfShot(f.capture))).toEqual(NONE);
  });

  test("a third of the frames that are not legs frames hide her face behind the phone, at every level", () => {
    for (const level of PLANNER_LEVELS) {
      const frames = plansOf("nightwear", level, 0).flat();
      const hidden = frames.filter((f) => f.capture === "mirror-hidden").length / frames.length;
      expect(hidden).toBeGreaterThan(0.3);
      expect(hidden).toBeLessThan(0.37);
    }
  });

  test("she lies on her stomach, is seen over her shoulder or from above, only on her bed", () => {
    expect(offenders(all, (f) => (f.capture === "prone" || f.capture === "over-shoulder" || f.capture === "above" || /\bstomach\b|\bprone\b/.test(f.slot.activity)) && f.slot.location !== "her bed")).toEqual(NONE);
  });

  test("side or back to the mirror, only her reflection: a mirrorBack moment is always the phone-over-face frame", () => {
    const back = all.filter((f) => f.moment.mirrorBack === true);
    expect(back.length).toBeGreaterThan(100);
    expect(offenders(back, (f) => f.capture !== "mirror-hidden")).toEqual(NONE);
  });

  test("an ordinary plan is cotton nightwear on the owner's model; lingerie is a bold slot's only; satin is for flirty slots and above", () => {
    const lingerie = (f: Frame): boolean => f.outfit.level === "bold";
    expect(offenders(allFrames("nightwear", "ordinary"), (f) => f.outfit.route !== undefined || f.slot.route !== undefined)).toEqual(NONE);
    expect(offenders(allFrames("nightwear", "flirty"), lingerie)).toEqual(NONE);
    expect(allFrames("nightwear", "bold").filter(lingerie).length).toBeGreaterThan(SEEDS.length * N * 0.3);
  });

  test("the open shirt never rides on a moment with her arms up (review of S5.9b2)", () => {
    const armsUp = all.filter((f) => /\barms?\b.*\bup\b|\bstretch/i.test(`${f.moment.text} ${f.moment.motion}`));
    expect(armsUp.length).toBeGreaterThan(100);
    expect(offenders(armsUp, (f) => /\bopen\b.*\bshirt\b/.test(f.slot.outfit))).toEqual(NONE);
  });
});

describe("«Пляж и бассейн»: the owner's rules on the real planner's plans", () => {
  const all = PLANNER_LEVELS.flatMap((level) => allFrames("beach", level));

  test("she mostly asks someone: half the frames are a friend's, and none is a mirror, prone or over-the-shoulder frame", () => {
    for (const level of PLANNER_LEVELS) {
      const frames = plansOf("beach", level, 0).flat();
      expect(frames.filter((f) => f.capture === "friend").length / frames.length).toBeGreaterThanOrEqual(0.45);
    }
    expect(offenders(all, (f) => shotOf(f.capture) === "mirror" || f.capture === "prone" || f.capture === "over-shoulder" || f.capture === "above")).toEqual(NONE);
  });

  test("swimwear on every frame, at every level (answer (a))", () => {
    expect(offenders(all, (f) => swimwearWordsIn(f.slot.outfit).length === 0)).toEqual(NONE);
  });

  test("in the water she wears a swimsuit or a bikini, never the shirt, the sweatshirt or the sarong", () => {
    const water = all.filter((f) => f.moment.water === true);
    expect(water.length).toBeGreaterThan(1000);
    expect(offenders(water, (f) => /shirt|sweatshirt|sarong/.test(f.slot.outfit))).toEqual(NONE);
  });

  test("a bold plan wears the bold cuts, and an ordinary or flirty one never does", () => {
    const boldCut = (f: Frame): boolean => f.outfit.level === "bold";
    expect(offenders(allFrames("beach", "ordinary"), boldCut)).toEqual(NONE);
    expect(offenders(allFrames("beach", "flirty"), boldCut)).toEqual(NONE);
    expect(allFrames("beach", "bold").filter(boldCut).length).toBeGreaterThan(SEEDS.length * N * 0.2);
  });

  test("the frames that face away are the moments that face away, and every slot is drawn on Seedream", () => {
    expect(offenders(all, (f) => f.slot.pose === "back" && f.moment.angle !== "back")).toEqual(NONE);
    expect(offenders(all, (f) => f.slot.route !== "seedream")).toEqual(NONE);
  });
});

describe("the mix keeps its shares in a 100-slot plan of each bank (I5.36)", () => {
  test.each([...BOLD_CATEGORIES])("%s: 40 bold, 40 flirty and 20 ordinary slots in every plan", (category) => {
    const expected: LevelCounts = { bold: 40, flirty: 40, ordinary: 20 };
    for (const slots of plansOf(category, "bold")) {
      const got = { bold: slots.filter((f) => levelOf(f) === "bold").length, flirty: slots.filter((f) => levelOf(f) === "flirty").length, ordinary: slots.filter((f) => levelOf(f) === "ordinary").length };
      expect(got).toEqual(expected);
    }
  });
});
