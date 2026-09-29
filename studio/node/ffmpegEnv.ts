import { allowlistedEnv } from "./childEnv";

// The engine never reads the process environment (a static test guards every
// module reachable from its entry: `engine/runtime.test.ts`). So the ffmpeg
// children's environment reaches it the way everything else does: main puts
// it into `EngineInit`, and the engine's start hands it here, once.

let configured: Record<string, string> | undefined;

/**
 * Sets the environment every ffmpeg child gets, filtered through the
 * allowlist again (a secret cannot pass by a caller forgetting to filter).
 * `undefined` clears it.
 */
export function configureFfmpegEnv(env: Readonly<Record<string, string | undefined>> | undefined): void {
  configured = env === undefined ? undefined : allowlistedEnv(env);
}

/**
 * What `configureFfmpegEnv` set, or `undefined` when nothing did: then the
 * child inherits its parent's environment, which is only ever the case in tests
 * and tools. In the app the engine process's own environment is already main's
 * allowlist (invariant 10), and the engine configures this at start.
 */
export function configuredFfmpegEnv(): Record<string, string> | undefined {
  return configured === undefined ? undefined : { ...configured };
}
