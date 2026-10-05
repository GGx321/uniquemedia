import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// Stage 3 whole-slice review M3: the upload step holds BLOB_READ_WRITE_TOKEN and imports @vercel/blob, so everything that package pulls in runs with the
// token. The dependency tree is therefore committed (a lockfile of its own, installed frozen) and the workflow's actions are pinned to commits, so a new
// release of a transitive package or a moved action tag cannot reach the token.

const here = (name: string): string => new URL(name, import.meta.url).pathname;
const workflow = readFileSync(here("../../.github/workflows/landing-downloads.yml"), "utf8");
const pkg: unknown = existsSync(here("./package.json")) ? JSON.parse(readFileSync(here("./package.json"), "utf8")) : null;
const rootPkg: unknown = JSON.parse(readFileSync(here("../../package.json"), "utf8"));

function dependencyOf(manifest: unknown, section: "dependencies" | "devDependencies", name: string): string | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const deps: unknown = Reflect.get(manifest, section);
  if (typeof deps !== "object" || deps === null) return undefined;
  const version: unknown = Reflect.get(deps, name);
  return typeof version === "string" ? version : undefined;
}

describe("the uploader's own dependency tree", () => {
  test("scripts/landing has a package.json that pins @vercel/blob to an exact version", () => {
    expect(dependencyOf(pkg, "dependencies", "@vercel/blob")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the pin is the version the repository's root already uses, so the two do not drift", () => {
    expect(dependencyOf(pkg, "dependencies", "@vercel/blob")).toBe(dependencyOf(rootPkg, "devDependencies", "@vercel/blob"));
  });

  test("a bun.lock is committed beside it and resolves that exact version", () => {
    expect(existsSync(here("./bun.lock"))).toBe(true);
    const lock = readFileSync(here("./bun.lock"), "utf8");
    const version = dependencyOf(pkg, "dependencies", "@vercel/blob") ?? "";
    expect(lock).toContain(`"@vercel/blob@${version}"`);
  });
});

describe("landing-downloads.yml", () => {
  test("installs from the lockfile, frozen, with install scripts off, in the landing folder", () => {
    expect(workflow).toMatch(/working-directory: scripts\/landing/);
    expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
  });

  test("never resolves a dependency afresh: no `bun add`, no `bun install` without the frozen lockfile", () => {
    expect(workflow).not.toMatch(/\bbun add\b/);
    const installs = workflow.split("\n").filter((line) => /\bbun install\b/.test(line) && !line.trimStart().startsWith("#"));
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) expect(line).toContain("--frozen-lockfile");
  });

  test("runs the uploader from the folder whose node_modules the frozen install made", () => {
    expect(workflow).toMatch(/bun scripts\/landing\/upload\.ts/);
    expect(workflow).not.toMatch(/RUNNER_TEMP\/uploader/);
  });

  test("every `uses:` is pinned to a full 40-character commit SHA, with its tag in a comment", () => {
    const uses = workflow.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+(\.\d+){0,2}\s*$/);
  });

  test("the Blob token is still handed to exactly one step", () => {
    expect(workflow.match(/BLOB_READ_WRITE_TOKEN: \$\{\{ secrets\.BLOB_READ_WRITE_TOKEN \}\}/g)?.length).toBe(1);
  });
});
