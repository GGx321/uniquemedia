import { z } from "zod";
import { Count, SafeText } from "./primitives";

/**
 * The closed set of error codes the engine and main can report.
 * User-facing text is kept apart, in `errorMessagesRu.ts`.
 *
 * - AUTH_INVALID: OpenRouter 401; the run stops and is never retried.
 * - INSUFFICIENT_CREDITS: OpenRouter 402.
 * - BUDGET_EXCEEDED: the monthly budget from Settings would be exceeded.
 * - RUN_CAP_EXCEEDED: the run's (or avatar job's) own cap would be exceeded.
 * - MODERATION_REFUSED: the provider refused the prompt or reference.
 * - RATE_LIMITED: 429 after transport retries; may carry `retryAfterMs`.
 * - NETWORK / TIMEOUT: transport failures (a timeout costs the worst case until reconciled).
 * - RECONCILE_REQUIRED: paid calls are blocked until the user reconciles.
 * - ENCRYPTION_UNAVAILABLE: `safeStorage` cannot encrypt, so the key is not stored.
 * - VALIDATION: a message or payload failed the contract.
 * - NOT_FOUND: an id did not resolve.
 * - INTERNAL: anything else.
 *
 * Fatal money codes (paid calls stop until the cause is dealt with):
 * - LEDGER_CORRUPT: a ledger line other than the last one cannot be read.
 * - SETTLE_ABOVE_WORST: a settle reported more than its reserve's worst case.
 * - LEDGER_WRITE_FAILED: a reserve or settle could not be written and fsynced.
 * - PRICE_UNAVAILABLE: neither live prices nor the fallback table cover the model.
 * - PRICE_CHANGED: the current worst case exceeds the `acceptedWorstMicros` the user agreed to.
 * - IN_FLIGHT: refused while paid requests are still in flight (e.g. reconcile, library move).
 */
export const ERROR_CODES = [
  "AUTH_INVALID",
  "INSUFFICIENT_CREDITS",
  "BUDGET_EXCEEDED",
  "RUN_CAP_EXCEEDED",
  "MODERATION_REFUSED",
  "RATE_LIMITED",
  "NETWORK",
  "TIMEOUT",
  "RECONCILE_REQUIRED",
  "ENCRYPTION_UNAVAILABLE",
  "VALIDATION",
  "NOT_FOUND",
  "INTERNAL",
  "LEDGER_CORRUPT",
  "SETTLE_ABOVE_WORST",
  "LEDGER_WRITE_FAILED",
  "PRICE_UNAVAILABLE",
  "PRICE_CHANGED",
  "IN_FLIGHT",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);

/** An error as it travels between processes: a code plus optional diagnostics, never user text. */
export const EngineError = z.strictObject({
  code: ErrorCode,
  detail: SafeText.optional(),
  retryAfterMs: Count.optional(),
});

export type ErrorCode = z.infer<typeof ErrorCode>;
export type EngineError = z.infer<typeof EngineError>;
