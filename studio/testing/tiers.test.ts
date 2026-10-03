import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { NODE_TEST_SUITES } from "../scripts/electronNodeTests";
import { tierTestArgs } from "../scripts/realWorkerTests";
import { inQuarantineRun, QUARANTINE, quarantineEntry, type QuarantineEntry } from "./quarantine";
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
      for (const match of readFileSync(file, "utf8").matchAll(/\b(?:quarantinedTest|inQuarantineRun)\(\s*"([^"]+)"/g)) {
        const id = match[1] ?? "";
        used.set(id, [...(used.get(id) ?? []), relative(ROOT, file)]);
      }
    }
    return used;
  }

  test("every tagged test has an entry, and every entry has a tagged test (the list cannot rot)", () => {
    const used = usedIds();
    expect([...used.keys()].filter((id) => !QUARANTINE.some((e) => e.id === id))).toEqual([]);
    expect(QUARANTINE.map((e) => e.id).filter((id) => !used.has(id))).toEqual([]);
  });
});

describe("the tiers' sources", () => {
  test("a file that checks a budget is tagged for the perf run, or the perf run never selects it", () => {
    const untagged: string[] = [];
    for (const file of sourcesUnder(STUDIO)) {
      if (file.endsWith("tiers.test.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (/\bassertBudget\(/.test(source) && !tierMarkers("perf").some((marker) => source.includes(marker))) untagged.push(relative(ROOT, file));
    }
    expect(untagged).toEqual([]);
  });

  test("the perf and the heavy tiers each have tests to run, so a tier job is never an empty pass", async () => {
    for (const tier of ["perf", "heavy"] as const) {
      const plan = await tierTestArgs(["./studio"], tier, ROOT);
      expect(plan).toHaveLength(1);
      expect((plan[0] ?? []).filter((arg) => !arg.startsWith("-")).length).toBeGreaterThan(0);
    }
  });

  test("a node suite lists a perf test count exactly when its source holds the perf tag", () => {
    for (const suite of NODE_TEST_SUITES) {
      const source = readFileSync(join(ROOT, suite.entry), "utf8");
      expect([suite.name, suite.tierTests?.perf !== undefined]).toEqual([suite.name, source.includes(tierTag("perf"))]);
    }
  });
});
