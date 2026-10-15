import { describe, expect, test } from "bun:test";
import { BANKS } from "./banks";
import { BANK_VERBS, CURATED_VERBS, readMotion } from "./motionGrammar";

// Stage 5, 5b.2, S5.WC2b round 2: the positive motion grammar is the bank's own. These tests prove it: every bank motion and every code motion reads, and the verb list is
// exactly the bank's clause verbs, recomputed here from the banks (the code motions add none). The code motions are restated verbatim (engine/clips/motion.ts holds
// them; a shared test may not import the engine); engine/clips/motionText.test.ts checks them through the one check as well.

const BANK_MOTIONS = [...new Set(Object.values(BANKS).flatMap((bank) => bank.places.flatMap((place) => place.moments.map((moment) => moment.motion))))];
const CODE_MOTIONS = [
  "she slowly blinks and gives a small smile",
  "she slowly tucks a strand of hair behind her ear",
  "she tilts her head a little to one side and smiles",
  "she slowly glances to the side and looks back",
  "she slowly takes a breath and relaxes her shoulders",
  "she slowly looks down and smiles to herself",
  "she turns her hips a little toward the mirror and back",
];

/** A motion's clause verbs, mechanically: the word after «she» and the adverbs, and after each «and», comma, «as» or «while» (but «and back»). */
function clauseVerbs(motion: string): string[] {
  return motion
    .toLowerCase()
    .split(/,| and (?!back\b)| as | while /)
    .flatMap((clause, n) => {
      const words = clause.trim().split(/\s+/);
      if (words[0] === "her" || words[0] === "the" || (n === 0 && words[0] !== "she")) return [];
      let i = words[0] === "she" ? 1 : 0;
      while (["slowly", "gently", "softly", "slightly"].includes(words[i] ?? "")) i++;
      return words[i] === undefined ? [] : [words[i]];
    });
}

describe("the motion grammar is the bank's own (S5.WC2b round 2)", () => {
  test("the corpus is what it says: 271 bank motions on 177 texts, 7 code motions", () => {
    expect(Object.values(BANKS).flatMap((bank) => bank.places.flatMap((place) => place.moments)).length).toBe(271);
    expect(new Set([...BANK_MOTIONS, ...CODE_MOTIONS]).size).toBe(177);
  });

  test("every bank motion and every code motion reads", () => {
    expect([...BANK_MOTIONS, ...CODE_MOTIONS].filter((motion) => !readMotion(motion).ok)).toEqual([]);
  });

  test("BANK_VERBS is exactly the clause verbs of the bank and the code motions, derived from them", () => {
    const derived = [...new Set([...BANK_MOTIONS, ...CODE_MOTIONS].flatMap(clauseVerbs))].sort();
    expect([...BANK_VERBS].sort()).toEqual(derived);
  });

  test("the curated extension adds verbs the bank does not say, and none twice", () => {
    expect(CURATED_VERBS.filter((verb) => (BANK_VERBS as readonly string[]).includes(verb))).toEqual([]);
    expect(new Set(CURATED_VERBS).size).toBe(CURATED_VERBS.length);
  });
});
