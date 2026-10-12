import { describe, expect, test } from "bun:test";
import { GAZE } from "../../shared/scenes/banks";
import { COVERS_HER, OPENS_WITH_ARMS_UP } from "../../shared/scenes/banks/boldRules";
import { ARMS_UP, looksElsewhere } from "../../shared/scenes/banks/schema";
import { poseFamilyOf } from "../../shared/scenes/banks/boldDesign.testkit";
import { HELD_OBJECT_WORDS } from "../../shared/scenes/words";
import { boldPromptMatrix, boldRunPrompts, type PromptFrame } from "./testing/boldRunPrompts";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.R4-fix B (the whole-slice review of 5a.3, plan s5a3 §6.2-§6.4): the bank text is the product, and the owner reads it as photo prompts. These sweeps scan the prompts a
// «Смелая» run really sends (testing/boldRunPrompts.ts: planner → template → assembleRun → boldPrompt, as runJob's `promptsOf`), over the review's matrix: both banks, 10 and 20
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
  const elsewhere = FRAMES.filter((f) => looksElsewhere(f.moment.text) || looksElsewhere(f.moment.motion));

  // Round 2: «lies prone, glancing back» is no longer read as a look elsewhere (a glance back names no target), so only the beach has such moments today; the check runs over both.
  test("the sweep reads such frames", () => {
    expect(elsewhere.length).toBeGreaterThan(100);
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

  // S5.R4 round 2 (re-review, LOW): a place detail is said on every frame of its place, the frames in the water among them: «she stands waist-deep, …, with a few seashells in the
  // sand» put the dry shore under a frame in the sea. A frame in the water (waist- or knee-deep, in the water, swimming) names no ground under her as its detail.
  test("a frame in the water names no sand, shells or pebbles as its detail", () => {
    const IN_THE_WATER = /\b(?:waist|knee|thigh|chest)-deep\b|\bin the (?:water|sea|pool)\b|\bswim\w*\b/i;
    const GROUND = /\b(?:sand|seashells?|shells?|pebbles?)\b/i;
    const wet = FRAMES.filter((f) => f.moment.water === true && IN_THE_WATER.test(f.moment.text));
    expect(wet.length).toBeGreaterThan(300);
    expect(offenders(wet, (f) => f.place.room !== true && f.place.details.some((d) => GROUND.test(d) && f.sentence.includes(`, with ${d}.`)))).toEqual(NONE);
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

  // S5.R4 round 2: the legs moments differed in words, not in pose: «legs stretched out» was 3 of 6 legs frames in 30 of 45 «Ночнушки» and 29 of 45 beach runs.
  test.each(["nightwear", "beach"] as const)("%s: no pose family twice among a run's legs frames", (category) => {
    const twice = runsOf(category).flatMap((frames, i) =>
      repeated(frames.filter((f) => f.slot.framing === "legs").map((f) => poseFamilyOf(f.slot.activity ?? "") ?? `none: ${f.slot.activity}`)).map((family) => `seed ${RUN_SEEDS[i]}: ${family}`),
    );
    expect(twice.slice(0, 5)).toEqual([]);
  });

  // With the legs moments apart, a beach run still drew one scene twice in about 2 % of runs (a moment its level's slots share, an outfit list of two to four): «a rooftop pool |
  // looks back over her shoulder | a high-leg black swimsuit» at seed 33, «the water's edge | stretches her arms out, knee-deep | a black bikini» at seed 37.
  test.each(["nightwear", "beach"] as const)("%s: no place, moment and outfit twice in any of the runs", (category) => {
    const twice = runsOf(category).flatMap((frames, i) => repeated(frames.map((f) => `${f.slot.location} | ${f.slot.activity} | ${f.slot.outfit}`)).map((key) => `seed ${RUN_SEEDS[i]}: ${key}`));
    expect(twice.slice(0, 5)).toEqual([]);
  });
});

// Item 4 (MEDIUM, plan s5a3 §6.2 r3.1): «a bold legs slot wears satin nightwear with stockings (the stockings make it bold)». The stockings were drawn at the bold share (0.5), so about
// half of the bold legs frames said «…wearing a satin cami and satin shorts.» and read as flirty ones. Every bold «Ночнушки» legs frame now says them; nothing else moves.
describe("a bold «Ночнушки» legs frame wears the stockings", () => {
  const STOCKINGS = /\bstockings\b/;
  const nightwear = FRAMES.filter((f) => f.slot.category === "nightwear");
  const boldLegs = nightwear.filter((f) => f.slot.framing === "legs" && f.slot.level === "bold");

  test("every one of them says its satin and the stockings", () => {
    expect(boldLegs.length).toBeGreaterThan(300);
    expect(offenders(boldLegs, (f) => !STOCKINGS.test(f.sentence) || !/\bsatin\b/.test(f.slot.outfit ?? ""))).toEqual(NONE);
  });

  test("no frame that is not bold says stockings, and no beach frame does", () => {
    expect(offenders(FRAMES, (f) => STOCKINGS.test(f.prompt) && (f.slot.level !== "bold" || f.slot.category !== "nightwear"))).toEqual(NONE);
  });
});

// Item 5 (LOW): under the duvet or a blanket a bold outfit does not show, and the 2K frame was paid for nothing («curls up with a blanket, wearing a white lace bra and panties»).
// Round 2: nor does the satin a bold slot then wore there («lies curled up under the duvet, wearing a short tied satin robe», 74 of 16 200): a bold slot takes no such moment.
describe("nothing bold goes under a cover", () => {
  const covered = FRAMES.filter((f) => COVERS_HER.test(f.moment.text) || COVERS_HER.test(f.moment.motion));

  test("the sweep reads frames under a cover, on the slots below bold", () => {
    expect(covered.length).toBeGreaterThan(20);
  });

  test("none of them is a bold slot or wears a bold outfit", () => {
    expect(offenders(covered, (f) => f.slot.level === "bold" || f.outfit.level === "bold")).toEqual(NONE);
  });
});

// Item 5 (LOW): with her arms up an open shirt falls open and a cropped tee rides up («lies back with her arms up» in «a cropped tee and cotton panties», 24 frames).
describe("no frame with her arms up wears an open shirt or a crop top", () => {
  const armsUp = FRAMES.filter((f) => ARMS_UP.test(f.moment.text) || ARMS_UP.test(f.moment.motion));

  test("the sweep reads frames with her arms up on bold slots", () => {
    expect(armsUp.filter((f) => f.slot.level === "bold").length).toBeGreaterThan(50);
  });

  test("none of them wears one", () => {
    expect(offenders(armsUp, (f) => OPENS_WITH_ARMS_UP.test(f.outfit.text))).toEqual(NONE);
  });
});
