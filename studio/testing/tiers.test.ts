import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { NODE_TEST_SUITES } from "../scripts/electronNodeTests";
import { tierTestArgs } from "../scripts/realWorkerTests";
import { inQuarantineRun, QUARANTINE, quarantineEntry, type QuarantineEntry } from "./quarantine";
import { budgetsOutsidePerfTests, holdsTierTests, importsHeavyHelper, nameTags, quarantineIds } from "./tierSources";
import { TIERS, tierOf, tierPattern, tierTag } from "./tiers";

const ROOT = resolve(import.meta.dir, "..", "..");
const STUDIO = join(ROOT, "studio");

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : sourcesUnder(join(dir, entry.name));
    return /\.test\.tsx?$|\.node-test\.[cm]?tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [];
  });
}

describe("tierOf", () => {
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
});

describe("quarantine", () => {
  const entry: QuarantineEntry = { id: "x", runId: "37116331132", date: "2026-10-03", reason: "a flake" };

  test("an id with no entry throws, so a tag cannot exist without its entry", () => {
    expect(() => quarantineEntry("nope", [entry])).toThrow(/no entry for "nope"/);
    expect(() => inQuarantineRun("nope", { STUDIO_TEST_TIER: "quarantine" }, [entry])).toThrow(/no entry/);
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

  test("the guard sees a heavy helper passed as a value, which the heavy run's file filter would never open", () => {
    const hidden = 'import { heavyTest } from "../testing/bunTiers";\n(c ? test : heavyTest)("x", fn);';
    const direct = 'import { heavyTest } from "../testing/bunTiers";\nif (c) test("x", fn); else heavyTest("x", fn);';
    expect([importsHeavyHelper(hidden), holdsTierTests(hidden, "heavy")]).toEqual([true, false]);
    expect([importsHeavyHelper(direct), holdsTierTests(direct, "heavy")]).toEqual([true, true]);
    expect(importsHeavyHelper('import { perfTest } from "../testing/bunTiers";')).toBe(false);
  });

  test("every test file that imports heavyTest or sweepTest is opened by the heavy run: a helper passed as a value, (c ? test : heavyTest)(...), would leave its tests running nowhere", () => {
    const unopened: string[] = [];
    for (const file of sourcesUnder(STUDIO)) {
      if (file.endsWith("tiers.test.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (importsHeavyHelper(source) && !holdsTierTests(source, "heavy", file)) unopened.push(relative(ROOT, file));
    }
    expect(unopened).toEqual([]);
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
