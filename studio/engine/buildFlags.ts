// Replaced at build time by electron.studio.vite.config.ts (`define`).
// `__STUDIO_E2E__`: true only in a build made with STUDIO_E2E=1
// (`bun run build:studio:e2e`). `__STUDIO_DEV__`: true only under
// `electron-vite dev`. Both false in every normal build, and undefined under
// bun test, which counts as false.
declare const __STUDIO_E2E__: boolean | undefined;
declare const __STUDIO_DEV__: boolean | undefined;

/**
 * An end-to-end test build. Only such a build accepts an OpenRouter base URL
 * other than the real one (invariant 13), reads the smoke test's switches
 * and keeps DevTools and remote debugging in a packaged app. Never ship one.
 */
export const STUDIO_E2E: boolean = typeof __STUDIO_E2E__ === "boolean" && __STUDIO_E2E__;

/** `electron-vite dev`: the renderer comes from the dev server. */
export const STUDIO_DEV: boolean = typeof __STUDIO_DEV__ === "boolean" && __STUDIO_DEV__;

/**
 * DevTools and remote debugging stay open: a dev or an E2E build only. A
 * build-time constant, so every `build:studio` output has these doors
 * compiled shut — never decided by `app.isPackaged`, which depends only on
 * the executable's name (a renamed production binary counts as unpackaged).
 */
export const DEBUGGABLE: boolean = STUDIO_DEV || STUDIO_E2E;
