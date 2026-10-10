import { IMPORT_FALLBACK_PRICE, type DescriptorCheck, type Estimate } from "../../shared/engine";

// The mock's side of `avatars.checkDescriptor` (Stage 5, S5.0c). The mock cannot look at a photo: a check says «everything agrees» with the descriptor it judges, unless a test
// scripts the next one (`MockEngine.setNextDescriptorCheck`). The price is the engine's own computation at the fallback table (`IMPORT_FALLBACK_PRICE.check` is one attempt; the
// command is priced at up to two), never a separate number.

/** The check of a descriptor whose hair, eyes and marks agree with the photo; the body is not visible (the mock has no body traits). */
export function matchingCheck(checkedText: string): DescriptorCheck {
  return { matches: true, aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } }, proposal: null, checkedText };
}

/** One check's price: the expected figure of one attempt, the worst of two. */
export const MOCK_CHECK_ESTIMATE: Readonly<Estimate> = {
  expectedMicros: IMPORT_FALLBACK_PRICE.check.expectedMicros,
  worstMicros: 2 * IMPORT_FALLBACK_PRICE.check.worstMicros,
  prices: "live",
  pricesAsOf: IMPORT_FALLBACK_PRICE.asOf,
};
