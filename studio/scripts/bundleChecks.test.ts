import { describe, expect, test } from "bun:test";
import { productionBundleProblems, productionEngineProblems, productionMainProblems } from "./bundleChecks";

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

  test("flags a debug switch name leaking into the renderer bundle", () => {
    expect(productionBundleProblems('fetch("studio-openrouter-base-url")')).toEqual(["contains studio-openrouter-base-url"]);
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
  test("passes an engine bundle that never takes an OpenRouter base-URL override", () => {
    expect(productionEngineProblems("resolveOpenRouterBaseUrl(init.openRouterBaseUrl, false)")).toEqual([]);
  });

  test("flags an engine bundle built with the E2E override kept", () => {
    expect(productionEngineProblems("resolveOpenRouterBaseUrl(init.openRouterBaseUrl, true)")).toEqual(["the engine takes an OpenRouter base-URL override"]);
  });
});
