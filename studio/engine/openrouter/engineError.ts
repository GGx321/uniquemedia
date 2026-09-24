import type { EngineError, ErrorCode } from "../../shared/engine/errors";
import type { HaltCause, ReserveRefusal } from "../money/budget";
import type { OpenRouterError, OpenRouterErrorCode } from "./errors";
import { truncate } from "./transport";
import type { ChatResult, Failed, FailureKind, ImageResult } from "./types";

/** A client result in the T0 error model. `fatal`: stop scheduling paid calls. */
export interface MappedError {
  error: EngineError;
  fatal: boolean;
}

function mapped(code: ErrorCode, f: Failed, fatal: boolean): MappedError {
  return { error: { code, detail: f.message }, fatal };
}

/**
 * Every failure kind maps onto an existing T0 code (the T0 codes are frozen);
 * `satisfies` makes a new kind without a mapping a compile error.
 */
const BY_KIND = {
  AUTH_INVALID: (f) => mapped("AUTH_INVALID", f, true),
  INSUFFICIENT_CREDITS: (f) => mapped("INSUFFICIENT_CREDITS", f, true),
  RATE_LIMITED: (f) => ({
    error: { code: "RATE_LIMITED", detail: f.message, ...(f.retryAfterMs === undefined ? {} : { retryAfterMs: f.retryAfterMs }) },
    fatal: false,
  }),
  // A 5xx that outlasted the transport retries is an upstream outage; any other status is our bug.
  HTTP_ERROR: (f) => mapped(f.httpStatus !== null && f.httpStatus >= 500 ? "NETWORK" : "INTERNAL", f, false),
  TIMEOUT: (f) => mapped("TIMEOUT", f, false),
  NETWORK: (f) => mapped("NETWORK", f, false),
  NOT_SENT: (f) => mapped("INTERNAL", f, false),
  EMPTY_CONTENT: (f) => mapped("INTERNAL", f, false),
  UNUSABLE_PAID_RESPONSE: (f) => mapped("INTERNAL", f, true),
} satisfies Record<FailureKind, (f: Failed) => MappedError>;

const BY_HALT_CAUSE = {
  SETTLE_ABOVE_WORST: "SETTLE_ABOVE_WORST",
  LEDGER_WRITE_FAILED: "LEDGER_WRITE_FAILED",
} satisfies Record<HaltCause, ErrorCode>;

function unreachable(value: never): never {
  throw new Error(`unmapped client result: ${JSON.stringify(value)}`);
}

/** Budget refusals map 1:1. A cap or budget refusal may clear as open attempts settle; the others need the user. */
function fromRefusal(refusal: ReserveRefusal): MappedError {
  switch (refusal.reason) {
    case "BUDGET_EXCEEDED":
    case "RUN_CAP_EXCEEDED":
      return {
        error: {
          code: refusal.reason,
          detail: `committed ${refusal.committedMicros} µ$ + worst case ${refusal.worstMicros} µ$ > limit ${refusal.limitMicros} µ$`,
        },
        fatal: false,
      };
    case "RECONCILE_REQUIRED":
      return {
        error: { code: "RECONCILE_REQUIRED", detail: `${refusal.openAttempts} open attempt(s)${refusal.torn ? ", torn ledger line" : ""}` },
        fatal: true,
      };
    case "HALTED":
      return { error: { code: BY_HALT_CAUSE[refusal.cause], detail: truncate(refusal.detail) }, fatal: true };
    default:
      return unreachable(refusal);
  }
}

/** The T0 error for a client result; null for a success within its worst case, or a cancel. */
export function toEngineError(result: ImageResult | ChatResult): MappedError | null {
  switch (result.status) {
    case "ok":
      return result.aboveWorst
        ? {
            error: { code: "SETTLE_ABOVE_WORST", detail: `billed ${result.costMicros} µ$, above the reserved worst case; the price table is wrong` },
            fatal: true,
          }
        : null;
    case "aborted":
      return null;
    case "refused":
      return { error: { code: "MODERATION_REFUSED", detail: result.message }, fatal: false };
    case "blocked":
      return fromRefusal(result.refusal);
    case "error":
      return BY_KIND[result.kind](result);
    default:
      return unreachable(result);
  }
}

/**
 * What an error thrown by the client means in the T0 error model: thrown by
 * `fetchCredits` (a failure kind) or when the client is created (the key or
 * the base URL). The message is already redacted. A 401 means the key is
 * rejected: the caller marks it so and never retries.
 */
const BY_THROWN_CODE = {
  AUTH_INVALID: () => "AUTH_INVALID",
  NO_API_KEY: () => "AUTH_INVALID",
  INVALID_API_KEY: () => "AUTH_INVALID",
  INSUFFICIENT_CREDITS: () => "INSUFFICIENT_CREDITS",
  RATE_LIMITED: () => "RATE_LIMITED",
  TIMEOUT: () => "TIMEOUT",
  NETWORK: () => "NETWORK",
  // As for a result: a 5xx that outlasted the retries is an outage, any other status our bug.
  HTTP_ERROR: (e) => (e.httpStatus !== null && e.httpStatus >= 500 ? "NETWORK" : "INTERNAL"),
  NOT_SENT: () => "INTERNAL",
  EMPTY_CONTENT: () => "INTERNAL",
  UNUSABLE_PAID_RESPONSE: () => "INTERNAL",
  BASE_URL_NOT_ALLOWED: () => "INTERNAL",
} satisfies Record<OpenRouterErrorCode, (error: OpenRouterError) => ErrorCode>;

export function fromOpenRouterError(error: OpenRouterError): EngineError {
  return { code: BY_THROWN_CODE[error.code](error), detail: truncate(error.message) };
}
