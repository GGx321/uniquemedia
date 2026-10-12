import { describe, expect, test } from "bun:test";
import { BOLD_CATEGORIES, type BoldCategory } from "../engine";
import { BANKS } from "./banks";
import { swimwearWordsIn } from "./banks/boldRules";
import { explicitActsIn, exposureWordsIn } from "./banks/boldDesign.testkit";
import type { Level, Moment, Outfit } from "./banks/types";
import { isHandCapture, posesFor, shotOf, type Capture } from "./captures";
import { boldContentLevel, contentProblems } from "./contentLine";
import { atOrBelow } from "./level";
import { momentAllowed } from "./render";
import { simulatePlan, type SimulatedSlot } from "./simulatePlan.testkit";
import { templateSentence } from "./template";
import { isOwnerBannedOutfit } from "./words";

// 5a.3 (S5.9b2, plan s5a3 §6.4 r3, I5.24, I5.32, I5.37): the two «Смелая» banks' own sweeps. The planner draws them with S5.9c (the mix and the bold draw), so
// these sweeps measure the bank text on the planner stand-in (simulatePlan.testkit.ts), at each level alone: every slot of a plan at ordinary, at flirty, at bold.
// The stand-in keeps the planner's order and its hard rule (no slot takes a moment or an outfit above its level); stockings ride with S5.9c's draw and template,
// so its bold slots wear none. The owner's rules: at home she shoots herself and a third of the frames hide her face behind the phone; at the beach she mostly
// asks someone, and wears swimwear on every frame; she lies on her stomach only on her bed; side or back to the mirror, only her reflection; nothing above
// the slot's level; no youth word (the exempt garment name spared), no exposure word and no explicit act in any sentence.

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const N = 100;
const LEVELS: readonly Level[] = ["ordinary", "flirty", "bold"];

const plans = new Map<string, SimulatedSlot[][]>();
/** The 50 plans of 100 slots of a bank at a level, built once. */
function plansOf(category: BoldCategory, level: Level): SimulatedSlot[][] {
  const key = `${category}:${level}`;
  const cached = plans.get(key);
  if (cached !== undefined) return cached;
  const built = SEEDS.map((seed) => simulatePlan(category, N, seed, level));
  plans.set(key, built);
  return built;
}
const framesOf = (category: BoldCategory, level: Level): SimulatedSlot[] => plansOf(category, level).flat();

/** Renders a plan the way a run would: in slot order, each slot seeing the sentences before it (dedup on), or each alone (dedup off). */
function render(slots: readonly SimulatedSlot[], level: Level, dedup: boolean): string[] {
  const seen = new Set<string>();
  return slots.map((slot) => {
    const sentence = templateSentence(slot, { key: slot.key, level, ...(dedup ? { seen } : {}) });
    if (sentence === null) throw new Error(`${slot.category}/${slot.location}: «${slot.activity}» did not render on ${slot.capture} ${slot.pose} in ${slot.outfit}`);
    seen.add(sentence);
    return sentence;
  });
}

/** A repeat the dedup contract allows: only when the first draw and all 8 redraws are taken. */
function unjustifiedRepeats(slots: readonly SimulatedSlot[], level: Level): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slot of slots) {
    const sentence = templateSentence(slot, { key: slot.key, level, seen }) ?? "";
    if (seen.has(sentence)) {
      const variants = [slot.key, ...Array.from({ length: 8 }, (_, i) => `${slot.key}:dedup:${i + 1}`)].map((key) => templateSentence(slot, { key, level }));
      if (variants.some((v) => v !== null && !seen.has(v))) out.push(sentence);
    }
    seen.add(sentence);
  }
  return out;
}

/** The moments a slot of the bank can draw at the level (not a legs moment: the stand-in deals no legs slot). */
function drawableMoments(category: BoldCategory, level: Level): { place: string; moment: Moment }[] {
  const captures = [...new Set(BANKS[category].captureDeck)];
  return BANKS[category].places.flatMap((place) =>
    place.moments
      .filter((m) => captures.some((capture) => (shotOf(capture) !== "mirror" || place.mirror === true) && posesFor(capture).some((pose) => momentAllowed(m, capture, pose, level))))
      .map((moment) => ({ place: place.name, moment })),
  );
}

/** The outfits a slot at the level can wear: the general ones of its level or below, and those the moments it can draw pin. */
function wearableOutfits(category: BoldCategory, level: Level): Outfit[] {
  const pinned = new Set(drawableMoments(category, level).flatMap(({ moment }) => moment.outfits ?? []));
  return BANKS[category].outfits.filter((o) => atOrBelow(o.level, level) && (o.pinOnly !== true || pinned.has(o.text)));
}

const outfitOf = (category: BoldCategory, text: string | undefined): Outfit | undefined => BANKS[category].outfits.find((o) => o.text === text);

/** What a failing sweep shows: how many frames broke the rule, and a few of them. */
function offenders(frames: readonly SimulatedSlot[], broken: (frame: SimulatedSlot) => boolean): { count: number; sample: string[] } {
  const hits = frames.filter(broken);
  return { count: hits.length, sample: hits.slice(0, 3).map((f) => `${f.category} | ${f.capture} | ${f.pose} | ${f.location} | ${f.activity} | ${f.wearing}`) };
}
const NONE = { count: 0, sample: [] };

describe.each([...BOLD_CATEGORIES])("%s: plans of 100 slots at each level (I5.24, I5.37)", (category) => {
  test.each([...LEVELS])("at %s: every slot renders, ≥ 0.8 of the sentences are distinct without the dedup, and with it a sentence repeats only when every redraw is taken", (level) => {
    let worst = 1;
    for (const slots of plansOf(category, level)) {
      worst = Math.min(worst, new Set(render(slots, level, false)).size / N);
      render(slots, level, true);
      expect(unjustifiedRepeats(slots, level)).toEqual([]);
    }
    expect(worst).toBeGreaterThanOrEqual(0.8);
  });

  test.each([...LEVELS])("at %s: no moment repeats more than ⌈n / moments⌉ + 1 times", (level) => {
    const bound = Math.ceil(N / drawableMoments(category, level).length) + 1;
    for (const slots of plansOf(category, level)) {
      const counts = new Map<string, number>();
      for (const slot of slots) counts.set(`${slot.location}|${slot.activity}`, (counts.get(`${slot.location}|${slot.activity}`) ?? 0) + 1);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(bound);
    }
  });

  test.each([...LEVELS])("at %s: no slot takes a moment or an outfit above its level", (level) => {
    expect(offenders(framesOf(category, level), (f) => !atOrBelow(f.moment.level, level) || !atOrBelow(outfitOf(category, f.outfit)?.level, level))).toEqual(NONE);
  });

  test.each([...LEVELS])("at %s: every moment and every outfit a slot of the level can draw is reached over the seeds", (level) => {
    const frames = framesOf(category, level);
    const seenMoments = new Set(frames.map((f) => `${f.location} | ${f.activity}`));
    const seenOutfits = new Set(frames.map((f) => f.outfit));
    expect(drawableMoments(category, level).map((m) => `${m.place} | ${m.moment.text}`).filter((m) => !seenMoments.has(m))).toEqual([]);
    expect(wearableOutfits(category, level).map((o) => o.text).filter((o) => !seenOutfits.has(o))).toEqual([]);
  });

  test("never steps a capture or a pose down at any level: only the place is ever redrawn", () => {
    for (const level of LEVELS) expect(framesOf(category, level).flatMap((s) => s.fallbacks.filter((f) => !f.startsWith("place ")))).toEqual([]);
  });

  test.each([...LEVELS])("at %s: every sentence holds to the bold content line and names no exposure word, explicit act or denim", (level) => {
    const sentences = [...new Set(plansOf(category, level).flatMap((slots) => render(slots, level, true)))];
    expect(sentences.length).toBeGreaterThan(300);
    expect(sentences.filter((s) => contentProblems(s, boldContentLevel()).length > 0)).toEqual([]);
    expect(sentences.filter((s) => exposureWordsIn(s).length > 0 || explicitActsIn(s).length > 0 || isOwnerBannedOutfit(s))).toEqual([]);
  });

  test("a front sentence never says «looking back» (S5.6R round D)", () => {
    for (const level of LEVELS) {
      const front = plansOf(category, level).flatMap((slots) => slots.map((slot) => ({ slot, text: templateSentence(slot, { key: slot.key, level }) ?? "" }))).filter((s) => s.slot.pose === "front");
      expect(front.length).toBeGreaterThan(500);
      expect(front.filter((s) => /looking back/i.test(s.text)).map((s) => s.text)).toEqual([]);
    }
  });
});

describe("«Ночнушки и бельё»: the owner's rules on its plans", () => {
  const all = LEVELS.flatMap((level) => framesOf("nightwear", level));
  const isSelfShot = (capture: Capture): boolean => capture !== "friend" && capture !== "candid" && capture !== "low-feet";

  test("at home she shoots herself: no frame is a friend's or a candid photo, at any level", () => {
    expect(all.length).toBe(LEVELS.length * SEEDS.length * N);
    expect(offenders(all, (f) => !isSelfShot(f.capture))).toEqual(NONE);
  });

  test("about a third of the frames hide her face behind the phone, at every level", () => {
    for (const level of LEVELS) {
      const frames = framesOf("nightwear", level);
      const hidden = frames.filter((f) => f.capture === "mirror-hidden").length / frames.length;
      expect(hidden).toBeGreaterThan(0.28);
      expect(hidden).toBeLessThan(0.39);
    }
  });

  test("she lies on her stomach, is seen over her shoulder or from above, only on her bed", () => {
    expect(offenders(all, (f) => (f.capture === "prone" || f.capture === "over-shoulder" || f.capture === "above" || /\bstomach\b|\bprone\b/.test(f.activity ?? "")) && f.location !== "her bed")).toEqual(NONE);
  });

  test("side or back to the mirror, only her reflection: a mirrorBack moment is always the phone-over-face frame", () => {
    const back = all.filter((f) => f.moment.mirrorBack === true);
    expect(back.length).toBeGreaterThan(100);
    expect(offenders(back, (f) => f.capture !== "mirror-hidden")).toEqual(NONE);
  });

  test("a prone or over-the-shoulder frame wears no legwear, and a hand-held frame takes no two-handed moment", () => {
    expect(offenders(all, (f) => (f.capture === "prone" || f.capture === "over-shoulder") && f.legwear !== undefined)).toEqual(NONE);
    expect(offenders(all, (f) => isHandCapture(f.capture) && f.moment.twoHanded)).toEqual(NONE);
  });

  test("an ordinary plan is cotton nightwear on the owner's model; lingerie is a bold slot's only", () => {
    const lingerie = (f: SimulatedSlot): boolean => outfitOf("nightwear", f.outfit)?.level === "bold";
    expect(offenders(framesOf("nightwear", "ordinary"), (f) => outfitOf("nightwear", f.outfit)?.route !== undefined)).toEqual(NONE);
    expect(offenders(framesOf("nightwear", "flirty"), lingerie)).toEqual(NONE);
    expect(framesOf("nightwear", "bold").filter(lingerie).length).toBeGreaterThan(SEEDS.length * N * 0.3);
  });
});

describe("«Пляж и бассейн»: the owner's rules on its plans", () => {
  const all = LEVELS.flatMap((level) => framesOf("beach", level));

  test("she mostly asks someone: half the frames are a friend's, and none is a mirror, prone or over-the-shoulder frame", () => {
    for (const level of LEVELS) {
      const frames = framesOf("beach", level);
      const friend = frames.filter((f) => f.capture === "friend").length / frames.length;
      expect(friend).toBeGreaterThanOrEqual(0.45);
    }
    expect(offenders(all, (f) => shotOf(f.capture) === "mirror" || f.capture === "prone" || f.capture === "over-shoulder" || f.capture === "above")).toEqual(NONE);
  });

  test("swimwear on every frame, at every level (answer (a))", () => {
    expect(offenders(all, (f) => swimwearWordsIn(f.outfit ?? "").length === 0)).toEqual(NONE);
  });

  test("in the water she wears a swimsuit or a bikini, never the shirt, the sweatshirt or the sarong", () => {
    const water = all.filter((f) => f.moment.water === true);
    expect(water.length).toBeGreaterThan(1000);
    expect(offenders(water, (f) => /shirt|sweatshirt|sarong/.test(f.outfit ?? ""))).toEqual(NONE);
  });

  test("a bold plan wears the bold cuts, and an ordinary one never does", () => {
    const boldCut = (f: SimulatedSlot): boolean => outfitOf("beach", f.outfit)?.level === "bold";
    expect(offenders(framesOf("beach", "ordinary"), boldCut)).toEqual(NONE);
    expect(offenders(framesOf("beach", "flirty"), boldCut)).toEqual(NONE);
    expect(framesOf("beach", "bold").filter(boldCut).length).toBeGreaterThan(SEEDS.length * N * 0.2);
  });

  test("a friend's photo of the moments that face away is the only frame without her face", () => {
    expect(offenders(all, (f) => f.pose === "back" && f.moment.angle !== "back")).toEqual(NONE);
  });
});
