// 5a.3 (S5.9b1, plan s5a3 §5): the content line, one pure function with the level as a parameter. Every site that checks the words of a sentence calls it
// (the assembler's last gate, the owner's edit-time check, the scene-set launch and approval gates, the renderer's mock), so no site keeps a copy of a list.
//
// "ordinary" and "flirty" are today's gate, byte for byte: the youth words (descriptor scope), then the revealing words. "bold" is the owner's «Смелая»:
// youth words only, with the garment name «babydoll» exempt (banks/boldRules.ts); no revealing-word rule, no covering clause, so his own edits may say
// «topless» or «naked». The exposure and explicit-act lists are bank design, swept by tests over the banks; they are never applied to a text here.
// Which level a slot or a scene is at (`contentLevelOf`) needs the «Смелая» category ids and lands with S5.9c; the sites call "ordinary" until then.

import { youthWords } from "../engine/ageText";
import { BOLD_EXEMPT_YOUTH } from "./banks/boldRules";
import { revealingWordsIn } from "./words";

/** Private: nothing outside this module can name the key, so nothing outside it can write a value of `BoldContentLevel`. */
const BOLD_BRAND: unique symbol = Symbol("bold content level");

/** The bold level: one frozen value, made here and nowhere else. A string, a mix level or a widened literal is not one. */
export interface BoldContentLevel {
  readonly kind: "bold";
  readonly [BOLD_BRAND]: true;
}

const BOLD: BoldContentLevel = Object.freeze<BoldContentLevel>({ kind: "bold", [BOLD_BRAND]: true });

/**
 * The level a text is held to. "ordinary" and "flirty" are plain literals; bold is the branded value above, because it drops the revealing-word gate and
 * a mix level (`SceneLevel`, which may say "bold" for the five built-ins) must never reach it by accident. `boldContentLevel()` is called by the two
 * «Смелая» bank schemas (S5.9b2, at load) and S5.9c's `contentLevelOf`: a «Смелая» category is bold whatever its mix level.
 */
export type ContentLevel = "ordinary" | "flirty" | BoldContentLevel;

/** The one way to a bold content level. */
export function boldContentLevel(): BoldContentLevel {
  return BOLD;
}

/** Every level, in the order of the mix (ordinary, flirty, bold). */
export const CONTENT_LEVELS: readonly ContentLevel[] = ["ordinary", "flirty", BOLD];

export interface ContentProblem {
  reason: "youth-word" | "revealing-word";
  words: string[];
}

/** Whether a youth word the rule found is an exempt garment name (or its plural), as the text has it. */
function isExemptGarment(word: string): boolean {
  const lower = word.toLowerCase();
  return BOLD_EXEMPT_YOUTH.some((name) => lower === name || lower === `${name}s`);
}

/**
 * Every rule a text breaks at `level`, the youth words first. Empty when the text is fine at that level. At "ordinary" and "flirty" this is what
 * `sentenceProblems` always was; at "bold" only the youth words count, minus the exempt garment names.
 */
export function contentProblems(text: string, level: ContentLevel): ContentProblem[] {
  const problems: ContentProblem[] = [];
  const found = youthWords(text, "descriptor");
  const bold = level === BOLD;
  const youth = bold ? found.filter((word) => !isExemptGarment(word)) : found;
  if (youth.length > 0) problems.push({ reason: "youth-word", words: youth });
  if (!bold) {
    const revealing = revealingWordsIn(text);
    if (revealing.length > 0) problems.push({ reason: "revealing-word", words: revealing });
  }
  return problems;
}
