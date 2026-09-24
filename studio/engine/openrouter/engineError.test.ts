import { expect, test } from "bun:test";
import { EngineError } from "../../shared/engine/errors";
import { toEngineError, type MappedError } from "./engineError";
import { PNG } from "./testing/fakes";
import type { Failed, FailureKind, ImageResult } from "./types";

const SETTLED_ZERO = { action: "settled", costMicros: 0, estimated: false } as const;
const LEFT_OPEN = { action: "left-open", worstMicros: 50_000 } as const;

function failure(kind: FailureKind, extra: Partial<Failed> = {}): Failed {
  return { status: "error", kind, message: `${kind} detail`, httpStatus: null, fatal: false, ledger: SETTLED_ZERO, ...extra };
}

function ok(aboveWorst: boolean): ImageResult {
  return { status: "ok", bytes: PNG, mediaType: "image/png", costMicros: 90_000, estimated: false, latencyMs: 5, httpTries: 1, aboveWorst };
}

const CASES: { name: string; result: ImageResult; expected: MappedError | null }[] = [
  { name: "ok", result: ok(false), expected: null },
  { name: "ok billed above its worst case", result: ok(true), expected: { error: { code: "SETTLE_ABOVE_WORST", detail: expect.any(String) }, fatal: true } },
  { name: "aborted", result: { status: "aborted", ledger: LEFT_OPEN }, expected: null },
  { name: "refused", result: { status: "refused", httpStatus: 400, message: "blocked through content moderation", ledger: SETTLED_ZERO }, expected: { error: { code: "MODERATION_REFUSED", detail: "blocked through content moderation" }, fatal: false } },
  {
    name: "blocked by the monthly budget",
    result: { status: "blocked", refusal: { ok: false, reason: "BUDGET_EXCEEDED", limitMicros: 10, committedMicros: 5, worstMicros: 6 } },
    expected: { error: { code: "BUDGET_EXCEEDED", detail: expect.any(String) }, fatal: false },
  },
  {
    name: "blocked by the run cap",
    result: { status: "blocked", refusal: { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 10, committedMicros: 5, worstMicros: 6 } },
    expected: { error: { code: "RUN_CAP_EXCEEDED", detail: expect.any(String) }, fatal: false },
  },
  {
    name: "blocked until reconcile",
    result: { status: "blocked", refusal: { ok: false, reason: "RECONCILE_REQUIRED", openAttempts: 2, torn: false } },
    expected: { error: { code: "RECONCILE_REQUIRED", detail: expect.any(String) }, fatal: true },
  },
  {
    name: "halted by a bill above the worst case",
    result: { status: "blocked", refusal: { ok: false, reason: "HALTED", cause: "SETTLE_ABOVE_WORST", detail: "billed above" } },
    expected: { error: { code: "SETTLE_ABOVE_WORST", detail: "billed above" }, fatal: true },
  },
  {
    name: "halted by a failed ledger write",
    result: { status: "blocked", refusal: { ok: false, reason: "HALTED", cause: "LEDGER_WRITE_FAILED", detail: "write failed" } },
    expected: { error: { code: "LEDGER_WRITE_FAILED", detail: "write failed" }, fatal: true },
  },
  { name: "AUTH_INVALID", result: failure("AUTH_INVALID", { httpStatus: 401, fatal: true }), expected: { error: { code: "AUTH_INVALID", detail: "AUTH_INVALID detail" }, fatal: true } },
  { name: "INSUFFICIENT_CREDITS", result: failure("INSUFFICIENT_CREDITS", { httpStatus: 402, fatal: true }), expected: { error: { code: "INSUFFICIENT_CREDITS", detail: "INSUFFICIENT_CREDITS detail" }, fatal: true } },
  {
    name: "RATE_LIMITED with a hint",
    result: failure("RATE_LIMITED", { httpStatus: 429, retryAfterMs: 3_000 }),
    expected: { error: { code: "RATE_LIMITED", detail: "RATE_LIMITED detail", retryAfterMs: 3_000 }, fatal: false },
  },
  { name: "HTTP_ERROR 4xx", result: failure("HTTP_ERROR", { httpStatus: 400 }), expected: { error: { code: "INTERNAL", detail: "HTTP_ERROR detail" }, fatal: false } },
  { name: "HTTP_ERROR 5xx", result: failure("HTTP_ERROR", { httpStatus: 503 }), expected: { error: { code: "NETWORK", detail: "HTTP_ERROR detail" }, fatal: false } },
  { name: "TIMEOUT", result: failure("TIMEOUT", { ledger: LEFT_OPEN }), expected: { error: { code: "TIMEOUT", detail: "TIMEOUT detail" }, fatal: false } },
  { name: "NETWORK", result: failure("NETWORK", { ledger: LEFT_OPEN }), expected: { error: { code: "NETWORK", detail: "NETWORK detail" }, fatal: false } },
  { name: "NOT_SENT", result: failure("NOT_SENT", { ledger: { action: "released" } }), expected: { error: { code: "INTERNAL", detail: "NOT_SENT detail" }, fatal: false } },
  { name: "EMPTY_CONTENT", result: failure("EMPTY_CONTENT", { httpStatus: 200 }), expected: { error: { code: "INTERNAL", detail: "EMPTY_CONTENT detail" }, fatal: false } },
  {
    name: "UNUSABLE_PAID_RESPONSE",
    result: failure("UNUSABLE_PAID_RESPONSE", { httpStatus: 200, fatal: true, rawSaved: true }),
    expected: { error: { code: "INTERNAL", detail: "UNUSABLE_PAID_RESPONSE detail" }, fatal: true },
  },
];

test.each(CASES)("maps $name onto the T0 error model", ({ result, expected }) => {
  expect(toEngineError(result)).toEqual(expected);
});

test("every mapped error is a valid T0 EngineError", () => {
  const mapped = CASES.map((c) => toEngineError(c.result)).filter((m) => m !== null);

  expect(mapped.length).toBeGreaterThan(0);
  for (const m of mapped) expect(EngineError.safeParse(m.error).success).toBe(true);
});
