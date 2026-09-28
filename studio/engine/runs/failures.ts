import type { EngineError } from "../../shared/engine";
import { toEngineError } from "../openrouter/engineError";
import type { Blocked, Failed } from "../openrouter/types";

// T6 (review H1): what a failed paid attempt means for a photo run. The
// money model takes a new attempt id only after a 2xx, an abort or a
// timeout. Any other failure must not be retried at once under the slot's
// next id — a dropped Wi-Fi would otherwise burn every open slot's three
// ids within milliseconds and close them for good, with their open reserves
// counted at the worst case after the reconcile.

/**
 * - next-attempt: a timeout; the slot takes its next id.
 * - transient: a final 429, a 5xx that outlasted the transport retries, a
 *   network error. The run stops sending and ends failed with its slots
 *   left open, so a resume later continues them.
 * - limit: the Budget refused this attempt (the run's cap, the month). Only
 *   this slot stops: another may still fit as earlier attempts settle below
 *   their worst case.
 * - fatal: the run stops sending (a 401 or 402, a ledger halt, a reconcile
 *   needed, a paid answer that cannot be used, or our own bug: a 4xx that is
 *   not a moderation refusal, a request that cannot be built).
 */
export type FailureKind = "fatal" | "transient" | "next-attempt" | "limit";

export function classifyFailure(result: Blocked | Failed): { kind: FailureKind; error: EngineError } {
  const mapped = toEngineError(result);
  const error: EngineError = mapped?.error ?? { code: "INTERNAL", detail: "the attempt failed without an error" };
  if (result.status === "blocked") {
    const reason = result.refusal.reason;
    return { kind: reason === "RUN_CAP_EXCEEDED" || reason === "BUDGET_EXCEEDED" ? "limit" : "fatal", error };
  }
  switch (result.kind) {
    case "TIMEOUT":
      return { kind: "next-attempt", error };
    case "RATE_LIMITED":
    case "NETWORK":
      return { kind: "transient", error };
    case "HTTP_ERROR":
      return { kind: result.httpStatus !== null && result.httpStatus >= 500 ? "transient" : "fatal", error };
    case "AUTH_INVALID":
    case "INSUFFICIENT_CREDITS":
    case "NOT_SENT":
    case "UNUSABLE_PAID_RESPONSE":
    case "EMPTY_CONTENT":
      return { kind: "fatal", error };
  }
}
