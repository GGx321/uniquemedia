import { describe, expect, test } from "bun:test";
import { CLIP_JOB_STEPS, JobCancelled, JobProgress, JobState } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { validJobStates } from "./snapshotJobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2 (plan s5b2 I5.61, I5.63, §5.2.2): a batch member in the job registry. It starts in the phase `queued` (memory-only, nothing done, no model), carries the batch trio
// (`batchId`, `batchIndex`, `batchSize`) through every phase and at its end, says what a `queued` or `proving` job waits for (`waitReason`), and a member that never ran ends `cancelled` with why.

const AVATAR = "avatar-00000001";
const JOB = "job-00000001";
const CLIP = JOB;
const BATCH = "batch-00000001";
const AT = "2026-10-15T12:00:00.000Z";
const TRIO = { batchId: BATCH, batchIndex: 3, batchSize: 10 } as const;
const FACTS = {
  photoId: "photo-00000001",
  request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
  motion: { source: "code", label: "Улыбка" },
  acceptedWorstMicros: 850_000,
} as const;

function startMember(jobs: JobRegistry, waitReason: "turn" | "alone" | "rate-limit" = "turn"): AbortSignal {
  return jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP, facts: FACTS, batch: { ...TRIO, waitReason } }, "queued");
}

function valid(states: unknown[]): void {
  for (const state of states) expect(JobState.safeParse(state).success).toBe(true);
}

describe("JobRegistry: a batch member", () => {
  test("starts running in `queued` at zero, with the batch trio and what it waits for", () => {
    const jobs = new JobRegistry();
    startMember(jobs);

    expect(jobs.states()).toEqual([{ kind: "clip", jobId: JOB, avatarId: AVATAR, clipId: CLIP, phase: "queued", status: "running", done: 0, total: CLIP_JOB_STEPS, ...FACTS, ...TRIO, waitReason: "turn" }]);
    valid(jobs.states());
  });

  test("keeps the trio when it moves to `preparing`, and drops the wait reason with it", () => {
    const jobs = new JobRegistry();
    startMember(jobs);

    const progress = jobs.clipPhase(JOB, { phase: "preparing" });

    expect(progress).toMatchObject({ phase: "preparing", ...TRIO });
    expect(progress).not.toHaveProperty("waitReason");
    expect(JobProgress.safeParse(progress).success).toBe(true);
    expect(jobs.stateOf(JOB)).toMatchObject({ phase: "preparing", ...TRIO });
    expect(jobs.stateOf(JOB)).not.toHaveProperty("waitReason");
    valid(jobs.states());
  });

  test("a queued update tells the new wait reason and stays at zero with no model", () => {
    const jobs = new JobRegistry();
    startMember(jobs);

    const progress = jobs.clipPhase(JOB, { phase: "queued", waitReason: "alone", model: "kling", submittedAt: AT, openReserveMicros: 5 });

    expect(progress).toMatchObject({ phase: "queued", waitReason: "alone", done: 0, ...TRIO });
    expect(progress).not.toHaveProperty("model");
    expect(progress).not.toHaveProperty("submittedAt");
    expect(progress).not.toHaveProperty("openReserveMicros");
    expect(JobProgress.safeParse(progress).success).toBe(true);
    valid(jobs.states());
  });

  test("the strict proof's wait reason is kept in `proving` and cleared when the phase leaves it", () => {
    const jobs = new JobRegistry();
    startMember(jobs);
    jobs.clipPhase(JOB, { phase: "proving", model: "kling", proveUntil: AT, waitReason: "proof" });
    expect(jobs.stateOf(JOB)).toMatchObject({ phase: "proving", waitReason: "proof" });

    const next = jobs.clipPhase(JOB, { phase: "submitting", model: "grok" });

    expect(next).not.toHaveProperty("waitReason");
    expect(jobs.stateOf(JOB)).not.toHaveProperty("waitReason");
    valid(jobs.states());
  });

  test("a wait reason handed to a phase that is neither `queued` nor `proving` is never kept", () => {
    const jobs = new JobRegistry();
    startMember(jobs);

    const progress = jobs.clipPhase(JOB, { phase: "downloading", waitReason: "alone" });

    expect(progress).not.toHaveProperty("waitReason");
    valid(jobs.states());
  });

  test("`jobs.progress` repeats the trio and the wait reason of a member", () => {
    const jobs = new JobRegistry();
    startMember(jobs, "rate-limit");

    const progress = jobs.progress(JOB, 0);

    expect(progress).toMatchObject({ kind: "clip", phase: "queued", waitReason: "rate-limit", ...TRIO });
    expect(JobProgress.safeParse(progress).success).toBe(true);
  });

  test("a member that never ran ends cancelled with its reason, and keeps the trio", () => {
    const jobs = new JobRegistry();
    startMember(jobs);

    const state = jobs.finishClip(JOB, { status: "cancelled", detail: "price-changed" });

    expect(state).toMatchObject({ status: "cancelled", detail: "price-changed", phase: "queued", ...TRIO });
    expect(state).not.toHaveProperty("waitReason");
    expect(JobState.safeParse(state).success).toBe(true);
  });

  test("a cancelled member's reason is one of the contract's, so the end event parses", () => {
    const jobs = new JobRegistry();
    startMember(jobs);
    jobs.finishClip(JOB, { status: "cancelled", detail: "photo-unreadable" });

    const payload = { kind: "clip", jobId: JOB, avatarId: AVATAR, clipId: CLIP, detail: "photo-unreadable" };
    expect(JobCancelled.safeParse(payload).success).toBe(true);
    expect(jobs.stateOf(JOB)).toMatchObject({ detail: "photo-unreadable" });
  });

  test("a cancelled clip with no reason (a single clip, or a cancel before 5b.2) lists none", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });

    const state = jobs.finishClip(JOB, { status: "cancelled" });

    expect(state).not.toHaveProperty("detail");
    expect(state).not.toHaveProperty("batchId");
  });

  test("a done member carries its trio and no reason", () => {
    const jobs = new JobRegistry();
    startMember(jobs);
    jobs.clipPhase(JOB, { phase: "saving", model: "kling" });

    const state = jobs.finishClip(JOB, { status: "done" });

    expect(state).toMatchObject({ status: "done", ...TRIO });
    expect(state).not.toHaveProperty("detail");
    expect(JobState.safeParse(state).success).toBe(true);
  });

  test("a failed member keeps its trio", () => {
    const jobs = new JobRegistry();
    startMember(jobs);

    const state = jobs.finishClip(JOB, { status: "failed", error: { code: "INTERNAL", detail: "x" } });

    expect(state).toMatchObject({ status: "failed", ...TRIO });
    expect(JobState.safeParse(state).success).toBe(true);
  });

  test("a queued member is a live job of its avatar (a delete waits), and not for the autopilot's question", () => {
    const jobs = new JobRegistry();
    startMember(jobs);

    expect(jobs.hasLiveJobFor(AVATAR)).toBe(true);
    expect(jobs.hasLiveJobFor(AVATAR, { clips: false })).toBe(false);
  });

  test("a cancel of a queued member fires its signal", () => {
    const jobs = new JobRegistry();
    const signal = startMember(jobs);

    expect(jobs.cancel(JOB)).toBe(true);

    expect(signal.aborted).toBe(true);
  });

  test("a snapshot keeps a queued member (validJobStates drops nothing)", () => {
    const jobs = new JobRegistry();
    startMember(jobs);

    const logged: string[] = [];
    expect(validJobStates(jobs.states(), (line) => logged.push(line))).toHaveLength(1);
    expect(logged).toEqual([]);
  });
});
