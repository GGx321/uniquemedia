import { allowlistedEnv } from "../node/childEnv";

/**
 * The explicit, minimal environment for `utilityProcess.fork` (invariant 10).
 * An allowlist rather than a denylist: OPENROUTER_* and every other secret,
 * NODE_OPTIONS and ELECTRON_* never reach the engine, whatever the parent had.
 * The list itself is shared with the ffmpeg children (`studio/node/childEnv.ts`).
 */
export function engineEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return allowlistedEnv(parent);
}
