import { describe, expect, test } from "bun:test";
import type { ErrorCode } from "../../shared/engine";
import type { PaidHold } from "../../shared/engine/autopilot";
import { causeOf, checkFailuresOf, displaces, failureRateTripped, holdRank, NETWORK_WAITS_MS, PRICE_WAITS_MS, sameHold } from "./paidFailures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b2 (plan §4.6): which cause an error code names, the waits of the automatic continues, and the failure-rate guard's arithmetic. Pure.

describe("causeOf: the row of the §4.6 table an error code belongs to", () => {
  test.each([
    ["INSUFFICIENT_CREDITS", { kind: "credits" }],
    ["AUTH_INVALID", { kind: "key" }],
    ["SETTLE_ABOVE_WORST", { kind: "halt", code: "SETTLE_ABOVE_WORST" }],
    ["LEDGER_WRITE_FAILED", { kind: "halt", code: "LEDGER_WRITE_FAILED" }],
    ["NETWORK", { kind: "network" }],
    ["RATE_LIMITED", { kind: "network" }],
    ["TIMEOUT", { kind: "network" }],
    ["RECONCILE_REQUIRED", { kind: "reconcile" }],
    ["PRICE_UNAVAILABLE", { kind: "price-unavailable" }],
    ["PRICE_CHANGED", { kind: "price" }],
    ["BUDGET_EXCEEDED", { kind: "budget" }],
    ["RUN_CAP_EXCEEDED", { kind: "cap" }],
    ["IN_FLIGHT", { kind: "busy" }],
    ["MASTER_FACE_UNUSABLE", { kind: "avatar", reason: "master-unusable" }],
    ["FACE_GATE_UNAVAILABLE", { kind: "avatar", reason: "face-gate-unavailable" }],
    ["DESCRIPTOR_INVALID", { kind: "avatar", reason: "descriptor-invalid" }],
  ] as const)("%s", (code, cause) => {
    expect(causeOf(code)).toEqual(cause);
  });

  const noRow: ErrorCode[] = ["INTERNAL", "VALIDATION", "NOT_FOUND", "QA_REJECTED", "MODERATION_REFUSED", "LEDGER_CORRUPT", "SCENES_CHANGED"];
  test.each(noRow)("%s is no row of the table: unknown, so the steps do not guess", (code) => {
    expect(causeOf(code)).toEqual({ kind: "unknown" });
  });
});

describe("the waits of the automatic continues", () => {
  test("a dropped job continues after one minute, then after five", () => {
    expect(NETWORK_WAITS_MS).toEqual([60_000, 300_000]);
  });

  test("the price list is tried again after five, fifteen and sixty minutes", () => {
    expect(PRICE_WAITS_MS).toEqual([300_000, 900_000, 3_600_000]);
  });
});

describe("failureRateTripped: half of a slice of four or more failing the gates or moderation", () => {
  test.each([
    [4, 2, true],
    [4, 1, false],
    [4, 4, true],
    [3, 3, false],
    [3, 2, false],
    [7, 3, false],
    [7, 4, true],
    [25, 12, false],
    [25, 13, true],
    [10, 0, false],
    [0, 0, false],
  ])("%i slots, %i failed the checks: %p", (slots, checkFailures, tripped) => {
    expect(failureRateTripped({ slots, checkFailures })).toBe(tripped);
  });
});

describe("checkFailuresOf: only a gate or a moderation refusal counts", () => {
  const failed = (code: ErrorCode) => ({ end: { status: "failed" as const, error: { code } } });
  const done = { end: { status: "done" as const, photoId: "photo-1" } };
  const open = { end: null };

  test("QA_REJECTED and MODERATION_REFUSED count; a slot that is done or still open does not", () => {
    expect(checkFailuresOf([failed("QA_REJECTED"), failed("MODERATION_REFUSED"), done, open])).toEqual({ slots: 4, checkFailures: 2 });
  });

  test("a slot that ended for want of an answer, the cap or the month is not a failed photo", () => {
    expect(checkFailuresOf([failed("TIMEOUT"), failed("NETWORK"), failed("RATE_LIMITED"), failed("BUDGET_EXCEEDED"), failed("RUN_CAP_EXCEEDED"), failed("INTERNAL")])).toEqual({ slots: 6, checkFailures: 0 });
  });
});

describe("holdRank, displaces and sameHold (S4.6b2, fix rounds 1 and 2)", () => {
  const at = "2026-10-09T10:00:00.000Z";
  const waiting: PaidHold = { reason: "network", at, detail: { drops: 1, attempt: 1, nextAt: at } };
  const waitingPrice: PaidHold = { reason: "price-unavailable", at, detail: { attempt: 1, nextAt: at } };
  const credits: PaidHold = { reason: "credits", at, detail: {} };
  const key: PaidHold = { reason: "key", at, detail: {} };
  const priceUnavailable: PaidHold = { reason: "price-unavailable", at, detail: { attempt: 3, nextAt: null } };
  const budget: PaidHold = { reason: "budget", at, detail: { freeMicros: 0, needMicros: 1, kind: "new-slice" } };
  const price: PaidHold = { reason: "price", at, detail: { stage: "slice", fromPhotos: 2, toPhotos: 0 } };
  const reconcile: PaidHold = { reason: "network", at, detail: { drops: 3, attempt: 2, nextAt: null } };
  const halt: PaidHold = { reason: "halt", at, detail: { code: "SETTLE_ABOVE_WORST" } };
  const internal: PaidHold = { reason: "internal", at, detail: { kind: "allocation-exceeded" } };

  test("ranks: waiting 0; credits, key, price, a price list that stayed unavailable and the month 1; a network hold with no retry 2; halt and internal 3", () => {
    expect([waiting, waitingPrice].map(holdRank)).toEqual([0, 0]);
    expect([credits, key, priceUnavailable, budget, price].map(holdRank)).toEqual([1, 1, 1, 1, 1]);
    expect(holdRank(reconcile)).toBe(2);
    expect([halt, internal].map(holdRank)).toEqual([3, 3]);
  });

  test.each([
    ["credits", credits],
    ["key", key],
    ["price", price],
    ["budget", budget],
    ["a price list that stayed unavailable", priceUnavailable],
    ["a waiting hold", waiting],
  ])("a network hold with no retry displaces %s", (_name, standing) => {
    expect(displaces(reconcile, standing)).toBe(true);
  });

  test.each([
    ["halt", halt],
    ["internal", internal],
    ["another network hold with no retry", reconcile],
  ])("a network hold with no retry does not displace %s", (_name, standing) => {
    expect(displaces(reconcile, standing)).toBe(false);
  });

  test("equals do not displace each other, and nothing displaces halt or internal", () => {
    expect(displaces(key, credits)).toBe(false);
    expect(displaces(waiting, waitingPrice)).toBe(false);
    expect([credits, key, reconcile, budget, price, waiting].map((next) => displaces(next, halt))).toEqual([false, false, false, false, false, false]);
    expect(displaces(halt, internal)).toBe(false);
  });

  test("sameHold compares reason, time and every field of the detail", () => {
    expect(sameHold(waiting, { ...waiting, detail: { ...waiting.detail } })).toBe(true);
    expect(sameHold(credits, key)).toBe(false);
    expect(sameHold(credits, { ...credits, at: "2026-10-09T10:00:00.001Z" })).toBe(false);
    expect(sameHold(waiting, { reason: "network", at, detail: { drops: 1, attempt: 1, nextAt: null } })).toBe(false);
    expect(sameHold(waiting, { reason: "network", at, detail: { drops: 2, attempt: 1, nextAt: at } })).toBe(false);
    expect(sameHold(price, { reason: "price", at, detail: { stage: "slice", fromPhotos: 2, toPhotos: 0 } })).toBe(true);
  });
});
