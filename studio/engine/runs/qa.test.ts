import { describe, expect, test } from "bun:test";
import { releasable, type QaGate } from "./qa";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7a: `releasable` is the one place that duck-types the optional
// ReleasableGate extension, so no other file needs its own `as` cast.

function bareGate(): QaGate {
  return { name: "face", paid: false, check: async () => ({ verdict: "pass" }) };
}

describe("releasable", () => {
  test("null for a gate with no releaseClaim", () => {
    expect(releasable(bareGate())).toBeNull();
  });

  test("the gate itself, callable, for a gate that does implement releaseClaim", () => {
    const released: { avatarId: string; attemptId: string }[] = [];
    const gate: QaGate & { releaseClaim(avatarId: string, attemptId: string): void } = {
      ...bareGate(),
      name: "pdq",
      releaseClaim: (avatarId, attemptId) => released.push({ avatarId, attemptId }),
    };

    const found = releasable(gate);
    expect(found).not.toBeNull();
    found?.releaseClaim("avatar-1", "run-1:slot-1#1");
    expect(released).toEqual([{ avatarId: "avatar-1", attemptId: "run-1:slot-1#1" }]);
  });

  test("a gate with releaseClaim as something other than a function is not releasable", () => {
    const gate = { ...bareGate(), releaseClaim: "not a function" };
    expect(releasable(gate)).toBeNull();
  });
});
