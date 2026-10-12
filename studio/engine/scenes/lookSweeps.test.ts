import { describe, expect, test } from "bun:test";
import { BODY_PHRASE_MAX, BodyBust, BodyFigure, BodyHeight, BodyMark, BottomShape, BottomSize, LegLength, LegShape, POOL_TIMES, bodyPhrase, youthWords } from "../../shared/engine";
import type { AvatarBody, AvatarDescriptor } from "../../shared/engine";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { withoutExemptLookPhrases } from "../../shared/scenes/words";
import { assembleSlot } from "./assembler";
import { hairLinesOf } from "./hairLines";
import { phoneHandLineOf } from "./phoneLook";
import { plan, planWithPools } from "./planner";
import { isPhoneActivity, POOLS, type Activity, type Place, type Pool } from "./pools";
import { redrawSlot } from "./redraw";
import { roomPlaceOf, slotLookOf } from "./roomPlace";
import { PlanSlotSchema, PoseSchema, type PlanSlot } from "./schema";
import { CUSTOM_REF } from "./testing/customPool";
import { firstHit, HELD_PHONE, NEGATED_LOOK, SOFT_LIST, STAGING, SWEEP_CUSTOM_POOL } from "./testing/lookRules";
import { CATEGORIES, SHOTS } from "./types";
import { revealingWordsIn } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.1d: the end-to-end look sweeps. Real plans (the planner, with the poses and every category, built-in and custom) go through a writer stand-in (a
// sentence made of the slot's own place, activity and outfit, the way the writer is told to write it) and the real assembler, across every shot × pose ×
// time × «Реализм камеры» on/off × the room draw's three states (tidy, lived-in, messy). The prompt is split into the writer's sentence and the look text
// around it: the look text is ours (I5.2, I5.3, I5.10 bind it); the sentence is the writer's and the pools', swept in pools.sweep.test.ts. Only prompts
// assembled from NEW plans are swept: an old journaled sentence keeps its text (I5.3, plan §4), and «Другая сцена» refreshes it.

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair." };
const MASTER = asLibraryReference(JPEG);
const ALL_POSES = { profile: true, back: true };
const TIMES = [...POOL_TIMES, "twilight"];
const PHONEFUL_REF = "cat-phoneful";

const one = (text: string): Activity => ({ text, twoHanded: false });
// A custom category whose places have phone activities beside clean ones (stored custom pools carry no phone flag: the words decide).
const PHONEFUL: Pool = {
  locations: [
    { name: "a bridge", times: ["morning", "evening"], activities: [one("texting on her phone"), one("leaning on the railing"), { text: "cooking", twoHanded: true }] },
    { name: "a bookshop", times: ["midday"], mirror: true, activities: [one("scrolling her phone"), one("browsing a shelf")] },
    { name: "a cafe", times: ["morning", "midday"], activities: [one("reading the board by the till"), one("scrolling her phone")] },
  ],
  outfits: ["a trench coat and jeans", "a knit dress and boots"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};
const POOLS_ALL: Record<string, Pool> = { ...POOLS, [CUSTOM_REF]: SWEEP_CUSTOM_POOL, [PHONEFUL_REF]: PHONEFUL };

/** The writer stand-in: one plain sentence made of the slot's own words. No trailing full stop (the assembler adds it). */
const sentenceOf = (slot: PlanSlot): string => `She is ${slot.activity} at ${slot.location}, wearing ${slot.outfit}`;

/** The captures that carry the body binding when the avatar has a body (plan r1.5 §5.4): the close self-shots from above and the plain selfie do not. */
const BODY_CAPTURES: readonly Capture[] = ["mirror-hidden", "mirror", "prone", "over-shoulder", "timer", "friend", "candid", "pov-legs", "low-feet"];

interface Swept {
  label: string;
  /** Who took the photo: the slot's capture, or the one its stored shot says. */
  capture: Capture;
  /** The body phrase the descriptor carried, or undefined for an avatar with no body. */
  body: string | undefined;
  slot: PlanSlot;
  realism: boolean;
  sentence: string;
  /** The prompt without the writer's sentence and the descriptor: the text that is ours. */
  look: string;
  prompt: string;
}

function assembleAll(slots: readonly PlanSlot[], runId: string, rooms: boolean, descriptor: AvatarDescriptor = DESCRIPTOR): Swept[] {
  const out: Swept[] = [];
  // The hair line sweeps with the rest of the look: the run's styles, as the run job draws them.
  const hair = hairLinesOf(slots, "shoulder", runId);
  for (const base of slots) {
    const time = TIMES[base.slotIndex % TIMES.length] as string;
    for (const slot of [base, { ...base, timeOfDay: time }]) {
      if (!PlanSlotSchema.safeParse(slot).success) continue;
      const sentence = sentenceOf(slot);
      for (const realism of [true, false]) {
        const prompt = assembleSlot(descriptor, slot, sentence, MASTER, { runId, cameraRealism: realism, lookOf: slotLookOf, hairStyleOf: (hairSlot) => hair.get(hairSlot.slotIndex) ?? null, ...(rooms ? { roomPlaceOf } : {}) }).prompt;
        if (!prompt.includes(sentence)) throw new Error(`the sentence is not in the prompt: ${sentence}`);
        out.push({ body: descriptor.body, capture: slot.capture ?? captureOfShot(slot.shot), label: `${runId}/${slot.slotIndex}/${slot.category}/${slot.shot}/${slot.pose}/${slot.timeOfDay}/${realism ? "on" : "off"}`, slot, realism, sentence, look: prompt.replace(sentence, "").replace(descriptor.text.replace(/\.$/, ""), "").replace(descriptor.body === undefined ? "" : `; ${descriptor.body}`, ""), prompt });
      }
    }
  }
  return out;
}

// The sweep set, built once: 25 seeded built-in plans (20 slots, every category, every pose) and 12 seeded plans over the custom categories.
const SWEPT: Swept[] = (() => {
  const all: Swept[] = [];
  for (let seed = 1; seed <= 25; seed++) all.push(...assembleAll(plan({ seed: seed * 7919, count: 20, categories: [...CATEGORIES] }).slots, `run-${seed}`, true));
  for (let seed = 1; seed <= 12; seed++) {
    const scenes = planWithPools({ seed: seed * 104729, count: 15, categories: [CUSTOM_REF, PHONEFUL_REF, "home"] }, POOLS_ALL);
    all.push(...assembleAll(scenes.slots, `run-c${seed}`, true));
  }
  return all;
})();

// The redraw sweep: «Другая сцена» on selfie and mirror slots, then assembled like any other (N1).
const REDRAWN: Swept[] = (() => {
  const avoid = { locations: new Set<string>(), outfits: new Set<string>() };
  const all: Swept[] = [];
  const cases: Array<[string, Pool]> = [...CATEGORIES.map((c): [string, Pool] => [c, POOLS[c]]), [PHONEFUL_REF, PHONEFUL], [CUSTOM_REF, SWEEP_CUSTOM_POOL]];
  for (const [category, pool] of cases) {
    for (const shot of ["selfie", "mirror"] as const) {
      const place = pool.locations[0] as Place;
      const slot = PlanSlotSchema.parse({ slotIndex: 1, category, location: place.name, timeOfDay: "morning", activity: "x", outfit: pool.outfits[0], shot, pose: "front", attemptIdBase: "slot-1", repeatedPair: false });
      for (let seed = 1; seed <= 25; seed++) {
        const out = redrawSlot({ seed: seed * 7919, k: 1 + (seed % 5), slot, pool, avoid });
        all.push(...assembleAll([out], `run-r${category}-${shot}-${seed}`, true));
      }
    }
  }
  return all;
})();

// The body axis (S5.2c, L9): the same sweep with a body phrase in the descriptor. A representative set, not the whole product: the shortest phrase, one
// mid-length one, one with marks, and the longest any body renders to (BODY_PHRASE_MAX). Three seeded plans each keep it fast; the shots, poses, times and
// «Реализм камеры» states still all come up, and every check below (I5.2, I5.3, I5.10, I5.13) runs over these prompts too.
const longestBody = (): AvatarBody => {
  const lengthOf = (body: AvatarBody): number => (bodyPhrase(body) ?? "").length;
  const best = (candidates: AvatarBody[]): AvatarBody => [...candidates].sort((a, b) => lengthOf(b) - lengthOf(a))[0] as AvatarBody;
  const one = (key: "height" | "bust" | "figure", values: readonly string[]): AvatarBody[] => values.map((v) => ({ [key]: v }) as AvatarBody);
  const two = (a: "legLength" | "bottomSize", av: readonly string[], b: "legShape" | "bottomShape", bv: readonly string[]): AvatarBody[] => av.flatMap((x) => bv.map((y) => ({ [a]: x, [b]: y }) as AvatarBody));
  const marks = [...BodyMark.options].sort((a, b) => lengthOf({ bodyMarks: [b] }) - lengthOf({ bodyMarks: [a] }));
  return {
    ...best(one("height", BodyHeight.options)),
    ...best(one("bust", BodyBust.options)),
    ...best(one("figure", BodyFigure.options)),
    ...best(two("legLength", LegLength.options, "legShape", LegShape.options)),
    ...best(two("bottomSize", BottomSize.options, "bottomShape", BottomShape.options)),
    bodyMarks: [marks[0] as (typeof marks)[number], marks[1] as (typeof marks)[number]],
  };
};
const BODIES: AvatarBody[] = [{ height: "short" }, { height: "tall", bust: "full", figure: "hourglass" }, { figure: "pear", legLength: "long", legShape: "toned", bodyMarks: ["tattoo-ankle"] }, longestBody()];
const BODY_PHRASES: string[] = BODIES.map((b) => bodyPhrase(b) ?? "");
const BODIED: Swept[] = BODY_PHRASES.flatMap((body, i) => {
  const descriptor: AvatarDescriptor = { ...DESCRIPTOR, body };
  const all: Swept[] = [];
  for (let seed = 1; seed <= 3; seed++) all.push(...assembleAll(plan({ seed: seed * 7919, count: 60, categories: [...CATEGORIES] }).slots, `run-b${i}-${seed}`, true, descriptor)); // 60 slots: a category faces away from 5 slots on (S5.7b)
  return all;
});

// S5.5: the only built-in activity that may happen in a messy room is the home bed's stretching (the glamour rooms are tidy now), and the messy draw is at most 5 %, so a
// plan sweep may never reach it. This fixed slot, across 200 runs per shot, makes the messy state a certainty of the sweep instead of a matter of the seeds.
const MESSY_ROOMS: Swept[] = (() => {
  const all: Swept[] = [];
  // Friend, selfie and candid: the messy sentence sits differently around a phone in her hand (the selfie) and a snap she does not pose for (the candid).
  for (const shot of ["friend", "selfie", "candid"] as const) {
    const slot = PlanSlotSchema.parse({ slotIndex: 1, category: "home", location: "her bed", timeOfDay: "morning", activity: "lies back on the pillow", outfit: POOLS.home.outfits[0], shot, pose: "front", attemptIdBase: "slot-1", repeatedPair: false });
    for (let run = 1; run <= 200; run++) all.push(...assembleAll([slot], `run-m${shot}${run}`, true));
  }
  return all;
})();

// A stored plan can still hold a photographer's shot (no new plan deals one): such a slot is a friend's, and its prompt takes the same look. Made here from new
// plans' friend slots, so the old shot stays swept.
const OLD_PHOTOGRAPHER: Swept[] = (() => {
  const all: Swept[] = [];
  for (let seed = 1; seed <= 6; seed++) {
    const friends = plan({ seed: seed * 7919, count: 30, categories: [...CATEGORIES] }).slots.filter((s) => s.shot === "friend" && s.capture === undefined);
    all.push(...assembleAll(friends.map((s) => ({ ...s, shot: "photographer" as const })), `run-p${seed}`, true));
  }
  return all;
})();

const EVERYTHING = [...SWEPT, ...REDRAWN, ...BODIED, ...MESSY_ROOMS, ...OLD_PHOTOGRAPHER];
const hits = (check: (s: Swept) => string | null): Array<{ label: string; hit: string }> =>
  EVERYTHING.flatMap((s) => {
    const hit = check(s);
    return hit === null ? [] : [{ label: s.label, hit }];
  });

describe("the sweep covers what it claims (it is not vacuous)", () => {
  test("a few thousand prompts", () => {
    expect(EVERYTHING.length).toBeGreaterThan(3000);
  });

  test("every shot, every pose and every time, with «Реализм камеры» both on and off", () => {
    expect(new Set(EVERYTHING.map((s) => s.slot.shot))).toEqual(new Set(SHOTS));
    expect(new Set(EVERYTHING.map((s) => s.slot.pose))).toEqual(new Set(PoseSchema.options));
    for (const time of TIMES) expect(EVERYTHING.some((s) => s.slot.timeOfDay === time)).toBe(true);
    expect(new Set(EVERYTHING.map((s) => s.realism))).toEqual(new Set([true, false]));
  });

  test("every built-in and both custom categories", () => {
    for (const category of [...CATEGORIES, CUSTOM_REF, PHONEFUL_REF]) expect(EVERYTHING.some((s) => s.slot.category === category)).toBe(true);
  });

  test("all three room states are drawn (tidy, lived-in, messy), and some prompts have no room phrase", () => {
    expect(EVERYTHING.some((s) => s.look.includes("The room is ordinary and fairly tidy"))).toBe(true);
    expect(EVERYTHING.some((s) => s.look.includes("The room looks lived-in"))).toBe(true);
    expect(EVERYTHING.some((s) => s.look.includes("The room is messy"))).toBe(true);
    expect(EVERYTHING.some((s) => !s.look.includes("The room "))).toBe(true);
  });

  test("a phone activity does reach friend, candid and photographer prompts (the allowance is exercised)", () => {
    const phoneShots = new Set(EVERYTHING.filter((s) => isPhoneActivity({ text: s.slot.activity })).map((s) => s.slot.shot));
    expect(phoneShots.has("friend") || phoneShots.has("candid") || phoneShots.has("photographer")).toBe(true);
  });
});

describe("the body axis (S5.2c)", () => {
  const BODY_CLAUSE = "and her exact body proportions as described";

  test("the representative set holds the longest phrase any body renders to, and every phrase is distinct", () => {
    expect(Math.max(...BODY_PHRASES.map((p) => p.length))).toBe(BODY_PHRASE_MAX);
    expect(new Set(BODY_PHRASES).size).toBe(BODY_PHRASES.length);
    expect(BODY_PHRASES.every((p) => p.length > 0)).toBe(true);
  });

  test("every body phrase is swept across every shot, every pose and both «Реализм камеры» states", () => {
    for (const phrase of BODY_PHRASES) {
      const mine = BODIED.filter((s) => s.body === phrase);
      // No new plan deals a photographer's shot (a stored one is swept in OLD_PHOTOGRAPHER); the body binding of a friend's snap is the same.
      expect(new Set(mine.map((s) => s.slot.shot))).toEqual(new Set(SHOTS.filter((shot) => shot !== "photographer")));
      expect(new Set(mine.map((s) => s.slot.pose))).toEqual(new Set(PoseSchema.options));
      expect(new Set(mine.map((s) => s.realism))).toEqual(new Set([true, false]));
    }
  });

  test("the phrase is in a body prompt exactly once, after the descriptor text and before the artefact line", () => {
    expect(hits((s) => (s.body === undefined || (s.prompt.split(s.body).length === 2 && s.prompt.indexOf(DESCRIPTOR.text.replace(/\.$/, "")) < s.prompt.indexOf(s.body)) ? null : "placement"))).toEqual([]);
  });

  test("a body prompt carries the binding clause once on the captures that take it (not the plain selfie or the close shot from above), and a prompt with no body never carries it", () => {
    expect(hits((s) => (s.body !== undefined && BODY_CAPTURES.includes(s.capture) ? (s.prompt.split(BODY_CLAUSE).length === 2 ? null : "missing") : s.prompt.includes(BODY_CLAUSE) ? "unexpected" : null))).toEqual([]);
  });

  test("a body prompt carries no youth or revealing word, phrase and clause included", () => {
    expect(hits((s) => (s.body === undefined ? null : (youthWords(s.prompt, "descriptor")[0] ?? revealingWordsIn(s.body)[0] ?? null)))).toEqual([]);
  });
});

describe("I5.2: only the mirror shows a phone", () => {
  // The look text may say «phone» only as the kind of photo and, for the mirror, in the mirror line and its phone-hand line. The sentence is not part of the look text.
  const KIND_OF_PHOTO = /Ordinary phone photo|A quick phone photo/g;
  const MIRROR_ONLY = /her phone in her hand at chest height|One hand holds the phone|she holds her phone right in front of her face, the phone covering her face|the phone covers her face|her face behind her phone/g;
  // The lines of the 5a.2 self-shots name her phone to say where it is NOT: out of the frame, propped on a ledge on a timer with nobody holding one.
  const SELF_SHOT_ONLY = /Her phone arm is out of the frame|A photo from her phone propped on a ledge|nobody holds a phone/g;

  test("no non-mirror look text matches a held-phone pattern", () => {
    expect(hits((s) => (s.slot.shot === "mirror" ? null : firstHit(s.look, HELD_PHONE)))).toEqual([]);
  });

  test("no look text names a phone beyond the places each author's lines allow", () => {
    expect(
      hits((s) => {
        const allowed = s.slot.shot === "mirror" ? MIRROR_ONLY : SELF_SHOT_ONLY;
        return s.look.replace(KIND_OF_PHOTO, "").replace(allowed, "").match(/\bphones?\b/i)?.[0] ?? null;
      }),
    ).toEqual([]);
  });

  test("a selfie or mirror prompt never carries a phone or two-handed activity, where its place has a clean one", () => {
    expect(
      hits((s) => {
        if (s.slot.shot !== "selfie" && s.slot.shot !== "mirror") return null;
        const place = POOLS_ALL[s.slot.category]?.locations.find((l) => l.name === s.slot.location);
        const activity = place?.activities.find((a) => a.text === s.slot.activity);
        if (activity === undefined) return `no such activity: ${s.slot.activity}`;
        if (activity.twoHanded) return `two-handed: ${activity.text}`;
        const hasClean = place?.activities.some((a) => !a.twoHanded && !isPhoneActivity(a)) === true;
        return hasClean && isPhoneActivity(activity) ? `phone: ${activity.text}` : null;
      }),
    ).toEqual([]);
  });

  test("a selfie or mirror prompt's writer sentence names no phone, where its place has a clean activity", () => {
    expect(
      hits((s) => {
        if (s.slot.shot !== "selfie" && s.slot.shot !== "mirror") return null;
        const place = POOLS_ALL[s.slot.category]?.locations.find((l) => l.name === s.slot.location);
        const hasClean = place?.activities.some((a) => !a.twoHanded && !isPhoneActivity(a)) === true;
        return hasClean ? (s.sentence.match(/\b(phones?|smartphones?|texting)\b/i)?.[0] ?? null) : null;
      }),
    ).toEqual([]);
  });

  test("every prompt ends with its own capture's hand line, and a photo someone else took ends with the constraints alone", () => {
    expect(
      hits((s) => {
        const hand = phoneHandLineOf(s.capture);
        return hand === null ? (s.prompt.endsWith("watermark.") ? null : "other") : s.prompt.endsWith(hand) ? null : s.capture;
      }),
    ).toEqual([]);
    expect(hits((s) => (s.slot.shot !== "selfie" && s.slot.shot !== "mirror" && /only her other hand acts|her other hand is free/.test(s.prompt) ? "other" : null))).toEqual([]);
  });
});

describe("C1: the word «selfie» draws a phone, so no selfie slot's image prompt says it", () => {
  const SELFIE_SLOTS = EVERYTHING.filter((s) => s.slot.shot === "selfie");

  test("the sweep reaches selfie slots of every category, built-in and custom (sanity)", () => {
    expect(SELFIE_SLOTS.length).toBeGreaterThan(300);
    expect(new Set(SELFIE_SLOTS.map((s) => s.slot.category)).size).toBeGreaterThanOrEqual(CATEGORIES.length + 2);
  });

  test("no selfie prompt says selfie or front camera, whichever of the fixed texts we own is drawn", () => {
    expect(hits((s) => (s.slot.shot === "selfie" ? (s.prompt.match(/selfie|front[ -]camera/i)?.[0] ?? null) : null))).toEqual([]);
  });

  test("a selfie prompt names a phone nowhere but in the kind of photo (the mirror alone shows one)", () => {
    expect(hits((s) => (s.slot.shot === "selfie" ? (s.prompt.replace(/Ordinary phone photo|Her phone arm is out of the frame/g, "").match(/\bphones?\b/i)?.[0] ?? null) : null))).toEqual([]);
  });

  test("the mirror prompt keeps saying selfie, because it must show the phone", () => {
    const mirror = EVERYTHING.filter((s) => s.slot.shot === "mirror");
    expect(mirror.length).toBeGreaterThan(0);
    expect(mirror.every((s) => /mirror selfie/.test(s.prompt))).toBe(true);
  });
});

describe("S5.R1 H1: a place never names a mirror the shot does not use", () => {
  test("no slot of a shot other than the mirror has a location that matches /mirror/i", () => {
    const offenders = EVERYTHING.filter((s) => s.slot.shot !== "mirror" && /mirror/i.test(s.slot.location)).map((s) => `${s.label}: ${s.slot.location}`);
    expect(offenders).toEqual([]);
  });

  test("no non-mirror prompt says «mirror» in the writer's sentence, where the pools are the source", () => {
    const offenders = EVERYTHING.filter((s) => s.slot.shot !== "mirror" && /mirror/i.test(s.sentence)).map((s) => s.label);
    expect(offenders).toEqual([]);
  });

  test("the built-in sweep does draw non-mirror shots at places that may carry a mirror (the sweep is not vacuous)", () => {
    const mirrorPlaces = new Set(CATEGORIES.flatMap((c) => POOLS[c].locations.filter((l) => l.mirror === true).map((l) => l.name)));
    expect(EVERYTHING.some((s) => s.slot.shot !== "mirror" && mirrorPlaces.has(s.slot.location))).toBe(true);
  });
});

describe("I5.3: no camera, staging or luxury word in a prompt assembled from a new plan", () => {
  test("none of the camera and staging phrases, in any prompt", () => {
    expect(hits((s) => firstHit(s.prompt, STAGING))).toEqual([]);
  });

  test("none of the soft list (studio, photographer, editorial, golden hour, softly lit, bokeh, cinematic, the luxury words…), in any prompt", () => {
    expect(hits((s) => SOFT_LIST.exec(withoutExemptLookPhrases(s.prompt))?.[0] ?? null)).toEqual([]);
  });
});

describe("I5.10: no negated look term in a prompt", () => {
  test("no «no retouching», «no bokeh», «not retouched», «without retouching» or the like, in any prompt", () => {
    expect(hits((s) => firstHit(s.prompt, NEGATED_LOOK))).toEqual([]);
  });
});

describe("what the look text must keep, whatever the draw (I5.13)", () => {
  test("«She is an adult woman.» is in every prompt", () => {
    expect(hits((s) => (s.prompt.includes("She is an adult woman.") ? null : "missing"))).toEqual([]);
  });

  // `youthWords` is the heavy call (about 0.5 ms a text) and the check reads the look alone, so a distinct look is read once; and the sweeps are checked one test each, so a loaded shard
  // is not asked to read all ~9.6k prompts (~5k distinct looks, 5 s alone) inside one test's bound (S5.R3). Every prompt of every sweep is still read.
  const verdicts = new Map<string, string | null>();
  const youthOrRevealing = (s: Swept): string | null => {
    if (!verdicts.has(s.look)) verdicts.set(s.look, youthWords(s.look, "descriptor")[0] ?? revealingWordsIn(s.look)[0] ?? null);
    return verdicts.get(s.look) ?? null;
  };
  const SWEEPS: Array<[string, readonly Swept[]]> = [
    ["the plans", SWEPT],
    ["the redraws", REDRAWN],
    ["the body phrases", BODIED],
    ["the messy rooms", MESSY_ROOMS],
    ["the old photographer shots", OLD_PHOTOGRAPHER],
  ];

  test("the sweeps listed here are the whole of EVERYTHING, so none is left unread", () => {
    expect(SWEEPS.reduce((sum, [, swept]) => sum + swept.length, 0)).toBe(EVERYTHING.length);
  });

  test.each(SWEEPS)("the look text carries no youth word and no revealing word: %s", (_name, swept) => {
    const offenders = swept.flatMap((s) => {
      const hit = youthOrRevealing(s);
      return hit === null ? [] : [{ label: s.label, hit }];
    });
    expect(offenders).toEqual([]);
  });

  test("the artefact line is positive in both switch states: the sharp background is there, «Реализм камеры» adds the camera-roll artefacts", () => {
    // I5.34: only «Дом»'s lamp places at evening and night swap the sharp background for the lamp mood; the sweep reaches both.
    const lampMood = (s: Swept): boolean => s.look.includes("dim evening light from a bedside lamp");
    expect(hits((s) => (lampMood(s) ? (s.look.includes("everything in focus") ? "lamp mood with the sharp line" : null) : s.look.includes("the background as sharp as she is") ? null : "no sharp background"))).toEqual([]);
    expect(EVERYTHING.some(lampMood)).toBe(true);
    expect(hits((s) => (lampMood(s) !== (POOLS_ALL[s.slot.category]?.locations.find((l) => l.name === s.slot.location)?.lamp === true && (s.slot.timeOfDay === "evening" || s.slot.timeOfDay === "night")) ? "lamp mood out of place" : null))).toEqual([]);
    expect(hits((s) => (s.realism !== s.look.includes("straight from her camera roll") ? "switch" : null))).toEqual([]);
  });
});

// Positive controls: the detectors above are not blind. Each fires on text that breaks its rule, so a silent sweep means the prompts are clean.
describe("the detectors fire on text that breaks the rule", () => {
  test.each(["she holds the phone", "holds her phone up", "a phone in her hand", "the phone is visible", "phone visible"])("held phone: %s", (text) => {
    expect(firstHit(text, HELD_PHONE)).not.toBeNull();
  });

  test.each(["studio lighting", "Editorial", "full-frame", "Only she is in focus", "shot on a camera", "a photographer", "golden hour", "softly lit", "bokeh"])("staging: %s", (text) => {
    expect(firstHit(text, STAGING)).not.toBeNull();
  });

  test.each(["in a studio", "cinematic", "a marble counter", "stunning", "soft light", "Golden Hour"])("soft list: %s", (text) => {
    expect(SOFT_LIST.test(text)).toBe(true);
  });

  test.each(["no retouching", "No airbrushing", "no beauty filter", "no bokeh", "no blur", "not retouched", "without retouching", "without any filters", "no soft-focus"])("negated look term: %s", (text) => {
    expect(firstHit(text, NEGATED_LOOK)).not.toBeNull();
  });

  test.each(["No other people in the photo; no text, logos, brand names or watermark.", "a little motion blur on her moving hand", "slight noise in the shadows", "mild JPEG compression"])(
    "text that is allowed does not fire: %s",
    (text) => {
      expect(firstHit(text, [...NEGATED_LOOK, ...STAGING, ...HELD_PHONE])).toBeNull();
      expect(SOFT_LIST.test(text)).toBe(false);
    },
  );
});
