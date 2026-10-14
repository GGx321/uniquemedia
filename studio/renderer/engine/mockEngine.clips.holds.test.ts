import { describe, expect, test } from "bun:test";
import { PROOF_READ_TRIES, REAL_CLIP_TIMINGS, SHORT_CLIP_TIMINGS } from "../../engine/clips/timings";
import { MOCK_CLIP_TIMINGS, MOCK_PROOF_READ_TRIES } from "./mockClips";
import { create, listClips, makeClipMock, money, moneyEvents, onlyClip, reconcile, runClip, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

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
    });
    for (const key of Object.keys(REAL) as (keyof typeof REAL)[]) expect(SHORT[key]).toBe(REAL[key] / 1_000);
  });

  test("the number of reads of a free call is the engine's", () => {
    expect(MOCK_PROOF_READ_TRIES).toBe(PROOF_READ_TRIES);
  });

  test("every figure the mock keeps is the engine's own, in both sets (the mock cannot import engine/, so the two are held side by side here)", () => {
    for (const key of Object.keys(REAL) as (keyof typeof REAL)[]) {
      expect(REAL[key]).toBe(REAL_CLIP_TIMINGS[key]);
      expect(SHORT[key]).toBe(SHORT_CLIP_TIMINGS[key]);
    }
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

  test("a clip that completed holds the reconcile for 2 minutes after its terminal status, and nothing after that", async () => {
    const m = makeClipMock();
    await runClip(m);
    expect(m.engine.peekClips().holds.size).toBe(1);
    const held = await reconcile(m);
    expect(held).toMatchObject({ ok: true, result: { status: "too-early" } });
    if (!held.ok || held.result.status !== "too-early") throw new Error("unreachable");
    expect(held.result.retryAfterMs).toBeLessThanOrEqual(REAL.holdTerminalMs);
    pastTheHold(m);
    expect(m.engine.peekClips().holds.size).toBe(0);
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "done", closedReserves: 0 } });
  });

  test("a reserve that was refused at the submit holds nothing, but the budget's own quiet rule still keeps the reconcile away for 2 minutes after the ledger's last line", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("rate-limited");
    await runClip(m);
    expect(m.engine.peekClips().holds.size).toBe(0);
    const early = await reconcile(m);
    expect(early).toMatchObject({ ok: true, result: { status: "too-early" } });
    if (!early.ok || early.result.status !== "too-early") throw new Error("unreachable");
    expect(early.result.retryAfterMs).toBeLessThanOrEqual(120_000);
    expect(await money(m)).not.toHaveProperty("reconcileAvailableAt");
    m.engine.passClipTime(120_000);
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "done" } });
  });

  test("a clip in `late` holds until 60 min after its submit, whatever the 20 min lifetime did", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("late");
    const { jobId } = await unwrap(create(m));
    for (let i = 0; i < 400 && !m.events.some((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.phase === "late"); i++) m.scheduler.next();
    const submitted = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId && e.payload.phase === "rendering" ? [e.payload.submittedAt] : []))[0];
    const status = await money(m);
    expect(status.reconcileAvailableAt).toBe(new Date(Date.parse(submitted ?? "") + REAL.holdSubmittedMs).toISOString());
    expect(status.reconcileNeeded).toBe(false);
  });
});

describe("money.status with a held clip reserve", () => {
  test("leaves this process's held abandoned reserve out of the reconcile reasons, keeps it unsettled, and says when the reconcile can run", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    const status = await money(m);
    expect(status).toMatchObject({ reconcileNeeded: false, reconcileReasons: [], unsettledMicros: 504_000, unsettledCount: 1 });
    const [attempt] = m.engine.peekClips().attempts;
    expect(status.reconcileAvailableAt).toBe(new Date((attempt?.reserveAtMs ?? 0) + REAL.holdUncertainMs).toISOString());
  });

  test("after the hold the same reserve is `open-reserves`, with no time to wait for", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    pastTheHold(m);
    const status = await money(m);
    expect(status).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"], unsettledMicros: 504_000 });
    expect(status).not.toHaveProperty("reconcileAvailableAt");
  });

  test("a paid command still runs while the reserve is held, and after: RECONCILE_REQUIRED never comes from this process's own reserves", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    const whileHeld = await create(m);
    expect(whileHeld.ok).toBe(true);
    m.scheduler.runAll();
    const after = await create(m);
    expect(after.ok).toBe(true);
    m.scheduler.runAll();
  });

  test("money.changed reaches the windows when the hold is taken and when it ends, with no spend at the end", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    const held = moneyEvents(m.events).filter((s) => s.ledger === "open" && s.reconcileAvailableAt !== undefined);
    expect(held.length).toBeGreaterThan(0);
    const spentAtEnd = (await money(m)).spentMicros;
    pastTheHold(m);
    const last = moneyEvents(m.events).at(-1);
    expect(last).toMatchObject({ ledger: "open", reconcileNeeded: true, spentMicros: spentAtEnd });
    expect(last).not.toHaveProperty("reconcileAvailableAt");
  });

  // The engine leaves a running clip's reserve out of the reconcile reasons (`isInFlight`, engine.ts `moneyStatus`): from its reserve to its settle the reserve is this process's own work. The mock
  // used to announce `reconcileNeeded: true` for a moment before the hold was taken and again when the terminal hold ended in the same tick as the proof settled: a paidStop and a banner blinking.
  const noFlicker: [string, Parameters<typeof makeClipMock>[0], Parameters<ClipMock["engine"]["scriptNextClip"]>[0]][] = [
    ["a clip that completes (mode auto)", {}, "ok"],
    ["a clip refused for free, then Grok behind it (mode auto)", {}, { first: "refused-free", then: "ok" }],
    ["a clip refused for free, left at the offer (mode offer)", { clips: { mode: "offer" } }, "refused-free"],
    ["a provider error", {}, "provider-error"],
    ["a refusal that was paid", {}, "refused-paid"],
  ];
  for (const [what, options, script] of noFlicker) {
    test(`never announces reconcileNeeded while ${what} runs, nor when its holds end`, async () => {
      const m = makeClipMock(options);
      m.engine.scriptNextClip(script);
      await runClip(m);
      pastTheHold(m);
      const statuses = moneyEvents(m.events).filter((s) => s.ledger === "open");
      expect(statuses.length).toBeGreaterThan(2);
      expect(statuses.filter((s) => s.reconcileNeeded || s.reconcileReasons.includes("open-reserves"))).toEqual([]);
    });
  }

  test("announces open-reserves for an uncertain submit once the reserve is abandoned and its hold ends", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    expect(moneyEvents(m.events).filter((s) => s.ledger === "open" && s.reconcileNeeded)).toEqual([]);
    pastTheHold(m);
    expect(moneyEvents(m.events).at(-1)).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"] });
  });

  test("with no hold, money.status carries no reconcileAvailableAt", async () => {
    const m = makeClipMock();
    expect(await money(m)).not.toHaveProperty("reconcileAvailableAt");
    await runClip(m);
    pastTheHold(m);
    expect(await money(m)).not.toHaveProperty("reconcileAvailableAt");
  });

  test("the latest of several holds is the one the status names", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    await runClip(m);
    const holds = [...m.engine.peekClips().holds.values()];
    expect(holds).toHaveLength(2);
    expect((await money(m)).reconcileAvailableAt).toBe(new Date(Math.max(...holds)).toISOString());
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
describe("the net-usage check with other money open (VR item 1)", () => {
  test("a refusal behind another clip's uncertain submit (its reserve open, its hold live) is settled at worst: no free proof, no Grok", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    m.engine.scriptNextClip("refused-free");
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling", "kling"]);
    const second = (await listClips(m)).find((c) => c.status === "failed" && c.failure.reason !== "submit-uncertain");
    expect(second).toMatchObject({ status: "failed", failure: { reason: "refused-unknown" }, model: "kling-std", cost: { micros: 504_000, kind: "estimated" } });
  });

  test("a previous clip that completed with an exact cost, its `terminal + 2 min` hold still live, does not spoil the proof: Grok runs", async () => {
    const m = makeClipMock();
    await runClip(m);
    expect(m.engine.peekClips().holds.size).toBe(1);
    m.engine.scriptNextClip("refused-free");
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling", "kling", "grok"]);
  });

  test("a previous clip whose cost was unreadable (settled at worst, an estimate) with its hold live leaves the proof uncounted: worst, no Grok", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("ok-uncosted");
    await runClip(m);
    expect(m.engine.peekClips().holds.size).toBe(1);
    m.engine.scriptNextClip("refused-free");
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling", "kling"]);
  });

  test("the same refusal after the reconcile closed the other reserve is proven free again, and Grok runs", async () => {
    const m = makeClipMock();
    await uncertainClip(m);
    pastTheHold(m);
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "done", closedReserves: 1 } });
    m.engine.scriptNextClip("refused-free");
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling", "kling", "grok"]);
  });
});
