import {
  AdultAge,
  AvatarTraits,
  Build,
  EyeColor,
  Ethnicity,
  HairColor,
  HairLength,
  HairTexture,
  Mark,
  SkinTone,
} from "../../shared/engine";

export type Traits = AvatarTraits;
type Ethnicity = Traits["ethnicity"];
type SkinTone = Traits["skinTone"];
type HairColor = Traits["hairColor"];
type HairLength = Traits["hairLength"];
type HairTexture = Traits["hairTexture"];
type EyeColor = Traits["eyeColor"];
type Build = Traits["build"];
type Mark = Traits["marks"][number];

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** A swatch colour for skin and hair pickers (display only). */
  color?: string;
}

// Russian labels for the fixed choices of the contract, in the mockup's order.
// Each list is checked against its enum in the tests, so a new enum value
// cannot silently go missing from the form.

export const ETHNICITIES: readonly Choice<Ethnicity>[] = [
  { value: "european", label: "Европейский" },
  { value: "latina", label: "Латино" },
  { value: "asian", label: "Азиатский" },
  { value: "african", label: "Африканский" },
  { value: "mixed", label: "Смешанный" },
];

export const SKIN_TONES: readonly Choice<SkinTone>[] = [
  { value: "very-light", label: "Очень светлая", color: "#f3dcc8" },
  { value: "light", label: "Светлая", color: "#e8c3a0" },
  { value: "light-olive", label: "Светлая оливковая", color: "#d4a37c" },
  { value: "tan", label: "Смуглая", color: "#b27b55" },
  { value: "dark", label: "Тёмная", color: "#8a5a3b" },
  { value: "very-dark", label: "Очень тёмная", color: "#5e3b27" },
];

export const HAIR_COLORS: readonly Choice<HairColor>[] = [
  { value: "black", label: "Чёрные", color: "#1d1512" },
  { value: "dark-brown", label: "Тёмно-каштановые", color: "#4a2e1f" },
  { value: "chestnut", label: "Каштановые", color: "#7a4a2c" },
  { value: "light-brown", label: "Русые", color: "#a8743f" },
  { value: "blonde", label: "Блонд", color: "#d9b77a" },
  { value: "red", label: "Рыжие", color: "#b8452e" },
];

export const HAIR_LENGTHS: readonly Choice<HairLength>[] = [
  { value: "bob", label: "Каре" },
  { value: "shoulder", label: "До плеч" },
  { value: "long", label: "Длинные" },
];

export const HAIR_TEXTURES: readonly Choice<HairTexture>[] = [
  { value: "straight", label: "Прямые" },
  { value: "wavy", label: "Волнистые" },
  { value: "curly", label: "Кудри" },
];

export const EYE_COLORS: readonly Choice<EyeColor>[] = [
  { value: "brown", label: "Карие" },
  { value: "hazel", label: "Ореховые" },
  { value: "green", label: "Зелёные" },
  { value: "blue", label: "Голубые" },
  { value: "grey", label: "Серые" },
];

export const BUILDS: readonly Choice<Build>[] = [
  { value: "slim", label: "Стройное" },
  { value: "athletic", label: "Спортивное" },
  { value: "soft", label: "Мягкие формы" },
  { value: "curvy", label: "Фигуристое" },
];

export const MARKS: readonly Choice<Mark>[] = [
  { value: "freckles", label: "Веснушки" },
  { value: "mole", label: "Родинка" },
  { value: "dimples", label: "Ямочки" },
  { value: "nose-piercing", label: "Пирсинг в носу" },
  { value: "wrist-tattoo", label: "Тату на запястье" },
];

/** A limit read from a T0 schema (`minValue`, `maxLength`, …); throws if the schema lost it. */
export function bound(value: number | null | undefined, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`the contract has no ${what}`);
  return value;
}

// The form's limits are read from the T0 schemas, so they cannot drift from what the engine accepts.
export const MIN_AGE = bound(AdultAge.minValue, "minimum age");
export const MAX_AGE = bound(AdultAge.maxValue, "maximum age");
export const VIBE_MAX = bound(AvatarTraits.shape.vibe.maxLength, "vibe length limit");

export const DEFAULT_TRAITS: Traits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "girl next door, coffee, travel, books",
};

/** Vibes for «Случайно»: ordinary adult interests, each checked against the age rules in the tests. */
export const RANDOM_VIBES: readonly string[] = [
  "girl next door, coffee, travel, books",
  "city minimalist, matcha, gallery weekends",
  "outdoorsy, hiking, film cameras",
  "beach mornings, surfing, sunscreen",
  "cozy homebody, vinyl records, baking",
  "runner, early mornings, smoothie bowls",
  "fashion lover, vintage markets, espresso",
  "yoga, plants, slow Sundays",
  "bookworm, rainy days, jazz bars",
  "foodie, street markets, road trips",
];

function pick<T>(items: readonly T[], rng: () => number): T {
  const item = items[Math.floor(rng() * items.length) % items.length];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

/** Valid random traits: every field from its fixed choices, 0–2 marks, a vetted vibe. */
export function randomTraits(rng: () => number = Math.random): Traits {
  const marks = MARKS.map((m) => m.value).filter(() => rng() < 0.3).slice(0, 2);
  return {
    age: MIN_AGE + (Math.floor(rng() * (MAX_AGE - MIN_AGE + 1)) % (MAX_AGE - MIN_AGE + 1)),
    ethnicity: pick(ETHNICITIES, rng).value,
    skinTone: pick(SKIN_TONES, rng).value,
    hairColor: pick(HAIR_COLORS, rng).value,
    hairLength: pick(HAIR_LENGTHS, rng).value,
    hairTexture: pick(HAIR_TEXTURES, rng).value,
    eyeColor: pick(EYE_COLORS, rng).value,
    build: pick(BUILDS, rng).value,
    marks,
    vibe: pick(RANDOM_VIBES, rng),
  };
}

export function isValidTraits(traits: Traits): boolean {
  return AvatarTraits.safeParse(traits).success;
}

const FIELD_LABELS: Record<keyof Traits, string> = {
  age: "Возраст",
  ethnicity: "Типаж",
  skinTone: "Кожа",
  hairColor: "Цвет волос",
  hairLength: "Длина волос",
  hairTexture: "Текстура волос",
  eyeColor: "Глаза",
  build: "Телосложение",
  marks: "Приметы",
  vibe: "Вайб",
};

function isTraitKey(key: unknown): key is keyof Traits {
  return typeof key === "string" && Object.hasOwn(FIELD_LABELS, key);
}

/** Why the contract refuses these traits, naming the first failing field; null when they are valid. */
export function traitsProblem(traits: Traits): string | null {
  const parsed = AvatarTraits.safeParse(traits);
  if (parsed.success) return null;
  const key = parsed.error.issues[0]?.path[0];
  return isTraitKey(key) ? `Исправьте поле «${FIELD_LABELS[key]}».` : "Проверьте внешность: она не проходит проверку.";
}

/** The enums the choice lists must cover, for the coverage test. */
export const TRAIT_ENUMS = {
  ethnicity: Ethnicity.options,
  skinTone: SkinTone.options,
  hairColor: HairColor.options,
  hairLength: HairLength.options,
  hairTexture: HairTexture.options,
  eyeColor: EyeColor.options,
  build: Build.options,
  marks: Mark.options,
};
