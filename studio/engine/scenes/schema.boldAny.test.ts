import { describe, expect, test } from "bun:test";
import { POOL_TEXT_MAX } from "../../shared/engine";
import { plan } from "./planner";
import { PlanSlotSchema, ScenePlanSchema } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA1, plan s5a4 §4 I5.73, §8 BA1): the slot schema is rewritten around the marker. A route is any category's; a bold level needs the route (or is a «Смелая»
// category's own); a `world` rides on a custom routed slot and nowhere else. A slot stored before 5a.4 parses exactly as it did.

const FIVE = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;
const BOLD_TWO = ["nightwear", "beach"] as const;
const CUSTOM = "cat-paris-cafes";

function slot(category: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slotIndex: 1,
    category,
    location: category === CUSTOM ? "a corner cafe in Paris" : "x",
    timeOfDay: "morning",
    activity: "y",
    outfit: "z",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

const issuePaths = (result: ReturnType<typeof PlanSlotSchema.safeParse>): string[] => result.error?.issues.map((i) => i.path.join(".")) ?? [];

describe("the route on a slot", () => {
  test.each([...FIVE, CUSTOM])("a route on a slot of «%s» parses and is kept", (category) => {
    expect(PlanSlotSchema.parse(slot(category, { route: "seedream" })).route).toBe("seedream");
  });

  test("a route other than seedream is still refused on a slot of the five", () => {
    expect(PlanSlotSchema.safeParse(slot("home", { route: "grok" })).success).toBe(false);
  });

  test("a slot of the five without a route gains none", () => {
    expect("route" in PlanSlotSchema.parse(slot("home"))).toBe(false);
  });
});

describe("a bold level on a slot", () => {
  test.each([...FIVE, CUSTOM])("a bold level on a routed slot of «%s» parses", (category) => {
    expect(PlanSlotSchema.parse(slot(category, { level: "bold", route: "seedream", ...(category === CUSTOM ? { world: "a cafe terrace in Paris" } : {}) })).level).toBe("bold");
  });

  test.each([...FIVE, CUSTOM])("a bold level on «%s» without the route is refused, on the level", (category) => {
    const result = PlanSlotSchema.safeParse(slot(category, { level: "bold" }));
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("level");
  });

  test.each([...BOLD_TWO])("a bold slot of «%s» still parses with or without the route", (category) => {
    expect(PlanSlotSchema.safeParse(slot(category, { level: "bold" })).success).toBe(true);
    expect(PlanSlotSchema.safeParse(slot(category, { level: "bold", route: "seedream" })).success).toBe(true);
  });

  test("a flirty or ordinary level on a slot of the five without a route still parses", () => {
    expect(PlanSlotSchema.safeParse(slot("home", { level: "flirty" })).success).toBe(true);
    expect(PlanSlotSchema.safeParse(slot("home", { level: "ordinary" })).success).toBe(true);
  });
});

describe("the world of a slot", () => {
  const WORLD = "a cafe terrace in Paris";

  test("a routed custom slot keeps its world", () => {
    expect(PlanSlotSchema.parse(slot(CUSTOM, { route: "seedream", world: WORLD })).world).toBe(WORLD);
  });

  test("a slot without a world gains none", () => {
    expect("world" in PlanSlotSchema.parse(slot(CUSTOM, { route: "seedream" }))).toBe(false);
  });

  test.each([...FIVE, ...BOLD_TWO])("a world on a slot of «%s» is refused, routed or not", (category) => {
    for (const extra of [{}, { route: "seedream" }]) {
      const result = PlanSlotSchema.safeParse(slot(category, { world: WORLD, ...extra }));
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("world");
    }
  });

  test("a world on a custom slot without the route is refused", () => {
    const result = PlanSlotSchema.safeParse(slot(CUSTOM, { world: WORLD }));
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("world");
  });

  test("a world is held to the pool text bound: one character over is refused, the bound itself parses", () => {
    expect(PlanSlotSchema.safeParse(slot(CUSTOM, { route: "seedream", world: "w".repeat(POOL_TEXT_MAX) })).success).toBe(true);
    expect(PlanSlotSchema.safeParse(slot(CUSTOM, { route: "seedream", world: "w".repeat(POOL_TEXT_MAX + 1) })).success).toBe(false);
  });

  test("an empty world and a non-ASCII world are refused", () => {
    expect(PlanSlotSchema.safeParse(slot(CUSTOM, { route: "seedream", world: "" })).success).toBe(false);
    expect(PlanSlotSchema.safeParse(slot(CUSTOM, { route: "seedream", world: "кафе в Париже" })).success).toBe(false);
  });
});

describe("a plan stored before 5a.4", () => {
  test.each(["ordinary", "flirty", "bold"] as const)("a real plan of every category at «%s» parses and round-trips", (level) => {
    const original = plan({ seed: 20261026, count: 30, categories: [...FIVE, ...BOLD_TWO], level });
    expect(ScenePlanSchema.parse(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });
});
