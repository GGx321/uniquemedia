import { describe, expect, test } from "bun:test";
import { unlinkWithRetry, type UnlinkRetryOptions } from "./unlinkRetry";
import { rejectionOf } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

/** An unlink that fails with the given codes in turn, then succeeds. */
function flakyUnlink(codes: string[]) {
  const calls: string[] = [];
  const unlink = async (path: string) => {
    calls.push(path);
    const code = codes[calls.length - 1];
    if (code !== undefined) throw fsError(code);
  };
  return { unlink, calls };
}

function recordSleeps() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

const DELAYS = [10, 20, 40] as const;

function windows(extra: UnlinkRetryOptions): UnlinkRetryOptions {
  return { platform: "win32", delaysMs: DELAYS, ...extra };
}

describe("unlinkWithRetry", () => {
  test("on Windows, retries EPERM, EBUSY and EACCES with growing delays until the unlink succeeds", async () => {
    const { unlink, calls } = flakyUnlink(["EPERM", "EBUSY", "EACCES"]);
    const { slept, sleep } = recordSleeps();

    await unlinkWithRetry("draft.json", windows({ unlink, sleep }));

    expect(calls).toHaveLength(4);
    expect(slept).toEqual([10, 20, 40]);
  });

  test("on Windows, gives up after the last delay and rejects with the last error", async () => {
    const { unlink, calls } = flakyUnlink(["EPERM", "EPERM", "EPERM", "EBUSY"]);
    const { sleep } = recordSleeps();

    const error = await rejectionOf(unlinkWithRetry("draft.json", windows({ unlink, sleep })));

    expect(error).toMatchObject({ code: "EBUSY" });
    expect(calls).toHaveLength(DELAYS.length + 1);
  });

  test("on Windows, a file that is already gone is not retried: ENOENT reaches the caller at once", async () => {
    const { unlink, calls } = flakyUnlink(["ENOENT"]);
    const { slept, sleep } = recordSleeps();

    const error = await rejectionOf(unlinkWithRetry("draft.json", windows({ unlink, sleep })));

    expect(error).toMatchObject({ code: "ENOENT" });
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  test("elsewhere a lock-like error is not retried: it is a real error there", async () => {
    const { unlink, calls } = flakyUnlink(["EPERM"]);
    const { sleep } = recordSleeps();

    const error = await rejectionOf(unlinkWithRetry("draft.json", { platform: "darwin", delaysMs: DELAYS, unlink, sleep }));

    expect(error).toMatchObject({ code: "EPERM" });
    expect(calls).toHaveLength(1);
  });

  test("an error without a code is not retried", async () => {
    const calls: string[] = [];
    const unlink = async (path: string) => {
      calls.push(path);
      throw new Error("no code");
    };

    await rejectionOf(unlinkWithRetry("draft.json", windows({ unlink, sleep: async () => {} })));

    expect(calls).toHaveLength(1);
  });

  test("a first attempt that works sleeps never", async () => {
    const { unlink, calls } = flakyUnlink([]);
    const { slept, sleep } = recordSleeps();

    await unlinkWithRetry("draft.json", windows({ unlink, sleep }));

    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});
