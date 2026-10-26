import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PhotoSidecarSchema } from "../library/schemas";
import { RunPlanSchema } from "../runs/plan";
import type { PlanSlot } from "../scenes/schema";
import { clipFallbackOf, frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { clipMotionProblems, clipPromptOf } from "./prompt";
import { CLIP_CAPTURES, COMES_OFF_LINE, CONTINUITY_LINE, LOOK_LINE, NOTHING_NEW_LINE, PROMPT_WORDS_MAX, SLOW_LINE, cameraLineOf, continuityLineOf, wordCount, type ClipDialect } from "./videoLook";
import { photoOf, pick, promptNamingLegwear, sceneRun, slotOf } from "./testing/frameFixtures";
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
  test("a scene text keeps 5b.1's checks: a 61-character text still makes a prompt", () => {
    expect(SIXTY_ONE.length).toBe(61);
    expect(clipPromptOf(TIMER, SIXTY_ONE, "kling", "scene").ok).toBe(true);
  });

  test("the same text as a vision or an own motion takes the bank's grammar and makes no prompt, in either dialect", () => {
    for (const source of ["vision", "own"] as const) for (const dialect of DIALECTS) expect(clipPromptOf(TIMER, SIXTY_ONE, dialect, source).ok).toBe(false);
  });

  test("on C3 K1 a vision or own text that names her phone makes no prompt (the planned hand-held capture)", () => {
    for (const source of ["vision", "own"] as const) for (const dialect of DIALECTS) expect(clipPromptOf(K1, "she slowly glances at her phone", dialect, source).ok).toBe(false);
  });
});

describe("an activity that names her phone never reaches the prompt (FU-CLIP: the slot's activity is not sent at all)", () => {
  test("on C3 K1 (the plan says the phone was in her hand) and on a friend's photo alike", () => {
    for (const facts of [{ ...K1, activity: "texting on her phone" }, { ...FRIEND, activity: "texting on her phone" }]) {
      const result = clipPromptOf(facts, "she slowly turns her head a little", "kling", "vision");
      if (!result.ok) throw new Error(result.problems.join("; "));
      expect(result.prompt).not.toContain("texting on her phone");
    }
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

  test("a prompt over 130 words in either dialect: too-long (FU-CLIP: the activity is no longer in it, so the slot's legwear makes it long)", () => {
    const long = { ...TIMER, legwear: `${"very ".repeat(110)}long socks` };
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
  const slot = run.scenes.slots[0] as PlanSlot;
  // The bank's list holds no «sheer black stockings», so the kit's sentence names none: the photo's prompt is made to name them (MEDIUM-2).
  return factsOf(frameFactsOf(photoOf(run, slot, legwear === undefined ? {} : { prompt: promptNamingLegwear(run, slot) }), run));
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

  test("S5.WC2c: everywhere: a vision text on «Смелая» and an own idea on an ordinary frame make the same Kling prompt line, «Nothing new appears.» alone", () => {
    for (const [facts, source] of [[boldMirror(), "vision"], [FRIEND, "own"], [TIMER, "own"], [FRIEND, "vision"]] as const) {
      const result = clipPromptOf(facts, ROBE, "kling", source);
      if (!result.ok) throw new Error(result.problems.join("; "));
      expect([source, result.prompt.includes(`Over the whole clip ${ROBE}. Nothing new appears. ${SLOW_LINE}`)]).toEqual([source, true]);
    }
  });

  test("a motion that only moves what she wears keeps «comes off», whatever its source", () => {
    expect(continuityLineOf("she slowly tugs the strap a little", null)).toBe(COMES_OFF_LINE);
  });

  test("round 2: the garments a model names take «comes off» when they are only moved; «her top knee» is no garment", () => {
    for (const motion of ["she slowly smooths her dress", "she slowly adjusts her top a little", "she slowly straightens her robe", "she slowly tugs her shirt a little", "she slowly smooths her skirt"]) {
      expect([motion, continuityLineOf(motion, null)]).toEqual([motion, COMES_OFF_LINE]);
    }
    expect(continuityLineOf("she slides her top knee forward a little", null)).toBe(CONTINUITY_LINE);
  });

  test("S5.WC2c: the frame decides which model runs, never the motion: an idea that takes clothing off builds its Grok prompt too, with the same line", () => {
    const facts = boldMirror();
    expect(clipPromptOf(facts, ROBE, "kling", "own").ok).toBe(true);
    const grok = clipPromptOf(facts, ROBE, "grok", "own");
    if (!grok.ok) throw new Error(grok.problems.join("; "));
    expect(grok.prompt).toContain(`Over the whole clip ${ROBE}. Nothing new appears. ${SLOW_LINE}`);
    // Whether Grok runs is the frame's: «Смелая» is Kling's alone by default, and falls back only when BOLD_CLIPS lets every motion of it.
    expect(clipFallbackOf(facts)).toBe("none");
    expect(clipFallbackOf(facts, "with-fallback", "auto")).toBe("auto");
    expect(clipMotionProblems(facts, ROBE, "own")).toEqual([]);
  });

  test("the line is written in clips/videoLook.ts alone (I5.1): no other engine or shared module holds it as a string", () => {
    const studio = join(import.meta.dir, "..", "..");
    const holds = (path: string): boolean => /["'`]Nothing new appears\.["'`]/.test(readFileSync(join(studio, path), "utf8"));
    // Windows scans with backslashes: compare and filter on forward slashes, read by the native path.
    const sources = [...new Bun.Glob("{engine,shared}/**/*.ts").scanSync(studio)].filter((path) => !/\.test\.ts$|testkit\.ts$|\/testing\//.test(path.replaceAll("\\", "/")));
    expect(sources.filter(holds).map((path) => path.replaceAll("\\", "/"))).toEqual(["engine/clips/videoLook.ts"]);
  });
});

// ---------- S5.WC2b: what the clothing-verb whitelist reads as taking clothing off is taken off in the prompt too ----------

describe("an own idea only the whitelist reads as taking clothing off: on «Смелая» Kling's alone, with «Nothing new appears.» (S5.WC2b, Q-H = 2)", () => {
  /** Accepted own ideas on «Смелая» that the takes-off forms never read (the whitelist does). */
  const OPENS = ["her robe slowly falls open", "she slowly loosens the tie of her robe", "she slowly works her skirt up"];

  test("the Kling prompt says «Nothing new appears.» alone: neither «comes off» nor the base line", () => {
    for (const motion of OPENS) {
      const result = clipPromptOf(boldMirror(), motion, "kling", "own");
      if (!result.ok) throw new Error(result.problems.join("; "));
      expect([motion, result.prompt.includes(`${NOTHING_NEW_LINE} ${SLOW_LINE}`)]).toEqual([motion, true]);
      expect([motion, result.prompt.includes(COMES_OFF_LINE) || result.prompt.includes(CONTINUITY_LINE)]).toEqual([motion, false]);
    }
  });

  test("S5.WC2c: its Grok prompt is built with the same line, and it is offered", () => {
    for (const motion of OPENS) {
      const grok = clipPromptOf(boldMirror(), motion, "grok", "own");
      if (!grok.ok) throw new Error(grok.problems.join("; "));
      expect([motion, grok.prompt.includes(`${NOTHING_NEW_LINE} ${SLOW_LINE}`)]).toEqual([motion, true]);
      expect([motion, clipMotionProblems(boldMirror(), motion, "own")]).toEqual([motion, []]);
    }
  });

  test("on a frame with legwear the legwear line goes too", () => {
    const result = clipPromptOf(boldMirror("sheer black stockings"), "her robe slowly falls open", "kling", "own");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.prompt).not.toContain("stay on her feet");
  });

  test("S5.WC2c: the grammar reads a top pulled down as undressing (the review's #TOP decision; the whitelist read it as kept on), on «Смелая» too: «Nothing new appears.»", () => {
    const motion = "she slowly pulls her top down a little";
    const kling = clipPromptOf(boldMirror(), motion, "kling", "own");
    if (!kling.ok) throw new Error(kling.problems.join("; "));
    expect(kling.prompt).toContain(`${NOTHING_NEW_LINE} ${SLOW_LINE}`);
    // What the grammar reads as kept on keeps «comes off»: a skirt pulled down a little.
    const skirt = clipPromptOf(boldMirror(), "she slowly pulls her skirt down a little", "kling", "own");
    if (!skirt.ok) throw new Error(skirt.problems.join("; "));
    expect(skirt.prompt).toContain(`${COMES_OFF_LINE} ${SLOW_LINE}`);
  });

  test("a scene or code text keeps the takes-off forms alone (no bank or code motion says these): the continuity line of the motion by itself does not move", () => {
    expect(continuityLineOf("her robe slowly falls open", null)).toBe(COMES_OFF_LINE);
  });
});

describe("exposure in an accepted own idea on «Смелая» is treated as undressing in the prompt (the controller's decision 5, S5.WC2b)", () => {
  /** Own ideas on «Смелая» that bare her (accepted there, Q-H = 2), each from a different list: the whitelist, the model's exposure verbs, the bank's exposure words. */
  const EXPOSED = ["she slowly uncovers her chest", "she slowly shows off her cleavage", "she slowly poses nude", "she slowly adjusts her top, revealing more"];

  test("they are accepted as own on «Смелая»", () => {
    for (const motion of EXPOSED) expect([motion, clipMotionProblems(boldMirror(), motion, "own")]).toEqual([motion, []]);
  });

  test("the Kling prompt says «Nothing new appears.» alone: neither «comes off» nor the base line", () => {
    for (const motion of EXPOSED) {
      const result = clipPromptOf(boldMirror(), motion, "kling", "own");
      if (!result.ok) throw new Error(result.problems.join("; "));
      expect([motion, result.prompt.includes(`${NOTHING_NEW_LINE} ${SLOW_LINE}`)]).toEqual([motion, true]);
      expect([motion, result.prompt.includes(COMES_OFF_LINE) || result.prompt.includes(CONTINUITY_LINE)]).toEqual([motion, false]);
    }
  });

  test("S5.WC2c: their Grok prompt is built with the same line", () => {
    for (const motion of EXPOSED) {
      const grok = clipPromptOf(boldMirror(), motion, "grok", "own");
      if (!grok.ok) throw new Error(grok.problems.join("; "));
      expect([motion, grok.prompt.includes(`${NOTHING_NEW_LINE} ${SLOW_LINE}`)]).toEqual([motion, true]);
    }
  });

  test("on a frame with legwear the legwear line goes too", () => {
    const result = clipPromptOf(boldMirror("sheer black stockings"), "she slowly uncovers her chest", "kling", "own");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.prompt).not.toContain("stay on her feet");
  });

  test("innocent posture is no exposure: «her chest rises a little as she breathes» keeps the base line and both dialects", () => {
    const motion = "her chest rises a little as she breathes";
    const kling = clipPromptOf(boldMirror(), motion, "kling", "own");
    if (!kling.ok) throw new Error(kling.problems.join("; "));
    expect(kling.prompt).toContain(CONTINUITY_LINE);
    expect(clipPromptOf(boldMirror(), motion, "grok", "own").ok).toBe(true);
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
