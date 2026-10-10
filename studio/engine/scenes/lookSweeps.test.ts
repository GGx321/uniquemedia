import { describe, expect, test } from "bun:test";
import { POOL_TIMES, youthWords } from "../../shared/engine";
import type { AvatarDescriptor } from "../../shared/engine";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleSlot } from "./assembler";
import { plan, planWithPools } from "./planner";
import { isPhoneActivity, POOLS, type Activity, type Place, type Pool } from "./pools";
import { redrawSlot } from "./redraw";
import { roomPlaceOf } from "./roomPlace";
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

interface Swept {
  label: string;
  slot: PlanSlot;
  realism: boolean;
  sentence: string;
  /** The prompt without the writer's sentence and the descriptor: the text that is ours. */
  look: string;
  prompt: string;
}

function assembleAll(slots: readonly PlanSlot[], runId: string, rooms: boolean): Swept[] {
  const out: Swept[] = [];
  for (const base of slots) {
    const time = TIMES[base.slotIndex % TIMES.length] as string;
    for (const slot of [base, { ...base, timeOfDay: time }]) {
      if (!PlanSlotSchema.safeParse(slot).success) continue;
      const sentence = sentenceOf(slot);
      for (const realism of [true, false]) {
        const prompt = assembleSlot(DESCRIPTOR, slot, sentence, MASTER, { runId, cameraRealism: realism, ...(rooms ? { roomPlaceOf } : {}) }).prompt;
        if (!prompt.includes(sentence)) throw new Error(`the sentence is not in the prompt: ${sentence}`);
        out.push({ label: `${runId}/${slot.slotIndex}/${slot.category}/${slot.shot}/${slot.pose}/${slot.timeOfDay}/${realism ? "on" : "off"}`, slot, realism, sentence, look: prompt.replace(sentence, "").replace(DESCRIPTOR.text.replace(/\.$/, ""), ""), prompt });
      }
    }
  }
  return out;
}

// The sweep set, built once: 25 seeded built-in plans (20 slots, every category, every pose) and 12 seeded plans over the custom categories.
const SWEPT: Swept[] = (() => {
  const all: Swept[] = [];
  for (let seed = 1; seed <= 25; seed++) all.push(...assembleAll(plan({ seed: seed * 7919, count: 20, categories: [...CATEGORIES], poses: ALL_POSES }).slots, `run-${seed}`, true));
  for (let seed = 1; seed <= 12; seed++) {
    const scenes = planWithPools({ seed: seed * 104729, count: 15, categories: [CUSTOM_REF, PHONEFUL_REF, "home"], poses: ALL_POSES }, POOLS_ALL);
    all.push(...assembleAll(scenes.slots, `run-c${seed}`, true));
  }
  return all;
})();

// The redraw sweep: «Другая сцена» on selfie and mirror slots, then assembled like any other (N1).
const REDRAWN: Swept[] = (() => {
  const NONE = { profile: false, back: false };
  const avoid = { locations: new Set<string>(), outfits: new Set<string>() };
  const all: Swept[] = [];
  const cases: Array<[string, Pool]> = [...CATEGORIES.map((c): [string, Pool] => [c, POOLS[c]]), [PHONEFUL_REF, PHONEFUL], [CUSTOM_REF, SWEEP_CUSTOM_POOL]];
  for (const [category, pool] of cases) {
    for (const shot of ["selfie", "mirror"] as const) {
      const place = pool.locations[0] as Place;
      const slot = PlanSlotSchema.parse({ slotIndex: 1, category, location: place.name, timeOfDay: "morning", activity: "x", outfit: pool.outfits[0], shot, pose: "front", attemptIdBase: "slot-1", repeatedPair: false });
      for (let seed = 1; seed <= 25; seed++) {
        const out = redrawSlot({ seed: seed * 7919, k: 1 + (seed % 5), slot, pool, avoid, poses: NONE });
        all.push(...assembleAll([out], `run-r${category}-${shot}-${seed}`, true));
      }
    }
  }
  return all;
})();

const EVERYTHING = [...SWEPT, ...REDRAWN];
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

describe("I5.2: only the mirror shows a phone", () => {
  // The look text may say «phone» only as the kind of photo, in the selfie line's «the phone itself is not in the picture», in the selfie phone-hand line
  // and, for the mirror, in the mirror line and its phone-hand line. The sentence is not part of the look text.
  const KIND_OF_PHOTO = /Ordinary phone photo|A quick phone snap|her phone's front camera/g;
  const SELFIE_ONLY = /the phone itself is not in the picture|Her phone arm runs out of the frame/g;
  const MIRROR_ONLY = /her phone in her hand at chest height|One hand holds the phone/g;

  test("no non-mirror look text matches a held-phone pattern", () => {
    expect(hits((s) => (s.slot.shot === "mirror" ? null : firstHit(s.look, HELD_PHONE)))).toEqual([]);
  });

  test("no look text names a phone beyond the places each author's lines allow", () => {
    expect(
      hits((s) => {
        const allowed = s.slot.shot === "selfie" ? SELFIE_ONLY : s.slot.shot === "mirror" ? MIRROR_ONLY : /(?!)/g;
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

  test("the selfie author's phone-hand line and the mirror's are the only ones, and every prompt ends with its own", () => {
    expect(hits((s) => (s.slot.shot === "mirror" && !s.prompt.endsWith("One hand holds the phone; only her other hand acts.") ? "mirror" : null))).toEqual([]);
    expect(hits((s) => (s.slot.shot === "selfie" && !s.prompt.endsWith("Her phone arm runs out of the frame; only her other hand acts.") ? "selfie" : null))).toEqual([]);
    expect(hits((s) => (s.slot.shot !== "selfie" && s.slot.shot !== "mirror" && /only her other hand acts/.test(s.prompt) ? "other" : null))).toEqual([]);
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
    expect(hits((s) => SOFT_LIST.exec(s.prompt)?.[0] ?? null)).toEqual([]);
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

  test("the look text carries no youth word and no revealing word", () => {
    expect(hits((s) => youthWords(s.look, "descriptor")[0] ?? revealingWordsIn(s.look)[0] ?? null)).toEqual([]);
  });

  test("the artefact line is positive in both switch states: the sharp background is there, «Реализм камеры» adds the camera-roll artefacts", () => {
    expect(hits((s) => (s.look.includes("the background as sharp as she is") ? null : "no sharp background"))).toEqual([]);
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
