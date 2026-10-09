import type { ErrorCode } from "../../shared/engine";
import type { PaidHold, SkipReason } from "../../shared/engine/autopilot";
import type { SlotEnd } from "../runs/journal";
import type { SliceOutcome } from "./paidPort";

// Stage 4, S4.6b2 (plan §4.6): the failure table's vocabulary. Which row of the table an error code belongs to, how long the automatic continues wait, and the failure-rate guard's arithmetic.
// Pure: the paid steps decide what a cause does (a hold, a retry, a skip); this file only names it.

export type HaltCode = "SETTLE_ABOVE_WORST" | "LEDGER_WRITE_FAILED";

/**
 * The row of the §4.6 table an error belongs to.
 * - credits / key / halt: a person must fix it (a top-up, a new key, a reconcile).
 * - network: the request got no answer, or a final 429 / 5xx settled at $0: the bounded automatic continues apply.
 * - reconcile: `RECONCILE_REQUIRED` in a running launch (the ledger holds reserves it cannot vouch for): the same exit as a network hold, no retry.
 * - price-unavailable: the price list did not load: a retry after 5, 15 and 60 minutes.
 * - price / budget / cap: the allocation, the month or the run's cap.
 * - busy: another job holds the avatar.
 * - avatar: the avatar itself cannot go on; the others do.
 * - unknown: no row. The steps leave the avatar where it is and say so.
 */
export type Cause =
  | { kind: "credits" }
  | { kind: "key" }
  | { kind: "halt"; code: HaltCode }
  | { kind: "network" }
  | { kind: "reconcile" }
  | { kind: "price-unavailable" }
  | { kind: "price" }
  | { kind: "budget" }
  | { kind: "cap" }
  | { kind: "busy" }
  | { kind: "avatar"; reason: Extract<SkipReason, "master-unusable" | "face-gate-unavailable" | "descriptor-invalid"> }
  | { kind: "unknown" };

export function causeOf(code: ErrorCode): Cause {
  switch (code) {
    case "INSUFFICIENT_CREDITS":
      return { kind: "credits" };
    case "AUTH_INVALID":
      return { kind: "key" };
    case "SETTLE_ABOVE_WORST":
    case "LEDGER_WRITE_FAILED":
      return { kind: "halt", code };
    case "NETWORK":
    case "RATE_LIMITED":
    case "TIMEOUT":
      return { kind: "network" };
    case "RECONCILE_REQUIRED":
      return { kind: "reconcile" };
    case "PRICE_UNAVAILABLE":
      return { kind: "price-unavailable" };
    case "PRICE_CHANGED":
      return { kind: "price" };
    case "BUDGET_EXCEEDED":
      return { kind: "budget" };
    case "RUN_CAP_EXCEEDED":
      return { kind: "cap" };
    case "IN_FLIGHT":
      return { kind: "busy" };
    case "MASTER_FACE_UNUSABLE":
      return { kind: "avatar", reason: "master-unusable" };
    case "FACE_GATE_UNAVAILABLE":
      return { kind: "avatar", reason: "face-gate-unavailable" };
    case "DESCRIPTOR_INVALID":
      return { kind: "avatar", reason: "descriptor-invalid" };
    default:
      return { kind: "unknown" };
  }
}

/** A job that got no answer continues by itself after the first drop (1 minute) and after the second (5 minutes); the third drop waits for a person (Q2 = A). */
export const NETWORK_WAITS_MS: readonly number[] = [60_000, 300_000];

/** The price list is asked for again after 5, 15 and 60 minutes; the fourth failure holds. */
export const PRICE_WAITS_MS: readonly number[] = [300_000, 900_000, 3_600_000];

/** The failure-rate guard (§4.6): a slice of at least four photos in which at least half of the slots failed the gates or moderation. */
export const FAILURE_RATE_MIN_SLOTS = 4;

export function failureRateTripped(outcome: SliceOutcome): boolean {
  return outcome.slots >= FAILURE_RATE_MIN_SLOTS && outcome.checkFailures * 2 >= outcome.slots;
}

/** A hold that waits for a retry already scheduled (a network or price-list wait with `nextAt`): nobody has to act, and a timer will. Every other hold is for a person. */
export function isWaitingHold(hold: PaidHold): hold is Extract<PaidHold, { reason: "network" | "price-unavailable" }> {
  return (hold.reason === "network" || hold.reason === "price-unavailable") && hold.detail.nextAt !== null;
}

/**
 * How much a paid hold must be respected (S4.6b2, fix rounds 1 and 2):
 * - 0, waiting: a retry is scheduled and a timer will clear it;
 * - 1, a person must act, and the cause costs nothing to meet again (credits, key, price, a price list that stayed unavailable, the month);
 * - 2, a network hold with no retry: requests of the launch got no answer three times, and only a reconcile makes the launch safe to continue (A19). It is above the holds of rank 1, so a
 *   third drop is never hidden behind a 402 that «Продолжить» would clear at once;
 * - 3, the ledger is halted or the launch's own check failed: nothing displaces them.
 */
export function holdRank(hold: PaidHold): 0 | 1 | 2 | 3 {
  if (hold.reason === "network") return hold.detail.nextAt === null ? 2 : 0;
  if (hold.reason === "price-unavailable") return hold.detail.nextAt === null ? 1 : 0;
  return hold.reason === "halt" || hold.reason === "internal" ? 3 : 1;
}

/** A hold displaces the one that stands only by a higher rank; among equals the first stays. */
export function displaces(next: PaidHold, standing: PaidHold): boolean {
  return holdRank(next) > holdRank(standing);
}

/** The same hold, structurally: its reason, its time and every field of its detail (details are flat). */
export function sameHold(a: PaidHold, b: PaidHold): boolean {
  if (a.reason !== b.reason || a.at !== b.at) return false;
  const x: Record<string, unknown> = a.detail;
  const y: Record<string, unknown> = b.detail;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const key of keys) {
    const left = x[key];
    const right = y[key];
    if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
      if (JSON.stringify(left) !== JSON.stringify(right)) return false;
    } else if (left !== right) return false;
  }
  return true;
}

const CHECK_CODES: readonly ErrorCode[] = ["QA_REJECTED", "MODERATION_REFUSED"];

/**
 * How a run's slots ended, for the guard: a slot counts as failed by the checks only when a QA gate or moderation closed it. A slot that is done, still open, or closed for want of an
 * answer, the cap, the month or a provider fault never counts: those are not a bad master portrait.
 */
export function checkFailuresOf(slots: readonly { end: SlotEnd | null }[]): SliceOutcome {
  const checkFailures = slots.filter((slot) => slot.end?.status === "failed" && CHECK_CODES.includes(slot.end.error.code)).length;
  return { slots: slots.length, checkFailures };
}
