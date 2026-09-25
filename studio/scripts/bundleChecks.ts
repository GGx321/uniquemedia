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

const SWITCH_NAMES = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"] as const;

/** Test-only switches and debug names that no production bundle (main, preload or renderer) may carry at all. */
const FORBIDDEN_DEBUG_MARKERS = [
  "studio-pick-folder",
  "studio-openrouter-base-url",
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

/** Problems with out-studio/engine/main.js of a production build (invariant 13). */
export function productionEngineProblems(engine: string): string[] {
  return /resolveOpenRouterBaseUrl\(init\.openRouterBaseUrl, false\)/.test(engine) ? [] : ["the engine takes an OpenRouter base-URL override"];
}
