import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterError } from "../openrouter/errors";
import { BALANCE_CACHE_MS, BALANCE_FAILURE_MS, BALANCE_WAIT_MS, balanceMicrosOf, createBalanceProbe } from "./balance";
import { Budget } from "./budget";
import { Ledger } from "./ledger";
import { reconcile, type CreditsFetcher } from "./reconcile";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const body = (data: Record<string, unknown>): unknown => ({ data });

describe("balanceMicrosOf", () => {
  test("is total_credits minus total_usage in micros", () => {
    expect(balanceMicrosOf(body({ total_credits: 20, total_usage: 1.2345 }))).toBe(18_765_500);
  });

  test("is null when total_credits is absent", () => {
    expect(balanceMicrosOf(body({ total_usage: 1 }))).toBeNull();
  });

  test("is null when total_credits is null", () => {
    expect(balanceMicrosOf(body({ total_credits: null, total_usage: 1 }))).toBeNull();
  });

  test("is null when total_credits is a string", () => {
    expect(balanceMicrosOf(body({ total_credits: "20", total_usage: 1 }))).toBeNull();
  });

  test("is null when total_credits is negative", () => {
    expect(balanceMicrosOf(body({ total_credits: -5, total_usage: 0 }))).toBeNull();
  });

  test("is null when total_credits is not finite", () => {
    expect(balanceMicrosOf(body({ total_credits: Number.POSITIVE_INFINITY, total_usage: 0 }))).toBeNull();
  });

  test("is null when total_usage is absent", () => {
    expect(balanceMicrosOf(body({ total_credits: 5 }))).toBeNull();
  });

  test("is null when total_usage is negative", () => {
    expect(balanceMicrosOf(body({ total_credits: 5, total_usage: -1 }))).toBeNull();
  });

  test("is null when total_usage is a string", () => {
    expect(balanceMicrosOf(body({ total_credits: 5, total_usage: "1" }))).toBeNull();
  });

  test("is null when the body has no data object", () => {
    expect(balanceMicrosOf(null)).toBeNull();
    expect(balanceMicrosOf("x")).toBeNull();
    expect(balanceMicrosOf({ total_credits: 5, total_usage: 1 })).toBeNull();
  });

  test("rounds down when the credits carry sub-micro decimals", () => {
    expect(balanceMicrosOf(body({ total_credits: 10.1234569, total_usage: 0 }))).toBe(10_123_456);
  });

  test("rounds the usage up, so the balance is never overstated", () => {
    expect(balanceMicrosOf(body({ total_credits: 10, total_usage: 0.1234561 }))).toBe(9_876_543);
  });

  test("keeps an exact decimal exact despite float noise", () => {
    expect(balanceMicrosOf(body({ total_credits: 0.045, total_usage: 0 }))).toBe(45_000);
  });

  test("is zero, not negative, when the account is overdrawn", () => {
    expect(balanceMicrosOf(body({ total_credits: 1, total_usage: 3 }))).toBe(0);
  });

  test("is null when both figures are beyond the safe range, even though their difference is small", () => {
    expect(balanceMicrosOf(body({ total_credits: 1e17, total_usage: 1e17 }))).toBeNull();
  });

  test("is null when only the usage is beyond the safe range", () => {
    expect(balanceMicrosOf(body({ total_credits: 5, total_usage: 1e17 }))).toBeNull();
  });

  test("is null when the figure is beyond the safe integer range", () => {
    expect(balanceMicrosOf(body({ total_credits: 1e12, total_usage: 0 }))).toBeNull();
  });
});

type Reply = unknown | Error | (() => Promise<unknown>);

function setup(replies: Reply[], opts: { key?: string | null; waitMs?: number } = {}) {
  let now = Date.parse("2026-10-09T10:00:00.000Z");
  let mono = 1_000;
  let gets = 0;
  let key: string | null = opts.key === undefined ? "A" : opts.key;
  let sourceThrows = false;
  let sourceCalls = 0;
  const idsOfGets: string[] = [];
  const failures: unknown[] = [];
  const probe = createBalanceProbe({
    clock: () => now,
    monotonic: () => mono,
    waitMs: opts.waitMs,
    source: () => {
      sourceCalls += 1;
      if (sourceThrows) throw new Error("source broke");
      if (key === null) return null;
      const id = key;
      const fetch: CreditsFetcher = async () => {
        const reply = replies[Math.min(gets, replies.length - 1)];
        gets += 1;
        idsOfGets.push(id);
        if (reply instanceof Error) throw reply;
        if (typeof reply === "function") return (reply as () => Promise<unknown>)();
        return reply;
      };
      return { id, fetch };
    },
    onFailure: (error) => failures.push(error),
  });
  return {
    probe,
    failures,
    idsOfGets,
    gets: () => gets,
    sourceCalls: () => sourceCalls,
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
    setClock: (deltaMs: number) => void (now += deltaMs),
    setMono: (deltaMs: number) => void (mono += deltaMs),
    setKey: (next: string | null) => void (key = next),
    dropKey: () => void (key = null),
    breakSource: () => void (sourceThrows = true),
  };
}

const OK = body({ total_credits: 20, total_usage: 5 });

describe("createBalanceProbe", () => {
  test("answers the balance with the time it was read", async () => {
    const t = setup([OK]);
    expect(await t.probe.read()).toEqual({ micros: 15_000_000, asOf: "2026-10-09T10:00:00.000Z" });
  });

  test("sends no request without a key and answers null", async () => {
    const t = setup([OK], { key: null });
    expect(await t.probe.read()).toBeNull();
    expect(t.gets()).toBe(0);
  });

  test("sends one GET for two reads inside the cache window", async () => {
    const t = setup([OK]);
    const first = await t.probe.read();
    t.advance(BALANCE_CACHE_MS);
    const second = await t.probe.read();
    expect(t.gets()).toBe(1);
    expect(second).toEqual(first);
  });

  test("sends a new GET one millisecond after the cache window", async () => {
    const t = setup([OK, body({ total_credits: 20, total_usage: 6 })]);
    await t.probe.read();
    t.advance(BALANCE_CACHE_MS + 1);
    const second = await t.probe.read();
    expect(t.gets()).toBe(2);
    expect(second?.micros).toBe(14_000_000);
  });

  test("shares one GET between reads that overlap", async () => {
    const t = setup([OK]);
    const [a, b] = await Promise.all([t.probe.read(), t.probe.read()]);
    expect(t.gets()).toBe(1);
    expect(a).toEqual(b);
  });

  test("answers null and does not throw when the request fails", async () => {
    const t = setup([new Error("network down")]);
    expect(await t.probe.read()).toBeNull();
  });

  test("reports the failure to the caller's hook", async () => {
    const boom = new Error("network down");
    const t = setup([boom]);
    await t.probe.read();
    expect(t.failures).toEqual([boom]);
  });

  test("does not cache a failure: the next read asks again", async () => {
    const t = setup([new Error("network down"), OK]);
    await t.probe.read();
    expect((await t.probe.read())?.micros).toBe(15_000_000);
    expect(t.gets()).toBe(2);
  });

  test("answers null for a body without total_credits", async () => {
    const t = setup([body({ total_usage: 1 })]);
    expect(await t.probe.read()).toBeNull();
  });

  test("answers null without a request once the key is gone, even inside the window", async () => {
    const t = setup([OK]);
    await t.probe.read();
    t.dropKey();
    expect(await t.probe.read()).toBeNull();
    expect(t.gets()).toBe(1);
  });
});

const NEVER = (): Promise<unknown> => new Promise(() => {});

function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("the wait budget", () => {
  test("is two seconds", () => {
    expect(BALANCE_WAIT_MS).toBe(2_000);
  });

  test("read answers null within the budget when the request never settles", async () => {
    const t = setup([NEVER], { waitMs: 20 });
    const started = performance.now();
    expect(await t.probe.read()).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("the request keeps running and fills the cache for the next read", async () => {
    const slow = deferred();
    const t = setup([() => slow.promise], { waitMs: 20 });
    expect(await t.probe.read()).toBeNull();
    slow.resolve(OK);
    await Bun.sleep(5);
    expect((await t.probe.read())?.micros).toBe(15_000_000);
    expect(t.gets()).toBe(1);
  });

  test("a read during the slow request joins it instead of sending another", async () => {
    const t = setup([NEVER], { waitMs: 20 });
    await t.probe.read();
    await t.probe.read();
    expect(t.gets()).toBe(1);
  });
});

describe("cached failures", () => {
  const timeout = new OpenRouterError("TIMEOUT", "GET /credits: no response");
  const network = new OpenRouterError("NETWORK", "GET /credits: down");

  test("a TIMEOUT is not retried within 30 seconds", async () => {
    const t = setup([timeout, OK]);
    await t.probe.read();
    t.advance(BALANCE_FAILURE_MS);
    expect(await t.probe.read()).toBeNull();
    expect(t.gets()).toBe(1);
  });

  test("a NETWORK failure is not retried within 30 seconds", async () => {
    const t = setup([network, OK]);
    await t.probe.read();
    t.advance(1_000);
    await t.probe.read();
    expect(t.gets()).toBe(1);
  });

  test("a failure is retried after 30 seconds", async () => {
    const t = setup([timeout, OK]);
    await t.probe.read();
    t.advance(BALANCE_FAILURE_MS + 1);
    expect((await t.probe.read())?.micros).toBe(15_000_000);
    expect(t.gets()).toBe(2);
  });

  test("a 401 is not cached as a failure window", async () => {
    const t = setup([new OpenRouterError("AUTH_INVALID", "401"), OK]);
    await t.probe.read();
    expect((await t.probe.read())?.micros).toBe(15_000_000);
  });

  test("a failure cached for key A does not hold back key B", async () => {
    const t = setup([timeout, OK]);
    await t.probe.read();
    t.setKey("B");
    expect((await t.probe.read())?.micros).toBe(15_000_000);
  });
});

describe("a change of key", () => {
  test("replacing key A with B inside the window sends a GET with B", async () => {
    const t = setup([OK]);
    await t.probe.read();
    t.setKey("B");
    await t.probe.read();
    expect(t.idsOfGets).toEqual(["A", "B"]);
  });

  test("a read under B does not join A's pending request", async () => {
    const a = deferred();
    const t = setup([() => a.promise, OK], { waitMs: 20 });
    await t.probe.read();
    t.setKey("B");
    const underB = await t.probe.read();
    expect(t.idsOfGets).toEqual(["A", "B"]);
    expect(underB?.micros).toBe(15_000_000);
  });

  test("A's late answer after the key was cleared does not repopulate the cache", async () => {
    const a = deferred();
    const t = setup([() => a.promise, OK], { waitMs: 20 });
    await t.probe.read();
    t.dropKey();
    await t.probe.read();
    t.setKey("A");
    a.resolve(body({ total_credits: 99, total_usage: 0 }));
    await Bun.sleep(5);
    expect((await t.probe.read())?.micros).toBe(20_000_000 - 5_000_000);
    expect(t.gets()).toBe(2);
  });

  test("A's late answer after B took over does not overwrite B's cache", async () => {
    const a = deferred();
    const t = setup([() => a.promise, OK], { waitMs: 20 });
    await t.probe.read();
    t.setKey("B");
    await t.probe.read();
    a.resolve(body({ total_credits: 99, total_usage: 0 }));
    await Bun.sleep(5);
    expect((await t.probe.read())?.micros).toBe(15_000_000);
  });
});

describe("the cache age", () => {
  test("a wall clock set back by an hour does not refetch", async () => {
    const t = setup([OK]);
    await t.probe.read();
    t.setClock(-3_600_000);
    await t.probe.read();
    expect(t.gets()).toBe(1);
  });

  test("asOf follows the wall clock, the age follows the monotonic one", async () => {
    const t = setup([OK, OK]);
    const first = await t.probe.read();
    t.advance(BALANCE_CACHE_MS + 1);
    t.setClock(-3_600_000);
    const second = await t.probe.read();
    expect(Date.parse(second?.asOf ?? "")).toBeLessThan(Date.parse(first?.asOf ?? ""));
    expect(t.gets()).toBe(2);
  });

  test("a monotonic clock that went backwards refetches", async () => {
    const t = setup([OK]);
    await t.probe.read();
    t.setMono(-500);
    await t.probe.read();
    expect(t.gets()).toBe(2);
  });
});

describe("a source that breaks", () => {
  test("read answers null when source throws", async () => {
    const t = setup([OK]);
    t.breakSource();
    expect(await t.probe.read()).toBeNull();
  });

  test("the throw is reported to onFailure", async () => {
    const t = setup([OK]);
    t.breakSource();
    await t.probe.read();
    expect(t.failures.length).toBe(1);
  });

  test("a hook that throws does not make read throw", async () => {
    const probe = createBalanceProbe({
      clock: () => 0,
      monotonic: () => 0,
      source: () => {
        throw new Error("source broke");
      },
      onFailure: () => {
        throw new Error("hook broke");
      },
    });
    expect(await probe.read()).toBeNull();
  });

});

describe("reconcile is unaffected by total_credits", () => {
  async function reconcileWith(data: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "studio-balance-"));
    try {
      const ledger = await Ledger.open(join(dir, "ledger.jsonl"));
      let mono = 1_000;
      const budget = new Budget(ledger, {
        runCapMicros: 10_000_000,
        monthlyBudgetMicros: 10_000_000,
        clock: () => Date.parse("2026-10-09T10:00:00.000Z"),
        monotonic: () => mono,
      });
      mono += 5 * 60_000;
      return await reconcile(budget, { fetchCredits: async () => ({ data }) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("reads the same total_usage whether total_credits is a number", async () => {
    expect(await reconcileWith({ total_credits: 25, total_usage: 1.5 })).toMatchObject({ ok: true, creditsUsageMicros: 1_500_000 });
  });

  test("reads the same total_usage whether total_credits is a string", async () => {
    expect(await reconcileWith({ total_credits: "oops", total_usage: 1.5 })).toMatchObject({ ok: true, creditsUsageMicros: 1_500_000 });
  });

  test("reads the same total_usage whether total_credits is absent", async () => {
    expect(await reconcileWith({ total_usage: 1.5 })).toMatchObject({ ok: true, creditsUsageMicros: 1_500_000 });
  });
});
