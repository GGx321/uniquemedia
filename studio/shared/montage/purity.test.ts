import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// The montage module is imported by the renderer (the preview) and by the
// engine (the graph builder), so its production files must be pure: no I/O, no
// Bun, no Node, no clock and no randomness (the same spec and seed must always
// give the same output), and nothing outside this folder but the contract's
// montage types.
const MONTAGE_DIR = import.meta.dir;
const ENGINE_MONTAGE = resolve(MONTAGE_DIR, "../engine/montage.ts");
const SHARED_TSCONFIG = resolve(MONTAGE_DIR, "../tsconfig.json");
const TSC = resolve(MONTAGE_DIR, "../../../node_modules/typescript/bin/tsc");

const productionFiles = readdirSync(MONTAGE_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.ts$/.test(e.name) && !/\.(test|testkit)\.ts$/.test(e.name))
  .map((e) => join(MONTAGE_DIR, e.name));

const FORBIDDEN = /\b(?:process|Buffer|Bun|require|Date|performance|crypto|setTimeout|setInterval|fetch)\b|Math\.random|globalThis\s*\[/g;

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
  ])("flags %s", (name, code) => {
    expect(forbiddenIn(code)).not.toEqual([]);
    expect(name.length).toBeGreaterThan(0);
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
    expect(productionFiles.length).toBeGreaterThanOrEqual(8);
  });

  test(
    "typechecks with no DOM, Node or Bun types (studio/shared/tsconfig.json)",
    () => {
      const r = spawnSync(process.execPath, [TSC, "-p", SHARED_TSCONFIG], { encoding: "utf8" });
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect({ status: r.status, signal: r.signal, error: r.error?.message, output }).toEqual({ status: 0, signal: null, error: undefined, output: "" });
    },
    60_000,
  );

  describe.each(productionFiles.map((f) => [relative(MONTAGE_DIR, f), f]))("%s", (_name, file) => {
    test("imports only sibling modules and the contract's montage types", () => {
      const foreign = importsOf(readFileSync(file, "utf8")).filter((p) => !allowedImport(p, file));
      expect(foreign).toEqual([]);
    });

    test("uses no process, Buffer, Bun, require, Date, timers, fetch, crypto or Math.random", () => {
      expect(forbiddenIn(readFileSync(file, "utf8"))).toEqual([]);
    });
  });
});
