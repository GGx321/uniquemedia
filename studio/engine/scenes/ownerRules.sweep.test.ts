import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor } from "../../shared/engine";
import { BANKS, CUES, GAZE } from "../../shared/scenes/banks";
import { captureOfShot, shotOf, type Capture } from "../../shared/scenes/captures";
import { plainSentence } from "../../shared/scenes/plain";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleSlot } from "./assembler";
import { localSentences } from "./localSentences";
import { slotKeyOf } from "./phoneLook";
import { plan } from "./planner";
import { roomPlaceOf, slotLookOf } from "./roomPlace";
import type { PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.6R (round A): the owner's rules for the scene text, swept over the real path a run takes: the seeded planner, the code template (localSentences) and
// the assembler, over 2 000 seeded plans per built-in category (12 slots each, the run's «Ракурсы» on for every other seed). The rules (the owner,
// 2026-10-11): at home she shoots herself; side or back to the mirror only her reflection shows; she lies on her stomach only on a bed; a moment of going
// out wears going-out clothes; a photo someone takes of her fits the place it is taken in and the moment it shows.

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair." };
const MASTER = asLibraryReference(JPEG);
const PLANS = 2000;
const COUNT = 12;

interface Frame {
  slot: PlanSlot;
  capture: Capture;
  sentence: string;
  /** The slot's final image prompt, assembled on first use (the assembler is the sweep's dear step, so only the frames a rule reads are assembled). */
  prompt: () => string;
}

function framesOf(category: Category, seed: number): Frame[] {
  const p = plan({ seed: seed * 7919 + COUNT, count: COUNT, categories: [category], poses: seed % 2 === 0 ? { profile: true, back: true } : { profile: false, back: false } });
  const runId = `run-${category}-${seed}`;
  const local = localSentences({ slots: p.slots, keyOf: (s) => slotKeyOf(runId, s.attemptIdBase) });
  return p.slots.map((slot) => {
    const sentence = local(slot) ?? plainSentence(slot);
    let prompt: string | undefined;
    const assemble = (): string => {
      prompt ??= assembleSlot(DESCRIPTOR, slot, sentence, MASTER, { runId, cameraRealism: seed % 4 !== 0, roomPlaceOf, lookOf: slotLookOf }).prompt;
      return prompt;
    };
    return { slot, capture: slot.capture ?? captureOfShot(slot.shot), sentence, prompt: assemble };
  });
}

// Built once, at load: 2 000 plans per category.
const FRAMES: Record<Category, Frame[]> = Object.fromEntries(
  CATEGORIES.map((category) => [category, Array.from({ length: PLANS }, (_, i) => framesOf(category, i + 1)).flat()]),
) as Record<Category, Frame[]>;
const ALL: Frame[] = CATEGORIES.flatMap((c) => FRAMES[c]);

/** What a failing sweep shows: how many frames broke the rule, and a few of them. */
function offenders(frames: readonly Frame[], broken: (frame: Frame) => boolean): { count: number; sample: string[] } {
  const hits = frames.filter(broken);
  return { count: hits.length, sample: hits.slice(0, 3).map((f) => `${f.slot.category} | ${f.capture} | ${f.slot.pose} | ${f.slot.location} | ${f.slot.activity} | ${f.slot.outfit}`) };
}
const NONE = { count: 0, sample: [] };

const roomsOf = (category: Category): Set<string> => new Set(BANKS[category].places.filter((p) => p.room === true).map((p) => p.name));
const isSelfShot = (capture: Capture): boolean => capture !== "friend" && capture !== "candid" && capture !== "low-feet";

describe("«Фитнес» at home is self-shot: on a timer, at arm's length or in the mirror; a friend or a candid stays at the gym and in the park", () => {
  const home = roomsOf("fitness");

  test("the sweep holds «Фитнес» frames at home", () => {
    expect(home.size).toBeGreaterThan(0);
    expect(FRAMES.fitness.filter((f) => home.has(f.slot.location)).length).toBeGreaterThan(PLANS);
  });

  test("no «Фитнес» frame at home is a photo someone else took", () => {
    expect(offenders(FRAMES.fitness, (f) => home.has(f.slot.location) && !isSelfShot(f.capture))).toEqual(NONE);
  });

  test("a home workout is shot on a timer as well as at arm's length, and every «Фитнес» timer frame is at home", () => {
    const homeCaptures = new Set(FRAMES.fitness.filter((f) => home.has(f.slot.location)).map((f) => f.capture));
    expect([...homeCaptures].sort()).toEqual(["selfie", "timer"]);
    expect(offenders(FRAMES.fitness, (f) => f.capture === "timer" && !home.has(f.slot.location))).toEqual(NONE);
  });

  test("a friend's photo and a candid of «Фитнес» still happen, away from home", () => {
    const asked = FRAMES.fitness.filter((f) => f.capture === "friend" || f.capture === "candid");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((f) => !home.has(f.slot.location))).toBe(true);
  });
});


describe("side or back to the mirror, only her reflection is in the picture", () => {
  // S5.6R (round C): «turns to check her outfit» turns her side to the mirror too; the sweep found it 608 times a plain mirror selfie in «Гламур».
  const SIDE_TO_MIRROR = /\bsideways\b|\bside to the mirror\b|\bback to the mirror\b|\bturns to check\b/;

  test("the sweep holds side-to-the-mirror moments of «Дом» and «Гламур»", () => {
    const side = ALL.filter((f) => SIDE_TO_MIRROR.test(f.slot.activity));
    expect([...new Set(side.map((f) => f.slot.category))].sort()).toEqual(["glamour", "home"]);
  });

  test("no side-to-the-mirror moment is a plain mirror selfie", () => {
    expect(offenders(ALL, (f) => SIDE_TO_MIRROR.test(f.slot.activity) && f.capture === "mirror")).toEqual(NONE);
  });

  test("a sideways moment is never a plain mirror selfie that claims her face is clearly visible", () => {
    expect(offenders(ALL, (f) => SIDE_TO_MIRROR.test(f.slot.activity) && shotOf(f.capture) === "mirror" && /face clearly visible/.test(f.prompt()))).toEqual(NONE);
  });

  test("a sideways mirror frame carries the reflection-only line", () => {
    expect(offenders(ALL, (f) => SIDE_TO_MIRROR.test(f.slot.activity) && shotOf(f.capture) === "mirror" && !f.prompt().includes("Only her reflection is in the picture"))).toEqual(NONE);
  });
});


describe("she lies on her stomach only on her bed", () => {
  test("off the bed, no «Дом» mirror frame has her lying down facing the mirror", () => {
    expect(offenders(FRAMES.home, (f) => f.slot.location !== "her bed" && /^lies\b/.test(f.slot.activity) && shotOf(f.capture) === "mirror")).toEqual(NONE);
  });

  test("off the bed, no «Дом» moment pins the prone selfie's outfits or lifts her hips", () => {
    const off = BANKS.home.places.filter((p) => p.name !== "her bed").flatMap((p) => p.moments);
    const prone = new Set(BANKS.home.places.find((p) => p.name === "her bed")?.moments.filter((m) => m.captures.includes("prone")).flatMap((m) => m.outfits ?? []));
    expect(prone.size).toBeGreaterThan(0);
    // Lifting her hips is the prone selfie's motion; turning them as she stands is not.
    expect(off.filter((m) => (m.outfits ?? []).some((o) => prone.has(o)) || /\blifts? her hips\b/.test(m.motion)).map((m) => m.text)).toEqual([]);
  });
});


describe("«Гламур»: the photo fits the place it is taken in", () => {
  const FAR = /a few steps away|her whole body in the picture/;

  test("in the back seat of a taxi nobody stands a few steps away: no taxi frame is a whole-body photo from a distance", () => {
    const taxi = FRAMES.glamour.filter((f) => f.slot.location === "the back seat of a taxi");
    expect(taxi.length).toBeGreaterThan(0);
    expect(offenders(taxi, (f) => FAR.test(f.prompt()))).toEqual(NONE);
  });

  test("in an elevator she takes it in the mirror or at arm's length: no elevator frame is a whole-body photo from a distance", () => {
    const elevator = FRAMES.glamour.filter((f) => f.slot.location === "an elevator");
    expect(elevator.length).toBeGreaterThan(0);
    expect(offenders(elevator, (f) => FAR.test(f.prompt()))).toEqual(NONE);
    expect([...new Set(elevator.map((f) => shotOf(f.capture)))].sort()).toEqual(["mirror", "selfie"]);
  });

  // The taxi and the elevator left the friend's draws with fewer places, and the getting-ready rooms took them (26 % of their frames before, 38 % after):
  // at home she shoots herself, so those rooms take her mirror and her arm's length only, and the friend's photos go out with her.
  test("at home, getting ready at the sink or by the front door, she shoots herself: no «Гламур» frame there is someone else's photo", () => {
    const home = roomsOf("glamour");
    expect(home.size).toBeGreaterThan(0);
    expect(FRAMES.glamour.filter((f) => home.has(f.slot.location)).length).toBeGreaterThan(PLANS);
    expect(offenders(FRAMES.glamour, (f) => home.has(f.slot.location) && !isSelfShot(f.capture))).toEqual(NONE);
  });
});

describe("«Дом»: a moment of going out wears going-out clothes", () => {
  const GOING_OUT = /going out|ready to go|\bkeys\b/;
  const SLEEP_OR_LOUNGE = /pajama|lounge|leggings|oversized|off one shoulder/;

  test("the sweep holds going-out frames", () => {
    expect(FRAMES.home.filter((f) => GOING_OUT.test(f.slot.activity)).length).toBeGreaterThan(PLANS);
  });

  test("no going-out frame wears pajamas, lounge shorts, leggings or an oversized tee or sweater", () => {
    expect(offenders(FRAMES.home, (f) => GOING_OUT.test(f.slot.activity) && SLEEP_OR_LOUNGE.test(f.slot.outfit))).toEqual(NONE);
  });
});

// S5.6R (round C): over 500 twenty-photo runs as the app makes them (all five categories, «Ракурсы» off), the reviewer found one expression said 3 times or more
// in 499 runs and one gaze in 464. Each is said at most twice in a run of 20, and in a 12-photo run of one category.
describe("a gaze or an expression is said at most twice in a run of 20", () => {
  const CUE_TEXTS = CUES.map((c) => c.text);
  const GAZE_TEXTS = GAZE.map((g) => g.text);
  const mostSaid = (sentences: readonly string[], voices: readonly string[]): number => Math.max(0, ...voices.map((voice) => sentences.filter((s) => s.includes(voice)).length));
  const RUNS: string[][] = Array.from({ length: 500 }, (_, i) => {
    const seed = (i + 1) * 104729;
    const p = plan({ seed, count: 20, categories: [...CATEGORIES], poses: { profile: false, back: false } });
    const runId = `run-mix-${seed}`;
    const local = localSentences({ slots: p.slots, keyOf: (s) => slotKeyOf(runId, s.attemptIdBase) });
    return p.slots.map((slot) => local(slot) ?? plainSentence(slot));
  });
  const PLANS_OF_ONE: string[][] = CATEGORIES.flatMap((c) => Array.from({ length: PLANS }, (_, i) => FRAMES[c].slice(i * COUNT, (i + 1) * COUNT).map((f) => f.sentence)));
  const over = (runs: readonly string[][], voices: readonly string[]) => runs.filter((run) => mostSaid(run, voices) > 2).length;

  test("the runs say gazes and expressions", () => {
    expect(RUNS.every((run) => mostSaid(run, CUE_TEXTS) > 0 && mostSaid(run, GAZE_TEXTS) > 0)).toBe(true);
  });

  test("no 20-photo run says one expression three times", () => {
    expect(over(RUNS, CUE_TEXTS)).toBe(0);
  });

  test("no 20-photo run says one gaze three times", () => {
    expect(over(RUNS, GAZE_TEXTS)).toBe(0);
  });

  test("no 12-photo run of one category says one expression or one gaze three times", () => {
    expect(over(PLANS_OF_ONE, [...CUE_TEXTS, ...GAZE_TEXTS])).toBe(0);
  });
});

describe("the text reads naturally (S5.6R, LOW)", () => {
  test("a photo over her own shoulder names her sneakers once: the outfit says them", () => {
    expect(offenders(ALL, (f) => f.capture === "over-shoulder" && (f.sentence.match(/\bsneakers\b/g) ?? []).length > 1)).toEqual(NONE);
  });

  test("a sentence never names the park path twice", () => {
    expect(offenders(ALL, (f) => (f.sentence.match(/\bpath\b/g) ?? []).length > 1 || (f.sentence.match(/\bpark\b/g) ?? []).length > 1)).toEqual(NONE);
  });

  test("a friend's photo of a moment about her feet shows her whole body, never «from her knees up»", () => {
    const FEET = /\b(foot|feet|heels?|sneakers|shoes|toes|ankles?)\b/;
    const feet = ALL.filter((f) => (f.capture === "friend" || f.capture === "candid") && FEET.test(f.slot.activity));
    expect(feet.length).toBeGreaterThan(0);
    expect(offenders(feet, (f) => f.prompt().includes("from her knees up"))).toEqual(NONE);
  });

  test("the prone selfies wear no legwear: the approved prone frames had bare legs", () => {
    const prone = FRAMES.home.filter((f) => /\bstomach\b|\bprone\b/.test(f.slot.activity));
    expect(prone.length).toBeGreaterThan(0);
    expect(offenders(prone, (f) => f.slot.legwear !== undefined)).toEqual(NONE);
  });

  test("a moment that looks out at the view is never on a front pose, which says her face and body are turned toward the camera", () => {
    const LOOKS_OUT = /^(looks out|takes in the view)\b/;
    expect(ALL.some((f) => LOOKS_OUT.test(f.slot.activity))).toBe(true);
    expect(offenders(ALL, (f) => LOOKS_OUT.test(f.slot.activity) && f.slot.pose === "front")).toEqual(NONE);
  });
});
