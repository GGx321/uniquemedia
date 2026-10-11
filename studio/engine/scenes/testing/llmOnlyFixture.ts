import type { CategoryPool, CategorySnapshot, CategorySummary } from "../../../shared/engine";
import { poolOf } from "../poolGen";
import type { Pool } from "../pools";

// 5a.2 (S5.6c2, plan s5a2 §5.7): the test-only custom category whose activities the code template cannot write. A built-in, and a custom category the
// template covers, are written with no model request since S5.6c1; a test of the LLM path (a writer request, a reserve, a chunk's attempts, a repair)
// plans from this category instead. None of its activities opens with a verb's «-ing» form or «on her …», so `customSentence` answers null for every slot
// (`rendersActivity` is false) and every slot of the category goes to the model at its chunk's reserved ids. Mirrors the mock's fixture (S5.6e).

export const LLM_ONLY_REF = "cat-llm-only-fixture" as const;

/** The pool in the contract's stored shape (what the category library keeps and `runs.start` reads). */
export const LLM_ONLY_CATEGORY_POOL: CategoryPool = {
  locations: [
    { name: "a corner cafe in Paris", times: ["morning", "midday"], activities: [{ text: "a quiet coffee", twoHanded: false }, { text: "one hand on the menu", twoHanded: false }], mirror: false },
    { name: "a Paris bakery counter", times: ["morning"], activities: [{ text: "a croissant break", twoHanded: false }, { text: "a box of pastries", twoHanded: true }], mirror: true },
    { name: "a bridge over the Seine", times: ["golden hour", "evening"], activities: [{ text: "a long look at the river", twoHanded: false }, { text: "a slow walk", twoHanded: false }], mirror: false },
    { name: "a flower stall", times: ["midday"], activities: [{ text: "a bouquet in her arms", twoHanded: false }, { text: "a stem between her fingers", twoHanded: false }], mirror: false },
    { name: "a quiet bookshop", times: ["midday", "evening"], activities: [{ text: "a shelf at eye level", twoHanded: false }, { text: "a book held open", twoHanded: false }], mirror: false },
  ],
  outfits: ["a beige trench coat and jeans", "a striped knit top and a midi skirt", "a long cardigan and trousers"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};

/**
 * The category as a library stores it (and the mock lists it): ONE definition, read by the engine's seeder (`testing/llmOnlyCategory.ts`), the parity rigs (the
 * real library and the mock's seed alike) and the mock's own tests, so no side keeps a copy of it. The timestamps are each store's own.
 */
export const LLM_ONLY_CATEGORY_RECORD: Omit<CategorySummary, "createdAt" | "updatedAt"> = {
  categoryId: LLM_ONLY_REF,
  name: "Только модель",
  description: "тестовая категория: шаблон её не пишет",
  label: "Model only",
  style: "phone",
  pool: LLM_ONLY_CATEGORY_POOL,
  model: "x-ai/grok-4.3",
  spentMicros: 5_000,
};

/** The same pool in the engine's planning shape. */
export const LLM_ONLY_POOL: Pool = poolOf(LLM_ONLY_CATEGORY_POOL);

export function llmOnlySnapshot(style: CategorySnapshot["style"] = "phone"): CategorySnapshot {
  return { ref: LLM_ONLY_REF, name: LLM_ONLY_CATEGORY_RECORD.name, label: LLM_ONLY_CATEGORY_RECORD.label, style };
}

/** The draft's categories of a story or a test whose subject is the compose WRITER (a fault or a hang there): the category only the model writes. ONE definition, read by the parity stories and the mock's launch testkit. */
export const ON_THE_WRITER = { categories: [LLM_ONLY_REF] };
