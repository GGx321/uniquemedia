import { describe, expect, test } from "bun:test";
import { CpuPool, NetworkPool, SHRINK_WINDOW_MS, type Release } from "./pools";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6: the run queue's two pools. The network pool bounds paid requests in
// flight (the settings' concurrency, default 6), shrinks on a 429 and grows
// back slowly; the CPU pool bounds local work (decoding, QA gates).

const never = new AbortController().signal;

/** Lets every queued microtask and resolved promise run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function tracked(pool: NetworkPool, signal = never, opts: { priority?: boolean } = {}) {
  let release: Release | null = null;
  let error: unknown = null;
  const promise = pool.acquire(signal, opts).then(
    (r) => {
      release = r;
    },
    (e: unknown) => {
      error = e;
    },
  );
  return {
    promise,
    granted: () => release !== null,
    error: () => error,
    release: () => {
      if (release === null) throw new Error("not granted");
      release();
    },
  };
}

describe("NetworkPool", () => {
  test("grants up to its limit at once; the next waits for a release", async () => {
    const pool = new NetworkPool({ max: 2 });
    const a = tracked(pool);
    const b = tracked(pool);
    const c = tracked(pool);
    await settle();

    expect([a.granted(), b.granted(), c.granted()]).toEqual([true, true, false]);
    expect(pool.active).toBe(2);

    a.release();
    await settle();
    expect(c.granted()).toBe(true);
    expect(pool.active).toBe(2);
  });

  test("grants waiters in the order they asked", async () => {
    const pool = new NetworkPool({ max: 1 });
    const first = tracked(pool);
    const order: string[] = [];
    const second = pool.acquire(never).then((r) => {
      order.push("second");
      return r;
    });
    const third = pool.acquire(never).then((r) => {
      order.push("third");
      return r;
    });
    await settle();

    first.release();
    (await second)();
    (await third)();

    expect(order).toEqual(["second", "third"]);
  });

  test("a release is idempotent: calling it twice frees one slot, not two", async () => {
    const pool = new NetworkPool({ max: 1 });
    const release = await pool.acquire(never);
    release();
    release();
    expect(pool.active).toBe(0);
    const a = tracked(pool);
    const b = tracked(pool);
    await settle();
    expect([a.granted(), b.granted()]).toEqual([true, false]);
  });

  test("a 429 shrinks the limit by one, never below one", () => {
    let now = 0;
    const pool = new NetworkPool({ max: 3, monotonic: () => now });
    pool.onResponse(429);
    expect(pool.limit).toBe(2);
    for (let i = 0; i < 4; i++) {
      now += SHRINK_WINDOW_MS;
      pool.onResponse(429);
    }
    expect(pool.limit).toBe(1);
  });

  test("a burst of 429s (every request in flight hit by one limit) shrinks it once per window, not once per response", () => {
    let now = 1_000;
    const pool = new NetworkPool({ max: 6, monotonic: () => now });
    for (let i = 0; i < 6; i++) pool.onResponse(429);
    expect(pool.limit).toBe(5);

    now += SHRINK_WINDOW_MS - 1;
    pool.onResponse(429);
    expect(pool.limit).toBe(5);

    now += 1;
    pool.onResponse(429);
    expect(pool.limit).toBe(4);
  });

  test("after a shrink, a new request waits until the ones in flight are below the new limit", async () => {
    const pool = new NetworkPool({ max: 3 });
    const held = [tracked(pool), tracked(pool), tracked(pool)];
    await settle();
    pool.onResponse(429);
    const next = tracked(pool);

    held[0]?.release();
    await settle();
    expect(next.granted()).toBe(false);

    held[1]?.release();
    await settle();
    expect(next.granted()).toBe(true);
    expect(pool.active).toBe(2);
  });

  test("recovers in proportion to its limit: one slot back per `limit` successes in a row (at least two), never above its max", () => {
    let now = 0;
    const pool = new NetworkPool({ max: 6, monotonic: () => now });
    for (let i = 0; i < 5; i++) {
      pool.onResponse(429);
      now += SHRINK_WINDOW_MS;
    }
    expect(pool.limit).toBe(1);

    const successesToGrow: number[] = [];
    let streak = 0;
    while (pool.limit < 6) {
      const before = pool.limit;
      pool.onResponse(200);
      streak++;
      if (pool.limit !== before) {
        successesToGrow.push(streak);
        streak = 0;
      }
    }
    expect(successesToGrow).toEqual([2, 2, 3, 4, 5]);
    for (let i = 0; i < 20; i++) pool.onResponse(200);
    expect(pool.limit).toBe(6);
  });

  test("a 429 resets the success streak; other statuses neither shrink nor count", () => {
    let now = 0;
    const pool = new NetworkPool({ max: 3, monotonic: () => now });
    pool.onResponse(429);
    now += SHRINK_WINDOW_MS;
    pool.onResponse(429);
    expect(pool.limit).toBe(1);

    pool.onResponse(200);
    now += SHRINK_WINDOW_MS;
    pool.onResponse(429);
    pool.onResponse(200);
    expect(pool.limit).toBe(1);

    pool.onResponse(500);
    pool.onResponse(400);
    expect(pool.limit).toBe(1);
    pool.onResponse(200);
    expect(pool.limit).toBe(2);
  });

  test("recovering wakes a waiter", async () => {
    const pool = new NetworkPool({ max: 2 });
    pool.onResponse(429);
    const a = tracked(pool);
    const b = tracked(pool);
    await settle();
    expect(b.granted()).toBe(false);

    pool.onResponse(200);
    pool.onResponse(200);
    await settle();
    expect(b.granted()).toBe(true);
    a.release();
    b.release();
  });

  test("an abort while waiting rejects with the signal's reason and leaves no slot taken", async () => {
    const pool = new NetworkPool({ max: 1 });
    const held = tracked(pool);
    const controller = new AbortController();
    const waiting = tracked(pool, controller.signal);
    await settle();

    const reason = new Error("cancelled");
    controller.abort(reason);
    await waiting.promise;

    expect(waiting.error()).toBe(reason);
    held.release();
    expect(pool.active).toBe(0);
    const next = tracked(pool);
    await settle();
    expect(next.granted()).toBe(true);
  });

  test("an already aborted signal is refused at once", async () => {
    const pool = new NetworkPool({ max: 1 });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const refused = tracked(pool, controller.signal);
    await refused.promise;
    expect(refused.error()).toBe(controller.signal.reason);
    expect(pool.active).toBe(0);
  });

  test("setMax raises or lowers the ceiling and clamps the current limit to it", async () => {
    const pool = new NetworkPool({ max: 2 });
    pool.setMax(4);
    expect(pool.limit).toBe(4);
    pool.setMax(1);
    expect(pool.limit).toBe(1);
  });

  test("refuses a max that is not a positive integer", () => {
    expect(() => new NetworkPool({ max: 0 })).toThrow(RangeError);
    expect(() => new NetworkPool({ max: 1.5 })).toThrow(RangeError);
    expect(() => new NetworkPool({ max: 2, shrinkWindowMs: -1 })).toThrow(RangeError);
  });
});

describe("CpuPool", () => {
  test("runs at most `size` tasks at once and answers each task's own result", async () => {
    const pool = new CpuPool(2);
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const task = (value: number) => () =>
      new Promise<number>((resolve) => {
        running++;
        peak = Math.max(peak, running);
        gates.push(() => {
          running--;
          resolve(value);
        });
      });
    const results = [1, 2, 3, 4].map((v) => pool.run(task(v), never));
    await settle();
    expect(peak).toBe(2);
    while (gates.length > 0) {
      gates.shift()?.();
      await settle();
    }
    expect(await Promise.all(results)).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  test("a task that throws frees its slot and rejects with its own error", async () => {
    const pool = new CpuPool(1);
    const boom = new Error("boom");
    await expect(pool.run(async () => Promise.reject(boom), never)).rejects.toBe(boom);
    expect(await pool.run(async () => "next", never)).toBe("next");
  });

  test("an abort frees a running task's slot at once, even if the task itself never settles (review round 3, L-c)", async () => {
    const pool = new CpuPool(1);
    const controller = new AbortController();
    const hung = pool.run(() => new Promise<never>(() => {}), controller.signal);
    void hung;
    await settle();
    let ran = false;
    const next = pool.run(async () => {
      ran = true;
    }, never);
    await settle();
    expect(ran).toBe(false);

    controller.abort(new Error("cancelled"));
    await next;
    expect(ran).toBe(true);
  });

  test("an abort that lands between the slot's grant and the task's start still frees the slot (final review, micro-window)", async () => {
    const pool = new CpuPool(1);
    const controller = new AbortController();
    // The slot is granted at once, but run() resumes after its await only on a later microtask: abort before that.
    const hung = pool.run(() => new Promise<never>(() => {}), controller.signal);
    void hung;
    controller.abort(new Error("cancelled"));
    let ran = false;
    const next = pool.run(async () => {
      ran = true;
    }, never);
    await settle();
    expect(ran).toBe(true);
    await next;
  });

  test("a task still waiting is dropped on abort and never runs", async () => {
    const pool = new CpuPool(1);
    let release: () => void = () => {};
    const first = pool.run(() => new Promise<void>((resolve) => (release = resolve)), never);
    const controller = new AbortController();
    let ran = false;
    const second = pool.run(async () => {
      ran = true;
    }, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    release();
    await first;
    expect(ran).toBe(false);
  });
});

// T7a review (finding 1): a paid QA gate's own request is work already paid
// for (and, per finding 3, a request that shrinks the window in which a stop
// would otherwise drop that paid image) — it must not be starved behind a
// stream of brand new image attempts in a busy run. `acquire`'s own
// `{ priority: true }` gives it a separate, first-served queue.
describe("NetworkPool priority lane", () => {
  test("a priority acquire is granted before an earlier-queued, non-priority waiter", async () => {
    const pool = new NetworkPool({ max: 1 });
    const holder = tracked(pool);
    await settle();
    expect(holder.granted()).toBe(true);

    const ordinary = tracked(pool); // queued first, no priority
    await settle();
    const priority = tracked(pool, never, { priority: true }); // queued second, but priority
    await settle();
    expect([ordinary.granted(), priority.granted()]).toEqual([false, false]);

    holder.release();
    await settle();

    expect(priority.granted()).toBe(true);
    expect(ordinary.granted()).toBe(false);
  });

  test("priority waiters are served in the order they asked, among themselves", async () => {
    const pool = new NetworkPool({ max: 1 });
    const holder = tracked(pool);
    await settle();
    const order: string[] = [];
    const first = pool.acquire(never, { priority: true }).then((r) => {
      order.push("first");
      return r;
    });
    const second = pool.acquire(never, { priority: true }).then((r) => {
      order.push("second");
      return r;
    });
    await settle();

    holder.release();
    (await first)();
    (await second)();

    expect(order).toEqual(["first", "second"]);
  });

  test("non-priority waiters still get their turn once every priority waiter is served", async () => {
    const pool = new NetworkPool({ max: 1 });
    const holder = tracked(pool);
    await settle();
    const ordinary = tracked(pool);
    const priority = tracked(pool, never, { priority: true });
    await settle();

    holder.release();
    await settle();
    expect(priority.granted()).toBe(true);
    expect(ordinary.granted()).toBe(false);

    priority.release();
    await settle();
    expect(ordinary.granted()).toBe(true);
  });

  test("without the option, acquire behaves exactly as before (plain FIFO, no priority queue involved)", async () => {
    const pool = new NetworkPool({ max: 1 });
    const first = tracked(pool);
    const second = tracked(pool);
    await settle();
    expect([first.granted(), second.granted()]).toEqual([true, false]);
    first.release();
    await settle();
    expect(second.granted()).toBe(true);
  });

  test("an aborted priority waiter is removed from its own queue, not the other one", async () => {
    const pool = new NetworkPool({ max: 1 });
    const holder = tracked(pool);
    await settle();
    const controller = new AbortController();
    const priority = tracked(pool, controller.signal, { priority: true });
    const ordinary = tracked(pool);
    await settle();

    controller.abort(new Error("cancelled"));
    await settle();
    expect(priority.error()).not.toBeNull();

    holder.release();
    await settle();
    expect(ordinary.granted()).toBe(true);
  });
});
