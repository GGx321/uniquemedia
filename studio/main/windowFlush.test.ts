import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { createWindowFlush, type FlushTarget } from "./windowFlush";
useNativeGlobals();

// Before quitting, main asks every window to save what its owner is editing and waits for each to say it is done
// (3d.2 review, HIGH 2). Each ask carries its own id, so only that window's answer to that ask counts.

function target(destroyed = false) {
  const sent: string[] = [];
  const t: FlushTarget = { send: (id) => void sent.push(id), isDestroyed: () => destroyed };
  return { t, sent };
}

function ids(): () => string {
  let n = 0;
  return () => `flush-${String(++n).padStart(4, "0")}`;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("asking the windows to save", () => {
  test("with no window there is nothing to wait for", async () => {
    const flush = createWindowFlush({ targets: () => [], newId: ids() });
    await flush.request();
  });

  test("every window is asked once, and the wait ends only when each of them answered", async () => {
    const a = target();
    const b = target();
    const flush = createWindowFlush({ targets: () => [a.t, b.t], newId: ids() });
    let done = false;
    void flush.request().then(() => (done = true));
    expect(a.sent).toEqual(["flush-0001"]);
    expect(b.sent).toEqual(["flush-0002"]);

    flush.acknowledge("flush-0001");
    await settle();
    expect(done).toBe(false);

    flush.acknowledge("flush-0002");
    await settle();
    expect(done).toBe(true);
  });

  test("an answer to an ask that was never made, a repeated answer, or one that is not an id changes nothing", async () => {
    const a = target();
    const b = target();
    const flush = createWindowFlush({ targets: () => [a.t, b.t], newId: ids() });
    let done = false;
    void flush.request().then(() => (done = true));

    flush.acknowledge("flush-9999");
    flush.acknowledge(42);
    flush.acknowledge({ id: "flush-0002" });
    flush.acknowledge("flush-0001");
    flush.acknowledge("flush-0001");
    await settle();
    expect(done).toBe(false);
  });

  test("a closed window is not asked, and not waited for", async () => {
    const open = target();
    const closed = target(true);
    const flush = createWindowFlush({ targets: () => [open.t, closed.t], newId: ids() });
    let done = false;
    void flush.request().then(() => (done = true));
    expect(closed.sent).toEqual([]);
    flush.acknowledge(open.sent[0]);
    await settle();
    expect(done).toBe(true);
  });

  test("a window whose send throws (it closed meanwhile) is not waited for", async () => {
    const broken: FlushTarget = {
      send: () => {
        throw new Error("Object has been destroyed");
      },
      isDestroyed: () => false,
    };
    const flush = createWindowFlush({ targets: () => [broken], newId: ids() });
    await flush.request();
  });
});
