import { describe, expect, test } from "bun:test";
import type { ImportResult, JobState, MediaOrigin, MediaSummary } from "../../../shared/engine";
import { applyImportCancelled, applyImportDone, applyImportFailed, applyImportProgress, type ImportProgress, type ImportView, importsFromSnapshot } from "../../engine/importJobs";
import { type MineLibrary, mineImports, mineLibrary, mineSections } from "./mine";
import { draftSpec } from "./testkit";

// 5b.2 part A (S5.WA4; plan §5.1, I5.59): a clip's montage copy is an own video the engine made, never the owner's file. «Мои» never lists one: not among
// the records, not among the imports on their way (a clip import job carries the clip's `origin` on its ref), not in the counts, the status card or the
// failure cards. The import's view keeps that origin from the job's first event to its end (and from a snapshot), so the «Клипы» tab can draw 57a from it.

const ORIGIN: MediaOrigin = { kind: "clip", avatarId: "avatar-mia-0001", clipId: "clip-0000004", photoId: "photo-mia-0002" };

const video = (mediaId: string, name: string, origin?: MediaOrigin): MediaSummary => ({
  mediaId,
  kind: "video",
  name,
  bytes: 1_000,
  createdAt: "2026-10-04T10:00:00.000Z",
  width: 720,
  height: 1280,
  durationMs: 5_000,
  sourceFps: 24,
  hdrToSdr: false,
  loopFrames: null,
  delayFrames: null,
  ...(origin === undefined ? {} : { origin }),
});

const OWN = video("media-video-0001", "latte-pour.mov");
const COPY = video("media-video-0002", "Клип 2026-10-14 12-00.mp4", ORIGIN);
const LIBRARY: MineLibrary = { media: [COPY, OWN], total: 2 };

const view = (jobId: string, patch: Partial<ImportView> = {}): ImportView => ({
  jobId,
  mediaKind: "video",
  name: "Клип 2026-10-14 12-00.mp4",
  status: "running",
  stage: "copy",
  done: 1,
  total: 10,
  prepare: null,
  mediaId: null,
  error: null,
  cancelRequested: false,
  ...patch,
});

const NO_TARGET = { fillTarget: null, addBlock: null, selectedSticker: null } as const;

describe("«Мои» never lists a clip's copy", () => {
  test("the records: the copy is not a tile, and the section's count leaves it out", () => {
    const sections = mineSections(LIBRARY, [], draftSpec(1), NO_TARGET);
    expect(sections.visual.map((t) => (t.kind === "record" ? t.media.name : t.view.name))).toEqual(["latte-pour.mov"]);
    expect(sections.counts.visual).toBe(1);
  });

  test("the imports on their way: a clip's copy being made is not a tile either", () => {
    const own = view("job-0000001", { name: "street-walk.mp4" });
    const copy = view("job-0000002", { origin: ORIGIN });
    const sections = mineSections({ media: [], total: 0 }, [own, copy], draftSpec(1), NO_TARGET);
    expect(sections.visual.map((t) => (t.kind === "import" ? t.view.jobId : t.media.mediaId))).toEqual(["job-0000001"]);
    expect(sections.counts.visual).toBe(1);
  });

  test("the tab's imports (status card, «ещё N в очереди», failure cards) leave the clip imports out", () => {
    const failed = view("job-0000003", { status: "failed", origin: ORIGIN, error: { code: "INTERNAL", detail: "encode" } });
    expect(mineImports([view("job-0000001"), view("job-0000002", { origin: ORIGIN }), failed]).map((v) => v.jobId)).toEqual(["job-0000001"]);
  });

  test("the library the tab shows and counts («Показаны N новых из M», the empty card) leaves the listed copies out", () => {
    expect(mineLibrary({ media: [COPY, OWN], total: 700 })).toEqual({ media: [OWN], total: 699 });
    expect(mineLibrary({ media: [COPY], total: 1 })).toEqual({ media: [], total: 0 });
    // A library with no copy is the same object.
    const plain: MineLibrary = { media: [OWN], total: 1 };
    expect(mineLibrary(plain)).toBe(plain);
  });
});

describe("a clip import's view keeps its origin", () => {
  const progress = (patch: Partial<ImportProgress> = {}): ImportProgress => ({ kind: "import", jobId: "job-0000002", mediaKind: "video", name: COPY.name, mediaId: null, done: 1, total: 10, origin: ORIGIN, ...patch });

  test("from its first event to its end, done, failed or cancelled", () => {
    const running = applyImportProgress([], progress());
    expect(running[0]?.origin).toEqual(ORIGIN);
    const done: ImportResult = { kind: "import", mediaId: COPY.mediaId, media: COPY };
    expect(applyImportDone(running, "job-0000002", done)[0]?.origin).toEqual(ORIGIN);
    // A job first heard of at its end is made from its record or its ref, origin included.
    expect(applyImportDone([], "job-0000002", done)[0]?.origin).toEqual(ORIGIN);
    expect(applyImportFailed([], { kind: "import", jobId: "job-0000002", mediaKind: "video", name: COPY.name, mediaId: null, origin: ORIGIN, error: { code: "INTERNAL" } })[0]?.origin).toEqual(ORIGIN);
    expect(applyImportCancelled([], { kind: "import", jobId: "job-0000002", mediaKind: "video", name: COPY.name, mediaId: null, origin: ORIGIN })[0]?.origin).toEqual(ORIGIN);
  });

  test("from a snapshot: a window reloaded mid-import still knows whose copy it is", () => {
    const state: Extract<JobState, { kind: "import" }> = { kind: "import", jobId: "job-0000002", mediaKind: "video", name: COPY.name, mediaId: null, origin: ORIGIN, status: "running", done: 1, total: 10 };
    expect(importsFromSnapshot([state], new Set())[0]?.origin).toEqual(ORIGIN);
  });

  test("a view first made without it takes the origin a later event of the job brings, and keeps it (review L7)", () => {
    const first = applyImportProgress([], progress({ origin: undefined }));
    expect(first[0]?.origin).toBeUndefined();
    const later = applyImportProgress(first, progress({ done: 5 }));
    expect(later[0]?.origin).toEqual(ORIGIN);
    // An event without it never takes it away.
    expect(applyImportProgress(later, progress({ done: 6, origin: undefined }))[0]?.origin).toEqual(ORIGIN);
    expect(applyImportFailed(applyImportProgress([], progress({ origin: undefined })), { kind: "import", jobId: "job-0000002", mediaKind: "video", name: COPY.name, mediaId: null, origin: ORIGIN, error: { code: "INTERNAL" } })[0]?.origin).toEqual(ORIGIN);
  });

  test("an own file's import has none", () => {
    expect(applyImportProgress([], progress({ origin: undefined }))[0]?.origin).toBeUndefined();
  });
});
