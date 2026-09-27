import { describe, expect, test } from "bun:test";
import { HostCall, MAX_IMPORT_PHOTO_BYTES } from "./control";
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
