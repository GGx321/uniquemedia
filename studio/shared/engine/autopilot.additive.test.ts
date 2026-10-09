import { describe, expect, test } from "bun:test";
import { OkResponse } from "./commands";
import { EngineError, LAUNCH_REASONS, SCENE_REASONS } from "./errors";
import { ERROR_MESSAGES_RU, LAUNCH_REASONS_RU, SCENE_REASONS_RU } from "./errorMessagesRu";
import { parseEngineCommand } from "./messages";
import { MediaSummary } from "./media";
import { PROTOCOL_VERSION } from "./envelope";
import { SceneSetView } from "./scenes";
import { JobState, RunSummary } from "./state";
import { VideoSummary } from "./video";
import { A, LAUNCH, NOW } from "./autopilot.fixtures";

// Stage 4, S4.1: every addition to a shape that already exists is OPTIONAL, so a payload from before Stage 4 (an old producer, a record or a set on disk read through the
// contract) still parses unchanged, and the new field is checked when it is there. Each shape below is tried first without the field, then with it, then with it broken.

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const accepts = (type: string, payload: unknown): boolean => parseEngineCommand(command(type, payload)).ok;
const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;

const legacyVideo: VideoSummary = {
  videoId: "video-00000001",
  avatarId: A,
  kind: "photo",
  durationMs: 8_000,
  bytes: 1_200_000,
  createdAt: NOW,
  relPath: "Mia/2026-10-08_photo_001.mp4",
  fileState: "present",
  montageId: null,
  photoCount: 1,
  music: null,
  hasPoster: false,
  title: null,
  firstClip: null,
};

describe("VideoSummary provenance and the published mark", () => {
  test("a summary from before Stage 4 still parses and gains no field", () => {
    const parsed = VideoSummary.parse(legacyVideo);
    expect(parsed).toEqual(legacyVideo);
    expect("origin" in parsed).toBe(false);
    expect("launchId" in parsed).toBe(false);
    expect("publishedAt" in parsed).toBe(false);
  });

  test("an autopilot video names its launch, and may be published", () => {
    const made: VideoSummary = { ...legacyVideo, origin: "autopilot", launchId: LAUNCH, publishedAt: "2026-10-08T15:00:00.000Z" };
    expect(VideoSummary.parse(made)).toEqual(made);
  });

  test("a launch id belongs to an autopilot video", () => {
    expect(VideoSummary.safeParse({ ...legacyVideo, launchId: LAUNCH }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...legacyVideo, origin: "autopilot", launchId: LAUNCH }).success).toBe(true);
    expect(VideoSummary.safeParse({ ...legacyVideo, origin: "autopilot" }).success).toBe(true);
  });

  test("a video not published is null or absent, never another word", () => {
    expect(VideoSummary.safeParse({ ...legacyVideo, publishedAt: null }).success).toBe(true);
    expect(VideoSummary.safeParse({ ...legacyVideo, publishedAt: "yesterday" }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...legacyVideo, publishedAt: true }).success).toBe(false);
  });

  test("the origin is `autopilot` or absent, and a launch id is a launch id", () => {
    expect(VideoSummary.safeParse({ ...legacyVideo, origin: "manual" }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...legacyVideo, origin: "autopilot", launchId: "../launch" }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...legacyVideo, origin: "autopilot", launchId: "run-0a1b2c3d4e5f" }).success).toBe(false);
  });
});

describe("videos.list, videos.delete, videos.setPublished", () => {
  test("the list answers as before, and may say whether the published marks could be read", () => {
    expect(answers("videos.list", { videos: [legacyVideo] })).toBe(true);
    expect(answers("videos.list", { videos: [legacyVideo], published: "ok" })).toBe(true);
    expect(answers("videos.list", { videos: [legacyVideo], published: "unknown" })).toBe(true);
    expect(answers("videos.list", { videos: [legacyVideo], published: "maybe" })).toBe(false);
    expect(answers("videos.list", { videos: [legacyVideo], published: true })).toBe(false);
  });

  test("a delete without rejectPhotos is the delete of before, with it the photos are rejected first", () => {
    expect(accepts("videos.delete", { videoId: "video-00000001", mode: "video" })).toBe(true);
    expect(accepts("videos.delete", { videoId: "video-00000001", mode: "record", rejectPhotos: true })).toBe(true);
    expect(accepts("videos.delete", { videoId: "video-00000001", mode: "video", rejectPhotos: false })).toBe(false);
    expect(accepts("videos.delete", { videoId: "video-00000001", mode: "video", rejectPhotos: "yes" })).toBe(false);
  });

  test("a delete's answer lists the photos it rejected only when asked to", () => {
    const base = { videoId: "video-00000001", fileDeleted: true, fileState: "present" };
    expect(answers("videos.delete", base)).toBe(true);
    expect(answers("videos.delete", { ...base, rejectedPhotoIds: ["photo-00000001", "photo-00000002"] })).toBe(true);
    expect(answers("videos.delete", { ...base, rejectedPhotoIds: [] })).toBe(true);
    expect(answers("videos.delete", { ...base, rejectedPhotoIds: ["../photo"] })).toBe(false);
    expect(answers("videos.delete", { ...base, rejectedPhotoIds: Array.from({ length: 101 }, (_, i) => `photo-${String(i).padStart(8, "0")}`) })).toBe(false);
  });

  test("setPublished names a video and a flag, and answers the video", () => {
    expect(accepts("videos.setPublished", { videoId: "video-00000001", published: true })).toBe(true);
    expect(accepts("videos.setPublished", { videoId: "video-00000001", published: false })).toBe(true);
    expect(accepts("videos.setPublished", { videoId: "video-00000001", published: "true" })).toBe(false);
    expect(accepts("videos.setPublished", { videoId: "video-00000001" })).toBe(false);
    expect(accepts("videos.setPublished", { videoId: "../video", published: true })).toBe(false);
    expect(answers("videos.setPublished", { video: { ...legacyVideo, publishedAt: NOW } })).toBe(true);
    expect(answers("videos.setPublished", { video: { ...legacyVideo, publishedAt: "never" } })).toBe(false);
  });
});

describe("own tracks marked «для автопилота»", () => {
  const audio: MediaSummary = {
    mediaId: "media-00000001",
    kind: "audio",
    name: "summer-loop.m4a",
    bytes: 900_000,
    createdAt: NOW,
    width: null,
    height: null,
    durationMs: 42_000,
    sourceFps: null,
    hdrToSdr: false,
    loopFrames: null,
    delayFrames: null,
  };

  test("a record from before Stage 4 parses and gains no field", () => {
    const parsed = MediaSummary.parse(audio);
    expect(parsed).toEqual(audio);
    expect("forAutopilot" in parsed).toBe(false);
  });

  test("a track is marked or not; the flag is a boolean", () => {
    expect(MediaSummary.safeParse({ ...audio, forAutopilot: true }).success).toBe(true);
    expect(MediaSummary.safeParse({ ...audio, forAutopilot: false }).success).toBe(true);
    expect(MediaSummary.safeParse({ ...audio, forAutopilot: "yes" }).success).toBe(false);
  });

  test("only a track can be marked: a photo, a video and a sticker cannot", () => {
    const photo = { ...audio, kind: "photo", name: "a.jpg", width: 100, height: 100, durationMs: null };
    expect(MediaSummary.safeParse(photo).success).toBe(true);
    expect(MediaSummary.safeParse({ ...photo, forAutopilot: true }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...photo, forAutopilot: false }).success).toBe(true);
  });

  test("the command names a media and a flag and answers the record", () => {
    expect(accepts("media.setForAutopilot", { mediaId: "media-00000001", on: true })).toBe(true);
    expect(accepts("media.setForAutopilot", { mediaId: "media-00000001", on: 1 })).toBe(false);
    expect(accepts("media.setForAutopilot", { mediaId: "../media", on: true })).toBe(false);
    expect(accepts("media.setForAutopilot", { mediaId: "media-00000001" })).toBe(false);
    expect(answers("media.setForAutopilot", { media: { ...audio, forAutopilot: true } })).toBe(true);
    expect(answers("media.setForAutopilot", { media: { ...audio, kind: "photo", forAutopilot: true } })).toBe(false);
  });
});

describe("launch marks on runs, jobs and scene sets", () => {
  const run = { runId: "run-00000001", avatarId: A, createdAt: NOW, total: 10, done: 4, failed: 1, open: 5, capMicros: 1_000_000, committedMicros: 300_000, running: false, resumable: true, capExhausted: false, remainingWorstMicros: 400_000 };

  test("a run summary from before Stage 4 parses and gains no field; a launch's slice names its launch", () => {
    expect(RunSummary.parse(run)).toEqual(run);
    expect(RunSummary.parse({ ...run, launchId: LAUNCH })).toEqual({ ...run, launchId: LAUNCH });
    expect(RunSummary.safeParse({ ...run, launchId: "run-00000002" }).success).toBe(false);
    expect(RunSummary.safeParse({ ...run, launchId: null }).success).toBe(false);
  });

  test("runs.list carries the mark through the contract", () => {
    expect(answers("runs.list", { runs: [run] })).toBe(true);
    expect(answers("runs.list", { runs: [{ ...run, launchId: LAUNCH }] })).toBe(true);
    expect(answers("runs.list", { runs: [{ ...run, launchId: "nope" }] })).toBe(false);
  });

  const common = { jobId: "job-00000001", status: "running", done: 1, total: 4 };
  const jobs = {
    run: { kind: "run", runId: "run-00000001", avatarId: A, ...common },
    scenes: { kind: "scenes", sceneSetId: "set-mia-00000001", avatarId: A, ...common },
    render: { kind: "render", videoId: "video-00000001", avatarId: A, montageId: null, ...common },
  };

  test.each(Object.entries(jobs))("a %s job from before Stage 4 parses, and a launch's names it", (_kind, job) => {
    expect(JobState.safeParse(job).success).toBe(true);
    expect(JobState.safeParse({ ...job, launchId: LAUNCH }).success).toBe(true);
    expect(JobState.safeParse({ ...job, launchId: "../launch" }).success).toBe(false);
  });

  test("a candidates job is never a launch's: the strict shape refuses the field", () => {
    const candidates = { kind: "avatar.candidates", avatarId: A, ...common };
    expect(JobState.safeParse(candidates).success).toBe(true);
    expect(JobState.safeParse({ ...candidates, launchId: LAUNCH }).success).toBe(false);
  });

  const set: SceneSetView = {
    sceneSetId: "set-mia-00000001",
    avatarId: A,
    createdAt: NOW,
    revision: 1,
    status: "ready",
    stoppedBy: null,
    stoppedError: null,
    runId: null,
    poses: { profile: false, back: false },
    categories: [],
    textModel: "x-ai/grok-4.3",
    spentMicros: 0,
    openReserveMicros: 0,
    write: null,
    lastCompose: null,
    chunks: [],
    scenes: [],
  };

  test("a scene set view from before Stage 4 parses and gains no field; a launch's set names its launch", () => {
    expect(SceneSetView.parse(set)).toEqual(set);
    expect(SceneSetView.parse({ ...set, launchId: LAUNCH })).toEqual({ ...set, launchId: LAUNCH });
    expect(SceneSetView.safeParse({ ...set, launchId: "set-mia-00000001" }).success).toBe(false);
  });
});

describe("the reasons of a refusal", () => {
  test.each(["launch-set", "over-plan", "not-awaiting"])("the scene reason %s is a VALIDATION reason that names no scene", (sceneReason) => {
    expect(SCENE_REASONS).toContain(sceneReason);
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason }).success).toBe(true);
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason, sceneId: 3 }).success).toBe(false);
    expect(EngineError.safeParse({ code: "IN_FLIGHT", sceneReason }).success).toBe(false);
  });

  test("the launch reasons are the five VALIDATION refusals of the start", () => {
    expect([...LAUNCH_REASONS]).toEqual(["open-set", "too-many-photos", "usage-unknown", "launch-unreadable", "nothing-enabled"]);
    for (const launchReason of LAUNCH_REASONS) expect(EngineError.safeParse({ code: "VALIDATION", launchReason }).success).toBe(true);
  });

  test("a launch reason is only on VALIDATION, is closed, and is never beside a scene or a category reason", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", launchReason: "nothing-enabled" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "PRICE_CHANGED", launchReason: "nothing-enabled" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", launchReason: "weather" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", launchReason: "open-set", sceneReason: "open-set" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", launchReason: "open-set", categoryReason: "limit" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", launchReason: "open-set", sceneId: 3 }).success).toBe(false);
  });

  test("an error from before Stage 4 parses as it did", () => {
    expect(EngineError.parse({ code: "VALIDATION", sceneReason: "set-used" })).toEqual({ code: "VALIDATION", sceneReason: "set-used" });
    expect(EngineError.parse({ code: "INTERNAL", detail: "autopilot.start is not implemented yet" })).toEqual({ code: "INTERNAL", detail: "autopilot.start is not implemented yet" });
  });

  test("every new reason has a Russian text of its own, and none is the general one", () => {
    const texts = [...LAUNCH_REASONS.map((r) => LAUNCH_REASONS_RU[r]), SCENE_REASONS_RU["launch-set"], SCENE_REASONS_RU["over-plan"], SCENE_REASONS_RU["not-awaiting"]];
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) {
      expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
      expect(/[а-яё]/i.test(text)).toBe(true);
    }
  });

  test("the launch-set text sends the owner to the Autopilot", () => {
    expect(SCENE_REASONS_RU["launch-set"]).toContain("«Автопилоте»");
  });
});
