import { describe, expect, test } from "bun:test";
import { COMMAND_DEADLINE_MS, HostCall, MAX_IMPORT_PHOTO_BYTES } from "./control";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { REFERENCE_TIMEOUT_MS } from "./runs/timeouts";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T6c review round 2, L3: bytes crossing this boundary must never be
// unbounded — main already caps its own read at the very same number
// (importFlow.ts), but the contract does not trust that it is the only
// possible sender, or that it never regresses.
describe("HostCall: import.stagePhoto's bytes are bounded (L3)", () => {
  const base = { kind: "control" as const, type: "import.stagePhoto" as const, callId: "call-00000001" };

  test("exactly at the cap parses", () => {
    expect(HostCall.safeParse({ ...base, bytes: new Uint8Array(MAX_IMPORT_PHOTO_BYTES) }).success).toBe(true);
  });

  test("one byte over the cap is rejected", () => {
    expect(HostCall.safeParse({ ...base, bytes: new Uint8Array(MAX_IMPORT_PHOTO_BYTES + 1) }).success).toBe(false);
  });
});

// runs.start answers only after everything it awaits: the price load (one
// timeout), then the master's own look before a run exists (`preflightMaster`:
// loadMaster, then prepareGates, each bounded by REFERENCE_TIMEOUT_MS). Main
// must not answer INTERNAL while the engine goes on to create and launch a
// paid run: the user would click again and pay twice.
describe("COMMAND_DEADLINE_MS['runs.start'] covers the worst awaited path", () => {
  test("a price load, then both bounded steps of the master's preflight, with room to spare", () => {
    const deadline = COMMAND_DEADLINE_MS["runs.start"] ?? 0;
    expect(deadline).toBeGreaterThan(PRICE_FETCH_TIMEOUT_MS + 2 * REFERENCE_TIMEOUT_MS);
  });

  test("runs.resume does no preflight: it keeps the estimate's deadline", () => {
    expect(COMMAND_DEADLINE_MS["runs.resume"]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
  });
});
