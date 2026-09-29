import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { createQuitFlow } from "./quitFlow";
useNativeGlobals();

// Quitting Studio: the engine is asked to cancel its renders and let a commit that is past its claim finish, BEFORE the
// app goes. `before-quit` is held while that runs (a second Cmd+Q during the wait must not skip it), the quit is asked
// again once it is over, and the engine is stopped only when the quit really goes on (`will-quit`).

function rig() {
  const calls: string[] = [];
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const flow = createQuitFlow({
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

describe("the quit flow", () => {
  test("holds the first before-quit and starts the soft shutdown, once", () => {
    const r = rig();
    const first = r.event();

    r.flow.beforeQuit(first);

    expect(first.prevented).toBe(true);
    expect(r.calls).toEqual(["shutdown"]);
  });

  test("a second quit during the wait is held too and does NOT skip or repeat the shutdown", () => {
    const r = rig();
    r.flow.beforeQuit(r.event());
    const second = r.event();

    r.flow.beforeQuit(second);

    expect(second.prevented).toBe(true);
    expect(r.calls).toEqual(["shutdown"]);
  });

  test("when the shutdown is over the quit is asked again, and that before-quit goes through", async () => {
    const r = rig();
    r.flow.beforeQuit(r.event());

    r.finish();
    await settle();

    expect(r.calls).toEqual(["shutdown", "quit"]);
    const again = r.event();
    r.flow.beforeQuit(again);
    expect(again.prevented).toBe(false);
  });

  test("a shutdown that fails does not keep the app from quitting", async () => {
    const r = rig();
    r.flow.beforeQuit(r.event());

    r.fail(new Error("the engine did not answer"));
    await settle();

    expect(r.calls).toEqual(["shutdown", "quit"]);
  });

  test("the engine is stopped when the quit goes on (will-quit), and never by the flow's own steps", async () => {
    const r = rig();
    r.flow.beforeQuit(r.event());
    r.finish();
    await settle();
    expect(r.calls).not.toContain("stop"); // a quit that another listener cancels leaves the engine running

    r.flow.willQuit();

    expect(r.calls.at(-1)).toBe("stop");
  });
});
