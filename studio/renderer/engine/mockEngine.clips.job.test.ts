import { describe, expect, test } from "bun:test";
import { CLIP_JOB_STEPS, JobProgress } from "../../shared/engine";
import { AVATAR, CLIP_PHOTOS, create, endOf, makeClipMock, money, onlyClip, phasesOf, progressOf, runClip, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

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

  // engine/clips/job.ts (`not-reserved`, `afterFreeRefusal`): Grok's reserve can be refused for a reason that is not room, here a halted ledger (a settle above its worst case elsewhere while Kling was
  // being proven). The clip ends free as Kling's `refused-free`, the owner is told through the money status, and nothing was sent to Grok.

  test("9 a refusal that /generation bills: settled at that figure, `refused-paid`, no Grok", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-paid");
    await runClip(m);
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect(ledgerOf(m)).toEqual([["kling", 504_000, 420_000, false]]);
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "refused-paid" }, cost: { micros: 420_000, kind: "billed" }, providerCostMicros: 420_000 });
  });

});

