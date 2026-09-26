import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// M6: the root testSetup.ts registers happy-dom globally for the whole repo
// (shared with the uniquifier, which may depend on that — never changed from
// here), replacing AbortController/AbortSignal. studio/engine, studio/main,
// studio/node and studio/scripts run under Electron's Node in production and
// must never be tested against anything else (plan: "Engine runtime",
// invariant 1), so every test file in those four folders must call
// useNativeGlobals() (./nativeGlobals.ts) — otherwise a new test could
// silently exercise happy-dom's AbortController/AbortSignal instead of the
// native ones Electron's Node gives the engine, and pass for the wrong
// reason. studio/renderer and studio/shared are not covered here: renderer
// code is DOM code happy-dom exists for, and shared/engine is pure,
// environment-agnostic contract code that never touches AbortController/
// AbortSignal at all (studio/shared/engine/purity.test.ts pins that it
// cannot reach any global, DOM included) — swapping either would add risk
// for no behavioral difference.
const TESTING_DIR = dirname(fileURLToPath(import.meta.url));
const STUDIO_DIR = dirname(TESTING_DIR);
const COVERED_DIRS = ["engine", "main", "node", "scripts"];

function allTestFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .filter((f): f is string => typeof f === "string" && /\.test\.tsx?$/.test(f))
    .map((f) => join(root, f));
}

/**
 * Exactly one call at column 0: a module-top-level statement. An indented
 * call sits inside a describe (the swap would then cover only that block) and
 * a commented-out one does nothing; neither may count.
 */
function callsHelperAtTopLevel(source: string): boolean {
  return (source.match(/^useNativeGlobals\(\);[ \t]*\r?$/gm) ?? []).length === 1;
}

const files = COVERED_DIRS.flatMap((dir) => allTestFiles(join(STUDIO_DIR, dir)));

test("there are test files to check in engine, main, node and scripts", () => {
  expect(files.length).toBeGreaterThan(60);
});

test("every test file in engine, main, node and scripts imports and calls useNativeGlobals()", () => {
  const violations = files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const importsHelper = /\bfrom\s+["'][^"']*\/testing\/nativeGlobals["']/.test(source);
    return importsHelper && callsHelperAtTopLevel(source) ? [] : [relative(STUDIO_DIR, file)];
  });
  expect(violations).toEqual([]);
});

test("the rule counts only one uncommented, module-top-level call", () => {
  expect(callsHelperAtTopLevel("import x;\nuseNativeGlobals();\n")).toBe(true);
  expect(callsHelperAtTopLevel("import x;\r\nuseNativeGlobals();\r\n")).toBe(true);
  expect(callsHelperAtTopLevel("import x;\n// useNativeGlobals();\n")).toBe(false);
  expect(callsHelperAtTopLevel('describe("a", () => {\n  useNativeGlobals();\n});\n')).toBe(false);
  expect(callsHelperAtTopLevel("useNativeGlobals();\nuseNativeGlobals();\n")).toBe(false);
  expect(callsHelperAtTopLevel("import x;\n")).toBe(false);
});
