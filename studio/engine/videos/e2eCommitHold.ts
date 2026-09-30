import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { CommitStep } from "./commit";

// A TEST-ONLY hold in the video commit, for the packaged E2E (Stage 3 plan, 3a.9). The smoke has to kill the engine at one
// exact point: after the temp was renamed onto the claimed name and before the record is linked, where a restart must
// ADOPT the video. The commit already reports each step to `hooks.reached`; this is the hook the engine passes in an E2E
// build, and ONLY there: `engine/main.ts` builds it behind `STUDIO_E2E`, a build-time constant, so a production bundle
// does not contain this module (bundleChecks.ts's `productionEngineProblems` and the production smoke look for
// `COMMIT_HOLD_MARKER`).
//
// The engine reads no environment and is handed no switch, so the smoke arms the hold with a file in userData: when the
// commit reaches `renamed` and the arming file is there, the hook renames it to the held file (one atomic step, so exactly
// one commit takes the arming and a restarted engine finds it gone) and then never returns. The smoke sees the held file,
// kills the engine, and restarts it.

/** In every marker file's name, and the one string a production bundle must not carry. */
export const COMMIT_HOLD_MARKER = "studio-e2e-commit-hold";

export function commitHoldPaths(dir: string): { readonly armed: string; readonly held: string } {
  return { armed: join(dir, `${COMMIT_HOLD_MARKER}.armed`), held: join(dir, `${COMMIT_HOLD_MARKER}.held`) };
}

export interface CommitHoldOptions {
  /** Where the marker files live: userData (the folder of the ledger), which the render-tmp sweep never touches. */
  readonly dir: string;
  /** What holding is; forever unless a test says otherwise. */
  readonly hold?: () => Promise<void>;
}

const holdForever = (): Promise<void> => new Promise<void>(() => undefined);

/** The commit's `hooks.reached` for an E2E build. A folder that cannot be used never fails a commit: it just does not hold. */
export function createCommitHold(options: CommitHoldOptions): (step: CommitStep) => Promise<void> {
  const paths = commitHoldPaths(options.dir);
  const hold = options.hold ?? holdForever;
  return async (step) => {
    if (step !== "renamed") return;
    try {
      await rename(paths.armed, paths.held);
    } catch {
      return; // not armed (or nothing to arm it with): the commit goes on
    }
    await hold();
  };
}
