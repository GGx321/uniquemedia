import { describe, expect, test } from "bun:test";
import { createDiskGate, DiskGateError } from "./diskGate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 3 whole-slice review L5: `studio-media://` did file work (lstat, realpath, open, read) with no limit on how many requests ran at once and no deadline. A
// library or export folder on a share that stops answering ties up one of libuv's four threads per request until the share gives up, and with four of them main's
// own file work (settings, keys, the app's assets) waits behind them: the window freezes. The gate bounds how many operations are in flight, answers a request that
// waits too long (busy) or runs too long (timeout) without waiting for the disk, and keeps a slot taken until the operation REALLY ends, so the bound on threads
// holds while a share is dead.

interface Pending<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function pending<T>(): Pending<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// One full turn of the event loop: every pending microtask has run, and no timer that is not already due has. Unlike a wall-clock bound it cannot be tipped by a
// stalled process (a GC pause, CPU starvation in a shard that runs thousands of tests): a stall delays the turn, it does not reorder what happens inside it.
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DiskGateError) return error.reason;
    throw error;
  }
  return "resolved";
}

describe("the disk gate", () => {
  test("runs an operation and returns what it returned", async () => {
    const gate = createDiskGate({ maxConcurrent: 2, deadlineMs: 1000, maxQueued: 8 });
    expect(await gate.run(async () => 42)).toBe(42);
  });

  test("passes an operation's own error through, and frees its slot", async () => {
    const gate = createDiskGate({ maxConcurrent: 1, deadlineMs: 1000, maxQueued: 8 });
    await expect(gate.run(async () => Promise.reject(new Error("ENOENT")))).rejects.toThrow("ENOENT");
    await expect(gate.run(() => { throw new Error("sync"); })).rejects.toThrow("sync");
    expect(await gate.run(async () => "after")).toBe("after");
    expect(gate.inFlight).toBe(0);
  });

  test("never has more than maxConcurrent operations in flight", async () => {
    const gate = createDiskGate({ maxConcurrent: 2, deadlineMs: 5000, maxQueued: 32 });
    let active = 0;
    let most = 0;
    const gates = Array.from({ length: 8 }, () => pending<void>());
    const runs = gates.map((g) =>
      gate.run(async () => {
        active++;
        most = Math.max(most, active);
        await g.promise;
        active--;
      }),
    );
    await tick(5);
    expect(active).toBe(2);
    for (const g of gates) {
      g.resolve();
      await tick(1);
    }
    await Promise.all(runs);
    expect(most).toBe(2);
  });

  test("a queued operation starts, in order, when a slot frees", async () => {
    const gate = createDiskGate({ maxConcurrent: 1, deadlineMs: 5000, maxQueued: 8 });
    const order: string[] = [];
    const first = pending<void>();
    const a = gate.run(async () => {
      order.push("a");
      await first.promise;
    });
    const b = gate.run(async () => void order.push("b"));
    const c = gate.run(async () => void order.push("c"));
    await tick(5);
    expect(order).toEqual(["a"]);
    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("an operation that outlasts the deadline is answered `timeout` without waiting for it", async () => {
    const gate = createDiskGate({ maxConcurrent: 2, deadlineMs: 30, maxQueued: 8 });
    const never = pending<void>();
    // `never` is never settled, so getting an answer at all proves the gate did not wait for the operation; no wall-clock bound is needed (nor safe under load).
    expect(await reasonOf(gate.run(() => never.promise))).toBe("timeout");
  });

  test("a timed-out operation keeps its slot until it really ends: the bound on threads holds while a share is dead", async () => {
    const gate = createDiskGate({ maxConcurrent: 2, deadlineMs: 30, maxQueued: 8 });
    const hung = [pending<void>(), pending<void>()];
    const ran: number[] = [];
    const first = hung.map((h, i) => gate.run(async () => { ran.push(i); await h.promise; }));
    expect(await Promise.all(first.map(reasonOf))).toEqual(["timeout", "timeout"]);
    expect(gate.inFlight).toBe(2);
    // The third finds no slot: it waits, runs out of its own deadline, and never touches the disk.
    let thirdRan = false;
    expect(await reasonOf(gate.run(async () => void (thirdRan = true)))).toBe("busy");
    expect(thirdRan).toBe(false);
    expect(ran).toEqual([0, 1]);
  });

  test("the slots come back when the hung operations finally end", async () => {
    const gate = createDiskGate({ maxConcurrent: 2, deadlineMs: 30, maxQueued: 8 });
    const hung = [pending<void>(), pending<void>()];
    const first = hung.map((h) => gate.run(() => h.promise));
    await Promise.all(first.map(reasonOf));
    expect(await reasonOf(gate.run(async () => "x"))).toBe("busy");
    hung[0]?.resolve();
    hung[1]?.reject(new Error("the share came back with an error"));
    await tick(5);
    expect(gate.inFlight).toBe(0);
    expect(await gate.run(async () => "served")).toBe("served");
  });

  test("an operation waiting for a slot past the deadline is `busy`, and never runs", async () => {
    const gate = createDiskGate({ maxConcurrent: 1, deadlineMs: 40, maxQueued: 8 });
    const hold = pending<void>();
    const holder = gate.run(() => hold.promise);
    let ran = false;
    const waiting = gate.run(async () => void (ran = true));
    expect(await reasonOf(waiting)).toBe("busy");
    hold.resolve();
    await holder.catch(() => undefined);
    await tick(5);
    expect(ran).toBe(false);
  });

  test("a full queue answers `busy` at once", async () => {
    // The deadline is far beyond the test: only the full queue can be what answers.
    const gate = createDiskGate({ maxConcurrent: 1, deadlineMs: 60_000, maxQueued: 2 });
    const hold = pending<void>();
    const running = gate.run(() => hold.promise);
    const queued = [gate.run(async () => 1), gate.run(async () => 2)];
    const overflow = gate.run(async () => 3);
    let answered = false;
    overflow.then(() => (answered = true), () => (answered = true));
    await nextTurn();
    expect(answered).toBe(true);
    expect(await reasonOf(overflow)).toBe("busy");
    expect(gate.queued).toBe(2);
    hold.resolve();
    await Promise.all([running, ...queued]);
  });

  test("a request that is aborted while it waits leaves the queue and never runs", async () => {
    const gate = createDiskGate({ maxConcurrent: 1, deadlineMs: 5000, maxQueued: 8 });
    const hold = pending<void>();
    const running = gate.run(() => hold.promise);
    const controller = new AbortController();
    let ran = false;
    const waiting = gate.run(async () => void (ran = true), controller.signal);
    expect(gate.queued).toBe(1);
    controller.abort();
    expect(await reasonOf(waiting)).toBe("aborted");
    expect(gate.queued).toBe(0);
    hold.resolve();
    await running;
    await tick(5);
    expect(ran).toBe(false);
  });

  test("a request already aborted never starts", async () => {
    const gate = createDiskGate({ maxConcurrent: 2, deadlineMs: 5000, maxQueued: 8 });
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    expect(await reasonOf(gate.run(async () => void (ran = true), controller.signal))).toBe("aborted");
    expect(ran).toBe(false);
  });

  test("the deadline is cleared once an operation ends: nothing is left to fire", async () => {
    const gate = createDiskGate({ maxConcurrent: 1, deadlineMs: 30, maxQueued: 8 });
    expect(await gate.run(async () => "quick")).toBe("quick");
    await tick(60);
    expect(gate.inFlight).toBe(0);
  });
});
