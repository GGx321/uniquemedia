import { afterEach, describe, expect, test } from "bun:test";
import { FfmpegTimeoutError } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { stagingBound, type StagingTimers } from "./stagingBound";
useNativeGlobals();

// The time bound of a render's staging (3f.3b, round 3): ONE bound for every read and copy that stages the job's files (own photos, videos, stickers, a track), raced against
// the work, so a `read` that never returns cannot hold a render slot: the job ends the moment the bound passes or the owner cancels, and the abandoned work is told to stop.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** Timers a test moves by hand. */
function fakeTimers() {
  const set: Array<{ fn: () => void; ms: number; handle: object }> = [];
  const cleared: unknown[] = [];
  const timers: StagingTimers = {
    set: (fn, ms) => {
      const handle = {};
      set.push({ fn, ms, handle });
      return handle;
    },
    clear: (handle) => void cleared.push(handle),
  };
  return { timers, set, cleared };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
afterEach(() => void unhandled.splice(0));

describe("stagingBound.run", () => {
  test("answers what the work answers, and hands it a signal that is not aborted", async () => {
    const bound = stagingBound(1_000, new AbortController().signal);
    let given: AbortSignal | undefined;

    expect(await bound.run(async (signal) => ((given = signal), 7))).toBe(7);

    expect(given?.aborted).toBe(false);
    bound.release();
  });

  test("when the bound passes it rejects with a timeout of that many ms though the work never settles, and the work's signal is aborted with the same reason", async () => {
    const fake = fakeTimers();
    const bound = stagingBound(1_234, new AbortController().signal, fake.timers);
    let given: AbortSignal | undefined;
    const running = bound.run((signal) => ((given = signal), never<void>())).catch((e: unknown) => e);

    fake.set[0]?.fn();
    const error = await running;

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    expect(error instanceof FfmpegTimeoutError && error.timeoutMs).toBe(1_234);
    expect(given?.aborted).toBe(true);
    expect(given?.reason).toBe(error);
  });

  test("a cancel rejects it at once with the cancel's own reason, though the work never settles", async () => {
    const controller = new AbortController();
    const bound = stagingBound(60_000, controller.signal);
    const stop = new Error("cancelled by the owner");
    const running = bound.run(() => never<void>()).catch((e: unknown) => e);

    controller.abort(stop);

    expect(await running).toBe(stop);
    bound.release();
  });

  test("a bound that has already passed refuses the next piece of work without starting it", async () => {
    const fake = fakeTimers();
    const bound = stagingBound(10, new AbortController().signal, fake.timers);
    await bound.run(async () => 1);
    fake.set[0]?.fn();
    let started = 0;

    const error = await bound.run(async () => void started++).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    expect(started).toBe(0);
  });

  test("a cancel that was already there refuses the work without starting it", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const bound = stagingBound(10, controller.signal);
    let started = 0;

    await expect(bound.run(async () => void started++)).rejects.toThrow("stopped");
    expect(started).toBe(0);
    bound.release();
  });

  test("the work's own failure within the bound is its own: it reaches the caller as it is", async () => {
    const bound = stagingBound(60_000, new AbortController().signal);
    const failure = new Error("EIO");

    await expect(bound.run(async () => Promise.reject(failure))).rejects.toBe(failure);
    bound.release();
  });

  test("B7: a hung read that REJECTS after the bound has fired is no unhandled rejection (it would crash the process)", async () => {
    const fake = fakeTimers();
    const bound = stagingBound(10, new AbortController().signal, fake.timers);
    let fail: (error: Error) => void = () => undefined;
    const running = bound.run(() => new Promise<void>((_resolve, reject) => (fail = reject))).catch((e: unknown) => e);

    fake.set[0]?.fn();
    await running;
    fail(new Error("the read returned late, with an error"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(unhandled).toEqual([]);
  });

  test("B7: the same after a cancel", async () => {
    const controller = new AbortController();
    const bound = stagingBound(60_000, controller.signal);
    let fail: (error: Error) => void = () => undefined;
    const running = bound.run(() => new Promise<void>((_resolve, reject) => (fail = reject))).catch((e: unknown) => e);

    controller.abort(new Error("stopped"));
    await running;
    fail(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(unhandled).toEqual([]);
    bound.release();
  });
});

describe("stagingBound.release", () => {
  test("the clock starts with the FIRST piece of work, not when the bound is made (the job has other steps before its staging): one timer of the bound's length", async () => {
    const fake = fakeTimers();
    const bound = stagingBound(4_321, new AbortController().signal, fake.timers);
    expect(fake.set).toHaveLength(0);

    await bound.run(async () => 1);
    await bound.run(async () => 2);

    expect(fake.set).toHaveLength(1);
    expect(fake.set[0]?.ms).toBe(4_321);
  });

  test("B9: releasing clears exactly the timer that was armed", async () => {
    const fake = fakeTimers();
    const bound = stagingBound(4_321, new AbortController().signal, fake.timers);
    await bound.run(async () => 1);
    expect(fake.cleared).toEqual([]);

    bound.release();

    expect(fake.cleared).toEqual([fake.set[0]?.handle]);
  });

  test("releasing twice clears the timer once, and a bound released before any work armed and cleared nothing", async () => {
    const fake = fakeTimers();
    const used = stagingBound(10, new AbortController().signal, fake.timers);
    await used.run(async () => 1);
    used.release();
    used.release();
    expect(fake.cleared).toHaveLength(1);

    const idle = fakeTimers();
    const unused = stagingBound(10, new AbortController().signal, idle.timers);
    unused.release();
    expect(idle.set).toEqual([]);
    expect(idle.cleared).toEqual([]);
  });

  test("work asked for after the release is refused: the staging is over", async () => {
    const bound = stagingBound(10, new AbortController().signal, fakeTimers().timers);
    bound.release();
    await expect(bound.run(async () => 1)).rejects.toThrow();
  });

  test("the real timer does not keep the process alive and is gone after release: a released bound with a short time never fires", async () => {
    const bound = stagingBound(15, new AbortController().signal);
    await bound.run(async () => 1);
    bound.release();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(bound.signal.aborted).toBe(false);
  });
});
