import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PhotoSidecarSchema } from "../library/schemas";
import { RunPlanSchema } from "../runs/plan";
import type { PlanSlot } from "../scenes/schema";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { clipMotionProblems, clipPromptOf, poseSentenceFor } from "./prompt";
import { CLIP_CAPTURES, COMES_OFF_LINE, CONTINUITY_LINE, LOOK_LINE, NOTHING_NEW_LINE, PROMPT_WORDS_MAX, SLOW_LINE, cameraLineOf, continuityLineOf, wordCount, type ClipDialect } from "./videoLook";
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

// ---------- Q-H = 2 (the owner, 2026-10-14) ----------

/** A frame of «Смелая»: probe P-V's S3 (a mirror selfie in «Ночнушки и бельё», one hand on her hip, nothing in her other hand), with the slot's legwear when asked. */
function boldMirror(legwear?: string): FrameFacts {
  const picked = pick("nightwear", (m) => m.text === "stands with one hand on her hip" && m.captures.includes("mirror") && m.noLegwear !== true);
  const run = sceneRun("run-00000503", [slotOf(picked, "mirror", "front", legwear === undefined ? {} : { legwear })]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run));
}

const ROBE = "she slowly takes off her robe";

describe("the continuity line of an own idea that takes clothing off, on a frame of «Смелая»: «Nothing new appears.» alone (Q-H = 2, plan §5.3)", () => {
  test("the line itself, and the one a motion that takes clothing off takes", () => {
    expect(NOTHING_NEW_LINE).toBe("Nothing new appears.");
    expect(continuityLineOf(ROBE, null)).toBe("Nothing new appears.");
  });

  test("the prompt carries it in place of the base line or «comes off», and no clothing clause at all", () => {
    const result = clipPromptOf(boldMirror(), ROBE, "kling", "own");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.prompt).toContain(`Over the whole clip ${ROBE}. Nothing new appears. ${SLOW_LINE}`);
    expect(result.prompt).not.toContain(CONTINUITY_LINE);
    expect(result.prompt).not.toContain(COMES_OFF_LINE);
  });

  test("on a frame with legwear the legwear line goes too: it is a clothing clause the idea may contradict (Kling decides)", () => {
    const facts = boldMirror("sheer black stockings");
    const kept = clipPromptOf(facts, "she slowly turns her hips a little", "kling", "own");
    if (!kept.ok) throw new Error(kept.problems.join("; "));
    expect(kept.prompt).toContain("Her sheer black stockings stay on her feet the whole time.");
    const result = clipPromptOf(facts, ROBE, "kling", "own");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.prompt).not.toContain("stay on her feet");
    expect(result.prompt).toContain(`Nothing new appears. ${SLOW_LINE}`);
  });

  test("never elsewhere: a vision text on «Смелая», an own idea on any other frame, make no prompt", () => {
    expect(clipPromptOf(boldMirror(), ROBE, "kling", "vision").ok).toBe(false);
    expect(clipPromptOf(FRIEND, ROBE, "kling", "own").ok).toBe(false);
    expect(clipPromptOf(TIMER, ROBE, "kling", "own").ok).toBe(false);
  });

  test("a motion that only moves what she wears keeps «comes off», whatever its source", () => {
    expect(continuityLineOf("she slowly tugs the strap a little", null)).toBe(COMES_OFF_LINE);
  });

  test("the line is written in clips/videoLook.ts alone (I5.1): no other engine or shared module holds it as a string", () => {
    const studio = join(import.meta.dir, "..", "..");
    const holds = (path: string): boolean => /["'`]Nothing new appears\.["'`]/.test(readFileSync(join(studio, path), "utf8"));
    const sources = [...new Bun.Glob("{engine,shared}/**/*.ts").scanSync(studio)].filter((path) => !/\.test\.ts$|testkit\.ts$|\/testing\//.test(path));
    expect(sources.filter(holds)).toEqual(["engine/clips/videoLook.ts"]);
  });
});

// ---------- the pins added by S5.WC2 (every existing pin stays byte for byte; prompt.sweep.test.ts holds them) ----------

const PINS = join(import.meta.dir, "fixtures");
const WRITE = process.env.CLIP_PROMPT_WRITE_PINS === "1";

/** The sweep's pin helper, for the files this task adds. */
function pinned(name: string, prompt: string): void {
  const path = join(PINS, `${name}.txt`);
  if (WRITE) {
    mkdirSync(PINS, { recursive: true });
    writeFileSync(path, `${prompt}\n`);
  }
  if (!existsSync(path)) throw new Error(`no pin ${name}.txt: run the test with CLIP_PROMPT_WRITE_PINS=1, then read every pin before committing it`);
  expect(prompt).toBe(readFileSync(path, "utf8").replace(/\n$/, ""));
}

function promptOf(facts: FrameFacts, motion: string, dialect: ClipDialect, source: "vision" | "own"): string {
  const result = clipPromptOf(facts, motion, dialect, source);
  if (!result.ok) throw new Error(result.problems.join("; "));
  expect(result.words).toBeLessThanOrEqual(PROMPT_WORDS_MAX);
  expect(result.words).toBe(wordCount(result.prompt));
  expect(result.prompt).toContain("One continuous shot, no cuts.");
  expect(result.prompt).toContain(LOOK_LINE);
  return result.prompt;
}

/** A vision suggestion or an own idea on a timer frame (the one capture whose two dialects differ): the same prompt for either source. */
const TIMER_TEXT = "she slowly rolls her shoulders back a little";

describe("the prompt pins of 5b.2 part C (clips/fixtures/own-*.txt)", () => {
  for (const dialect of DIALECTS) {
    test(`an own or vision motion on a timer frame, ${dialect}`, () => {
      const prompt = promptOf(TIMER, TIMER_TEXT, dialect, "own");
      expect(promptOf(TIMER, TIMER_TEXT, dialect, "vision")).toBe(prompt);
      pinned(`own-timer.${dialect}`, prompt);
    });
  }

  test("an own idea that takes clothing off on a frame of «Смелая», Kling (Grok never runs on «Смелая»)", () => {
    pinned("own-takes-off.kling", promptOf(boldMirror(), ROBE, "kling", "own"));
  });

  test("no camera line says «reach» (spike B), the new pins' included", () => {
    for (const capture of CLIP_CAPTURES) for (const dialect of DIALECTS) expect(cameraLineOf(capture, dialect)).not.toMatch(/\breach/i);
  });
});
