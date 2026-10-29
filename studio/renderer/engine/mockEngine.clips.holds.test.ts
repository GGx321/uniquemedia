import { describe, expect, test } from "bun:test";
import { MOCK_CLIP_TIMINGS } from "./mockClips";
import { makeClipMock, money, onlyClip, reconcile, runClip, type ClipMock } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V7 (plan I5.48): the reconcile hold in the mock, as the engine keeps it (engine.clips.money.test.ts is the reference). A video bills when it completes, so while an attempt of
// this process may still bill the reconcile answers TOO_SOON; a held reserve of this process is not a reconcile reason (the renderer's paidStop would stop every paid action for nothing);
// `reconcileAvailableAt` says when; and every change of the registry is announced, because no ledger line marks it.

const { real: REAL, short: SHORT } = MOCK_CLIP_TIMINGS;

async function uncertainClip(m: ClipMock): Promise<string> {
  m.engine.scriptNextClip("uncertain");
  return runClip(m);
}

/** Runs the clock until the moment the registry has nothing left to hold (the mock's `settle`). */
function pastTheHold(m: ClipMock): void {
  m.scheduler.runAll();
}

describe("the timing sets", () => {
  test("the real set is the engine's real set, and the short set is the real one divided by a thousand", () => {
    expect(REAL).toEqual({
      pollMs: 20_000,
      proofFirstReadMs: 15_000,
      proofSecondReadMs: 120_000,
      proofRetryMs: 5_000,
      lifetimeMs: 1_200_000,
      latePollMs: 60_000,
      lateGiveUpMs: 3_600_000,
      holdUncertainMs: 1_200_000,
      holdTerminalMs: 120_000,
      holdSubmittedMs: 3_600_000,
      exportProgressMs: 2_000,
      // 5b.2 (S5.WB3): the batch's alone-wait bound and the pause after a 429, the engine's two new figures.
      aloneWaitMs: 130_000,
      rateLimitPauseMs: 60_000,
    });
    for (const key of Object.keys(REAL) as (keyof typeof REAL)[]) expect(SHORT[key]).toBe(REAL[key] / 1_000);
  });

});

describe("the reconcile and a clip", () => {
  test("answers TOO_SOON while the hold registry holds an entry, and runs once it is gone", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    // The clip ended at once; its reserve may still bill.
    const held = await reconcile(m);
    expect(held).toMatchObject({ ok: true, result: { status: "too-early" } });
    if (!held.ok || held.result.status !== "too-early") throw new Error("unreachable");
    expect(held.result.retryAfterMs).toBeGreaterThan(0);
    expect(held.result.retryAfterMs).toBeLessThanOrEqual(REAL.holdUncertainMs);
    expect(Number.isInteger(held.result.retryAfterMs)).toBe(true);
    expect(held.result.warnings).toEqual([]);

    pastTheHold(m);
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "done", closedReserves: 1 } });
    expect(await money(m)).toMatchObject({ unsettledMicros: 0, spentMicros: 504_000, reconcileNeeded: false });
  });

});

describe("the reconcile settles a clip's open reserve at its worst, and the clip says so", () => {
  test("an uncertain clip: `open` before, `estimated` at the worst after", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    expect(await onlyClip(m)).toMatchObject({ cost: { micros: 504_000, kind: "open" } });
    pastTheHold(m);
    await reconcile(m);
    expect(await onlyClip(m)).toMatchObject({ cost: { micros: 504_000, kind: "estimated" } });
  });
});

// VR item 1 (engine/clips/attempt.ts `moneyIsAlone`, attempt.proof.test.ts): the net-usage check counts only while nothing but the attempt is open or held. Another clip's charge, refunded inside
// the window, would hide this attempt's own billed refusal; so with other money open a refusal is never proven free, in either mode: worst, and no Grok.

