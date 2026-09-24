import { expect, test } from "bun:test";
import type { MoneyStatus } from "../../shared/engine";
import { paidStop } from "./paidStop";

const OPEN: MoneyStatus = {
  ledger: "open",
  month: "2026-09",
  spentMicros: 0,
  monthlyBudgetMicros: 10_000_000,
  unsettledMicros: 0,
  unsettledCount: 0,
  reconcileNeeded: false,
  reconcileReasons: [],
  halt: null,
};

test("nothing stops paid calls on a clean ledger", () => {
  expect(paidStop({ money: OPEN, engineError: null })).toBeNull();
});

test("before the money status is known nothing is claimed", () => {
  expect(paidStop({ money: null, engineError: null })).toBeNull();
});

test("reasons to reconcile stop paid calls until a reconcile", () => {
  const money: MoneyStatus = { ...OPEN, reconcileNeeded: true, reconcileReasons: ["open-reserves"] };
  expect(paidStop({ money, engineError: null })).toEqual({ kind: "reconcile" });
});

test("a settle above its worst case from the status stops paid calls until a reconcile", () => {
  const money: MoneyStatus = { ...OPEN, halt: { cause: "SETTLE_ABOVE_WORST", detail: "x", attemptIds: ["slot-1#1"] } };
  expect(paidStop({ money, engineError: null })).toEqual({ kind: "reconcile" });
});

test("a settle above its worst case reported as an engine error stops paid calls until a reconcile", () => {
  expect(paidStop({ money: OPEN, engineError: { code: "SETTLE_ABOVE_WORST" } })).toEqual({ kind: "reconcile" });
});

test("a failed ledger write stops paid calls until a restart, even with reasons to reconcile", () => {
  const money: MoneyStatus = {
    ...OPEN,
    reconcileNeeded: true,
    reconcileReasons: ["open-reserves"],
    halt: { cause: "LEDGER_WRITE_FAILED", detail: "x" },
  };
  expect(paidStop({ money, engineError: null })).toEqual({ kind: "restart", code: "LEDGER_WRITE_FAILED" });
});

test.each(["LEDGER_CORRUPT", "LEDGER_UNREADABLE"] as const)("a ledger that could not be read (%s) stops paid calls, and a reconcile cannot help", (cause) => {
  const money: MoneyStatus = {
    ledger: "unavailable",
    month: "2026-09",
    monthlyBudgetMicros: 10_000_000,
    reconcileNeeded: false,
    reconcileReasons: [],
    halt: { cause, detail: "x" },
  };
  expect(paidStop({ money, engineError: null })).toEqual({ kind: "restart", code: cause });
});
