import { describe, expect, test } from "bun:test";
import { ERROR_MESSAGES_RU, MEDIA_REASONS_AUDIO_RU, MEDIA_REASONS_RU } from "./errorMessagesRu";
import { EngineError, ERROR_CODES } from "./errors";
import { EVENT_TYPES, EventMessage } from "./events";
import { MediaUnsupportedReason } from "./media";
import { JobCancelled, JobFailed, JobProgress, JobResult, JobState } from "./state";

// 3f.1b: the import job (K29), `MEDIA_UNSUPPORTED` with its `mediaReason` and Russian texts (K30, CF10), and `media.changed`.

const summary = {
  mediaId: "media-00000001",
  kind: "photo",
  name: "summer.jpg",
  bytes: 120_000,
  createdAt: "2026-10-04T10:00:00.000Z",
  width: 3024,
  height: 4032,
  durationMs: null,
  sourceFps: null,
  hdrToSdr: false,
  loopFrames: null,
  delayFrames: null,
};

const importJob = { kind: "import", jobId: "job-00000005", mediaKind: "photo", name: "summer.jpg", mediaId: null, status: "running", done: 400, total: 1000 };
const importResult = { kind: "import", mediaId: "media-00000001", media: summary };
const { status: _status, ...progressFields } = importJob;
const { done: _done, total: _total, ...ref } = progressFields;

describe("an import job", () => {
  test("is one more kind of job, with the kind of media, the file's display name and no media id until it is stored", () => {
    expect(JobState.safeParse(importJob).success).toBe(true);
    expect(JobProgress.safeParse(progressFields).success).toBe(true);
  });

  test("counts bytes copied of the file's size, and never more than the size", () => {
    expect(JobProgress.safeParse({ ...progressFields, done: 1001 }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progressFields, done: 0, total: 0 }).success).toBe(true);
  });

  test("a job that waits for its turn is announced queued, at zero only", () => {
    expect(JobProgress.safeParse({ ...progressFields, done: 0, queued: true }).success).toBe(true);
    expect(JobProgress.safeParse({ ...progressFields, done: 5, queued: true }).success).toBe(false);
    expect(JobState.safeParse({ ...importJob, status: "queued", done: 0 }).success).toBe(true);
  });

  test("has no path anywhere: an extra path field is refused", () => {
    expect(JobState.safeParse({ ...importJob, path: "/home/me/a.jpg" }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progressFields, path: "/home/me/a.jpg" }).success).toBe(false);
  });

  test("names a media kind and a display name", () => {
    expect(JobState.safeParse({ ...importJob, mediaKind: "document" }).success).toBe(false);
    expect(JobState.safeParse({ ...importJob, name: "a‮gpj.exe" }).success).toBe(false);
    expect(JobState.safeParse({ ...importJob, name: "" }).success).toBe(false);
  });

  test("is done with the media it stored, and then its media id is set", () => {
    expect(JobState.safeParse({ ...importJob, status: "done", done: 1000, mediaId: "media-00000001", result: importResult }).success).toBe(true);
    expect(JobResult.safeParse(importResult).success).toBe(true);
  });

  test("a done import without a result, or with a media id that is not its result's, is refused", () => {
    expect(JobState.safeParse({ ...importJob, status: "done", done: 1000, mediaId: "media-00000001" }).success).toBe(false);
    expect(JobState.safeParse({ ...importJob, status: "done", done: 1000, mediaId: "media-00000009", result: importResult }).success).toBe(false);
    expect(JobState.safeParse({ ...importJob, status: "done", done: 1000, mediaId: null, result: importResult }).success).toBe(false);
  });

  test("a job that did not finish has no media id", () => {
    expect(JobState.safeParse({ ...importJob, status: "failed", mediaId: "media-00000001", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "format" } }).success).toBe(false);
    expect(JobState.safeParse({ ...importJob, status: "cancelled", mediaId: "media-00000001" }).success).toBe(false);
  });

  test("fails with MEDIA_UNSUPPORTED and the reason, or cancelled", () => {
    expect(JobState.safeParse({ ...importJob, status: "failed", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" } }).success).toBe(true);
    expect(JobState.safeParse({ ...importJob, status: "cancelled" }).success).toBe(true);
    expect(JobFailed.safeParse({ ...ref, error: { code: "MEDIA_UNSUPPORTED", mediaReason: "changed" } }).success).toBe(true);
    expect(JobCancelled.safeParse(ref).success).toBe(true);
  });

  test("is not a render, a run or a candidates job: their fields do not fit it", () => {
    expect(JobProgress.safeParse({ ...progressFields, videoId: "video-00000001" }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progressFields, avatarId: "avatar-0001" }).success).toBe(false);
  });
});

describe("MEDIA_UNSUPPORTED (K30)", () => {
  test("is an error code", () => {
    expect([...ERROR_CODES]).toContain("MEDIA_UNSUPPORTED");
  });

  test.each(MediaUnsupportedReason.options)("says why it refused: %s", (mediaReason) => {
    expect(EngineError.safeParse({ code: "MEDIA_UNSUPPORTED", mediaReason }).success).toBe(true);
  });

  test("without a reason it is refused: the owner could not be told what to do", () => {
    expect(EngineError.safeParse({ code: "MEDIA_UNSUPPORTED" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "MEDIA_UNSUPPORTED", detail: "nope" }).success).toBe(false);
  });

  test("an unknown reason is refused", () => {
    expect(EngineError.safeParse({ code: "MEDIA_UNSUPPORTED", mediaReason: "later" }).success).toBe(false);
  });

  test("a reason on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", mediaReason: "format" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "INTERNAL", mediaReason: "failed" }).success).toBe(false);
  });

  test("has a Russian text of its own", () => {
    expect(ERROR_MESSAGES_RU.MEDIA_UNSUPPORTED).toMatch(/[А-Яа-яЁё]/);
  });
});

describe("the Russian text of each refusal reason (CF10)", () => {
  test("covers exactly the reasons, each with its own text", () => {
    expect(Object.keys(MEDIA_REASONS_RU).sort()).toEqual([...MediaUnsupportedReason.options].sort());
    const texts = Object.values(MEDIA_REASONS_RU);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text).toMatch(/[А-Яа-яЁё]/);
  });

  test("a HEIC picture is told to be saved as a JPEG", () => {
    expect(MEDIA_REASONS_RU.heic).toContain("сохраните как JPEG");
  });

  test("a photo that is too small, too large in pixels or an animated WebP says so in its own words (3f.2)", () => {
    expect(MEDIA_REASONS_RU["too-small"]).toContain("2 пиксел");
    expect(MEDIA_REASONS_RU.dimensions).toContain("мегапиксел");
    expect(MEDIA_REASONS_RU["animated-webp"]).toContain("WebP");
  });

  test("music that is too long or in a codec Studio does not read says so in its own words (3f.4)", () => {
    expect(MEDIA_REASONS_AUDIO_RU["too-long"]).toContain("10 минут");
    expect(MEDIA_REASONS_AUDIO_RU.codec).toMatch(/mp3|AAC|FLAC/);
    expect(MEDIA_REASONS_AUDIO_RU.format).toContain("музык");
  });

  test("the music texts are a separate per-kind map that only holds reasons of the contract", () => {
    for (const reason of Object.keys(MEDIA_REASONS_AUDIO_RU)) expect(MediaUnsupportedReason.safeParse(reason).success).toBe(true);
    for (const text of Object.values(MEDIA_REASONS_AUDIO_RU)) {
      expect(text).toMatch(/[А-Яа-яЁё]/);
      expect(text).not.toMatch(/[\\/]/);
    }
  });

  test("no text holds a path or a file name placeholder", () => {
    for (const text of Object.values(MEDIA_REASONS_RU)) {
      expect(text).not.toMatch(/[\\/]/);
      expect(text).not.toMatch(/\{|\}/);
    }
  });
});

describe("media.changed", () => {
  const envelope = { v: 5, id: "event-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "media.changed" };

  test("is an event", () => {
    expect([...EVENT_TYPES]).toContain("media.changed");
  });

  test("announces a stored record, or one that is gone", () => {
    expect(EventMessage.safeParse({ ...envelope, payload: { change: "upserted", media: summary } }).success).toBe(true);
    expect(EventMessage.safeParse({ ...envelope, payload: { change: "removed", mediaId: "media-00000001" } }).success).toBe(true);
  });

  test("a removal names only the id, an upsert only the record", () => {
    expect(EventMessage.safeParse({ ...envelope, payload: { change: "removed", mediaId: "media-00000001", media: summary } }).success).toBe(false);
    expect(EventMessage.safeParse({ ...envelope, payload: { change: "upserted", mediaId: "media-00000001" } }).success).toBe(false);
    expect(EventMessage.safeParse({ ...envelope, payload: { change: "changed", media: summary } }).success).toBe(false);
  });
});
