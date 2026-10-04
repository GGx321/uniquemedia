import { type EngineClient, unavailableClient } from "./client";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { realScheduler } from "./scheduler";
import { windowStudioClient } from "./windowStudio";

/**
 * The real engine whenever the preload exposes `window.studio.request`.
 * Without it, a dev build falls back to `makeMock` and a release build gets
 * `unavailable`: the mock never ships as if it were an engine.
 */
export function chooseEngineClient(dev: boolean, makeMock: () => EngineClient): EngineClient {
  return windowStudioClient() ?? (dev ? makeMock() : unavailableClient());
}

/** The demo mock with real timers, so progress is visible in the dev build; its draft plays the demo video in its third clip (3f.3b). */
function demoMock(): EngineClient {
  return mockEngineClient(new MockEngine({ preset: "demo", demoVideos: true, demoOwnVideo: true, scheduler: realScheduler, latencyMs: 160, stepMs: 900, textDrawMs: 120 }));
}

/**
 * Vite replaces `import.meta.env.DEV` with a literal, so in a release build the
 * dev branch is dead code and the mock engine is dropped from the bundle.
 */
export function pickEngineClient(): EngineClient {
  return import.meta.env.DEV ? chooseEngineClient(true, demoMock) : chooseEngineClient(false, unavailableClient);
}
