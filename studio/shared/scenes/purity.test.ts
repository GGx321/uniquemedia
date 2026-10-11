import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// 5a.2 (I5.21): the scene banks and the template are shared, pure code. The engine and the renderer's mock render the same sentence from the same
// bank, so there is no clock, no randomness, no I/O, and nothing imported but zod and modules inside `studio/shared/` (draws are hash picks, never
// the uniquifier's rng).
const DIR = import.meta.dir;
const SHARED = resolve(DIR, "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const productionFiles = walk(DIR).filter((f) => /\.ts$/.test(f) && !/\.(test|testkit)\.ts$/.test(f));

const FORBIDDEN = /\b(?:process|Buffer|Bun|require|Date|performance|crypto|setTimeout|setInterval|fetch|eval)\b|Math\.random\b|new\s+Function\b|globalThis\s*(?:\[|\.process)/g;
const importsOf = (code: string): string[] => new Bun.Transpiler({ loader: "ts" }).scanImports(code).map((i) => i.path);
const forbiddenIn = (code: string): string[] => new Bun.Transpiler({ loader: "ts" }).transformSync(code).match(FORBIDDEN) ?? [];

function foreignImports(code: string, file: string): string[] {
  return importsOf(code).filter((specifier) => {
    if (specifier === "zod") return false;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return true;
    return !resolve(dirname(file), specifier).startsWith(SHARED + sep);
  });
}

describe("the scene banks' shared code is pure", () => {
  test("the checks catch a violation (negative control)", () => {
    expect(forbiddenIn("export const f = () => Date.now();")).toEqual(["Date"]);
    expect(forbiddenIn("export const f = () => Math.random();")).toEqual(["Math.random"]);
    expect(forbiddenIn("export const f = () => 1;")).toEqual([]);
    const probe = join(DIR, "probe.ts");
    expect(foreignImports('import { makeRng } from "../../../src/core/rng";', probe)).toEqual(["../../../src/core/rng"]);
    expect(foreignImports('import { fnv1a } from "../../engine/scenes/rngUtil";', probe)).toEqual(["../../engine/scenes/rngUtil"]);
    expect(foreignImports('import { readFileSync } from "node:fs";', probe)).toEqual(["node:fs"]);
    expect(foreignImports('import { z } from "zod";\nimport { POOL_TEXT_MAX } from "../engine";\nimport { pick } from "./hash";', probe)).toEqual([]);
  });

  test("there are production files to check", () => {
    expect(productionFiles.length).toBeGreaterThanOrEqual(1);
  });

  test.each(productionFiles.map((file) => [relative(DIR, file), file] as const))("%s uses no clock, randomness or I/O", (_name, file) => {
    expect(forbiddenIn(readFileSync(file, "utf8"))).toEqual([]);
  });

  test.each(productionFiles.map((file) => [relative(DIR, file), file] as const))("%s imports only zod and modules inside studio/shared", (_name, file) => {
    expect(foreignImports(readFileSync(file, "utf8"), file)).toEqual([]);
  });
});
