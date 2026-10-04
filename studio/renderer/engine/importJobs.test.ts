import { describe, expect, test } from "bun:test";
import type { EngineError, ImportResult, JobState, MediaSummary } from "../../shared/engine";
import {
  applyCancelAsks,
  applyImportCancelled,
  applyImportDone,
  applyImportFailed,
  applyImportProgress,
  failActiveImports,
  importPercent,
  importsFromSnapshot,
  isActiveImport,
  markImportCancelling,
  MAX_FINISHED_IMPORTS,
  unmarkImportCancelling,
  type ImportProgress,
  type ImportView,
} from "./importJobs";

// 3f.6: the window's view of own-media imports, as pure data (the «Мои» tab's tiles and its status card read it; the store keeps it
// from the snapshot and the `job.*` events). An import is no avatar's job, so it is kept apart from `jobs`. An import's progress says its
// `stage` (the contract's `ImportStage`: absent is the copy) and, while a video is prepared, what the probe judged (`ImportPrepare`).

const JOB = "job-import-0001";
const OTHER = "job-import-0002";

function progress(patch: Partial<ImportProgress> = {}): ImportProgress {
  return { kind: "import", jobId: JOB, mediaKind: "video", name: "street-walk.mp4", mediaId: null, done: 0, total: 1_000, ...patch };
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

describe("the percent a tile and the card show, across the two stages (round 2, L8: never backwards)", () => {
  test("the copy fills the first part, the prepare the rest; the move from one to the other never goes back", () => {
    const copy = (done: number) => importPercent(only(applyImportProgress([], progress({ done, total: 1_000 }))));
    const prepare = (done: number, total = 100) => importPercent(only(applyImportProgress([], progress({ done, total, stage: "prepare" }))));
    expect([copy(0), copy(500), copy(1_000)]).toEqual([0, 15, 30]);
    expect([prepare(0), prepare(50), prepare(99)]).toEqual([30, 65, 99]);
    const sequence = [copy(0), copy(400), copy(1_000), prepare(0), prepare(10), prepare(90), prepare(99)];
    expect(sequence.every((p, i) => i === 0 || p >= (sequence[i - 1] ?? 0))).toBe(true);
  });

  test("a job without a total yet reads 0; a done one reads 100; a prepare never reads 100 before the end", () => {
    expect(importPercent(only(applyImportProgress([], progress({ done: 0, total: 0 }))))).toBe(0);
    expect(importPercent(only(applyImportProgress([], progress({ done: 0, total: 0, stage: "prepare" }))))).toBe(30);
    expect(importPercent(only(applyImportDone(applyImportProgress([], progress({ done: 3 })), JOB, result("media-0000001"))))).toBe(100);
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

  test("the copy moves on to prepare with what the probe judged; prepare's units replace the bytes", () => {
    const copying = applyImportProgress([], progress({ done: 1_000 }));
    expect(only(copying)).toMatchObject({ stage: "copy", prepare: null });
    const preparing = applyImportProgress(copying, progress({ done: 40, total: 100, stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 } }));
    expect(only(preparing)).toMatchObject({ stage: "prepare", done: 40, total: 100, prepare: { hdrToSdr: true, fromFps: 60 } });
    // A prepare step without what was judged (a photo, a track, the probe not done yet) claims nothing.
    expect(only(applyImportProgress(copying, progress({ done: 1, total: 2, stage: "prepare" }))).prepare).toBe(null);
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

  test("a failure that arrives over an import already done changes nothing (round 1, L2: the record is there)", () => {
    const done = applyImportDone(applyImportProgress([], progress()), JOB, result("media-0000001"));
    expect(applyImportFailed(done, { kind: "import", jobId: JOB, mediaKind: "video", name: "street-walk.mp4", mediaId: null, error: UNSUPPORTED })).toBe(done);
    expect(only(done)).toMatchObject({ status: "done", error: null });
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
  const CANCEL_REF = { kind: "import" as const, jobId: JOB, mediaKind: "video" as const, name: "street-walk.mp4", mediaId: null };

  test("an active import is marked; the mark outlives its end; a done or failed one is not marked", () => {
    const running = applyImportProgress([], progress());
    const marked = markImportCancelling(running, JOB);
    expect(only(marked).cancelRequested).toBe(true);
    expect(markImportCancelling(marked, "job-unknown-01")).toBe(marked);
    expect(markImportCancelling(marked, JOB)).toBe(marked);
    const cancelled = applyImportCancelled(marked, CANCEL_REF);
    expect(only(cancelled)).toMatchObject({ status: "cancelled", cancelRequested: true });
    const done = applyImportDone(running, JOB, result("media-0000001"));
    expect(markImportCancelling(done, JOB)).toBe(done);
    const failed = applyImportFailed(running, { ...CANCEL_REF, error: UNSUPPORTED });
    expect(markImportCancelling(failed, JOB)).toBe(failed);
  });

  test("the race (round 1, L1): the job's cancelled event beats the cancel's answer; the mark still lands on it", () => {
    const cancelledFirst = applyImportCancelled(applyImportProgress([], progress()), CANCEL_REF);
    expect(only(markImportCancelling(cancelledFirst, JOB))).toMatchObject({ status: "cancelled", cancelRequested: true });
  });

  test("a refused cancel takes the mark back: the import goes on and a later engine cancel is told", () => {
    const marked = markImportCancelling(applyImportProgress([], progress()), JOB);
    const unmarked = unmarkImportCancelling(marked, JOB);
    expect(only(unmarked).cancelRequested).toBe(false);
    expect(unmarkImportCancelling(unmarked, JOB)).toBe(unmarked);
  });

  test("the asked cancels are put back on the imports they name (an import first heard of after the ask)", () => {
    const fresh = applyImportCancelled([], CANCEL_REF);
    expect(only(applyCancelAsks(fresh, new Set([JOB]))).cancelRequested).toBe(true);
    expect(applyCancelAsks(fresh, new Set())).toBe(fresh);
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
    const after = importsFromSnapshot([state({ status: "running", done: 250 }), state({ jobId: OTHER, status: "queued" })], new Set());
    expect(after.map((i) => [i.jobId, i.status, i.done])).toEqual([
      [JOB, "running", 250],
      [OTHER, "queued", 0],
    ]);
  });

  test("a job the owner dismissed stays dismissed", () => {
    const after = importsFromSnapshot([state({ status: "failed" }), state({ jobId: OTHER, status: "running" })], new Set([JOB]));
    expect(after.map((i) => i.jobId)).toEqual([OTHER]);
  });

  test("each job's stage and what the probe judged, as the snapshot says them (absent is the copy)", () => {
    const preparing = only(importsFromSnapshot([state({ status: "running", done: 45, total: 100, stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 } })], new Set()));
    expect(preparing).toMatchObject({ stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 }, done: 45 });
    expect(only(importsFromSnapshot([state({ status: "running", done: 10 })], new Set()))).toMatchObject({ stage: "copy", prepare: null });
  });

  test("this window's cancel asks are put on the jobs they name, whatever the snapshot", () => {
    expect(only(importsFromSnapshot([state({ status: "running" })], new Set(), new Set([JOB]))).cancelRequested).toBe(true);
    expect(only(importsFromSnapshot([state({ status: "cancelled" })], new Set(), new Set([JOB]))).cancelRequested).toBe(true);
    expect(only(importsFromSnapshot([state({ status: "running" })], new Set())).cancelRequested).toBe(false);
  });
});

describe("the percent the tile and the card show", () => {
  test("floor of its share of the bar, 0 with no total, 100 once done", () => {
    expect(importPercent(only(applyImportProgress([], progress({ done: 399, total: 1_000 }))))).toBe(11);
    expect(importPercent(only(applyImportProgress([], progress({ done: 0, total: 0 }))))).toBe(0);
    expect(importPercent(only(applyImportDone(applyImportProgress([], progress({ done: 3 })), JOB, result("media-0000001"))))).toBe(100);
  });
});
