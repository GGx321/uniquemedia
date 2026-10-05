import { describe, expect, test } from "bun:test";
import { command, ok, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// A promise rejection nobody handled is logged and swallowed (processGuards.ts) and the engine goes on: the windows are
// told through an `engine.notice` of code `engine-internal-error`, with a count and no text.

const dir = useEngineDir("studio-engine-notices-");

function noticesOf(events: () => Array<{ type: string; payload: unknown }>): unknown[] {
  return events().flatMap((event) => (event.type === "engine.notice" && typeof event.payload === "object" && event.payload !== null && "notice" in event.payload ? [event.payload.notice] : []));
}

describe("noteUnhandledRejection", () => {
  test("emits one engine.notice with the code and a count of 1, and no text", async () => {
    const { engine, events } = await startEngine(dir());

    engine.noteUnhandledRejection();

    const [notice, ...rest] = noticesOf(events);
    expect(rest).toEqual([]);
    expect(notice).toEqual({ noticeId: expect.any(String), code: "engine-internal-error", at: expect.any(String), count: 1 });
    expect(Object.keys(notice ?? {}).sort()).toEqual(["at", "code", "count", "noticeId"]); // no `detail`: nothing of the error travels
  });

  test("the notice is pending in the snapshot, so a window opened later still sees it", async () => {
    const { engine } = await startEngine(dir());
    engine.noteUnhandledRejection();

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { notices: [{ code: "engine-internal-error", count: 1 }] } });
  });

  test("a burst within the window is one event at once, and the pending notice counts every rejection, once", async () => {
    const { engine, events } = await startEngine(dir());

    for (let n = 0; n < 5; n++) engine.noteUnhandledRejection();

    expect(noticesOf(events)).toHaveLength(1); // the rest wait for the window's end (see the trailing-edge test)
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    expect(snapshot).toMatchObject({ result: { notices: [{ code: "engine-internal-error", count: 5 }] } });
  });

  test("five seconds on, the next rejection is announced again, with the running count and a fresh id", async () => {
    let mono = 0;
    const { engine, events } = await startEngine(dir(), { deps: { monotonic: () => mono } });

    engine.noteUnhandledRejection();
    mono = 4_999;
    engine.noteUnhandledRejection(); // still inside the window: counted, not announced
    mono = 5_000;
    engine.noteUnhandledRejection();

    const notices = noticesOf(events);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ count: 1 });
    expect(notices[1]).toMatchObject({ count: 3 });
    expect(new Set(notices.map((n) => (typeof n === "object" && n !== null && "noticeId" in n ? n.noticeId : null))).size).toBe(2);
  });

  test("what a burst held back is announced when the window ends: the windows end up with the real count, and it is announced once", async () => {
    // a real clock, so the monotonic reading moves with the timer that fires at the window's end
    const { engine, events } = await startEngine(dir(), { deps: { monotonic: () => performance.now(), internalNoticeWindowMs: 40 } });

    for (let n = 0; n < 5; n++) engine.noteUnhandledRejection();
    expect(noticesOf(events)).toHaveLength(1);
    expect(noticesOf(events)[0]).toMatchObject({ count: 1 });

    const deadline = performance.now() + 10_000; // only names a timer that never fires
    while (noticesOf(events).length < 2 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));

    const notices = noticesOf(events);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ code: "engine-internal-error", count: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100)); // and nothing more follows: one trailing announcement, not a chain
    expect(noticesOf(events)).toHaveLength(2);
  });

  test("a trailing announcement that cannot be posted is logged, not thrown out of the timer (an uncaught exception would end the engine)", async () => {
    let failing = false;
    let delivered = 0;
    const logged: string[] = [];
    let logSeen: () => void = () => undefined;
    const loggedOnce = new Promise<void>((resolve) => (logSeen = resolve));
    const realError = console.warn;
    console.warn = (...args: unknown[]) => {
      logged.push(args.join(" "));
      if (logged[logged.length - 1]?.includes("could not be posted") === true) logSeen();
    };
    try {
      const { engine } = await startEngine(dir(), {
        deps: {
          monotonic: () => performance.now(),
          internalNoticeWindowMs: 30,
          post: (message) => {
            if (failing) throw new Error("the port is closed");
            if (typeof message === "object" && message !== null && "type" in message && message.type === "engine.notice") delivered += 1;
          },
        },
      });
      for (let n = 0; n < 3; n++) engine.noteUnhandledRejection();
      failing = true; // only the trailing announcement meets the failure
      // The log line is the event; 10 s only names a timer that never fired.
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const never = new Promise<never>((_, reject) => (giveUp = setTimeout(() => reject(new Error("the trailing announcement never ran")), 10_000)));
      await Promise.race([loggedOnce, never]).finally(() => clearTimeout(giveUp));
      expect(logged.some((line) => line.includes("could not be posted"))).toBe(true);
      expect(logged.join("\n")).not.toContain("the port is closed"); // the error's kind, never its message
      expect(delivered).toBe(1);
    } finally {
      console.warn = realError;
    }
  });

  test("an event that the port refuses does not make the emitter throw: only the log refusing an event does, so no caller retries it into a duplicate", async () => {
    const { engine } = await startEngine(dir(), {
      deps: {
        post: () => {
          throw new Error("the port is closed");
        },
      },
    });
    const realWarn = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
    try {
      expect(() => engine.noteUnhandledRejection()).not.toThrow();
    } finally {
      console.warn = realWarn;
    }
    expect(warned.some((line) => line.includes("could not be posted"))).toBe(true);
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { notices: [{ code: "engine-internal-error", count: 1 }] } });
  });

  test("a shutdown drops the trailing announcement: nothing is posted after the engine said it is stopping", async () => {
    const { engine, events } = await startEngine(dir(), { deps: { monotonic: () => performance.now(), internalNoticeWindowMs: 60 } });
    for (let n = 0; n < 3; n++) engine.noteUnhandledRejection();
    expect(noticesOf(events)).toHaveLength(1);

    await engine.shutdown(0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(noticesOf(events)).toHaveLength(1);
  });

  test("a rejection after shutdown does not arm the trailing timer again", async () => {
    const { engine, events } = await startEngine(dir(), { deps: { monotonic: () => performance.now(), internalNoticeWindowMs: 60 } });
    engine.noteUnhandledRejection();
    expect(noticesOf(events)).toHaveLength(1);

    await engine.shutdown(0);
    engine.noteUnhandledRejection(); // inside the window: it would arm the trailing timer
    engine.noteUnhandledRejection();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(noticesOf(events)).toHaveLength(1);
  });

  test("a single rejection schedules no trailing announcement", async () => {
    const { engine, events } = await startEngine(dir(), { deps: { monotonic: () => performance.now(), internalNoticeWindowMs: 20 } });
    engine.noteUnhandledRejection();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(noticesOf(events)).toHaveLength(1);
  });

  test("it sits beside main's notices: one pending entry per code", async () => {
    const restart = { noticeId: "notice-0002", code: "engine-restarted" as const, detail: "the engine exited unexpectedly (code 9)", at: "2026-09-24T11:59:00.000Z", count: 1 };
    const { engine } = await startEngine(dir(), { init: { notices: [restart] } });

    engine.noteUnhandledRejection();
    engine.noteUnhandledRejection();

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({
      result: { notices: [restart, { code: "engine-internal-error", count: 2 }] },
    });
  });
});
