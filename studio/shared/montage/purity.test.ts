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

describe("the purity checks themselves catch violations (negative controls)", () => {
  test.each([
    ["process", "export const a = process.env.HOME;"],
    ["Buffer", 'export const a = Buffer.from("x");'],
    ["Bun", "export const a = Bun.version;"],
    ["require", 'export const a = require("node:fs");'],
    ["Date", "export const a = Date.now();"],
    ["Math.random", "export const a = Math.random();"],
    ["crypto", "export const a = crypto.randomUUID();"],
    ["Math.sin", "export const a = Math.sin(1);"],
    ["Math.cos", "export const a = Math.cos(1);"],
    ["Math.tan", "export const a = Math.tan(1);"],
    ["Math.exp", "export const a = Math.exp(1);"],
    ["Math.log", "export const a = Math.log(2);"],
    ["Math.pow", "export const a = Math.pow(2, 3);"],
    ["Math.atan2", "export const a = Math.atan2(1, 2);"],
    ["Math.hypot", "export const a = Math.hypot(3, 4);"],
    ["Math.cbrt", "export const a = Math.cbrt(8);"],
    ["Math.sqrt", "export const a = Math.sqrt(4);"],
    ["**", "export const a = 2 ** 3;"],
    [".toLocaleString", "export const a = (1).toLocaleString();"],
    [".toLocaleDateString", "export const a = new Object().toLocaleDateString();"],
    ["Intl", 'export const a = new Intl.NumberFormat("en");'],
    ["eval", 'export const a = eval("1");'],
    ["new Function", 'export const a = new Function("return 1");'],
    ["globalThis.process", "export const a = globalThis.process;"],
    ["globalThis[", 'export const a = globalThis["proc" + "ess"];'],
  ])("flags %s", (name, code) => {
    // The matched token must be the very thing named, not some other match.
    expect(forbiddenIn(code).some((token) => token.includes(name.replace(/^\./, "")))).toBe(true);
  });

  test("leaves ordinary integer maths alone", () => {
    expect(forbiddenIn("export const a = Math.floor(Math.min(3, Math.max(1, Math.round(2.5) * 2)) / 2) + Math.abs(-1) + Math.ceil(0.5);")).toEqual([]);
  });

  test.each([
    'import { Focus } from "../engine/montage";',
    'import { type Focus } from "../engine/montage";',
    'import { Focus,\n  Clip } from "../engine/montage";',
    'export { Focus } from "../engine/montage";',
    'export * from "../engine/montage";',
    'import "../engine/montage";',
    'import * as m from "../engine/montage";',
  ])("flags a value import from the contract: %s", (code) => {
    expect(VALUE_IMPORT_FROM_CONTRACT.test(code)).toBe(true);
  });

  test.each([
    'import type { Focus } from "../engine/montage";',
    'import type { Focus,\n  Clip } from "../engine/montage";',
    'export type { Focus } from "../engine/montage";',
    'import { FPS } from "./constants";',
  ])("accepts a type-only import: %s", (code) => {
    expect(VALUE_IMPORT_FROM_CONTRACT.test(code)).toBe(false);
  });

  test("flags an import from node or a package, and one that leaves the folder", () => {
    const from = join(MONTAGE_DIR, "x.ts");
    expect(allowedImport("node:fs", from)).toBe(false);
    expect(allowedImport("zod", from)).toBe(false);
    expect(allowedImport("../engine/state", from)).toBe(false);
    expect(allowedImport("./crop", from)).toBe(true);
    expect(allowedImport("../engine/montage", from)).toBe(true);
  });
});

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
