import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// The montage module is imported by the renderer (the preview) and by the
// engine (the graph builder), so its production files must be pure: no I/O, no
// Bun, no Node, no clock and no randomness (the same spec and seed must always
// give the same output), and nothing outside this folder but the contract's
// montage types.
const MONTAGE_DIR = import.meta.dir;
const ENGINE_MONTAGE = resolve(MONTAGE_DIR, "../engine/montage.ts");

const productionFiles = readdirSync(MONTAGE_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.ts$/.test(e.name) && !/\.(test|testkit)\.ts$/.test(e.name))
  .map((e) => join(MONTAGE_DIR, e.name));

const FORBIDDEN =
  /\b(?:process|Buffer|Bun|require|Date|performance|crypto|setTimeout|setInterval|fetch|Intl|eval)\b|Math\.(?:random|sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt|sqrt)\b|\*\*|\.toLocale\w*|new\s+Function\b|globalThis\s*(?:\[|\.process)/g;

/**
 * A value import (or re-export) from the contract's montage module: anything
 * that is not `import type`. The contract pulls in zod, so a value import would
 * put zod into every bundle that uses this module. `import { type X }` counts:
 * only a plain `import type` is guaranteed to be erased.
 */
const VALUE_IMPORT_FROM_CONTRACT = /\b(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']\.\.\/engine\/montage["']|\bimport\s*["']\.\.\/engine\/montage["']/;

/** Import specifiers a montage production file may use: siblings, and the contract's montage module (types). */
function allowedImport(specifier: string, fromFile: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const target = resolve(dirname(fromFile), specifier);
  const inFolder = target.startsWith(MONTAGE_DIR + sep);
  return inFolder || target === ENGINE_MONTAGE.replace(/\.ts$/, "");
}

const importsOf = (code: string): string[] => new Bun.Transpiler({ loader: "ts" }).scanImports(code).map((i) => i.path);
const forbiddenIn = (code: string): string[] => new Bun.Transpiler({ loader: "ts" }).transformSync(code).match(FORBIDDEN) ?? [];

describe("studio/shared/montage is pure", () => {
  test("has production modules", () => {
    expect(productionFiles.length).toBeGreaterThanOrEqual(14);
  });

  // The typecheck of studio/shared/tsconfig.json (no Node, Bun or DOM types) is a blocking step of the CI build and canary jobs
  // (`bunx tsc --noEmit -p studio/shared/tsconfig.json`), moved there from a test that spawned the same tsc (CI-4).

  describe.each(productionFiles.map((f) => [relative(MONTAGE_DIR, f), f]))("%s", (_name, file) => {
    test("imports only sibling modules and the contract's montage types", () => {
      const foreign = importsOf(readFileSync(file, "utf8")).filter((p) => !allowedImport(p, file));
      expect(foreign).toEqual([]);
    });

    test("imports the contract's montage module for types only (so zod never reaches a bundle through it)", () => {
      expect(VALUE_IMPORT_FROM_CONTRACT.test(readFileSync(file, "utf8"))).toBe(false);
    });

    test("uses no I/O, clock, randomness, locale, eval, transcendental Math or ** (integer maths only)", () => {
      expect(forbiddenIn(readFileSync(file, "utf8"))).toEqual([]);
    });
  });
});
