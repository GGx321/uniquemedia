import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { COMMIT_HOLD_MARKER, commitHoldPaths, createCommitHold } from "./e2eCommitHold";
useNativeGlobals();

// 3a.9's test hook: the packaged E2E arms it with a file, the commit reaches `renamed` (the video is under its final name,
// its record is not yet linked), the hook says so with a second file and then holds until the smoke kills the engine. It is
// compiled out of a production build (buildFlags.test.ts and the production smoke prove it).

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-commit-hold-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A hold the test releases by hand instead of one that never ends. */
function controlledHold(): { hold: () => Promise<void>; release: () => void; entered: () => boolean } {
  let release: () => void = () => undefined;
  let entered = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hold: () => {
      entered = true;
      return pending;
    },
    release,
    entered: () => entered,
  };
}

const arm = (): Promise<void> => writeFile(commitHoldPaths(dir).armed, "");

describe("the E2E commit hold", () => {
  test("names its marker files after one marker string, the one a production bundle is checked not to carry", () => {
    const paths = commitHoldPaths(dir);
    expect(paths.armed).toContain(COMMIT_HOLD_MARKER);
    expect(paths.held).toContain(COMMIT_HOLD_MARKER);
    expect(paths.armed).not.toBe(paths.held);
  });

  test("lets a commit through when nothing armed it", async () => {
    const control = controlledHold();
    const reached = createCommitHold({ dir, hold: control.hold });

    await reached("renamed");

    expect(control.entered()).toBe(false);
    expect(existsSync(commitHoldPaths(dir).held)).toBe(false);
  });

  test("ignores every step but the one right after the rename, and leaves the arming in place", async () => {
    await arm();
    const control = controlledHold();
    const reached = createCommitHold({ dir, hold: control.hold });

    for (const step of ["verified", "temp-synced", "name-claimed", "intent-temp-written", "intent-written", "dir-synced", "record-linked", "record-committed"] as const) {
      await reached(step);
    }

    expect(control.entered()).toBe(false);
    expect(existsSync(commitHoldPaths(dir).armed)).toBe(true);
    expect(existsSync(commitHoldPaths(dir).held)).toBe(false);
  });

  test("turns the arming file into the held file and holds the commit at `renamed`", async () => {
    await arm();
    const control = controlledHold();
    const reached = createCommitHold({ dir, hold: control.hold });
    let passed = false;

    const commit = reached("renamed").then(() => {
      passed = true;
    });
    await Bun.sleep(20);

    expect(control.entered()).toBe(true);
    expect(passed).toBe(false);
    expect(existsSync(commitHoldPaths(dir).held)).toBe(true);
    expect(existsSync(commitHoldPaths(dir).armed)).toBe(false);

    control.release();
    await commit;
    expect(passed).toBe(true);
  });

  test("holds once: after the arming was used, the next commit goes through", async () => {
    await arm();
    const first = controlledHold();
    const second = controlledHold();
    const holdFirst = createCommitHold({ dir, hold: first.hold })("renamed");
    await Bun.sleep(20);
    first.release();
    await holdFirst;

    await createCommitHold({ dir, hold: second.hold })("renamed");

    expect(second.entered()).toBe(false);
  });

  test("an engine that restarts after the kill finds the arming gone and does not hold again", async () => {
    await arm();
    const killed = controlledHold();
    void createCommitHold({ dir, hold: killed.hold })("renamed");
    await Bun.sleep(20);
    // The engine is killed here: its hold never ends. The restarted engine builds a fresh hold over the same folder.
    const restarted = controlledHold();

    await createCommitHold({ dir, hold: restarted.hold })("renamed");

    expect(restarted.entered()).toBe(false);
  });

  test("a folder that cannot be read lets the commit through instead of failing it", async () => {
    const control = controlledHold();
    const reached = createCommitHold({ dir: join(dir, "no", "such", "folder"), hold: control.hold });

    await reached("renamed");

    expect(control.entered()).toBe(false);
  });
});
