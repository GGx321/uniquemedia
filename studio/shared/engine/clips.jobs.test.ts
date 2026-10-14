import { describe, expect, test } from "bun:test";
import { CLIP_PHASES } from "./clips";
import { PROTOCOL_VERSION } from "./envelope";
import { EventMessage } from "./events";
import { JobCancelled, JobFailed, JobKind, JobProgress, JobResult, JobState } from "./state";

// Stage 5, 5b.1, S5.V1 (plan s5b1 §5.1, §5.2, §8): the job kind `clip`. A clip job carries a phase; `done / total` count the steps of a clip (video, download, check, save)
// and, for an export, the frames. The result belongs to the job through the same refine as the other kinds, with its own case BEFORE the render fall-through.

const AVATAR = "avatar-aaaa-0001";
const JOB = "job-00000001";
const CLIP = "clip-0000001";
const BOOT = "boot-00000001";

const ref = { kind: "clip", jobId: JOB, avatarId: AVATAR, clipId: CLIP };
const progress = (over: Record<string, unknown> = {}) => ({ ...ref, done: 1, total: 4, phase: "rendering", ...over });
const result = (over: Record<string, unknown> = {}) => ({ kind: "clip", avatarId: AVATAR, clipId: CLIP, ...over });
const state = (over: Record<string, unknown> = {}) => ({ kind: "clip", jobId: JOB, avatarId: AVATAR, clipId: CLIP, status: "running", done: 1, total: 4, phase: "rendering", ...over });
const event = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: BOOT, type, payload });
const error = { code: "INTERNAL", detail: "x" };

describe("JobKind", () => {
  test("gains `clip` and keeps the six it had", () => {
    expect([...JobKind.options].sort()).toEqual(["avatar.candidates", "avatar.portraits", "clip", "import", "render", "run", "scenes"]);
  });
});

describe("the phases of a clip job", () => {
  test("are `queued` (5b.2), the §5.1 ladder plus late, recovering and exporting", () => {
    expect([...CLIP_PHASES]).toEqual(["queued", "preparing", "submitting", "rendering", "proving", "downloading", "checking", "saving", "late", "recovering", "exporting"]);
  });
});

describe("JobProgress for a clip", () => {
  test("parses in every phase", () => {
    for (const phase of CLIP_PHASES) expect(JobProgress.safeParse(progress({ phase })).success).toBe(true);
  });

  test("done may equal total but not exceed it", () => {
    expect(JobProgress.safeParse(progress({ done: 4, total: 4 })).success).toBe(true);
    expect(JobProgress.safeParse(progress({ done: 5, total: 4 })).success).toBe(false);
  });

  test("an export counts frames: done and total may be large", () => {
    expect(JobProgress.safeParse(progress({ phase: "exporting", done: 120, total: 300 })).success).toBe(true);
  });

  test("a phase is required and must be known", () => {
    const { phase: _phase, ...noPhase } = progress();
    expect(JobProgress.safeParse(noPhase).success).toBe(false);
    expect(JobProgress.safeParse(progress({ phase: "still" })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ phase: "enhancing" })).success).toBe(false);
  });

  test("the clip and the avatar are named", () => {
    const { clipId: _clipId, ...noClip } = progress();
    const { avatarId: _avatarId, ...noAvatar } = progress();
    expect(JobProgress.safeParse(noClip).success).toBe(false);
    expect(JobProgress.safeParse(noAvatar).success).toBe(false);
  });

  test("the rendering phase carries the model and the submit time", () => {
    expect(JobProgress.safeParse(progress({ model: "kling", submittedAt: "2026-10-13T10:00:00.000Z" })).success).toBe(true);
    expect(JobProgress.safeParse(progress({ model: "grok" })).success).toBe(true);
    expect(JobProgress.safeParse(progress({ model: "seedance" })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ submittedAt: "yesterday" })).success).toBe(false);
  });

  test("the proof window ends at a time, and only the proving phase has one", () => {
    expect(JobProgress.safeParse(progress({ phase: "proving", proveUntil: "2026-10-13T10:02:00.000Z" })).success).toBe(true);
    expect(JobProgress.safeParse(progress({ phase: "rendering", proveUntil: "2026-10-13T10:02:00.000Z" })).success).toBe(false);
  });

  test("a key the contract does not know is refused", () => {
    expect(JobProgress.safeParse(progress({ saving: true })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ queued: true })).success).toBe(false);
  });

  test("the other kinds parse as before and a clip's phase is not accepted on them", () => {
    expect(JobProgress.safeParse({ kind: "avatar.candidates", jobId: JOB, avatarId: AVATAR, done: 1, total: 4 }).success).toBe(true);
    expect(JobProgress.safeParse({ kind: "avatar.candidates", jobId: JOB, avatarId: AVATAR, done: 1, total: 4, phase: "rendering" }).success).toBe(false);
    expect(JobProgress.safeParse({ kind: "render", jobId: JOB, videoId: "video-00000001", avatarId: AVATAR, montageId: null, done: 1, total: 4 }).success).toBe(true);
  });
});

describe("JobFailed and JobCancelled for a clip", () => {
  test("a failed clip carries its identity and the error", () => {
    expect(JobFailed.safeParse({ ...ref, error }).success).toBe(true);
    expect(JobFailed.safeParse({ ...ref }).success).toBe(false);
    expect(JobFailed.safeParse({ ...ref, error, phase: "saving" }).success).toBe(false);
  });

  test("a failed clip carries a clip reason through its error", () => {
    expect(JobFailed.safeParse({ ...ref, error: { code: "IN_FLIGHT", clipReason: "submitted" } }).success).toBe(true);
  });

  test("a cancelled clip carries its identity and nothing else", () => {
    expect(JobCancelled.safeParse(ref).success).toBe(true);
    expect(JobCancelled.safeParse({ ...ref, phase: "preparing" }).success).toBe(false);
    const { clipId: _clipId, ...noClip } = ref;
    expect(JobCancelled.safeParse(noClip).success).toBe(false);
  });
});

describe("JobResult for a clip", () => {
  test("a clip result names its avatar and its clip", () => {
    expect(JobResult.safeParse(result()).success).toBe(true);
    const { clipId: _clipId, ...noClip } = result();
    expect(JobResult.safeParse(noClip).success).toBe(false);
  });

  test("an export result names where the copy went, as a render's relative path", () => {
    expect(JobResult.safeParse(result({ exported: { relPath: "Nini/2026-10-13_clip_001.mp4" } })).success).toBe(true);
    expect(JobResult.safeParse(result({ exported: { relPath: "/Users/alex/Nini/x.mp4" } })).success).toBe(false);
    expect(JobResult.safeParse(result({ exported: { relPath: "Nini/2026-10-13_clip_001.mp4", extra: 1 } })).success).toBe(false);
  });

  test("a key the contract does not know is refused", () => {
    expect(JobResult.safeParse(result({ bytes: 1 })).success).toBe(false);
  });
});

describe("JobState for a clip", () => {
  test("a running clip passes the refine in each phase with done within total", () => {
    for (const phase of CLIP_PHASES) expect(JobState.safeParse(state({ phase })).success).toBe(true);
  });

  test("done past total is refused", () => {
    expect(JobState.safeParse(state({ done: 5, total: 4 })).success).toBe(false);
  });

  test("a done clip carries a result that belongs to it", () => {
    expect(JobState.safeParse(state({ status: "done", done: 4, result: result() })).success).toBe(true);
  });

  test("a clip state never reaches the render fall-through: its own result is accepted, which the render case could not do", () => {
    // Without the clip case the refine falls to `result.kind === "render" && …` and refuses a good clip result.
    const parsed = JobState.safeParse(state({ status: "done", done: 4, result: result({ exported: { relPath: "Nini/2026-10-13_clip_001.mp4" } }) }));
    expect(parsed.success).toBe(true);
  });

  test("a result of another clip or another avatar is refused", () => {
    expect(JobState.safeParse(state({ status: "done", done: 4, result: result({ clipId: "clip-0000002" }) })).success).toBe(false);
    expect(JobState.safeParse(state({ status: "done", done: 4, result: result({ avatarId: "avatar-aaaa-0002" }) })).success).toBe(false);
  });

  test("a clip result on another kind of job is refused", () => {
    const render = { kind: "render", jobId: JOB, videoId: "video-00000001", avatarId: AVATAR, montageId: null, status: "done", done: 1, total: 1 };
    expect(JobState.safeParse({ ...render, result: result() }).success).toBe(false);
    const run = { kind: "run", jobId: JOB, runId: "run-00000001", avatarId: AVATAR, status: "done", done: 1, total: 1 };
    expect(JobState.safeParse({ ...run, result: result() }).success).toBe(false);
  });

  test("another kind's result on a clip job is refused", () => {
    const render = { kind: "render", videoId: "video-00000001", avatarId: AVATAR, bytes: 1, durationMs: 1000, videoKind: "photo", relPath: "Nini/2026-10-13_photo_001.mp4" };
    expect(JobState.safeParse(state({ status: "done", done: 4, result: render })).success).toBe(false);
  });

  test("a result belongs to a done job only, an error to a failed one only", () => {
    expect(JobState.safeParse(state({ result: result() })).success).toBe(false);
    expect(JobState.safeParse(state({ status: "done", done: 4 })).success).toBe(false);
    expect(JobState.safeParse(state({ status: "failed", error })).success).toBe(true);
    expect(JobState.safeParse(state({ status: "failed" })).success).toBe(false);
    expect(JobState.safeParse(state({ error })).success).toBe(false);
  });

  test("a queued or cancelled clip parses", () => {
    expect(JobState.safeParse(state({ status: "queued", done: 0 })).success).toBe(true);
    expect(JobState.safeParse(state({ status: "cancelled" })).success).toBe(true);
  });

  test("a phase is required", () => {
    const { phase: _phase, ...noPhase } = state();
    expect(JobState.safeParse(noPhase).success).toBe(false);
  });

  test("the proof window ends at a time, and only the proving phase has one", () => {
    expect(JobState.safeParse(state({ phase: "proving", proveUntil: "2026-10-13T10:02:00.000Z" })).success).toBe(true);
    expect(JobState.safeParse(state({ proveUntil: "2026-10-13T10:02:00.000Z" })).success).toBe(false);
  });

  test("the model and submit time ride along", () => {
    expect(JobState.safeParse(state({ model: "kling", submittedAt: "2026-10-13T10:00:00.000Z" })).success).toBe(true);
  });

  test("the old kinds are untouched", () => {
    const candidates = { kind: "avatar.candidates", jobId: JOB, avatarId: AVATAR, status: "running", done: 1, total: 4 };
    expect(JobState.parse(candidates)).toEqual(candidates as never);
    const render = { kind: "render", jobId: JOB, videoId: "video-00000001", avatarId: AVATAR, montageId: null, status: "running", done: 1, total: 4, saving: true };
    expect(JobState.parse(render)).toEqual(render as never);
  });
});

describe("the job events carry a clip", () => {
  test("job.progress, job.failed and job.cancelled", () => {
    expect(EventMessage.safeParse(event("job.progress", progress())).success).toBe(true);
    expect(EventMessage.safeParse(event("job.failed", { ...ref, error })).success).toBe(true);
    expect(EventMessage.safeParse(event("job.cancelled", ref)).success).toBe(true);
  });

  test("job.done carries a clip result", () => {
    expect(EventMessage.safeParse(event("job.done", { jobId: JOB, result: result() })).success).toBe(true);
  });

  test("an old job.progress parses as before", () => {
    expect(EventMessage.safeParse(event("job.progress", { kind: "run", jobId: JOB, runId: "run-00000001", avatarId: AVATAR, done: 1, total: 5 })).success).toBe(true);
  });
});

// Stage 5, 5b.1, S5.V8b (additive, protocol 5): a clip create job carries the facts its tile shows, so a window that first sees the job (a new window after a restart, a reload mid-render) draws it whole.
describe("the facts a clip job carries", () => {
  const facts = {
    photoId: "photo-aaaa-0001",
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    motion: { source: "code", label: "Моргает и улыбается" },
    acceptedWorstMicros: 510_000,
  };

  test("a progress event of an older engine, without the facts, still parses", () => {
    expect(JobProgress.safeParse(progress()).success).toBe(true);
  });

  test("a progress event carries the photo, the request, the motion's label and the accepted worst case", () => {
    const parsed = JobProgress.safeParse(progress({ phase: "recovering", ...facts }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind === "clip" ? parsed.data.acceptedWorstMicros : null).toBe(510_000);
  });

  test("a job state of an older engine, without the facts, still parses", () => {
    expect(JobState.safeParse(state()).success).toBe(true);
  });

  test("a job state in the snapshot carries the same facts", () => {
    expect(JobState.safeParse(state({ phase: "recovering", ...facts })).success).toBe(true);
  });

  test("an event on the wire carries the facts", () => {
    expect(EventMessage.safeParse(event("job.progress", progress({ ...facts }))).success).toBe(true);
  });

  test("the motion carries its source and label, not the English prompt text", () => {
    expect(JobProgress.safeParse(progress({ ...facts, motion: { ...facts.motion, text: "she slowly blinks" } })).success).toBe(false);
  });

  test("a request or an amount the contract does not know is refused", () => {
    expect(JobProgress.safeParse(progress({ ...facts, request: { ...facts.request, seconds: 7 } })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ ...facts, acceptedWorstMicros: -1 })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ ...facts, acceptedWorstMicros: 0.5 })).success).toBe(false);
  });
});

// S5.V8b follow-up: the four create facts come together or not at all; the open reserve is its own fact, told wherever the ledger holds one open.
describe("the facts of a clip job, together and apart", () => {
  const facts = {
    photoId: "photo-aaaa-0001",
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    motion: { source: "code", label: "Моргает и улыбается" },
    acceptedWorstMicros: 850_000,
  };

  test.each(["photoId", "request", "motion", "acceptedWorstMicros"] as const)("a progress event with `%s` missing from the four is refused", (missing) => {
    const { [missing]: _gone, ...rest } = facts;
    expect(JobProgress.safeParse(progress(rest)).success).toBe(false);
  });

  test.each(["photoId", "request", "motion", "acceptedWorstMicros"] as const)("a job state with `%s` missing from the four is refused", (missing) => {
    const { [missing]: _gone, ...rest } = facts;
    expect(JobState.safeParse(state(rest)).success).toBe(false);
  });

  test("all four present, or none, parse", () => {
    expect(JobProgress.safeParse(progress(facts)).success).toBe(true);
    expect(JobProgress.safeParse(progress()).success).toBe(true);
    expect(JobState.safeParse(state(facts)).success).toBe(true);
  });

  test("the open reserve is told alone, with the four or without them", () => {
    expect(JobProgress.safeParse(progress({ openReserveMicros: 504_000 })).success).toBe(true);
    expect(JobProgress.safeParse(progress({ ...facts, openReserveMicros: 504_000 })).success).toBe(true);
    expect(JobState.safeParse(state({ openReserveMicros: 504_000 })).success).toBe(true);
  });

  test("the open reserve is a whole number of micro-dollars, never negative", () => {
    expect(JobProgress.safeParse(progress({ openReserveMicros: -1 })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ openReserveMicros: 0.5 })).success).toBe(false);
  });
});
