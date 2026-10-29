import { describe, expect, test } from "bun:test";
import { holdsFromLedger, planRecovery } from "../../engine/clips/recover";
import { summarizeJournal } from "../../engine/clips/journal";
import { REAL_CLIP_TIMINGS } from "../../engine/clips/timings";
import { create, makeClipMock, money, onlyClip, phasesOf, reconcile, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V7 (plan §5.12, I5.48, I5.49): `restart()` with a clip in flight. The mock's journal lines are the engine's (the same strict schema), so each fixture below is a journal the
// engine's own `planRecovery` can read: the tests ask the engine what it would do with the very lines the mock wrote, and hold the mock's recovery to it. Restart is reconcile, never adopt:
// the recovery job is free and writes no ledger line, and every reserve of the earlier process waits for the owner's reconcile.

function stepUntil(m: ClipMock, phase: string, jobId: string): void {
  for (let i = 0; i < 400 && !phasesOf(m.events, jobId).includes(phase); i++) if (!m.scheduler.next()) break;
  if (!phasesOf(m.events, jobId).includes(phase)) throw new Error(`the clip never reached ${phase}`);
}

/** Creates a clip and plays it up to the moment `phase` was announced, then restarts the engine. */
async function restartAt(m: ClipMock, phase: string, over: Parameters<typeof create>[1] = {}): Promise<string> {
  const { jobId } = await unwrap(create(m, over));
  stepUntil(m, phase, jobId);
  m.engine.restart();
  return jobId;
}

function engineSaysOf(m: ClipMock, clipId: string): string {
  const journal = m.engine.peekClips().journals[clipId] ?? [];
  const reserved = new Set(m.engine.peekClips().attempts.filter((a) => a.clipId === clipId).map((a) => a.attemptId));
  return planRecovery({ summary: summarizeJournal(journal), recordExists: false, reservedAttempts: reserved, nowMs: m.engine.peekClips().nowMs, timings: REAL_CLIP_TIMINGS }).kind;
}

describe("a clip whose reserve was made and whose POST left no `submitted` line (`submitting`)", () => {

  test("the reconcile waits for the reserve line's `at` + 20 min and for the restart's own quiet, and says when", async () => {
    const m = makeClipMock();
    await restartAt(m, "submitting");
    const [attempt] = m.engine.peekClips().attempts;
    const status = await money(m);
    expect(Date.parse(status.reconcileAvailableAt ?? "")).toBe(Math.max((attempt?.reserveAtMs ?? 0) + REAL_CLIP_TIMINGS.holdUncertainMs, m.engine.peekClips().restartedAtMs + 300_000));
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "too-early" } });
  });

});

describe("a clip that was submitted and had no end (`rendering`, `proving`, `late`)", () => {
  test.each(["rendering", "proving"] as const)("restarted in %s: the recovery polls the provider's job and, when it completed, fetches it: ready, recovered, the provider's number for information, the reserve still open", async (phase) => {
    const m = makeClipMock();
    m.engine.scriptNextClip(phase === "proving" ? { first: "refused-free", then: "ok" } : "ok");
    const jobId = await restartAt(m, phase);
    expect(engineSaysOf(m, jobId)).toBe("poll");
    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.find((j) => j.kind === "clip")).toMatchObject({ phase: "recovering", model: "kling", submittedAt: expect.any(String) });
    m.scheduler.runAll();
    const clip = await onlyClip(m);
    if (phase === "rendering") {
      expect(clip).toMatchObject({ clipId: jobId, status: "ready", recovered: true, model: "kling-std", fallback: false, cost: { micros: 504_000, kind: "open" }, providerCostMicros: 420_000, width: 720, height: 1280 });
    } else {
      // The refusal was being proven when the process stopped: the earlier process wrote no `ended` line, so the clip is read from the provider's own word.
      expect(clip).toMatchObject({ clipId: jobId, status: "failed", failure: { reason: "refused-unknown" }, recovered: true, cost: { micros: 504_000, kind: "open" } });
    }
    expect(await money(m)).toMatchObject({ reconcileNeeded: true, unsettledMicros: 504_000 });
  });

  // engine/clips/recover.ts `providerCost`: the poll's own usage, else one /generation read of the job's record; a poll with neither gives no number at all (never the figure the model would bill).

});

// VR item 2: a journal whose attempt ended at the POST (a 4xx the provider refused, settled 0) has an `ended` line and no `submitted` line. The mock's recovery plan reads it as the engine's does. The
// window is closed in both (the record follows the `ended` line at once), so the lines are written by hand and the two plans are asked about the very same journal.

// VR item 3 (engine/clips/recover.ts `refusalReason`): the old process settled the refused attempt in the ledger and stopped before the journal's `ended` line. The recovery takes the record's reason
// from that settle, and writes no ledger line of its own.
describe("a content refusal the old process had already settled when it stopped (VR item 3)", () => {
  async function restartedAfterSettle(bill: { costMicros: number; estimated: boolean }) {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-free");
    const { jobId } = await unwrap(create(m, { fallback: "none", acceptedWorstMicros: 504_000 }));
    stepUntil(m, "proving", jobId);
    m.engine.settleClipReserveBeforeCrash(`${jobId}:video#1`, bill);
    m.engine.restart();
    m.scheduler.runAll();
    return { m, jobId };
  }

  test("a settle of 0 is recorded `refused-free`: nothing is left for the reconcile", async () => {
    const { m } = await restartedAfterSettle({ costMicros: 0, estimated: false });
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-free" }, recovered: true, cost: { micros: 0, kind: "free" } });
    expect(await money(m)).toMatchObject({ unsettledMicros: 0, reconcileNeeded: false });
  });

});

// VR item 6: the engine never writes `ended {status: "uncertain"}` (an uncertain submit leaves the journal at `requested`, attempt.table.test.ts row 5): a restart reads such a line as «ended: held 2 min»,
// and the hold of an uncertain submit would be cut from 20 min to 2. The mock writes the same lines as the engine, and this pins it against the engine's own run.
describe("the journal of an uncertain submit (VR items 4 and 6)", () => {

  test("after a restart the reserve of an uncertain submit, whose journal went with its record, is held 60 min from its `at`, as the engine holds a reserve with no journal in view", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("uncertain");
    const { jobId } = await unwrap(create(m));
    m.scheduler.runAll();
    m.engine.restart();
    const { attempts, holds, nowMs } = m.engine.peekClips();
    const [attempt] = attempts;
    expect(attempt).toBeDefined();
    const engineHolds = holdsFromLedger([{ attemptId: `${jobId}:video#1`, at: new Date(attempt?.reserveAtMs ?? 0).toISOString() }], nowMs, REAL_CLIP_TIMINGS);
    expect(engineHolds.get(`${jobId}:video#1`)).toBe((attempt?.reserveAtMs ?? 0) + 60 * 60_000);
    expect(holds.get(`${jobId}:video#1`)).toBe(engineHolds.get(`${jobId}:video#1`));
  });
});
