import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOLD_CATEGORIES, SCENE_TEXT_MAX, youthWords, type BoldCategory } from "../../shared/engine";
import { BANKS, CUES, GAZE } from "../../shared/scenes/banks";
import { BOLD_EXEMPT_LOOK, withoutBoldExemptLook } from "../../shared/scenes/banks/boldRules";
import { explicitActsIn, exposureWordsIn } from "../../shared/scenes/banks/boldDesign.testkit";
import { boldBankProblems } from "../../shared/scenes/banks/schema";
import type { CategoryBank } from "../../shared/scenes/banks/types";
import { boldContentLevel, contentProblems } from "../../shared/scenes/contentLine";
import { REVEALING_WORDS, revealingWordsIn, withoutExemptLookPhrases } from "../../shared/scenes/words";
import { BoldPoolSchema, BuiltInPoolSchema, POOLS } from "./pools";
import { firstHit, NEGATED_LOOK, PAPER_AND_SCREENS, SOFT_LIST, STAGING } from "./testing/lookRules";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9b2, plan s5a3 §6.4 r3, §5.2, I5.37): the engine's side of the «Смелая» banks' sweep, the twin of banks.sweep.test.ts (which holds the five to the
// ordinary lists). Every text of the two banks, motions, start poses and coverage sentences included, is held to the bold content line (youth words only, the
// exempt garment name spared), to the paper, screen and staging lists, and to the bank-design lists (no exposure word, no explicit act, never a runtime gate).
// The soft look list holds every item but the satin nightwear of banks/boldRules.ts; a coverage sentence names the garment's own material and is not held
// to it. What the S5.8 gates refuse in these banks is allowed only through boldRules.ts, and only here.

interface BankText {
  where: string;
  text: string;
  coverage: boolean;
}

function textsOf(category: string, bank: CategoryBank): BankText[] {
  const out: BankText[] = [];
  const add = (where: string, text: string, coverage = false): void => {
    out.push({ where: `${category}${where}`, text, coverage });
  };
  bank.outfits.forEach((outfit, i) => {
    add(`.outfits[${i}]`, outfit.text);
    if (outfit.coverage !== undefined) add(`.outfits[${i}].coverage`, outfit.coverage, true);
  });
  for (const item of [...(bank.legwear?.items ?? []), ...(bank.legwear?.bold?.items ?? [])]) add(".legwear", item);
  for (const place of bank.places) {
    add(`/${place.name}`, place.name);
    add(`/${place.name}.at`, place.at);
    for (const detail of place.details) add(`/${place.name}.details`, detail);
    for (const moment of place.moments) {
      add(`/${place.name}.moment`, moment.text);
      add(`/${place.name}.motion`, moment.motion);
      if (moment.startPose !== undefined) add(`/${place.name}.startPose`, moment.startPose);
      if (moment.coverage !== undefined) add(`/${place.name}.coverage`, moment.coverage, true);
    }
  }
  return out;
}

const TEXTS: BankText[] = BOLD_CATEGORIES.flatMap((c) => textsOf(c, BANKS[c]));
const ITEMS = TEXTS.filter((t) => !t.coverage);
const COVERAGE = TEXTS.filter((t) => t.coverage);

const failures = (texts: readonly BankText[], check: (text: string) => string | null) =>
  texts.flatMap(({ where, text }) => {
    const hit = check(text);
    return hit === null ? [] : [{ where, text, hit }];
  });

describe("the «Смелая» banks' sweep: the engine's word lists", () => {
  test("reads every text of the two banks (it is not vacuous)", () => {
    expect(TEXTS.length).toBeGreaterThan(200);
    expect(COVERAGE.length).toBeGreaterThanOrEqual(25);
  });

  test("no text breaks the bold content line: no youth word (the exempt garment name spared)", () => {
    expect(failures(TEXTS, (t) => contentProblems(t, boldContentLevel())[0]?.words.join(", ") ?? null)).toEqual([]);
  });

  test("no item uses a soft-list word but the «Смелая» satin nightwear (and K-22's silk pajamas)", () => {
    expect(failures(ITEMS, (t) => SOFT_LIST.exec(withoutBoldExemptLook(withoutExemptLookPhrases(t)))?.[0] ?? null)).toEqual([]);
  });

  test("no text names paper or a screen, a staging phrase or a negated look term", () => {
    expect(failures(TEXTS, (t) => PAPER_AND_SCREENS.exec(t)?.[0] ?? null)).toEqual([]);
    expect(failures(TEXTS, (t) => firstHit(t, [...STAGING, ...NEGATED_LOOK]))).toEqual([]);
  });

  test("no text names an exposure word or an explicit act (bank design, I5.37)", () => {
    expect(failures(TEXTS, (t) => exposureWordsIn(t)[0] ?? null)).toEqual([]);
    expect(failures(TEXTS, (t) => explicitActsIn(t)[0] ?? null)).toEqual([]);
  });

  // One failing row per list: the sweep would catch a «Смелая» text that broke it.
  test.each<[string, (text: string) => boolean, string]>([
    ["the bold content line", (t) => contentProblems(t, boldContentLevel()).length > 0, "a petite schoolgirl set"],
    ["the soft list", (t) => SOFT_LIST.test(withoutBoldExemptLook(withoutExemptLookPhrases(t))), "satin pajamas"],
    ["the soft list", (t) => SOFT_LIST.test(withoutBoldExemptLook(withoutExemptLookPhrases(t))), "a glamorous lace bodysuit"],
    ["paper and screens", (t) => PAPER_AND_SCREENS.test(t), "reads a magazine in bed"],
    ["staging", (t) => firstHit(t, [...STAGING, ...NEGATED_LOOK]) !== null, "softly lit by the window"],
    ["exposure", (t) => exposureWordsIn(t).length > 0, "topless on the bed"],
    ["explicit", (t) => explicitActsIn(t).length > 0, "on all fours on the bed"],
  ])("%s catches «%s»", (_name, catches, text) => {
    expect(catches(text)).toBe(true);
  });
});

describe("what the S5.8 gates refuse here is allowed through boldRules.ts only", () => {
  const ordinaryRefusal = (t: string): string[] => [
    ...revealingWordsIn(t),
    ...youthWords(t, "descriptor"),
    ...(SOFT_LIST.exec(withoutExemptLookPhrases(t))?.slice(0, 1) ?? []),
  ];
  const refused = ITEMS.filter((t) => ordinaryRefusal(t.text).length > 0);

  test("the five's gates refuse the «Смелая» vocabulary of these banks: lingerie, swimwear, stockings, satin and the babydoll", () => {
    const words = new Set(refused.flatMap((t) => ordinaryRefusal(t.text).map((w) => w.toLowerCase())));
    expect([...words].sort()).toEqual(["babydoll", "bikini", "bra", "briefs", "panties", "satin", "stockings", "swimsuit"]);
  });

  test("each such text passes the bold content line and the soft list minus the satin nightwear: the exemptions are the reason, nothing else", () => {
    for (const { where, text } of refused) {
      expect({ where, bold: contentProblems(text, boldContentLevel()) }).toEqual({ where, bold: [] });
      expect({ where, soft: SOFT_LIST.exec(withoutBoldExemptLook(withoutExemptLookPhrases(text)))?.[0] ?? null }).toEqual({ where, soft: null });
    }
  });

  test("the five's pool schema refuses the «Смелая» pools, and their own schema accepts them", () => {
    for (const category of BOLD_CATEGORIES) {
      expect(BuiltInPoolSchema.safeParse(POOLS[category]).success, category).toBe(false);
      expect(BoldPoolSchema.safeParse(POOLS[category]).success, category).toBe(true);
      expect(boldBankProblems(BANKS[category]), category).toEqual([]);
    }
  });

  test("the global lists keep refusing: the revealing words, the youth rule and the soft list have no exemption of their own", () => {
    for (const word of ["bikini", "stockings", "panties", "a black lace bra and panties"]) expect(REVEALING_WORDS.test(word), word).toBe(true);
    expect(youthWords("a sheer babydoll over a lace set", "descriptor")).toEqual(["babydoll"]);
    for (const phrase of BOLD_EXEMPT_LOOK) expect(SOFT_LIST.test(withoutExemptLookPhrases(phrase)), phrase).toBe(true);
  });

  test("shared/scenes/words.ts names none of the exemptions: they live in banks/boldRules.ts", () => {
    const words = readFileSync(join(import.meta.dir, "../../shared/scenes/words.ts"), "utf8");
    expect(words).not.toMatch(/babydoll/i);
    for (const phrase of BOLD_EXEMPT_LOOK) expect(words.includes(phrase), phrase).toBe(false);
  });
});

// Plan s5a3 §7.3: the coverage is appended to the scene sentence (S5.9c), and the two together stay within SCENE_TEXT_MAX. The bound is the longest of every
// clause the template could put together for the bank, so no real combination can pass it.
describe("a «Смелая» sentence with its coverage fits the scene text bound", () => {
  const longest = (texts: readonly string[]): number => Math.max(0, ...texts.map((t) => t.length));
  const OPENING = "dressed in".length;

  function worstOf(category: BoldCategory): number {
    const bank = BANKS[category];
    const legwear = [...(bank.legwear?.items ?? []), ...(bank.legwear?.bold?.items ?? [])];
    const coverage = [...bank.outfits.flatMap((o) => (o.coverage === undefined ? [] : [o.coverage])), ...bank.places.flatMap((p) => p.moments.flatMap((m) => (m.coverage === undefined ? [] : [m.coverage])))];
    return (
      longest(bank.places.map((p) => p.at)) +
      ", she ".length +
      longest(bank.places.flatMap((p) => p.moments.map((m) => m.text))) +
      ", ".length +
      OPENING +
      " ".length +
      longest(bank.outfits.map((o) => o.text)) +
      (legwear.length > 0 ? " with ".length + longest(legwear) : 0) +
      ", ".length +
      longest(GAZE.map((g) => g.text)) +
      ", ".length +
      longest(CUES.map((c) => c.text)) +
      ", with ".length +
      longest(bank.places.flatMap((p) => p.details)) +
      ".".length +
      " ".length +
      longest(coverage)
    );
  }

  test.each<[BoldCategory, number]>([
    ["nightwear", 406],
    // S5.R4: 318 -> 326, the pool's «a glass of iced tea on a side table» (35) is now the longest detail.
    ["beach", 326],
  ])("%s: the longest combination is %i characters, under 600", (category, worst) => {
    expect(worstOf(category)).toBe(worst);
    expect(worstOf(category)).toBeLessThanOrEqual(SCENE_TEXT_MAX);
  });
});
