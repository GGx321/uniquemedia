// What a production build of Studio must look like, read from its bundles.
// Every debug door is a build-time constant (studio/engine/buildFlags.ts), so
// in a `build:studio` output it is compiled shut and nothing about it is left
// to decide at run time. Used by the smoke test on shipped packages and by
// buildFlags.test.ts on real builds of both kinds.
//
// Threat model: these checks guard against an ACCIDENTAL regression — someone
// gating the refusal on `app.isPackaged`, moving it into a helper for reuse,
// or reopening a debug switch for local convenience and forgetting to revert
// it. They do not guard against a malicious committer, who could simply edit
// this file. So the rules below are a strict whitelist of the one shape the
// refusal's compiled output may take, not a hunt for every way a determined
// author could obfuscate a bypass.

import { posix } from "node:path";

const SWITCH_NAMES = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"] as const;

/** Test-only switches and debug names that no production bundle (main, preload or renderer) may carry at all. */
const FORBIDDEN_DEBUG_MARKERS = [
  "studio-pick-folder",
  // T6c: the import photo dialog's own E2E-only switch (main.ts's pickImportFile).
  "studio-pick-import-file",
  "studio-openrouter-base-url",
  // 3c.3: the flashapi mock's E2E-only switch (main.ts's flashapiBaseUrlForTests).
  "studio-flashapi-base-url",
  // 3d.1b: the mock engine's test controls. The mock is dev-only (`select.ts` drops it from a release build), and these
  // method names exist nowhere else, so finding one in any bundle means the mock shipped.
  "failNextRender",
  "setExportDisk",
  "moveExportFolder",
  "ELECTRON_RENDERER_URL",
  "DEBUGGABLE",
  "__STUDIO_DEV__",
  "__STUDIO_E2E__",
  // Studio only ever removes remote-debugging switches, never adds one back:
  // a production bundle calling appendSwitch at all — main, preload or
  // renderer, on `app.commandLine` or on anything an alias reopens it
  // under — is itself a problem, whatever it is trying to append.
  "appendSwitch",
] as const;

/** Which of the forbidden debug markers a bundle's text carries, each reported as `contains <marker>`. */
function forbiddenMarkerProblems(bundle: string): string[] {
  return FORBIDDEN_DEBUG_MARKERS.filter((text) => bundle.includes(text)).map((text) => `contains ${text}`);
}

/** Problems with a production preload or renderer bundle: it must carry none of the markers main is also checked for. */
export function productionBundleProblems(bundle: string): string[] {
  return forbiddenMarkerProblems(bundle);
}

/** A line with no leading whitespace: esbuild's printer indents a line exactly to its nesting depth, so this is what "module top level" looks like in a bundle. */
function isColumnZero(line: string): boolean {
  return line.length > 0 && line === line.trimStart();
}

/**
 * Problems with the remote-debugging refusal in out-studio/main/main.js. A
 * strict whitelist, checked against the real shape esbuild emits (confirmed
 * by building both bypasses below for real with `bunx electron-vite build`):
 *
 * - the loop's own two lines (`for (const name of [` and the matching
 *   `]) app.commandLine.removeSwitch(name);`) must sit at column 0 — once
 *   `!DEBUGGABLE` folds to `true` the loop is a plain top-level statement, so
 *   a label, a function or an `if` wrapper all leave it indented instead;
 * - every occurrence of a switch name must be inside that loop's own array or
 *   on the one-line refusal warning, never anywhere else in the file;
 * - every access to `commandLine` must be the loop's own, or the one
 *   unrelated, already-present read of `--user-data-dir`. An alias such as
 *   `const cl = app.commandLine` adds a line that is neither, so it fails —
 *   on purpose: this rule matches one literal shape, not a family of them.
 */
function refusalShapeProblems(main: string): string[] {
  const lines = main.split("\n");
  const forIndex = lines.findIndex((line) => line.trimStart().startsWith("for (const name of ["));
  const closeIndex = lines.findIndex((line) => line.trimStart().startsWith("]) app.commandLine.removeSwitch(name);"));
  if (forIndex === -1 || closeIndex === -1) return ["the remote-debugging refusal is missing"];

  const problems: string[] = [];
  const forLine = lines[forIndex] ?? "";
  const closeLine = lines[closeIndex] ?? "";
  if (!isColumnZero(forLine)) problems.push(`the refusal loop does not start at column 0, so something wraps it: ${forLine.trim()}`);
  if (!isColumnZero(closeLine)) problems.push(`the refusal loop's removeSwitch call does not start at column 0, so something wraps it: ${closeLine.trim()}`);

  const warnIndex = lines.findIndex((line) => line.includes("console.warn") && line.includes("remote-debugging-port"));
  lines.forEach((line, i) => {
    if ((i >= forIndex && i <= closeIndex) || i === warnIndex) return;
    for (const name of SWITCH_NAMES) {
      if (line.includes(name)) problems.push(`line ${i + 1} mentions "${name}" outside the refusal loop and its warning: ${line.trim()}`);
    }
  });

  lines.forEach((line, i) => {
    if (!line.includes("commandLine") || i === closeIndex || line.includes('"user-data-dir"')) return;
    problems.push(`line ${i + 1} accesses commandLine outside the refusal loop and the --user-data-dir read: ${line.trim()}`);
  });

  return problems;
}

/** Problems with out-studio/main/main.js of a production build; empty when every door is shut. */
export function productionMainProblems(main: string): string[] {
  const problems = forbiddenMarkerProblems(main);
  if (!/devTools: (false|!1)\b/.test(main)) problems.push("DevTools are not compiled off");
  problems.push(...refusalShapeProblems(main));
  // `app.isPackaged` depends only on the executable's name: it may choose
  // where an unpackaged run keeps its data, never whether a door is open.
  const packaged = main.split("\n").filter((line) => line.includes("isPackaged"));
  if (packaged.some((line) => !line.includes('"userData"'))) {
    problems.push(`isPackaged decides more than where unpackaged data lives: ${packaged.map((line) => line.trim()).join(" | ")}`);
  }
  return problems;
}

/**
 * Problems with out-studio/engine/main.js of a production build (invariant 13): neither the OpenRouter nor the flashapi
 * base URL may be overridable. Each must be the one call with the build flag folded to `false`; a bundle that lost the
 * call altogether is a problem too, since the rule then cannot be read from it.
 */
export function productionEngineProblems(engine: string): string[] {
  const problems: string[] = [];
  // Layer one: the resolver of each base URL, with the build flag folded to false.
  if (!/resolveOpenRouterBaseUrl\(init\.openRouterBaseUrl, false\)/.test(engine)) problems.push("the engine takes an OpenRouter base-URL override");
  if (!/resolveMusicBaseUrl\(init\.musicBaseUrl, false\)/.test(engine)) problems.push("the engine takes a flashapi base-URL override");
  // Layer two: each client is built with `allowBaseUrlOverride: false`, the flag its own check reads (`checkedBaseUrl`).
  // A mutation of only this layer to true leaves the resolver shut and the client open to any loopback base.
  const openClientShut = /baseUrl: this\.#openRouterBaseUrl,\s*allowBaseUrlOverride: (false|!1),/.test(engine);
  const musicClientShut = /baseUrl: resolveMusicBaseUrl\(init\.musicBaseUrl, \w+\),\s*allowBaseUrlOverride: (false|!1),/.test(engine);
  if (!openClientShut) problems.push("the OpenRouter client is built with a base-URL override allowed");
  if (!musicClientShut) problems.push("the flashapi client is built with a base-URL override allowed");
  // Any other `true` (a third client, a reshaped call) that the two shapes above do not account for.
  const allowed = engine.match(/allowBaseUrlOverride: (true|!0)/g)?.length ?? 0;
  const named = Number(!openClientShut) + Number(!musicClientShut);
  if (allowed > named) problems.push("a client in the engine allows a base-URL override");
  // Test-only music helpers live under studio/engine/music/testing/. A persisting test sink in the bundle would turn
  // `music.refresh` on, which only the real track store (3c.4) may do.
  if (engine.includes("PersistingTestSink")) problems.push("a test-only music sink is in the engine bundle");
  if (engine.includes("hangingBody")) problems.push("a test-only music helper is in the engine bundle");
  return problems;
}

/**
 * Problems with the renderer's built CSS (fonts.css, once Vite resolves it).
 * fonts.css's `@font-face` rules import `@fontsource-variable`'s own package
 * paths, not real URLs: a built stylesheet must never ship that bare text —
 * Vite resolves each one to a real, same-origin url() for the woff2 file
 * (electron.studio.vite.config.ts's renderer assetsInlineLimit excludes
 * fonts from inlining) — otherwise the font silently fails to load. Guards
 * both directions: an unresolved import, and a build that dropped every
 * woff2 reference outright. A font inlined as a data: URI is flagged too:
 * the renderer's CSP (default-src 'self') blocks it, which is exactly why
 * assetsInlineLimit excludes woff2 in the first place.
 *
 * Comments survive minification (fonts.css's own top-of-file comment
 * mentions "@fontsource-variable's" in prose) and are stripped first, so the
 * `@fontsource` check only ever sees real CSS, not documentation about it.
 */
export function productionRendererCssProblems(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const problems: string[] = [];
  if (/url\(\s*["']?@fontsource/.test(withoutComments)) problems.push("an unresolved @fontsource url() remains in the built CSS");
  if (/url\(\s*["']?data:(font\/|application\/(x-)?font)/.test(withoutComments)) {
    problems.push("a font is inlined as a data: URI, which the renderer's CSP blocks");
  }
  // Not `\.woff2\b`: a data: URI names it as a MIME type ("data:font/woff2;base64,…"),
  // with no leading dot the way a hashed asset filename has one.
  if (!/woff2/i.test(withoutComments)) problems.push("no woff2 font reference survived the build");
  return problems;
}

/**
 * The relative module specifiers a built ESM file loads: static `import`/
 * `export ... from` and string-literal dynamic `import("...")`. Bare and
 * `node:` specifiers are not listed — only files the build itself must have
 * emitted next to the entry.
 */
export function relativeImportsOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

/**
 * T7c: problems with the engine's face worker (`out-studio/engine/faceWorker.js`).
 * It is a separate built entry that the engine loads by file URL and nothing
 * imports, so a build that silently dropped it — or shipped it without a
 * shared chunk it imports — would only fail at the first photo run. Checked
 * from the built files (`worker` is null when the file does not exist);
 * `fileExists` answers for a path relative to `out-studio/` (a build
 * directory or a packaged asar alike).
 */
export function faceWorkerProblems(engineMain: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): string[] {
  return workerEntryProblems("faceWorker", engineMain, worker, fileExists);
}

/**
 * 3b.2: the same checks for the text worker entry (`out-studio/engine/textWorker.js`), plus one that keeps resvg
 * where it belongs: its glue carries a distinctive message, and the engine bundle must not contain it, or the
 * wasm could run on the engine's own thread again.
 */
export function textWorkerProblems(engineMain: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): string[] {
  const problems = workerEntryProblems("textWorker", engineMain, worker, fileExists);
  if (engineMain.includes("Already initialized. The `initWasm()` function can be used only once.")) {
    problems.push("the engine bundle contains resvg-wasm; it must load only inside the text worker");
  }
  return problems;
}

function workerEntryProblems(name: string, engineMain: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): string[] {
  const problems: string[] = [];
  if (!new RegExp(`new URL\\(\\s*["']\\./${name}\\.js["']\\s*,\\s*import\\.meta\\.url\\s*\\)`).test(engineMain)) {
    problems.push(`the engine does not resolve "./${name}.js" against its own import.meta.url`);
  }
  if (worker === null || worker.trim().length === 0) {
    problems.push(`out-studio/engine/${name}.js is missing`);
    return problems;
  }
  if (!worker.includes("parentPort") || !worker.includes("workerData")) problems.push(`${name}.js does not use worker_threads' parentPort/workerData`);
  if (/(?:\bfrom\s*|\bimport\s*\(?\s*)["']electron["']/.test(worker)) problems.push(`${name}.js imports electron`);
  for (const specifier of relativeImportsOf(worker)) {
    if (!fileExists(posix.normalize(posix.join("engine", specifier)))) problems.push(`${name}.js imports ${specifier}, which is not in the build`);
  }
  return problems;
}
