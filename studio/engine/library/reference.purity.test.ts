import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Review (LOW 6): LibraryReference's brand (media.ts) only deters an
// ACCIDENTAL plain-Uint8Array assignment — an explicit `as LibraryReference`
// bypasses it anywhere the type is imported (TypeScript has no way to
// restrict a type-only export to one file). Two static rules keep that
// bypass rare, deliberate and reviewable, instead of relying on nobody ever
// writing it elsewhere:
// - no production file may write `as LibraryReference` outside library/,
//   where the one real mint point (Library.loadReference()) lives;
// - no production file may import from a testing/ folder in the first
//   place — otherwise a test-only escape hatch (e.g. asLibraryReference in
//   openrouter/testing/fakes.ts) could leak into real code that way instead.

const LIBRARY_DIR = dirname(fileURLToPath(import.meta.url)); // studio/engine/library
const ENGINE_DIR = dirname(LIBRARY_DIR); // studio/engine
const STUDIO_DIR = dirname(ENGINE_DIR);
const NODE_DIR = join(STUDIO_DIR, "node");

function allTsFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"))
    .map((f) => join(root, f));
}

function isTestFile(path: string): boolean {
  // `*.node-test.ts` are tests too (run under Electron's Node by electronNodeTests.ts), so they may use the test tiers (studio/testing/tiers.ts).
  return path.endsWith(".test.ts") || path.endsWith(".test.tsx") || path.endsWith(".node-test.ts");
}

/** Inside a folder named exactly "testing", anywhere in the path. */
function isUnderTestingFolder(path: string): boolean {
  return path.split(sep).includes("testing");
}

function isUnderLibraryFolder(path: string): boolean {
  return path.startsWith(LIBRARY_DIR + sep) || path === LIBRARY_DIR;
}

const allFiles = [...allTsFiles(ENGINE_DIR), ...allTsFiles(NODE_DIR)];
/** Real production code: not a test file, and not test infrastructure living in a testing/ folder. */
const production = allFiles.filter((f) => !isTestFile(f) && !isUnderTestingFolder(f));

describe("LibraryReference stays a rare, reviewable escape hatch (LOW 6)", () => {
  test("there are production files to check", () => {
    expect(production.length).toBeGreaterThan(40);
  });

  test("no production file imports from a testing/ folder", () => {
    const violations = production.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const specifiers = [
        ...[...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1] ?? ""),
        ...[...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? ""),
      ];
      return specifiers.filter((s) => s.split("/").includes("testing")).map((s) => `${relative(STUDIO_DIR, file)}: imports ${s}`);
    });
    expect(violations).toEqual([]);
  });

  test("no `as LibraryReference` outside library/", () => {
    const violations = production
      .filter((file) => !isUnderLibraryFolder(file))
      .flatMap((file) => (/\bas\s+LibraryReference\b/.test(readFileSync(file, "utf8")) ? [relative(STUDIO_DIR, file)] : []));
    expect(violations).toEqual([]);
  });
});
