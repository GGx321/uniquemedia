import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
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
  const SIDE_TO_MIRROR = /\bsideways\b|\bside to the mirror\b|\bback to the mirror\b/;

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

