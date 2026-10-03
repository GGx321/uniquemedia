import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { NODE_TEST_SUITES } from "../scripts/electronNodeTests";
import { tierTestArgs } from "../scripts/realWorkerTests";
import { inQuarantineRun, QUARANTINE, quarantineEntry, type QuarantineEntry } from "./quarantine";
import { budgetsOutsidePerfTests, holdsTierTests, nameTags, quarantineIds } from "./tierSources";
import { assertBudget, BLOCKING_FLOOR_MS, budgetBound, inTier, TIERS, tierMarkers, tierOf, tierPattern, tierTag } from "./tiers";

const ROOT = resolve(import.meta.dir, "..", "..");
const STUDIO = join(ROOT, "studio");

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : sourcesUnder(join(dir, entry.name));
    return /\.test\.tsx?$|\.node-test\.[cm]?tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [];
  });
}

const PERF: Record<string, string> = { STUDIO_TEST_TIER: "perf" };
const BLOCKING: Record<string, string> = {};

describe("tierOf", () => {
  test("is undefined for the blocking run, whether the variable is unset or empty", () => {
    expect(tierOf({})).toBeUndefined();
    expect(tierOf({ STUDIO_TEST_TIER: "" })).toBeUndefined();
  });

  test("reads each tier", () => {
    for (const tier of TIERS) expect(tierOf({ STUDIO_TEST_TIER: tier })).toBe(tier);
  });

  test("throws for a value that is not a tier, so a typo cannot quietly run the blocking suite", () => {
    expect(() => tierOf({ STUDIO_TEST_TIER: "perff" })).toThrow(/not a tier/);
    expect(() => tierOf({ STUDIO_TEST_TIER: "PERF" })).toThrow(/not a tier/);
  });
});

describe("the tag", () => {
  test("is the tier in brackets, and its pattern selects exactly the tagged names", () => {
    for (const tier of TIERS) {
      const pattern = new RegExp(tierPattern(tier));
      expect(pattern.test(`${tierTag(tier)} a test`)).toBe(true);
      expect(pattern.test(`a test about ${tier}`)).toBe(false);
    }
  });

  test("is among the markers that make a runner open a file", () => {
    for (const tier of TIERS) expect(tierMarkers(tier)).toContain(tierTag(tier));
  });
});

describe("assertBudget", () => {
  test("in the blocking run, a time over the budget but under the generous bound passes", () => {
    expect(() => assertBudget(300, 20, "x", { env: BLOCKING })).not.toThrow();
    expect(budgetBound(20, { env: BLOCKING })).toBe(BLOCKING_FLOOR_MS);
  });

  test("in the blocking run, a runaway still fails (the bound is generous, not gone)", () => {
    expect(() => assertBudget(BLOCKING_FLOOR_MS + 1, 20, "a runaway", { env: BLOCKING })).toThrow(/a runaway took 2001 ms, not under 2000 ms/);
  });

  test("in the perf run, the budget itself is the bound", () => {
    expect(() => assertBudget(19, 20, "x", { env: PERF })).not.toThrow();
    expect(() => assertBudget(20, 20, "x", { env: PERF })).toThrow(/not under 20 ms/);
  });

  test("a bound over four times a large budget scales with it, and `blockingMs` replaces it", () => {
    expect(budgetBound(1_000, { env: BLOCKING })).toBe(4_000);
    expect(budgetBound(1_000, { env: BLOCKING, blockingMs: 1_200 })).toBe(1_200);
    expect(budgetBound(1_000, { env: PERF, blockingMs: 1_200 })).toBe(1_000);
  });
});

describe("inTier", () => {
  test("registers only in the run of its own tier", () => {
    let ran = 0;
    inTier("perf", () => ran++, PERF);
    inTier("perf", () => ran++, BLOCKING);
    inTier("heavy", () => ran++, PERF);
    expect(ran).toBe(1);
  });
});

describe("quarantine", () => {
  const entry: QuarantineEntry = { id: "x", runId: "37116331132", date: "2026-10-03", reason: "a flake" };

  test("every entry names its id, a numeric run id, an ISO date and a reason, and ids are unique", () => {
    for (const e of QUARANTINE) {
      expect(e.id).toMatch(/^[\w.-]+$/);
      expect(e.runId).toMatch(/^\d{8,}$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.reason.length).toBeGreaterThan(10);
    }
    expect(new Set(QUARANTINE.map((e) => e.id)).size).toBe(QUARANTINE.length);
  });

  test("an id with no entry throws, so a tag cannot exist without its entry", () => {
    expect(() => quarantineEntry("nope", [entry])).toThrow(/no entry for "nope"/);
    expect(() => inQuarantineRun("nope", { STUDIO_TEST_TIER: "quarantine" }, [entry])).toThrow(/no entry/);
  });

  test("a listed test runs in the quarantine run and nowhere else", () => {
    expect(inQuarantineRun("x", { STUDIO_TEST_TIER: "quarantine" }, [entry])).toBe(true);
    expect(inQuarantineRun("x", {}, [entry])).toBe(false);
    expect(inQuarantineRun("x", { STUDIO_TEST_TIER: "perf" }, [entry])).toBe(false);
  });

  // `quarantinedTest("<id>", ...)` and `inQuarantineRun("<id>", ...)` in the sources, as the ids they name.
  function usedIds(): Map<string, string[]> {
    const used = new Map<string, string[]>();
    for (const file of sourcesUnder(STUDIO)) {
      if (file.endsWith("tiers.test.ts")) continue;
      for (const id of quarantineIds(readFileSync(file, "utf8"), file)) used.set(id, [...(used.get(id) ?? []), relative(ROOT, file)]);
    }
    return used;
  }

  test("every tagged test has an entry, and every entry has a tagged test (the list cannot rot)", () => {
    const used = usedIds();
    expect([...used.keys()].filter((id) => !QUARANTINE.some((e) => e.id === id))).toEqual([]);
    expect(QUARANTINE.map((e) => e.id).filter((id) => !used.has(id))).toEqual([]);
  });
});

describe("tierSources", () => {
  test("holdsTierTests sees a helper call, inTier and a tagged name, and not a string or a comment that mentions one", () => {
    expect(holdsTierTests('heavyTest("a", () => {});', "heavy")).toBe(true);
    expect(holdsTierTests('inTier("perf", () => { test("x", () => {}); });', "perf")).toBe(true);
    expect(holdsTierTests('test("[perf] x", () => {});', "perf")).toBe(true);
    expect(holdsTierTests("describe.each(rows)(`[heavy] ${name}`, () => {});", "heavy")).toBe(true);
    expect(holdsTierTests('if (inQuarantineRun("x")) test("y", () => {});', "quarantine")).toBe(true);
    expect(holdsTierTests('const s = \'heavyTest("a")\'; // perfTest("b")\ntest("[perf]", () => {});', "heavy")).toBe(false);
    expect(holdsTierTests('test("[pref] typo", () => {});', "perf")).toBe(false);
  });

  test("nameTags reads the leading tag of test, suite and helper names", () => {
    const source = 'test("[pref] a", () => {});\nperfTest("b", () => {});\ndescribe("[heavy] c", () => {});\ntest("a [mid] d", () => {});';
    expect(nameTags(source)).toEqual([
      { line: 1, tag: "pref" },
      { line: 3, tag: "heavy" },
    ]);
  });

  test("budgetsOutsidePerfTests flags an assertBudget in a plain test, and not one in a perf test", () => {
    expect(budgetsOutsidePerfTests('test("a", () => { assertBudget(1, 2, "x"); });')).toEqual([1]);
    expect(budgetsOutsidePerfTests('perfTest("a", () => { assertBudget(1, 2, "x"); });')).toEqual([]);
    expect(budgetsOutsidePerfTests('test("[perf] a", () => { for (const c of cs) assertBudget(1, 2, "x"); });')).toEqual([]);
    expect(budgetsOutsidePerfTests('perfTest("a", () => {});\ntest("b", () => { assertBudget(1, 2, "x"); });')).toEqual([2]);
  });
});

describe("the tiers' sources", () => {
  test("every assertBudget sits inside a test the perf run selects, or the perf run never enforces it", () => {
    const outside: string[] = [];
    for (const file of sourcesUnder(STUDIO)) {
      if (file.endsWith("tiers.test.ts")) continue;
      for (const line of budgetsOutsidePerfTests(readFileSync(file, "utf8"), file)) outside.push(`${relative(ROOT, file)}:${line}`);
    }
    expect(outside).toEqual([]);
  });

  test("every leading [tag] of a test or suite name is a tier: a typo would drop the test out of every tier run", () => {
    const unknown: string[] = [];
    for (const file of sourcesUnder(STUDIO)) {
      if (file.endsWith("tiers.test.ts") || file.endsWith("realWorkerTests.test.ts")) continue;
      for (const { line, tag } of nameTags(readFileSync(file, "utf8"), file)) {
        if (!TIERS.some((tier) => tier === tag)) unknown.push(`${relative(ROOT, file)}:${line} [${tag}]`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test("the perf and the heavy tiers each have tests to run, so a tier job is never an empty pass", async () => {
    for (const tier of ["perf", "heavy"] as const) {
      const plan = await tierTestArgs(["./studio"], tier, ROOT);
      expect(plan).toHaveLength(1);
      expect((plan[0] ?? []).filter((arg) => !arg.startsWith("-")).length).toBeGreaterThan(0);
    }
  });

  test("a node suite lists a test count for a tier exactly when its source holds tests of that tier (EVERY tier: a quarantined node test must not drop out of the quarantine run)", () => {
    for (const suite of NODE_TEST_SUITES) {
      const source = readFileSync(join(ROOT, suite.entry), "utf8");
      for (const tier of TIERS) {
        expect([suite.name, tier, suite.tierTests?.[tier] !== undefined]).toEqual([suite.name, tier, holdsTierTests(source, tier, suite.entry)]);
      }
    }
  });
});
