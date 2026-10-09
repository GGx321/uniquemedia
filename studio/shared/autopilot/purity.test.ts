import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

// The autopilot's spec generator and track chooser are shared, pure code: the same input must always give the same output, so there is no
// clock, no randomness, no I/O, and nothing imported from outside `shared/` (and no VALUE import of the contract: zod stays out of the bundle).
const DIR = import.meta.dir;
const SHARED = resolve(DIR, "..");

const productionFiles = readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.ts$/.test(e.name) && !/\.(test|testkit)\.ts$/.test(e.name))
  .map((e) => join(DIR, e.name));

const FORBIDDEN = /\b(?:process|Buffer|Bun|require|Date|performance|crypto|setTimeout|setInterval|fetch|eval)\b|Math\.random\b|new\s+Function\b|globalThis\s*(?:\[|\.process)/g;
const importsOf = (code: string): string[] => new Bun.Transpiler({ loader: "ts" }).scanImports(code).map((i) => i.path);
const forbiddenIn = (code: string): string[] => new Bun.Transpiler({ loader: "ts" }).transformSync(code).match(FORBIDDEN) ?? [];

describe("the autopilot's shared code is pure", () => {
  test("the checks catch a violation (negative control)", () => {
    expect(forbiddenIn("export const f = () => Date.now();")).toEqual(["Date"]);
    expect(forbiddenIn("export const f = () => Math.random();")).toEqual(["Math.random"]);
    expect(forbiddenIn("export const f = () => 1;")).toEqual([]);
  });

  test("there are production files to check", () => {
    expect(productionFiles.length).toBeGreaterThanOrEqual(2);
  });

  test.each(productionFiles.map((file) => [file.slice(DIR.length + 1), file] as const))("%s uses no clock, randomness or I/O", (_name, file) => {
    expect(forbiddenIn(readFileSync(file, "utf8"))).toEqual([]);
  });

  test.each(productionFiles.map((file) => [file.slice(DIR.length + 1), file] as const))("%s imports only from shared/, and only types from the contract", (_name, file) => {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      expect(specifier.startsWith(".")).toBe(true);
      expect(resolve(dirname(file), specifier).startsWith(SHARED + sep)).toBe(true);
    }
    // `transformSync` erases type imports, so what remains from the contract is a value import
    const values = importsOf(new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(file, "utf8")));
    expect(values.filter((specifier) => /\/engine\/(?:montage|autopilot)$/.test(specifier))).toEqual([]);
  });
});
