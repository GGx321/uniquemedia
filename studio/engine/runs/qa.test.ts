import { describe, expect, test } from "bun:test";
import { GateFailure, type QaGate } from "./qa";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7a review (finding, LOW): the duck-typed `releasable()` helper (and its
// internal `as` cast) is gone. `releaseClaim` is now a first-class, optional
// member of `QaGate` itself, so a caller reads `gate.releaseClaim?.(...)`
// directly — no cast anywhere, and no separate helper to keep in sync with
// the interface. This deliberately replaces the old `releasable()` tests
// (which pinned the duck-typed helper's own behaviour) with a test of the
// plain optional method instead.

function bareGate(): QaGate {
  return { name: "face", paid: false, check: async () => ({ verdict: "pass" }) };
}

describe("QaGate.releaseClaim (optional, first-class)", () => {
  test("a gate with no releaseClaim leaves it undefined: a caller's optional call is a no-op", () => {
    const gate = bareGate();
    expect(gate.releaseClaim).toBeUndefined();
    expect(() => gate.releaseClaim?.("avatar-1", "run-1:slot-1#1")).not.toThrow();
  });

  test("a gate that implements releaseClaim is called directly, with no cast needed at the call site", () => {
    const released: { avatarId: string; attemptId: string }[] = [];
    const gate: QaGate = {
      ...bareGate(),
      name: "pdq",
      releaseClaim: (avatarId, attemptId) => released.push({ avatarId, attemptId }),
    };

    gate.releaseClaim?.("avatar-1", "run-1:slot-1#1");

    expect(released).toEqual([{ avatarId: "avatar-1", attemptId: "run-1:slot-1#1" }]);
  });
});

describe("QaGate.prepare (optional, H1)", () => {
  test("a gate with no prepare leaves it undefined: a caller's optional call is a no-op", () => {
    const gate = bareGate();
    expect(gate.prepare).toBeUndefined();
  });

  test("a gate that implements prepare is called directly, with no cast needed at the call site", async () => {
    const prepared: string[] = [];
    const gate: QaGate = {
      ...bareGate(),
      name: "face",
      prepare: async (input) => {
        prepared.push(input.avatarId);
      },
    };

    await gate.prepare?.({
      avatarId: "avatar-1",
      masterOriginal: new Uint8Array([1, 2, 3]),
      signal: new AbortController().signal,
    });

    expect(prepared).toEqual(["avatar-1"]);
  });
});

describe("GateFailure", () => {
  test("carries the EngineError it was built with, and its own message mirrors the error's detail", () => {
    const error = { code: "AUTH_INVALID" as const, detail: "the stored key was rejected" };
    const failure = new GateFailure(error);

    expect(failure.error).toBe(error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("the stored key was rejected");
  });

  test("falls back to the error's code as its message when there is no detail", () => {
    const failure = new GateFailure({ code: "INSUFFICIENT_CREDITS" });
    expect(failure.message).toBe("INSUFFICIENT_CREDITS");
  });
});
