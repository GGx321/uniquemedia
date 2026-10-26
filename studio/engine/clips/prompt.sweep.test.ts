import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BANKS } from "../../shared/scenes/banks";
import type { BankCategory } from "../../shared/scenes/banks/types";
import { posesFor, type Capture } from "../../shared/scenes/captures";
import { contentProblems } from "../../shared/scenes/contentLine";
import { PHONE_WORDS, SELFIE_WORDS } from "../../shared/scenes/words";
import { contractCategory, buildRunPlan, RunPlanSchema, type RunPlan } from "../runs/plan";
import { plan } from "../scenes";
import type { PlanSlot } from "../scenes/schema";
import { PhotoSidecarSchema } from "../library/schemas";
import { BOLD_CLIPS, clipAllowsAutoGrok } from "../../shared/engine";
import { clipFallbackOf, frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { motionChoicesOf } from "./motion";
import { clipPromptOf } from "./prompt";
import { ADULT_LINE, CLIP_CAPTURES, LEGS_LINE, PROMPT_WORDS_MAX, SLOW_LINE, hasVideoStagingWord, legwearLineOf, type ClipDialect } from "./videoLook";
import { AVATAR, MODELS, everyMoment, photoOf, planlessPhoto, promptNamingLegwear, sceneRun, sentenceOf, slotOf, type Picked } from "./testing/frameFixtures";
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
  const runSlot = run.scenes.slots[0] as PlanSlot;
  // MEDIUM-2: the legwear line needs a photo that names the legwear, and only «Дом»'s list holds the sweep's socks: every frame's photo names them, so the worst case
  // of the line is swept on all of them (490 frames), not on «Дом»'s 51 alone.
  const facts = factsOf(frameFactsOf(photoOf(run, runSlot, legwear ? { prompt: promptNamingLegwear(run, runSlot) } : {}), run));
  if (legwear && facts.legwear === null) throw new Error(`${picked.place.name}/«${picked.moment.text}» on ${capture}: the photo does not name its legwear`);
  return facts;
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
            const result = clipPromptOf(facts, choice.text, dialect, choice.source);
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

  test("every prompt says it is one continuous shot with no cuts, after the look and before the adult line (C3 K1)", () => {
    for (const s of SWEPT()) {
      expect(s.prompt).toContain("One continuous shot, no cuts.");
      expect(s.prompt.indexOf("One continuous shot, no cuts.")).toBeGreaterThan(s.prompt.indexOf("Vertical phone video"));
      expect(s.prompt.indexOf("One continuous shot, no cuts.")).toBeLessThan(s.prompt.indexOf(ADULT_LINE));
    }
  });

  test("no mirror-hidden prompt sends the camera up to her face: the phone covers it (round 2)", () => {
    for (const s of SWEPT()) if (s.facts.capture === "mirror-hidden") expect(s.prompt).not.toMatch(/turns up to her face/);
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

  test("no prompt restates its slot's activity outside the motion sentence (FU-CLIP: the photo may not show what the plan says)", () => {
    for (const s of SWEPT()) {
      if (s.facts.activity === null) continue;
      const rest = s.prompt.replace(`Over the whole clip ${s.motion}.`, "");
      if (rest.includes(s.facts.activity)) throw new Error(`${s.where} ${s.dialect}: restates «${s.facts.activity}»`);
    }
  });

  test("the longest prompt is pinned: a change that lengthens it is seen", () => {
    const longest = SWEPT().reduce((a, b) => (b.words > a.words ? b : a));
    expect({ words: longest.words, where: longest.where, dialect: longest.dialect }).toEqual(LONGEST);
  });
});

/**
 * Pinned by S5.V5, moved by the C3 polish (the no-cuts sentence added 5 words to every prompt): the longest prompt of the sweep, exactly at the cap: a pov-legs legs frame
 * on its full camera line (one word more and it takes the short line, as the legwear frame now does). fixtures/longest.txt holds its text.
 */
const LONGEST: { words: number; where: string; dialect: ClipDialect } = {
  words: 130,
  where: "travel/a balcony over city rooftops/«stretches her legs on the chair» on pov-legs (scene)",
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
            const result = clipPromptOf(facts, choice.text, dialect, choice.source);
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

describe("an old pov-legs photo with no POV line takes the unknown camera line (S5.WP1, plan s5b2 I5.69)", () => {
  /** The pov-legs line before the C3′ fix (aba9a3f6 to 6c94d102): it drew a selfie from above. */
  const PRE_FIX = "A photo she took looking down along her own legs from where she lies or sits, held at her eye level; nothing in her hand can be seen.";
  const UNKNOWN_LINE = "The framing stays almost still, with a little natural sway.";

  test("C3 K1's own photo and plan (fixtures/c3-k1.json): exactly the prompt with the unknown line and, since FU-CLIP, no legs line (the photo was a selfie from above), in both dialects", () => {
    const k1 = JSON.parse(readFileSync(join(PINS, "c3-k1.json"), "utf8")) as { photo: unknown; plan: unknown };
    const facts = factsOf(frameFactsOf(PhotoSidecarSchema.parse(k1.photo), RunPlanSchema.parse(k1.plan)));
    expect({ capture: facts.capture, legs: facts.legs, faceRole: facts.faceRole, sceneMotion: facts.sceneMotion }).toEqual({ capture: "unknown", legs: true, faceRole: "hidden", sceneMotion: true });
    const scene = motionChoicesOf(facts)[0];
    expect(scene).toMatchObject({ id: "scene", text: "she points and flexes her toes slowly" });
    const expected =
      "The framing stays almost still, with a little natural sway. The adult woman keeps her pose from the photo. Over the whole clip she points and flexes her toes slowly. " +
      "Nothing new appears, and nothing she holds or wears changes. " +
      "Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures. Vertical phone video, slight noise, everything in focus. One continuous shot, no cuts. " +
      "No text on screen. She is an adult woman.";
    for (const dialect of DIALECTS) expect(promptFor(facts, scene?.text ?? "", dialect)).toBe(expected);
  });

  test("every pov-legs bank moment drawn with the pre-fix line, legwear on and off, every motion it is offered, both dialects: the unknown line, no legs line (FU-CLIP), at most 130 words", () => {
    let prompts = 0;
    for (const picked of everyMoment().filter((p) => p.moment.captures.includes("pov-legs"))) {
      for (const legwear of picked.moment.noLegwear === true ? [false] : [false, true]) {
        const slot = slotOf(picked, "pov-legs", poseOf(picked, "pov-legs"), legwear ? { legwear: LONGEST_LEGWEAR } : {});
        const run = sceneRun("run-00000302", [slot]);
        const runSlot = run.scenes.slots[0] as PlanSlot;
        const named = legwear ? `, with ${LONGEST_LEGWEAR}` : "";
        const facts = factsOf(frameFactsOf(photoOf(run, runSlot, { prompt: `${PRE_FIX} ${sentenceOf(run.runId, runSlot)}${named}. She is an adult woman.` }), run));
        expect(facts.legwear).toBe(legwear ? LONGEST_LEGWEAR : null);
        expect(facts.capture).toBe("unknown");
        const choices = motionChoicesOf(facts);
        expect(choices[0]?.id).toBe("scene");
        // An unknown capture lifts the phone rule pov-legs (a hand capture) is held to; no pov-legs motion or activity names a phone, so it lets nothing new through.
        for (const text of [facts.activity ?? "", ...choices.map((choice) => choice.text)]) expect(PHONE_WORDS.test(text) || SELFIE_WORDS.test(text)).toBe(false);
        for (const choice of choices) {
          for (const dialect of DIALECTS) {
            const result = clipPromptOf(facts, choice.text, dialect, choice.source);
            if (!result.ok) throw new Error(`${picked.place.name}/«${picked.moment.text}» (${choice.id}, ${dialect}): ${result.problems.join("; ")}`);
            expect(result.prompt.startsWith(`${UNKNOWN_LINE} `)).toBe(true);
            expect(result.prompt).not.toContain(LEGS_LINE);
            // The camera line is the unknown one (no «reach» in it: videoLook.test.ts); a bank motion may say «reaches» («she reaches toward her toes slowly»).
            expect(result.prompt).not.toMatch(/first-person|point-of-view/i);
            expect(result.prompt).toContain("One continuous shot, no cuts.");
            expect(result.words).toBeLessThanOrEqual(PROMPT_WORDS_MAX);
            prompts++;
          }
        }
      }
    }
    expect(prompts).toBeGreaterThanOrEqual(22 * 2);
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
  const result = clipPromptOf(facts, motion, dialect, "scene");
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

  test("a legs frame by the mirror: the first mirror-hidden legs moment", () => {
    const picked = everyMoment().find((p) => p.moment.captures.includes("mirror-hidden") && p.moment.legs?.framing === "legs");
    if (picked === undefined) throw new Error("no mirror-hidden legs moment");
    pinned("mirror-hidden-legs.kling", promptFor(factsFor(picked, "mirror-hidden", false), picked.moment.motion, "kling"));
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
