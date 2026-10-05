import type { Estimate } from "../../shared/engine";
import type { PricedBook, PriceModels } from "../money/priceCache";
import { POOL_MAX_ATTEMPTS, poolCall } from "./poolGen";

// What a category call costs, in one place: the estimate command prices it, the paid commands compare the owner's accepted worst case
// with it and cap the job at that, and the job sends exactly these calls, so no reserve exceeds what the owner was shown.

/** The models a category call prices: the settings' text model alone. */
export function categoryPriceModels(textModel: string): PriceModels {
  return { imageModels: [], chatModels: [textModel] };
}

/**
 * The call's expected and worst cost in the contract's shape. Expected: one attempt at its typical tokens. Worst: every attempt at its
 * ceilings (`POOL_MAX_ATTEMPTS` × one attempt's ceiling, which poolGen.floor.test.ts pins the reserve to). The description does not enter it.
 */
export function categoryEstimate(priced: PricedBook, textModel: string): Estimate {
  const { book } = priced;
  const call = poolCall(textModel);
  const attemptWorst = book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images });
  return {
    expectedMicros: book.chatCost({ model: call.model, images: call.images, ...call.typical }),
    worstMicros: POOL_MAX_ATTEMPTS * attemptWorst,
    prices: book.source,
    pricesAsOf: priced.asOf,
  };
}
