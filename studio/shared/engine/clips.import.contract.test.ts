import { describe, expect, test } from "bun:test";
import { CLIP_REASONS, ClipReason, EngineError } from "./errors";
import { COMMAND_TYPES, ENGINE_COMMAND_TYPES, MAIN_ONLY_COMMANDS, OkResponse } from "./commands";
import { SLEEP_CLASS, heldWhileAsleep } from "./commandHold";
import { PROTOCOL_VERSION } from "./envelope";
import { parseEngineCommand } from "./messages";
import { ClipSummary } from "./clips";
import { EventMessage } from "./events";
import { MediaListResult, MediaSummary } from "./media";
import { JobCancelled, JobFailed, JobProgress, JobResult, JobState } from "./state";
import { Clip } from "./montage";

// Stage 5, 5b.2, S5.WA1 (plan s5b2 §5.1, §8): the contract of clips in the montage editor. `media.importClip`, `MediaSummary.origin`, `ClipSummary.use`, and the clip reasons
// `file-damaged` and `in-use`. Everything is additive in protocol 5: each shape is tried in its old form first (it parses and gains no key), then with the new field, then broken.

const AVATAR = "avatar-aaaa-0001";
const OTHER_AVATAR = "avatar-bbbb-0002";
const PHOTO = "photo-0001";
const CLIP = "clip-0000001";

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const accepts = (type: string, payload: unknown): boolean => parseEngineCommand(command(type, payload)).ok;
const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;

const ownVideo = {
  mediaId: "media-00000001",
  kind: "video",
  name: "Клип 2026-10-14 10-00.mp4",
  bytes: 4_000_000,
  createdAt: "2026-10-14T10:00:00.000Z",
  width: 720,
  height: 1280,
  durationMs: 5_000,
  sourceFps: 24,
  hdrToSdr: false,
  loopFrames: null,
  delayFrames: null,
};
const origin = { kind: "clip" as const, avatarId: AVATAR, clipId: CLIP, photoId: PHOTO };

const readyClip = {
  clipId: CLIP,
  avatarId: AVATAR,
  photoId: PHOTO,
  createdAt: "2026-10-14T10:00:00.000Z",
  seen: false,
  motion: { source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" },
  request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
  model: "kling-std",
  fallback: false,
  recovered: false,
  cost: { micros: 420_000, kind: "billed" },
  exports: [],
  status: "ready",
  width: 720,
  height: 1280,
  durationMs: 5_000,
  face: { verdict: "match", p75: 0.71, frames: 11 },
};
const failedClip = {
  clipId: CLIP,
  avatarId: AVATAR,
  photoId: PHOTO,
  createdAt: "2026-10-14T10:00:00.000Z",
  seen: false,
  motion: { source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" },
  request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
  model: "kling-std",
  fallback: false,
  recovered: false,
  cost: { micros: 0, kind: "free" },
  exports: [],
  status: "failed",
  failure: { reason: "provider-error" },
};

describe("media.importClip", () => {
  test("is in the command set, and it is an engine command, not main's", () => {
    expect(COMMAND_TYPES as readonly string[]).toContain("media.importClip");
    expect(ENGINE_COMMAND_TYPES as readonly string[]).toContain("media.importClip");
    expect(MAIN_ONLY_COMMANDS as readonly string[]).not.toContain("media.importClip");
  });

  test("takes an avatar and a clip and nothing else (never a path)", () => {
    expect(accepts("media.importClip", { avatarId: AVATAR, clipId: CLIP })).toBe(true);
    expect(accepts("media.importClip", { avatarId: AVATAR })).toBe(false);
    expect(accepts("media.importClip", { clipId: CLIP })).toBe(false);
    expect(accepts("media.importClip", { avatarId: AVATAR, clipId: CLIP, path: "/tmp/x.mp4" })).toBe(false);
    expect(accepts("media.importClip", { avatarId: "../x", clipId: CLIP })).toBe(false);
  });

  test("answers {mediaId} when a live copy exists, or {jobId} when an import job starts, and nothing else", () => {
    expect(answers("media.importClip", { mediaId: "media-00000001" })).toBe(true);
    expect(answers("media.importClip", { jobId: "job-00000001" })).toBe(true);
    expect(answers("media.importClip", {})).toBe(false);
    expect(answers("media.importClip", { mediaId: "media-00000001", jobId: "job-00000001" })).toBe(false);
    expect(answers("media.importClip", { jobId: "job-00000001", extra: 1 })).toBe(false);
  });

  test("answers at once after its checks (the default deadline); it does not wait for the encode", () => {
    // The deadline itself is pinned in engine/control.clipImport.test.ts.
    expect(answers("media.importClip", { jobId: "job-00000001" })).toBe(true);
  });

  test("is free: it is classified, and it is not held while the Mac sleeps", () => {
    expect(SLEEP_CLASS["media.importClip"]).toBe("free");
    expect(heldWhileAsleep("media.importClip")).toBe(false);
  });
});

describe("the refusals of media.importClip are the existing machinery", () => {
  test("LIBRARY_UNAVAILABLE and NOT_FOUND carry no clip reason", () => {
    expect(EngineError.safeParse({ code: "LIBRARY_UNAVAILABLE" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "NOT_FOUND", detail: "no such clip" }).success).toBe(true);
  });

  test("VALIDATION `not-ready` and `file-damaged` are accepted", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "not-ready" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "file-damaged" }).success).toBe(true);
  });

  test("IN_FLIGHT `job-running` is accepted", () => {
    expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason: "job-running" }).success).toBe(true);
  });

  test("a full disk is MEDIA_UNSUPPORTED with the importer's `no-space`", () => {
    expect(EngineError.safeParse({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" }).success).toBe(true);
  });
});

describe("clipReason `file-damaged` and `in-use`", () => {
  test("both are in the closed set", () => {
    expect(CLIP_REASONS).toContain("file-damaged");
    expect(CLIP_REASONS).toContain("in-use");
    expect(ClipReason.safeParse("file-damaged").success).toBe(true);
    expect(ClipReason.safeParse("in-use").success).toBe(true);
  });

  test("`file-damaged` belongs to VALIDATION and is refused with IN_FLIGHT", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "file-damaged" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason: "file-damaged" }).success).toBe(false);
  });

  test("`in-use` belongs to IN_FLIGHT (a clip delete refused while a render holds the copy) and is refused with VALIDATION", () => {
    expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason: "in-use" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "in-use" }).success).toBe(false);
  });

  test("neither appears beside another reason, or on another code", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "file-damaged", portraitReason: "not-imported" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason: "in-use", sceneReason: "set-used" }).success).toBe(false);
    for (const clipReason of ["file-damaged", "in-use"]) expect(EngineError.safeParse({ code: "NOT_FOUND", clipReason }).success).toBe(false);
  });

});

describe("MediaSummary.origin", () => {
  test("an own video without an origin parses as before and gains no key", () => {
    const parsed = MediaSummary.parse(ownVideo);
    expect("origin" in parsed).toBe(false);
  });

  test("an own video may carry exactly {kind: clip, avatarId, clipId, photoId}", () => {
    expect(MediaSummary.parse({ ...ownVideo, origin }).origin).toEqual(origin);
  });

  test("the origin is strict: an extra key, a missing key and another kind are refused", () => {
    expect(MediaSummary.safeParse({ ...ownVideo, origin: { ...origin, path: "/x" } }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...ownVideo, origin: { kind: "clip", avatarId: AVATAR, clipId: CLIP } }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...ownVideo, origin: { ...origin, kind: "photo" } }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...ownVideo, origin: { ...origin, photoId: "../x" } }).success).toBe(false);
  });

  test("only a video may have an origin", () => {
    const photo = { ...ownVideo, kind: "photo", durationMs: null, sourceFps: null };
    expect(MediaSummary.safeParse(photo).success).toBe(true);
    expect(MediaSummary.safeParse({ ...photo, origin }).success).toBe(false);
    const sticker = { ...ownVideo, kind: "sticker", durationMs: null, sourceFps: null, loopFrames: 3, delayFrames: [1, 1, 1] };
    expect(MediaSummary.safeParse(sticker).success).toBe(true);
    expect(MediaSummary.safeParse({ ...sticker, origin }).success).toBe(false);
    const audio = { ...ownVideo, kind: "audio", width: null, height: null, sourceFps: null };
    expect(MediaSummary.safeParse(audio).success).toBe(true);
    expect(MediaSummary.safeParse({ ...audio, origin }).success).toBe(false);
  });

  test("a listing carries the origin through", () => {
    const listed = MediaListResult.parse({ media: [{ ...ownVideo, origin }, { ...ownVideo, mediaId: "media-00000002" }], total: 2 });
    expect(listed.media[0]?.origin).toEqual(origin);
    expect(listed.media[1] !== undefined && "origin" in listed.media[1]).toBe(false);
  });

  test("a clip of another avatar is a legal value (the engine's admission, not the shape, refuses it)", () => {
    expect(MediaSummary.safeParse({ ...ownVideo, origin: { ...origin, avatarId: OTHER_AVATAR } }).success).toBe(true);
  });
});

describe("ClipSummary.use", () => {
  test("a ready clip without `use` parses as before and gains no key", () => {
    const parsed = ClipSummary.parse(readyClip);
    expect("use" in parsed).toBe(false);
  });

  test("a ready clip may say a finished video holds THIS clip (`clip`) or its frame through the photo or a sibling clip (`photo`)", () => {
    for (const inVideo of ["clip", "photo"] as const) {
      const parsed = ClipSummary.parse({ ...readyClip, use: { inVideo } });
      expect(parsed.status === "ready" ? parsed.use : "not ready").toEqual({ inVideo });
    }
  });

  test("`use` is strict and says `inVideo: clip | photo`: true, false, another word and an extra key are refused", () => {
    expect(ClipSummary.safeParse({ ...readyClip, use: { inVideo: true } }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...readyClip, use: { inVideo: false } }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...readyClip, use: { inVideo: "draft" } }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...readyClip, use: {} }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...readyClip, use: { inVideo: "clip", videoId: "video-1" } }).success).toBe(false);
  });

  test("a failed clip has no `use`", () => {
    expect(ClipSummary.safeParse(failedClip).success).toBe(true);
    expect(ClipSummary.safeParse({ ...failedClip, use: { inVideo: "clip" } }).success).toBe(false);
  });

  test("clips.list and clips.get carry it", () => {
    const used = { ...readyClip, use: { inVideo: "photo" } };
    expect(answers("clips.list", { clips: [used, readyClip] })).toBe(true);
    expect(answers("clips.get", { clip: used })).toBe(true);
  });
});

describe("the montage contract is untouched (I5.59)", () => {
  test("a montage clip has exactly three kinds: photo, collage and video", () => {
    const kinds = Clip.options.map((option) => option.shape.kind.value);
    expect([...kinds].sort()).toEqual(["collage", "photo", "video"]);
  });
});

describe("ClipSummary.use.inDrafts (the delete dialog's draft warning)", () => {
  const withUse = (use: unknown) => ClipSummary.safeParse({ ...readyClip, use });

  test("parses with each key alone and with both together", () => {
    expect(withUse({ inVideo: "clip" }).success).toBe(true);
    expect(withUse({ inDrafts: { count: 2 } }).success).toBe(true);
    expect(withUse({ inVideo: "photo", inDrafts: { count: 1, first: { name: "Лето", frame: 3 } } }).success).toBe(true);
  });

  test("one draft may name itself and the frame the copy stands at; an unnamed draft has a null name", () => {
    expect(withUse({ inDrafts: { count: 1, first: { name: "Лето", frame: 3 } } }).success).toBe(true);
    expect(withUse({ inDrafts: { count: 1, first: { name: null, frame: 1 } } }).success).toBe(true);
  });

  test("an empty `use` is refused: absent means not used", () => {
    expect(withUse({}).success).toBe(false);
  });

  test("a count of 0, a fraction or a negative is refused", () => {
    for (const count of [0, 1.5, -1]) expect(withUse({ inDrafts: { count } }).success).toBe(false);
  });

  test("a frame of 0 is refused, and so is a draft name that is empty, over 80 characters or holds a control character", () => {
    expect(withUse({ inDrafts: { count: 1, first: { name: "x", frame: 0 } } }).success).toBe(false);
    expect(withUse({ inDrafts: { count: 1, first: { name: "", frame: 1 } } }).success).toBe(false);
    expect(withUse({ inDrafts: { count: 1, first: { name: "x".repeat(81), frame: 1 } } }).success).toBe(false);
    expect(withUse({ inDrafts: { count: 1, first: { name: "a\u0007b", frame: 1 } } }).success).toBe(false);
  });

  test("inDrafts is strict, and a failed clip has none", () => {
    expect(withUse({ inDrafts: { count: 1, drafts: [] } }).success).toBe(false);
    expect(withUse({ inDrafts: { count: 1, first: { name: "x", frame: 1, id: "m" } } }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...failedClip, use: { inDrafts: { count: 1 } } }).success).toBe(false);
  });
});

describe("the import job carries the clip's origin (I5.59)", () => {
  const job = { kind: "import", jobId: "job-00000005", mediaKind: "video", name: "Клип 2026-10-14 10-00.mp4", mediaId: null, status: "running", done: 400, total: 1000 };
  const { status: _status, ...progress } = job;
  const { done: _done, total: _total, ...ref } = progress;
  const clipSummary = { ...ownVideo, origin };
  const envelope = { v: 5, id: "event-00000001", kind: "event", seq: 1, bootId: "boot-00000001" };

  test("a job state, a progress and a failure carry it", () => {
    expect(JobState.parse({ ...job, origin })).toMatchObject({ origin });
    expect(JobProgress.parse({ ...progress, origin })).toMatchObject({ origin });
    expect(JobFailed.parse({ ...ref, origin, error: { code: "INTERNAL" } })).toMatchObject({ origin });
    expect(JobCancelled.parse({ ...ref, origin })).toMatchObject({ origin });
  });

  test("a job without an origin parses as before and gains no key", () => {
    expect("origin" in JobState.parse(job)).toBe(false);
    expect("origin" in JobProgress.parse(progress)).toBe(false);
    expect("origin" in JobCancelled.parse(ref)).toBe(false);
  });

  test("the origin is strict and valid: an extra key, another kind and a bad clip id are refused", () => {
    expect(JobState.safeParse({ ...job, origin: { ...origin, path: "/x" } }).success).toBe(false);
    expect(JobState.safeParse({ ...job, origin: { ...origin, kind: "photo" } }).success).toBe(false);
    expect(JobState.safeParse({ ...job, origin: { ...origin, clipId: "../x" } }).success).toBe(false);
    expect(JobProgress.safeParse({ ...progress, origin: { kind: "clip", avatarId: AVATAR, photoId: PHOTO } }).success).toBe(false);
  });

  test("only an import job has it: a clip job refuses it", () => {
    expect(JobCancelled.safeParse({ kind: "clip", jobId: "job-00000006", origin }).success).toBe(false);
  });

  test("the finished import's result carries the stored media with its origin, and the job state with it", () => {
    const result = { kind: "import", mediaId: "media-00000001", media: clipSummary };
    expect(JobResult.parse(result)).toMatchObject({ media: { origin } });
    expect(JobState.safeParse({ ...job, origin, status: "done", done: 1000, mediaId: "media-00000001", result }).success).toBe(true);
  });

  test("media.changed carries the copy's origin", () => {
    const parsed = EventMessage.parse({ ...envelope, type: "media.changed", payload: { change: "upserted", media: clipSummary } });
    expect(parsed.type === "media.changed" && parsed.payload.change === "upserted" ? parsed.payload.media.origin : "wrong").toEqual(origin);
  });
});

// Two refines carried over from the WA1 review (S5.WB1 owns the contract files now).
describe("ClipUse.inDrafts.first is told only for one draft", () => {
  const withUse = (use: unknown) => ClipSummary.safeParse({ ...readyClip, use });
  const first = { name: "Лето", frame: 3 };

  test("`first` with a count of 1 parses, and so does a count above 1 without it", () => {
    expect(withUse({ inDrafts: { count: 1, first } }).success).toBe(true);
    expect(withUse({ inDrafts: { count: 2 } }).success).toBe(true);
    expect(withUse({ inDrafts: { count: 1 } }).success).toBe(true);
  });

  test("`first` with a count above 1 is refused: the dialog names a draft only when there is exactly one", () => {
    expect(withUse({ inDrafts: { count: 2, first } }).success).toBe(false);
    expect(withUse({ inVideo: "clip", inDrafts: { count: 7, first } }).success).toBe(false);
  });
});

describe("the import job's origin belongs to a video (the same rule as MediaSummary.origin)", () => {
  const job = (mediaKind: string, over: Record<string, unknown> = {}) => ({ kind: "import", jobId: "job-00000005", mediaKind, name: "x.mp4", mediaId: null, status: "running", done: 400, total: 1000, ...over });
  const { status: _status, done: _done, total: _total, ...videoRef } = job("video");

  test("a video import carries it in a state, a progress, a failure and a cancel", () => {
    expect(JobState.safeParse({ ...job("video"), origin }).success).toBe(true);
    const { status: _s, ...progress } = job("video");
    expect(JobProgress.safeParse({ ...progress, origin }).success).toBe(true);
    expect(JobFailed.safeParse({ ...videoRef, origin, error: { code: "INTERNAL" } }).success).toBe(true);
    expect(JobCancelled.safeParse({ ...videoRef, origin }).success).toBe(true);
  });

  test("a photo, sticker or audio import refuses it everywhere", () => {
    for (const mediaKind of ["photo", "sticker", "audio"]) {
      const { status: _s, done: _d, total: _t, ...ref } = job(mediaKind);
      const { status: _s2, ...progress } = job(mediaKind);
      expect(JobState.safeParse({ ...job(mediaKind), origin }).success).toBe(false);
      expect(JobProgress.safeParse({ ...progress, origin }).success).toBe(false);
      expect(JobFailed.safeParse({ ...ref, origin, error: { code: "INTERNAL" } }).success).toBe(false);
      expect(JobCancelled.safeParse({ ...ref, origin }).success).toBe(false);
    }
  });

  test("a photo import without an origin parses as before", () => {
    expect(JobState.safeParse(job("photo")).success).toBe(true);
    expect(JobCancelled.safeParse({ kind: "import", jobId: "job-00000005", mediaKind: "photo", name: "x.jpg", mediaId: null }).success).toBe(true);
  });
});

