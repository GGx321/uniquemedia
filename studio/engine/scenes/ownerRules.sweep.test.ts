import { describe, expect, test } from "bun:test";
import { youthWords, type AvatarDescriptor } from "../../shared/engine";
import { AWAY_ACTION_WORDS, DRESS_LENGTH, DRESS_OR_SKIRT, GLANCE_BACK_WORDS, isOwnerBannedOutfit, LEGS_UNSUITED_OUTFITS, unfabricBottomsIn, YOUTH_PROPS } from "../../shared/scenes/words";
import { BANKS, CUES, GAZE, HAIRSTYLES } from "../../shared/scenes/banks";
import { captureOfShot, faceVisibleOf, shotOf, type Capture } from "../../shared/scenes/captures";
import { plainSentence } from "../../shared/scenes/plain";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleSlot } from "./assembler";
import { hairLinesOf } from "./hairLines";
import { localSentences } from "./localSentences";
import { CONSTRAINTS, slotKeyOf } from "./phoneLook";
import { plan } from "./planner";
import { roomPlaceOf, slotLookOf } from "./roomPlace";
import type { PlanSlot } from "./schema";
import { revealingWordsIn } from "./words";
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
  /** The slot's hairstyle (the run's hair line, «Today her hair is …»), or null for none. The avatar's hair length rotates with the seed. */
  hair: string | null;
  /** The slot's final image prompt, assembled on first use (the assembler is the sweep's dear step, so only the frames a rule reads are assembled). */
  prompt: () => string;
}

const LENGTHS = ["bob", "shoulder", "long"] as const;

function framesOf(category: Category, seed: number, level: "ordinary" | "flirty" = "ordinary", legsShare?: 15 | 30): Frame[] {
  const p = plan({ seed: seed * 7919 + COUNT, count: COUNT, categories: [category], ...(level === "flirty" ? { level } : {}), ...(legsShare === undefined ? {} : { legsShare }) });
  const runId = `run-${category}-${seed}`;
  const local = localSentences({ slots: p.slots, keyOf: (s) => slotKeyOf(runId, s.attemptIdBase) });
  const hair = hairLinesOf(p.slots, LENGTHS[seed % LENGTHS.length] ?? "shoulder", runId);
  return p.slots.map((slot) => {
    const sentence = local(slot) ?? plainSentence(slot);
    let prompt: string | undefined;
    const assemble = (): string => {
      prompt ??= assembleSlot(DESCRIPTOR, slot, sentence, MASTER, { runId, cameraRealism: seed % 4 !== 0, roomPlaceOf, lookOf: slotLookOf, hairStyleOf: (s) => hair.get(s.slotIndex) ?? null }).prompt;
      return prompt;
    };
    return { slot, capture: slot.capture ?? captureOfShot(slot.shot), sentence, hair: hair.get(slot.slotIndex) ?? null, prompt: assemble };
  });
}

// Built once, at load: 2 000 plans per category.
const FRAMES: Record<Category, Frame[]> = Object.fromEntries(
  CATEGORIES.map((category) => [category, Array.from({ length: PLANS }, (_, i) => framesOf(category, i + 1)).flat()]),
) as Record<Category, Frame[]>;
const ALL: Frame[] = CATEGORIES.flatMap((c) => FRAMES[c]);

// S5.7b: the same sweep under «Кокетливая» (7 of 12 slots flirty), on plan ids apart from the ordinary ones.
const FLIRTY_PLANS = 1000;
const FLIRTY: Record<Category, Frame[]> = Object.fromEntries(
  CATEGORIES.map((category) => [category, Array.from({ length: FLIRTY_PLANS }, (_, i) => framesOf(category, i + 50_001, "flirty")).flat()]),
) as Record<Category, Frame[]>;
const FLIRTY_ALL: Frame[] = CATEGORIES.flatMap((c) => FLIRTY[c]);

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

// S5.6R (round C): «blow-dried smooth» or «… straight and worn loose» on about 30 % of «Фитнес» frames, a loose style on 70 %, a sporty one on 11 %. A workout
// moment is a sport moment now: a sporty style on 3 in 4 of a run's, the rest loose. The hair colour is the reference photo's whatever the style (hairLines).
describe("«Фитнес»: she trains in a sporty hairstyle", () => {
  const SPORTY = new Set(HAIRSTYLES.filter((s) => s.sport === true).map((s) => s.text));
  const lines = FRAMES.fitness.flatMap((f) => (f.hair === null ? [] : [f.hair]));
  const share = (test: (style: string) => boolean): number => lines.filter(test).length / lines.length;

  test("the sweep holds «Фитнес» hair lines", () => {
    expect(lines.length).toBeGreaterThan(PLANS * (COUNT / 2));
  });

  test("a sporty style (a ponytail, a sleek bun, a braid, tied or pinned back) on 3 in 4 of them at least", () => {
    expect(share((style) => SPORTY.has(style))).toBeGreaterThanOrEqual(0.75);
  });

  test("a blow-dried style on 15 % of them at most", () => {
    expect(share((style) => /blow-dried/.test(style))).toBeLessThanOrEqual(0.15);
  });

  test("the hair line keeps her hair colour from the reference photo", () => {
    expect(offenders(FRAMES.fitness.filter((f, i) => f.hair !== null && i % 50 === 0), (f) => !f.prompt().includes("the same hair colour as in the reference photo"))).toEqual(NONE);
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
    const p = plan({ seed, count: 20, categories: [...CATEGORIES] });
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

// S5.7b (I5.28): «Кокетливая» changes the moments, the gaze and the cue, never the owner's rules. The rules above that read a frame are asked again of the flirty plans.
describe("«Кокетливая» plans keep the owner's rules (S5.7b)", () => {
  const isFlirtyFrame = (f: Frame): boolean => f.slot.level === "flirty";
  const FLIRTY_CUES = CUES.filter((c) => c.level === "flirty").map((c) => c.text);
  const FLIRTY_GAZES = GAZE.filter((g) => g.level === "flirty").map((g) => g.text);
  const FLIRTY_MOMENTS = new Set(CATEGORIES.flatMap((c) => BANKS[c].places.flatMap((p) => p.moments.filter((m) => m.level === "flirty").map((m) => `${c}\u0000${p.name}\u0000${m.text}`))));
  const onFlirtyMoment = (f: Frame): boolean => FLIRTY_MOMENTS.has(`${f.slot.category}\u0000${f.slot.location}\u0000${f.slot.activity}`);
  const momentOfFrame = (f: Frame) => BANKS[f.slot.category as Category].places.find((p) => p.name === f.slot.location)?.moments.find((m) => m.text === f.slot.activity);
  const SAYS_FLIRTY = [...FLIRTY_CUES, ...FLIRTY_GAZES];

  test("every 12-slot plan holds exactly 7 flirty slots", () => {
    for (const category of CATEGORIES) {
      for (let i = 0; i < FLIRTY_PLANS; i++) expect(FLIRTY[category].slice(i * COUNT, (i + 1) * COUNT).filter(isFlirtyFrame)).toHaveLength(7);
    }
  });

  test("the sweep holds flirty moments in «Дом» and «Гламур», only on flirty slots, and never in an ordinary plan", () => {
    const onMoment = FLIRTY_ALL.filter(onFlirtyMoment);
    expect([...new Set(onMoment.map((f) => f.slot.category))].sort()).toEqual(["glamour", "home"]);
    expect(onMoment.length).toBeGreaterThan(FLIRTY_PLANS);
    expect(offenders(onMoment, (f) => !isFlirtyFrame(f))).toEqual(NONE);
    expect(offenders(ALL, onFlirtyMoment)).toEqual(NONE);
  });

  test("a flirty slot where her face shows says a flirty gaze, a flirty cue or a flirty moment", () => {
    const shows = FLIRTY_ALL.filter((f) => isFlirtyFrame(f) && f.capture !== "mirror-hidden" && f.slot.pose !== "back" && momentOfFrame(f)?.expression !== true);
    expect(shows.length).toBeGreaterThan(FLIRTY_PLANS);
    expect(offenders(shows, (f) => !onFlirtyMoment(f) && !SAYS_FLIRTY.some((voice) => f.sentence.includes(voice)))).toEqual(NONE);
  });

  test("an ordinary slot of a flirty plan says no flirty gaze and no flirty cue", () => {
    expect(offenders(FLIRTY_ALL.filter((f) => !isFlirtyFrame(f)), (f) => SAYS_FLIRTY.some((voice) => f.sentence.includes(voice)))).toEqual(NONE);
  });

  test("no flirty sentence says sexy, seductive or sultry, a revealing word or a youth word", () => {
    // Distinct sentences only: the youth check is the dear step, and an equal sentence has an equal verdict.
    const distinct = [...new Map(FLIRTY_ALL.map((f) => [f.sentence, f] as const)).values()];
    expect(distinct.length).toBeGreaterThan(1000);
    expect(offenders(distinct, (f) => /\b(sexy|seductive|sultry)\b/i.test(f.sentence) || revealingWordsIn(f.sentence).length > 0 || youthWords(f.sentence, "descriptor").length > 0)).toEqual(NONE);
    expect(offenders(FLIRTY_ALL, (f) => /\b(sexy|seductive|sultry)\b/i.test(f.sentence) || revealingWordsIn(f.sentence).length > 0)).toEqual(NONE);
  });

  test("a flirty frame's prompt still says she is an adult woman, and carries no sexy, seductive or sultry", () => {
    const sample = FLIRTY_ALL.filter((f, i) => isFlirtyFrame(f) && i % 25 === 0);
    expect(sample.length).toBeGreaterThan(300);
    expect(offenders(sample, (f) => !f.prompt().includes(CONSTRAINTS) || /\b(sexy|seductive|sultry)\b/i.test(f.prompt()))).toEqual(NONE);
  });

  test("a flirty slot never lies on her stomach off her bed, and a flirty prone moment wears the prone outfits and no legwear", () => {
    expect(offenders(FLIRTY.home, (f) => f.slot.location !== "her bed" && /^lies\b/.test(f.slot.activity) && shotOf(f.capture) === "mirror")).toEqual(NONE);
    const prone = FLIRTY.home.filter((f) => onFlirtyMoment(f) && /\bstomach\b/.test(f.slot.activity));
    expect(prone.length).toBeGreaterThan(FLIRTY_PLANS / 10);
    expect(offenders(prone, (f) => f.slot.location !== "her bed" || f.slot.legwear !== undefined || !["grey jersey lounge shorts and a tee", "grey leggings and a cropped tee"].includes(f.slot.outfit))).toEqual(NONE);
  });

  test("at home she shoots herself: no flirty «Дом» frame is a friend's, nor a flirty home workout or getting-ready frame", () => {
    expect(offenders(FLIRTY.home, (f) => !isSelfShot(f.capture))).toEqual(NONE);
    const fitHome = roomsOf("fitness");
    const glamHome = roomsOf("glamour");
    expect(offenders(FLIRTY.fitness, (f) => fitHome.has(f.slot.location) && !isSelfShot(f.capture))).toEqual(NONE);
    expect(offenders(FLIRTY.glamour, (f) => glamHome.has(f.slot.location) && !isSelfShot(f.capture))).toEqual(NONE);
  });

  test("side or back to the mirror stays reflection-only, and a going-out moment still wears going-out clothes", () => {
    const SIDE = /\bsideways\b|\bside to the mirror\b|\bback to the mirror\b|\bturns to check\b/;
    expect(offenders(FLIRTY_ALL, (f) => SIDE.test(f.slot.activity) && f.capture === "mirror")).toEqual(NONE);
    expect(offenders(FLIRTY.home, (f) => /going out|ready to go|\bkeys\b/.test(f.slot.activity) && /pajama|lounge|leggings|oversized|off one shoulder/.test(f.slot.outfit))).toEqual(NONE);
  });

  test("the taxi and the elevator keep their no-distance rule, and the flirty bar moment is a friend's or an arm's-length photo at the bar", () => {
    const FAR = /a few steps away|her whole body in the picture/;
    const rooms = FLIRTY.glamour.filter((f) => f.slot.location === "the back seat of a taxi" || f.slot.location === "an elevator");
    expect(rooms.length).toBeGreaterThan(0);
    expect(offenders(rooms, (f) => FAR.test(f.prompt()))).toEqual(NONE);
    const bar = FLIRTY.glamour.filter(onFlirtyMoment);
    expect(bar.length).toBeGreaterThan(0);
    expect(offenders(bar, (f) => f.slot.location !== "a cocktail bar" || !["friend", "selfie"].includes(f.capture))).toEqual(NONE);
  });
});

// S5.8a («Ножки», I5.29): the same sweep over the real path, with legs asked for. 12-slot plans at 30 % hold 3 legs slots (the cap of the run: ⌊0.3 × 12⌋), at 15 % 2 (round-half-up of
// 1.8). The owner's rules are asked again of the legs frames, ordinary and flirty: at home she shoots herself (the friend's `low-feet` is for places outside), the taxi is a selfie
// place, side or back to the mirror shows only her reflection, prone is only on a bed, no denim shorts or skirts, natural poses, and nothing a youth prop or a revealing word.
const LEGS_PLANS = 600;
const LEGS: Record<Category, Frame[]> = Object.fromEntries(
  CATEGORIES.map((category) => [category, Array.from({ length: LEGS_PLANS }, (_, i) => framesOf(category, i + 100_001, "ordinary", i % 2 === 0 ? 30 : 15)).flat()]),
) as Record<Category, Frame[]>;
const LEGS_FLIRTY: Record<Category, Frame[]> = Object.fromEntries(
  CATEGORIES.map((category) => [category, Array.from({ length: LEGS_PLANS / 2 }, (_, i) => framesOf(category, i + 150_001, "flirty", 30)).flat()]),
) as Record<Category, Frame[]>;
const LEGS_ALL: Frame[] = CATEGORIES.flatMap((c) => [...LEGS[c], ...LEGS_FLIRTY[c]]);
const LEGS_FRAMES: Frame[] = LEGS_ALL.filter((f) => f.slot.framing === "legs");
const WITH_BODY: AvatarDescriptor = { ...DESCRIPTOR, body: "a slim build with narrow hips" };

describe("«Ножки» plans keep the owner's rules (S5.8a)", () => {
  test("every 12-slot plan holds the legs slots the formula gives: 3 at 30 %, 2 at 15 %", () => {
    for (const category of CATEGORIES) {
      for (let i = 0; i < LEGS_PLANS; i++) {
        const plan12 = LEGS[category].slice(i * COUNT, (i + 1) * COUNT);
        expect(plan12.filter((f) => f.slot.framing === "legs")).toHaveLength(i % 2 === 0 ? 3 : 2);
      }
    }
  });

  test("the sweep holds legs frames of every category, every legs capture, and feet in every one of them", () => {
    expect([...new Set(LEGS_FRAMES.map((f) => f.slot.category))].sort()).toEqual([...CATEGORIES].sort());
    expect([...new Set(LEGS_FRAMES.map((f) => f.capture))].sort()).toEqual(["low-feet", "mirror-hidden", "pov-legs"]);
    expect(LEGS_FRAMES.length).toBeGreaterThan(LEGS_PLANS * CATEGORIES.length * 2);
  });

  test("at home she shoots herself: no legs frame in a room is a photo someone else took, and `low-feet` is outside only", () => {
    const rooms = new Set(CATEGORIES.flatMap((c) => [...roomsOf(c)]));
    expect(offenders(LEGS_FRAMES, (f) => rooms.has(f.slot.location) && !isSelfShot(f.capture))).toEqual(NONE);
    expect(offenders(LEGS_FRAMES, (f) => f.capture === "low-feet" && (f.slot.category === "home" || rooms.has(f.slot.location)))).toEqual(NONE);
    expect(LEGS_FRAMES.filter((f) => f.capture === "low-feet").length).toBeGreaterThan(LEGS_PLANS);
  });

  test("the taxi is a selfie place: its legs frame looks down along her own legs, and no taxi frame is a whole-body photo from a distance", () => {
    const FAR = /a few steps away|her whole body in the picture|crouching/;
    const taxi = LEGS_FRAMES.filter((f) => f.slot.location === "the back seat of a taxi");
    expect(taxi.length).toBeGreaterThan(50);
    expect(offenders(taxi, (f) => f.capture !== "pov-legs" || FAR.test(f.prompt()))).toEqual(NONE);
  });

  test("side or back to the mirror shows only her reflection: a legs mirror frame faces the mirror and never claims her face is clearly visible", () => {
    const SIDE_TO_MIRROR = /\bsideways\b|\bside to the mirror\b|\bback to the mirror\b|\bturns to check\b/;
    const mirror = LEGS_FRAMES.filter((f) => shotOf(f.capture) === "mirror");
    expect(mirror.length).toBeGreaterThan(LEGS_PLANS);
    expect(offenders(mirror, (f) => SIDE_TO_MIRROR.test(f.slot.activity) || f.capture === "mirror" || /face clearly visible/.test(f.prompt()))).toEqual(NONE);
    expect(offenders(LEGS_ALL, (f) => SIDE_TO_MIRROR.test(f.slot.activity) && f.capture === "mirror")).toEqual(NONE);
  });

  test("she lies on her stomach only on her bed: no legs frame lies prone", () => {
    expect(offenders(LEGS_FRAMES, (f) => /stomach|prone/.test(f.slot.activity))).toEqual(NONE);
    expect(offenders(LEGS_ALL, (f) => f.slot.location !== "her bed" && /^lies\b/.test(f.slot.activity) && shotOf(f.capture) === "mirror")).toEqual(NONE);
  });

  test("no denim shorts or skirts, in any outfit, sentence or prompt of a legs plan", () => {
    expect(offenders(LEGS_ALL, (f) => isOwnerBannedOutfit(f.slot.outfit) || isOwnerBannedOutfit(f.sentence))).toEqual(NONE);
  });

  // S5.8a review: a low angle under a mini reads as an upskirt shot. A frame from below or toward the mirror (`low-feet`, a mirror legs frame) wears shorts, trousers, leggings,
  // joggers or a midi or long dress, never a mini or short dress or skirt, a bodycon or a sweater or tee worn as a dress; the legs moments pin the same for a look down her own legs.
  test("no mini or short dress or skirt, bodycon, or sweater or tee as a dress on a legs frame, least of all from below or toward the mirror", () => {
    const UNSUITED = LEGS_UNSUITED_OUTFITS;
    const low = LEGS_FRAMES.filter((f) => f.capture === "low-feet" || shotOf(f.capture) === "mirror");
    expect(low.length).toBeGreaterThan(LEGS_PLANS);
    expect(offenders(low, (f) => UNSUITED.test(f.slot.outfit) || UNSUITED.test(f.sentence))).toEqual(NONE);
    expect(offenders(LEGS_FRAMES, (f) => UNSUITED.test(f.slot.outfit))).toEqual(NONE);
    // A whitelist as well (round 2): a dress or skirt on a legs frame names midi, long or maxi; «a navy wrap dress» of no length is not one.
    expect(offenders(LEGS_FRAMES, (f) => DRESS_OR_SKIRT.test(f.slot.outfit) && !DRESS_LENGTH.test(f.slot.outfit))).toEqual(NONE);
  });

  test("the poses are natural: a legs frame faces the camera, front or three-quarter, never in profile or from behind", () => {
    expect(offenders(LEGS_FRAMES, (f) => f.slot.pose !== "front" && f.slot.pose !== "three-quarter")).toEqual(NONE);
  });

  test("the legs lines open the prompt, with the legs pose phrase and no phone, no selfie word and no hair line", () => {
    const sample = LEGS_FRAMES.filter((_, i) => i % 20 === 0);
    expect(sample.length).toBeGreaterThan(300);
    expect(offenders(sample, (f) => !f.prompt().includes("Her legs fill most of the frame; her face may be out of frame."))).toEqual(NONE);
    expect(offenders(sample, (f) => f.prompt().includes("Today her hair is"))).toEqual(NONE);
    expect(offenders(sample.filter((f) => f.capture !== "mirror-hidden"), (f) => /\b(phone|selfie)\b/i.test(f.sentence))).toEqual(NONE);
  });

  test("the body binding rides on every legs prompt when the avatar has a body", () => {
    const sample = LEGS_FRAMES.filter((_, i) => i % 40 === 0);
    expect(offenders(sample, (f) => !assembleSlot(WITH_BODY, f.slot, f.sentence, MASTER, { runId: "run-legs", roomPlaceOf, lookOf: slotLookOf }).prompt.includes("her exact body proportions as described"))).toEqual(NONE);
  });

  test("legwear goes only where the moment allows it: never on a moment that names socks, soles, bare skin or heels", () => {
    const clash = /\b(socks?|socked|tights|stockings?|bare|barefoot|soles?|heels?)\b/;
    expect(offenders(LEGS_FRAMES, (f) => f.slot.legwear !== undefined && clash.test(f.slot.activity))).toEqual(NONE);
    // Only «Дом» has legwear, and its legs moments pin shorts, pajamas and leggings (S5.8a review), so tights ride on about 3 % of the legs frames of all five categories (measured 214 of 7 500).
    expect(LEGS_FRAMES.filter((f) => f.slot.legwear !== undefined).length).toBeGreaterThan(LEGS_PLANS / 8);
    expect(offenders(LEGS_ALL, (f) => /stocking/i.test(f.sentence) || /stocking/i.test(f.slot.legwear ?? ""))).toEqual(NONE);
  });

  test("legwear never rides under joggers, trousers or leggings: tights and thigh-high socks on trousers read as a fault (wave 5e)", () => {
    expect(offenders(LEGS_FRAMES, (f) => f.slot.legwear !== undefined && /\b(joggers|sweatpants|trousers|pants|jeans|leggings)\b/i.test(f.slot.outfit))).toEqual(NONE);
  });

  test("no sentence or motion of a legs plan carries a youth prop, a youth word or a revealing word, and no sentence says sexy, seductive or sultry", () => {
    const distinct = [...new Map(LEGS_FRAMES.map((f) => [f.sentence, f] as const)).values()];
    expect(distinct.length).toBeGreaterThan(300);
    expect(offenders(distinct, (f) => YOUTH_PROPS.test(f.sentence) || youthWords(f.sentence, "descriptor").length > 0 || revealingWordsIn(f.sentence).length > 0 || /\b(sexy|seductive|sultry)\b/i.test(f.sentence))).toEqual(NONE);
  });

  test("a flirty plan with legs holds exactly 7 flirty slots of 12, a legs moment is never a flirty one, and an ordinary slot says nothing flirty", () => {
    const FLIRTY_VOICES = [...CUES.filter((c) => c.level === "flirty").map((c) => c.text), ...GAZE.filter((g) => g.level === "flirty").map((g) => g.text)];
    for (const category of CATEGORIES) {
      for (let i = 0; i < LEGS_PLANS / 2; i++) {
        const plan12 = LEGS_FLIRTY[category].slice(i * COUNT, (i + 1) * COUNT);
        expect(plan12.filter((f) => f.slot.level === "flirty")).toHaveLength(7);
        expect(plan12.filter((f) => f.slot.framing === "legs")).toHaveLength(3);
      }
    }
    const flirtyMoments = new Set(CATEGORIES.flatMap((c) => BANKS[c].places.flatMap((p) => p.moments.filter((m) => m.level === "flirty").map((m) => `${c}\u0000${p.name}\u0000${m.text}`))));
    expect(offenders(LEGS_FRAMES, (f) => flirtyMoments.has(`${f.slot.category}\u0000${f.slot.location}\u0000${f.slot.activity}`))).toEqual(NONE);
    expect(offenders(LEGS_ALL.filter((f) => f.slot.level !== "flirty"), (f) => FLIRTY_VOICES.some((voice) => f.sentence.includes(voice)))).toEqual(NONE);
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

// C3′ (the owner's verdict on the C3′ run, 2026-10-12, and the Grok wording probe c3fix): each fix is asked of the same sweep, ordinary, flirty and «Ножки» plans alike.
const C3_ALL: Frame[] = [...ALL, ...FLIRTY_ALL, ...LEGS_ALL];

describe("C3′: a face-hidden mirror frame covers her face from her eyebrows to her chin", () => {
  // «the phone hides most of her face» drew her face BESIDE the phone in 5 of 5 C3′ frames; the probe's winner (1a) drew no face.
  const FACE_COVER = "she holds her phone right in front of her face, the phone covering her face from her eyebrows to her chin; only her hair and body show in the mirror.";
  const OLD_COVER = /hides most of her face|it hides her face/;
  // A look, her eyes or an expression would pull her face back out from behind the phone.
  const FACE_CLAUSE = /\b(?:look\w*|glanc\w*|gaz\w*|eyes?|star(?:e|es|ing)|smil\w*|grin\w*|smirk\w*|laugh\w*|pout\w*|wink\w*|lips?)\b/i;
  const hidden = C3_ALL.filter((f) => f.capture === "mirror-hidden");
  const sideOn = hidden.filter((f) => slotLookOf(f.slot)?.mirrorBack === true);

  test("the sweep holds face-hidden frames of «Дом», «Гламур» and «Фитнес», side to the mirror and legs frames among them", () => {
    expect([...new Set(hidden.map((f) => f.slot.category))].sort()).toEqual(["fitness", "glamour", "home"]);
    expect(sideOn.length).toBeGreaterThan(PLANS / 2);
    expect(hidden.filter((f) => f.slot.framing === "legs").length).toBeGreaterThan(LEGS_PLANS / 2);
  });

  test("every face-hidden prompt carries the face-cover line, and none the old «hides most of her face»", () => {
    const sample = hidden.filter((_, i) => i % 7 === 0);
    expect(sample.length).toBeGreaterThan(1000);
    expect(offenders(sample, (f) => !f.prompt().includes(FACE_COVER) || OLD_COVER.test(f.prompt()))).toEqual(NONE);
  });

  test("side to the mirror, the reflection-only sentence says the phone covers her face the same way", () => {
    expect(offenders(sideOn, (f) => !f.prompt().includes("Only her reflection is in the picture; the phone covers her face from her eyebrows to her chin."))).toEqual(NONE);
  });

  test("no gaze, eyes or expression contradicts it: a face-hidden sentence names none", () => {
    expect(offenders(hidden, (f) => FACE_CLAUSE.test(f.sentence))).toEqual(NONE);
  });
});

describe("C3′: a look down her own legs is a first-person photo from her eyes", () => {
  // «looking down along her own legs … held at her eye level» came out as a photo from far away (R5#09); the probe's variant (b) drew a clean first-person view.
  const POV_LINE = "A first-person point-of-view photo: the camera is exactly where her eyes are, looking straight down her own body;";
  const pov = C3_ALL.filter((f) => f.capture === "pov-legs");

  test("the sweep holds pov-legs frames of «Дом», «Виды», «Гламур» and «Фитнес», barefoot and socked among them", () => {
    expect([...new Set(pov.map((f) => f.slot.category))].sort()).toEqual(["fitness", "glamour", "home", "travel"]);
    expect(pov.some((f) => /\bbare\b/.test(f.slot.activity)) && pov.some((f) => /\bsocked\b/.test(f.slot.activity))).toBe(true);
  });

  test("every pov-legs prompt opens with the first-person line: no face, no mirror and no hand in the picture, and her hands hold nothing", () => {
    const sample = pov.filter((_, i) => i % 3 === 0);
    expect(sample.length).toBeGreaterThan(500);
    expect(
      offenders(sample, (f) => {
        const prompt = f.prompt();
        return !prompt.startsWith(POV_LINE) || !prompt.includes("only her own legs are in the picture, with no face, no mirror and no hand.") || !prompt.endsWith("her other hand is free and holds nothing.") || prompt.includes("held at her eye level");
      }),
    ).toEqual(NONE);
  });

  test("the line leaves her feet to the moment: no pov-legs prompt puts socks on a barefoot moment", () => {
    expect(offenders(pov, (f) => /\bbare\b/.test(f.slot.activity) && /\bsock/.test(f.prompt()))).toEqual(NONE);
  });
});

describe("C3′: no built-in skirt or shorts is left for Grok to draw as denim", () => {
  // An unnamed «a mini skirt» (R3#03) or «shorts» came out as DENIM; the probe drew none once the outfit named a fabric.
  const BOTTOMS = /\b(?:skirts?|shorts|skorts?|minis?)\b(?![- ]dress)/;
  const wearing = C3_ALL.filter((f) => BOTTOMS.test(f.slot.outfit));

  test("the sweep holds skirts or shorts in every category's frames", () => {
    expect([...new Set(wearing.map((f) => f.slot.category))].sort()).toEqual([...CATEGORIES].sort());
  });

  test("every skirt, shorts or skort a built-in frame wears names its fabric", () => {
    expect(offenders(wearing, (f) => unfabricBottomsIn(f.slot.outfit).length > 0)).toEqual(NONE);
  });

  test("so no built-in prompt needs the not-denim clause, and none names denim at all", () => {
    const sample = wearing.filter((_, i) => i % 9 === 0);
    expect(sample.length).toBeGreaterThan(2000);
    expect(offenders(sample, (f) => /\bdenim\b/i.test(f.prompt()))).toEqual(NONE);
  });
});

describe("C3′: a frame from behind or in profile shows what she is doing", () => {
  // The owner on R2#01 «walks away down the pavement» and R5#08 «sits facing the window»: «просто стоит спиной без какой-либо позы».
  const away = C3_ALL.filter((f) => f.slot.pose === "back" || f.slot.pose === "profile");
  const glance = C3_ALL.filter((f) => GLANCE_BACK_WORDS.test(f.slot.activity) && (f.capture === "friend" || f.capture === "candid" || f.capture === "timer"));

  test("the sweep holds away frames of every category, from behind and in profile", () => {
    expect([...new Set(away.map((f) => f.slot.category))].sort()).toEqual([...CATEGORIES].sort());
    expect(away.some((f) => f.slot.pose === "back") && away.some((f) => f.slot.pose === "profile")).toBe(true);
  });

  test("every away frame's moment names what she is doing: her hands, arms or hair, a strap or an earring, a stretch, a railing, her knees or legs, a turn to look", () => {
    expect(offenders(away, (f) => !AWAY_ACTION_WORDS.test(f.slot.activity))).toEqual(NONE);
  });

  // The probe (c3fix 4b): glancing back over her shoulder, her face shows at three-quarter even under «Photographed from behind, her face not visible».
  test("a frame that glances back over her shoulder is half from behind with her face visible, never «her face not visible»", () => {
    expect(glance.length).toBeGreaterThan(PLANS);
    const sample = glance.filter((_, i) => i % 3 === 0);
    expect(offenders(sample, (f) => /her face not visible/.test(f.prompt()) || !f.prompt().includes("Seen half from behind, her face turned back to a three-quarter angle, clearly visible."))).toEqual(NONE);
  });

  test("and the face gate judges it like any three-quarter frame", () => {
    expect(offenders(glance, (f) => f.slot.pose !== "three-quarter" || faceVisibleOf(f.slot) !== "yes")).toEqual(NONE);
  });
});

describe("C3′: a timer frame keeps the phone that takes it out of the picture", () => {
  // The probe's timer frame (c3fix 4a) drew the propped phone itself in the foreground.
  const timer = C3_ALL.filter((f) => f.capture === "timer");

  test("the sweep holds timer frames of «Дом», «Улица», «Виды» and «Фитнес»", () => {
    expect([...new Set(timer.map((f) => f.slot.category))].sort()).toEqual(["fitness", "home", "photoshoot", "travel"]);
  });

  test("every timer prompt says the phone itself is out of the picture, her hands empty and nobody holding a phone", () => {
    const sample = timer.filter((_, i) => i % 5 === 0);
    expect(sample.length).toBeGreaterThan(1000);
    expect(offenders(sample, (f) => !f.prompt().includes("on a timer; the phone itself is out of the picture; both of her hands are empty and nobody holds a phone;"))).toEqual(NONE);
  });
});
