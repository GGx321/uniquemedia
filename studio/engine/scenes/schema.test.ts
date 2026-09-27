import { describe, expect, test } from "bun:test";
import { plan } from "./planner";
import { ScenePlanSchema } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const ALL = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;

describe("ScenePlanSchema", () => {
  test("round-trips a real 20-photo plan through JSON exactly", () => {
    const original = plan({ seed: 20260924, count: 20, categories: [...ALL] });
    const roundTripped = ScenePlanSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(roundTripped).toEqual(original);
  });

  test("round-trips an empty plan", () => {
    const original = plan({ seed: 1, count: 0, categories: [] });
    expect(ScenePlanSchema.parse(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  test("rejects an unknown top-level key (strict)", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, extra: true }).success).toBe(false);
  });

  test("rejects a slot missing a required field", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const { outfit: _outfit, ...rest } = good.slots[0]!;
    expect(ScenePlanSchema.safeParse({ ...good, slots: [rest] }).success).toBe(false);
  });

  test("rejects a slot with an unknown key (strict)", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, slots: [{ ...good.slots[0], extra: 1 }] }).success).toBe(false);
  });

  test("rejects a slot missing repeatedPair", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const { repeatedPair: _repeatedPair, ...rest } = good.slots[0]!;
    expect(ScenePlanSchema.safeParse({ ...good, slots: [rest] }).success).toBe(false);
  });

  test("rejects a non-boolean repeatedPair", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, slots: [{ ...good.slots[0], repeatedPair: "yes" }] }).success).toBe(false);
  });

  test("rejects an attemptIdBase that does not match slot-<n>", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const bad = { ...good, slots: [{ ...good.slots[0], attemptIdBase: "not-a-slot-id" }] };
    expect(ScenePlanSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an unknown category", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const bad = { ...good, slots: [{ ...good.slots[0], category: "sports" }] };
    expect(ScenePlanSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an unknown shot", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const bad = { ...good, slots: [{ ...good.slots[0], shot: "drone" }] };
    expect(ScenePlanSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects a version other than 1", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, version: 2 }).success).toBe(false);
  });

  test("rejects a non-integer seed", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, seed: 1.5 }).success).toBe(false);
  });
});
