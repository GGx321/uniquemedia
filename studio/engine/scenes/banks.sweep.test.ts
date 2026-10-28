import { describe, expect, test } from "bun:test";
import { youthWords } from "../../shared/engine";
import { BANKS, CUES, GAZE, HAIRSTYLES } from "../../shared/scenes/banks";
import { BANK_CATEGORIES, ORDINARY_BANK_CATEGORIES, type CategoryBank } from "../../shared/scenes/banks/types";
import { PHONE_WORDS as SHARED_PHONE_WORDS, SELFIE_WORDS as SHARED_SELFIE_WORDS, withoutExemptLookPhrases } from "../../shared/scenes/words";
import { sentenceProblems } from "./assembler";
import { PHONE_WORDS, POOLS, SELFIE_WORDS } from "./pools";
import { firstHit, NEGATED_LOOK, PAPER_AND_SCREENS, SOFT_LIST, STAGING } from "./testing/lookRules";
import { CATEGORIES } from "./types";
import { REVEALING_WORDS } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6a, I5.21, I5.35): the engine's side of the bank sweep. The shared banks validate themselves at load with the rules shared code can hold
// (shared/scenes/banks/schema.ts); the word lists that live in the engine (the revealing words, the writer's soft list, paper and screens, the
// staging phrases, the assembler's last gate) are swept here over every bank text, motions and start poses included, with a negative control per
// list. K-22: «silk pajamas» is exempt from the luxury words (the owner's references); «satin» stays refused.

interface BankText {
  where: string;
  text: string;
}

function textsOf(category: string, bank: CategoryBank): BankText[] {
  const out: BankText[] = bank.outfits.map((outfit, i) => ({ where: `${category}.outfits[${i}]`, text: outfit.text }));
  for (const item of bank.legwear?.items ?? []) out.push({ where: `${category}.legwear`, text: item });
  for (const place of bank.places) {
    out.push({ where: `${category}/${place.name}`, text: place.name }, { where: `${category}/${place.name}.at`, text: place.at });
    for (const detail of place.details) out.push({ where: `${category}/${place.name}.details`, text: detail });
    for (const moment of place.moments) {
      out.push({ where: `${category}/${place.name}.moment`, text: moment.text }, { where: `${category}/${place.name}.motion`, text: moment.motion });
      if (moment.startPose !== undefined) out.push({ where: `${category}/${place.name}.startPose`, text: moment.startPose });
    }
  }
  return out;
}

const BANK_TEXTS: BankText[] = [
  // 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): the ordinary word lists sweep the five ordinary banks (ORDINARY_BANK_CATEGORIES), every rule and row kept; the two
  // «Смелая» banks are swept by banks.bold.sweep.test.ts through the bold content line.
  ...ORDINARY_BANK_CATEGORIES.flatMap((c) => textsOf(c, BANKS[c])),
  ...GAZE.map((g) => ({ where: "gaze", text: g.text })),
  ...CUES.map((c) => ({ where: "cues", text: c.text })),
  ...HAIRSTYLES.map((h) => ({ where: "hair", text: h.text })),
];

/** The engine-side rules, each the first word it hits, or null. */
const ENGINE_RULES: Array<[string, (text: string) => string | null]> = [
  ["revealing", (t) => REVEALING_WORDS.exec(t)?.[0] ?? null],
  ["soft list (with the K-22 exemption)", (t) => SOFT_LIST.exec(withoutExemptLookPhrases(t))?.[0] ?? null],
  ["paper and screens", (t) => PAPER_AND_SCREENS.exec(t)?.[0] ?? null],
  ["staging", (t) => firstHit(t, [...STAGING, ...NEGATED_LOOK])],
  ["youth (descriptor)", (t) => youthWords(t, "descriptor")[0] ?? null],
  ["the assembler's last gate", (t) => sentenceProblems(t)[0]?.reason ?? null],
];

const failures = (texts: readonly BankText[], check: (text: string) => string | null) =>
  texts.flatMap(({ where, text }) => {
    const hit = check(text);
    return hit === null ? [] : [{ where, text, hit }];
  });

const rule = (name: string): ((text: string) => string | null) => ENGINE_RULES.find(([n]) => n === name)?.[1] ?? (() => "no such rule");

describe("the bank sweep: the engine's word lists", () => {
  test("the sweep reads some text, so the scans below are not run on nothing", () => {
    expect(BANK_TEXTS.length).toBeGreaterThan(0);
  });


  test.each(ENGINE_RULES)("no bank text breaks the %s rule", (_name, check) => {
    expect(failures(BANK_TEXTS, check)).toEqual([]);
  });

  // One failing row per rule: the sweep would catch a bank text that broke it.
  test.each<[string, string]>([
    ["revealing", "a bikini top and shorts"],
    ["revealing", "a slip dress"],
    ["revealing", "black stockings"],
    ["soft list (with the K-22 exemption)", "a chic little cafe"],
    ["soft list (with the K-22 exemption)", "satin pajamas"],
    ["soft list (with the K-22 exemption)", "a silk dress"],
    ["paper and screens", "reads a book on the couch"],
    ["staging", "a studio lighting setup"],
    ["youth (descriptor)", "a young girl's backpack"],
    ["the assembler's last gate", "a sports bra and leggings"],
  ])("the %s rule catches «%s»", (name, text) => {
    expect(rule(name)(text)).not.toBeNull();
  });

  test.each<[string]>([["silk pajamas"], ["a mini dress with thin straps"], ["white knee-high socks"], ["thigh-high socks"], ["sheer black tights"], ["a pleated mini skirt and fitted top"]])(
    "«%s» passes every engine rule (K-17, K-22)",
    (text) => {
      expect(ENGINE_RULES.map(([, check]) => check(text))).toEqual(ENGINE_RULES.map(() => null));
    },
  );
});

describe("one source of truth with the engine", () => {
  test("pools.ts re-exports the shared phone and selfie words, not copies of them (S5.6b)", () => {
    expect(PHONE_WORDS).toBe(SHARED_PHONE_WORDS);
    expect(SELFIE_WORDS).toBe(SHARED_SELFIE_WORDS);
  });

  test("the banks' categories are the engine's, in the canonical order (I5.33: the ids stay)", () => {
    expect([...BANK_CATEGORIES]).toEqual([...CATEGORIES]);
  });
});

// The banks seed the pools S5.6b derives from them. «Гламур» is S5.5's evening out, kept as built: its seven places and S5.4's 11 outfits. «Фитнес»
// keeps today's places and outfits. «Дом», «Улица» and «Виды» take the owner's references (r1.2), so their places and outfits change; a place that
// keeps its name keeps what a stored slot relies on (its marks).
describe("the banks seed today's pools", () => {
  const marks = (p: { at?: string; times: readonly string[]; mirror?: true; room?: true }) => ({ at: p.at ?? "", times: [...p.times], mirror: p.mirror, room: p.room });

  test("«Гламур» keeps S5.5's seven places, in order, with their marks, and S5.4's 11 outfits", () => {
    expect(BANKS.glamour.places.map((p) => p.name)).toEqual(POOLS.glamour.locations.map((p) => p.name));
    expect(BANKS.glamour.places.map(marks)).toEqual(POOLS.glamour.locations.map(marks));
    expect(BANKS.glamour.outfits.map((o) => o.text)).toEqual([...POOLS.glamour.outfits]);
  });

  test("«Фитнес» keeps today's places, with their marks, and today's outfits", () => {
    expect(BANKS.fitness.places.map(marks)).toEqual(POOLS.fitness.locations.map(marks));
    expect(BANKS.fitness.outfits.map((o) => o.text)).toEqual([...POOLS.fitness.outfits]);
  });

  test.each([...CATEGORIES])("%s: a place that keeps its name from today's pool keeps its marks", (category) => {
    for (const place of POOLS[category].locations) {
      const bank = BANKS[category].places.find((p) => p.name === place.name);
      if (bank !== undefined) expect(marks(bank)).toEqual(marks(place));
    }
  });
});
