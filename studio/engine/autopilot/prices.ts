import { MAX_GENERATED_PER_AVATAR, type LaunchUnitPrices } from "../../shared/autopilot/estimate";
import type { ImageAgeCheck } from "../../shared/engine";
import type { CoversOf } from "../../shared/scenes/writerBound";
import { WRITER_CALL } from "../money/estimate";
import type { PricedBook, PriceModels } from "../money/priceCache";
import { runEstimateFromScenes, runPriceModels, type RunModels } from "../runs/plan";
import { composeEstimate, writerCeilingMicros } from "../sceneSets/estimate";

// Stage 4 (plan §4.2, invariant A18): the unit prices of the launch estimate, read from the engine's own estimates. `launchEstimate` (shared) is linear in the
// counts and takes these; nothing here prices a call by its own formula, so a launch's figure cannot drift from the compose's and the draw's.

/**
 * The models a launch prices: exactly a whole run's (the route's image models, the settings' text model for the writer and, when it is on, the age check's), with the
 * image endpoints rechecked against Studio's requests. A launch's draw is priced like a run priced it, and its compose like a set's.
 */
export function launchPriceModels(models: RunModels, imageAgeCheck: ImageAgeCheck, bold = false): PriceModels {
  return runPriceModels(models, imageAgeCheck, bold ? 1 : 0);
}

/** Stands for a custom category with no coverage in the writer's table: the typical cost of n model scenes, read off `composeEstimate` for n scenes of one such category. */
const MODEL_ONLY_PROBE = "cat-table-probe" as const;

/**
 * One photo and one scene at these prices. `photoWorst`/`photoExpected` are `runEstimateFromScenes` for ONE photo, so the dearer route model (the Seedream fallback
 * after a refusal), the three attempts per slot and the age-check toggle are priced exactly as a run prices them; the writer's ceiling, its chunk and its attempts
 * are the compose's, and its typical cost is tabulated per MODEL scene count from `composeEstimate` (a call's cost is rounded up, so it is not exactly linear).
 *
 * 5a.3 (S5.9d, option B): `bold` is a launch whose draft is «Смелая» (`isBoldLook`; 5a.4, I5.77: of any category, since the planner puts every slot of it on the route). Every
 * photo of it is priced at the Seedream 2K unit, so
 * `launchEstimate(n) = composeEstimate(n) + runEstimateFromScenes(n, boldPhotos = n)` (A18) and the launch math itself reads a different unit and nothing else.
 *
 * 5a.2 (S5.6c2): `covers` says which custom categories the code template covers. It travels in the unit, so `launchEstimate` prices each avatar's compose from its
 * split exactly as `composeEstimate` prices the compose it will make (A18 over every shape of split).
 */
export function unitPricesOf(priced: PricedBook, models: RunModels, imageAgeCheck: ImageAgeCheck, covers: CoversOf, bold = false): LaunchUnitPrices {
  const photo = runEstimateFromScenes(priced, models, { count: 1, ...(bold ? { boldPhotos: 1 } : {}) }, imageAgeCheck);
  const uncovered: CoversOf = () => false;
  const writerTypicalMicros = Array.from(
    { length: MAX_GENERATED_PER_AVATAR + 1 },
    (_, n) => composeEstimate(priced, models.textModel, [{ ref: MODEL_ONLY_PROBE, count: n }], uncovered).expectedMicros,
  );
  return {
    photoWorstMicros: photo.worstMicros,
    photoExpectedMicros: photo.expectedMicros,
    writerCeilingMicros: writerCeilingMicros(priced, models.textModel),
    writerChunkSlots: WRITER_CALL.slotsPerCall,
    writerMaxAttempts: WRITER_CALL.maxAttempts,
    writerTypicalMicros,
    covers,
    prices: priced.book.source,
    pricesAsOf: priced.asOf,
  };
}
