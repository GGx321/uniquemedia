import { z } from "zod";
import { adultTextProblems, DESCRIPTOR_MAX_CHARS } from "./ageText";

/** Avatar age: an integer 21-35. The lower bound is invariant 8 (every avatar is 21+). */
export const AdultAge = z.number().int().min(21).max(35);

/**
 * No control chars, no invisible format chars (bidi overrides, zero-width,
 * BOM), no lone surrogates (they encode as U+FFFD), and no line or paragraph
 * separators (U+2028/2029 break a prompt line).
 */
const NO_HIDDEN_CHARS = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]*$/u;

/** Display name; never sent in prompts. */
export const AvatarName = z
  .string()
  .max(60)
  .regex(NO_HIDDEN_CHARS, "must not contain control or invisible characters")
  .refine((s) => s.trim().length > 0, "must not be blank");

// Fixed choices from the "New avatar" mockup (Studio design canvas, AvatarNew).
export const Ethnicity = z.enum(["european", "latina", "asian", "african", "mixed"]);
export const SkinTone = z.enum(["very-light", "light", "light-olive", "tan", "dark", "very-dark"]);
export const HairColor = z.enum(["black", "dark-brown", "chestnut", "light-brown", "blonde", "red"]);
export const HairLength = z.enum(["bob", "shoulder", "long"]);
export const HairTexture = z.enum(["straight", "wavy", "curly"]);
export const EyeColor = z.enum(["brown", "hazel", "green", "blue", "grey"]);
export const Build = z.enum(["slim", "athletic", "soft", "curvy"]);
export const Mark = z.enum(["freckles", "mole", "dimples", "nose-piercing", "wrist-tattoo"]);

const ADULT_TEXT_MESSAGE =
  "must state no other age, no under-21 bound, no non-ASCII digits and no youth words";

/**
 * What the user picks in the wizard; the engine turns it into a descriptor.
 * The vibe only feeds the descriptor LLM, whose output is checked strictly,
 * so here only hard markers of a minor are refused: another age, an under-21
 * bound, non-ASCII digits, and words like "teen" or "school uniform". Ordinary
 * phrases such as "girl next door" pass (invariant 8).
 */
export const AvatarTraits = z
  .strictObject({
    age: AdultAge,
    ethnicity: Ethnicity,
    skinTone: SkinTone,
    hairColor: HairColor,
    hairLength: HairLength,
    hairTexture: HairTexture,
    eyeColor: EyeColor,
    build: Build,
    marks: z
      .array(Mark)
      .max(Mark.options.length)
      .refine((marks) => new Set(marks).size === marks.length, "marks must not repeat"),
    vibe: z
      .string()
      .max(200)
      .regex(NO_HIDDEN_CHARS, "must be a single line without control or invisible characters"),
  })
  .refine((t) => adultTextProblems(t.vibe, t.age, "vibe").length === 0, {
    message: ADULT_TEXT_MESSAGE,
    path: ["vibe"],
  });

function hasAgeAnchor(text: string, age: number): boolean {
  return new RegExp(`(?<![0-9])${age}-year-old`).test(text);
}

/**
 * The appearance anchor that goes into every prompt. Its text must state the
 * avatar's own adult age as "<age>-year-old", no other age in any form, no
 * under-21 bound, and no youth words — "girl" included: the engine writes
 * "woman" (invariant 8).
 */
export const AvatarDescriptor = z
  .strictObject({
    age: AdultAge,
    text: z.string().min(1).max(DESCRIPTOR_MAX_CHARS).regex(NO_HIDDEN_CHARS, "must not contain control or invisible characters"),
  })
  .refine((d) => hasAgeAnchor(d.text, d.age), {
    message: "text must state the avatar's age as '<age>-year-old'",
    path: ["text"],
  })
  .refine((d) => adultTextProblems(d.text, d.age, "descriptor").length === 0, {
    message: ADULT_TEXT_MESSAGE,
    path: ["text"],
  });

/** Lifecycle of an avatar in the library: a draft until a candidate is picked. */
export const AvatarStatus = z.enum(["draft", "active", "archived"]);

export type AvatarTraits = z.infer<typeof AvatarTraits>;
export type AvatarDescriptor = z.infer<typeof AvatarDescriptor>;
export type AvatarStatus = z.infer<typeof AvatarStatus>;
