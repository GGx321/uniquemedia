import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, type BudgetLimits, type ReserveRefusal, type ReserveResult } from "./budget";
import { Ledger, type LedgerLine, type Scope } from "./ledger";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.2 (plan §4.10, invariant A2): the launch group. `BudgetLimits.groupOf` maps an attempt (by its id and scope) to a group with a cap; the Budget
// refuses any reserve or hold that would lift the group's committed (settled at cost, all time, + open at worst + held, over every ledger line that maps to
// the same key) above that cap, with RUN_CAP_EXCEEDED carrying the group's numbers. The ledger format does not change.

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-budget-group-"));
  path = join(dir, "ledger.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = "2026-10-09T12:00:00.000Z";
const CAP = 100_000;
const SLICE_1 = { runId: "slice-1" } satisfies Scope;
const SLICE_2 = { runId: "slice-2" } satisfies Scope;
const OTHER: Scope = { runId: "manual-run" };
const GROUP = "launch:L1";

/** The launch of these tests: its writer attempts (`set-1:writer-…`) and its slice runs belong to the group; a review write (`set-1:write-…`) does not. */
function launchGroupOf(capMicros: number = CAP): NonNullable<BudgetLimits["groupOf"]> {
  return (req) => {
    if (req.attemptId.startsWith("set-1:writer-")) return { key: GROUP, capMicros };
    const scope = req.scope;
    if ("runId" in scope && (scope.runId === SLICE_1.runId || scope.runId === SLICE_2.runId)) return { key: GROUP, capMicros };
    return null;
  };
}

async function setup(opts: { lines?: LedgerLine[]; groupOf?: BudgetLimits["groupOf"]; runCapMicros?: BudgetLimits["runCapMicros"]; monthlyBudgetMicros?: number } = {}): Promise<Budget> {
  if (opts.lines) await writeFile(path, opts.lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const ledger = await Ledger.open(path);
  const now = Date.parse(NOW);
  return new Budget(ledger, {
    runCapMicros: opts.runCapMicros ?? 10_000_000,
    monthlyBudgetMicros: opts.monthlyBudgetMicros ?? 50_000_000,
    clock: () => now,
    monotonic: () => 0,
    ...(opts.groupOf === undefined ? {} : { groupOf: opts.groupOf }),
  });
}

function req(attemptId: string, worstMicros: number, scope: Scope = SLICE_1) {
  return { attemptId, jobId: `job-${attemptId}`, scope, model: "x-ai/grok-imagine-image-2.0", worstMicros };
}

function settledLines(attemptId: string, costMicros: number, at: string, scope: Scope = SLICE_1): LedgerLine[] {
  return [
    { type: "reserve", attemptId, jobId: `job-${attemptId}`, scope, model: "m", worstMicros: costMicros, at },
    { type: "settle", attemptId, costMicros, estimated: false, at },
  ];
}

function refusal(result: ReserveResult | { ok: true } | ReserveRefusal): Extract<ReserveRefusal, { limitMicros: number }> {
  if (result.ok) throw new Error("expected a refusal");
  if (result.reason !== "BUDGET_EXCEEDED" && result.reason !== "RUN_CAP_EXCEEDED") throw new Error(`expected a limit refusal, got ${result.reason}`);
  return result;
}

describe("the group's cap on a reserve", () => {
  test("a reserve that brings the group exactly to its cap (W′) is allowed", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    expect((await budget.tryReserve(req("a#1", CAP))).ok).toBe(true);
  });

  test("a reserve one micro-dollar above the cap (W′ + 1) is refused RUN_CAP_EXCEEDED with the group's numbers", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    const result = refusal(await budget.tryReserve(req("a#1", CAP + 1)));
    expect(result).toEqual({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: CAP, committedMicros: 0, worstMicros: CAP + 1 });
  });

  test("a reserve one micro-dollar below the cap (W′ - 1) is allowed", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    expect((await budget.tryReserve(req("a#1", CAP - 1))).ok).toBe(true);
  });

  test("an open reserve counts at its worst case against the group", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    expect((await budget.tryReserve(req("a#1", 60_000))).ok).toBe(true);
    expect((await budget.tryReserve(req("a#2", 40_000))).ok).toBe(true);
    expect(refusal(await budget.tryReserve(req("a#3", 1))).committedMicros).toBe(100_000);
  });

  test("the second reserve is refused one micro-dollar over what the first left, naming what is committed", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryReserve(req("a#1", 60_000));
    const result = refusal(await budget.tryReserve(req("a#2", 40_001)));
    expect(result).toEqual({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: CAP, committedMicros: 60_000, worstMicros: 40_001 });
  });

  test("a settled attempt counts at its cost, not its worst case: a settle below worst frees the group's room", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    const first = await budget.tryReserve(req("a#1", 60_000));
    if (!first.ok) throw new Error("reserve");
    await budget.settle(first.handle, { costMicros: 10_000, estimated: false });
    expect((await budget.tryReserve(req("a#2", 90_000))).ok).toBe(true);
    expect(refusal(await budget.tryReserve(req("a#3", 1))).committedMicros).toBe(100_000);
  });

  test("a released attempt costs the group nothing", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    const first = await budget.tryReserve(req("a#1", 60_000));
    if (!first.ok) throw new Error("reserve");
    await budget.release(first.handle, "never sent");
    expect((await budget.tryReserve(req("a#2", CAP))).ok).toBe(true);
  });

  test("the group spans scopes: two slice runs and the writer share one cap", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    expect((await budget.tryReserve(req("set-1:writer-1#1", 30_000, { runId: "set-1-run" }))).ok).toBe(true);
    expect((await budget.tryReserve(req("s1#1", 40_000, SLICE_1))).ok).toBe(true);
    expect((await budget.tryReserve(req("s2#1", 30_000, SLICE_2))).ok).toBe(true);
    expect(refusal(await budget.tryReserve(req("s2#2", 1, SLICE_2))).reason).toBe("RUN_CAP_EXCEEDED");
  });

  test("an attempt outside the group is unaffected by a full group", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryReserve(req("a#1", CAP));
    expect((await budget.tryReserve(req("m#1", 500_000, OTHER))).ok).toBe(true);
  });

  test("a review write (<setId>:write-k) is outside the group even on the launch's set", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryReserve(req("a#1", CAP));
    expect((await budget.tryReserve(req("set-1:write-1#1", 40_000, { runId: "set-1-review" }))).ok).toBe(true);
  });

  test("an attempt outside the group does not use up the group's room", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryReserve(req("m#1", 500_000, OTHER));
    expect((await budget.tryReserve(req("a#1", CAP))).ok).toBe(true);
  });

  test("the scope's own cap is reported first when it is the smaller limit", async () => {
    const budget = await setup({ groupOf: launchGroupOf(), runCapMicros: 50_000 });
    const result = refusal(await budget.tryReserve(req("a#1", 60_000)));
    expect(result).toMatchObject({ reason: "RUN_CAP_EXCEEDED", limitMicros: 50_000 });
  });

  test("the month's budget is reported before the group's cap", async () => {
    const budget = await setup({ groupOf: launchGroupOf(), monthlyBudgetMicros: 50_000 });
    expect(refusal(await budget.tryReserve(req("a#1", 60_000))).reason).toBe("BUDGET_EXCEEDED");
  });

  test("zero is a valid cap: nothing in the group can be reserved, a zero-worst attempt can", async () => {
    const budget = await setup({ groupOf: launchGroupOf(0) });
    expect(refusal(await budget.tryReserve(req("a#1", 1))).limitMicros).toBe(0);
    expect((await budget.tryReserve(req("a#2", 0))).ok).toBe(true);
  });

  test("a group cap that is not a whole number of micro-dollars throws", async () => {
    const budget = await setup({ groupOf: launchGroupOf(1.5) });
    await expect(budget.tryReserve(req("a#1", 1))).rejects.toThrow(TypeError);
  });

  test("the largest cap the contract allows (10 000 $) works to the micro-dollar", async () => {
    const max = 10_000_000_000;
    const budget = await setup({ groupOf: launchGroupOf(max), runCapMicros: max, monthlyBudgetMicros: max });
    expect((await budget.tryReserve(req("a#1", max))).ok).toBe(true);
    expect(refusal(await budget.tryReserve(req("a#2", 1))).reason).toBe("BUDGET_EXCEEDED");
  });
});

describe("the group's cap on a hold", () => {
  test("a hold that brings the group exactly to its cap is admitted", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    expect(await budget.tryHold([{ attemptId: "a#1", scope: SLICE_1, worstMicros: CAP }])).toEqual({ ok: true });
  });

  test("a hold one micro-dollar over the cap is refused RUN_CAP_EXCEEDED and nothing is held", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    const result = await budget.tryHold([{ attemptId: "a#1", scope: SLICE_1, worstMicros: CAP + 1 }]);
    expect(result).toEqual({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: CAP, committedMicros: 0, worstMicros: CAP + 1 });
    expect(budget.status().heldMicros).toBe(0);
  });

  test("several requests in one hold are summed against the group together", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    const over = await budget.tryHold([
      { attemptId: "a#1", scope: SLICE_1, worstMicros: 50_000 },
      { attemptId: "a#2", scope: SLICE_2, worstMicros: 50_001 },
    ]);
    expect(over).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: CAP, worstMicros: 100_001 });
    const exact = await budget.tryHold([
      { attemptId: "a#1", scope: SLICE_1, worstMicros: 50_000 },
      { attemptId: "a#2", scope: SLICE_2, worstMicros: 50_000 },
    ]);
    expect(exact).toEqual({ ok: true });
  });

  test("only the requests that belong to the group count against it", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    const result = await budget.tryHold([
      { attemptId: "a#1", scope: SLICE_1, worstMicros: CAP },
      { attemptId: "m#1", scope: OTHER, worstMicros: 400_000 },
    ]);
    expect(result).toEqual({ ok: true });
  });

  test("a held attempt counts against a later reserve of the group", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryHold([{ attemptId: "a#1", scope: SLICE_1, worstMicros: 60_000 }]);
    expect(refusal(await budget.tryReserve(req("a#2", 40_001))).committedMicros).toBe(60_000);
    expect((await budget.tryReserve(req("a#2", 40_000))).ok).toBe(true);
  });

  test("an open reserve counts against a later hold of the group", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryReserve(req("a#1", 60_000));
    const result = await budget.tryHold([{ attemptId: "a#2", scope: SLICE_2, worstMicros: 40_001 }]);
    expect(result).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", committedMicros: 60_000 });
  });

  test("a reserve replaces its own hold: the attempt is not counted twice", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryHold([{ attemptId: "a#1", scope: SLICE_1, worstMicros: CAP }]);
    expect((await budget.tryReserve(req("a#1", CAP))).ok).toBe(true);
  });

  test("a released hold gives the group its room back", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryHold([{ attemptId: "a#1", scope: SLICE_1, worstMicros: CAP }]);
    budget.releaseHold("a#1");
    expect((await budget.tryReserve(req("a#2", CAP))).ok).toBe(true);
  });
});

describe("more group edges", () => {
  test("a hold one micro-dollar below the cap (W′ - 1) is admitted", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    expect(await budget.tryHold([{ attemptId: "a#1", scope: SLICE_1, worstMicros: CAP - 1 }])).toEqual({ ok: true });
  });

  test("a line of last month counts toward the group but not toward this month's budget", async () => {
    const lines = settledLines("s1#1", 70_000, "2026-09-02T10:00:00.000Z");
    const budget = await setup({ lines, groupOf: launchGroupOf(), monthlyBudgetMicros: 40_000 });
    expect((await budget.tryReserve(req("s1#2", 30_000))).ok).toBe(true);
    expect(refusal(await budget.tryReserve(req("s1#3", 10_001))).reason).toBe("BUDGET_EXCEEDED");
  });

  test("a settle above worst inside a group still halts every reserve", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    const r = await budget.tryReserve(req("a#1", 10_000));
    if (!r.ok) throw new Error("reserve");
    await expect(budget.settle(r.handle, { costMicros: 20_000, estimated: false })).rejects.toThrow();
    const next = await budget.tryReserve(req("a#2", 1));
    expect(next).toMatchObject({ ok: false, reason: "HALTED", cause: "SETTLE_ABOVE_WORST" });
  });

  test("a hold followed by a reserve of a different amount counts only the reserve", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    await budget.tryHold([{ attemptId: "a#1", scope: SLICE_1, worstMicros: 60_000 }]);
    expect((await budget.tryReserve(req("a#1", 40_000))).ok).toBe(true);
    expect(refusal(await budget.tryReserve(req("a#2", 60_001))).committedMicros).toBe(40_000);
    expect((await budget.tryReserve(req("a#2", 60_000))).ok).toBe(true);
  });
});

describe("committedOfGroup", () => {
  test("is the settled, open and held money of the group: the very sum the Budget enforces", async () => {
    const lines = settledLines("s1#1", 20_000, "2026-09-02T10:00:00.000Z");
    const budget = await setup({ lines, groupOf: launchGroupOf() });
    await budget.tryReserve(req("s1#2", 30_000));
    await budget.tryHold([{ attemptId: "s2#1", scope: SLICE_2, worstMicros: 10_000 }]);
    await budget.tryReserve(req("m#1", 99_000, OTHER));
    expect(budget.committedOfGroup(GROUP)).toBe(60_000);
    expect(refusal(await budget.tryReserve(req("s1#3", CAP))).committedMicros).toBe(budget.committedOfGroup(GROUP));
  });

  test("an unknown group has committed nothing", async () => {
    const budget = await setup({ groupOf: launchGroupOf() });
    expect(budget.committedOfGroup("launch:none")).toBe(0);
  });
});

describe("restoring the group from the ledger", () => {
  test("settled lines of an earlier process count against the group as soon as the group is mapped, before any reserve", async () => {
    const lines = [...settledLines("set-1:writer-1#1", 30_000, "2026-10-09T10:00:00.000Z", { runId: "set-1-run" }), ...settledLines("s1#1", 40_000, "2026-10-09T10:05:00.000Z")];
    const budget = await setup({ lines, groupOf: launchGroupOf() });
    expect(refusal(await budget.tryReserve(req("s1#2", 30_001))).committedMicros).toBe(70_000);
    expect((await budget.tryReserve(req("s1#2", 30_000))).ok).toBe(true);
  });

  test("the group counts settled money of an earlier month: its cap is all time", async () => {
    const lines = settledLines("s1#1", 70_000, "2026-09-02T10:00:00.000Z");
    const budget = await setup({ lines, groupOf: launchGroupOf() });
    expect(refusal(await budget.tryReserve(req("s1#2", 30_001))).committedMicros).toBe(70_000);
  });

  test("a group whose launch is finished maps nothing: its old lines no longer limit anything", async () => {
    const lines = settledLines("s1#1", 100_000, "2026-10-09T10:00:00.000Z");
    const budget = await setup({ lines, groupOf: () => null });
    expect((await budget.tryReserve(req("s1#2", 5_000_000))).ok).toBe(true);
  });
});

describe("without a group", () => {
  test("no groupOf behaves as before: a large reserve under the scope cap and the month is allowed", async () => {
    const budget = await setup();
    expect((await budget.tryReserve(req("a#1", 5_000_000))).ok).toBe(true);
  });

  test("a groupOf that returns null for everything changes nothing", async () => {
    const budget = await setup({ groupOf: () => null });
    expect((await budget.tryReserve(req("a#1", 5_000_000))).ok).toBe(true);
    expect(budget.status().openReserveMicros).toBe(5_000_000);
  });
});

describe("the ledger format", () => {
  test("a group adds nothing to a reserve line", async () => {
    const withGroup = await setup({ groupOf: launchGroupOf() });
    await withGroup.tryReserve(req("a#1", 1_000));
    const [line] = withGroup.ledger.lines;
    expect(Object.keys(line ?? {}).sort()).toEqual(["at", "attemptId", "jobId", "model", "scope", "type", "worstMicros"]);
  });
});
