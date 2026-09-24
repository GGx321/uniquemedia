import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Invariant 13: the OpenRouter base-URL override exists only in an E2E build.
// Builds Studio for real (electron-vite, the same config as `build:studio`)
// into temp folders, once normally and once with STUDIO_E2E=1, and reads the
// emitted engine and main bundles. The E2E build shows the greps can see the
// override at all; the normal one must have it compiled out.
const ROOT = resolve(import.meta.dirname, "../..");
const ENGINE_CALL = /resolveOpenRouterBaseUrl\(init\.openRouterBaseUrl, (true|false)\)/;
const SWITCH = "studio-openrouter-base-url";

let normalDir = "";
let e2eDir = "";

function build(outDir: string, e2e: boolean): void {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== "STUDIO_E2E") env[name] = value;
  if (e2e) env.STUDIO_E2E = "1";
  const result = spawnSync("bunx", ["electron-vite", "build", "-c", "electron.studio.vite.config.ts", "--outDir", outDir], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`build failed:\n${result.stdout}\n${result.stderr}`);
}

beforeAll(async () => {
  normalDir = await mkdtemp(join(tmpdir(), "studio-build-normal-"));
  e2eDir = await mkdtemp(join(tmpdir(), "studio-build-e2e-"));
  build(normalDir, false);
  build(e2eDir, true);
}, 120_000);

afterAll(async () => {
  await rm(normalDir, { recursive: true, force: true });
  await rm(e2eDir, { recursive: true, force: true });
});

// With --outDir, electron-vite puts the main-process build (both entries) under <outDir>/main.
const engineOf = (dir: string) => readFile(join(dir, "main", "engine", "main.js"), "utf8");
const mainOf = (dir: string) => readFile(join(dir, "main", "main", "main.js"), "utf8");

describe("the E2E build flag", () => {
  test("an E2E build lets the engine take the override and main read it (so the greps below can see it)", async () => {
    expect((await engineOf(e2eDir)).match(ENGINE_CALL)?.[1]).toBe("true");
    expect(await mainOf(e2eDir)).toContain(SWITCH);
  });

  test("a normal build compiles the flag to false: the engine ignores any override and main never reads one", async () => {
    const engine = await engineOf(normalDir);
    expect(engine.match(ENGINE_CALL)?.[1]).toBe("false");
    expect(engine).not.toContain("__STUDIO_E2E__");
    const main = await mainOf(normalDir);
    expect(main).not.toContain(SWITCH);
    expect(main).not.toContain("__STUDIO_E2E__");
  });
});
