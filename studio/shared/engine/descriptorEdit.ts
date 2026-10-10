import { adultTextProblems, DESCRIPTOR_MAX_CHARS, youthWords, type AdultTextProblem } from "./ageText";
import { AvatarDescriptor } from "./avatar";
import type { DescriptorReason } from "./errors";

// The owner's hand-typed descriptor (`avatars.editDescriptor`), judged before it is stored. The engine and the renderer's mock share this one function, so
// both answer a text with the same closed reason (the parity rig plays the refusals against both).

/** Letters NFD cannot split into a base letter and a mark. */
const SPELLED_OUT: Record<string, string> = { ß: "ss", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ø: "o", Ø: "O", ł: "l", Ł: "L", đ: "d", Đ: "D" };

/**
 * Typography folded before validation, so a paid answer is not dropped for it:
 * NFKC (fullwidth digits), invisible format characters dropped — U+FEFF too,
 * although JS counts it as whitespace — so a word they split is seen whole by
 * the checks, control characters that are whitespace (tab, newline) to a
 * space and the rest dropped, every dash to "-", curly quotes to straight
 * ones, accents stripped ("café" → "cafe"), whitespace collapsed.
 */
export function normaliseDescriptorText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, (ch) => (/\s/.test(ch) ? " " : ""))
    .replace(/[\p{Pd}−]/gu, "-")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .replace(/[ßæÆœŒøØłŁđĐ]/g, (ch) => SPELLED_OUT[ch] ?? ch)
    .replace(/\s+/g, " ")
    .trim();
}

export type DescriptorEditCheck =
  | { ok: true; text: string }
  /** `words` are the owner's own offending words, only with `youth-word`. */
  | { ok: false; reason: DescriptorReason; words: string[] };

/** Invisible or control characters, except the whitespace a textarea produces (tab, newline), which the normaliser folds to a space. */
const HIDDEN = /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|(?![\t\n\r])\p{Cc}/u;

const PROBLEM_REASON: Record<AdultTextProblem, DescriptorReason> = {
  script: "script",
  "non-ascii-digits": "non-ascii-digits",
  "other-age": "other-age",
  "under-21-bound": "under-21-bound",
  "youth-word": "youth-word",
  number: "number",
  "too-long": "too-long",
};

function refused(reason: DescriptorReason, words: string[] = []): DescriptorEditCheck {
  return { ok: false, reason, words };
}

/**
 * The first rule the text breaks, in the order the owner can fix them: invisible characters, blank, too long, the age anchor (it may stand anywhere), then the
 * `AdultTextProblem`s in the order `adultTextProblems` lists them (a foreign digit before the script rule it also breaks). The text it accepts is the normalised one, and it passes `AvatarDescriptor` for `age`.
 */
export function checkDescriptorEdit(text: string, age: number): DescriptorEditCheck {
  if (HIDDEN.test(text)) return refused("hidden-chars");
  const normalised = normaliseDescriptorText(text);
  if (normalised === "") return refused("empty");
  if (normalised.length > DESCRIPTOR_MAX_CHARS) return refused("too-long");
  if (!new RegExp(`(?<![0-9])${age}-year-old`).test(normalised)) return refused("no-anchor");
  const problems = adultTextProblems(normalised, age, "descriptor");
  // A foreign digit also breaks the script rule; «only 0-9» is the more useful advice, so it goes first (and is reachable at all).
  const first = problems.includes("non-ascii-digits") ? "non-ascii-digits" : problems[0];
  if (first !== undefined) return refused(PROBLEM_REASON[first], first === "youth-word" ? youthWords(normalised, "descriptor") : []);
  // The contract has the last word: a rule it adds later refuses the text here too.
  return AvatarDescriptor.safeParse({ age, text: normalised }).success ? { ok: true, text: normalised } : refused("invalid");
}
