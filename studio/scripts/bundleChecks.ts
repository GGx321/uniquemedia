// What a production build of Studio must look like, read from its bundles.
// Every debug door is a build-time constant (studio/engine/buildFlags.ts), so
// in a `build:studio` output it is compiled shut and nothing about it is left
// to decide at run time. Used by the smoke test on shipped packages and by
// buildFlags.test.ts on real builds of both kinds.

/** Test-only switches and debug names that a production main bundle must not carry at all. */
const FORBIDDEN_IN_MAIN = [
  "studio-pick-folder",
  "studio-openrouter-base-url",
  "ELECTRON_RENDERER_URL",
  "DEBUGGABLE",
  "__STUDIO_DEV__",
  "__STUDIO_E2E__",
] as const;

/** Problems with out-studio/main/main.js of a production build; empty when every door is shut. */
export function productionMainProblems(main: string): string[] {
  const problems = FORBIDDEN_IN_MAIN.filter((text) => main.includes(text)).map((text) => `contains ${text}`);
  if (!/devTools: (false|!1)\b/.test(main)) problems.push("DevTools are not compiled off");
  if (!main.includes('"remote-debugging-port"')) problems.push("the remote-debugging refusal is missing");
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
