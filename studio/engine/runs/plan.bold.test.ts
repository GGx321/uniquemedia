import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RunPlanSchema } from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9a, plan s5a3 §11 and I5.43): a plan gains `slot.route` and `models.bold` ADDITIVELY. A plan.json written before them parses to the very same document
// (the frozen fixture of main 3a9cd498 is never re-pinned), and one that carries them reads back as written. Nothing writes either field yet: S5.9d does.

const raw = (): Record<string, unknown> => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "plan-main-3a9cd498.json"), "utf8"));

/** The plan with its first slot on the Seedream route. S5.9b2 (plan s5a3 §11): only a «Смелая» category's slot carries a route, so the slot becomes one of «Ночнушки и бельё». */
function withRoute(plan: Record<string, unknown>, category = "nightwear"): Record<string, unknown> {
  const scenes = plan.scenes as { slots: Record<string, unknown>[] };
  return { ...plan, scenes: { ...scenes, slots: scenes.slots.map((slot, i) => (i === 0 ? { ...slot, category, route: "seedream" } : slot)) } };
}

describe("a plan.json before 5a.3", () => {
  test("parses to the very same document and gains neither a route nor a bold model", () => {
    const old = raw();
    const parsed = RunPlanSchema.parse(old);
    expect<unknown>(parsed).toEqual(old);
    expect("bold" in parsed.models).toBe(false);
    expect(parsed.scenes.slots.every((slot) => !("route" in slot))).toBe(true);
  });
});

describe("a plan.json with the 5a.3 fields", () => {
  test("keeps the bold model of the plan", () => {
    const old = raw();
    const models = { ...(old.models as Record<string, unknown>), bold: "bytedance-seed/seedream-5-0-pro" };
    const plan = { ...old, models };
    expect(RunPlanSchema.parse(plan).models.bold).toBe("bytedance-seed/seedream-5-0-pro");
    expect<unknown>(RunPlanSchema.parse(plan)).toEqual(plan);
  });

  test("keeps a slot's route", () => {
    const plan = withRoute(raw());
    const parsed = RunPlanSchema.parse(plan);
    const first = parsed.scenes.slots[0];
    expect(first !== undefined && "route" in first ? first.route : undefined).toBe("seedream");
    expect<unknown>(parsed).toEqual(plan);
  });

  test("refuses a slot whose level is bold: no slot is drawn bold before S5.9c", () => {
    const plan = withRoute(raw());
    const scenes = plan.scenes as { slots: Record<string, unknown>[] };
    const bold = { ...plan, scenes: { ...scenes, slots: scenes.slots.map((slot, i) => (i === 0 ? { ...slot, level: "bold" } : slot)) } };
    expect(RunPlanSchema.safeParse(bold).success).toBe(false);
  });

  test("refuses a route on a slot of the five (only a «Смелая» category's slot is drawn on Seedream)", () => {
    expect(RunPlanSchema.safeParse(withRoute(raw(), "home")).success).toBe(false);
  });

  test("refuses a route other than seedream", () => {
    const plan = withRoute(raw());
    const scenes = plan.scenes as { slots: Record<string, unknown>[] };
    const broken = { ...plan, scenes: { ...scenes, slots: scenes.slots.map((slot, i) => (i === 0 ? { ...slot, route: "grok" } : slot)) } };
    expect(RunPlanSchema.safeParse(broken).success).toBe(false);
  });

  test("refuses an empty bold model", () => {
    const old = raw();
    expect(RunPlanSchema.safeParse({ ...old, models: { ...(old.models as Record<string, unknown>), bold: "" } }).success).toBe(false);
  });
});
