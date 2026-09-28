import { describe, expect, test } from "bun:test";
import { productionGateOrder } from "./productionGates";
import type { QaGate } from "./qa";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

function bareGate(name: string): QaGate {
  return { name, paid: false, check: async () => ({ verdict: "pass" }) };
}

describe("productionGateOrder (money review M4)", () => {
  test("is exactly [pdq, face, age] when every gate loaded", () => {
    const pdq = bareGate("pdq");
    const face = bareGate("face");
    const age = bareGate("age");

    expect(productionGateOrder({ pdq, face, age }).map((g) => g.name)).toEqual(["pdq", "face", "age"]);
  });

  test("falls back to [pdq, age] when the face gate failed to load (M3), never crashing or reordering the rest", () => {
    const pdq = bareGate("pdq");
    const age = bareGate("age");

    expect(productionGateOrder({ pdq, face: null, age }).map((g) => g.name)).toEqual(["pdq", "age"]);
  });

  test("returns the exact same gate instances, never a copy or a wrapper", () => {
    const pdq = bareGate("pdq");
    const face = bareGate("face");
    const age = bareGate("age");

    const order = productionGateOrder({ pdq, face, age });

    expect(order[0]).toBe(pdq);
    expect(order[1]).toBe(face);
    expect(order[2]).toBe(age);
  });
});
