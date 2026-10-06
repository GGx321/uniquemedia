import type { ChatCall } from "../money/estimate";

// The pool call's limits, in a module of their own with no imports of weight: main's command deadline (control.ts) reads the attempt count from
// here, and must not pull the scene writer in with it.

/** A pool call is asked once more after a rejected answer; then the command fails with POOL_REJECTED. */
export const POOL_MAX_ATTEMPTS = 2;

/**
 * The pool call's limits: about 10K tokens in and 4K out, so one attempt's ceiling is $0.0225 at the fallback prices and a
 * call's two attempts are $0.045. The prompt is at most ~6.5K bytes (the owner's 500 chars at three bytes each, the worst
 * feedback, the rules, the example and the schema), and the client counts one token per byte as a floor under `inputTokens`:
 * poolGen.floor.test.ts pins that the ceiling stays above that floor with a margin, so a reserve is always the price the owner accepted.
 * `maxTokens` covers low-effort reasoning plus a ~900-token answer. Typical counts are an estimate (no real call yet).
 */
const POOL_LIMITS = { maxTokens: 4_000, inputTokens: 10_000, images: 0, typical: { inputTokens: 1_800, outputTokens: 1_500 } } as const;

/** One pool attempt on the settings' text model. */
export function poolCall(textModel: string): ChatCall {
  return { model: textModel, ...POOL_LIMITS, typical: { ...POOL_LIMITS.typical } };
}
