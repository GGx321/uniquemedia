import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, type ReserveHandle, type ReserveResult } from "./budget";
import { Ledger, type LedgerLine, type ReserveLine, type Scope } from "./ledger";
import { RECONCILE_TOLERANCE_MICROS, reconcile, type CreditsFetcher } from "./reconcile";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-reconcile-"));
  path = join(dir, "ledger.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RUN: Scope = { runId: "run-1" };
const T0 = "2026-09-24T12:00:00.000Z";
/** Quiet for every T0 ledger: past an open reserve's request timeout (180 s) plus the 2-minute wait. */
const QUIET = "2026-09-24T12:05:00.000Z";
const MIN = 60_000;

/** `openedMsAgo`: how long this process has had the ledger open (monotonic); 5 minutes by default, like QUIET. */
async function setup(opts: { lines?: LedgerLine[]; raw?: string; now?: string; openedMsAgo?: number } = {}) {
  if (opts.lines || opts.raw !== undefined) {
    await writeFile(path, (opts.lines ?? []).map((l) => `${JSON.stringify(l)}\n`).join("") + (opts.raw ?? ""));
  }
  let now = Date.parse(opts.now ?? QUIET);
  let mono = 1_000;
  const ledger = await Ledger.open(path);
  const budget = new Budget(ledger, { runCapMicros: 10_000_000, monthlyBudgetMicros: 10_000_000, clock: () => now, monotonic: () => mono });
  mono += opts.openedMsAgo ?? 5 * MIN;
  return {
    budget,
    ledger,
    setNow: (iso: string) => (now = Date.parse(iso)),
    /** Moves both clocks forward together, as real time passes. */
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
    /** Moves only the monotonic clock, as when the wall clock is wrong. */
    advanceMono: (ms: number) => (mono += ms),
  };
}

function credits(totalUsageUsd: number): CreditsFetcher & { calls: () => number } {
  let calls = 0;
  const fetcher = async (): Promise<unknown> => {
    calls++;
    return { data: { total_credits: 25, total_usage: totalUsageUsd } };
  };
  return Object.assign(fetcher, { calls: () => calls });
}

function reserveLine(attemptId: string, worstMicros: number, at = T0): ReserveLine {
  return { type: "reserve", attemptId, jobId: `job-${attemptId}`, scope: RUN, model: "x-ai/grok-imagine-image-2.0", worstMicros, at };
}

function settleLine(attemptId: string, costMicros: number, at = T0): LedgerLine {
  return { type: "settle", attemptId, costMicros, estimated: false, at };
}

function marker(creditsUsageMicros: number, at = T0): LedgerLine {
  return { type: "reconcile", creditsUsageMicros, ledgerTotalMicros: 0, aboveWorstAttempts: [], at };
}

function handleOf(result: ReserveResult): ReserveHandle {
  if (!result.ok) throw new Error(`expected a reservation, got ${result.reason}`);
  return result.handle;
}

async function fileLines(): Promise<unknown[]> {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const reserveReq = (attemptId: string, worstMicros = 1) => ({ attemptId, jobId: "j", scope: RUN, model: "m", worstMicros });

// ---------- the wait after the last activity ----------

test("refuses while the last ledger write is under 2 minutes old and says how long to wait", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000), settleLine("a#1", 50_000)], now: "2026-09-24T12:01:59.999Z" });
  const fetchCredits = credits(1);
  const before = await readFile(path, "utf8");

  const result = await reconcile(budget, { fetchCredits });

  expect(result).toEqual({ ok: false, reason: "TOO_SOON", retryAfterMs: 1, warnings: [] });
  expect(fetchCredits.calls()).toBe(0);
  expect(await readFile(path, "utf8")).toBe(before);
});

test("proceeds at exactly 2 minutes after the last write", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000), settleLine("a#1", 50_000)], now: "2026-09-24T12:02:00.000Z" });

  expect((await reconcile(budget, { fetchCredits: credits(1) })).ok).toBe(true);
});

test("an open reserve of an earlier process counts as active until its request timeout", async () => {
  const { budget, setNow } = await setup({ lines: [reserveLine("a#1", 50_000)], now: "2026-09-24T12:04:59.999Z" });

  expect(await reconcile(budget, { fetchCredits: credits(1) })).toEqual({ ok: false, reason: "TOO_SOON", retryAfterMs: 1, warnings: [] });
  setNow("2026-09-24T12:05:00.000Z");
  expect((await reconcile(budget, { fetchCredits: credits(1) })).ok).toBe(true);
});

test("an attempt this process abandoned counts as active from the moment it was abandoned", async () => {
  const { budget, advance } = await setup({ now: T0 });
  const handle = handleOf(await budget.tryReserve(reserveReq("a#1", 50_000)));
  advance(170_000); // the request timed out late
  await budget.abandon(handle);
  advance(30_000);

  expect(await reconcile(budget, { fetchCredits: credits(1) })).toEqual({ ok: false, reason: "TOO_SOON", retryAfterMs: 90_000, warnings: [] });
  advance(90_000);
  expect((await reconcile(budget, { fetchCredits: credits(1) })).ok).toBe(true);
});

test("refuses while an attempt of this process is still in flight", async () => {
  const { budget, advance } = await setup({ now: T0 });
  await budget.tryReserve(reserveReq("a#1", 50_000));
  advance(10 * MIN);

  expect(await reconcile(budget, { fetchCredits: credits(1) })).toEqual({ ok: false, reason: "IN_FLIGHT", inFlight: 1 });
});

// ---------- clock skew ----------

test("after a restart with an earlier process's open reserve, reconcile waits 300 s from ledger open even if the wall clock jumped forward", async () => {
  const { budget, advanceMono } = await setup({ lines: [reserveLine("a#1", 50_000)], now: "2026-09-25T12:00:00.000Z", openedMsAgo: 0 });

  expect(await reconcile(budget, { fetchCredits: credits(1) })).toEqual({ ok: false, reason: "TOO_SOON", retryAfterMs: 300_000, warnings: [] });
  advanceMono(299_999);
  expect(await reconcile(budget, { fetchCredits: credits(1) })).toMatchObject({ ok: false, reason: "TOO_SOON", retryAfterMs: 1 });
  advanceMono(1);
  expect(await reconcile(budget, { fetchCredits: credits(1) })).toMatchObject({ ok: true, closedAttempts: ["a#1"] });
});

test("a ledger dated in the future waits 2 minutes from ledger open on the monotonic clock and warns CLOCK_SKEW", async () => {
  const future = "2027-09-24T12:00:00.000Z";
  const { budget, advanceMono } = await setup({ lines: [reserveLine("a#1", 50_000, future), settleLine("a#1", 50_000, future)], now: T0, openedMsAgo: 0 });

  advanceMono(119_999);
  expect(await reconcile(budget, { fetchCredits: credits(1) })).toEqual({ ok: false, reason: "TOO_SOON", retryAfterMs: 1, warnings: ["CLOCK_SKEW"] });
  advanceMono(1);
  expect(await reconcile(budget, { fetchCredits: credits(1) })).toMatchObject({ ok: true, warnings: ["CLOCK_SKEW"] });
});

test("a future-dated open reserve no longer blocks forever: reconcile closes it after the skewed wait", async () => {
  const { budget, advanceMono } = await setup({ lines: [reserveLine("a#1", 50_000, "2027-09-24T12:00:00.000Z")], now: T0, openedMsAgo: 0 });
  expect(await budget.tryReserve(reserveReq("n#1"))).toMatchObject({ ok: false, reason: "RECONCILE_REQUIRED" });

  advanceMono(179_999 + 120_000);
  expect(await reconcile(budget, { fetchCredits: credits(1) })).toMatchObject({ ok: false, reason: "TOO_SOON", retryAfterMs: 1 });
  advanceMono(1);
  expect(await reconcile(budget, { fetchCredits: credits(1) })).toMatchObject({ ok: true, closedAttempts: ["a#1"], warnings: ["CLOCK_SKEW"] });
  expect((await budget.tryReserve(reserveReq("n#1"))).ok).toBe(true);
});

// ---------- closing open reserves ----------

test("closes every open reserve with a settle at its worst case, estimated", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000), reserveLine("b#1", 20_000), reserveLine("c#1", 7_000), settleLine("c#1", 7_000)] });

  const result = await reconcile(budget, { fetchCredits: credits(1) });

  expect(result).toMatchObject({ ok: true, closedAttempts: ["a#1", "b#1"] });
  expect((await fileLines()).slice(4, 6)).toEqual([
    { type: "settle", attemptId: "a#1", costMicros: 50_000, estimated: true, at: QUIET },
    { type: "settle", attemptId: "b#1", costMicros: 20_000, estimated: true, at: QUIET },
  ]);
});

test("after reconcile the same budget allows reserves again", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000)] });
  expect((await budget.tryReserve(reserveReq("n#1"))).ok).toBe(false);

  await reconcile(budget, { fetchCredits: credits(1) });

  expect((await budget.tryReserve(reserveReq("n#1"))).ok).toBe(true);
});

test("after reconcile a restarted process allows reserves", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000)], raw: `{"type":"settle","attemptId":"a#` });
  await reconcile(budget, { fetchCredits: credits(1) });

  const restarted = new Budget(await Ledger.open(path), {
    runCapMicros: 10_000_000,
    monthlyBudgetMicros: 10_000_000,
    clock: () => Date.parse(QUIET),
    monotonic: () => 0,
  });

  expect(restarted.status().state).toBe("ok");
});

test("closes this process's abandoned attempt at its worst case", async () => {
  const { budget, advance } = await setup({ now: T0 });
  const handle = handleOf(await budget.tryReserve(reserveReq("a#1", 50_000)));
  await budget.abandon(handle);
  advance(2 * MIN);

  const result = await reconcile(budget, { fetchCredits: credits(1) });

  expect(result).toMatchObject({ ok: true, closedAttempts: ["a#1"] });
  expect((await fileLines())[1]).toEqual({ type: "settle", attemptId: "a#1", costMicros: 50_000, estimated: true, at: "2026-09-24T12:02:00.000Z" });
});

// ---------- a bill above the worst case ----------

test("reconcile acknowledges a settle above worst: records it in the marker and lifts the halt", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000), settleLine("a#1", 90_000)] });
  expect(await budget.tryReserve(reserveReq("n#1"))).toMatchObject({ ok: false, reason: "HALTED", cause: "SETTLE_ABOVE_WORST" });

  const result = await reconcile(budget, { fetchCredits: credits(0.09) });

  expect(result).toMatchObject({ ok: true, aboveWorstAttempts: ["a#1"] });
  expect((await fileLines()).at(-1)).toMatchObject({ type: "reconcile", aboveWorstAttempts: ["a#1"] });
  expect((await budget.tryReserve(reserveReq("n#1"))).ok).toBe(true);
});

// ---------- torn line ----------

test("moves a torn last line into <ledger>.torn and truncates it from the ledger", async () => {
  const torn = `{"type":"settle","attemptId":"a#1","cos`;
  const { budget, ledger } = await setup({ lines: [reserveLine("a#1", 50_000)], raw: torn });

  const result = await reconcile(budget, { fetchCredits: credits(1) });

  expect(result).toMatchObject({ ok: true, tornMoved: true });
  expect(await readFile(`${path}.torn`, "utf8")).toBe(`${torn}\n`);
  expect(ledger.torn).toBeNull();
  const reopened = await Ledger.open(path);
  expect(reopened.torn).toBeNull();
  expect(reopened.lines.map((l) => l.type)).toEqual(["reserve", "settle", "reconcile"]);
});

// ---------- totals, marker, mismatch ----------

test("appends a reconcile marker with the credits usage and the ledger total", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000), settleLine("a#1", 40_000)] });

  await reconcile(budget, { fetchCredits: credits(1.2345675) });

  expect((await fileLines()).at(-1)).toEqual({ type: "reconcile", creditsUsageMicros: 1_234_568, ledgerTotalMicros: 40_000, aboveWorstAttempts: [], at: QUIET });
});

test("compares the /credits delta since the previous marker with the ledger total of the same window", async () => {
  const { budget } = await setup({
    lines: [
      reserveLine("old#1", 900_000),
      settleLine("old#1", 900_000),
      marker(1_000_000),
      reserveLine("a#1", 50_000),
      settleLine("a#1", 50_000),
      reserveLine("b#1", 20_000),
      settleLine("b#1", 20_000),
      reserveLine("c#1", 30_000),
    ],
  });

  const result = await reconcile(budget, { fetchCredits: credits(1.1) });

  expect(result).toEqual({
    ok: true,
    creditsUsageMicros: 1_100_000,
    creditsDeltaMicros: 100_000,
    deltaUnavailable: null,
    ledgerTotalMicros: 100_000,
    mismatch: false,
    closedAttempts: ["c#1"],
    aboveWorstAttempts: [],
    tornMoved: false,
    warnings: [],
  });
});

test("a difference of exactly the tolerance is not a mismatch", async () => {
  const { budget } = await setup({ lines: [marker(1_000_000), reserveLine("a#1", 100_000), settleLine("a#1", 100_000)] });

  expect(await reconcile(budget, { fetchCredits: credits(1.11) })).toMatchObject({ creditsDeltaMicros: 100_000 + RECONCILE_TOLERANCE_MICROS, mismatch: false });
});

test("a difference one micro over the tolerance is a mismatch", async () => {
  const { budget } = await setup({ lines: [marker(1_000_000), reserveLine("a#1", 100_000), settleLine("a#1", 100_000)] });

  expect(await reconcile(budget, { fetchCredits: credits(1.110001) })).toMatchObject({ creditsDeltaMicros: 110_001, mismatch: true });
});

test("a ledger total above the /credits delta by more than the tolerance is also a mismatch", async () => {
  const { budget } = await setup({ lines: [marker(1_000_000), reserveLine("a#1", 100_000), settleLine("a#1", 100_000)] });

  expect(await reconcile(budget, { fetchCredits: credits(1.089999) })).toMatchObject({ creditsDeltaMicros: 89_999, mismatch: true });
});

test("a negative /credits delta gives no delta, with a reason and no mismatch verdict", async () => {
  const { budget } = await setup({ lines: [marker(1_000_000), reserveLine("a#1", 100_000), settleLine("a#1", 100_000)] });

  expect(await reconcile(budget, { fetchCredits: credits(0.9) })).toMatchObject({
    ok: true,
    creditsUsageMicros: 900_000,
    creditsDeltaMicros: null,
    deltaUnavailable: "NEGATIVE_DELTA",
    mismatch: null,
  });
});

test("the first reconcile has no credits delta and totals the whole ledger", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000), settleLine("a#1", 45_000)] });

  expect(await reconcile(budget, { fetchCredits: credits(4.629) })).toMatchObject({
    ok: true,
    creditsUsageMicros: 4_629_000,
    creditsDeltaMicros: null,
    deltaUnavailable: "NO_BASELINE",
    mismatch: null,
    ledgerTotalMicros: 45_000,
  });
});

test("reconcile on an empty ledger writes only a baseline marker", async () => {
  const { budget } = await setup();

  await reconcile(budget, { fetchCredits: credits(0.5) });

  expect(await fileLines()).toEqual([{ type: "reconcile", creditsUsageMicros: 500_000, ledgerTotalMicros: 0, aboveWorstAttempts: [], at: QUIET }]);
});

// ---------- failures ----------

test("a failing /credits fetch writes nothing and keeps the torn line", async () => {
  const { budget, ledger } = await setup({ lines: [reserveLine("a#1", 50_000)], raw: `{"ty` });
  const before = await readFile(path, "utf8");

  await expect(reconcile(budget, { fetchCredits: () => Promise.reject(new Error("network down")) })).rejects.toThrow("network down");

  expect(await readFile(path, "utf8")).toBe(before);
  expect(ledger.torn).not.toBeNull();
});

test("an unexpected /credits body is rejected and writes nothing", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000)] });
  const before = await readFile(path, "utf8");

  await expect(reconcile(budget, { fetchCredits: async () => ({ data: { total_usage: "1.0" } }) })).rejects.toThrow("/credits");

  expect(await readFile(path, "utf8")).toBe(before);
});

// ---------- serialization with reserves ----------

test("a reserve issued during a reconcile waits for it and lands after the marker", async () => {
  const { budget } = await setup({ lines: [reserveLine("a#1", 50_000)] });
  let releaseFetch: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseFetch = resolve));
  const fetchCredits: CreditsFetcher = async () => {
    await gate;
    return { data: { total_usage: 1 } };
  };

  const reconciling = reconcile(budget, { fetchCredits });
  const reserving = budget.tryReserve(reserveReq("n#1"));
  releaseFetch();
  await reconciling;

  expect((await reserving).ok).toBe(true);
  expect((await fileLines()).map((l) => (l as { type: string }).type)).toEqual(["reserve", "settle", "reconcile", "reserve"]);
});
