import { z } from "zod";
import { adultTextProblems, DESCRIPTOR_MAX_CHARS } from "./ageText";
import { AvatarBody, BODY_PHRASE_MAX } from "./body";

/** Avatar age: an integer 21-35. The lower bound is invariant 8 (every avatar is 21+). */
export const AdultAge = z.number().int().min(21).max(35);

/**
 * No control chars, no invisible format chars (bidi overrides, zero-width,
 * BOM), no lone surrogates (they encode as U+FFFD), and no line or paragraph
 * separators (U+2028/2029 break a prompt line).
 */
export const NO_HIDDEN_CHARS = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]*$/u;

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
    // Stage 5, S5.2a: the eight optional body traits. The same schemas as `AvatarBody`'s, spread, so the two can never drift. The descriptor LLM never receives them.
    ...AvatarBody.shape,
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
    /**
     * Stage 5, S5.2a: the body phrase `bodyPhrase` renders from her body traits. It is never stored in the descriptor text: the engine adds it for a prompt
     * (`promptDescriptorOf`) and `promptSubject` appends it after «; ». Absent for an avatar with no body.
     */
    body: z.string().min(1).max(BODY_PHRASE_MAX).regex(NO_HIDDEN_CHARS, "must not contain control or invisible characters").optional(),
  })
  .refine((d) => hasAgeAnchor(d.text, d.age), {
    message: "text must state the avatar's age as '<age>-year-old'",
    path: ["text"],
  })
  .refine((d) => adultTextProblems(d.text, d.age, "descriptor").length === 0, {
    message: ADULT_TEXT_MESSAGE,
    path: ["text"],
  })
  .refine((d) => d.body === undefined || adultTextProblems(d.body, d.age, "descriptor").length === 0, {
    message: ADULT_TEXT_MESSAGE,
    path: ["body"],
  })
  .refine((d) => composedLength(d.text, d.body) <= DESCRIPTOR_MAX_CHARS, {
    message: `the text and the body phrase together must not exceed ${DESCRIPTOR_MAX_CHARS} characters`,
    path: ["body"],
  });

/** The length of the descriptor as a prompt carries it: the text, then «; » and the body phrase when there is one. */
export function composedLength(text: string, body?: string): number {
  return body === undefined ? text.length : text.length + 2 + body.length;
}

// ---------- Stage 5, S5.0c: the descriptor-vs-master check ----------

/** What a check compares with the master photo: the hair (colour, length, texture, bangs), the eyes, the face marks, and (when the photo shows it) the body. */
export const CHECK_ASPECTS = ["hair", "eyes", "marks", "body"] as const;
export const CheckAspect = z.enum(CHECK_ASPECTS);
/** `ok`: the description matches the photo; `mismatch`: it contradicts it; `not-visible`: the photo does not show this (grey in the window, not an error). */
export const CheckState = z.enum(["ok", "mismatch", "not-visible"]);

/** The short Russian phrases of a mismatch («В описании: … · На фото: …») are model output: bounded and plain text. */
export const CHECK_PHRASE_MAX_CHARS = 40;
const CheckPhrase = z.string().min(1).max(CHECK_PHRASE_MAX_CHARS).regex(NO_HIDDEN_CHARS, "must not contain control or invisible characters");

export const AspectVerdict = z.strictObject({ state: CheckState, descriptor: CheckPhrase.optional(), photo: CheckPhrase.optional() });

/**
 * One check of a saved avatar's descriptor against her master photo. It never writes: `proposal` is the corrected text a mismatch of hair, eyes or marks suggests,
 * or null (no such mismatch, a text that breaks a rule, one that adds a word about the body, or one equal to the stored text). The owner applies it, if he wants it,
 * with `avatars.editDescriptor`, passing `checkedText` as `expectedText` so a proposal made against an older text is refused as stale. A `body` mismatch never has a
 * proposal: it goes to the body traits.
 */
export const DescriptorCheck = z
  .strictObject({
    matches: z.boolean(),
    aspects: z.strictObject({
      hair: AspectVerdict.optional(),
      eyes: AspectVerdict.optional(),
      marks: AspectVerdict.optional(),
      body: AspectVerdict.optional(),
    }),
    proposal: z.string().min(1).max(DESCRIPTOR_MAX_CHARS).regex(NO_HIDDEN_CHARS, "must not contain control or invisible characters").nullable(),
    /** The stored descriptor text this check judged. */
    checkedText: z.string().min(1).max(DESCRIPTOR_MAX_CHARS).regex(NO_HIDDEN_CHARS, "must not contain control or invisible characters"),
  })
  .refine((c) => c.matches === !Object.values(c.aspects).some((a) => a?.state === "mismatch"), { message: "matches must say whether no aspect is a mismatch", path: ["matches"] })
  .refine((c) => c.proposal === null || [c.aspects.hair, c.aspects.eyes, c.aspects.marks].some((a) => a?.state === "mismatch"), {
    message: "a proposal needs a mismatch of the hair, the eyes or the marks (a body mismatch has none)",
    path: ["proposal"],
  });

/** Lifecycle of an avatar in the library: a draft until a candidate is picked. */
export const AvatarStatus = z.enum(["draft", "active", "archived"]);

export type AvatarTraits = z.infer<typeof AvatarTraits>;
export type AvatarDescriptor = z.infer<typeof AvatarDescriptor>;
export type AvatarStatus = z.infer<typeof AvatarStatus>;
export type CheckAspect = z.infer<typeof CheckAspect>;
export type CheckState = z.infer<typeof CheckState>;
export type AspectVerdict = z.infer<typeof AspectVerdict>;
export type DescriptorCheck = z.infer<typeof DescriptorCheck>;
