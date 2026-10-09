import { MAX_GENERATED_PER_AVATAR, type LaunchUnitPrices } from "../../shared/autopilot/estimate";
import type { ImageAgeCheck } from "../../shared/engine";
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
export function launchPriceModels(models: RunModels, imageAgeCheck: ImageAgeCheck): PriceModels {
  return runPriceModels(models, imageAgeCheck);
}

/**
 * One photo and one scene at these prices. `photoWorst`/`photoExpected` are `runEstimateFromScenes` for ONE photo, so the dearer route model (the Seedream fallback
 * after a refusal), the three attempts per slot and the age-check toggle are priced exactly as a run prices them; the writer's ceiling, its chunk and its attempts
 * are the compose's, and its typical cost is tabulated per scene count from `composeEstimate` (a call's cost is rounded up, so it is not exactly linear).
 */
export function unitPricesOf(priced: PricedBook, models: RunModels, imageAgeCheck: ImageAgeCheck): LaunchUnitPrices {
  const photo = runEstimateFromScenes(priced, models, { count: 1 }, imageAgeCheck);
  const writerTypicalMicros = Array.from({ length: MAX_GENERATED_PER_AVATAR + 1 }, (_, n) => composeEstimate(priced, models.textModel, n).expectedMicros);
  return {
    photoWorstMicros: photo.worstMicros,
    photoExpectedMicros: photo.expectedMicros,
    writerCeilingMicros: writerCeilingMicros(priced, models.textModel),
    writerChunkSlots: WRITER_CALL.slotsPerCall,
    writerMaxAttempts: WRITER_CALL.maxAttempts,
    writerTypicalMicros,
    prices: priced.book.source,
    pricesAsOf: priced.asOf,
  };
}
