import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drawAllocationLeft, sliceSize } from "../../shared/autopilot/money";
import { Budget, scopeKey } from "../money/budget";
import { Ledger, type LedgerLine, type Scope } from "../money/ledger";
import { monthRoom } from "./room";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.2 (plan §4.4, invariant A21): the engine's month room with live caps. `#checkMonthlyRoom` counts spent + open + held only, so the unspent rest of a
// running job's cap is invisible to it; the room a launch sizes its slices to subtracts every live scope's `max(0, cap − committed)`.

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-room-"));
  path = join(dir, "ledger.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = "2026-10-09T12:00:00.000Z";
const MANUAL: Scope = { runId: "manual-run" };
const SLICE: Scope = { runId: "slice-1" };
const JOB: Scope = { avatarJobId: "job-1" };
const PHOTO = 210_000;

async function setup(opts: { lines?: LedgerLine[]; monthlyBudgetMicros?: number; caps?: Map<string, number> } = {}): Promise<{ budget: Budget; caps: Map<string, number> }> {
  if (opts.lines) await writeFile(path, opts.lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const ledger = await Ledger.open(path);
  const caps = opts.caps ?? new Map<string, number>();
  const now = Date.parse(NOW);
  const budget = new Budget(ledger, {
    runCapMicros: (scope) => caps.get(scopeKey(scope)) ?? 0,
    monthlyBudgetMicros: opts.monthlyBudgetMicros ?? 10_000_000,
    clock: () => now,
    monotonic: () => 0,
  });
  return { budget, caps };
}

function req(attemptId: string, worstMicros: number, scope: Scope) {
  return { attemptId, jobId: `job-${attemptId}`, scope, model: "m", worstMicros };
}

function settled(attemptId: string, costMicros: number, at: string, scope: Scope): LedgerLine[] {
  return [
    { type: "reserve", attemptId, jobId: `job-${attemptId}`, scope, model: "m", worstMicros: costMicros, at },
    { type: "settle", attemptId, costMicros, estimated: false, at },
  ];
}

describe("Budget.committedByScope", () => {
  test("is, per scope, what is settled (all time), open at worst and held", async () => {
    const lines = [...settled("a#1", 300_000, "2026-09-02T10:00:00.000Z", MANUAL), ...settled("a#2", 200_000, "2026-10-02T10:00:00.000Z", MANUAL), ...settled("j#1", 40_000, NOW, JOB)];
    const { budget, caps } = await setup({ lines });
    caps.set(scopeKey(MANUAL), 5_000_000);
    caps.set(scopeKey(SLICE), 5_000_000);
    await budget.tryReserve(req("a#3", 70_000, MANUAL));
    await budget.tryHold([{ attemptId: "a#4", scope: MANUAL, worstMicros: 10_000 }]);
    await budget.tryHold([{ attemptId: "s#1", scope: SLICE, worstMicros: 5_000 }]);
    const committed = budget.committedByScope();
    expect(committed.get(scopeKey(MANUAL))).toBe(300_000 + 200_000 + 70_000 + 10_000);
    expect(committed.get(scopeKey(SLICE))).toBe(5_000);
    expect(committed.get(scopeKey(JOB))).toBe(40_000);
  });

  test("a scope the ledger has never seen is absent", async () => {
    const { budget } = await setup();
    expect(budget.committedByScope().size).toBe(0);
  });

  test("a closed attempt that was released costs the scope nothing", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), 1_000_000);
    const r = await budget.tryReserve(req("a#1", 70_000, MANUAL));
    if (!r.ok) throw new Error("reserve");
    await budget.release(r.handle, "never sent");
    expect(budget.committedByScope().get(scopeKey(MANUAL)) ?? 0).toBe(0);
  });
});

describe("monthRoom", () => {
  test("with nothing running the room is the budget less what is spent this month", async () => {
    const { budget, caps } = await setup({ lines: settled("j#1", 1_500_000, NOW, JOB) });
    expect(monthRoom(budget, caps)).toEqual({ budgetMicros: 10_000_000, committedMicros: 1_500_000, freeMicros: 8_500_000 });
  });

  test("an empty ledger leaves the whole budget", async () => {
    const { budget, caps } = await setup();
    expect(monthRoom(budget, caps).freeMicros).toBe(10_000_000);
  });

  test("a running job's unspent cap is not free", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), 5_000_000);
    await budget.tryReserve(req("a#1", 400_000, MANUAL));
    // 400 000 open + 4 600 000 still unspent in the cap
    expect(monthRoom(budget, caps)).toEqual({ budgetMicros: 10_000_000, committedMicros: 5_000_000, freeMicros: 5_000_000 });
  });

  test("a running job that has settled part of its cap holds back only the rest", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), 5_000_000);
    const r = await budget.tryReserve(req("a#1", 400_000, MANUAL));
    if (!r.ok) throw new Error("reserve");
    await budget.settle(r.handle, { costMicros: 100_000, estimated: false });
    expect(monthRoom(budget, caps)).toEqual({ budgetMicros: 10_000_000, committedMicros: 5_000_000, freeMicros: 5_000_000 });
  });

  test("a held attempt is counted once: as held, not again as unspent cap", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), 500_000);
    await budget.tryHold([{ attemptId: "a#1", scope: MANUAL, worstMicros: 100_000 }]);
    expect(monthRoom(budget, caps).committedMicros).toBe(500_000);
  });

  test("a job that has used its whole cap holds back nothing more", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), 300_000);
    const r = await budget.tryReserve(req("a#1", 300_000, MANUAL));
    if (!r.ok) throw new Error("reserve");
    await budget.settle(r.handle, { costMicros: 300_000, estimated: false });
    expect(monthRoom(budget, caps)).toEqual({ budgetMicros: 10_000_000, committedMicros: 300_000, freeMicros: 9_700_000 });
  });

  test("an earlier month's spend in a live scope reduces its unspent cap but is not spent this month", async () => {
    const { budget, caps } = await setup({ lines: settled("a#1", 3_000_000, "2026-09-02T10:00:00.000Z", MANUAL) });
    caps.set(scopeKey(MANUAL), 5_000_000);
    expect(monthRoom(budget, caps)).toEqual({ budgetMicros: 10_000_000, committedMicros: 2_000_000, freeMicros: 8_000_000 });
  });

  test("a resumable slice that is not running counts through the extra live scopes", async () => {
    const { budget, caps } = await setup();
    const extra = [{ scope: SLICE, capMicros: 5_250_000 }];
    expect(monthRoom(budget, caps, extra).freeMicros).toBe(10_000_000 - 5_250_000);
  });

  test("a resumable slice that has spent part of its cap holds back the rest", async () => {
    const { budget, caps } = await setup({ lines: settled("s#1", 1_000_000, NOW, SLICE) });
    const extra = [{ scope: SLICE, capMicros: 5_250_000 }];
    expect(monthRoom(budget, caps, extra)).toEqual({ budgetMicros: 10_000_000, committedMicros: 5_250_000, freeMicros: 4_750_000 });
  });

  test("a scope that is both running and listed as extra is counted once", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(SLICE), 5_250_000);
    const extra = [{ scope: SLICE, capMicros: 5_250_000 }];
    expect(monthRoom(budget, caps, extra).committedMicros).toBe(5_250_000);
  });

  test("several live scopes add up", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), 2_000_000);
    caps.set(scopeKey(JOB), 1_000_000);
    expect(monthRoom(budget, caps, [{ scope: SLICE, capMicros: 500_000 }]).freeMicros).toBe(10_000_000 - 3_500_000);
  });

  test("the room follows a new monthly budget", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), 5_000_000);
    await budget.setMonthlyBudget(20_000_000);
    expect(monthRoom(budget, caps).freeMicros).toBe(15_000_000);
  });

  test("the room is zero, never negative, when the live caps exceed the budget", async () => {
    const { budget, caps } = await setup({ monthlyBudgetMicros: 1_000_000 });
    caps.set(scopeKey(MANUAL), 5_000_000);
    expect(monthRoom(budget, caps)).toEqual({ budgetMicros: 1_000_000, committedMicros: 5_000_000, freeMicros: 0 });
  });

  test("a zero budget has no room", async () => {
    const { budget, caps } = await setup({ monthlyBudgetMicros: 0 });
    expect(monthRoom(budget, caps).freeMicros).toBe(0);
  });
});

describe("monthRoom excluding a scope (the slice waiting for resume-slice)", () => {
  test("the excluded slice's own unspent cap is not subtracted: $10 budget, $4 spent elsewhere, slice cap $5.25 with $3 committed", async () => {
    const lines = [...settled("j#1", 4_000_000, NOW, JOB), ...settled("s#1", 3_000_000, NOW, SLICE)];
    const { budget, caps } = await setup({ lines });
    const extra = [{ scope: SLICE, capMicros: 5_250_000 }];
    expect(monthRoom(budget, caps, extra).freeMicros).toBe(750_000);
    expect(monthRoom(budget, caps, extra, SLICE).freeMicros).toBe(3_000_000);
  });

  test("a running job's cap is excluded too when it is the excluded scope; others stay", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(SLICE), 5_250_000);
    caps.set(scopeKey(MANUAL), 2_000_000);
    expect(monthRoom(budget, caps, [], SLICE).freeMicros).toBe(8_000_000);
  });
});

describe("A21: a slice sized to the room completes while a concurrent manual run spends its whole cap", () => {
  const MANUAL_CAP = 5_000_000;

  /** The manual run reserves and settles at worst, in 100 000 µ$ steps, until it has used its whole cap. */
  async function spendWholeCap(budget: Budget): Promise<void> {
    for (let i = 0; i < MANUAL_CAP / 100_000; i++) {
      const r = await budget.tryReserve(req(`manual#${i}`, 100_000, MANUAL));
      if (!r.ok) throw new Error(`the manual run was refused: ${r.reason}`);
      await budget.settle(r.handle, { costMicros: 100_000, estimated: false });
    }
  }

  test("sized to the room with live caps, the slice never meets BUDGET_EXCEEDED", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), MANUAL_CAP);

    const room = monthRoom(budget, caps);
    const slice = sliceSize({ scenesLeft: 90, drawLeftMicros: drawAllocationLeft(90 * PHOTO, []), roomMicros: room.freeMicros, photoWorstMicros: PHOTO });
    expect(slice.photos).toBe(Math.floor(5_000_000 / PHOTO));
    caps.set(scopeKey(SLICE), slice.capMicros);

    // The manual run spends everything it may, alternating with the slice's attempts.
    const refusals: string[] = [];
    for (let i = 0; i < MANUAL_CAP / 100_000; i++) {
      const m = await budget.tryReserve(req(`manual#${i}`, 100_000, MANUAL));
      if (!m.ok) throw new Error(`the manual run was refused: ${m.reason}`);
      await budget.settle(m.handle, { costMicros: 100_000, estimated: false });
      if (i < slice.photos) {
        const s = await budget.tryReserve(req(`slice#${i}`, PHOTO, SLICE));
        if (!s.ok) refusals.push(s.reason);
        else await budget.settle(s.handle, { costMicros: PHOTO, estimated: false });
      }
    }
    expect(refusals).toEqual([]);
  });

  test("sized to a room that ignores the running job's cap, the same slice is refused BUDGET_EXCEEDED mid-run (the failure A21 prevents)", async () => {
    const { budget, caps } = await setup();
    caps.set(scopeKey(MANUAL), MANUAL_CAP);

    const status = budget.status();
    const naiveRoom = status.monthlyBudgetMicros - (status.spentThisMonthMicros + status.openReserveMicros + status.heldMicros);
    const slice = sliceSize({ scenesLeft: 90, drawLeftMicros: 90 * PHOTO, roomMicros: naiveRoom, photoWorstMicros: PHOTO });
    expect(slice.photos).toBe(25);
    caps.set(scopeKey(SLICE), slice.capMicros);

    await spendWholeCap(budget);
    let refused = 0;
    for (let i = 0; i < slice.photos; i++) {
      const s = await budget.tryReserve(req(`slice#${i}`, PHOTO, SLICE));
      if (!s.ok) {
        expect(s.reason).toBe("BUDGET_EXCEEDED");
        refused++;
      } else await budget.settle(s.handle, { costMicros: PHOTO, estimated: false });
    }
    expect(refused).toBeGreaterThan(0);
  });

  test("once the slice is running, its whole cap is off the room the next job is sized to", async () => {
    const { budget, caps } = await setup();
    const slice = sliceSize({ scenesLeft: 90, drawLeftMicros: 90 * PHOTO, roomMicros: monthRoom(budget, caps).freeMicros, photoWorstMicros: PHOTO });
    expect(slice).toMatchObject({ photos: 25, capMicros: 25 * PHOTO });
    caps.set(scopeKey(SLICE), slice.capMicros);
    expect(monthRoom(budget, caps).freeMicros).toBe(10_000_000 - slice.capMicros);
  });
});
