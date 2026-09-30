import { describe, expect, test } from "bun:test";
import { faceWorkerProblems, productionBundleProblems, productionEngineProblems, productionMainProblems, productionRendererCssProblems, relativeImportsOf, textWorkerProblems } from "./bundleChecks";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// A stand-in for a real production main.js: the exact, unconditional shape
// esbuild emits for studio/main/main.ts's `if (!DEBUGGABLE) { for (...) ... }`
// once DEBUGGABLE is inlined to `false` and the dead `if` is folded away (see
// buildFlags.test.ts, which checks this against a real build), plus the one
// unrelated, pre-existing read of `--user-data-dir` through the same
// `app.commandLine` object, and the `isPackaged` line another check reads.
const CLEAN_MAIN = `
for (const name of [
	"remote-debugging-port",
	"remote-debugging-pipe",
	"remote-debugging-address"
]) app.commandLine.removeSwitch(name);
if (process.argv.some((arg) => arg.startsWith("--remote-debugging-"))) console.warn("studio: ignoring --remote-debugging-port/--remote-debugging-pipe/--remote-debugging-address (production build)");
var devToolsFlag = false;
new BrowserWindow({ webPreferences: { devTools: false } });
var userDataSwitch = app.commandLine.getSwitchValue("user-data-dir");
else if (!app.isPackaged) app.setPath("userData", join(x, "uniquemedia-studio-dev"));
`;

describe("productionMainProblems: the remote-debugging refusal must match one strict, whitelisted shape", () => {
  test("passes a bundle with the refusal's real shape", () => {
    expect(productionMainProblems(CLEAN_MAIN)).toEqual([]);
  });

  test("still reports the refusal missing when the bundle has no removeSwitch call at all (e.g. an E2E build)", () => {
    expect(productionMainProblems("var x = 1;")).toContain("the remote-debugging refusal is missing");
  });

  test("fails a bundle where esbuild folded the refusal behind `if (app.isPackaged)`", () => {
    // The real shape esbuild produces for `if (!DEBUGGABLE) { if (app.isPackaged) { for (...) ... } }`
    // once the dead-code elimination of `!DEBUGGABLE` runs: the outer, always-true
    // branch disappears and only the inner, real runtime condition is left —
    // confirmed by building this exact mutation of studio/main/main.ts with
    // `bunx electron-vite build`. Whatever wraps it, the loop's own two lines
    // stop sitting at column 0.
    const mutated = CLEAN_MAIN.replace(
      'for (const name of [\n\t"remote-debugging-port",\n\t"remote-debugging-pipe",\n\t"remote-debugging-address"\n]) app.commandLine.removeSwitch(name);',
      'if (app.isPackaged) {\n\tfor (const name of [\n\t\t"remote-debugging-port",\n\t\t"remote-debugging-pipe",\n\t\t"remote-debugging-address"\n\t]) app.commandLine.removeSwitch(name);\n}',
    );
    const problems = productionMainProblems(mutated);
    expect(problems.some((p) => p.includes("does not start at column 0"))).toBe(true);
  });

  test("fails a bundle where the refusal was moved into a function called conditionally elsewhere", () => {
    // The reviewer's first bypass: `function closeDebugDoors() {...}` at
    // indent 0, called by `if (...) closeDebugDoors();`. A function boundary
    // indents its body one level, same as any other wrapper — the column-0
    // rule catches this without needing to know "function" is special.
    const mutated = CLEAN_MAIN.replace(
      'for (const name of [\n\t"remote-debugging-port",\n\t"remote-debugging-pipe",\n\t"remote-debugging-address"\n]) app.commandLine.removeSwitch(name);',
      'function closeDebugDoors() {\n\tfor (const name of [\n\t\t"remote-debugging-port",\n\t\t"remote-debugging-pipe",\n\t\t"remote-debugging-address"\n\t]) app.commandLine.removeSwitch(name);\n}\nif (process.env.STUDIO_SKIP_HARDENING !== "1") closeDebugDoors();',
    );
    const problems = productionMainProblems(mutated);
    expect(problems.some((p) => p.includes("does not start at column 0"))).toBe(true);
  });

  test("fails a bundle where the refusal sits in a labeled block a runtime check can `break` out of", () => {
    // The reviewer's second-round bypass: `refusal: { if (cond) break refusal; for (...) ... }`.
    // Confirmed against a real build of this exact mutation of main.ts: the
    // label survives (esbuild cannot fold away a real `break` target), and it
    // indents the loop by one level, same as any other wrapper.
    const mutated = CLEAN_MAIN.replace(
      'for (const name of [\n\t"remote-debugging-port",\n\t"remote-debugging-pipe",\n\t"remote-debugging-address"\n]) app.commandLine.removeSwitch(name);',
      'refusal: {\n\tif (process.env.STUDIO_SNEAK === "1") break refusal;\n\tfor (const name of [\n\t\t"remote-debugging-port",\n\t\t"remote-debugging-pipe",\n\t\t"remote-debugging-address"\n\t]) app.commandLine.removeSwitch(name);\n}',
    );
    const problems = productionMainProblems(mutated);
    expect(problems.some((p) => p.includes("does not start at column 0"))).toBe(true);
  });

  test("fails a bundle where an alias reopens a switch: `var cl = app.commandLine; ... cl.appendSwitch(...)`", () => {
    // The reviewer's second-round bypass: an alias defeats a check that only
    // matches the literal `app.commandLine.x(...)` text. Confirmed against a
    // real build of this exact mutation of main.ts. Three independent things
    // now catch it: `appendSwitch` is a forbidden marker outright, the alias
    // line is a `commandLine` access the whitelist does not expect, and the
    // switch name on the `cl.appendSwitch(...)` line sits outside the loop
    // and the one-line warning.
    const mutated = `${CLEAN_MAIN}var cl = app.commandLine;\nif (process.env.STUDIO_SNEAK === "1") cl.appendSwitch("remote-debugging-port", "9222");\n`;
    const problems = productionMainProblems(mutated);
    expect(problems).toContain("contains appendSwitch");
    expect(problems.some((p) => p.includes("accesses commandLine outside the refusal loop"))).toBe(true);
    expect(problems.some((p) => p.includes('mentions "remote-debugging-port" outside the refusal loop'))).toBe(true);
  });

  test("fails a bundle with a second, duplicate removeSwitch call for a switch name outside the loop", () => {
    const mutated = `${CLEAN_MAIN}app.commandLine.removeSwitch("remote-debugging-pipe");\n`;
    const problems = productionMainProblems(mutated);
    expect(problems.some((p) => p.includes('mentions "remote-debugging-pipe" outside the refusal loop'))).toBe(true);
    expect(problems.some((p) => p.includes("accesses commandLine outside the refusal loop"))).toBe(true);
  });

  test("does not flag the one unrelated, pre-existing `--user-data-dir` read through the same commandLine object", () => {
    // Sanity check that the whitelist's one carve-out is exercised: CLEAN_MAIN
    // already contains this line, and the base "passes" test above covers it,
    // but this pins the exact reason it is allowed.
    expect(CLEAN_MAIN).toContain('app.commandLine.getSwitchValue("user-data-dir")');
    expect(productionMainProblems(CLEAN_MAIN).some((p) => p.includes("accesses commandLine"))).toBe(false);
  });
});

describe("productionBundleProblems: preload and renderer bundles are scanned for the same markers as main", () => {
  test("passes a bundle with none of the forbidden markers", () => {
    expect(productionBundleProblems("module.exports = {};")).toEqual([]);
  });

  test("flags a debug switch name leaking into the preload bundle", () => {
    expect(productionBundleProblems('const SWITCH = "studio-pick-folder";')).toEqual(["contains studio-pick-folder"]);
  });

  // T6c: the import photo dialog's own E2E-only switch, compiled out of
  // production exactly like studio-pick-folder.
  test("flags the import dialog's E2E switch leaking anywhere", () => {
    expect(productionBundleProblems('const SWITCH = "studio-pick-import-file";')).toEqual(["contains studio-pick-import-file"]);
  });

  test("flags a debug switch name leaking into the renderer bundle", () => {
    expect(productionBundleProblems('fetch("studio-openrouter-base-url")')).toEqual(["contains studio-openrouter-base-url"]);
  });

  test.each(["failNextRender", "setExportDisk", "moveExportFolder"])("flags the mock engine's test control %s in a bundle: the mock must never ship", (control) => {
    expect(productionBundleProblems(`engine.${control}(1);`)).toEqual([`contains ${control}`]);
  });

  test("flags the flashapi mock's E2E switch leaking anywhere", () => {
    expect(productionBundleProblems('const SWITCH = "studio-flashapi-base-url";')).toEqual(["contains studio-flashapi-base-url"]);
  });

  test("flags the dev-server env var and the build-time flag names if they leak anywhere", () => {
    const bundle = "const a = ELECTRON_RENDERER_URL; const b = __STUDIO_DEV__; const c = __STUDIO_E2E__; const d = DEBUGGABLE;";
    expect(productionBundleProblems(bundle)).toEqual([
      "contains ELECTRON_RENDERER_URL",
      "contains DEBUGGABLE",
      "contains __STUDIO_DEV__",
      "contains __STUDIO_E2E__",
    ]);
  });

  test("flags appendSwitch leaking into preload or renderer, whatever it is trying to append", () => {
    // Studio only ever removes remote-debugging switches; it never appends
    // any switch anywhere, so the mere presence of the identifier is itself
    // the problem — an alias in preload or renderer code could otherwise
    // reopen a switch this scan cannot see coming.
    expect(productionBundleProblems('x.appendSwitch("whatever")')).toEqual(["contains appendSwitch"]);
  });
});

describe("productionEngineProblems", () => {
  // The shapes esbuild emits for a production build (the build flag folded to `false`), one per layer of each rule.
  const OPEN_RESOLVE = "resolveOpenRouterBaseUrl(init.openRouterBaseUrl, false);";
  const OPEN_CLIENT = "baseUrl: this.#openRouterBaseUrl,\n\t\t\tallowBaseUrlOverride: false,";
  const MUSIC_CLIENT = "baseUrl: resolveMusicBaseUrl(init.musicBaseUrl, false),\n\t\t\tallowBaseUrlOverride: false,";
  const bundle = (...parts: string[]) => parts.join("\n");
  const SHUT = bundle(OPEN_RESOLVE, OPEN_CLIENT, MUSIC_CLIENT);

  test("passes an engine bundle that allows neither the OpenRouter nor the flashapi base-URL override, at either layer", () => {
    expect(productionEngineProblems(SHUT)).toEqual([]);
  });

  test("flags an engine bundle built with the E2E override kept", () => {
    expect(productionEngineProblems(bundle("resolveOpenRouterBaseUrl(init.openRouterBaseUrl, true);", OPEN_CLIENT, MUSIC_CLIENT))).toEqual(["the engine takes an OpenRouter base-URL override"]);
  });

  test("flags a flashapi base-URL override kept in the engine's resolver, on its own", () => {
    expect(productionEngineProblems(bundle(OPEN_RESOLVE, OPEN_CLIENT, MUSIC_CLIENT.replace("init.musicBaseUrl, false", "init.musicBaseUrl, true")))).toEqual(["the engine takes a flashapi base-URL override"]);
  });

  test("flags a flashapi client built with the override allowed although the resolver is shut: the second layer", () => {
    expect(productionEngineProblems(bundle(OPEN_RESOLVE, OPEN_CLIENT, MUSIC_CLIENT.replace("allowBaseUrlOverride: false", "allowBaseUrlOverride: true")))).toEqual([
      "the flashapi client is built with a base-URL override allowed",
    ]);
  });

  test("flags an OpenRouter client built with the override allowed, in either spelling of true", () => {
    for (const spelled of ["true", "!0"]) {
      expect(productionEngineProblems(bundle(OPEN_RESOLVE, OPEN_CLIENT.replace("false", spelled), MUSIC_CLIENT))).toEqual(["the OpenRouter client is built with a base-URL override allowed"]);
    }
  });

  test("flags any client anywhere that allows the override, even one the two shapes above do not name", () => {
    expect(productionEngineProblems(bundle(SHUT, "createOtherClient({ allowBaseUrlOverride: true });"))).toEqual(["a client in the engine allows a base-URL override"]);
  });

  test("flags an engine bundle that lost the flashapi resolver altogether, so a silent rewrite cannot slip through", () => {
    expect(productionEngineProblems(bundle(OPEN_RESOLVE, OPEN_CLIENT))).toEqual(["the engine takes a flashapi base-URL override", "the flashapi client is built with a base-URL override allowed"]);
  });

  test("flags a test-only sink that made it into the engine bundle: it would turn the music refresh on", () => {
    expect(productionEngineProblems(bundle(SHUT, "class PersistingTestSink { persistent = true; }"))).toEqual(["a test-only music sink is in the engine bundle"]);
    expect(productionEngineProblems(bundle(SHUT, "const hangingBody = () => {};"))).toEqual(["a test-only music helper is in the engine bundle"]);
  });

  test("flags every layer when everything is kept", () => {
    expect(
      productionEngineProblems(
        bundle("resolveOpenRouterBaseUrl(init.openRouterBaseUrl, true);", OPEN_CLIENT.replace("false", "true"), MUSIC_CLIENT.replace(/false/g, "true")),
      ),
    ).toEqual([
      "the engine takes an OpenRouter base-URL override",
      "the engine takes a flashapi base-URL override",
      "the OpenRouter client is built with a base-URL override allowed",
      "the flashapi client is built with a base-URL override allowed",
    ]);
  });
});

describe("productionRendererCssProblems: fonts.css must resolve to real asset references, never bare @fontsource text", () => {
  test("passes CSS with a resolved woff2 reference and no @fontsource text", () => {
    const css = '@font-face{src:url(./assets/martian-mono-cyrillic-ext-abc123.woff2) format("woff2")}';
    expect(productionRendererCssProblems(css)).toEqual([]);
  });

  test("a comment that mentions @fontsource is not a problem", () => {
    // fonts.css's own top-of-file comment survives minification and mentions
    // "@fontsource-variable's" in prose — that is not an unresolved import,
    // just documentation, and must not fail a real `bun run build:studio`.
    const css =
      "/* The files are @fontsource-variable's (the same Google files). */\n" +
      '@font-face{src:url(./assets/martian-mono-cyrillic-ext-abc123.woff2) format("woff2")}';
    expect(productionRendererCssProblems(css)).toEqual([]);
  });

  test("an unresolved url(@fontsource/...) is a problem", () => {
    const css = 'src:url("@fontsource-variable/martian-mono/files/martian-mono-cyrillic-ext-wght-normal.woff2") format("woff2")';
    expect(productionRendererCssProblems(css)).toContain("an unresolved @fontsource url() remains in the built CSS");
  });

  test("a woff2 inlined as a data: URI is a problem: the renderer's CSP (default-src 'self') blocks it", () => {
    const css = '@font-face{src:url(data:font/woff2;base64,AAAA) format("woff2")}';
    expect(productionRendererCssProblems(css)).toContain("a font is inlined as a data: URI, which the renderer's CSP blocks");
  });

  test("flags CSS with no woff2 reference at all", () => {
    expect(productionRendererCssProblems("body { color: red; }")).toContain("no woff2 font reference survived the build");
  });
});

// T7c: the face worker is a separate built entry that the engine loads by
// file URL and nothing imports, so a build that silently dropped it would
// only fail at the first photo run. These checks make that a build failure.

const ENGINE_WITH_WORKER = 'const FACE_WORKER_URL = new URL("./faceWorker.js", import.meta.url);\nspawn(FACE_WORKER_URL);';
const WORKER = [
  'import { i as imageSize } from "../media-Cef_5W6L.js";',
  'import { n as FaceWorkerRequestSchema } from "../protocol-Dhrd3x2Q.js";',
  'import { readFile } from "node:fs/promises";',
  'import { parentPort, workerData } from "node:worker_threads";',
  "parentPort.postMessage(workerData);",
].join("\n");
const ALL_PRESENT = (path: string): boolean => ["engine/faceWorker.js", "media-Cef_5W6L.js", "protocol-Dhrd3x2Q.js"].includes(path);

describe("relativeImportsOf", () => {
  test("lists static and string-literal dynamic relative imports, and nothing else", () => {
    const source = [
      'import { a } from "../chunk-a.js";',
      'import "./side-effect.js";',
      'export { b } from "../chunk-b.js";',
      'import { readFile } from "node:fs/promises";',
      'import * as ort from "onnxruntime-web";',
      'const lazy = await import("../chunk-c.js");',
    ].join("\n");
    expect(relativeImportsOf(source)).toEqual(["../chunk-a.js", "./side-effect.js", "../chunk-b.js", "../chunk-c.js"]);
  });
});

describe("faceWorkerProblems", () => {
  test("passes a build whose engine points at a worker entry that is a worker thread with every chunk it imports present", () => {
    expect(faceWorkerProblems(ENGINE_WITH_WORKER, WORKER, ALL_PRESENT)).toEqual([]);
  });

  test("fails when the worker entry was not built", () => {
    expect(faceWorkerProblems(ENGINE_WITH_WORKER, null, ALL_PRESENT)).toContain("out-studio/engine/faceWorker.js is missing");
  });

  test("fails when the worker entry is empty", () => {
    expect(faceWorkerProblems(ENGINE_WITH_WORKER, "", ALL_PRESENT)).toContain("out-studio/engine/faceWorker.js is missing");
  });

  test("fails when the engine no longer spawns it by that file URL", () => {
    expect(faceWorkerProblems("spawn();", WORKER, ALL_PRESENT)).toContain('the engine does not resolve "./faceWorker.js" against its own import.meta.url');
  });

  test("fails when the worker entry is not a worker thread at all", () => {
    expect(faceWorkerProblems(ENGINE_WITH_WORKER, "console.log(1);", ALL_PRESENT)).toContain("faceWorker.js does not use worker_threads' parentPort/workerData");
  });

  test("fails when a shared chunk the worker imports is missing", () => {
    const problems = faceWorkerProblems(ENGINE_WITH_WORKER, WORKER, (path) => path !== "protocol-Dhrd3x2Q.js");
    expect(problems).toEqual(["faceWorker.js imports ../protocol-Dhrd3x2Q.js, which is not in the build"]);
  });

  test("fails when the worker imports electron (the engine must stay Electron-free)", () => {
    const problems = faceWorkerProblems(ENGINE_WITH_WORKER, `${WORKER}\nimport { app } from "electron";`, ALL_PRESENT);
    expect(problems).toContain("faceWorker.js imports electron");
  });
});

describe("textWorkerProblems", () => {
  const ENGINE = 'const url = new URL("./textWorker.js", import.meta.url);';
  const PRESENT = (path: string): boolean => ["engine/textWorker.js", "shared-Abc123.js"].includes(path);
  const TEXT_WORKER = `import { parentPort, workerData } from "node:worker_threads";\nimport { z } from "../shared-Abc123.js";`;

  test("passes a build whose engine spawns the text worker by file URL and whose worker is a worker thread with its chunks present", () => {
    expect(textWorkerProblems(ENGINE, TEXT_WORKER, PRESENT)).toEqual([]);
  });

  test("fails when the text worker entry was not built", () => {
    expect(textWorkerProblems(ENGINE, null, PRESENT)).toContain("out-studio/engine/textWorker.js is missing");
  });

  test("fails when the engine no longer spawns it by that file URL", () => {
    expect(textWorkerProblems("spawn();", TEXT_WORKER, PRESENT)).toContain('the engine does not resolve "./textWorker.js" against its own import.meta.url');
  });

  test("fails when the entry is not a worker thread, imports electron, or misses a chunk", () => {
    expect(textWorkerProblems(ENGINE, "console.log(1);", PRESENT)).toContain("textWorker.js does not use worker_threads' parentPort/workerData");
    expect(textWorkerProblems(ENGINE, `${TEXT_WORKER}\nimport { app } from "electron";`, PRESENT)).toContain("textWorker.js imports electron");
    expect(textWorkerProblems(ENGINE, TEXT_WORKER, (path) => path !== "shared-Abc123.js")).toEqual(["textWorker.js imports ../shared-Abc123.js, which is not in the build"]);
  });

  test("fails when the engine bundle carries resvg's glue, which belongs in the worker only", () => {
    const problems = textWorkerProblems(`${ENGINE}\nconst e = "Already initialized. The \`initWasm()\` function can be used only once.";`, TEXT_WORKER, PRESENT);
    expect(problems).toContain("the engine bundle contains resvg-wasm; it must load only inside the text worker");
  });
});
