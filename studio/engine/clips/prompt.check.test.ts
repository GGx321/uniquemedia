import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PhotoSidecarSchema } from "../library/schemas";
import { RunPlanSchema } from "../runs/plan";
import type { PlanSlot } from "../scenes/schema";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { clipMotionProblems, clipPromptOf, poseSentenceFor } from "./prompt";
import { PROMPT_WORDS_MAX, type ClipDialect } from "./videoLook";
import { photoOf, pick, sceneRun, slotOf } from "./testing/frameFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC2 (plan s5b2 I5.66): the clip prompt is built on the one motion check. A text is checked as what it is (`scene`, `code`, `vision`, `own`); a scene or code
// call that names no source keeps 5b.1's behaviour, so every existing prompt and pin stays byte for byte. `clipMotionProblems` is what an LLM motion must pass before it is
// offered (WC3): the check, then the prompt within 130 words in both dialects.

const DIALECTS: readonly ClipDialect[] = ["kling", "grok"];

function factsOf(result: FrameFactsResult): FrameFacts {
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}

const TIMER = ((): FrameFacts => {
  const run = sceneRun("run-00000501", [slotOf(pick("home", (m) => m.captures.includes("timer") && m.legs === undefined && m.angle === undefined), "timer")]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run));
})();

const FRIEND = ((): FrameFacts => {
  const run = sceneRun("run-00000502", [slotOf(pick("travel", (m) => m.captures.includes("friend") && m.legs === undefined && m.phone !== true && m.angle === undefined), "friend")]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run));
})();

const K1 = ((): FrameFacts => {
  const k1 = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "c3-k1.json"), "utf8")) as { photo: unknown; plan: unknown };
  return factsOf(frameFactsOf(PhotoSidecarSchema.parse(k1.photo), RunPlanSchema.parse(k1.plan)));
})();

const SIXTY_ONE = "she slowly turns her head a little toward the window and back";

describe("the prompt takes the text's source (I5.66)", () => {
  test("a scene call (no source) keeps 5b.1's checks: a 61-character text still makes a prompt", () => {
    expect(SIXTY_ONE.length).toBe(61);
    expect(clipPromptOf(TIMER, SIXTY_ONE, "kling").ok).toBe(true);
  });

  test("the same text as a vision or an own motion takes the bank's grammar and makes no prompt, in either dialect", () => {
    for (const source of ["vision", "own"] as const) for (const dialect of DIALECTS) expect(clipPromptOf(TIMER, SIXTY_ONE, dialect, source).ok).toBe(false);
  });

  test("on C3 K1 a vision or own text that names her phone makes no prompt (the planned hand-held capture)", () => {
    for (const source of ["vision", "own"] as const) for (const dialect of DIALECTS) expect(clipPromptOf(K1, "she slowly glances at her phone", dialect, source).ok).toBe(false);
  });
});

describe("the activity takes the same phone rule (one phone rule)", () => {
  test("on C3 K1 an activity that names her phone is left out: the plan says the phone was in her hand", () => {
    expect(poseSentenceFor({ ...K1, activity: "texting on her phone" })).toBeNull();
  });

  test("on a friend's photo the same activity stays (no phone in her hand there)", () => {
    expect(poseSentenceFor({ ...FRIEND, activity: "texting on her phone" })).toBe("The adult woman is texting on her phone.");
  });
});

describe("clipMotionProblems: what an LLM motion must pass before it is offered (WC3)", () => {
  test("a text that passes the check and fits the cap in both dialects has no problem", () => {
    expect(clipMotionProblems(FRIEND, "she slowly turns her head a little toward the window", "vision")).toEqual([]);
  });

  test("the check's closed problems, in the display order", () => {
    expect(clipMotionProblems(FRIEND, "slowly she turns her head", "vision")).toEqual(["not-motion"]);
    expect(clipMotionProblems(K1, "she glances at her phone", "own")).toEqual(["phone", "not-small"]);
  });

  test("a prompt over 130 words in either dialect: too-long", () => {
    const long = { ...TIMER, activity: `lies ${"very ".repeat(110)}still` };
    const result = clipPromptOf(long, "she slowly turns her head", "kling", "vision");
    expect(result.ok).toBe(false);
    expect(clipMotionProblems(long, "she slowly turns her head", "vision")).toEqual(["too-long"]);
    expect(PROMPT_WORDS_MAX).toBe(130);
  });
});
