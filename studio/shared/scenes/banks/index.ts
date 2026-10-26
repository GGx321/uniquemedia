import { isBoldCategory } from "../../engine";
import { BEACH } from "./beach";
import { FITNESS } from "./fitness";
import { GLAMOUR } from "./glamour";
import { HOME } from "./home";
import { NIGHTWEAR } from "./nightwear";
import { CUES, GAZE, HAIRSTYLES } from "./looks";
import { PHOTOSHOOT } from "./photoshoot";
import { boldAnyProblems, boldBankProblems, boldOnlyHereProblems, categoryBankProblems, cueBankProblems, gazeBankProblems, hairBankProblems, type BoldAnyKind } from "./schema";
import { TRAVEL } from "./travel";
import { BANK_CATEGORIES, type BankCategory, type CategoryBank } from "./types";

// 5a.2 (S5.6a, I5.21): every phrase of a template sentence comes from these banks. Data, not code, and validated when this module loads, so a malformed
// bank fails the first test that imports it (and the engine at start), never a run.

export { CUES, GAZE, HAIRSTYLES };

export const BANKS: Readonly<Record<BankCategory, CategoryBank>> = { home: HOME, travel: TRAVEL, photoshoot: PHOTOSHOOT, glamour: GLAMOUR, fitness: FITNESS, nightwear: NIGHTWEAR, beach: BEACH };

/**
 * 5a.4 (S5.BA2): the shipped «Смелая» banks held to the 5a.4 rules as well (banks/schema.ts `boldAnyProblems`): beach, whose places are water places. «Ночнушки и бельё» joins with its
 * always-underwear redesign (Q-A2); until then it keeps the 5a.3 rules alone.
 */
const BOLD_ANY_KIND: Readonly<Partial<Record<BankCategory, BoldAnyKind>>> = { beach: "beach" };

/** What `validateBanks` checks; each part defaults to the shipped bank. */
export interface BankInput {
  banks?: unknown;
  gaze?: unknown;
  cues?: unknown;
  hair?: unknown;
}

function categoryOf(banks: unknown, category: BankCategory): unknown {
  return typeof banks === "object" && banks !== null && category in banks ? Reflect.get(banks, category) : undefined;
}

/** Validates the banks and throws with every problem found, each under its bank's name. Called eagerly below. */
export function validateBanks(input: BankInput = {}): void {
  const banks = input.banks ?? BANKS;
  const problems = [
    // S5.9b2 (plan s5a3 §6.4, H2): the schema is chosen by category. A «Смелая» bank is held to its own; an ordinary one to the five's, and it holds none of the
    // «Смелая» vocabulary (bold-only-here, I5.37).
    ...BANK_CATEGORIES.flatMap((category) => {
      const bank = categoryOf(banks, category);
      const kind = BOLD_ANY_KIND[category];
      const problems = !isBoldCategory(category)
        ? [...categoryBankProblems(bank, category), ...boldOnlyHereProblems(bank)]
        : kind === undefined
          ? boldBankProblems(bank)
          : boldAnyProblems(bank, kind);
      return problems.map((p) => `${category}: ${p}`);
    }),
    ...gazeBankProblems(input.gaze ?? GAZE).map((p) => `gaze: ${p}`),
    ...cueBankProblems(input.cues ?? CUES).map((p) => `cues: ${p}`),
    ...hairBankProblems(input.hair ?? HAIRSTYLES).map((p) => `hair: ${p}`),
  ];
  if (problems.length > 0) throw new Error(`Studio scene banks are invalid:\n${problems.join("\n")}`);
}

validateBanks();
