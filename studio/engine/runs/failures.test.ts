import { describe, expect, test } from "bun:test";
import type { Blocked, Failed, FailureKind as ClientFailureKind, LedgerEffect } from "../openrouter/types";
import { classifyFailure } from "./failures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6 review H1: what a failed attempt means for a run. The money model takes
// a new attempt id only after a 2xx, an abort or a timeout; any other failure
// either stops the whole run for a resume later (a rate limit, an outage, the
// network) or is a bug or a refusal of the account that must stop it for good
// in this job — never an instant retry that burns the slot's next id.

const OPEN: LedgerEffect = { action: "left-open", worstMicros: 50_000 };
const FREE: LedgerEffect = { action: "settled", costMicros: 0, estimated: false };

function failed(kind: ClientFailureKind, httpStatus: number | null, extra: Partial<Failed> = {}): Failed {
  return { status: "error", kind, message: `${kind} ${httpStatus ?? ""}`, httpStatus, fatal: false, ledger: httpStatus === null ? OPEN : FREE, ...extra };
}

describe("classifyFailure", () => {
  test("a timeout moves the slot to its next id (the money model allows a new id after a timeout)", () => {
    expect(classifyFailure(failed("TIMEOUT", null))).toMatchObject({ kind: "next-attempt", error: { code: "TIMEOUT" } });
  });

  test("a final 429 stops the run for a resume, keeping the server's Retry-After", () => {
    expect(classifyFailure(failed("RATE_LIMITED", 429, { retryAfterMs: 120_000 }))).toEqual({
      kind: "transient",
      error: { code: "RATE_LIMITED", detail: "RATE_LIMITED 429", retryAfterMs: 120_000 },
    });
  });

  test.each([500, 502, 503, 504])("a %d that outlasted the transport retries stops the run for a resume", (status) => {
    expect(classifyFailure(failed("HTTP_ERROR", status))).toMatchObject({ kind: "transient", error: { code: "NETWORK" } });
  });

  test("a network error stops the run for a resume", () => {
    expect(classifyFailure(failed("NETWORK", null))).toMatchObject({ kind: "transient", error: { code: "NETWORK" } });
  });

  test.each([400, 404, 413, 422])("a %d that is not a moderation refusal is our bug: fatal", (status) => {
    expect(classifyFailure(failed("HTTP_ERROR", status))).toMatchObject({ kind: "fatal", error: { code: "INTERNAL" } });
  });

  test("a request that could not be built is fatal: every later one would be built the same way", () => {
    expect(classifyFailure(failed("NOT_SENT", null, { ledger: { action: "released" } }))).toMatchObject({ kind: "fatal", error: { code: "INTERNAL" } });
  });

  test.each([
    ["AUTH_INVALID", 401, "AUTH_INVALID"],
    ["INSUFFICIENT_CREDITS", 402, "INSUFFICIENT_CREDITS"],
    ["UNUSABLE_PAID_RESPONSE", 200, "INTERNAL"],
    ["EMPTY_CONTENT", 200, "INTERNAL"],
  ] as const)("%s is fatal", (kind, status, code) => {
    expect(classifyFailure(failed(kind, status))).toMatchObject({ kind: "fatal", error: { code } });
  });

  test("the run's cap or the month running out stops only the slot that asked (others may still fit)", () => {
    const cap: Blocked = { status: "blocked", refusal: { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 1, committedMicros: 1, worstMicros: 1 } };
    const month: Blocked = { status: "blocked", refusal: { ok: false, reason: "BUDGET_EXCEEDED", limitMicros: 1, committedMicros: 1, worstMicros: 1 } };
    expect(classifyFailure(cap)).toMatchObject({ kind: "limit", error: { code: "RUN_CAP_EXCEEDED" } });
    expect(classifyFailure(month)).toMatchObject({ kind: "limit", error: { code: "BUDGET_EXCEEDED" } });
  });

  test("a reconcile needed or a halted ledger is fatal", () => {
    const reconcile: Blocked = { status: "blocked", refusal: { ok: false, reason: "RECONCILE_REQUIRED", openAttempts: 1, torn: false } };
    const halted: Blocked = { status: "blocked", refusal: { ok: false, reason: "HALTED", cause: "LEDGER_WRITE_FAILED", detail: "x" } };
    expect(classifyFailure(reconcile)).toMatchObject({ kind: "fatal", error: { code: "RECONCILE_REQUIRED" } });
    expect(classifyFailure(halted)).toMatchObject({ kind: "fatal", error: { code: "LEDGER_WRITE_FAILED" } });
  });
});
