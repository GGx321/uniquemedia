import { describe, expect, test } from "bun:test";
import { faceWorkerProblems, photoDecodeWorkerProblems, productionBundleProblems, productionEngineBundleProblems, productionEngineProblems, productionMainProblems, productionMoneyTimingProblems, productionRendererCssProblems, productionRendererPageProblems, relativeImportsOf, stickerEncodeWorkerProblems, textWorkerProblems } from "./bundleChecks";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// A stand-in for a real production main.js: the exact, unconditional shape
// esbuild emits for studio/main/main.ts's `if (!DEBUGGABLE) { for (...) ... }`
// once DEBUGGABLE is inlined to `false` and the dead `if` is folded away (see
// buildFlags.test.ts, which checks this against a real build), plus the one
// unrelated, pre-existing read of `--user-data-dir` through the same
// `app.commandLine` object, the `isPackaged` line another check reads, and
// the lines that serve and load the window's page from `studio-app://renderer`.
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
var APP_SCHEME = "studio-app";
var APP_PAGE_URL = \`\${APP_SCHEME}://renderer/index.html\`;
protocol.registerSchemesAsPrivileged([{
	scheme: MEDIA_SCHEME,
	privileges: MEDIA_SCHEME_PRIVILEGES
}, {
	scheme: APP_SCHEME,
	privileges: APP_SCHEME_PRIVILEGES
}]);
	protocol.handle(APP_SCHEME, (request) => handleAppRequest(request, RENDERER_DIR));
	if (devServerUrl) win.loadURL(devServerUrl);
	else win.loadURL(APP_PAGE_URL);
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

// The 3f.6 security review read /etc/hosts from the real app: on a `file:` page the CSP's 'self' is every file on the disk.
describe("productionMainProblems: the window's page comes from the app's own scheme, never from a file: URL", () => {
  test("passes the real shape", () => {
    expect(productionMainProblems(CLEAN_MAIN).filter((p) => p.includes("page") || p.includes("scheme"))).toEqual([]);
  });

  test("fails a main that loads the page from a file", () => {
    const mutated = CLEAN_MAIN.replace("else win.loadURL(APP_PAGE_URL);", "else win.loadFile(RENDERER_FILE);");
    expect(productionMainProblems(mutated)).toEqual(["main loads a file: page (loadFile)", "the window does not load the app's own page (studio-app://renderer/index.html)"]);
  });

  test("fails a main that loads a file: URL by loadURL", () => {
    const mutated = CLEAN_MAIN.replace("else win.loadURL(APP_PAGE_URL);", "else win.loadURL(pathToFileURL(RENDERER_FILE).href);");
    expect(productionMainProblems(mutated)).toEqual(["main builds a file: URL (pathToFileURL)", "the window does not load the app's own page (studio-app://renderer/index.html)"]);
  });

  test("fails a main whose page is another URL", () => {
    const mutated = CLEAN_MAIN.replace("var APP_PAGE_URL = `${APP_SCHEME}://renderer/index.html`;", 'var APP_PAGE_URL = "file:///index.html";');
    expect(productionMainProblems(mutated)).toEqual(["the app's own page is not studio-app://renderer/index.html"]);
  });

  test("fails a main that does not register the scheme, or does not answer it", () => {
    const unregistered = CLEAN_MAIN.replace("scheme: APP_SCHEME,\n\tprivileges: APP_SCHEME_PRIVILEGES", "scheme: OTHER,\n\tprivileges: APP_SCHEME_PRIVILEGES");
    expect(productionMainProblems(unregistered)).toEqual(["the app's scheme is not registered as privileged"]);
    const unanswered = CLEAN_MAIN.replace("protocol.handle(APP_SCHEME,", "protocol.handle(OTHER,");
    expect(productionMainProblems(unanswered)).toEqual(["nothing answers the app's scheme"]);
  });
});

describe("productionRendererPageProblems: the shipped page's CSP", () => {
  const page = (csp: string): string => `<!doctype html><html><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${csp}" /></head></html>`;
  const CLEAN = "default-src 'self'; img-src 'self' data: studio-media:; media-src studio-media:; style-src 'self' 'unsafe-inline'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

  test("passes the real policy", () => {
    expect(productionRendererPageProblems(page(CLEAN))).toEqual([]);
  });

  test("fails a page with no policy", () => {
    expect(productionRendererPageProblems("<!doctype html><title>x</title>")).toEqual(["the page has no Content-Security-Policy"]);
  });

  test("names every directive that is not shut", () => {
    const open = CLEAN.replace("frame-src 'none'; child-src 'none'; ", "").replace("base-uri 'none'", "base-uri 'self'");
    expect(productionRendererPageProblems(page(open))).toEqual(["frame-src is not 'none'", "child-src is not 'none'", "base-uri is not 'none'"]);
  });

  test("fails a policy that lets file: URLs or any origin in", () => {
    expect(productionRendererPageProblems(page(CLEAN.replace("img-src 'self'", "img-src 'self' file:")))).toEqual(["img-src names file:"]);
    expect(productionRendererPageProblems(page(CLEAN.replace("default-src 'self'", "default-src *")))).toEqual(["default-src is not 'self'", "default-src names *"]);
  });
});

describe("productionMoneyTimingProblems: an E2E build's shortened money timings never reach a production build", () => {
  const PRODUCTION = "var RECONCILE_QUIET_MS = 12e4;\nvar REQUEST_TIMEOUT_MS = 18e4;";

  test("passes the production values, as the bundler prints them", () => {
    expect(productionMoneyTimingProblems(PRODUCTION)).toEqual([]);
    expect(productionMoneyTimingProblems("var RECONCILE_QUIET_MS = 120000;\nvar REQUEST_TIMEOUT_MS = 180000;")).toEqual([]);
  });

  test("flags the E2E values (the shortened branch was not folded away)", () => {
    expect(productionMoneyTimingProblems("var RECONCILE_QUIET_MS = 5e3;\nvar REQUEST_TIMEOUT_MS = 15e3;")).toEqual([
      "RECONCILE_QUIET_MS is not the production 120 s (or was not found)",
      "REQUEST_TIMEOUT_MS is not the production 180 s (or was not found)",
    ]);
  });

  test("flags a ternary that survived, and a value that is 120 s plus something", () => {
    expect(productionMoneyTimingProblems("var RECONCILE_QUIET_MS = STUDIO_E2E ? 5e3 : 12e4;\nvar REQUEST_TIMEOUT_MS = 18e4;")).toEqual(["RECONCILE_QUIET_MS is not the production 120 s (or was not found)"]);
    expect(productionMoneyTimingProblems("var RECONCILE_QUIET_MS = 12e45;\nvar REQUEST_TIMEOUT_MS = 18e4;")).toEqual(["RECONCILE_QUIET_MS is not the production 120 s (or was not found)"]);
  });

  test("flags a constant that cannot be found at all", () => {
    const missing = ["RECONCILE_QUIET_MS is declared 0 times in the shared chunks (exactly one expected)", "REQUEST_TIMEOUT_MS is declared 0 times in the shared chunks (exactly one expected)"];
    expect(productionMoneyTimingProblems("")).toEqual(missing);
    expect(productionMoneyTimingProblems("var OTHER_QUIET_MS = 12e4;\nvar OTHER_TIMEOUT_MS = 18e4;")).toEqual(missing);
  });

  test("a mention in a comment or a string does not stand in for the declaration", () => {
    const mention = '// var RECONCILE_QUIET_MS = 12e4;\nconst text = "var REQUEST_TIMEOUT_MS = 18e4;";\n  var RECONCILE_QUIET_MS = 12e4;\n';
    expect(productionMoneyTimingProblems(mention + "var RECONCILE_QUIET_MS = 5e3;\nvar REQUEST_TIMEOUT_MS = 15e3;")).toEqual([
      "RECONCILE_QUIET_MS is not the production 120 s (or was not found)",
      "REQUEST_TIMEOUT_MS is not the production 180 s (or was not found)",
    ]);
  });

  test("two declarations of one constant are flagged, whichever is the real one", () => {
    expect(productionMoneyTimingProblems(`${PRODUCTION}\nvar RECONCILE_QUIET_MS = 5e3;`)).toEqual(["RECONCILE_QUIET_MS is declared 2 times in the shared chunks (exactly one expected)"]);
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

  // 3f.1: the own-media dialog's E2E-only switch. A picked path would otherwise be settable from the command line of a shipped build.
  test("flags the own-media dialog's E2E switch leaking anywhere", () => {
    expect(productionBundleProblems('const SWITCH = "studio-pick-media";')).toEqual(["contains studio-pick-media"]);
  });

  test("flags a debug switch name leaking into the renderer bundle", () => {
    expect(productionBundleProblems('fetch("studio-openrouter-base-url")')).toEqual(["contains studio-openrouter-base-url"]);
  });

  test.each(["failNextRender", "setExportDisk", "moveExportFolder", "pickExportFolderNext", "pickMediaNext", "holdImports", "MockOwnMedia", "failNextMusicRefresh", "setMusicQuotaLog", "seedMusicTracks", "holdTextDrawing", "releaseTextDrawing", "mockPreviewPng", "demo-track-", "demoVideos", "seedDemoVideos", "seedOwnSticker", "seedDemoOwnSticker", "mockOwnStickerBytes", "demoOwnVideo", "seedDemoOwnVideoClip", "timeOutNextDelete", "loseTrackOfRecords", "seedLaunch", "tearPublishedLog", "failLaunchPaidStep", "failLaunchRender", "setAvatarBusy", "loseLaunchLibrary", "holdLaunchMusic", "quitLaunch", "MockAutopilot", "MockRun"])("flags the mock engine's test control %s in a bundle: the mock must never ship", (control) => {
    expect(productionBundleProblems(`engine.${control}(1);`)).toEqual([`contains ${control}`]);
  });

  test("flags the flashapi mock's E2E switch leaking anywhere", () => {
    expect(productionBundleProblems('const SWITCH = "studio-flashapi-base-url";')).toEqual(["contains studio-flashapi-base-url"]);
  });

  test("flags the mock CDN's E2E switch leaking anywhere", () => {
    expect(productionBundleProblems('const SWITCH = "studio-music-cdn-base-url";')).toEqual(["contains studio-music-cdn-base-url"]);
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
  // 3c.4: a production bundle has no mock-CDN code at all (its branch is behind the build flag, which folds to `false`),
  // so there is no call to read; the check is that none of the transport is there.
  const bundle = (...parts: string[]) => parts.join("\n");
  const SHUT = bundle(OPEN_RESOLVE, OPEN_CLIENT, MUSIC_CLIENT);

  test("flags the loopback mock transport in the engine bundle: it must be compiled out, not merely unused", () => {
    expect(productionEngineProblems(bundle(SHUT, "function createLoopbackCdnTransport(base) {}"))).toEqual(["the mock-CDN transport is in the engine bundle"]);
  });

  test("flags the E2E build's refusing CDN transport in the engine bundle: it too is for an E2E build alone", () => {
    expect(productionEngineProblems(bundle(SHUT, "function createRefusingCdnTransport() {}"))).toEqual(["the mock-CDN transport is in the engine bundle"]);
  });

  test("flags the mock CDN's messages in the engine bundle even if the function was renamed", () => {
    expect(productionEngineProblems(bundle(SHUT, 'throw new TypeError("the mock CDN may only be a loopback host");'))).toEqual(["the mock-CDN transport is in the engine bundle"]);
  });

  test("flags a test-only track-store helper in the engine bundle", () => {
    expect(productionEngineProblems(bundle(SHUT, "export function fakeCdn() {}"))).toEqual(["a test-only music helper is in the engine bundle"]);
    expect(productionEngineProblems(bundle(SHUT, "const m4aBuilder = 1;"))).toEqual(["a test-only music helper is in the engine bundle"]);
  });

  test("flags the fixtures' host patterns being imported into the engine bundle", () => {
    expect(productionEngineProblems(bundle(SHUT, "export const cdnHostPatterns = [];"))).toEqual(["a test-only music helper is in the engine bundle"]);
  });

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

  test("flags the E2E commit hold that made it into the engine bundle: it would stop a real commit at the rename", () => {
    expect(productionEngineProblems(bundle(SHUT, 'const held = "studio-e2e-commit-hold.held";'))).toEqual(["a test-only commit hold is in the engine bundle"]);
  });

  test("flags the commit hold when the bundler put it in a shared chunk beside the entry, which the entry's own text does not show", () => {
    const chunk = 'const held = "studio-e2e-commit-hold.held";';
    expect(productionEngineProblems(SHUT)).toEqual([]);
    expect(productionEngineBundleProblems(SHUT, chunk)).toEqual(["a test-only commit hold is in the engine bundle"]);
  });

  test("passes an engine bundle and shared chunks that carry none of it", () => {
    expect(productionEngineBundleProblems(SHUT, "var RECONCILE_QUIET_MS = 12e4;")).toEqual([]);
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

// 3f.2 (fix round 1): the own-photo decode worker is the same kind of entry. A build that dropped it would fail only at the first photo the
// owner imports; and the WASM decode must not come back into the engine's own bundle.
describe("photoDecodeWorkerProblems", () => {
  const ENGINE = 'const PHOTO_DECODE_WORKER_URL = new URL("./photoDecodeWorker.js", import.meta.url);';
  const PHOTO_WORKER = 'import { parentPort, workerData } from "node:worker_threads";\nimport { z } from "../shared-Abc123.js";';
  const PRESENT = (path: string): boolean => ["engine/photoDecodeWorker.js", "shared-Abc123.js"].includes(path);

  test("passes a build whose engine spawns the decode worker by file URL and whose worker is a worker thread with its chunks present", () => {
    expect(photoDecodeWorkerProblems(ENGINE, PHOTO_WORKER, PRESENT)).toEqual([]);
  });

  test("fails when the decode worker entry was not built", () => {
    expect(photoDecodeWorkerProblems(ENGINE, null, PRESENT)).toContain("out-studio/engine/photoDecodeWorker.js is missing");
  });

  test("fails when the engine no longer spawns it by that file URL", () => {
    expect(photoDecodeWorkerProblems("spawn();", PHOTO_WORKER, PRESENT)).toContain('the engine does not resolve "./photoDecodeWorker.js" against its own import.meta.url');
  });

  test("fails when a chunk the worker imports is missing, and when it imports electron", () => {
    expect(photoDecodeWorkerProblems(ENGINE, PHOTO_WORKER, () => false)).toEqual(["photoDecodeWorker.js imports ../shared-Abc123.js, which is not in the build"]);
    expect(photoDecodeWorkerProblems(ENGINE, `${PHOTO_WORKER}\nimport { app } from "electron";`, PRESENT)).toContain("photoDecodeWorker.js imports electron");
  });

  test("fails when the engine bundle carries the WASM decode itself: it must run only inside the worker", () => {
    const engine = `${ENGINE}\nthrow new Error("decode/wasmDecode: unsupported image format for the engine own decoder");`;
    expect(photoDecodeWorkerProblems(engine, PHOTO_WORKER, PRESENT)).toContain("the engine bundle contains the WASM image decoder; it must run only inside the decode worker");
  });
});

// 3f.5: the own-sticker encode worker takes no `workerData` (the job comes by message), so that is the one rule of a worker entry it is not held
// to; and the APNG writer with its hand-written deflate must not come into the engine's own bundle.
describe("stickerEncodeWorkerProblems", () => {
  const ENGINE = 'const STICKER_ENCODE_WORKER_URL = new URL("./stickerEncodeWorker.js", import.meta.url);';
  const WORKER = 'import { parentPort } from "node:worker_threads";\nimport { z } from "../shared-Abc123.js";';
  const PRESENT = (path: string): boolean => ["engine/stickerEncodeWorker.js", "shared-Abc123.js"].includes(path);

  test("passes a build whose engine spawns the encode worker by file URL and whose worker is a worker thread with its chunks present", () => {
    expect(stickerEncodeWorkerProblems(ENGINE, WORKER, PRESENT)).toEqual([]);
  });

  test("fails when the encode worker entry was not built", () => {
    expect(stickerEncodeWorkerProblems(ENGINE, null, PRESENT)).toContain("out-studio/engine/stickerEncodeWorker.js is missing");
  });

  test("fails when the engine no longer spawns it by that file URL", () => {
    expect(stickerEncodeWorkerProblems("spawn();", WORKER, PRESENT)).toContain('the engine does not resolve "./stickerEncodeWorker.js" against its own import.meta.url');
  });

  test("fails when the entry is not a worker thread", () => {
    expect(stickerEncodeWorkerProblems(ENGINE, 'import { z } from "../shared-Abc123.js";', PRESENT)).toContain("stickerEncodeWorker.js does not use worker_threads' parentPort");
  });

  test("fails when a chunk the worker imports is missing, and when it imports electron", () => {
    expect(stickerEncodeWorkerProblems(ENGINE, WORKER, () => false)).toEqual(["stickerEncodeWorker.js imports ../shared-Abc123.js, which is not in the build"]);
    expect(stickerEncodeWorkerProblems(ENGINE, `${WORKER}\nimport { app } from "electron";`, PRESENT)).toContain("stickerEncodeWorker.js imports electron");
  });

  test("fails when the engine bundle carries the APNG writer: it must run only inside the worker", () => {
    const engine = `${ENGINE}\nthrow new Error("the APNG passes its limit of " + 5);`;
    expect(stickerEncodeWorkerProblems(engine, WORKER, PRESENT)).toContain("the engine bundle contains the APNG writer; it must run only inside the encode worker");
  });

  test("the other workers are still held to workerData: a decode worker without it fails", () => {
    const engine = 'const PHOTO_DECODE_WORKER_URL = new URL("./photoDecodeWorker.js", import.meta.url);';
    expect(photoDecodeWorkerProblems(engine, WORKER, (path) => ["engine/photoDecodeWorker.js", "shared-Abc123.js"].includes(path))).toContain("photoDecodeWorker.js does not use worker_threads' parentPort/workerData");
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
