import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import studioViteConfig from "../../electron.studio.vite.config";
import { productionEngineProblems, productionMainProblems } from "../scripts/bundleChecks";

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

// Every debug door (remote debugging, DevTools, the renderer URL from the
// environment, the smoke test's folder-dialog switch) is decided when the app
// is built, never by how it is launched: `app.isPackaged` depends only on the
// executable's name, so a renamed production binary must stay closed.
// Assertions report what they found, never the whole bundle.

/** Which of `texts` occur in `bundle`. */
function found(bundle: string, texts: readonly string[]): string[] {
  return texts.filter((text) => bundle.includes(text));
}

/** The bundle's lines that mention isPackaged, trimmed. */
function isPackagedLines(bundle: string): string[] {
  return bundle.split("\n").filter((line) => line.includes("isPackaged")).map((line) => line.trim());
}

describe("debug affordances are compile-time", () => {
  test("a production build refuses remote debugging and keeps DevTools off, with nothing left to decide at run time", async () => {
    const main = await mainOf(normalDir);
    expect(found(main, ["DEBUGGABLE"])).toEqual([]);
    expect(/devTools: (false|!1)\b/.test(main)).toBe(true);
    expect(found(main, ['"remote-debugging-port"'])).toEqual(['"remote-debugging-port"']);
    // The only isPackaged left is where an unpackaged run keeps its data, not a door.
    const lines = isPackagedLines(main);
    expect(lines.map((line) => line.includes('"userData"'))).toEqual([true]);
  });

  test("a production build never reads the test switches and never trusts a renderer URL from the environment", async () => {
    const main = await mainOf(normalDir);
    expect(found(main, ["studio-pick-folder", "studio-openrouter-base-url", "ELECTRON_RENDERER_URL", "__STUDIO_DEV__", "__STUDIO_E2E__"])).toEqual([]);
  });

  test("an E2E build keeps DevTools and remote debugging and reads the folder-dialog switch, but trusts no renderer URL", async () => {
    const main = await mainOf(e2eDir);
    expect(found(main, ["studio-pick-folder"])).toEqual(["studio-pick-folder"]);
    expect(/devTools: (true|!0)\b/.test(main)).toBe(true);
    expect(found(main, ['"remote-debugging-port"', "ELECTRON_RENDERER_URL"])).toEqual([]);
  });

  test("only electron-vite dev (command serve) is a development build", async () => {
    const devFlag = async (command: "serve" | "build", mode: string): Promise<unknown> => {
      const config = typeof studioViteConfig === "function" ? await studioViteConfig({ command, mode }) : await studioViteConfig;
      return config.main?.define?.__STUDIO_DEV__;
    };
    expect(await devFlag("serve", "development")).toBe("true");
    expect(await devFlag("build", "production")).toBe("false");
    expect(await devFlag("build", "development")).toBe("false");
  });
});

// The smoke test greps shipped bundles with these same rules; here they meet real builds.
describe("the smoke test's production bundle checks", () => {
  test("pass a production build", async () => {
    expect(productionMainProblems(await mainOf(normalDir))).toEqual([]);
    expect(productionEngineProblems(await engineOf(normalDir))).toEqual([]);
  });

  test("flag an E2E build: every door it keeps open is named", async () => {
    expect(productionMainProblems(await mainOf(e2eDir))).toEqual([
      "contains studio-pick-folder",
      "contains studio-openrouter-base-url",
      "DevTools are not compiled off",
      "the remote-debugging refusal is missing",
    ]);
    expect(productionEngineProblems(await engineOf(e2eDir))).toEqual(["the engine takes an OpenRouter base-URL override"]);
  });
});
