import { describe, expect, test } from "bun:test";
import { MEDIA_REASONS_BY_KIND_RU, MEDIA_REASONS_RU, mediaReasonRu } from "./errorMessagesRu";
import { fromFpsOf, MediaUnsupportedReason } from "./media";
import { JobCancelled, JobFailed, JobProgress, JobState } from "./state";

// 3f.6 engine prep: the import's progress has a STAGE. `copy` counts bytes (what it always did; absent means copy), `prepare` counts the
// importer's own units and may say what the probe judged (`hdrToSdr`, `fromFps`). And `too-short`, the reason a clip or a track that
// no montage can use is turned away.

const progress = { kind: "import", jobId: "job-00000005", mediaKind: "video", name: "walk.mov", mediaId: null, done: 40, total: 100 };
const state = { ...progress, status: "running" };

describe("an import's progress stage", () => {
  test("a progress with no stage is a copy: an older bundle's message stays valid", () => {
    expect(JobProgress.safeParse(progress).success).toBe(true);
    expect(JobState.safeParse(state).success).toBe(true);
  });

  test("says copy or prepare, and nothing else", () => {
    expect(JobProgress.safeParse({ ...progress, stage: "copy" }).success).toBe(true);
    expect(JobProgress.safeParse({ ...progress, stage: "prepare" }).success).toBe(true);
    expect(JobProgress.safeParse({ ...progress, stage: "encode" }).success).toBe(false);
  });

  test("a prepare says what the probe judged: HDR to SDR and the source rate when it is not 30", () => {
    const prepare = { hdrToSdr: true, fromFps: 60 };
    expect(JobProgress.safeParse({ ...progress, stage: "prepare", prepare }).success).toBe(true);
    expect(JobProgress.safeParse({ ...progress, stage: "prepare", prepare: { hdrToSdr: false, fromFps: null } }).success).toBe(true);
  });

  test("what the probe judged is not a copy's: a copy, or a progress with no stage, carries none", () => {
    const prepare = { hdrToSdr: true, fromFps: 60 };
    expect(JobProgress.safeParse({ ...progress, stage: "copy", prepare }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progress, prepare }).success).toBe(false);
  });

  test("the judged facts are exact: a rate is positive and at most 1000, and nothing else rides along", () => {
    const stage = "prepare";
    expect(JobProgress.safeParse({ ...progress, stage, prepare: { hdrToSdr: true, fromFps: 0 } }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progress, stage, prepare: { hdrToSdr: true, fromFps: 1001 } }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progress, stage, prepare: { hdrToSdr: true } }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progress, stage, prepare: { hdrToSdr: true, fromFps: null, path: "/a" } }).success).toBe(false);
  });

  test("a prepare still never counts past its total", () => {
    expect(JobProgress.safeParse({ ...progress, stage: "prepare", done: 101 }).success).toBe(false);
  });

  test("a prepare progress is never full: the last unit belongs to the end of the job (a full copy is allowed, its end follows)", () => {
    expect(JobProgress.safeParse({ ...progress, stage: "prepare", done: 100, total: 100 }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progress, stage: "prepare", done: 99, total: 100 }).success).toBe(true);
    expect(JobProgress.safeParse({ ...progress, stage: "prepare", done: 0, total: 1 }).success).toBe(true);
    expect(JobProgress.safeParse({ ...progress, done: 100, total: 100 }).success).toBe(true);
    expect(JobProgress.safeParse({ ...progress, stage: "copy", done: 100, total: 100 }).success).toBe(true);
  });

  test("a snapshot's job that is done in its prepare stage is a full count: only a progress is never full", () => {
    expect(JobState.safeParse({ ...state, status: "done", stage: "prepare", done: 100, total: 100, mediaId: "media-00000001", result: { kind: "import", mediaId: "media-00000001", media: { mediaId: "media-00000001", kind: "video", name: "walk.mov", bytes: 10, createdAt: "2026-10-04T10:00:00.000Z", width: 2, height: 2, durationMs: 1000, sourceFps: 30, hdrToSdr: false, loopFrames: null, delayFrames: null } } }).success).toBe(true);
  });

  test("a queued import is announced at zero and in no stage but the first", () => {
    expect(JobProgress.safeParse({ ...progress, done: 0, queued: true }).success).toBe(true);
    expect(JobProgress.safeParse({ ...progress, done: 0, queued: true, stage: "prepare" }).success).toBe(false);
  });

  test("a snapshot's job state carries the stage it was in", () => {
    expect(JobState.safeParse({ ...state, stage: "prepare", prepare: { hdrToSdr: false, fromFps: 24 } }).success).toBe(true);
    expect(JobState.safeParse({ ...state, stage: "copy", prepare: { hdrToSdr: false, fromFps: null } }).success).toBe(false);
  });

  test("no other kind of job has a stage", () => {
    const render = { kind: "render", jobId: "job-00000006", videoId: "video-00000001", avatarId: "avatar-0001", montageId: null, done: 1, total: 10 };
    expect(JobProgress.safeParse({ ...render, stage: "prepare" }).success).toBe(false);
  });

  test("a failure or a cancel names the job and no stage", () => {
    const { done: _done, total: _total, ...ref } = progress;
    expect(JobFailed.safeParse({ ...ref, stage: "prepare", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "failed" } }).success).toBe(false);
    expect(JobCancelled.safeParse({ ...ref, stage: "prepare" }).success).toBe(false);
  });
});

describe("fromFpsOf: the source rate a window says it converts from", () => {
  test("is the source's rate when it is not the mezzanine's 30", () => {
    expect(fromFpsOf(60)).toBe(60);
    expect(fromFpsOf(24)).toBe(24);
    expect(fromFpsOf(25)).toBe(25);
    expect(fromFpsOf(120)).toBe(120);
  });

  test("is null for 30, and for the rounding of a 30 000 / 1001 camera (29.97): no conversion worth a word", () => {
    expect(fromFpsOf(30)).toBeNull();
    expect(fromFpsOf(29.97)).toBeNull();
    expect(fromFpsOf(30.03)).toBeNull();
  });

  test("a rate one step past the tolerance is told", () => {
    expect(fromFpsOf(29.9)).toBe(29.9);
    expect(fromFpsOf(30.1)).toBe(30.1);
  });
});

describe("too-short", () => {
  test("is the last reason, so no older reason's place moved", () => {
    expect(MediaUnsupportedReason.options.at(-1)).toBe("too-short");
  });

  test("a video is told the 0.5 s of the shortest clip, in the video's own words", () => {
    expect(mediaReasonRu("too-short", "video")).toBe("Видео короче 0.5 с — в ролик его не поставить.");
  });

  test("a track is told it is shorter than the shortest montage (4 s), in the track's own words", () => {
    const text = mediaReasonRu("too-short", "audio");
    expect(text).toContain("4 с");
    expect(text).toMatch(/[Тт]рек/);
    expect(text).not.toBe(MEDIA_REASONS_RU["too-short"]);
  });

  test("the neutral text names no kind and no number that belongs to one", () => {
    expect(MEDIA_REASONS_RU["too-short"]).not.toMatch(/[Вв]идео|ролик|[Тт]рек|0\.5|4 с/);
    expect(mediaReasonRu("too-short")).toBe(MEDIA_REASONS_RU["too-short"]);
  });

  test("photos and stickers have no text of their own for it", () => {
    expect(MEDIA_REASONS_BY_KIND_RU.photo?.["too-short"]).toBeUndefined();
    expect(MEDIA_REASONS_BY_KIND_RU.sticker?.["too-short"]).toBeUndefined();
  });
});
