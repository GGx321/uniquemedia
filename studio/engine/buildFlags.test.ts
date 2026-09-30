import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import studioViteConfig from "../../electron.studio.vite.config";
import { productionEngineBundleProblems, productionMainProblems, productionMoneyTimingProblems } from "../scripts/bundleChecks";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Invariant 13: the OpenRouter base-URL override exists only in an E2E build.
// Builds Studio for real (electron-vite, the same config as `build:studio`)
// into temp folders, once normally and once with STUDIO_E2E=1, and reads the
// emitted engine and main bundles. The E2E build shows the greps can see the
// override at all; the normal one must have it compiled out.
const ROOT = resolve(import.meta.dirname, "../..");
const ENGINE_CALL = /resolveOpenRouterBaseUrl\(init\.openRouterBaseUrl, (true|false)\)/;
const SWITCH = "studio-openrouter-base-url";
const MUSIC_ENGINE_CALL = /resolveMusicBaseUrl\(init\.musicBaseUrl, (true|false)\)/;
const MUSIC_SWITCH = "studio-flashapi-base-url";

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

/** The shared chunks of a build: every `.js` beside the entries' folders (`<outDir>/main/*.js`), where the money core lands. */
async function chunksOf(dir: string): Promise<string> {
  const folder = join(dir, "main");
  const names = (await readdir(folder)).filter((name) => name.endsWith(".js"));
  return (await Promise.all(names.map((name) => readFile(join(folder, name), "utf8")))).join("\n");
}

// The money timings the E2E smoke shortens (money/budget.ts, money/reconcile.ts) are checked here, on every push, and not only
// when the packaging steps run: a positive control (the E2E build must be caught by the same check) beside the real one.
describe("the E2E build's shortened money timings", () => {
  test("a normal build carries the real 120 s reconcile wait and 180 s request timeout", async () => {
    expect(productionMoneyTimingProblems(await chunksOf(normalDir))).toEqual([]);
  });

  test("an E2E build carries the short ones, and the production check catches it (so the check can see them at all)", async () => {
    const chunks = await chunksOf(e2eDir);
    expect(chunks).toMatch(/^var RECONCILE_QUIET_MS = 5e3;$/m);
    expect(chunks).toMatch(/^var REQUEST_TIMEOUT_MS = 15e3;$/m);
    expect(productionMoneyTimingProblems(chunks)).toEqual(["RECONCILE_QUIET_MS is not the production 120 s (or was not found)", "REQUEST_TIMEOUT_MS is not the production 180 s (or was not found)"]);
  });
});

describe("the E2E build flag", () => {
  test("an E2E build lets the engine take the override and main read it (so the greps below can see it)", async () => {
    expect((await engineOf(e2eDir)).match(ENGINE_CALL)?.[1]).toBe("true");
    expect(await mainOf(e2eDir)).toContain(SWITCH);
  });

  test("an E2E build lets the engine take the flashapi override and main read its switch", async () => {
    expect((await engineOf(e2eDir)).match(MUSIC_ENGINE_CALL)?.[1]).toBe("true");
    expect(await mainOf(e2eDir)).toContain(MUSIC_SWITCH);
  });

  test("a normal build compiles the flashapi override out: the engine ignores it and main never reads its switch", async () => {
    expect((await engineOf(normalDir)).match(MUSIC_ENGINE_CALL)?.[1]).toBe("false");
    expect(await mainOf(normalDir)).not.toContain(MUSIC_SWITCH);
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
    expect(found(main, ["studio-pick-folder", "studio-pick-import-file", "studio-openrouter-base-url", "studio-flashapi-base-url", "ELECTRON_RENDERER_URL", "__STUDIO_DEV__", "__STUDIO_E2E__"])).toEqual([]);
  });

  test("an E2E build keeps DevTools and remote debugging and reads the folder- and import-photo-dialog switches, but trusts no renderer URL", async () => {
    const main = await mainOf(e2eDir);
    expect(found(main, ["studio-pick-folder", "studio-pick-import-file"])).toEqual(["studio-pick-folder", "studio-pick-import-file"]);
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
    expect(productionEngineBundleProblems(await engineOf(normalDir), await chunksOf(normalDir))).toEqual([]);
  });

  test("flag an E2E build: every door it keeps open is named", async () => {
    expect(productionMainProblems(await mainOf(e2eDir))).toEqual([
      "contains studio-pick-folder",
      // T6c: the import photo dialog's own E2E-only switch, live in an E2E
      // build exactly like studio-pick-folder — compiled out of production
      // (see the passing "pass a production build" test above).
      "contains studio-pick-import-file",
      "contains studio-openrouter-base-url",
      "contains studio-flashapi-base-url",
      // 3c.4: the mock CDN's E2E-only switch, live in an E2E build and compiled out of production.
      "contains studio-music-cdn-base-url",
      "DevTools are not compiled off",
      "the remote-debugging refusal is missing",
    ]);
    expect(productionEngineBundleProblems(await engineOf(e2eDir), await chunksOf(e2eDir))).toEqual([
      "the engine takes an OpenRouter base-URL override",
      "the engine takes a flashapi base-URL override",
      "the OpenRouter client is built with a base-URL override allowed",
      "the flashapi client is built with a base-URL override allowed",
      // 3c.4: the loopback transport is in an E2E bundle and absent from a production one.
      "the mock-CDN transport is in the engine bundle",
      // 3a.9: the commit hold the packaged E2E arms; compiled out of production (the passing test above).
      "a test-only commit hold is in the engine bundle",
    ]);
  });
});
