// Replaced at build time by electron.studio.vite.config.ts (`define`): true
// only in a build made with STUDIO_E2E=1 (`bun run build:studio:e2e`), false
// in every normal build. Undefined under bun test, which counts as false.
declare const __STUDIO_E2E__: boolean | undefined;

/**
 * An end-to-end test build. Only such a build accepts an OpenRouter base URL
 * other than the real one (invariant 13) and keeps DevTools and remote
 * debugging in a packaged app. Never ship one.
 */
export const STUDIO_E2E: boolean = typeof __STUDIO_E2E__ === "boolean" && __STUDIO_E2E__;
