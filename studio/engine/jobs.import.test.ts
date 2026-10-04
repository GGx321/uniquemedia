import { describe, expect, test } from "bun:test";
import { JobProgress, JobState, type ImportResult } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The import jobs of JobRegistry (3f.1b, K29): running from the moment the file is opened, `done` and `total` count bytes copied,
// and the job ends done (with its record), failed (MEDIA_UNSUPPORTED) or cancelled.

const MEDIA = { mediaKind: "photo", name: "summer.jpg" } as const;
const RESULT: ImportResult = {
  kind: "import",
  mediaId: "media-00000001",
  media: {
    mediaId: "media-00000001",
    kind: "photo",
    name: "summer.jpg",
    bytes: 1000,
    createdAt: "2026-10-04T10:00:00.000Z",
    width: 100,
    height: 200,
    durationMs: null,
    sourceFps: null,
    hdrToSdr: false,
    loopFrames: null,
    delayFrames: null,
  },
};

function valid(states: unknown[]): void {
  for (const state of states) expect(JobState.safeParse(state).success).toBe(true);
}

describe("JobRegistry, import jobs", () => {
  test("a started import is running at zero of the file's size, with no media id yet, and its state fits the contract", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000);

    expect(jobs.states()).toEqual([{ kind: "import", jobId: "job-00000001", ...MEDIA, mediaId: null, status: "running", done: 0, total: 1000 }]);
    valid(jobs.states());
  });

  test("progress counts bytes, never goes back and never passes the size", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000);

    expect(jobs.progress("job-00000001", 400)).toEqual({ kind: "import", jobId: "job-00000001", ...MEDIA, mediaId: null, done: 400, total: 1000 });
    expect(jobs.progress("job-00000001", 100)).toMatchObject({ done: 400 });
    expect(jobs.progress("job-00000001", 5000)).toMatchObject({ done: 1000 });
    expect(JobProgress.safeParse(jobs.progress("job-00000001", 1000)).success).toBe(true);
  });

  test("a progress of a job that is not running is nothing", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000);
    jobs.finishImport("job-00000001", { status: "cancelled" });
    expect(jobs.progress("job-00000001", 10)).toBeNull();
  });

  test("a done import carries its record, its media id, and a full count", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000);
    jobs.progress("job-00000001", 300);

    const state = jobs.finishImport("job-00000001", { status: "done", result: RESULT });
    expect(state).toEqual({ kind: "import", jobId: "job-00000001", ...MEDIA, mediaId: "media-00000001", status: "done", done: 1000, total: 1000, result: RESULT });
    valid(jobs.states());
  });

  test("a failed import keeps its error and no media id", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000);
    jobs.progress("job-00000001", 300);

    const state = jobs.finishImport("job-00000001", { status: "failed", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" } });
    expect(state).toMatchObject({ status: "failed", mediaId: null, done: 300, error: { code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" } });
    valid(jobs.states());
  });

  test("a cancelled import keeps how far it got", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000);
    jobs.progress("job-00000001", 300);

    expect(jobs.finishImport("job-00000001", { status: "cancelled" })).toMatchObject({ status: "cancelled", mediaId: null, done: 300 });
    valid(jobs.states());
  });

  test("an import ends once: a second end changes nothing and answers null", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000);
    jobs.finishImport("job-00000001", { status: "cancelled" });

    expect(jobs.finishImport("job-00000001", { status: "done", result: RESULT })).toBeNull();
    expect(jobs.stateOf("job-00000001")).toMatchObject({ status: "cancelled" });
  });

  test("another kind of job is not finished as an import, and an import is not finished as theirs", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000002", "avatar-00000001", 4);
    jobs.startImport("job-00000001", MEDIA, 1000);

    expect(jobs.finishImport("job-00000002", { status: "cancelled" })).toBeNull();
    expect(jobs.finish("job-00000001", { status: "cancelled" })).toBeNull();
    expect(jobs.finishRun("job-00000001", { status: "cancelled" })).toBeNull();
    expect(jobs.stateOf("job-00000001")).toMatchObject({ status: "running" });
  });

  test("cancel fires the import's signal; the job ends when its owner sees it", () => {
    const jobs = new JobRegistry();
    const signal = jobs.startImport("job-00000001", MEDIA, 1000);

    expect(signal.aborted).toBe(false);
    expect(jobs.cancel("job-00000001")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(jobs.stateOf("job-00000001")).toMatchObject({ status: "running" });
  });

  test("the running imports are counted: a library switch must wait for them", () => {
    const jobs = new JobRegistry();
    expect(jobs.activeImports()).toBe(0);
    jobs.startImport("job-00000001", MEDIA, 1000);
    jobs.startImport("job-00000002", { mediaKind: "video", name: "walk.mov" }, 5000);
    expect(jobs.activeImports()).toBe(2);
    jobs.finishImport("job-00000001", { status: "cancelled" });
    expect(jobs.activeImports()).toBe(1);
    jobs.finishImport("job-00000002", { status: "failed", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "failed" } });
    expect(jobs.activeImports()).toBe(0);
  });

  test("an import id is registered once", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000);
    expect(() => jobs.startImport("job-00000001", MEDIA, 1000)).toThrow();
  });

  test("a size of zero or one that is not a count is refused: an import has bytes", () => {
    const jobs = new JobRegistry();
    expect(() => jobs.startImport("job-00000001", MEDIA, -1)).toThrow();
    expect(() => jobs.startImport("job-00000002", MEDIA, 1.5)).toThrow();
  });

  test("a job that waits for its turn is queued: counted as active, announced queued at zero, and not running until it is told to", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000, { queued: true });

    expect(jobs.stateOf("job-00000001")).toMatchObject({ status: "queued", done: 0, total: 1000, mediaId: null });
    valid(jobs.states());
    expect(jobs.activeImports()).toBe(1);
    expect(jobs.progress("job-00000001", 10)).toBeNull();
    const announced = jobs.announceImport("job-00000001");
    expect(announced).toEqual({ kind: "import", jobId: "job-00000001", ...MEDIA, mediaId: null, done: 0, total: 1000, queued: true });
    expect(JobProgress.safeParse(announced).success).toBe(true);
  });

  test("its turn comes: it runs, is announced again at zero without the queued flag, and only a queued job can be started", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 1000, { queued: true });
    expect(jobs.startImportRunning("job-00000001")).toBe(true);
    expect(jobs.stateOf("job-00000001")).toMatchObject({ status: "running" });
    expect(jobs.announceImport("job-00000001")).toEqual({ kind: "import", jobId: "job-00000001", ...MEDIA, mediaId: null, done: 0, total: 1000 });
    expect(jobs.startImportRunning("job-00000001")).toBe(false);
    expect(jobs.startImportRunning("job-00000404")).toBe(false);
    expect(jobs.progress("job-00000001", 10)).toMatchObject({ done: 10 });
  });

  test("a queued job ends cancelled from its queue, and the cancel fires its signal", () => {
    const jobs = new JobRegistry();
    const signal = jobs.startImport("job-00000001", MEDIA, 1000, { queued: true });
    expect(jobs.cancel("job-00000001")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(jobs.finishImport("job-00000001", { status: "cancelled" })).toMatchObject({ status: "cancelled", done: 0 });
    expect(jobs.activeImports()).toBe(0);
  });

  test("announcing a job that is over, or unknown, is nothing", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", MEDIA, 10);
    jobs.finishImport("job-00000001", { status: "cancelled" });
    expect(jobs.announceImport("job-00000001")).toBeNull();
    expect(jobs.announceImport("job-00000404")).toBeNull();
  });
});
