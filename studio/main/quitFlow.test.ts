import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { createQuitFlow } from "./quitFlow";
useNativeGlobals();

// Quitting Studio: the windows are first asked to save what the owner is editing (3d.2 review, HIGH 2: an edit
// still inside its autosave wait must not be lost to Cmd+Q), then the engine is asked to cancel its renders and let
// a commit that is past its claim finish, BEFORE the app goes. `before-quit` is held while that runs (a second Cmd+Q
// during the wait must not skip it), the quit is asked again once it is over, and the engine is stopped only when the
// quit really goes on (`will-quit`).

function rig(options: { flushTimeoutMs?: number; flush?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const flow = createQuitFlow({
    flushWindows:
      options.flush ??
      (async () => {
        calls.push("flush");
      }),
    flushTimeoutMs: options.flushTimeoutMs ?? 5_000,
    shutdown: () =>
      new Promise<void>((resolve, reject) => {
        calls.push("shutdown");
        finish = resolve;
        fail = reject;
      }),
    quit: () => void calls.push("quit"),
    stop: () => void calls.push("stop"),
  });
  const event = () => {
    const e = { prevented: false, preventDefault: () => void (e.prevented = true) };
    return e;
  };
  return { calls, flow, event, finish: () => finish(), fail: (error: Error) => fail(error) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the quit flow", () => {
  test("holds the first before-quit, asks the windows to save, then starts the soft shutdown, once", async () => {
    const r = rig();
    const first = r.event();

    r.flow.beforeQuit(first);
    await settle();

    expect(first.prevented).toBe(true);
    expect(r.calls).toEqual(["flush", "shutdown"]);
  });

  test("the engine is not shut down while a window is still saving: it waits for the answer", async () => {
    let saved: () => void = () => undefined;
    const r = rig({ flush: () => new Promise<void>((resolve) => (saved = resolve)) });
    r.flow.beforeQuit(r.event());
    await settle();
    expect(r.calls).toEqual([]);

    saved();
    await settle();
    expect(r.calls).toEqual(["shutdown"]);
  });

  test("a window that never answers does not keep the app from quitting: the wait is bounded", async () => {
    const r = rig({ flush: () => new Promise<void>(() => undefined), flushTimeoutMs: 20 });
    r.flow.beforeQuit(r.event());
    await settle();
    expect(r.calls).toEqual([]);

    await wait(40);
    expect(r.calls).toEqual(["shutdown"]);
  });

  test("a save request that fails does not keep the app from quitting", async () => {
    const r = rig({ flush: () => Promise.reject(new Error("the window is gone")) });
    r.flow.beforeQuit(r.event());
    await settle();
    expect(r.calls).toEqual(["shutdown"]);
  });

  test("a second quit during the wait is held too and does NOT skip or repeat the saves or the shutdown", async () => {
    const r = rig();
    r.flow.beforeQuit(r.event());
    const second = r.event();

    r.flow.beforeQuit(second);
    await settle();

    expect(second.prevented).toBe(true);
    expect(r.calls).toEqual(["flush", "shutdown"]);
  });

  test("when the shutdown is over the quit is asked again, and that before-quit goes through", async () => {
    const r = rig();
    r.flow.beforeQuit(r.event());
    await settle();

    r.finish();
    await settle();

    expect(r.calls).toEqual(["flush", "shutdown", "quit"]);
    const again = r.event();
    r.flow.beforeQuit(again);
    expect(again.prevented).toBe(false);
  });

  test("a shutdown that fails does not keep the app from quitting", async () => {
    const r = rig();
    r.flow.beforeQuit(r.event());
    await settle();

    r.fail(new Error("the engine did not answer"));
    await settle();

    expect(r.calls).toEqual(["flush", "shutdown", "quit"]);
  });

  test("the engine is stopped when the quit goes on (will-quit), and never by the flow's own steps", async () => {
    const r = rig();
    r.flow.beforeQuit(r.event());
    await settle();
    r.finish();
    await settle();
    expect(r.calls).not.toContain("stop"); // a quit that another listener cancels leaves the engine running

    r.flow.willQuit();

    expect(r.calls.at(-1)).toBe("stop");
  });
});
