import type { QaGate } from "./qa";

/**
 * Money review M4: the production QA gate order (T7a/T7b), pulled out of
 * `studio/engine/main.ts`'s own wiring into its own, directly testable
 * function — `productionGates.test.ts` pins the exact order so a future
 * edit that reshuffles it fails loudly, and `engine/main.ts` is the one
 * caller, never duplicating the rule.
 *
 * `pdq` stays first (free, cheapest to fail on — no wasted work on a
 * near-duplicate); `face` stays second, still free; `age` stays last, the
 * only paid gate, so money is spent only on an image every free gate
 * already accepted. `face` is nullable: `main.ts`'s own `loadFaceGate()`
 * can fail (missing/corrupt models, a WASM codec failure, a load timeout —
 * M3), in which case the run is refused before it starts anyway
 * (`Engine#assertFaceGate`), but the gate LIST itself must still be well
 * formed (pdq and age, in their own order) rather than crash building it.
 */
export function productionGateOrder(gates: { pdq: QaGate; face: QaGate | null; age: QaGate }): QaGate[] {
  return gates.face === null ? [gates.pdq, gates.age] : [gates.pdq, gates.face, gates.age];
}
