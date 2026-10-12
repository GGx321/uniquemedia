import { FITNESS } from "./fitness";
import { GLAMOUR } from "./glamour";
import { HOME } from "./home";
import { CUES, GAZE, HAIRSTYLES } from "./looks";
import { PHOTOSHOOT } from "./photoshoot";
import { boldOnlyHereProblems, categoryBankProblems, cueBankProblems, gazeBankProblems, hairBankProblems } from "./schema";
import { TRAVEL } from "./travel";
import { BANK_CATEGORIES, type BankCategory, type CategoryBank } from "./types";

// 5a.2 (S5.6a, I5.21): every phrase of a template sentence comes from these banks. Data, not code, and validated when this module loads, so a malformed
// bank fails the first test that imports it (and the engine at start), never a run.

export { CUES, GAZE, HAIRSTYLES };

export const BANKS: Readonly<Record<BankCategory, CategoryBank>> = { home: HOME, travel: TRAVEL, photoshoot: PHOTOSHOOT, glamour: GLAMOUR, fitness: FITNESS };

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
    // S5.9b2 (I5.37): an ordinary bank holds none of the «Смелая» vocabulary (bold-only-here).
    ...BANK_CATEGORIES.flatMap((category) => [...categoryBankProblems(categoryOf(banks, category), category), ...boldOnlyHereProblems(categoryOf(banks, category))].map((p) => `${category}: ${p}`)),
    ...gazeBankProblems(input.gaze ?? GAZE).map((p) => `gaze: ${p}`),
    ...cueBankProblems(input.cues ?? CUES).map((p) => `cues: ${p}`),
    ...hairBankProblems(input.hair ?? HAIRSTYLES).map((p) => `hair: ${p}`),
  ];
  if (problems.length > 0) throw new Error(`Studio scene banks are invalid:\n${problems.join("\n")}`);
}

validateBanks();
