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
  // 3f.1: the own-media dialog's E2E-only switch (main.ts's pickedMediaForTests). A picked path must never be settable from a shipped build's command line.
  "studio-pick-media",
  "studio-openrouter-base-url",
  // 3c.3: the flashapi mock's E2E-only switch (main.ts's flashapiBaseUrlForTests).
  "studio-flashapi-base-url",
  // 3d.1b: the mock engine's test controls. The mock is dev-only (`select.ts` drops it from a release build), and these
  // method names exist nowhere else, so finding one in any bundle means the mock shipped.
  "failNextRender",
  "setExportDisk",
  "moveExportFolder",
  // 3e.3: the mock's stand-in for main's folder dialog.
  "pickExportFolderNext",
  // 3f.1: the mock's stand-in for main's own-media dialog.
  "pickMediaNext",
  // 3f.1b: the mock's own-media jobs (a held import, and the class that plays them): the mock is dev-only.
  "holdImports",
  "MockOwnMedia",
  // 3c.6: the mock's scripted music refresh failure and its stand-in for a damaged quota log.
  "failNextMusicRefresh",
  "setMusicQuotaLog",
  // 3d.1b: the mock's stored tracks, its held text drawing (a queued preview becomes TEXT_PREVIEW_SUPERSEDED) and the picture
  // it serves for a preview id (the dev build's stand-in for `studio-media://text/<previewId>`).
  "seedMusicTracks",
  "holdTextDrawing",
  "releaseTextDrawing",
  "mockPreviewPng",
  // 3d.1b review: the mock's invented demo tracks (ids `demo-track-NNNN`) were built at module load, so they shipped.
  "demo-track-",
  // 3e.2: the dev build's demo videos (Mia's records in every file state): the mock's option and the method that seeds them.
  "demoVideos",
  "seedDemoVideos",
  // 3f.5: the dev build's own sticker (a seeded record, its option, and the stand-in for the stored file): the mock is dev-only.
  "seedOwnSticker",
  "seedDemoOwnSticker",
  "mockOwnStickerBytes",
  // 3f.3b: the dev build's own video clip in the demo draft (the option and the method that seeds it): the mock is dev-only.
  "demoOwnVideo",
  "seedDemoOwnVideoClip",
  // 3f.6: the dev build's «Мои» (its seeded library and the drop zone's scripted dialog): the mock is dev-only.
  "withMineDemo",
  "mineDemoSeeds",
  "mineDemoPicks",
  // 3c.4: the mock CDN's E2E-only switch (main.ts's musicCdnBaseUrlForTests).
  "studio-music-cdn-base-url",
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

/** Names that exist only in the test-only music helpers and fixtures: none may be in the engine bundle. */
const TEST_ONLY_MUSIC_NAMES = ["hangingBody", "fakeCdn", "m4aBuilder", "storeKit", "cdnHostPatterns"] as const;

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
 * Problems with the money timings in a production build's shared chunks (every `out-studio/*.js` beside the entries): an
 * E2E build shortens the reconcile wait and the request timeout so its smoke does not wait minutes (STUDIO_E2E in
 * money/budget.ts and money/reconcile.ts); a production build must carry the real 120 s and 180 s, with the shortened
 * branch folded away. Both must be found (a renamed constant fails here, not silently passes).
 */
export function productionMoneyTimingProblems(chunks: string): string[] {
  const problems: string[] = [];
  // Anchored to the declaration itself (the bundler prints `var NAME = <number>;` at column 0), and there must be exactly one:
  // a mention in a comment or a string, or a second declaration, must not be able to satisfy the check.
  const check = (name: string, minified: string, plain: string, label: string): void => {
    const declarations = chunks.match(new RegExp(`^var ${name} = .*$`, "gm")) ?? [];
    if (declarations.length !== 1) {
      problems.push(`${name} is declared ${declarations.length} times in the shared chunks (exactly one expected)`);
      return;
    }
    if (declarations[0] !== `var ${name} = ${minified};` && declarations[0] !== `var ${name} = ${plain};`) problems.push(`${name} is not the production ${label} (or was not found)`);
  };
  check("RECONCILE_QUIET_MS", "12e4", "120000", "120 s");
  check("REQUEST_TIMEOUT_MS", "18e4", "180000", "180 s");
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
  // The mock CDN (3c.4, invariant 31): the engine entry picks the loopback transport only behind `STUDIO_E2E`, so with the
  // flag folded to `false` the bundler drops the transport and its messages altogether: none of it may be in the bundle.
  // (Unlike the base URLs above there is no call left to read: the whole branch is gone, which is the stronger result.)
  if (["createLoopbackCdnTransport", "createRefusingCdnTransport", "the mock CDN"].some((name) => engine.includes(name))) problems.push("the mock-CDN transport is in the engine bundle");
  // Test-only music helpers live under studio/engine/music/testing/ and studio/engine/music/fixtures/. A persisting test
  // sink in the bundle would turn `music.refresh` on, which only the real track store (3c.4) may do.
  if (engine.includes("PersistingTestSink")) problems.push("a test-only music sink is in the engine bundle");
  if (TEST_ONLY_MUSIC_NAMES.some((name) => engine.includes(name))) problems.push("a test-only music helper is in the engine bundle");
  // 3a.9: the packaged E2E stops a commit right after the rename to kill the engine there (studio/engine/videos/e2eCommitHold.ts).
  // The hook is built behind STUDIO_E2E, so a production bundle has neither the module nor the marker its files are named by.
  if (engine.includes("studio-e2e-commit-hold")) problems.push("a test-only commit hold is in the engine bundle");
  return problems;
}

/**
 * `productionEngineProblems` over the engine entry AND the shared chunks beside it: the bundler may move a module that two entries
 * import (the commit hold, for one) into a chunk, and then the entry's own text no longer shows it.
 */
export function productionEngineBundleProblems(engine: string, sharedChunks: string): string[] {
  return productionEngineProblems(`${engine}\n${sharedChunks}`);
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

/**
 * 3f.2 (fix round 1): the same checks for the own-photo decode worker (`out-studio/engine/photoDecodeWorker.js`), plus one that keeps the
 * WASM decode where it belongs: `wasmDecode.ts` carries a distinctive message, and the engine bundle must not contain it, or the decode
 * (synchronous, hundreds of megabytes that never shrink) could run on the engine's own thread again.
 */
export function photoDecodeWorkerProblems(engineMain: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): string[] {
  const problems = workerEntryProblems("photoDecodeWorker", engineMain, worker, fileExists);
  if (engineMain.includes("decode/wasmDecode: unsupported image format")) problems.push("the engine bundle contains the WASM image decoder; it must run only inside the decode worker");
  return problems;
}

/**
 * 3f.5: the same checks for the own-sticker encode worker (`out-studio/engine/stickerEncodeWorker.js`). It takes no `workerData` (the job comes by
 * message), so it is held to `parentPort` only; and the APNG writer must stay where it belongs: `ApngTooLargeError`'s message is distinctive, and the
 * engine bundle must not contain it, or the hand-written deflate (tens of seconds over 300 frames) could run on the engine's own thread.
 */
export function stickerEncodeWorkerProblems(engineMain: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): string[] {
  const problems = workerEntryProblems("stickerEncodeWorker", engineMain, worker, fileExists, { workerData: false });
  if (engineMain.includes("the APNG passes its limit of")) problems.push("the engine bundle contains the APNG writer; it must run only inside the encode worker");
  return problems;
}

function workerEntryProblems(name: string, engineMain: string, worker: string | null, fileExists: (outStudioPath: string) => boolean, options: { workerData: boolean } = { workerData: true }): string[] {
  const problems: string[] = [];
  if (!new RegExp(`new URL\\(\\s*["']\\./${name}\\.js["']\\s*,\\s*import\\.meta\\.url\\s*\\)`).test(engineMain)) {
    problems.push(`the engine does not resolve "./${name}.js" against its own import.meta.url`);
  }
  if (worker === null || worker.trim().length === 0) {
    problems.push(`out-studio/engine/${name}.js is missing`);
    return problems;
  }
  if (options.workerData) {
    if (!worker.includes("parentPort") || !worker.includes("workerData")) problems.push(`${name}.js does not use worker_threads' parentPort/workerData`);
  } else if (!worker.includes("parentPort")) {
    problems.push(`${name}.js does not use worker_threads' parentPort`);
  }
  if (/(?:\bfrom\s*|\bimport\s*\(?\s*)["']electron["']/.test(worker)) problems.push(`${name}.js imports electron`);
  for (const specifier of relativeImportsOf(worker)) {
    if (!fileExists(posix.normalize(posix.join("engine", specifier)))) problems.push(`${name}.js imports ${specifier}, which is not in the build`);
  }
  return problems;
}
