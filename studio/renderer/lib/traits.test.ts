import { expect, test } from "bun:test";
import { AdultAge, AvatarTraits } from "../../shared/engine";
import { plural, waitLabel, yearsOld } from "./format";
import {
  BUILDS,
  DEFAULT_TRAITS,
  ETHNICITIES,
  EYE_COLORS,
  HAIR_COLORS,
  HAIR_LENGTHS,
  HAIR_TEXTURES,
  MARKS,
  RANDOM_VIBES,
  randomTraits,
  MAX_AGE,
  MIN_AGE,
  SKIN_TONES,
  TRAIT_ENUMS,
  traitsProblem,
  VIBE_MAX,
} from "./traits";
import { vibeIssues } from "./vibe";

/** A small deterministic generator (LCG) so the random-traits test is repeatable. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("every choice list covers its contract enum exactly", () => {
  const values = (list: readonly { value: string }[]): string[] => list.map((c) => c.value).sort();
  expect(values(ETHNICITIES)).toEqual([...TRAIT_ENUMS.ethnicity].sort());
  expect(values(SKIN_TONES)).toEqual([...TRAIT_ENUMS.skinTone].sort());
  expect(values(HAIR_COLORS)).toEqual([...TRAIT_ENUMS.hairColor].sort());
  expect(values(HAIR_LENGTHS)).toEqual([...TRAIT_ENUMS.hairLength].sort());
  expect(values(HAIR_TEXTURES)).toEqual([...TRAIT_ENUMS.hairTexture].sort());
  expect(values(EYE_COLORS)).toEqual([...TRAIT_ENUMS.eyeColor].sort());
  expect(values(BUILDS)).toEqual([...TRAIT_ENUMS.build].sort());
  expect(values(MARKS)).toEqual([...TRAIT_ENUMS.marks].sort());
});

test("the default traits pass the contract", () => {
  expect(AvatarTraits.safeParse(DEFAULT_TRAITS).success).toBe(true);
});

test("«Случайно» always produces traits the contract accepts", () => {
  const rng = seeded(42);
  const ages = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const traits = randomTraits(rng);
    ages.add(traits.age);
    expect(AvatarTraits.safeParse(traits).success).toBe(true);
    expect(vibeIssues(traits.vibe, traits.age)).toEqual([]);
  }
  // Both ends of the slider are reachable.
  expect(ages.has(21)).toBe(true);
  expect(ages.has(35)).toBe(true);
});

test("a generator returning the edge values still stays in range", () => {
  expect(AvatarTraits.safeParse(randomTraits(() => 0)).success).toBe(true);
  expect(AvatarTraits.safeParse(randomTraits(() => 0.999_999_9)).success).toBe(true);
});

test("every random vibe is fine at every age", () => {
  for (const vibe of RANDOM_VIBES) {
    for (let age = 21; age <= 35; age++) expect(vibeIssues(vibe, age)).toEqual([]);
  }
});

test("Russian plurals", () => {
  const forms = ["аватар", "аватара", "аватаров"] as const;
  expect(plural(1, forms)).toBe("аватар");
  expect(plural(2, forms)).toBe("аватара");
  expect(plural(5, forms)).toBe("аватаров");
  expect(plural(11, forms)).toBe("аватаров");
  expect(plural(12, forms)).toBe("аватаров");
  expect(plural(21, forms)).toBe("аватар");
  expect(plural(22, forms)).toBe("аватара");
  expect(plural(0, forms)).toBe("аватаров");
  expect(yearsOld(21)).toBe("21 год");
  expect(yearsOld(23)).toBe("23 года");
  expect(yearsOld(25)).toBe("25 лет");
});

test("waits read as minutes and seconds, rounded up", () => {
  expect(waitLabel(95_000)).toBe("1 мин 35 с");
  expect(waitLabel(120_000)).toBe("2 мин");
  expect(waitLabel(40_001)).toBe("41 с");
  expect(waitLabel(0)).toBe("0 с");
});

test("the form's limits come from the contract", () => {
  expect(MIN_AGE).toBe(AdultAge.minValue ?? Number.NaN);
  expect(MAX_AGE).toBe(AdultAge.maxValue ?? Number.NaN);
  expect(VIBE_MAX).toBe(AvatarTraits.shape.vibe.maxLength ?? Number.NaN);
});

test("an invalid look names the field that fails", () => {
  expect(traitsProblem(DEFAULT_TRAITS)).toBeNull();
  expect(traitsProblem({ ...DEFAULT_TRAITS, vibe: "teen" })).toBe("Исправьте поле «Вайб».");
  expect(traitsProblem({ ...DEFAULT_TRAITS, age: 19 })).toBe("Исправьте поле «Возраст».");
});
