import { describe, expect, test } from "bun:test";
import { JobProgress, JobState, CLIP_JOB_STEPS } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { validJobStates } from "./snapshotJobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.1, I5.50): a clip job in the registry. It starts in `preparing` with the four steps of a clip (video, download, check, save), moves through its
// phases with the model, the submit time and the end of the proof window where they belong, ends with its clip, and makes its avatar busy for a delete but not for the autopilot.

const AVATAR = "avatar-00000001";
const JOB = "job-00000001";
const CLIP = JOB;
const AT = "2026-10-13T12:00:00.000Z";

function valid(states: unknown[]): void {
  for (const state of states) expect(JobState.safeParse(state).success).toBe(true);
}

describe("JobRegistry: clip jobs", () => {
  test("a started clip job is running in `preparing`, nothing done of its four steps", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });

    expect(jobs.states()).toEqual([{ kind: "clip", jobId: JOB, avatarId: AVATAR, clipId: CLIP, phase: "preparing", status: "running", done: 0, total: CLIP_JOB_STEPS }]);
    valid(jobs.states());
  });

  test("a job may start in another phase (a recovery job starts in `recovering`)", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP }, "recovering");

    expect(jobs.stateOf(JOB)).toMatchObject({ kind: "clip", phase: "recovering", status: "running" });
  });

  test("a phase update answers the progress payload, with the model and the submit time in `rendering`", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });

    const progress = jobs.clipPhase(JOB, { phase: "rendering", model: "kling", submittedAt: AT });

    expect(progress).toEqual({ kind: "clip", jobId: JOB, avatarId: AVATAR, clipId: CLIP, done: 0, total: CLIP_JOB_STEPS, phase: "rendering", model: "kling", submittedAt: AT });
    expect(JobProgress.safeParse(progress).success).toBe(true);
    expect(jobs.stateOf(JOB)).toMatchObject({ phase: "rendering", model: "kling", submittedAt: AT });
  });

  test("the end of the proof window is cleared when the phase leaves `proving`, so the state and the event stay valid", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });
    jobs.clipPhase(JOB, { phase: "proving", model: "kling", proveUntil: AT });
    expect(jobs.stateOf(JOB)).toMatchObject({ phase: "proving", proveUntil: AT });

    const next = jobs.clipPhase(JOB, { phase: "submitting", model: "grok" });

    expect(next).not.toHaveProperty("proveUntil");
    expect(JobProgress.safeParse(next).success).toBe(true);
    expect(jobs.stateOf(JOB)).not.toHaveProperty("proveUntil");
    valid(jobs.states());
  });

  test("a proof window handed to a phase that is not `proving` is never kept", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });

    const progress = jobs.clipPhase(JOB, { phase: "downloading", proveUntil: AT });

    expect(progress).not.toHaveProperty("proveUntil");
    valid(jobs.states());
  });

  test("a snapshot keeps the paid job after it left `proving` (validJobStates drops nothing)", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });
    jobs.clipPhase(JOB, { phase: "proving", model: "kling", proveUntil: AT });
    jobs.clipPhase(JOB, { phase: "rendering", model: "grok", submittedAt: AT });

    const logged: string[] = [];
    expect(validJobStates(jobs.states(), (line) => logged.push(line))).toHaveLength(1);
    expect(logged).toEqual([]);
  });

  test("`done` counts the steps reached, never goes back and never passes the total", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });

    expect(jobs.clipPhase(JOB, { phase: "downloading", done: 1 })).toMatchObject({ done: 1 });
    expect(jobs.clipPhase(JOB, { phase: "checking", done: 2 })).toMatchObject({ done: 2 });
    expect(jobs.clipPhase(JOB, { phase: "saving", done: 1 })).toMatchObject({ done: 2 });
    expect(jobs.clipPhase(JOB, { phase: "saving", done: 99 })).toMatchObject({ done: CLIP_JOB_STEPS });
  });

  test("a phase update for a job that is not a running clip changes nothing and answers null", () => {
    const jobs = new JobRegistry();
    jobs.startScenes("job-scenes", { sceneSetId: "set-00000001", avatarId: AVATAR, total: 3 });
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });
    jobs.finishClip(JOB, { status: "cancelled" });

    expect(jobs.clipPhase("job-scenes", { phase: "rendering" })).toBeNull();
    expect(jobs.clipPhase(JOB, { phase: "rendering" })).toBeNull();
    expect(jobs.clipPhase("job-unknown", { phase: "rendering" })).toBeNull();
  });

  test("a done clip job carries its clip and its avatar, at the full count", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });
    jobs.clipPhase(JOB, { phase: "saving", done: 3 });

    const state = jobs.finishClip(JOB, { status: "done" });

    expect(state).toMatchObject({ kind: "clip", status: "done", done: CLIP_JOB_STEPS, total: CLIP_JOB_STEPS, result: { kind: "clip", avatarId: AVATAR, clipId: CLIP } });
    valid(jobs.states());
  });

  test("a failed clip job carries its error; a cancelled one nothing more", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });
    jobs.startClip("job-00000002", { avatarId: AVATAR, clipId: "job-00000002" });

    expect(jobs.finishClip(JOB, { status: "failed", error: { code: "BUDGET_EXCEEDED", detail: "no room" } })).toMatchObject({ status: "failed", error: { code: "BUDGET_EXCEEDED" } });
    expect(jobs.finishClip("job-00000002", { status: "cancelled" })).toMatchObject({ status: "cancelled" });
    valid(jobs.states());
  });

  test("a clip job that ended stays as it ended: a second end answers null", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });
    jobs.finishClip(JOB, { status: "done" });

    expect(jobs.finishClip(JOB, { status: "cancelled" })).toBeNull();
    expect(jobs.stateOf(JOB)).toMatchObject({ status: "done" });
  });

  test("a live clip makes its avatar busy for a delete, and not for the autopilot's question", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });

    expect(jobs.hasLiveJobFor(AVATAR)).toBe(true);
    expect(jobs.hasLiveJobFor(AVATAR, { clips: false })).toBe(false);
  });

  test("any other live job still makes the avatar busy for the autopilot", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });
    jobs.startScenes("job-scenes", { sceneSetId: "set-00000001", avatarId: AVATAR, total: 3 });

    expect(jobs.hasLiveJobFor(AVATAR, { clips: false })).toBe(true);
  });

  test("a clip job that ended no longer makes its avatar busy", () => {
    const jobs = new JobRegistry();
    jobs.startClip(JOB, { avatarId: AVATAR, clipId: CLIP });
    jobs.finishClip(JOB, { status: "done" });

    expect(jobs.hasLiveJobFor(AVATAR)).toBe(false);
  });
});
