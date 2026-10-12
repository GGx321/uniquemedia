import { describe, expect, test } from "bun:test";
import { GAZE } from "../../shared/scenes/banks";
import { LOOKS_ELSEWHERE } from "../../shared/scenes/banks/schema";
import { boldPromptMatrix, type PromptFrame } from "./boldRunPrompts.testkit";
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
