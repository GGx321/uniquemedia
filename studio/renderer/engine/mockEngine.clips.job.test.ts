import { describe, expect, test } from "bun:test";
import { REAL_CLIP_TIMINGS } from "../../engine/clips/timings";
import { CLIP_JOB_STEPS, JobProgress } from "../../shared/engine";
import { AVATAR, CLIP_PHOTOS, create, endOf, listClips, makeClipMock, money, onlyClip, phasesOf, progressOf, reconcile, refusal, runClip, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V7: a clip's job in the mock, from create to record: the phases in order, the money, the end. The reference is the engine (engine.clips.job.test.ts and
// engine/clips/attempt.table.test.ts, the settle table of plan §5.7); every figure here is theirs.

/** Runs the mock's clock one task at a time until `condition` holds (the clip is then caught mid-flight), or fails. */
function stepUntil(m: ClipMock, condition: () => boolean, what: string): void {
  for (let i = 0; i < 400 && !condition(); i++) if (!m.scheduler.next()) break;
  if (!condition()) throw new Error(`the clip never reached ${what}`);
}

const reached = (m: ClipMock, jobId: string, phase: string) => () => phasesOf(m.events, jobId).includes(phase);

// engine/clips/attempt.ts: how long after the terminal status the money settles. A bill the poll carries is settled at once; a completed poll with no usage waits for `/generation` (15 s after the status, a 404
// read again twice, 5 s apart) and settles at the worst; a refusal that `/generation` bills is settled by its FIRST reading (15 s), and one that needs the proof (a 404, a net-usage check) by its second (2 min).
describe("when a clip's money settles, after the provider's terminal status", () => {
  const T = REAL_CLIP_TIMINGS;

  /** The mock's clock, when `phase` (or the job's end) was reached, counted from the submit (the moment `rendering` was announced). */
  async function afterSubmit(script: Parameters<ClipMock["engine"]["scriptNextClip"]>[0], until: "downloading" | "end"): Promise<number> {
    const m = makeClipMock();
    m.engine.scriptNextClip(script);
    // No fallback, so a free refusal ends the job at its own settle instead of going on to Grok.
    const { jobId } = await unwrap(create(m, { fallback: "none", acceptedWorstMicros: 504_000 }));
    stepUntil(m, reached(m, jobId, "rendering"), "rendering");
    const submitted = m.engine.peekClips().nowMs;
    stepUntil(m, until === "end" ? () => endOf(m.events, jobId) !== undefined : reached(m, jobId, until), until);
    return m.engine.peekClips().nowMs - submitted;
  }

  test("a poll that carries its usage settles at the terminal status", async () => {
    expect(await afterSubmit("ok", "downloading")).toBe(3 * T.pollMs);
  });

  test("a poll with no usage waits for `/generation`: 15 s, read again twice 5 s apart, then settles at the worst", async () => {
    expect(await afterSubmit("ok-uncosted", "downloading")).toBe(3 * T.pollMs + T.proofFirstReadMs + 2 * T.proofRetryMs);
  });

  test.each(["refused-paid", "provider-error-paid"] as const)("%s: a refusal /generation bills is settled by the first reading, 15 s after the status", async (script) => {
    expect(await afterSubmit(script, "end")).toBe(3 * T.pollMs + T.proofFirstReadMs);
  });

  test.each(["refused-free", "refused-unknown", "refused-uncounted", "provider-error"] as const)("%s: a refusal that needs the whole proof is settled by its second reading, 2 min after the status", async (script) => {
    expect(await afterSubmit(script, "end")).toBe(3 * T.pollMs + T.proofSecondReadMs);
  });
});

describe("a clip from create to record", () => {
  test("phases in order with done within total; job.done carries the clip; the record is ready with the engine's figures", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);
    expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting", "rendering", "downloading", "checking", "saving"]);
    for (const progress of progressOf(m.events, jobId)) {
      expect(JobProgress.safeParse(progress).success).toBe(true);
      expect(progress.done).toBeLessThanOrEqual(CLIP_JOB_STEPS);
      expect(progress.total).toBe(CLIP_JOB_STEPS);
    }
    expect(progressOf(m.events, jobId).find((p) => p.phase === "rendering")).toMatchObject({ model: "kling", submittedAt: expect.any(String), done: 0 });
    expect(progressOf(m.events, jobId).map((p) => p.done)).toEqual([0, 0, 0, 1, 2, 3]);
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "clip", avatarId: AVATAR, clipId: jobId } } });

    const clip = await onlyClip(m);
    expect(clip).toMatchObject({
      clipId: jobId,
      avatarId: AVATAR,
      photoId: CLIP_PHOTOS.plain.photoId,
      seen: false,
      status: "ready",
      model: "kling-std",
      fallback: false,
      recovered: false,
      cost: { micros: 420_000, kind: "billed" },
      providerCostMicros: 420_000,
      exports: [],
      width: 720,
      height: 1280,
      durationMs: 5_000,
      motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    });
    expect(await money(m)).toMatchObject({ spentMicros: 420_000, unsettledMicros: 0, unsettledCount: 0 });
  });

  test("a pro clip of 10 s is a 1080 x 1920 file of 10 s that bills 1 120 000 µ$, reserved at 1 232 000", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m, { quality: "pro", seconds: 10, acceptedWorstMicros: 1_550_000 }));
    stepUntil(m, reached(m, jobId, "rendering"), "rendering");
    expect(await money(m)).toMatchObject({ unsettledMicros: 1_232_000, unsettledCount: 1 });
    m.scheduler.runAll();
    expect(await onlyClip(m)).toMatchObject({ model: "kling-pro", width: 1080, height: 1920, durationMs: 10_000, cost: { micros: 1_120_000, kind: "billed" }, providerCostMicros: 1_120_000 });
  });

  test("the reserve is the clip's first money event: open at the worst case before the POST, settled when the video completes, announced with money.changed", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, reached(m, jobId, "submitting"), "submitting");
    expect(await money(m)).toMatchObject({ unsettledMicros: 504_000, unsettledCount: 1, spentMicros: 0 });
    m.scheduler.runAll();
    const statuses = m.events.flatMap((e) => (e.type === "money.changed" && e.payload.status.ledger === "open" ? [e.payload.status] : []));
    expect(statuses.some((s) => s.unsettledMicros === 504_000)).toBe(true);
    expect(statuses.some((s) => s.spentMicros === 420_000 && s.unsettledMicros === 0)).toBe(true);
  });

  test("the snapshot lists the running job in its phase, and the finished one as done", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, reached(m, jobId, "rendering"), "rendering");
    const running = await unwrap(m.client.request("engine.snapshot", {}));
    expect(running.jobs.filter((j) => j.kind === "clip")).toEqual([expect.objectContaining({ kind: "clip", jobId, clipId: jobId, status: "running", phase: "rendering", model: "kling" })]);
    m.scheduler.runAll();
    const finished = await unwrap(m.client.request("engine.snapshot", {}));
    expect(finished.jobs.filter((j) => j.kind === "clip")).toEqual([expect.objectContaining({ jobId, status: "done", done: CLIP_JOB_STEPS, result: { kind: "clip", avatarId: AVATAR, clipId: jobId } })]);
  });

  test("a clip of an ordinary photo that is judged carries a face verdict: a match at 0.86 over 10 frames for 5 s, 20 for 10 s", async () => {
    const m = makeClipMock();
    await runClip(m);
    await runClip(m, { seconds: 10, acceptedWorstMicros: 1_550_000 });
    const faces = (await listClips(m)).map((c) => (c.status === "ready" ? c.face : null));
    expect(faces).toEqual([
      { verdict: "match", p75: 0.86, frames: 20 },
      { verdict: "match", p75: 0.86, frames: 10 },
    ]);
  });

  test("a scripted face check: a mismatch, too few frames with one face, a broken worker; the clip is kept either way", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip({ face: "mismatch" });
    await runClip(m);
    m.engine.scriptNextClip({ face: "few-faces" });
    await runClip(m);
    m.engine.scriptNextClip({ face: "worker" });
    await runClip(m);
    const clips = (await listClips(m)).reverse();
    expect(clips.map((c) => c.status)).toEqual(["ready", "ready", "ready"]);
    expect(clips.map((c) => (c.status === "ready" ? c.face : null))).toEqual([
      { verdict: "mismatch", p75: 0.41, frames: 10 },
      { verdict: "skipped", frames: 2, why: "few-faces" },
      { verdict: "skipped", frames: 0, why: "worker" },
    ]);
  });
});

describe("one paid clip at a time (I5.50)", () => {
  test("two creates with no await between them make exactly one job; the other is IN_FLIGHT `one-at-a-time`, free", async () => {
    const m = makeClipMock();
    const [first, second] = await Promise.all([create(m), create(m)]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "one-at-a-time" } });
    m.scheduler.runAll();
    expect(await listClips(m)).toHaveLength(1);
  });

  test("the slot is the first check: a create that would be refused otherwise still answers one-at-a-time", async () => {
    const m = makeClipMock();
    await unwrap(create(m));
    expect(await refusal(create(m, { photoId: "photo-mia-master", acceptedWorstMicros: 1 }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "one-at-a-time" });
  });

  test("once the first clip's money closes, a new one is allowed while its download still runs", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, reached(m, jobId, "downloading"), "downloading");
    const second = await create(m, { acceptedWorstMicros: 850_000 });
    expect(second.ok).toBe(true);
    m.scheduler.runAll();
    expect(await listClips(m)).toHaveLength(2);
  });

  test("a refused create gives the slot back: the next create runs", async () => {
    const m = makeClipMock();
    expect((await create(m, { photoId: "photo-mia-master" })).ok).toBe(false);
    expect((await create(m)).ok).toBe(true);
  });

  test("the reconcile is refused IN_FLIGHT while the clip's money is open, and runs once it is closed and its hold is over", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, reached(m, jobId, "rendering"), "rendering");
    expect(await reconcile(m)).toEqual({ ok: false, code: "IN_FLIGHT" });
    // In the engine's words: the paid count of the one clip.
    expect(await refusal(m.client.request("money.reconcile", {}))).toMatchObject({ code: "IN_FLIGHT", detail: "1 paid job(s) of this engine are running; reconcile when they end" });
    m.scheduler.runAll();
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "done" } });
  });
});

describe("cancel through avatars.cancel", () => {
  test("in `preparing`: cancelled, free, no record and no reserve", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    expect(await unwrap(m.client.request("avatars.cancel", { jobId }))).toEqual({ jobId });
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.cancelled", payload: { kind: "clip", jobId, avatarId: AVATAR, clipId: jobId } });
    expect(phasesOf(m.events, jobId)).toEqual(["preparing"]);
    expect(m.engine.peekClips().posts).toEqual([]);
    expect(m.engine.peekClips().attempts).toEqual([]);
    expect(await listClips(m)).toEqual([]);
    expect(await money(m)).toMatchObject({ spentMicros: 0, unsettledMicros: 0 });
    expect((await create(m)).ok).toBe(true);
  });

  test("after the POST: IN_FLIGHT `submitted`, and the job goes on to its record", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, reached(m, jobId, "rendering"), "rendering");
    expect(await refusal(m.client.request("avatars.cancel", { jobId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "submitted" });
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)?.type).toBe("job.done");
  });

  test("a job that is not in this engine is NOT_FOUND", async () => {
    expect((await refusal(makeClipMock().client.request("avatars.cancel", { jobId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
  });
});

describe("the settle table (plan §5.7), mode auto", () => {
  /** What the mock's money state machine did, attempt by attempt: the reserve, how it closed, and the POSTs that left. */
  function ledgerOf(m: ClipMock) {
    return m.engine.peekClips().attempts.map((a) => [a.model, a.worstMicros, a.state === "open" ? "open" : a.costMicros, a.state === "open" ? undefined : a.estimated] as const);
  }

  test("1 completed with usage: usage.cost, exact", async () => {
    const m = makeClipMock();
    await runClip(m);
    expect(ledgerOf(m)).toEqual([["kling", 504_000, 420_000, false]]);
  });

  test("2 completed without usage and without a /generation record: the worst, estimated, shown as «стоимость не прочитана»", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("ok-uncosted");
    await runClip(m);
    expect(ledgerOf(m)).toEqual([["kling", 504_000, 504_000, true]]);
    const clip = await onlyClip(m);
    expect(clip).toMatchObject({ status: "ready", cost: { micros: 504_000, kind: "estimated" } });
    expect(clip.providerCostMicros).toBeUndefined();
  });

  test("3 a moderation 4xx at the submit: settled 0, no proof window, then Grok runs by itself and the clip bills Grok's figure", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-submit");
    const jobId = await runClip(m);
    expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting", "submitting", "rendering", "downloading", "checking", "saving"]);
    expect(progressOf(m.events, jobId).filter((p) => p.phase === "submitting").map((p) => p.model)).toEqual(["kling", "grok"]);
    expect(m.engine.peekClips().posts).toEqual(["kling", "grok"]);
    expect(ledgerOf(m)).toEqual([
      ["kling", 504_000, 0, false],
      ["grok", 850_000, 710_000, false],
    ]);
    expect(await onlyClip(m)).toMatchObject({ status: "ready", model: "grok", fallback: true, cost: { micros: 710_000, kind: "billed" }, providerCostMicros: 710_000, request: { model: "kling", fallback: "auto" } });
  });

  test("7 a poll-time content refusal proven free: `proving` only there, with its end; then Grok behind it; cost is Grok's alone", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-free");
    const jobId = await runClip(m);
    expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting", "rendering", "proving", "submitting", "rendering", "downloading", "checking", "saving"]);
    const proving = progressOf(m.events, jobId).filter((p) => p.phase === "proving");
    expect(proving).toHaveLength(1);
    expect(proving[0]).toMatchObject({ model: "kling", proveUntil: expect.any(String), done: 0 });
    for (const p of progressOf(m.events, jobId)) if (p.phase !== "proving") expect(p.proveUntil).toBeUndefined();
    expect(m.engine.peekClips().posts).toEqual(["kling", "grok"]);
    expect(ledgerOf(m)).toEqual([
      ["kling", 504_000, 0, false],
      ["grok", 850_000, 710_000, false],
    ]);
    expect(await onlyClip(m)).toMatchObject({ status: "ready", model: "grok", fallback: true, cost: { micros: 710_000, kind: "billed" } });
  });

  test("7b the same refusal with fallback `none` ends `refused-free`: free, no Grok, no offer", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-free");
    const jobId = await runClip(m, { fallback: "none", acceptedWorstMicros: 504_000 });
    expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting", "rendering", "proving"]);
    expect(endOf(m.events, jobId)?.type).toBe("job.done");
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    const clip = await onlyClip(m);
    expect(clip).toMatchObject({ status: "failed", failure: { reason: "refused-free" }, model: "kling-std", fallback: false, cost: { micros: 0, kind: "free" } });
    expect(clip.status === "failed" ? clip.failure.grokOffer : "ready").toBeUndefined();
  });

  test("7c a frame of «Смелая» under kling-only: refused free, never Grok, never an offer", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-free");
    await runClip(m, { photoId: CLIP_PHOTOS.bold.photoId, acceptedWorstMicros: 504_000 });
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-free" }, cost: { micros: 0, kind: "free" }, request: { fallback: "none" } });
  });

  test("7d under with-fallback a frame of «Смелая» falls back to Grok like any other", async () => {
    const m = makeClipMock({ clips: { boldClips: "with-fallback" } });
    m.engine.scriptNextClip("refused-free");
    await runClip(m, { photoId: CLIP_PHOTOS.bold.photoId });
    expect(m.engine.peekClips().posts).toEqual(["kling", "grok"]);
    expect(await onlyClip(m)).toMatchObject({ status: "ready", model: "grok", fallback: true });
  });

  test("7e Kling and Grok both refuse, both free: `refused-both`, model grok, cost free", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip({ first: "refused-free", then: "refused-free" });
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling", "grok"]);
    expect(ledgerOf(m)).toEqual([
      ["kling", 504_000, 0, false],
      ["grok", 850_000, 0, false],
    ]);
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-both" }, model: "grok", fallback: true, cost: { micros: 0, kind: "free" } });
  });

  test("7f Grok's reserve is refused by the month behind a free Kling: the clip ends `grok-no-room`, free, with no Grok POST", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip({ first: "refused-free", then: "no-room" });
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "grok-no-room" }, model: "grok", fallback: false, cost: { micros: 0, kind: "free" } });
  });

  // engine/clips/job.ts (`not-reserved`, `afterFreeRefusal`): Grok's reserve can be refused for a reason that is not room, here a halted ledger (a settle above its worst case elsewhere while Kling was
  // being proven). The clip ends free as Kling's `refused-free`, the owner is told through the money status, and nothing was sent to Grok.
  test("7g Grok's reserve is refused by a halted ledger behind a free Kling: `refused-free` on Kling, free, with no Grok POST, and the money says why", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip({ first: "refused-free", then: "ok" });
    const { jobId } = await unwrap(create(m));
    stepUntil(m, reached(m, jobId, "proving"), "proving");
    m.engine.haltAboveWorst();
    const before = m.events.length;
    m.scheduler.runAll();
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.done" });
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-free" }, model: "kling-std", fallback: false, cost: { micros: 0, kind: "free" } });
    expect(m.events.slice(before).some((e) => e.type === "money.changed")).toBe(true);
    expect(await money(m)).toMatchObject({ halt: { cause: "SETTLE_ABOVE_WORST" } });
  });

  test("7h a ledger that needs a reconcile before the first reserve refuses the clip itself, in the budget's words, with nothing sent", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    m.engine.haltAboveWorst();
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.failed", payload: { jobId, error: { code: "SETTLE_ABOVE_WORST" } } });
    expect(m.engine.peekClips().posts).toEqual([]);
    expect(m.engine.peekClips().attempts).toEqual([]);
    expect(m.engine.peekClips().journals[jobId]).toBeUndefined();
    expect(await listClips(m)).toEqual([]);
  });

  test("9 a refusal that /generation bills: settled at that figure, `refused-paid`, no Grok", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-paid");
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect(ledgerOf(m)).toEqual([["kling", 504_000, 420_000, false]]);
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-paid" }, cost: { micros: 420_000, kind: "billed" }, providerCostMicros: 420_000 });
  });

  test("8 a refusal after which the account's usage rose: the worst, estimated, `refused-unknown`, no Grok", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-unknown");
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect(ledgerOf(m)).toEqual([["kling", 504_000, 504_000, true]]);
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-unknown" }, cost: { micros: 504_000, kind: "estimated" } });
  });

  test("the strict free proof: a net-usage check that could not count is NOT free: worst, `refused-unknown`, and no automatic Grok", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-uncounted");
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect(ledgerOf(m)).toEqual([["kling", 504_000, 504_000, true]]);
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-unknown" }, cost: { micros: 504_000, kind: "estimated" } });
  });

  test("11 a poll-time failure that is not a content refusal goes through the same proof and never to Grok: free, paid or worst", async () => {
    for (const [script, cost, kind] of [
      ["provider-error", 0, "free"],
      ["provider-error-paid", 420_000, "billed"],
      ["provider-error-unknown", 504_000, "estimated"],
    ] as const) {
      const m = makeClipMock();
      m.engine.scriptNextClip(script);
      const jobId = await runClip(m);
      expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting", "rendering", "proving"]);
      expect(progressOf(m.events, jobId).find((p) => p.phase === "proving")?.proveUntil).toEqual(expect.any(String));
      expect(m.engine.peekClips().posts).toEqual(["kling"]);
      expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "provider-error" }, cost: { micros: cost, kind } });
    }
  });

  test("4 a refusal at the submit that is not a content one is free and ends with its own reason; no rendering, no proving", async () => {
    for (const [script, reason] of [
      ["rate-limited", "rate-limited"],
      ["bad-request", "bad-request"],
      ["key-invalid", "key-invalid"],
      ["no-credits", "no-credits"],
    ] as const) {
      const m = makeClipMock();
      m.engine.scriptNextClip(script);
      const jobId = await runClip(m);
      expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting"]);
      expect(m.engine.peekClips().posts).toEqual(["kling"]);
      expect(ledgerOf(m)).toEqual([["kling", 504_000, 0, false]]);
      expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason }, cost: { micros: 0, kind: "free" } });
      expect(endOf(m.events, jobId)?.type).toBe("job.done");
    }
  });

  test("a 401 at the submit marks the stored key rejected, as the engine does", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("key-invalid");
    await runClip(m);
    const settings = await unwrap(m.client.request("settings.get", {}));
    expect(settings.apiKey.rejected).toBe(true);
  });

  test("5 a 5xx or a timeout at the submit: the clip ends at once, its reserve stays open at the worst, `submit-uncertain`", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("uncertain");
    const jobId = await runClip(m);
    expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting"]);
    expect(endOf(m.events, jobId)?.type).toBe("job.done");
    expect(ledgerOf(m)).toEqual([["kling", 504_000, "open", undefined]]);
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "submit-uncertain" }, cost: { micros: 504_000, kind: "open" } });
    expect(await money(m)).toMatchObject({ unsettledMicros: 504_000, unsettledCount: 1, spentMicros: 0 });
  });

  test("12 no terminal status in 20 min: the job stays live in phase `late`, then ends failed `late` with its reserve open", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("late");
    const { jobId } = await unwrap(create(m));
    stepUntil(m, reached(m, jobId, "late"), "late");
    expect(progressOf(m.events, jobId).find((p) => p.phase === "late")).toMatchObject({ model: "kling", submittedAt: expect.any(String) });
    expect(endOf(m.events, jobId)).toBeUndefined();
    expect(await listClips(m)).toEqual([]);
    expect(await money(m)).toMatchObject({ unsettledMicros: 504_000, unsettledCount: 1 });
    m.scheduler.runAll();
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "late" }, cost: { micros: 504_000, kind: "open" } });
  });

  test("12b a late `completed` writes no ledger line: the clip is ready, its cost is the open reserve until the reconcile, the provider's number is information", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("late-ok");
    const jobId = await runClip(m);
    expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting", "rendering", "late", "downloading", "checking", "saving"]);
    expect(m.engine.peekClips().attempts).toEqual([expect.objectContaining({ state: "open", worstMicros: 504_000 })]);
    expect(await onlyClip(m)).toMatchObject({ status: "ready", cost: { micros: 504_000, kind: "open" }, providerCostMicros: 420_000 });
    // The late status holds the reconcile for 2 minutes more.
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "too-early" } });
    m.scheduler.runAll();
    const closed = await reconcile(m);
    expect(closed).toMatchObject({ ok: true, result: { status: "done", closedReserves: 1 } });
    expect(await onlyClip(m)).toMatchObject({ cost: { micros: 504_000, kind: "estimated" }, providerCostMicros: 420_000 });
  });

  test("a paid failure after a completed video is recorded with a free re-download until 60 min after the submit", async () => {
    for (const reason of ["download-failed", "invalid-file", "disk-full"] as const) {
      const m = makeClipMock();
      m.engine.scriptNextClip(reason);
      const jobId = await runClip(m);
      expect(phasesOf(m.events, jobId)).toEqual(["preparing", "submitting", "rendering", "downloading"]);
      const clip = await onlyClip(m);
      expect(clip).toMatchObject({ status: "failed", failure: { reason }, cost: { micros: 420_000, kind: "billed" } });
      const submitted = progressOf(m.events, jobId).find((p) => p.phase === "rendering")?.submittedAt;
      expect(clip.status === "failed" ? clip.retryDownloadUntil : undefined).toBe(new Date(Date.parse(submitted ?? "") + 3_600_000).toISOString());
    }
  });
});

describe("the settle table, mode offer", () => {
  test("a content refusal proven free offers Grok as a new click at its own price; nothing runs by itself", async () => {
    const m = makeClipMock({ clips: { mode: "offer" } });
    m.engine.scriptNextClip("refused-free");
    await runClip(m, { acceptedWorstMicros: 504_000 });
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    const clip = await onlyClip(m);
    expect(clip).toMatchObject({ status: "failed", failure: { reason: "refused-free", grokOffer: { expectedMicros: 710_000, worstMicros: 850_000, prices: "live" } }, cost: { micros: 0, kind: "free" } });
  });

  test("the offer is a Grok create: it runs with no fallback, bills Grok's figure, and its own refusal ends `refused-free` with no offer", async () => {
    const m = makeClipMock({ clips: { mode: "offer" } });
    m.engine.scriptNextClip({ first: "ok" });
    await runClip(m, { model: "grok", fallback: "none", acceptedWorstMicros: 850_000 });
    expect(m.engine.peekClips().posts).toEqual(["grok"]);
    expect(await onlyClip(m)).toMatchObject({ status: "ready", model: "grok", cost: { micros: 710_000, kind: "billed" } });

    const refused = makeClipMock({ clips: { mode: "offer" } });
    refused.engine.scriptNextClip("refused-free");
    await runClip(refused, { model: "grok", fallback: "none", acceptedWorstMicros: 850_000 });
    const clip = await onlyClip(refused);
    expect(clip).toMatchObject({ status: "failed", failure: { reason: "refused-free" }, model: "grok", cost: { micros: 0, kind: "free" } });
    expect(clip.status === "failed" ? clip.failure.grokOffer : "ready").toBeUndefined();
  });

  test("no offer after a billed, uncertain or unreadable failure, for a fallback `none`, or for a frame of «Смелая»", async () => {
    for (const script of ["refused-paid", "refused-unknown", "refused-uncounted", "provider-error"] as const) {
      const m = makeClipMock({ clips: { mode: "offer" } });
      m.engine.scriptNextClip(script);
      await runClip(m, { acceptedWorstMicros: 504_000 });
      const clip = await onlyClip(m);
      expect(clip.status === "failed" ? clip.failure.grokOffer : "ready").toBeUndefined();
    }
    const none = makeClipMock({ clips: { mode: "offer" } });
    none.engine.scriptNextClip("refused-free");
    await runClip(none, { fallback: "none", acceptedWorstMicros: 504_000 });
    const noneClip = await onlyClip(none);
    expect(noneClip.status === "failed" ? noneClip.failure.grokOffer : "ready").toBeUndefined();
    const bold = makeClipMock({ clips: { mode: "offer" } });
    bold.engine.scriptNextClip("refused-free");
    await runClip(bold, { photoId: CLIP_PHOTOS.bold.photoId, acceptedWorstMicros: 504_000 });
    const boldClip = await onlyClip(bold);
    expect(boldClip.status === "failed" ? boldClip.failure.grokOffer : "ready").toBeUndefined();
  });

  test("the offer is priced at the clip's length", async () => {
    const m = makeClipMock({ clips: { mode: "offer" } });
    m.engine.scriptNextClip("refused-free");
    await runClip(m, { seconds: 10, acceptedWorstMicros: 924_000 });
    const clip = await onlyClip(m);
    expect(clip.status === "failed" ? clip.failure.grokOffer : null).toMatchObject({ expectedMicros: 1_410_000, worstMicros: 1_550_000 });
  });

  test("in mode offer a poll-time content refusal whose check cannot count is worst-estimated with no offer, as in mode auto", async () => {
    const m = makeClipMock({ clips: { mode: "offer" } });
    m.engine.scriptNextClip("refused-uncounted");
    await runClip(m, { acceptedWorstMicros: 504_000 });
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-unknown" }, cost: { micros: 504_000, kind: "estimated" } });
  });
});
