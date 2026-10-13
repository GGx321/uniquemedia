import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

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

// 5b.1 (S5.V2): `videoEstimate.ts` prices a clip through the formulas the engine and the mock share (`shared/engine/clips.ts`, plan s5b1 §5.9). These two shared modules are the
// only others allowed, and the test after the next one pins that they (and everything they import) are pure: zod and relative modules under `studio/shared` only.
const SHARED_PURE = ["../../shared/engine/clips", "../../shared/engine/estimate"];

// `../buildFlags` is the one module outside money that is allowed: build-time constants and nothing else (no imports of its
// own), which the E2E build reads to shorten the reconcile wait and the request timeout.
test("money production code imports only node:*, zod, sibling modules and the build flags", () => {
  const violations = PRODUCTION.flatMap((file) =>
    importsOf(readFileSync(join(DIR, file), "utf8"))
      .filter((spec) => !spec.startsWith("node:") && spec !== "zod" && !spec.startsWith("./") && spec !== "../buildFlags" && !SHARED_PURE.includes(spec))
      .map((spec) => `${file}: ${spec}`)
  );

  expect(violations).toEqual([]);
});

test("the build flags module the money code may import has no imports of its own", () => {
  const source = readFileSync(join(DIR, "..", "buildFlags.ts"), "utf8");
  expect(importsOf(source)).toEqual([]);
});

/** Every file the shared module reaches through relative imports, itself included. */
function reachableFrom(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of importsOf(readFileSync(entry, "utf8"))) {
    if (spec.startsWith(".")) reachableFrom(`${resolve(dirname(entry), spec)}.ts`, seen);
  }
  return seen;
}

test("the shared modules the money code may import are pure: zod and relative modules under studio/shared only", () => {
  const sharedRoot = resolve(DIR, "..", "..", "shared") + sep;
  const files = SHARED_PURE.flatMap((spec) => [...reachableFrom(`${resolve(DIR, spec)}.ts`)]);

  const violations = files.flatMap((file) => [
    ...(file.startsWith(sharedRoot) ? [] : [`${file}: outside studio/shared`]),
    ...importsOf(readFileSync(file, "utf8"))
      .filter((spec) => spec !== "zod" && !spec.startsWith("."))
      .map((spec) => `${file}: ${spec}`),
  ]);

  expect(files.length).toBeGreaterThan(SHARED_PURE.length);
  expect(violations).toEqual([]);
});
