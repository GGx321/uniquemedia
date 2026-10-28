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

// Pinned from the pre-change `sentenceProblems`, then re-pinned once, on purpose, by the S5.9b1 review (the revealing vocabulary grew: panties, bras, topless,
// naked, plurals, and the text is folded before it is read). Of the 2062 inputs below, exactly 100 changed, all in `texts`: the probes «panties», «topless»,
// «naked» and «a black lace bra and panties» (old result: none) alone, and each joined to the first twelve clean texts (2 x 12 x 4 = 96). Their new results
// are listed literally in the test after this table. Every bank text, pool text and real prompt kept its result; the prompts digest below is the pre-change one.
const PINNED = {
  texts: 1702,
  textsHit: 650,
  textsDigest: "acf0149931704b372a949fc1455c90ffd10489901c57bd47b5978ec4e5598275",
  prompts: 360,
  promptsHit: 240,
  promptsDigest: "bdab74557c4381dee85ae876a5455860b214b6d20d5c428f86aa50122115d0d1",
};

/** Newly refused words, plurals and tricks (S5.9b1 review), and three look-alikes that must stay legal. */
const NEW_PROBES = [
  "bikinis", "thongs", "swimsuits", "slip dresses", "bra", "a lace bra", "bras", "bralette", "underwear", "briefs", "panty",
  "Ｂｉｋｉｎｉ", "bi\u200bkini", "b i k i n i", "t.h.o.n.g", "nude lipstick", "a briefcase and a bracelet", "a zebra print scarf",
];
const NEW_PROBES_REFUSED = 15;
const NEW_PROBES_DIGEST = "ca12fc0a5dede1199a06605c446ff1a2bbe13e94c379d17de1c3f1cf43641af3";

const LEVELS_SHARED: Array<"ordinary" | "flirty"> = ["ordinary", "flirty"];
const ALL = [...TEXTS, ...PROMPTS, ...DIRTY_PROMPTS];

describe("the word gate, characterized", () => {

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

  test("four of the old probes changed their result (22 were refused before, 26 are now), and these are the new results", () => {
    expect(contentProblems("panties", "ordinary")).toEqual([{ reason: "revealing-word", words: ["panties"] }]);
    expect(contentProblems("topless", "ordinary")).toEqual([{ reason: "revealing-word", words: ["topless"] }]);
    expect(contentProblems("naked", "ordinary")).toEqual([{ reason: "revealing-word", words: ["naked"] }]);
    expect(contentProblems("a black lace bra and panties", "ordinary")).toEqual([{ reason: "revealing-word", words: ["bra", "panties"] }]);
    expect(PROBES.filter((probe) => contentProblems(probe, "ordinary").length > 0)).toHaveLength(26);
  });

  test.each(LEVELS_SHARED)("the new vocabulary probes keep their pinned results at %s", (level) => {
    const refused = NEW_PROBES.filter((probe) => contentProblems(probe, level).some((p) => p.reason === "revealing-word"));
    expect(refused).toHaveLength(NEW_PROBES_REFUSED);
    expect(NEW_PROBES.filter((probe) => !refused.includes(probe))).toEqual(["nude lipstick", "a briefcase and a bracelet", "a zebra print scarf"]);
    expect(digestOf(NEW_PROBES, (t) => contentProblems(t, level))).toBe(NEW_PROBES_DIGEST);
  });

  test("the new vocabulary probes are legal at bold", () => {
    expect(NEW_PROBES.filter((probe) => contentProblems(probe, boldContentLevel()).length > 0)).toEqual([]);
  });
});
