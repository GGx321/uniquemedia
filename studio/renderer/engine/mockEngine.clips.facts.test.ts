import { describe, expect, test } from "bun:test";
import { JobProgress } from "../../shared/engine";
import { CLIP_PHOTOS, create, makeClipMock, phasesOf, progressOf, runClip, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V8b: the mock's clip create job carries the facts its tile shows, on the same jobs and at the same moments as the engine's (engine.clips.job.test.ts,
// engine.clips.restart.test.ts): from its first event, in the snapshot, and after `restart()`, where a recovery job takes them from the mock's journal and nothing else.

const FACTS = {
  photoId: CLIP_PHOTOS.plain.photoId,
  request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
  motion: { source: "code", label: "Моргает и улыбается" },
  acceptedWorstMicros: 850_000,
} as const;

function stepUntil(m: ClipMock, phase: string, jobId: string): void {
  for (let i = 0; i < 400 && !phasesOf(m.events, jobId).includes(phase); i++) if (!m.scheduler.next()) break;
  if (!phasesOf(m.events, jobId).includes(phase)) throw new Error(`the clip never reached ${phase}`);
}

describe("a fresh clip create job in the mock", () => {
  test("every event of it carries the photo, the request, the motion's label and the accepted worst case", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);

    const events = progressOf(m.events, jobId);
    expect(events.length).toBeGreaterThan(1);
    for (const event of events) {
      expect(event).toMatchObject(FACTS);
      expect(JobProgress.safeParse(event).success).toBe(true);
    }
  });

  test("the motion's English prompt text never reaches the window", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);

    for (const event of progressOf(m.events, jobId)) expect(event.motion).not.toHaveProperty("text");
  });

  test("the snapshot lists the running job with the same facts, and the finished one keeps them", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    const running = await unwrap(m.client.request("engine.snapshot", {}));
    expect(running.jobs.find((j) => j.jobId === jobId)).toMatchObject({ status: "running", ...FACTS });

    m.scheduler.runAll();
    const ended = await unwrap(m.client.request("engine.snapshot", {}));
    expect(ended.jobs.find((j) => j.jobId === jobId)).toMatchObject({ status: "done", ...FACTS });
  });

  test("a request the sheet narrowed (Grok alone has no fallback) carries the narrowed request, as the engine's job does", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m, { photoId: CLIP_PHOTOS.bold.photoId, fallback: "auto", acceptedWorstMicros: 504_000 }));

    expect(progressOf(m.events, jobId)[0]).toMatchObject({ request: { model: "kling", fallback: "none" } });
  });
});

describe("a clip recovered after the mock's restart", () => {
  test("the recovery job carries the facts of the mock's journal line, not those of anything else", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, "rendering", jobId);
    const requested = (m.engine.peekClips().journals[jobId] ?? []).find((line) => line.type === "requested");
    if (requested === undefined || requested.type !== "requested") throw new Error("the journal has no requested line");

    m.engine.restart();

    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    const recovery = snapshot.jobs.find((j) => j.kind === "clip" && j.clipId === jobId);
    expect(recovery).toMatchObject({ phase: "recovering", status: "running", photoId: requested.photoId, request: requested.request, motion: { source: requested.motion.source, label: requested.motion.label }, acceptedWorstMicros: requested.acceptedWorstMicros });
    expect(recovery).not.toHaveProperty("motion.text");
  });

  test("every event of the recovery job carries them, down to its end", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, "rendering", jobId);
    m.engine.restart();
    m.scheduler.runAll();

    const recovery = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId !== jobId && e.payload.clipId === jobId ? [e.payload] : []));
    expect(recovery.length).toBeGreaterThan(1);
    for (const event of recovery) expect(event).toMatchObject(FACTS);
  });
});

describe("the open reserve of a clip job in the mock", () => {
  test("is told while the clip's reserve is open, as the engine tells it, and not after it settled", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);

    const byPhase = (phase: string) => progressOf(m.events, jobId).filter((p) => p.phase === phase);
    expect(byPhase("preparing")[0]).not.toHaveProperty("openReserveMicros");
    for (const phase of ["submitting", "rendering"]) expect(byPhase(phase)[0]).toMatchObject({ openReserveMicros: 504_000 });
    for (const phase of ["downloading", "checking", "saving"]) expect(byPhase(phase)[0]).not.toHaveProperty("openReserveMicros");
  });

  test("a recovered clip asked for with an automatic fallback tells the Kling reserve still open, in every event and in the snapshot", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    stepUntil(m, "rendering", jobId);
    m.engine.restart();

    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.find((j) => j.kind === "clip" && j.clipId === jobId)).toMatchObject({ phase: "recovering", acceptedWorstMicros: 850_000, openReserveMicros: 504_000 });
    m.scheduler.runAll();
    const recovery = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId !== jobId && e.payload.clipId === jobId ? [e.payload] : []));
    expect(recovery.length).toBeGreaterThan(1);
    for (const event of recovery) expect(event).toMatchObject({ acceptedWorstMicros: 850_000, openReserveMicros: 504_000 });
  });
});
