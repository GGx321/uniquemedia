import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The engine runs under Electron's Node while tests run under bun, so money
// code may use only node:* APIs (plan: "Engine runtime", invariant 1).
const DIR = dirname(fileURLToPath(import.meta.url));
const PRODUCTION = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "Bun.*", pattern: /\bBun\s*\./ },
  { name: "process.env", pattern: /\bprocess\s*\.\s*env\b/ },
  { name: "import.meta.dir", pattern: /\bimport\s*\.\s*meta\s*\.\s*dir/ },
  { name: "bun:* import", pattern: /from\s+["']bun[:"']/ },
];

/** Module specifiers of static imports/re-exports, side-effect imports and dynamic import(). */
function importsOf(source: string): string[] {
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
  ];
  return patterns.flatMap((p) => [...source.matchAll(p)].map((m) => m[1] ?? ""));
}

test("the money module has production files to check", () => {
  expect(PRODUCTION).toContain("budget.ts");
  expect(PRODUCTION).toContain("ledger.ts");
});

test("money production code uses no Bun-only API and never reads process.env", () => {
  const violations = PRODUCTION.flatMap((file) => {
    const source = readFileSync(join(DIR, file), "utf8");
    return FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(({ name }) => `${file}: ${name}`);
  });

  expect(violations).toEqual([]);
});

test("money production code imports only node:*, zod and sibling modules", () => {
  const violations = PRODUCTION.flatMap((file) =>
    importsOf(readFileSync(join(DIR, file), "utf8"))
      .filter((spec) => !spec.startsWith("node:") && spec !== "zod" && !spec.startsWith("./"))
      .map((spec) => `${file}: ${spec}`)
  );

  expect(violations).toEqual([]);
});
