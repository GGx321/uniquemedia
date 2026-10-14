import { describe, expect, test } from "bun:test";
import { planRecovery } from "../../engine/clips/recover";
import { summarizeJournal } from "../../engine/clips/journal";
import { REAL_CLIP_TIMINGS } from "../../engine/clips/timings";
import { AVATAR, create, endOf, listClips, makeClipMock, money, onlyClip, phasesOf, progressOf, reconcile, refusal, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

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

describe("a clip in `preparing`", () => {
  test("is simply gone: no reserve, no journal, no record, nothing to recover", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    m.engine.restart();
    m.scheduler.runAll();
    expect(await listClips(m)).toEqual([]);
    expect(m.engine.peekClips().attempts).toEqual([]);
    expect(m.engine.peekClips().journals[jobId]).toBeUndefined();
    expect(await money(m)).toMatchObject({ unsettledMicros: 0, reconcileNeeded: false });
    expect((await create(m)).ok).toBe(true);
  });
});

describe("a clip whose reserve was made and whose POST left no `submitted` line (`submitting`)", () => {
  test("the recovery records it `lost`; its reserve stays open for the owner's reconcile, which is required", async () => {
    const m = makeClipMock();
    const jobId = await restartAt(m, "submitting");
    expect(engineSaysOf(m, jobId)).toBe("fail");
    m.scheduler.runAll();
    expect(await onlyClip(m)).toMatchObject({ clipId: jobId, status: "failed", failure: { reason: "lost" }, recovered: true, cost: { micros: 504_000, kind: "open" } });
    expect(await money(m)).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"], unsettledMicros: 504_000, unsettledCount: 1 });
    expect((await refusal(create(m))).code).toBe("RECONCILE_REQUIRED");
  });

  test("the recovery is a clip job in phase `recovering` that ends with job.done, writing no ledger line", async () => {
    const m = makeClipMock();
    const jobId = await restartAt(m, "submitting");
    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    const recovery = snapshot.jobs.find((j) => j.kind === "clip");
    expect(recovery).toMatchObject({ kind: "clip", status: "running", phase: "recovering", clipId: jobId });
    if (recovery === undefined) throw new Error("no recovery job");
    m.scheduler.runAll();
    expect(endOf(m.events, recovery.jobId)).toMatchObject({ type: "job.done", payload: { jobId: recovery.jobId, result: { kind: "clip", avatarId: AVATAR, clipId: jobId } } });
    expect(m.engine.peekClips().attempts).toEqual([expect.objectContaining({ state: "open", worstMicros: 504_000 })]);
  });

  test("the reconcile waits for the reserve line's `at` + 20 min and for the restart's own quiet, and says when", async () => {
    const m = makeClipMock();
    await restartAt(m, "submitting");
    const [attempt] = m.engine.peekClips().attempts;
    const status = await money(m);
    expect(Date.parse(status.reconcileAvailableAt ?? "")).toBe(Math.max((attempt?.reserveAtMs ?? 0) + REAL_CLIP_TIMINGS.holdUncertainMs, m.engine.peekClips().restartedAtMs + 300_000));
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "too-early" } });
  });

  test("past the wait the reconcile settles the reserve at its worst, and a clip may be made again", async () => {
    const m = makeClipMock();
    await restartAt(m, "submitting");
    m.scheduler.runAll();
    m.engine.passClipTime(REAL_CLIP_TIMINGS.holdUncertainMs + 1);
    m.scheduler.runAll();
    expect(await reconcile(m)).toMatchObject({ ok: true, result: { status: "done", closedReserves: 1 } });
    expect(await onlyClip(m)).toMatchObject({ cost: { micros: 504_000, kind: "estimated" } });
    expect((await create(m)).ok).toBe(true);
    m.scheduler.runAll();
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

  test("the recovery's phases: recovering, then downloading, checking and saving, and job.done", async () => {
    const m = makeClipMock();
    await restartAt(m, "rendering");
    const recovery = (await unwrap(m.client.request("engine.snapshot", {}))).jobs.find((j) => j.kind === "clip");
    if (recovery === undefined) throw new Error("no recovery job");
    m.scheduler.runAll();
    expect(phasesOf(m.events, recovery.jobId)).toEqual(["recovering", "recovering", "downloading", "checking", "saving"]);
    expect(progressOf(m.events, recovery.jobId).map((p) => p.done)).toEqual([0, 0, 1, 2, 3]);
  });

  test("a provider job that failed while the engine was away is recorded from its status: a refusal is `refused-unknown`, any other end `provider-error`", async () => {
    for (const [script, reason] of [
      ["refused-free", "refused-unknown"],
      ["provider-error", "provider-error"],
    ] as const) {
      const m = makeClipMock();
      m.engine.scriptNextClip(script);
      await restartAt(m, "rendering");
      m.scheduler.runAll();
      expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason }, recovered: true, cost: { micros: 504_000, kind: "open" } });
    }
  });

  test("restarted in `late`: a clip that comes in is fetched, one that never does is `late`", async () => {
    const ok = makeClipMock();
    ok.engine.scriptNextClip("late-ok");
    await restartAt(ok, "late");
    ok.scheduler.runAll();
    expect(await onlyClip(ok)).toMatchObject({ status: "ready", recovered: true, cost: { micros: 504_000, kind: "open" } });

    const never = makeClipMock();
    never.engine.scriptNextClip("late");
    await restartAt(never, "late");
    never.scheduler.runAll();
    expect(await onlyClip(never)).toMatchObject({ status: "failed", failure: { reason: "late" }, recovered: true });
  });

  test("the restart's hold is the submit + 60 min", async () => {
    const m = makeClipMock();
    const jobId = await restartAt(m, "rendering");
    const submitted = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId && e.payload.phase === "rendering" ? [e.payload.submittedAt] : []))[0];
    const status = await money(m);
    expect(Date.parse(status.reconcileAvailableAt ?? "")).toBe(Date.parse(submitted ?? "") + REAL_CLIP_TIMINGS.holdSubmittedMs);
  });
});

describe("a clip whose money the earlier process had settled (`downloading`, `checking`, `saving`)", () => {
  test("restarted in `downloading`: the file is fetched again; the clip is ready, recovered, and billed as the earlier process settled it", async () => {
    const m = makeClipMock();
    const jobId = await restartAt(m, "downloading");
    expect(engineSaysOf(m, jobId)).toBe("download");
    m.scheduler.runAll();
    expect(await onlyClip(m)).toMatchObject({ clipId: jobId, status: "ready", recovered: true, cost: { micros: 420_000, kind: "billed" } });
    // Nothing was left open: the earlier process settled the reserve before the download.
    expect(await money(m)).toMatchObject({ reconcileNeeded: false, unsettledMicros: 0, spentMicros: 420_000 });
  });

  test("restarted after the file was fetched and checked (`checking`, `saving`): the kept file is finished from disk, with no `downloading` phase", async () => {
    for (const phase of ["checking", "saving"] as const) {
      const m = makeClipMock();
      const jobId = await restartAt(m, phase);
      expect(m.engine.peekClips().journals[jobId]?.map((l) => l.type)).toContain("downloaded");
      expect(engineSaysOf(m, jobId)).toBe("download");
      const recovery = (await unwrap(m.client.request("engine.snapshot", {}))).jobs.find((j) => j.kind === "clip");
      if (recovery === undefined) throw new Error("no recovery job");
      m.scheduler.runAll();
      expect(phasesOf(m.events, recovery.jobId)).toEqual(["recovering", "checking", "saving"]);
      expect(await onlyClip(m)).toMatchObject({ status: "ready", recovered: true, cost: { micros: 420_000, kind: "billed" } });
    }
  });

  test("the journal of a clip is complete before the file is: `downloading` has no `downloaded` line", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, "downloading", jobId);
    expect(m.engine.peekClips().journals[jobId]?.map((l) => l.type)).toEqual(["requested", "submitted", "ended"]);
  });
});

describe("the second attempt of a clip", () => {
  test("restarted while Grok was being reserved behind a free Kling, with no `submitted` line: `lost`, Grok's reserve open, Kling's settled 0", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip({ first: "refused-submit", then: "ok" });
    const { jobId } = await unwrap(create(m));
    for (let i = 0; i < 400 && progressOf(m.events, jobId).filter((p) => p.phase === "submitting").length < 2; i++) m.scheduler.next();
    m.engine.restart();
    expect(engineSaysOf(m, jobId)).toBe("fail");
    m.scheduler.runAll();
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "lost" }, model: "grok", recovered: true, cost: { micros: 850_000, kind: "open" } });
  });

  test("restarted while Grok rendered behind a free Kling: Grok's job is polled and fetched; the clip says it is Grok's", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip({ first: "refused-free", then: "ok" });
    const { jobId } = await unwrap(create(m));
    for (let i = 0; i < 400 && progressOf(m.events, jobId).filter((p) => p.phase === "rendering").length < 2; i++) m.scheduler.next();
    m.engine.restart();
    expect(engineSaysOf(m, jobId)).toBe("poll");
    m.scheduler.runAll();
    expect(await onlyClip(m)).toMatchObject({ status: "ready", recovered: true, model: "grok", fallback: true, cost: { micros: 850_000, kind: "open" }, providerCostMicros: 710_000 });
  });
});

describe("the rest of a restart", () => {
  test("a record with a stale journal beside it is left alone: no job, and the journal is gone", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    m.scheduler.runAll();
    m.engine.leaveStaleClipJournal(jobId);
    m.engine.restart();
    m.scheduler.runAll();
    expect(m.engine.peekClips().files[jobId]).toEqual({ journal: false, record: true, media: true });
    expect(await listClips(m)).toHaveLength(1);
    expect((await unwrap(m.client.request("engine.snapshot", {}))).jobs.filter((j) => j.kind === "clip")).toEqual([]);
  });

  test("a download retry and an export that were running are gone with the process; their clips are as they were", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("download-failed");
    const { jobId } = await unwrap(create(m));
    m.scheduler.runAll();
    await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId: jobId }));
    m.engine.restart();
    m.scheduler.runAll();
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "download-failed" } });
    expect((await m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId: jobId })).ok).toBe(true);
  });

  test("a recovery job cannot be cancelled: IN_FLIGHT `job-running`, with its own words", async () => {
    const m = makeClipMock();
    await restartAt(m, "rendering");
    const recovery = (await unwrap(m.client.request("engine.snapshot", {}))).jobs.find((j) => j.kind === "clip");
    if (recovery === undefined) throw new Error("no recovery job");
    expect(await refusal(m.client.request("avatars.cancel", { jobId: recovery.jobId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    m.scheduler.runAll();
  });

  test("a delete or a retry of a clip being recovered is IN_FLIGHT `job-running`; once the recovery has ended the clip is an ordinary record", async () => {
    const m = makeClipMock();
    const jobId = await restartAt(m, "rendering");
    expect(await refusal(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    expect(await refusal(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId: jobId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    m.scheduler.runAll();
    expect((await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).clipId).toBe(jobId);
  });
});
