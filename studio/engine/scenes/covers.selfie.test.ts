import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CUES, GAZE } from "../../shared/scenes/banks";
import { CAPTURES, shotOf, type Capture } from "../../shared/scenes/captures";
import { covers, customSentence, type CustomPool } from "../../shared/scenes/custom";
import { gazeKindsFor } from "../../shared/scenes/render";
import { PHONE_WORDS, SELFIE_WORDS } from "../../shared/scenes/words";
import { LLM_ONLY_POOL } from "./testing/llmOnlyFixture";
useNativeGlobals();

// 5a.2 (S5.6d, the open question left by the S5.6c2 money review): `covers(pool)` renders every combination of a custom pool with the ONE key "covers", while the
// refusal of a self-shot sentence that names a phone (render.ts `renderSentence`, C1) is decided on the sentence a slot's own key draws. If that draw could differ
// by key, a covered category (writer budget 0, no reserve) could still emit a null slot at run time.
//
// It cannot, and these tests pin why. The draw is made of the slot's stored texts (the place, the activity, the outfit: the same for every key) and the gaze and
// the cue the key picks. For a self-shot capture neither the gaze nor the cue can name a phone or say «selfie»: the only gaze that names the phone is the mirror's,
// and a mirror shot is the one capture the refusal does not apply to. So the refusal turns on the stored texts alone, which `covers` sees whole.

const SELF_SHOT_CAPTURES: readonly Capture[] = CAPTURES.filter((capture) => shotOf(capture) === "selfie");
const POSES = ["front", "three-quarter", "profile", "back"] as const;
const MOMENT_GAZES = [undefined, "own", "viewer", "focus"] as const;
const words = (text: string): boolean => PHONE_WORDS.test(text) || SELFIE_WORDS.test(text);

describe("a self-shot capture's gaze and cue never name a phone or say selfie", () => {
  test("there are self-shot captures to look at: the selfie, from above, prone, over the shoulder and the legs POV", () => {
    expect([...SELF_SHOT_CAPTURES].sort()).toEqual(["above", "over-shoulder", "pov-legs", "prone", "selfie"]);
  });

  test("every gaze a self-shot capture can draw, in every pose and for every moment gaze tag, is clean", () => {
    for (const capture of SELF_SHOT_CAPTURES)
      for (const pose of POSES)
        for (const gaze of MOMENT_GAZES) {
          const kinds = gazeKindsFor(capture, pose, gaze);
          for (const option of GAZE.filter((g) => kinds.includes(g.kind))) expect({ capture, pose, text: option.text, named: words(option.text) }).toEqual({ capture, pose, text: option.text, named: false });
        }
  });

  test("every cue a self-shot capture can draw, at either level, is clean", () => {
    for (const capture of SELF_SHOT_CAPTURES)
      for (const cue of CUES.filter((c) => c.captures === undefined || c.captures.includes(capture))) expect({ capture, level: cue.level ?? "ordinary", text: cue.text, named: words(cue.text) }).toEqual({ capture, level: cue.level ?? "ordinary", text: cue.text, named: false });
  });

  test("the control: the mirror's own gaze does name her phone (so the check above is not vacuous), and a mirror shot is not held to the refusal", () => {
    const naming = GAZE.filter((g) => words(g.text));
    expect(naming.map((g) => g.kind)).toEqual(["mirror"]);
    expect(SELF_SHOT_CAPTURES.every((capture) => !gazeKindsFor(capture, "front").includes("mirror"))).toBe(true);
  });
});

describe("a covered custom category with selfies never emits a null slot, whatever the key", () => {
  const COVERED: CustomPool = {
    locations: [
      { name: "a quiet bookshop", activities: [{ text: "holding a mug", twoHanded: false }, { text: "browsing the shelves", twoHanded: false }, { text: "on her stomach, reading", twoHanded: false }] },
      { name: "a cafe terrace", activities: [{ text: "stirring her coffee", twoHanded: false }, { text: "laughing with a friend", twoHanded: false }] },
    ],
    outfits: ["a cozy cardigan and jeans", "a linen dress"],
    shotDeck: ["selfie", "selfie", "friend", "candid", "friend"],
  };
  const KEYS = Array.from({ length: 200 }, (_, i) => `run-0000000${i % 10}:slot-${i}`);
  const REF = "cat-coveredselfies";

  test("the pool is covered, and has selfies in its deck", () => {
    expect(covers(COVERED)).toBe(true);
    expect(COVERED.shotDeck).toContain("selfie");
  });

  // A custom category's capture is derived from its stored shot (a selfie in the deck is the `selfie` capture): the other self-shot captures are the built-in
  // «Дом» deck's, which its own banks cover.
  test("every combination the pool can draw on its selfie capture renders under 200 different keys", () => {
    const nulls: string[] = [];
    for (const capture of ["selfie"] as const)
      for (const pose of ["front", "three-quarter"] as const)
        for (const place of COVERED.locations)
          for (const activity of place.activities)
            for (const outfit of COVERED.outfits)
              for (const key of KEYS) {
                const text = customSentence({ category: REF, location: place.name, activity: activity.text, outfit, shot: "selfie", capture, pose }, { key, snapshots: [{ ref: REF }] });
                if (text === null) nulls.push(`${capture}/${pose}/${place.name}/${activity.text}/${outfit}/${key}`);
              }
    expect(nulls).toEqual([]);
  });

  test("when a stored text does name a phone, the slot is null under EVERY key, and `covers` already says the category is not covered", () => {
    const withPhone: CustomPool = { ...COVERED, outfits: ["a phone-print hoodie"] };
    expect(covers(withPhone)).toBe(false);
    const place = withPhone.locations[0];
    if (place === undefined) throw new Error("no place");
    const results = KEYS.map((key) => customSentence({ category: REF, location: place.name, activity: "holding a mug", outfit: "a phone-print hoodie", shot: "selfie", capture: "selfie", pose: "front" }, { key, snapshots: [{ ref: REF }] }));
    expect(results.every((text) => text === null)).toBe(true);
  });

  test("the fixture the money tests use, which the template cannot write, is not covered", () => {
    expect(covers(LLM_ONLY_POOL as unknown as CustomPool)).toBe(false);
  });
});
