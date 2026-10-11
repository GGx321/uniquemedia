import { openLibrary } from "../library";
import { sequentialIds, steppingClock } from "../library/testing/sampleData";
import { LLM_ONLY_CATEGORY_RECORD, LLM_ONLY_REF } from "../scenes/testing/llmOnlyFixture";

// 5a.2 (S5.6c2, m11): `cat-llm-only-fixture` in a real library, for the engine tests of the model path. A built-in category (and a custom one the template
// covers) is written by the code template with no writer request, so a test that needs a writer request, a reserve or a chunk's attempts plans from this
// category: its activities do not read after «she is», the template answers null for every slot, and every slot goes to the model. No test-runner import.

let seeded = 0;

/** Puts the fixture category in the library at `libraryDir` (a library the engine will open next, or has open: the store is files). Returns its id. */
export async function seedLlmOnlyCategory(libraryDir: string): Promise<typeof LLM_ONLY_REF> {
  const { library } = await openLibrary(libraryDir, { now: steppingClock(), newId: sequentialIds(`llmonly${++seeded}`) });
  if ((await library.categories.get(LLM_ONLY_REF)) === null) await library.categories.create(LLM_ONLY_CATEGORY_RECORD);
  return LLM_ONLY_REF;
}
