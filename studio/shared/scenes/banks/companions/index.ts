import { BANKS } from "../index";
import { boldAnyProblems, type BoldAnyKind } from "../schema";
import { BANK_CATEGORIES, ORDINARY_BANK_CATEGORIES, type CategoryBank, type OrdinaryBankCategory } from "../types";
import { CUSTOM_ROOMS } from "./customRooms";
import { CUSTOM_WATER } from "./customWater";
import { FITNESS_BOLD } from "./fitness";
import { GLAMOUR_BOLD } from "./glamour";
import { HOME_BOLD } from "./home";
import { PHOTOSHOOT_BOLD } from "./photoshoot";
import { TRAVEL_BOLD } from "./travel";

// 5a.4 (S5.BA2, plan s5a4 §5.2, §5.3.1, I5.71): the «Смелая» banks of every category but the two that are «Смелая» already. A companion re-reads one of the five into private,
// natural places (I5.72); the two custom banks hold a custom category's frames at «Смелая», away from the water («rooms») and at it («by the water»). Their own registry, never
// BANKS, so every test and fixture that reads the seven stays as it was (QB-1). Data, validated when this module loads: a malformed bank fails the first test that imports it.

export const BOLD_COMPANIONS: Readonly<Record<OrdinaryBankCategory, CategoryBank>> = { home: HOME_BOLD, travel: TRAVEL_BOLD, photoshoot: PHOTOSHOOT_BOLD, glamour: GLAMOUR_BOLD, fitness: FITNESS_BOLD };

/** The custom categories' two «Смелая» banks: a slot draws from «by the water» when its world is a water place, from «rooms» otherwise (S5.BA3). */
export const CUSTOM_BOLD_BANKS = { rooms: CUSTOM_ROOMS, water: CUSTOM_WATER } as const satisfies Readonly<Record<string, CategoryBank>>;

export type CustomBoldBranch = keyof typeof CUSTOM_BOLD_BANKS;
const CUSTOM_BRANCHES: readonly CustomBoldBranch[] = ["rooms", "water"];

/** What `validateBoldBanks` checks; each part defaults to the shipped registry. */
export interface BoldBankInput {
  companions?: unknown;
  custom?: unknown;
}

const entryOf = (banks: unknown, key: string): unknown => (typeof banks === "object" && banks !== null && key in banks ? Reflect.get(banks, key) : undefined);

/**
 * Validates the companions and the custom banks under the 5a.3 and the 5a.4 rules (banks/schema.ts `boldAnyProblems`) and throws with every problem found, each under its bank's
 * name. A bank's moments are held unique against the seven and every other new bank (moment-unique). Called eagerly below.
 */
export function validateBoldBanks(input: BoldBankInput = {}): void {
  const companions = input.companions ?? BOLD_COMPANIONS;
  const custom = input.custom ?? CUSTOM_BOLD_BANKS;
  const entries: { name: string; bank: unknown; kind: BoldAnyKind }[] = [
    ...ORDINARY_BANK_CATEGORIES.map((category) => ({ name: category, bank: entryOf(companions, category), kind: "companion" as const })),
    ...CUSTOM_BRANCHES.map((branch) => ({ name: branch, bank: entryOf(custom, branch), kind: branch })),
  ];
  const shipped = BANK_CATEGORIES.map((category) => BANKS[category]);
  const problems = entries.flatMap(({ name, bank, kind }) => {
    const others = [...shipped, ...entries.filter((other) => other.name !== name).map((other) => other.bank)];
    return boldAnyProblems(bank, kind, others).map((p) => `${name}: ${p}`);
  });
  if (problems.length > 0) throw new Error(`Studio «Смелая» banks are invalid:\n${problems.join("\n")}`);
}

/** An implied cover by what it is, as the card's cover clause names it (r2.4 N1): the sheet, the towel (a bath towel, or one over her hips), the bath foam. */
export type ImpliedItem = "sheet" | "towel" | "foam";
const IMPLIED_ITEMS: readonly (readonly [ImpliedItem, RegExp])[] = [
  ["sheet", /\b(?:bed)?sheet\b/i],
  ["towel", /\btowel\b/i],
  ["foam", /\bfoam\b/i],
];

/** The implied covers a «Смелая» bank can draw for a Studio-created avatar, in the clause's fixed order (sheet, towel, foam): read from its data, so a cover that leaves the bank leaves it. */
export function impliedItemsOf(bank: CategoryBank): ImpliedItem[] {
  const covers = bank.outfits.filter((outfit) => outfit.tier === "implied").map((outfit) => outfit.text);
  return IMPLIED_ITEMS.filter(([, words]) => covers.some((text) => words.test(text))).map(([item]) => item);
}

validateBoldBanks();
