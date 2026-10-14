import { describe, expect, test } from "bun:test";
import { CLIP_REASONS, ClipReason, EngineError } from "./errors";
import { CLIP_REASONS_RU, mediaReasonRu } from "./errorMessagesRu";
import { COMMAND_TYPES, ENGINE_COMMAND_TYPES, MAIN_ONLY_COMMANDS, OkResponse } from "./commands";
import { SLEEP_CLASS, heldWhileAsleep } from "./commandHold";
import { PROTOCOL_VERSION } from "./envelope";
import { parseEngineCommand } from "./messages";
import { ClipSummary } from "./clips";
import { MediaListResult, MediaSummary } from "./media";
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

  test("answers the copy's media id and nothing else", () => {
    expect(answers("media.importClip", { mediaId: "media-00000001" })).toBe(true);
    expect(answers("media.importClip", {})).toBe(false);
    expect(answers("media.importClip", { mediaId: "media-00000001", jobId: "job-00000001" })).toBe(false);
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

  test("a full disk is MEDIA_UNSUPPORTED with the importer's `no-space`, which has a text", () => {
    expect(EngineError.safeParse({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" }).success).toBe(true);
    expect(mediaReasonRu("no-space", "video")).toContain("не хватает места");
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

  test("each has its Russian text, word for word (44b for `in-use`, 57c's family for `file-damaged`)", () => {
    expect<string>(CLIP_REASONS_RU["in-use"]).toBe("Клип сейчас в рендере — удалите его после окончания.");
    expect<string>(CLIP_REASONS_RU["file-damaged"]).toBe("Файл клипа в Studio повреждён или не читается — для монтажа его не подготовить.");
  });

  test("the text of `file-damaged` never calls the Studio file intact", () => {
    expect(CLIP_REASONS_RU["file-damaged"]).not.toContain("цел");
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

  test("a ready clip may say its frame is in a finished video", () => {
    const parsed = ClipSummary.parse({ ...readyClip, use: { inVideo: true } });
    expect(parsed.status === "ready" ? parsed.use : "not ready").toEqual({ inVideo: true });
  });

  test("`use` is strict and says only `inVideo: true`: false, an extra key and an empty object are refused", () => {
    expect(ClipSummary.safeParse({ ...readyClip, use: { inVideo: false } }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...readyClip, use: {} }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...readyClip, use: { inVideo: true, videoId: "video-1" } }).success).toBe(false);
  });

  test("a failed clip has no `use`", () => {
    expect(ClipSummary.safeParse(failedClip).success).toBe(true);
    expect(ClipSummary.safeParse({ ...failedClip, use: { inVideo: true } }).success).toBe(false);
  });

  test("clips.list and clips.get carry it", () => {
    const used = { ...readyClip, use: { inVideo: true } };
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
