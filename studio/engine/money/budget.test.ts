import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttemptId } from "../../shared/engine";
import { Budget, isAttemptId, type BudgetLimits, type ReserveHandle, type ReserveRequest, type ReserveResult } from "./budget";
import { MoneyError } from "./errors";
import { Ledger, type LedgerDeps, type LedgerLine, type ReserveLine, type Scope } from "./ledger";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-budget-"));
  path = join(dir, "ledger.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RUN: Scope = { runId: "run-1" };
const OTHER_RUN: Scope = { runId: "run-2" };
const NOW = "2026-09-24T12:00:00.000Z";

interface Setup {
  budget: Budget;
  ledger: Ledger;
  setNow: (iso: string) => void;
}

async function setup(
  opts: { lines?: LedgerLine[]; raw?: string; runCapMicros?: BudgetLimits["runCapMicros"]; monthlyBudgetMicros?: number; now?: string; deps?: LedgerDeps } = {}
): Promise<Setup> {
  if (opts.lines || opts.raw !== undefined) {
    await writeFile(path, (opts.lines ?? []).map((l) => `${JSON.stringify(l)}\n`).join("") + (opts.raw ?? ""));
  }
  let now = Date.parse(opts.now ?? NOW);
  const ledger = await Ledger.open(path, opts.deps);
  const budget = new Budget(ledger, {
    runCapMicros: opts.runCapMicros ?? 10_000_000,
    monthlyBudgetMicros: opts.monthlyBudgetMicros ?? 10_000_000,
    clock: () => now,
    monotonic: () => 0,
  });
  return { budget, ledger, setNow: (iso) => (now = Date.parse(iso)) };
}

function req(attemptId: string, worstMicros: number, scope: Scope = RUN): ReserveRequest {
  return { attemptId, jobId: `job-${attemptId}`, scope, model: "x-ai/grok-imagine-image-2.0", worstMicros };
}

function reserveLine(attemptId: string, worstMicros: number, at: string, scope: Scope = RUN): ReserveLine {
  return { type: "reserve", attemptId, jobId: `job-${attemptId}`, scope, model: "x-ai/grok-imagine-image-2.0", worstMicros, at };
}

/** A reserve plus its settle, as an earlier process would have left them. */
function settledLines(attemptId: string, costMicros: number, at: string, scope: Scope = RUN): LedgerLine[] {
  return [reserveLine(attemptId, costMicros, at, scope), { type: "settle", attemptId, costMicros, estimated: false, at }];
}

function handleOf(result: ReserveResult): ReserveHandle {
  if (!result.ok) throw new Error(`expected a reservation, got ${result.reason}`);
  return result.handle;
}

async function fileLines(): Promise<unknown[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function codeOf(err: unknown): string | null {
  return err instanceof MoneyError ? err.code : null;
}

// ---------- reserve ----------

test("tryReserve writes the reserve line to disk before it resolves and returns a handle", async () => {
  const { budget } = await setup();

  const result = await budget.tryReserve(req("slot-1#1", 50_000));

  expect(handleOf(result)).toMatchObject({ attemptId: "slot-1#1", worstMicros: 50_000, scope: RUN });
  expect(await fileLines()).toEqual([reserveLine("slot-1#1", 50_000, NOW)]);
});

test("a reserve that brings the month exactly to the budget is allowed", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });

  expect((await budget.tryReserve(req("a#1", 100_000))).ok).toBe(true);
});

test("a reserve one micro over the monthly budget is refused with BUDGET_EXCEEDED and writes nothing", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });

  const result = await budget.tryReserve(req("a#1", 100_001));

  expect(result).toEqual({ ok: false, reason: "BUDGET_EXCEEDED", limitMicros: 100_000, committedMicros: 0, worstMicros: 100_001 });
  expect(await fileLines()).toEqual([]);
});

test("a reserve that brings the run exactly to its cap is allowed", async () => {
  const { budget } = await setup({ runCapMicros: 100_000 });

  expect((await budget.tryReserve(req("a#1", 100_000))).ok).toBe(true);
});

test("a reserve one micro over the run cap is refused with RUN_CAP_EXCEEDED and writes nothing", async () => {
  const { budget } = await setup({ runCapMicros: 100_000 });

  const result = await budget.tryReserve(req("a#1", 100_001));

  expect(result).toEqual({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 100_000, committedMicros: 0, worstMicros: 100_001 });
  expect(await fileLines()).toEqual([]);
});

test("the run cap binds on the run's own spend while the monthly budget has room", async () => {
  const { budget } = await setup({ lines: settledLines("a#1", 60_000, NOW), runCapMicros: 100_000, monthlyBudgetMicros: 10_000_000 });

  const result = await budget.tryReserve(req("b#1", 50_000));

  expect(result).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", committedMicros: 60_000 });
});

test("a numeric run cap applies to each run separately", async () => {
  const { budget } = await setup({ lines: settledLines("a#1", 60_000, NOW), runCapMicros: 100_000 });

  expect((await budget.tryReserve(req("b#1", 50_000, OTHER_RUN))).ok).toBe(true);
});

test("the monthly budget binds on spend across runs while the run cap has room", async () => {
  const { budget } = await setup({ lines: settledLines("a#1", 60_000, NOW, OTHER_RUN), runCapMicros: 1_000_000, monthlyBudgetMicros: 100_000 });

  const result = await budget.tryReserve(req("b#1", 50_000));

  expect(result).toMatchObject({ ok: false, reason: "BUDGET_EXCEEDED", committedMicros: 60_000 });
});

test("when both limits would be exceeded, BUDGET_EXCEEDED is reported", async () => {
  const { budget } = await setup({ runCapMicros: 100_000, monthlyBudgetMicros: 100_000 });

  expect(await budget.tryReserve(req("a#1", 200_000))).toMatchObject({ ok: false, reason: "BUDGET_EXCEEDED" });
});

test("a per-scope cap function gives an avatar job its own cap", async () => {
  const runCapMicros = (scope: Scope): number => ("avatarJobId" in scope ? 230_000 : 3_330_000);
  const { budget } = await setup({ runCapMicros });

  const avatar = await budget.tryReserve(req("cand-1#1", 230_001, { avatarJobId: "av-1" }));
  const run = await budget.tryReserve(req("slot-1#1", 230_001, RUN));

  expect(avatar).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 230_000 });
  expect(run.ok).toBe(true);
});

test("a zero worst case fits exactly at the limit, one micro does not", async () => {
  const { budget } = await setup({ lines: settledLines("a#1", 100_000, NOW), monthlyBudgetMicros: 100_000 });

  expect((await budget.tryReserve(req("b#1", 0))).ok).toBe(true);
  expect((await budget.tryReserve(req("c#1", 1))).ok).toBe(false);
});

test("worstMicros must be a non-negative integer", async () => {
  const { budget } = await setup();

  expect(await caught(budget.tryReserve(req("a#1", 0.5)))).toBeInstanceOf(TypeError);
  expect(await caught(budget.tryReserve(req("b#1", -1)))).toBeInstanceOf(TypeError);
  expect(await fileLines()).toEqual([]);
});

const BAD_ATTEMPT_IDS = ["", "slot 1#1", "slot-1#1\n", "x".repeat(129), "слот-1#1"];

test.each(BAD_ATTEMPT_IDS)("an attempt id the contract refuses (%p) is refused before anything is written", async (attemptId) => {
  const { budget } = await setup();

  expect(await caught(budget.tryReserve(req(attemptId, 1)))).toBeInstanceOf(TypeError);
  expect(await fileLines()).toEqual([]);
});

test("the Budget accepts exactly the attempt ids the contract accepts: every char 0x00-0xFF, and lengths 0, 1, 128, 129", () => {
  const chars = Array.from({ length: 0x100 }, (_, code) => String.fromCharCode(code));
  const lengths = [0, 1, 128, 129].map((n) => "a".repeat(n));
  const samples = [...chars, ...lengths];
  const disagree = samples.filter((id) => isAttemptId(id) !== AttemptId.safeParse(id).success);
  expect(disagree.map((id) => (id.length === 1 ? `0x${id.charCodeAt(0).toString(16)}` : `length ${id.length}`))).toEqual([]);
  // Both sides really draw a line: some ids pass, some do not.
  expect(samples.filter((id) => isAttemptId(id)).length).toBe(0x7e - 0x21 + 1 + 2);
});

test("an attempt id already in the ledger is never reserved again", async () => {
  const { budget } = await setup({ lines: settledLines("a#1", 10_000, NOW) });

  expect(codeOf(await caught(budget.tryReserve(req("a#1", 10_000))))).toBe("ATTEMPT_ID_REUSED");
  expect((await fileLines()).length).toBe(2);
});

// ---------- the monthly window (UTC) ----------

test("a settle at the last millisecond of the previous month does not count this month", async () => {
  const { budget } = await setup({
    lines: settledLines("aug#1", 100_000, "2026-08-31T23:59:59.999Z", OTHER_RUN),
    monthlyBudgetMicros: 100_000,
    now: "2026-09-01T00:00:00.000Z",
  });

  expect((await budget.tryReserve(req("sep#1", 100_000))).ok).toBe(true);
});

test("a settle at the first millisecond of the month counts this month", async () => {
  const { budget } = await setup({
    lines: settledLines("sep-first#1", 1, "2026-09-01T00:00:00.000Z", OTHER_RUN),
    monthlyBudgetMicros: 100_000,
    now: "2026-09-30T23:59:59.999Z",
  });

  expect(await budget.tryReserve(req("b#1", 100_000))).toMatchObject({ ok: false, reason: "BUDGET_EXCEEDED", committedMicros: 1 });
});

test("the month rolls over between its last millisecond and the next month's first", async () => {
  const { budget, setNow } = await setup({
    lines: settledLines("aug#1", 1, "2026-08-01T00:00:00.000Z", OTHER_RUN),
    monthlyBudgetMicros: 100_000,
    now: "2026-08-31T23:59:59.999Z",
  });

  expect((await budget.tryReserve(req("b#1", 100_000))).ok).toBe(false);
  setNow("2026-09-01T00:00:00.000Z");
  expect((await budget.tryReserve(req("b#1", 100_000))).ok).toBe(true);
});

test("a run's cap counts its settled costs from earlier months", async () => {
  const { budget } = await setup({
    lines: settledLines("aug#1", 60_000, "2026-08-31T23:00:00.000Z"),
    runCapMicros: 100_000,
    now: "2026-09-01T01:00:00.000Z",
  });

  expect(await budget.tryReserve(req("b#1", 50_000))).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED" });
});

// ---------- open reserves count at their worst case ----------

test("an unsettled reserve counts at its worst case until it is settled", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });
  const first = handleOf(await budget.tryReserve(req("a#1", 60_000)));

  expect(await budget.tryReserve(req("b#1", 50_000))).toMatchObject({ ok: false, reason: "BUDGET_EXCEEDED", committedMicros: 60_000 });

  await budget.settle(first, { costMicros: 40_000, estimated: false });
  expect((await budget.tryReserve(req("b#1", 50_000))).ok).toBe(true);
});

test("an unsettled reserve counts at its worst case against the run cap", async () => {
  const { budget } = await setup({ runCapMicros: 100_000 });
  await budget.tryReserve(req("a#1", 60_000));

  expect(await budget.tryReserve(req("b#1", 50_000))).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", committedMicros: 60_000 });
});

test("a released reserve no longer counts", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });
  const first = handleOf(await budget.tryReserve(req("a#1", 60_000)));

  await budget.release(first, "reference image missing");

  expect((await budget.tryReserve(req("b#1", 100_000))).ok).toBe(true);
});

test("an abandoned reserve keeps counting at its worst case", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });
  const first = handleOf(await budget.tryReserve(req("a#1", 60_000)));

  await budget.abandon(first);

  expect(await budget.tryReserve(req("b#1", 50_000))).toMatchObject({ ok: false, reason: "BUDGET_EXCEEDED", committedMicros: 60_000 });
  expect(await fileLines()).toEqual([reserveLine("a#1", 60_000, NOW)]);
});

// ---------- concurrency ----------

test("concurrent tryReserve calls cannot jointly exceed the monthly budget", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });

  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => budget.tryReserve(req(`s${i}#1`, 30_000, { runId: `run-${i}` }))));

  expect(results.filter((r) => r.ok).length).toBe(3);
  expect((await fileLines()).length).toBe(3);
});

test("concurrent tryReserve calls cannot jointly exceed the run cap", async () => {
  const { budget } = await setup({ runCapMicros: 100_000 });

  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => budget.tryReserve(req(`s${i}#1`, 30_000))));

  expect(results.filter((r) => r.ok).length).toBe(3);
  expect((await fileLines()).length).toBe(3);
});

test("a settle issued before a concurrent reserve frees its room for that reserve", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });
  const first = handleOf(await budget.tryReserve(req("a#1", 60_000)));

  const [, reserved] = await Promise.all([budget.settle(first, { costMicros: 40_000, estimated: false }), budget.tryReserve(req("b#1", 50_000))]);

  expect(reserved.ok).toBe(true);
  expect((await fileLines()).map((l) => (l as { type: string }).type)).toEqual(["reserve", "settle", "reserve"]);
});

test("a reserve issued before a concurrent settle still sees the open reserve at its worst case", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });
  const first = handleOf(await budget.tryReserve(req("a#1", 60_000)));

  const [reserved] = await Promise.all([budget.tryReserve(req("b#1", 50_000)), budget.settle(first, { costMicros: 40_000, estimated: false })]);

  expect(reserved).toMatchObject({ ok: false, reason: "BUDGET_EXCEEDED", committedMicros: 60_000 });
  expect((await fileLines()).map((l) => (l as { type: string }).type)).toEqual(["reserve", "settle"]);
});

test("a reserve racing a settle above worst is refused as HALTED", async () => {
  const { budget } = await setup();
  const first = handleOf(await budget.tryReserve(req("a#1", 50_000)));

  const [settled, reserved] = await Promise.allSettled([budget.settle(first, { costMicros: 50_001, estimated: false }), budget.tryReserve(req("b#1", 1))]);

  expect(settled.status).toBe("rejected");
  expect(reserved).toMatchObject({ status: "fulfilled", value: { ok: false, reason: "HALTED", cause: "SETTLE_ABOVE_WORST" } });
});

// ---------- monthly budget changes ----------

/**
 * A ledger whose first append blocks in fsync until `release`: the reserve
 * is then being written, inside the Budget's mutex, while the test acts.
 */
function holdFirstAppend(): { deps: LedgerDeps; writing: Promise<void>; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let signalWriting = () => {};
  const writing = new Promise<void>((resolve) => (signalWriting = resolve));
  let held = false;
  const deps: LedgerDeps = {
    openFile: async (p, flags) => {
      const handle = await open(p, flags);
      if (flags === "a" && !held) {
        held = true;
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          signalWriting();
          await gate;
          return sync();
        });
      }
      return handle;
    },
  };
  return { deps, writing, release };
}

test("a new monthly budget applies from the next reserve on", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });
  await budget.tryReserve(req("a#1", 60_000));

  await budget.setMonthlyBudget(80_000);

  expect(await budget.tryReserve(req("b#1", 20_001))).toEqual({
    ok: false,
    reason: "BUDGET_EXCEEDED",
    limitMicros: 80_000,
    committedMicros: 60_000,
    worstMicros: 20_001,
  });
  expect((await budget.tryReserve(req("c#1", 20_000))).ok).toBe(true);
});

test("a raised monthly budget lets through a reserve the old one refused", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });
  expect((await budget.tryReserve(req("a#1", 150_000))).ok).toBe(false);

  await budget.setMonthlyBudget(150_000);

  expect((await budget.tryReserve(req("a#1", 150_000))).ok).toBe(true);
});

test("a budget change waits for a reserve whose write is in progress", async () => {
  const hold = holdFirstAppend();
  const { budget } = await setup({ monthlyBudgetMicros: 100_000, deps: hold.deps });
  const reserving = budget.tryReserve(req("a#1", 60_000));
  await hold.writing;

  let changed = false;
  const changing = budget.setMonthlyBudget(50_000).then(() => (changed = true));
  await Bun.sleep(20);
  expect(changed).toBe(false);

  hold.release();
  await Promise.all([reserving, changing]);
  expect(changed).toBe(true);
});

test("a reserve checked under the old budget keeps its reservation when the budget drops during its write", async () => {
  const hold = holdFirstAppend();
  const { budget } = await setup({ monthlyBudgetMicros: 100_000, deps: hold.deps });
  const reserving = budget.tryReserve(req("a#1", 60_000));
  await hold.writing;
  const changing = budget.setMonthlyBudget(50_000);
  hold.release();

  expect((await reserving).ok).toBe(true);
  await changing;
  expect(await budget.tryReserve(req("b#1", 1))).toMatchObject({ ok: false, reason: "BUDGET_EXCEEDED", limitMicros: 50_000, committedMicros: 60_000 });
});

test("reserves in flight during a budget change stay this process's own: no reconcile is asked for and they settle", async () => {
  const hold = holdFirstAppend();
  const { budget } = await setup({ monthlyBudgetMicros: 100_000, deps: hold.deps });
  const reserving = budget.tryReserve(req("a#1", 60_000));
  await hold.writing;
  const changing = budget.setMonthlyBudget(200_000);
  hold.release();
  const handle = handleOf(await reserving);
  await changing;

  expect(budget.status()).toMatchObject({ state: "ok", monthlyBudgetMicros: 200_000, openAttempts: 1 });
  expect(budget.inFlightCount()).toBe(1);
  await budget.settle(handle, { costMicros: 50_000, estimated: false });
  expect(budget.status()).toMatchObject({ state: "ok", spentThisMonthMicros: 50_000, openAttempts: 0 });
});

test("status reports the new monthly budget once the change resolved", async () => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });

  await budget.setMonthlyBudget(0);

  expect(budget.status().monthlyBudgetMicros).toBe(0);
});

test("a budget change writes nothing to the ledger", async () => {
  const { budget } = await setup({ lines: settledLines("s#1", 30_000, NOW) });

  await budget.setMonthlyBudget(5_000_000);

  expect(await fileLines()).toEqual(settledLines("s#1", 30_000, NOW));
});

test.each([-1, 1.5, Number.NaN, 2 ** 53])("a monthly budget of %p is rejected and the old one stays", async (micros) => {
  const { budget } = await setup({ monthlyBudgetMicros: 100_000 });

  expect(await caught(budget.setMonthlyBudget(micros))).toBeInstanceOf(TypeError);
  expect(budget.status().monthlyBudgetMicros).toBe(100_000);
});

// ---------- restart: reconcile required ----------

test("an open reserve left by a previous process refuses every reserve with RECONCILE_REQUIRED", async () => {
  const { budget } = await setup({ lines: [reserveLine("old#1", 50_000, NOW)] });

  expect(await budget.tryReserve(req("new#1", 1))).toEqual({ ok: false, reason: "RECONCILE_REQUIRED", openAttempts: 1, torn: false });
  expect((await fileLines()).length).toBe(1);
});

test("a torn last line refuses every reserve with RECONCILE_REQUIRED", async () => {
  const { budget } = await setup({ lines: settledLines("old#1", 50_000, NOW), raw: `{"type":"res` });

  expect(await budget.tryReserve(req("new#1", 1))).toEqual({ ok: false, reason: "RECONCILE_REQUIRED", openAttempts: 0, torn: true });
});

test("a ledger whose reserves are all closed allows reserves after a restart", async () => {
  const release: LedgerLine = { type: "release", attemptId: "r#1", reason: "not sent", at: NOW };
  const { budget } = await setup({ lines: [...settledLines("s#1", 50_000, NOW), reserveLine("r#1", 50_000, NOW), release] });

  expect((await budget.tryReserve(req("new#1", 1))).ok).toBe(true);
});

test("this process's own abandoned reserve does not require reconcile", async () => {
  const { budget } = await setup();
  await budget.abandon(handleOf(await budget.tryReserve(req("a#1", 10_000))));

  expect((await budget.tryReserve(req("b#1", 10_000))).ok).toBe(true);
});

// ---------- settle, release, abandon ----------

test("settle appends a settle line with the cost, the estimated flag and the time", async () => {
  const { budget, setNow } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));
  setNow("2026-09-24T12:00:09.000Z");

  await budget.settle(handle, { costMicros: 50_000, estimated: true });

  expect((await fileLines())[1]).toEqual({ type: "settle", attemptId: "a#1", costMicros: 50_000, estimated: true, at: "2026-09-24T12:00:09.000Z" });
});

test("settle above the reserved worst records the line, then throws a fatal SETTLE_ABOVE_WORST", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));

  const err = await caught(budget.settle(handle, { costMicros: 50_001, estimated: false }));

  expect(codeOf(err)).toBe("SETTLE_ABOVE_WORST");
  expect(err instanceof MoneyError && err.fatal).toBe(true);
  expect((await fileLines())[1]).toMatchObject({ type: "settle", attemptId: "a#1", costMicros: 50_001 });
});

test("after a settle above worst every reserve is refused as HALTED", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));
  await caught(budget.settle(handle, { costMicros: 50_001, estimated: false }));

  expect(await budget.tryReserve(req("b#1", 1))).toMatchObject({ ok: false, reason: "HALTED", cause: "SETTLE_ABOVE_WORST" });
  expect((await fileLines()).length).toBe(2);
});

test("a settle above worst left by a previous process halts every reserve after a restart", async () => {
  const { budget } = await setup({
    lines: [reserveLine("a#1", 50_000, NOW), { type: "settle", attemptId: "a#1", costMicros: 90_000, estimated: false, at: NOW }],
  });

  expect(await budget.tryReserve(req("b#1", 1))).toMatchObject({ ok: false, reason: "HALTED", cause: "SETTLE_ABOVE_WORST" });
  expect(budget.aboveWorstAttempts()).toEqual(["a#1"]);
  expect((await fileLines()).length).toBe(2);
});

test("a settle above worst before the latest reconcile marker no longer halts", async () => {
  const { budget } = await setup({
    lines: [
      reserveLine("a#1", 50_000, NOW),
      { type: "settle", attemptId: "a#1", costMicros: 90_000, estimated: false, at: NOW },
      { type: "reconcile", creditsUsageMicros: 90_000, ledgerTotalMicros: 90_000, aboveWorstAttempts: ["a#1"], at: NOW },
    ],
  });

  expect((await budget.tryReserve(req("b#1", 1))).ok).toBe(true);
  expect(budget.aboveWorstAttempts()).toEqual([]);
});

test("status after a restart shows a halt from a settle above worst", async () => {
  const { budget } = await setup({
    lines: [reserveLine("a#1", 50_000, NOW), { type: "settle", attemptId: "a#1", costMicros: 90_000, estimated: false, at: NOW }],
  });

  expect(budget.status()).toMatchObject({ state: "halted", haltCause: "SETTLE_ABOVE_WORST" });
});

test("settle exactly at the reserved worst is accepted", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));

  await budget.settle(handle, { costMicros: 50_000, estimated: false });

  expect((await budget.tryReserve(req("b#1", 1))).ok).toBe(true);
});

test("a second settle of the same attempt is rejected and writes no second line", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));
  await budget.settle(handle, { costMicros: 10_000, estimated: false });

  expect(codeOf(await caught(budget.settle(handle, { costMicros: 10_000, estimated: false })))).toBe("ATTEMPT_CLOSED");
  expect((await fileLines()).length).toBe(2);
});

test("concurrent settles of the same attempt write exactly one line", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));

  const results = await Promise.allSettled([
    budget.settle(handle, { costMicros: 10_000, estimated: false }),
    budget.settle(handle, { costMicros: 10_000, estimated: false }),
  ]);

  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect((await fileLines()).length).toBe(2);
});

test("settle cost must be a non-negative integer", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));

  expect(await caught(budget.settle(handle, { costMicros: 0.5, estimated: false }))).toBeInstanceOf(TypeError);
  expect((await fileLines()).length).toBe(1);
});

test("release appends a release line with its reason", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));

  await budget.release(handle, "reference image missing");

  expect((await fileLines())[1]).toEqual({ type: "release", attemptId: "a#1", reason: "reference image missing", at: NOW });
});

test("settle after release is rejected", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));
  await budget.release(handle, "not sent");

  expect(codeOf(await caught(budget.settle(handle, { costMicros: 0, estimated: false })))).toBe("ATTEMPT_CLOSED");
});

test("settle after abandon is rejected and writes nothing", async () => {
  const { budget } = await setup();
  const handle = handleOf(await budget.tryReserve(req("a#1", 50_000)));
  await budget.abandon(handle);

  expect(codeOf(await caught(budget.settle(handle, { costMicros: 0, estimated: false })))).toBe("ATTEMPT_CLOSED");
  expect((await fileLines()).length).toBe(1);
});

test("a handle from another budget is rejected as UNKNOWN_ATTEMPT", async () => {
  const { budget } = await setup();
  const otherLedger = await Ledger.open(join(dir, "other.jsonl"));
  const other = new Budget(otherLedger, { runCapMicros: 1_000_000, monthlyBudgetMicros: 1_000_000, clock: () => Date.parse(NOW), monotonic: () => 0 });
  const foreign = handleOf(await other.tryReserve(req("a#1", 50_000)));

  expect(codeOf(await caught(budget.settle(foreign, { costMicros: 0, estimated: false })))).toBe("UNKNOWN_ATTEMPT");
  expect(await fileLines()).toEqual([]);
});

// ---------- public surface ----------

test("a Budget exposes no write that appends a line around the limits", async () => {
  const { budget } = await setup();

  expect("write" in budget).toBe(false);
});

// ---------- write failure ----------

test("a failed reserve write rejects and halts every later reserve", async () => {
  const deps: LedgerDeps = {
    openFile: async (p, flags) => {
      const handle = await open(p, flags);
      spyOn(handle, "sync").mockImplementation(() => Promise.reject(new Error("EIO: i/o error")));
      return handle;
    },
  };
  const { budget } = await setup({ deps });

  expect(await caught(budget.tryReserve(req("a#1", 1)))).toBeInstanceOf(Error);
  expect(await budget.tryReserve(req("b#1", 1))).toMatchObject({ ok: false, reason: "HALTED", cause: "LEDGER_WRITE_FAILED" });
});

// ---------- status ----------

test("status after a restart shows what needs reconciling", async () => {
  const { budget } = await setup({
    lines: [...settledLines("s#1", 30_000, NOW), reserveLine("old#1", 50_000, NOW), reserveLine("old#2", 20_000, NOW)],
    monthlyBudgetMicros: 10_000_000,
  });

  expect(budget.status()).toEqual({
    state: "reconcile-required",
    monthlyBudgetMicros: 10_000_000,
    spentThisMonthMicros: 30_000,
    openReserveMicros: 70_000,
    openAttempts: 2,
    torn: false,
    haltCause: null,
  });
});

test("status is ok while only this process's reserves are open", async () => {
  const { budget } = await setup({ lines: settledLines("aug#1", 5_000, "2026-08-15T00:00:00.000Z") });
  await budget.tryReserve(req("a#1", 50_000));

  expect(budget.status()).toMatchObject({ state: "ok", spentThisMonthMicros: 0, openReserveMicros: 50_000, openAttempts: 1 });
});
