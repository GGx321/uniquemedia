import { describe, expect, test } from "bun:test";
import { youthWords } from "../../shared/engine";
import { BANKS, CUES, GAZE, HAIRSTYLES } from "../../shared/scenes/banks";
import { LIGHTS } from "../../shared/scenes/banks/lights";
import { BANK_CATEGORIES, type CategoryBank } from "../../shared/scenes/banks/types";
import { PHONE_WORDS as SHARED_PHONE_WORDS, SELFIE_WORDS as SHARED_SELFIE_WORDS } from "../../shared/scenes/words";
import { sentenceProblems } from "./assembler";
import { PHONE_WORDS, POOLS, SELFIE_WORDS } from "./pools";
import { firstHit, NEGATED_LOOK, PAPER_AND_SCREENS, SOFT_LIST, STAGING } from "./testing/lookRules";
import { CATEGORIES } from "./types";
import { REVEALING_WORDS } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6a, I5.21): the engine's side of the bank sweep. The shared banks validate themselves at load with the rules shared code can hold
// (shared/scenes/banks/schema.ts); the word lists that live in the engine (the revealing words, the writer's soft list, paper and screens, the
// staging phrases, the assembler's last gate) are swept here over every bank text, with a negative control per list.

interface BankText {
  where: string;
  text: string;
}

function textsOf(category: string, bank: CategoryBank): BankText[] {
  const out: BankText[] = bank.outfits.map((text, i) => ({ where: `${category}.outfits[${i}]`, text }));
  for (const item of bank.legwear ?? []) out.push({ where: `${category}.legwear`, text: item.text });
  for (const place of bank.places) {
    out.push({ where: `${category}/${place.name}`, text: place.name }, { where: `${category}/${place.name}.at`, text: place.at });
    for (const detail of place.details) out.push({ where: `${category}/${place.name}.details`, text: detail });
    for (const moment of place.moments) out.push({ where: `${category}/${place.name}.moment`, text: moment.text });
  }
  return out;
}

const BANK_TEXTS: BankText[] = [
  ...BANK_CATEGORIES.flatMap((c) => textsOf(c, BANKS[c])),
  ...GAZE.map((g) => ({ where: "gaze", text: g.text })),
  ...CUES.map((c) => ({ where: "cues", text: c.text })),
  ...HAIRSTYLES.map((h) => ({ where: "hair", text: h.text })),
  ...LIGHTS.map((l) => ({ where: "lights", text: l.text })),
];

/** The engine-side rules, each the first word it hits, or null. */
const ENGINE_RULES: Array<[string, (text: string) => string | null]> = [
  ["revealing", (t) => REVEALING_WORDS.exec(t)?.[0] ?? null],
  ["soft list", (t) => SOFT_LIST.exec(t)?.[0] ?? null],
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

describe("the bank sweep: the engine's word lists", () => {
  test("reads every bank text (it is not vacuous)", () => {
    const places = BANK_CATEGORIES.reduce((n, c) => n + BANKS[c].places.length, 0);
    expect(places).toBeGreaterThanOrEqual(30);
    expect(BANK_TEXTS.length).toBeGreaterThan(places * 7);
  });

  test.each(ENGINE_RULES)("no bank text breaks the %s rule", (_name, check) => {
    expect(failures(BANK_TEXTS, check)).toEqual([]);
  });

  // One failing row per rule: the sweep would catch a bank text that broke it.
  test.each<[string, string]>([
    ["revealing", "a bikini top and shorts"],
    ["soft list", "a chic little cafe"],
    ["paper and screens", "reads a book on the couch"],
    ["staging", "a studio lighting setup"],
    ["youth (descriptor)", "a young girl's backpack"],
    ["the assembler's last gate", "a sports bra and leggings"],
  ])("the %s rule catches «%s»", (name, text) => {
    const rule = ENGINE_RULES.find(([n]) => n === name);
    expect(rule?.[1](text)).not.toBeNull();
  });
});

describe("one source of truth with the engine", () => {
  test("the shared phone and selfie words are the engine's own (S5.6b points pools.ts at the shared copies)", () => {
    expect({ source: SHARED_PHONE_WORDS.source, flags: SHARED_PHONE_WORDS.flags }).toEqual({ source: PHONE_WORDS.source, flags: PHONE_WORDS.flags });
    expect({ source: SHARED_SELFIE_WORDS.source, flags: SHARED_SELFIE_WORDS.flags }).toEqual({ source: SELFIE_WORDS.source, flags: SELFIE_WORDS.flags });
  });

  test("the banks' categories are the engine's, in the canonical order", () => {
    expect([...BANK_CATEGORIES]).toEqual([...CATEGORIES]);
  });
});

// The banks seed today's pools (plan s5a2 §5.1): S5.6b derives POOLS from them. Moments replace activities (finite verb phrases now), so only the
// places, the outfits and the decks are compared. The owner's style references (2026-10-11) replace places in «Дом», «Улица» and «Виды», so a place
// may go; one that stays keeps what a stored plan's slot relies on (its name finds it, its marks place the mirror and the room).
describe("the banks seed today's pools", () => {
  test.each([...CATEGORIES])("%s keeps today's outfits and shot deck, untouched (K-10)", (category) => {
    expect(BANKS[category].outfits).toEqual(POOLS[category].outfits);
    expect(BANKS[category].shotDeck).toEqual(POOLS[category].shotDeck);
  });

  test.each([...CATEGORIES])("%s: a place kept from today's pool keeps its locative phrase, times, mirror and room marks", (category) => {
    const kept = POOLS[category].locations.flatMap((place) => {
      const bank = BANKS[category].places.find((p) => p.name === place.name);
      return bank === undefined ? [] : [{ bank, place }];
    });
    expect(kept.length).toBeGreaterThan(0);
    for (const { bank, place } of kept) {
      const marks = (p: { at?: string; times: readonly string[]; mirror?: true; room?: true }) => ({ at: p.at ?? "", times: [...p.times], mirror: p.mirror, room: p.room });
      expect(marks(bank)).toEqual(marks(place));
    }
  });

  test("Glamour is S5.5's evening out: the same seven places, in the same order", () => {
    expect(BANKS.glamour.places.map((p) => p.name)).toEqual(POOLS.glamour.locations.map((p) => p.name));
  });
});
