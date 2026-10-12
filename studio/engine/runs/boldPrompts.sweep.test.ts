import { describe, expect, test } from "bun:test";
import { GAZE } from "../../shared/scenes/banks";
import { LOOKS_ELSEWHERE } from "../../shared/scenes/banks/schema";
import { HELD_OBJECT_WORDS } from "../../shared/scenes/words";
import { boldPromptMatrix, boldRunPrompts, type PromptFrame } from "./boldRunPrompts.testkit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.R4-fix B (the whole-slice review of 5a.3, plan s5a3 §6.2-§6.4): the bank text is the product, and the owner reads it as photo prompts. These sweeps scan the prompts a
// «Смелая» run really sends (boldRunPrompts.testkit.ts: planner → template → assembleRun → boldPrompt, as runJob's `promptsOf`), over the review's matrix: both banks, 10 and 20
// photos, «Ножки» 0 / 15 / 30 %, «Реализм камеры» on and off, 40 seeds each.

const SEEDS = 40;
const FRAMES: readonly PromptFrame[] = boldPromptMatrix(SEEDS);

/** What a failing sweep shows: how many frames broke the rule, and a few of their sentences. */
function offenders(frames: readonly PromptFrame[], broken: (frame: PromptFrame) => boolean): { count: number; sample: string[] } {
  const hits = frames.filter(broken);
  return { count: hits.length, sample: [...new Set(hits.map((f) => `${f.slot.category} | ${f.capture} | ${f.sentence}`))].slice(0, 3) };
}
const NONE = { count: 0, sample: [] };

test("the matrix is the review's: both banks, every size, legs share and realism, 40 seeds", () => {
  expect(FRAMES.length).toBe(2 * (10 + 20) * 3 * 2 * SEEDS);
  expect(new Set(FRAMES.map((f) => f.slot.category))).toEqual(new Set(["nightwear", "beach"]));
});

// Item 1 (MEDIUM): «sits on a ledge, watching dusk fall» lost its own gaze and drew «…watching dusk fall, …, looking up at the viewer» in most of its frames.
describe("a moment that looks at something other than the viewer takes no gaze of the template's", () => {
  const elsewhere = FRAMES.filter((f) => LOOKS_ELSEWHERE.test(f.moment.text) || LOOKS_ELSEWHERE.test(f.moment.motion));

  test("the sweep reads such frames in both banks", () => {
    expect(new Set(elsewhere.map((f) => f.slot.category))).toEqual(new Set(["nightwear", "beach"]));
  });

  test("none of them says a gaze clause next to its own look", () => {
    expect(offenders(elsewhere, (f) => GAZE.some((g) => f.sentence.includes(g.text)))).toEqual(NONE);
  });
});

// Item 2 (MEDIUM): a place detail is said as «…, with {detail}.» at the end of the scene sentence, and the room phrase says its details the same way. A detail that is an object
// she could hold («a glass of iced tea», «a canvas tote bag») reads as a prop in her hands: the owner asked «зачем?» of a glass of water and a bag, and a frame whose phone line says
// «her other hand is free and holds nothing» contradicted it. Such a detail sits in the place («… on a side table», «… beside her»), or the place says scenery instead.

/** The objects she could hold: the timer rule's held objects (shared/scenes/words.ts), and what a beach or a pool adds. */
const EXTRA_HOLDABLE = /\b(?:totes?|baskets?|purses?|drinks?|tea|juice|cocktails?|wine|books?|magazines?|umbrellas?|parasols?|hats?|sunglasses|fans?|(?:sea)?shells?|flowers?|bouquets?|balls?|towels?)\b/i;
const holdable = (item: string): boolean => HELD_OBJECT_WORDS.test(item) || EXTRA_HOLDABLE.test(item);
/** A phrase that puts the object somewhere in the place, never in her hands, on her arm or over her shoulder. */
const SITED = /\b(?:on|in|by|beside|behind|under|beneath|against|along|near|next to|across|over|inside|atop)\s+(?!(?:her|one)\s+(?:hands?|arms?|shoulders?|lap|wrists?|fingers?)\b)\S|\b(?:overhead|nearby)\b/i;

/** The items of every «, with …» clause of a prompt (the scene sentence's detail, the room phrase), one by one. */
function withItems(prompt: string): string[] {
  return Array.from(prompt.matchAll(/,\s+with\s+([^,.;]+)(?=[.,;])/g), (m) => m[1] ?? "").flatMap((clause) => clause.split(/\s+and\s+/));
}
/** The held objects a prompt leaves dangling: a «with» item that names one and does not put it anywhere. */
const danglingIn = (prompt: string): string[] => withItems(prompt).filter((item) => holdable(item) && !SITED.test(item));

describe("a place detail never dangles as a prop in her hands", () => {
  test("the detector: a held object said with no place dangles; one that sits in the place, or scenery, does not", () => {
    expect(danglingIn("On a sandy beach, she sits, wearing a black bikini, a slow smile, with a glass of iced tea.")).toEqual(["a glass of iced tea"]);
    expect(danglingIn("By a hotel pool, she sits, wearing a black bikini, with a canvas tote bag.")).toEqual(["a canvas tote bag"]);
    expect(danglingIn("By a hotel pool, she sits, wearing a black bikini, with a tote bag over her shoulder.")).toEqual(["a tote bag over her shoulder"]);
    expect(danglingIn("By a hotel pool, she sits, wearing a black bikini, with a glass of iced tea on a side table.")).toEqual([]);
    expect(danglingIn("The room looks lived-in, with a bedside lamp and a glass of water on the nightstand.")).toEqual([]);
    expect(danglingIn("On the rocks by the sea, she sits, wearing a black bikini, with the warm evening sky.")).toEqual([]);
  });

  test("the sweep reads «with» details and held objects that sit in the place, in both banks", () => {
    for (const category of ["nightwear", "beach"] as const) {
      const items = FRAMES.filter((f) => f.slot.category === category).flatMap((f) => withItems(f.prompt));
      expect(items.filter(holdable).length, category).toBeGreaterThan(100);
    }
  });

  test("no prompt carries a held object as a place detail with no place of its own", () => {
    expect(offenders(FRAMES, (f) => danglingIn(f.prompt).length > 0)).toEqual(NONE);
  });

  test("no prompt says her other hand holds nothing while a place detail puts an object in it", () => {
    const empty = FRAMES.filter((f) => f.prompt.includes("holds nothing"));
    expect(empty.length).toBeGreaterThan(500);
    expect(offenders(empty, (f) => danglingIn(f.prompt).length > 0)).toEqual(NONE);
  });
});

// Item 3 (MEDIUM): at 20 photos and «Ножки» 30 % a run holds 6 legs slots. With 4 legs moments a bank, two of them came twice in every run, and the same scene (place, moment and
// outfit: «her bed | lies with her legs crossed | a satin cami and satin shorts») was paid for twice in 16 of 40 «Ночнушки» runs and 14 of 40 beach runs.
describe("a 20-photo run with «Ножки» 30 % never pays for the same scene twice", () => {
  const RUN_SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
  const runsOf = (category: "nightwear" | "beach"): PromptFrame[][] => RUN_SEEDS.map((seed) => boldRunPrompts({ category, seed, count: 20, legsShare: 30, cameraRealism: false }));
  const repeated = (keys: readonly string[]): string[] => keys.filter((key, i) => keys.indexOf(key) !== i);

  test.each(["nightwear", "beach"] as const)("%s: 6 legs slots a run, and no legs moment twice", (category) => {
    const runs = runsOf(category);
    for (const frames of runs) expect(frames.filter((f) => f.slot.framing === "legs")).toHaveLength(6);
    const twice = runs.flatMap((frames, i) => repeated(frames.filter((f) => f.slot.framing === "legs").map((f) => `${f.slot.location} | ${f.slot.activity}`)).map((key) => `seed ${RUN_SEEDS[i]}: ${key}`));
    expect(twice.slice(0, 5)).toEqual([]);
  });

  // With the legs moments apart, a beach run still drew one scene twice in about 2 % of runs (a moment its level's slots share, an outfit list of two to four): «a rooftop pool |
  // looks back over her shoulder | a high-leg black swimsuit» at seed 33, «the water's edge | stretches her arms out, knee-deep | a black bikini» at seed 37.
  test.each(["nightwear", "beach"] as const)("%s: no place, moment and outfit twice in any of the runs", (category) => {
    const twice = runsOf(category).flatMap((frames, i) => repeated(frames.map((f) => `${f.slot.location} | ${f.slot.activity} | ${f.slot.outfit}`)).map((key) => `seed ${RUN_SEEDS[i]}: ${key}`));
    expect(twice.slice(0, 5)).toEqual([]);
  });
});
