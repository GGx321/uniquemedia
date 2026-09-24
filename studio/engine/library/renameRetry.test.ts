import { describe, expect, test } from "bun:test";
import { renameWithRetry, type RenameRetryOptions } from "./renameRetry";
import { rejectionOf } from "./testing/helpers";

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

/** A rename that fails with the given codes in turn, then succeeds. */
function flakyRename(codes: string[]) {
  const calls: Array<[string, string]> = [];
  const rename = async (from: string, to: string) => {
    calls.push([from, to]);
    const code = codes[calls.length - 1];
    if (code !== undefined) throw fsError(code);
  };
  return { rename, calls };
}

function recordSleeps() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

const DELAYS = [10, 20, 40] as const;

function windows(extra: RenameRetryOptions): RenameRetryOptions {
  return { platform: "win32", delaysMs: DELAYS, ...extra };
}

describe("renameWithRetry", () => {
  test("on Windows, retries EPERM and EBUSY with growing delays until the rename succeeds", async () => {
    const { rename, calls } = flakyRename(["EPERM", "EBUSY"]);
    const { slept, sleep } = recordSleeps();

    await renameWithRetry("a.tmp", "a", windows({ rename, sleep }));

    expect(calls).toEqual([["a.tmp", "a"], ["a.tmp", "a"], ["a.tmp", "a"]]);
    expect(slept).toEqual([10, 20]);
  });

  test("on Windows, retries EACCES too", async () => {
    const { rename, calls } = flakyRename(["EACCES"]);
    const { sleep } = recordSleeps();
    await renameWithRetry("a.tmp", "a", windows({ rename, sleep }));
    expect(calls).toHaveLength(2);
  });

  test("on Windows, gives up after the last delay and rejects with the last error", async () => {
    const { rename, calls } = flakyRename(["EPERM", "EPERM", "EPERM", "EBUSY"]);
    const { slept, sleep } = recordSleeps();

    const error = await rejectionOf(renameWithRetry("a.tmp", "a", windows({ rename, sleep })));

    expect(error).toMatchObject({ code: "EBUSY" });
    expect(calls).toHaveLength(DELAYS.length + 1);
    expect(slept).toEqual([10, 20, 40]);
  });

  test("on Windows, does not retry an error a retry cannot fix", async () => {
    const { rename, calls } = flakyRename(["ENOENT"]);
    const { slept, sleep } = recordSleeps();

    expect(await rejectionOf(renameWithRetry("a.tmp", "a", windows({ rename, sleep })))).toMatchObject({ code: "ENOENT" });

    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  test("elsewhere, fails on the first EPERM without retrying", async () => {
    const { rename, calls } = flakyRename(["EPERM"]);
    const { slept, sleep } = recordSleeps();

    const error = await rejectionOf(renameWithRetry("a.tmp", "a", { platform: "darwin", delaysMs: DELAYS, rename, sleep }));

    expect(error).toMatchObject({ code: "EPERM" });
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});
