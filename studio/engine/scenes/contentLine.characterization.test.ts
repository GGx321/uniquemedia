import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AvatarDescriptor } from "../../shared/engine";
import { BANKS, CUES, GAZE, HAIRSTYLES } from "../../shared/scenes/banks";
import { boldContentLevel, contentProblems, type ContentLevel } from "../../shared/scenes/contentLine";
import type { BankCategory, CategoryBank } from "../../shared/scenes/banks/types";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleSlot, sentenceProblems } from "./assembler";
import { plan } from "./planner";
import { POOLS, type Pool } from "./pools";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.9b1: the characterization of the word gate before and after the move. The digests below were taken from `sentenceProblems` as it stood on feat/s5-9a
// (before `contentProblems` existed), over the five built-in banks, the five built-in pools, their dirty variants and real assembled prompts. The level
// parameter must not change a byte at "ordinary" or "flirty": same inputs, same digest.

const FIVE = ["home", "travel", "photoshoot", "glamour", "fitness"] as const satisfies readonly BankCategory[];

/** One word of each kind the gate knows (youth, revealing, both) and a few it must leave alone. Fixed: the digest depends on this list. */
const PROBES = [
  "girl",
  "a little girl",
  "schoolgirl",
  "teen",
  "young",
  "petite",
  "babydoll",
  "baby blue",
  "uniform",
  "bikini",
  "a white string bikini",
  "swimsuit",
  "swimwear",
  "lingerie",
  "sports bra",
  "thong",
  "stockings",
  "stocking",
  "slip dress",
  "robe over lingerie",
  "Stockings and a Bikini",
  "the girl in a bikini",
  "panties",
  "a black lace bra and panties",
  "topless",
  "naked",
  "nude lipstick",
  "sheer black tights",
  "satin slip nightdress",
  "a satin robe",
];

function bankTexts(bank: CategoryBank): string[] {
  const out: string[] = bank.outfits.map((outfit) => outfit.text);
  out.push(...(bank.legwear?.items ?? []));
  for (const place of bank.places) {
    out.push(place.name, place.at, ...place.details);
    for (const moment of place.moments) out.push(moment.text, moment.motion, ...(moment.startPose === undefined ? [] : [moment.startPose]));
  }
  return out;
}

function poolTexts(pool: Pool): string[] {
  const out: string[] = [...pool.outfits];
  for (const place of pool.locations) {
    out.push(place.name, ...(place.at === undefined ? [] : [place.at]), ...(place.details ?? []));
    for (const activity of place.activities) out.push(activity.text);
  }
  return out;
}

const CLEAN: string[] = [
  ...FIVE.flatMap((c) => bankTexts(BANKS[c])),
  ...FIVE.flatMap((c) => poolTexts(POOLS[c])),
  ...GAZE.map((g) => g.text),
  ...CUES.map((c) => c.text),
  ...HAIRSTYLES.map((h) => h.text),
];

/** Every clean text, then each probe alone and after the first twelve clean texts, so a gate that swallows a word in a context shows. */
const TEXTS: string[] = [
  ...CLEAN,
  ...PROBES,
  ...CLEAN.slice(0, 12).flatMap((text) => PROBES.flatMap((probe) => [`${text} ${probe}`, `${probe}, ${text}`])),
];

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair." };
const MASTER = asLibraryReference(JPEG);
const SENTENCE = "She leans on the bridge railing as the evening light turns the river gold.";

/** Real prompts: every slot of three seeded plans of 20 over the five categories, at both mix levels, assembled with a clean sentence. */
function realPrompts(): string[] {
  const out: string[] = [];
  for (const seed of [1, 2, 3]) {
    for (const level of ["ordinary", "flirty"] as const) {
      const scenePlan = plan({ seed, count: 20, categories: [...FIVE], level });
      for (const slot of scenePlan.slots) out.push(assembleSlot(DESCRIPTOR, slot, SENTENCE, MASTER, { runId: `char-${seed}-${level}` }).prompt);
    }
  }
  return out;
}
const PROMPTS = realPrompts();
const DIRTY_PROMPTS = PROMPTS.slice(0, 20).flatMap((prompt) => PROBES.slice(0, 12).map((probe) => `${prompt} ${probe}`));

const digestOf = (texts: readonly string[], check: (text: string) => unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(texts.map((text) => check(text))))
    .digest("hex");

// Pinned from the pre-change `sentenceProblems`:
const PINNED = {
  texts: 1702,
  textsHit: 550,
  textsDigest: "8d8018642ca0aa3650457c864b0ccf05fe1ba03655ab0a468e6514f6c2037406",
  prompts: 360,
  promptsHit: 240,
  promptsDigest: "bdab74557c4381dee85ae876a5455860b214b6d20d5c428f86aa50122115d0d1",
};

const LEVELS_SHARED: Array<"ordinary" | "flirty"> = ["ordinary", "flirty"];
const ALL = [...TEXTS, ...PROMPTS, ...DIRTY_PROMPTS];

describe("the word gate, characterized", () => {
  test("the corpus is not vacuous", () => {
    expect(CLEAN.length).toBeGreaterThan(900);
    expect(PROMPTS).toHaveLength(120);
    expect(TEXTS.filter((t) => sentenceProblems(t).length > 0).length).toBeGreaterThan(300);
  });

  test("sentenceProblems keeps its digests over the banks, the pools and the real prompts", () => {
    const now = {
      texts: TEXTS.length,
      textsHit: TEXTS.filter((t) => sentenceProblems(t).length > 0).length,
      textsDigest: digestOf(TEXTS, sentenceProblems),
      prompts: PROMPTS.length + DIRTY_PROMPTS.length,
      promptsHit: [...PROMPTS, ...DIRTY_PROMPTS].filter((t) => sentenceProblems(t).length > 0).length,
      promptsDigest: digestOf([...PROMPTS, ...DIRTY_PROMPTS], sentenceProblems),
    };
    expect(now).toEqual(PINNED);
  });

  test.each(LEVELS_SHARED)("contentProblems at %s keeps the same digests as sentenceProblems did", (level) => {
    const now = {
      texts: TEXTS.length,
      textsHit: TEXTS.filter((t) => contentProblems(t, level).length > 0).length,
      textsDigest: digestOf(TEXTS, (t) => contentProblems(t, level)),
      prompts: PROMPTS.length + DIRTY_PROMPTS.length,
      promptsHit: [...PROMPTS, ...DIRTY_PROMPTS].filter((t) => contentProblems(t, level).length > 0).length,
      promptsDigest: digestOf([...PROMPTS, ...DIRTY_PROMPTS], (t) => contentProblems(t, level)),
    };
    expect(now).toEqual(PINNED);
  });

  test.each(LEVELS_SHARED)("sentenceProblems is only the alias of contentProblems at ordinary, and %s agrees with it (the pinned digests above are the real guard)", (level) => {
    expect(ALL.filter((t) => JSON.stringify(contentProblems(t, level)) !== JSON.stringify(sentenceProblems(t)))).toEqual([]);
  });

  test("at bold the same corpus never reports a revealing word, and reports the youth words the other levels do except the exempt garment", () => {
    const strays = ALL.filter((t) => contentProblems(t, boldContentLevel()).some((p) => p.reason === "revealing-word"));
    expect(strays).toEqual([]);
    const youthOf = (t: string, level: ContentLevel) => contentProblems(t, level).find((p) => p.reason === "youth-word")?.words ?? [];
    const drifted = ALL.filter((t) => JSON.stringify(youthOf(t, boldContentLevel())) !== JSON.stringify(youthOf(t, "ordinary").filter((w) => !/^babydolls?$/i.test(w))));
    expect(drifted).toEqual([]);
  });
});
