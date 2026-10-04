import { describe, expect, test } from "bun:test";
import type { EngineError, ImportResult, JobState, MediaSummary } from "../../shared/engine";
import {
  applyImportCancelled,
  applyImportDone,
  applyImportFailed,
  applyImportProgress,
  failActiveImports,
  importPercent,
  importStageOf,
  importsFromSnapshot,
  isActiveImport,
  markImportCancelling,
  MAX_FINISHED_IMPORTS,
  prepareFactsOf,
  type ImportProgress,
  type ImportView,
} from "./importJobs";

// 3f.6: the window's view of own-media imports, as pure data (the «Мои» tab's tiles and its status card read it; the store keeps it
// from the snapshot and the `job.*` events). An import is no avatar's job, so it is kept apart from `jobs`. The engine branch adds an
// optional `stage` ("copy" | "prepare") to an import's progress and, while preparing a video, `prepare: {hdrToSdr, fromFps}`: both are
// read defensively, so the view works whether the contract carries them or not.

const JOB = "job-import-0001";
const OTHER = "job-import-0002";

function progress(patch: Partial<ImportProgress> = {}, extra: Record<string, unknown> = {}): ImportProgress {
  // The engine branch's fields ride beside the contract's: the reader must take them from a plain object.
  const base: ImportProgress = { kind: "import", jobId: JOB, mediaKind: "video", name: "street-walk.mp4", mediaId: null, done: 0, total: 1_000, ...patch };
  return Object.assign(base, extra);
}

function summary(mediaId: string): MediaSummary {
  return { mediaId, kind: "video", name: "street-walk.mp4", bytes: 40_000_000, createdAt: "2026-10-04T10:00:00.000Z", width: 1080, height: 1920, durationMs: 12_000, sourceFps: 60, hdrToSdr: true, loopFrames: null, delayFrames: null };
}

const result = (mediaId: string): ImportResult => ({ kind: "import", mediaId, media: summary(mediaId) });
const UNSUPPORTED: EngineError = { code: "MEDIA_UNSUPPORTED", mediaReason: "codec", detail: "the file was refused: codec" };

function only(imports: readonly ImportView[]): ImportView {
  const [first, ...rest] = imports;
  if (first === undefined || rest.length > 0) throw new Error(`expected one import, got ${imports.length}`);
  return first;
}

describe("the stage and the normalising facts are read defensively (the engine branch's optional fields)", () => {
  test("no stage reads copy; prepare reads prepare; anything else reads copy", () => {
    expect(importStageOf(progress())).toBe("copy");
    expect(importStageOf(progress({}, { stage: "prepare" }))).toBe("prepare");
    expect(importStageOf(progress({}, { stage: "copy" }))).toBe("copy");
    expect(importStageOf(progress({}, { stage: "PREPARE" }))).toBe("copy");
    expect(importStageOf(progress({}, { stage: 1 }))).toBe("copy");
  });

  test("the facts of a video being prepared: HDR → SDR and the source rate, each only when the engine says so", () => {
    expect(prepareFactsOf(progress({}, { stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 } }))).toEqual({ hdrToSdr: true, fromFps: 60 });
    expect(prepareFactsOf(progress({}, { stage: "prepare", prepare: { hdrToSdr: false, fromFps: null } }))).toEqual({ hdrToSdr: false, fromFps: null });
    // No `prepare` at all, or not an object: nothing is claimed.
    expect(prepareFactsOf(progress({}, { stage: "prepare" }))).toBe(null);
    expect(prepareFactsOf(progress({}, { stage: "prepare", prepare: "hdr" }))).toBe(null);
    expect(prepareFactsOf(progress({}, { stage: "prepare", prepare: null }))).toBe(null);
  });

  test("a rate that is not a positive finite number is not a rate; a flag that is not true is false", () => {
    for (const fromFps of [0, -30, Number.NaN, Number.POSITIVE_INFINITY, "60", undefined]) {
      expect(prepareFactsOf(progress({}, { prepare: { hdrToSdr: "yes", fromFps } }))).toEqual({ hdrToSdr: false, fromFps: null });
    }
  });
});

describe("progress: announced, queued, running, the stage", () => {
  test("the first announcement creates the import (queued when the engine says so) in the order heard", () => {
    const queued = applyImportProgress([], progress({ queued: true }));
    expect(only(queued)).toMatchObject({ jobId: JOB, name: "street-walk.mp4", mediaKind: "video", status: "queued", stage: "copy", done: 0, total: 1_000, prepare: null, cancelRequested: false });
    const two = applyImportProgress(queued, progress({ jobId: OTHER, name: "a.jpg", mediaKind: "photo" }));
    expect(two.map((i) => i.jobId)).toEqual([JOB, OTHER]);
    expect(two[1]?.status).toBe("running");
  });

  test("the queued announcement goes to running at the job's turn; a running import is never taken back to queued", () => {
    const running = applyImportProgress(applyImportProgress([], progress({ queued: true })), progress({ done: 400 }));
    expect(only(running)).toMatchObject({ status: "running", done: 400 });
    expect(only(applyImportProgress(running, progress({ queued: true, done: 0 }))).status).toBe("running");
  });

  test("the copy moves on to prepare with its facts; prepare's units replace the bytes", () => {
    const copying = applyImportProgress([], progress({ done: 1_000 }));
    const preparing = applyImportProgress(copying, progress({ done: 40, total: 100 }, { stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 } }));
    expect(only(preparing)).toMatchObject({ stage: "prepare", done: 40, total: 100, prepare: { hdrToSdr: true, fromFps: 60 } });
    // A prepare step without its facts keeps none: nothing is guessed.
    expect(only(applyImportProgress(copying, progress({ done: 1, total: 2 }, { stage: "prepare" }))).prepare).toBe(null);
  });

  test("a late progress never brings a finished import back", () => {
    for (const ended of [
      applyImportDone(applyImportProgress([], progress()), JOB, result("media-0000001")),
      applyImportFailed(applyImportProgress([], progress()), { kind: "import", jobId: JOB, mediaKind: "video", name: "street-walk.mp4", mediaId: null, error: UNSUPPORTED }),
      applyImportCancelled(applyImportProgress([], progress()), { kind: "import", jobId: JOB, mediaKind: "video", name: "street-walk.mp4", mediaId: null }),
    ]) {
      expect(applyImportProgress(ended, progress({ done: 500 }))).toBe(ended);
    }
  });
});

describe("the end: done, failed, cancelled", () => {
  test("done: the record's id, the whole bar; a done first heard of here is made from its record", () => {
    const done = applyImportDone(applyImportProgress([], progress({ done: 300 })), JOB, result("media-0000001"));
    expect(only(done)).toMatchObject({ status: "done", mediaId: "media-0000001", done: 1_000, total: 1_000 });
    const unseen = applyImportDone([], OTHER, result("media-0000002"));
    expect(only(unseen)).toMatchObject({ jobId: OTHER, status: "done", name: "street-walk.mp4", mediaKind: "video", mediaId: "media-0000002" });
  });

  test("failed keeps the engine's error (its media reason); cancelled ends an active import only", () => {
    const failed = applyImportFailed(applyImportProgress([], progress()), { kind: "import", jobId: JOB, mediaKind: "video", name: "street-walk.mp4", mediaId: null, error: UNSUPPORTED });
    expect(only(failed)).toMatchObject({ status: "failed", error: UNSUPPORTED, cancelRequested: false });
    const cancelRef = { kind: "import" as const, jobId: JOB, mediaKind: "video" as const, name: "street-walk.mp4", mediaId: null };
    expect(only(applyImportCancelled(applyImportProgress([], progress()), cancelRef)).status).toBe("cancelled");
    expect(applyImportCancelled(failed, cancelRef)).toBe(failed);
  });

  test("a failure or a cancel first heard of here is still shown, by the identity its event carries", () => {
    const failed = applyImportFailed([], { kind: "import", jobId: JOB, mediaKind: "audio", name: "track.wma", mediaId: null, error: UNSUPPORTED });
    expect(only(failed)).toMatchObject({ name: "track.wma", mediaKind: "audio", status: "failed" });
  });

  test("the engine gone for good fails every import still active, with its reason; the finished stay as they ended", () => {
    const gone: EngineError = { code: "INTERNAL", detail: "gone" };
    const done = applyImportDone(applyImportProgress([], progress()), JOB, result("media-0000001"));
    const both = applyImportProgress(done, progress({ jobId: OTHER }));
    const after = failActiveImports(both, gone);
    expect(after.map((i) => [i.jobId, i.status])).toEqual([
      [JOB, "done"],
      [OTHER, "failed"],
    ]);
    expect(after[1]?.error).toEqual(gone);
    expect(failActiveImports(done, gone)).toBe(done);
  });

  test("finished imports are kept to the newest MAX_FINISHED_IMPORTS; active ones are never dropped", () => {
    let imports: readonly ImportView[] = applyImportProgress([], progress({ jobId: "job-import-active" }));
    for (let i = 0; i < MAX_FINISHED_IMPORTS + 5; i++) {
      const jobId = `job-import-${String(i).padStart(4, "0")}`;
      imports = applyImportDone(applyImportProgress(imports, progress({ jobId })), jobId, result(`media-${String(i).padStart(7, "0")}`));
    }
    expect(imports.filter((i) => !isActiveImport(i))).toHaveLength(MAX_FINISHED_IMPORTS);
    expect(imports[0]?.jobId).toBe("job-import-active");
    expect(imports.some((i) => i.jobId === "job-import-0000")).toBe(false);
    expect(imports.at(-1)?.jobId).toBe(`job-import-${String(MAX_FINISHED_IMPORTS + 4).padStart(4, "0")}`);
  });
});

describe("a cancel this window asked for: marked, and the mark stays with the end (so the tab tells the owner's cancel from the engine's)", () => {
  test("only an active import is marked; the mark outlives its end", () => {
    const running = applyImportProgress([], progress());
    const marked = markImportCancelling(running, JOB);
    expect(only(marked).cancelRequested).toBe(true);
    expect(markImportCancelling(marked, "job-unknown-01")).toBe(marked);
    expect(markImportCancelling(marked, JOB)).toBe(marked);
    const cancelled = applyImportCancelled(marked, { kind: "import", jobId: JOB, mediaKind: "video", name: "street-walk.mp4", mediaId: null });
    expect(only(cancelled)).toMatchObject({ status: "cancelled", cancelRequested: true });
    const done = applyImportDone(running, JOB, result("media-0000001"));
    expect(markImportCancelling(done, JOB)).toBe(done);
  });

  test("a cancel the engine made on its own (the window closed elsewhere, its time ran out) is not this window's", () => {
    const cancelled = applyImportCancelled(applyImportProgress([], progress()), { kind: "import", jobId: JOB, mediaKind: "video", name: "street-walk.mp4", mediaId: null });
    expect(only(cancelled)).toMatchObject({ status: "cancelled", cancelRequested: false });
  });
});

describe("a snapshot: the engine's list of import jobs replaces the view", () => {
  const state = (patch: Partial<Extract<JobState, { kind: "import" }>> & Pick<Extract<JobState, { kind: "import" }>, "status">): Extract<JobState, { kind: "import" }> => {
    const base = { kind: "import" as const, jobId: JOB, mediaKind: "video" as const, name: "street-walk.mp4", mediaId: null, done: 0, total: 1_000 };
    if (patch.status === "done") return { ...base, ...patch, status: "done", mediaId: "media-0000001", result: result("media-0000001") };
    if (patch.status === "failed") return { ...base, ...patch, status: "failed", error: UNSUPPORTED };
    return { ...base, ...patch, status: patch.status };
  };

  test("each job as the engine holds it, in its order; one gone from the snapshot is gone from the view", () => {
    const before = applyImportProgress([], progress({ jobId: "job-import-gone" }));
    const after = importsFromSnapshot(before, [state({ status: "running", done: 250 }), state({ jobId: OTHER, status: "queued" })], new Set());
    expect(after.map((i) => [i.jobId, i.status, i.done])).toEqual([
      [JOB, "running", 250],
      [OTHER, "queued", 0],
    ]);
  });

  test("a job the owner dismissed stays dismissed", () => {
    const after = importsFromSnapshot([], [state({ status: "failed" }), state({ jobId: OTHER, status: "running" })], new Set([JOB]));
    expect(after.map((i) => i.jobId)).toEqual([OTHER]);
  });

  test("a snapshot that does not say the stage keeps a running prepare as it was (its facts too), and this window's cancel mark", () => {
    const preparing = markImportCancelling(applyImportProgress([], progress({ done: 40, total: 100 }, { stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 } })), JOB);
    const after = only(importsFromSnapshot(preparing, [state({ status: "running", done: 45, total: 100 })], new Set()));
    expect(after).toMatchObject({ stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 }, done: 45, cancelRequested: true });
    expect(only(importsFromSnapshot(preparing, [state({ status: "cancelled" })], new Set())).cancelRequested).toBe(true);
    // One that does say it is taken at its word.
    const said = Object.assign(state({ status: "running", done: 10, total: 1_000 }), { stage: "copy" });
    expect(only(importsFromSnapshot(preparing, [said], new Set())).stage).toBe("copy");
  });
});

describe("the percent the tile and the card show", () => {
  test("floor of done over total, 0 with no total, 100 once done", () => {
    expect(importPercent(only(applyImportProgress([], progress({ done: 399, total: 1_000 }))))).toBe(39);
    expect(importPercent(only(applyImportProgress([], progress({ done: 0, total: 0 }))))).toBe(0);
    expect(importPercent(only(applyImportDone(applyImportProgress([], progress({ done: 3 })), JOB, result("media-0000001"))))).toBe(100);
  });
});
