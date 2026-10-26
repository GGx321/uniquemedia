import { describe, expect, test } from "bun:test";
import { SCENE_TEXT_MAX } from "../../shared/engine";
import { CUES, GAZE } from "../../shared/scenes/banks";
import { withoutBoldExemptLook } from "../../shared/scenes/banks/boldRules";
import { explicitActsIn, exposureWordsIn } from "../../shared/scenes/banks/boldDesign.testkit";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import type { CategoryBank } from "../../shared/scenes/banks/types";
import { boldContentLevel, contentProblems } from "../../shared/scenes/contentLine";
import { withoutExemptLookPhrases } from "../../shared/scenes/words";
import { firstHit, NEGATED_LOOK, PAPER_AND_SCREENS, SOFT_LIST, STAGING } from "./testing/lookRules";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA2, plan s5a4 §8 BA2, I5.75, I5.76): the engine's side of the new «Смелая» banks' sweep, the twin of banks.bold.sweep.test.ts. Every text of the five companions and the
// two custom banks, motions, coverage sentences (kept and open alike) and a moment's own details included, is held to the bold content line (youth words only, the exempt garment
// name spared), to the paper, screen and staging lists, and to the bank-design lists (no exposure word, no explicit act). The soft look list holds every item but the satin
// nightwear; a coverage sentence names the garment's material and is not held to it.

interface BankText {
  where: string;
  text: string;
  coverage: boolean;
}

const NEW_BANKS: readonly (readonly [string, CategoryBank])[] = [...Object.entries(BOLD_COMPANIONS), ...Object.entries(CUSTOM_BOLD_BANKS)];

function textsOf(name: string, bank: CategoryBank): BankText[] {
  const out: BankText[] = [];
  const add = (where: string, text: string | undefined, coverage = false): void => {
    if (text !== undefined) out.push({ where: `${name}${where}`, text, coverage });
  };
  bank.outfits.forEach((outfit, i) => {
    add(`.outfits[${i}]`, outfit.text);
    add(`.outfits[${i}].coverage`, outfit.coverage, true);
    add(`.outfits[${i}].openCoverage`, outfit.openCoverage, true);
  });
  for (const item of [...(bank.legwear?.items ?? []), ...(bank.legwear?.bold?.items ?? [])]) add(".legwear", item);
  for (const place of bank.places) {
    add(`/${place.name}`, place.name);
    add(`/${place.name}.at`, place.at);
    for (const detail of place.details) add(`/${place.name}.details`, detail);
    for (const moment of place.moments) {
      add(`/${place.name}.moment`, moment.text);
      add(`/${place.name}.motion`, moment.motion);
      add(`/${place.name}.startPose`, moment.startPose);
      add(`/${place.name}.coverage`, moment.coverage, true);
      add(`/${place.name}.openCoverage`, moment.openCoverage, true);
      for (const detail of moment.details ?? []) add(`/${place.name}: ${moment.text}.details`, detail);
    }
  }
  return out;
}

const TEXTS: BankText[] = NEW_BANKS.flatMap(([name, bank]) => textsOf(name, bank));
const ITEMS = TEXTS.filter((t) => !t.coverage);

const failures = (texts: readonly BankText[], check: (text: string) => string | null) =>
  texts.flatMap(({ where, text }) => {
    const hit = check(text);
    return hit === null ? [] : [{ where, text, hit }];
  });

describe("the new «Смелая» banks' sweep: the engine's word lists", () => {
  test("reads every text of the seven new banks (it is not vacuous)", () => {
    expect(TEXTS.length).toBeGreaterThan(750);
    expect(TEXTS.filter((t) => t.coverage).length).toBeGreaterThanOrEqual(90);
  });

  test("no text breaks the bold content line: no youth word (the exempt garment name spared)", () => {
    expect(failures(TEXTS, (t) => contentProblems(t, boldContentLevel())[0]?.words.join(", ") ?? null)).toEqual([]);
  });

  test("no item uses a soft-list word but the «Смелая» satin nightwear", () => {
    expect(failures(ITEMS, (t) => SOFT_LIST.exec(withoutBoldExemptLook(withoutExemptLookPhrases(t)))?.[0] ?? null)).toEqual([]);
  });

  test("no text names paper or a screen, a staging phrase or a negated look term", () => {
    expect(failures(TEXTS, (t) => PAPER_AND_SCREENS.exec(t)?.[0] ?? null)).toEqual([]);
    expect(failures(TEXTS, (t) => firstHit(t, [...STAGING, ...NEGATED_LOOK]))).toEqual([]);
  });

  test("no text names an exposure word or an explicit act, the open coverage sentences included (I5.76)", () => {
    expect(failures(TEXTS, (t) => exposureWordsIn(t)[0] ?? null)).toEqual([]);
    expect(failures(TEXTS, (t) => explicitActsIn(t)[0] ?? null)).toEqual([]);
  });
});

// The coverage is appended to the scene sentence, and the two together stay within SCENE_TEXT_MAX: the bound is the longest of every clause the template could put together for
// the bank (its capture line is a sentence of its own), so no real combination can pass it.
describe("a new «Смелая» sentence with its coverage fits the scene text bound", () => {
  const longest = (texts: readonly string[]): number => Math.max(0, ...texts.map((t) => t.length));
  const OPENING = "dressed in".length;

  function worstOf(bank: CategoryBank): number {
    const legwear = [...(bank.legwear?.items ?? []), ...(bank.legwear?.bold?.items ?? [])];
    const coverage = [
      ...bank.outfits.flatMap((o) => [o.coverage, o.openCoverage]),
      ...bank.places.flatMap((p) => p.moments.flatMap((m) => [m.coverage, m.openCoverage])),
    ].filter((c): c is string => c !== undefined);
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
      longest(bank.places.flatMap((p) => [...p.details, ...p.moments.flatMap((m) => m.details ?? [])])) +
      ".".length +
      " ".length +
      longest(coverage)
    );
  }

  test.each<[string, number, CategoryBank]>([
    ["home", 389, BOLD_COMPANIONS.home],
    ["travel", 384, BOLD_COMPANIONS.travel],
    ["photoshoot", 428, BOLD_COMPANIONS.photoshoot],
    ["glamour", 367, BOLD_COMPANIONS.glamour],
    ["fitness", 361, BOLD_COMPANIONS.fitness],
    ["rooms", 312, CUSTOM_BOLD_BANKS.rooms],
    ["water", 287, CUSTOM_BOLD_BANKS.water],
  ])("%s: the longest combination is %i characters, under 600", (_name, worst, bank) => {
    expect(worstOf(bank)).toBe(worst);
    expect(worstOf(bank)).toBeLessThanOrEqual(SCENE_TEXT_MAX);
  });
});
