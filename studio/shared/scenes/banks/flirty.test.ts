import { describe, expect, test } from "bun:test";
import { BANKS, CUES, GAZE } from "./index";
import { BANK_CATEGORIES } from "./types";

// 5a.2b (S5.7b, plan s5a2 §6.2): the flirty items. «Дом»: a prone frame with her feet up (on her bed only) and a knees-hugged timer frame; «Гламур»: chin on her
// hand at the bar. No tier 2 (no lingerie, no «Смелая»), and no cue says sexy, seductive or sultry.

const flirtyMoments = BANK_CATEGORIES.flatMap((category) =>
  BANKS[category].places.flatMap((place) => place.moments.filter((m) => m.level === "flirty").map((moment) => ({ category, place, moment }))),
);

describe("the flirty moments", () => {
  test("«Дом» holds exactly two and «Гламур» one; no other category holds any", () => {
    const by = (category: string): number => flirtyMoments.filter((f) => f.category === category).length;
    expect([by("home"), by("glamour"), by("travel"), by("photoshoot"), by("fitness")]).toEqual([2, 1, 0, 0, 0]);
  });

  test("her feet up is a prone frame on her bed, in the prone selfie's outfits, with no legwear and the feet motion", () => {
    const found = flirtyMoments.find((f) => f.moment.text === "lies on her stomach, feet up");
    expect(found?.place.name).toBe("her bed");
    expect(found?.moment.captures).toEqual(["prone"]);
    expect(found?.moment.motion).toBe("her raised feet swing slowly behind her");
    expect(found?.moment.noLegwear).toBe(true);
    expect(found?.moment.outfits).toEqual(["grey jersey lounge shorts and a tee", "grey leggings and a cropped tee"]);
  });

  test("hugging her knees is a timer frame on her bed, with both hands busy", () => {
    const found = flirtyMoments.find((f) => f.moment.text === "sits hugging her knees" && f.moment.level === "flirty");
    expect(found?.place.name).toBe("her bed");
    expect(found?.moment.captures).toEqual(["timer"]);
    expect(found?.moment.twoHanded).toBe(true);
    expect(found?.moment.motion).toBe("she rocks a little and smiles");
  });

  test("chin on her hand is at the bar, a friend's or an arm's-length photo, with the hand at her face", () => {
    const found = flirtyMoments.find((f) => f.category === "glamour");
    expect(found?.place.name).toBe("a cocktail bar");
    expect(found?.moment.text).toBe("leans in, chin on her hand");
    expect(found?.moment.captures).toEqual(["friend", "selfie"]);
    expect(found?.moment.handAtFace).toBe(true);
    expect(found?.moment.motion).toBe("she tilts her head slowly");
  });

  test("«Гламур» never lies on a bed", () => {
    const text = BANKS.glamour.places.flatMap((p) => [p.name, p.at, ...p.moments.map((m) => m.text)]).join(" ");
    expect(text).not.toMatch(/\bbed\b/);
  });
});

describe("the flirty gaze and cues", () => {
  test("none says sexy, seductive or sultry", () => {
    const texts = [...GAZE, ...CUES].filter((item) => item.level === "flirty").map((item) => item.text);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).not.toMatch(/sexy|seductive|sultry/i);
  });

  test("no flirty moment says it either", () => {
    for (const { moment } of flirtyMoments) expect(`${moment.text} ${moment.motion}`).not.toMatch(/sexy|seductive|sultry/i);
  });
});
