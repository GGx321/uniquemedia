import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BANKS } from "../../shared/scenes/banks";
import type { BankCategory } from "../../shared/scenes/banks/types";
import { posesFor, type Capture } from "../../shared/scenes/captures";
import { contentProblems } from "../../shared/scenes/contentLine";
import { contractCategory, buildRunPlan, type RunPlan } from "../runs/plan";
import { plan } from "../scenes";
import type { PlanSlot } from "../scenes/schema";
import { BOLD_CLIPS, clipAllowsAutoGrok } from "../../shared/engine";
import { clipFallbackOf, frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { motionChoicesOf } from "./motion";
import { clipPromptOf } from "./prompt";
import { ADULT_LINE, CLIP_CAPTURES, PROMPT_WORDS_MAX, SLOW_LINE, hasVideoStagingWord, legwearLineOf, type ClipDialect } from "./videoLook";
import { AVATAR, MODELS, everyMoment, photoOf, planlessPhoto, sceneRun, slotOf, type Picked } from "./testing/frameFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V5 (plan s5b1 §8 V5, I5.51, I5.57): every bank motion through the clip prompt, and the pins. The sweep reads the banks as they are (by content, never by
// line), so a polish that changes a motion re-runs it; the pins are 5b.1's own lines in context, one per capture and dialect, and the longest prompt.

const DIALECTS: readonly ClipDialect[] = ["kling", "grok"];

function factsOf(result: FrameFactsResult): FrameFacts {
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}

/** The longest legwear any bank names: the worst case of the legwear line. */
const LONGEST_LEGWEAR = Object.values(BANKS)
  .flatMap((bank) => [...(bank.legwear?.items ?? []), ...(bank.legwear?.bold?.items ?? [])])
  .reduce((a, b) => (b.split(/\s+/).length > a.split(/\s+/).length ? b : a), "");

/** The pose a moment is drawn with on a capture: its own angle where the capture takes it, else the capture's first pose. */
function poseOf(picked: Picked, capture: Capture): PlanSlot["pose"] {
  const poses = posesFor(capture);
  return picked.moment.angle !== undefined && poses.includes(picked.moment.angle) ? picked.moment.angle : (poses[0] ?? "front");
}

/** The facts of a photo of this moment on this capture, with or without legwear. */
function factsFor(picked: Picked, capture: Capture, legwear: boolean): FrameFacts {
  const slot = slotOf(picked, capture, poseOf(picked, capture), legwear ? { legwear: LONGEST_LEGWEAR } : {});
  const run = sceneRun("run-00000301", [slot]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run));
}

interface Swept {
  where: string;
  facts: FrameFacts;
  motion: string;
  dialect: ClipDialect;
  prompt: string;
  words: number;
}

/**
 * Pinned: the bank motions a frame drops because they would contradict its photo. On a face-hidden capture the phone covers her face from her eyebrows to her chin, so a
 * motion of her mouth or eyes is not offered there (it is on the moment's other captures). A new entry here is a bank motion to look at, not a sweep to widen.
 */
const DROPPED: readonly string[] = [
  // «she takes a small sip»: the bottle would go to her mouth behind the phone.
  "fitness/a gym floor/«holds a water bottle» on mirror-hidden",
  "fitness/the gym locker room/«holds a water bottle» on mirror-hidden",
  // «she sips and smiles a little».
  "nightwear/her bed/«sits cross-legged with her coffee» on mirror-hidden",
];

const dropped = new Set<string>();

/** Every bank motion × each of its captures × dialect × legwear on and off (on only where the moment may wear it), plus every code motion of those frames. */
function sweep(): Swept[] {
  const out: Swept[] = [];
  for (const picked of everyMoment()) {
    for (const capture of picked.moment.captures) {
      for (const legwear of picked.moment.noLegwear === true ? [false] : [false, true]) {
        const facts = factsFor(picked, capture, legwear);
        const frame = `${picked.category}/${picked.place.name}/«${picked.moment.text}» on ${capture}`;
        const where = `${frame}${legwear ? " with legwear" : ""}`;
        const choices = motionChoicesOf(facts, () => dropped.add(frame));
        if (choices[0]?.id !== "scene" && !dropped.has(frame)) throw new Error(`${where}: «Как в сцене» is not offered`);
        for (const choice of choices) {
          for (const dialect of DIALECTS) {
            const result = clipPromptOf(facts, choice.text, dialect);
            if (!result.ok) throw new Error(`${where} (${choice.id}, ${dialect}): ${result.problems.join("; ")}`);
            out.push({ where: `${where} (${choice.id})`, facts, motion: choice.text, dialect, prompt: result.prompt, words: result.words });
          }
        }
      }
    }
  }
  return out;
}

let swept: Swept[] | undefined;
/** The sweep, run once, on first use (so a failure is a test's, not the file's). */
const SWEPT = (): Swept[] => (swept ??= sweep());

describe("every bank motion makes a valid clip prompt (§8 V5 sweep)", () => {
  test("the sweep covers every bank motion (271 on main) on every capture it lists", () => {
    const moments = everyMoment();
    expect(moments.length).toBeGreaterThanOrEqual(271);
    const scenePrompts = new Set(SWEPT().filter((s) => s.motion === s.facts.moment?.motion).map((s) => s.facts.moment));
    expect(scenePrompts.size).toBe(new Set(moments.map((m) => m.moment)).size);
  });

  test("every frame of «Смелая» routes to Kling alone: no fallback, no automatic Grok, under both engine modes (I5.57); every frame of the five may fall back", () => {
    for (const s of SWEPT()) {
      const bold = s.facts.category === "nightwear" || s.facts.category === "beach";
      expect(s.facts.bold).toBe(bold);
      for (const mode of ["auto", "offer"] as const) {
        const fallback = clipFallbackOf(s.facts, BOLD_CLIPS, mode);
        expect(fallback).toBe(bold ? "none" : mode);
        expect(clipAllowsAutoGrok({ model: "kling", mode, fallback: "auto", bold: s.facts.bold })).toBe(!bold && mode === "auto");
      }
    }
  });

  test("a bank motion is dropped only where it would contradict its photo, exactly as pinned", () => {
    SWEPT();
    expect([...dropped].sort()).toEqual([...DROPPED].sort());
  });

  test("every prompt is within 130 words, carries the pacing line and ends with the adult line", () => {
    for (const s of SWEPT()) {
      if (s.words > PROMPT_WORDS_MAX) throw new Error(`${s.where} ${s.dialect}: ${s.words} words`);
      expect(s.prompt).toContain(SLOW_LINE);
      expect(s.prompt.endsWith(ADULT_LINE)).toBe(true);
    }
  });

  test("no motion and no activity carries a video word, and both pass the content line at the slot's level", () => {
    for (const s of SWEPT()) {
      expect(hasVideoStagingWord(s.motion)).toBe(false);
      expect(contentProblems(s.motion, s.facts.level)).toEqual([]);
      if (s.facts.activity !== null) {
        expect(hasVideoStagingWord(s.facts.activity)).toBe(false);
        expect(contentProblems(s.facts.activity, s.facts.level)).toEqual([]);
      }
    }
  });

  test("the longest prompt is pinned: a change that lengthens it is seen", () => {
    const longest = SWEPT().reduce((a, b) => (b.words > a.words ? b : a));
    expect({ words: longest.words, where: longest.where, dialect: longest.dialect }).toEqual(LONGEST);
  });
});

/**
 * Pinned by S5.V5: the longest prompt of the sweep, exactly at the cap: a pov-legs legs frame with legwear on its full camera line (one word more and it takes the short
 * line, as «stretches her legs along the bed» does). fixtures/longest.txt holds its text.
 */
const LONGEST: { words: number; where: string; dialect: ClipDialect } = {
  words: 130,
  where: "nightwear/an armchair in her bedroom/«stretches out her legs» on pov-legs with legwear (scene)",
  dialect: "kling",
};

describe("no outfit in a video prompt (I5.51, I5.57): every slot of the two «Смелая» banks, by the real planner", () => {
  const coverages = new Set(
    (["nightwear", "beach"] as const).flatMap((category) => [
      ...BANKS[category].outfits.flatMap((o) => (o.coverage === undefined ? [] : [o.coverage])),
      ...BANKS[category].places.flatMap((p) => p.moments.flatMap((m) => (m.coverage === undefined ? [] : [m.coverage]))),
    ]),
  );

  function boldRuns(): RunPlan[] {
    const runs: RunPlan[] = [];
    for (const category of ["nightwear", "beach"] as const) {
      for (const [i, legsShare] of ([0, 15, 30, 0, 15, 30, 0, 15, 30, 0, 15] as const).entries()) {
        runs.push(
          buildRunPlan({
            runId: `run-${category.slice(0, 4)}${String(i).padStart(4, "0")}`,
            avatarId: AVATAR,
            createdAt: "2026-10-13T10:00:00.000Z",
            request: { avatarId: AVATAR, count: 100, categories: [contractCategory(category)], level: "bold", legsShare },
            imageAgeCheck: "off",
            models: MODELS,
            capMicros: 9_000_000,
            plannedWorstMicros: 9_000_000,
            scenes: plan({ seed: 100 + i, count: 100, categories: [category], level: "bold", legsShare }),
          }),
        );
      }
    }
    return runs;
  }

  test("over at least 2 000 slots, no prompt holds the slot's outfit or a coverage sentence, and stockings come only through the legwear line", () => {
    let slots = 0;
    for (const run of boldRuns()) {
      for (const slot of run.scenes.slots) {
        if (slot.category === "own") continue;
        slots++;
        const facts = factsOf(frameFactsOf(photoOf(run, slot), run));
        for (const choice of motionChoicesOf(facts)) {
          for (const dialect of DIALECTS) {
            const result = clipPromptOf(facts, choice.text, dialect);
            if (!result.ok) throw new Error(`${slot.location}/«${slot.activity}»: ${result.problems.join("; ")}`);
            expect(result.prompt.toLowerCase()).not.toContain(slot.outfit.toLowerCase());
            for (const coverage of coverages) expect(result.prompt).not.toContain(coverage);
            if (/\bstockings?\b/i.test(result.prompt)) {
              expect(slot.legwear ?? "").toMatch(/\bstockings?\b/i);
              expect(result.prompt.replace(legwearLineOf(slot.legwear ?? ""), "")).not.toMatch(/\bstockings?\b/i);
            }
          }
        }
      }
    }
    expect(slots).toBeGreaterThanOrEqual(2_000);
  });
});

// ---------- the pins: one prompt per capture and dialect, from the first bank moment that lists the capture ----------

const PINS = join(import.meta.dir, "fixtures");
const WRITE = process.env.CLIP_PROMPT_WRITE_PINS === "1";

function pinned(name: string, prompt: string): void {
  const path = join(PINS, `${name}.txt`);
  if (WRITE) {
    mkdirSync(PINS, { recursive: true });
    writeFileSync(path, `${prompt}\n`);
  }
  if (!existsSync(path)) throw new Error(`no pin ${name}.txt: run the test with CLIP_PROMPT_WRITE_PINS=1, then read every pin before committing it`);
  expect(prompt).toBe(readFileSync(path, "utf8").replace(/\n$/, ""));
}

function firstOn(capture: Capture): Picked {
  const picked = everyMoment().find((p) => p.moment.captures.includes(capture));
  if (picked === undefined) throw new Error(`no bank moment lists ${capture}`);
  return picked;
}

function promptFor(facts: FrameFacts, motion: string, dialect: ClipDialect): string {
  const result = clipPromptOf(facts, motion, dialect);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.prompt;
}

describe("the prompt pins (clips/fixtures/*.txt)", () => {
  for (const capture of CLIP_CAPTURES) {
    for (const dialect of DIALECTS) {
      test(`${capture}, ${dialect}`, () => {
        if (capture === "unknown") {
          const facts = factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null));
          const first = motionChoicesOf(facts)[0];
          if (first === undefined) throw new Error("no motion for an unknown capture");
          pinned(`${capture}.${dialect}`, promptFor(facts, first.text, dialect));
          return;
        }
        const picked = firstOn(capture);
        const facts = factsFor(picked, capture, false);
        pinned(`${capture}.${dialect}`, promptFor(facts, picked.moment.motion, dialect));
      });
    }
  }

  test("prone, the plan's example: the hips lift", () => {
    const picked = everyMoment().find((p) => p.moment.captures.includes("prone") && /\bhips\b/.test(p.moment.motion));
    if (picked === undefined) throw new Error("no prone hips moment");
    pinned("prone-hips.kling", promptFor(factsFor(picked, "prone", false), picked.moment.motion, "kling"));
  });

  test("a legs frame with legwear: the longest legwear on the first pov-legs moment that may wear it", () => {
    const picked = everyMoment().find((p) => p.moment.captures.includes("pov-legs") && p.moment.noLegwear !== true && (p.category as BankCategory) === "home");
    if (picked === undefined) throw new Error("no pov-legs moment");
    pinned("legs-legwear.kling", promptFor(factsFor(picked, "pov-legs", true), picked.moment.motion, "kling"));
  });

  test("the longest prompt of the sweep", () => {
    const longest = SWEPT().reduce((a, b) => (b.words > a.words ? b : a));
    pinned("longest", longest.prompt);
  });
});
