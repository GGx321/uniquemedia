import { describe, expect, test } from "bun:test";
import type { Probed } from "../engine/render/ffmpeg.testkit";
import { copySummaryProblems, fixtureClipArgv, fixturePosterArgv, frameUseProblems, MONTAGE_SMOKE, montageSmokeExpectation, montageSmokeSpec, providerFileProblems, storedCopyProblems } from "./clipMontageSmoke";

// Stage 5, 5b.2, S5.WA3: the pure checks of the clip-montage smoke. The run that makes them mean something is clipMontageSmoke.engine.test.ts (the real engine, no Electron) and the packaged smoke (CI).

const CLIP = { clipId: "clip-0000001", avatarId: "avatar-0001", photoId: "photo-0001" };
const GOOD_COPY = { kind: "video", width: 720, height: 1280, durationMs: 2_000, sourceFps: 24, origin: { kind: "clip" as const, ...CLIP } };

function probed(over: Partial<Probed["streams"][number]> = {}, extra: Probed["streams"] = []): Probed {
  const video = { codec_type: "video", codec_name: "h264", width: 720, height: 1280, r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_read_frames: "60", ...over };
  return { streams: [video, ...extra], format: {} } as unknown as Probed;
}

describe("the Reel the smoke renders", () => {
  test("is one photo and two copies of 2 s: 6 s, 180 frames at 30 fps", () => {
    expect(montageSmokeExpectation()).toEqual({ frames: 180, durationMs: 6_000 });
  });

  test("names the photo first and then the two copies, each a video clip of its media from the start", () => {
    const spec = montageSmokeSpec("avatar-1", "photo-9", ["media-a", "media-b"]) as { clips: Record<string, unknown>[] };
    expect(spec.clips.map((c) => c.kind)).toEqual(["photo", "video", "video"]);
    expect(spec.clips.map((c) => c.mediaId)).toEqual([undefined, "media-a", "media-b"]);
    expect(spec.clips.map((c) => c.durationMs)).toEqual([2_000, 2_000, 2_000]);
    expect(spec.clips.slice(1).map((c) => c.trimStartMs)).toEqual([0, 0]);
  });
});

describe("the fixture clip", () => {
  test("is asked of ffmpeg as 24 fps H.264 with AAC, 2 s, 720 x 1280", () => {
    const argv = fixtureClipArgv("/tmp/out.mp4").join(" ");
    expect(argv).toContain("testsrc2=size=720x1280:rate=24:duration=2");
    expect(argv).toContain("-c:v libx264");
    expect(argv).toContain("-c:a aac");
    expect(argv.endsWith("/tmp/out.mp4")).toBe(true);
  });

  test("has a poster of its first frame", () => {
    expect(fixturePosterArgv("/tmp/in.mp4", "/tmp/p.jpg")).toEqual(["-i", "/tmp/in.mp4", "-frames:v", "1", "/tmp/p.jpg"]);
  });
});

describe("copySummaryProblems", () => {
  test("accepts the copy of the clip: a video with the clip's origin, its size, its length and the 24 fps it came from", () => {
    expect(copySummaryProblems(GOOD_COPY, CLIP)).toEqual([]);
  });

  test("a copy that is not there is one problem", () => {
    expect(copySummaryProblems(undefined, CLIP)).toHaveLength(1);
  });

  test("a copy with no origin, or the origin of another clip, does not say where it comes from", () => {
    expect(copySummaryProblems({ ...GOOD_COPY, origin: undefined }, CLIP).join()).toContain("does not say where it comes from");
    expect(copySummaryProblems({ ...GOOD_COPY, origin: { kind: "clip", ...CLIP, clipId: "clip-9" } }, CLIP).join()).toContain("does not say where it comes from");
  });

  test("a copy upscaled to the frame is refused", () => {
    expect(copySummaryProblems({ ...GOOD_COPY, width: 1080, height: 1920 }, CLIP).join()).toContain("never upscaled");
  });

  test("a copy of the wrong length, and one that does not remember its 24 fps, are refused", () => {
    expect(copySummaryProblems({ ...GOOD_COPY, durationMs: 2_500 }, CLIP).join()).toContain("2500 ms");
    expect(copySummaryProblems({ ...GOOD_COPY, sourceFps: 30 }, CLIP).join()).toContain("30 fps");
  });

  test("a length within two frames of the encode is accepted", () => {
    expect(copySummaryProblems({ ...GOOD_COPY, durationMs: 2_000 + 2 * (1000 / 30) - 1 }, CLIP)).toEqual([]);
  });
});

describe("storedCopyProblems", () => {
  test("accepts one H.264 stream at 30/1, inside the frame, with the frames 30 fps makes of 2 s", () => {
    expect(storedCopyProblems(probed())).toEqual([]);
  });

  test("an audio stream in the copy is refused: a copy carries no audio", () => {
    expect(storedCopyProblems(probed({}, [{ codec_type: "audio", codec_name: "aac" } as Probed["streams"][number]])).join()).toContain("no audio");
  });

  test("a variable or a 24 fps copy is refused", () => {
    expect(storedCopyProblems(probed({ r_frame_rate: "24/1", avg_frame_rate: "24/1" })).join()).toContain("30/1 constant");
    expect(storedCopyProblems(probed({ avg_frame_rate: "2997/100" })).join()).toContain("30/1 constant");
  });

  test("a copy outside the frame, and one with a wrong frame count, are refused", () => {
    expect(storedCopyProblems(probed({ width: 1081 })).join()).toContain("outside the frame");
    expect(storedCopyProblems(probed({ nb_read_frames: "59" })).join()).toContain("59 frames, not 60");
  });

  test("a file with no video stream is refused", () => {
    expect(storedCopyProblems({ streams: [], format: {} } as unknown as Probed).join()).toContain("0 video streams");
  });
});

describe("providerFileProblems", () => {
  test("the same sha256 before and after is no problem; another is the provider's file rewritten", () => {
    expect(providerFileProblems("clip-1", "abc", "abc")).toEqual([]);
    expect(providerFileProblems("clip-1", "abcdef0123456789", "fedcba9876543210").join()).toContain("rewritten");
  });
});

describe("frameUseProblems", () => {
  const clips = [
    { clipId: "c1", use: { inVideo: "clip" } },
    { clipId: "c2", use: { inVideo: "clip" } },
  ];
  const photos = [
    { photoId: "p1", used: true, reserved: false },
    { photoId: "p2", used: true, reserved: false },
    { photoId: "p3", used: true, reserved: false },
  ];

  test("both clips used as a clip and all three frames used and free of any reservation is right", () => {
    expect(frameUseProblems(clips, ["c1", "c2"], photos, ["p1", "p2", "p3"])).toEqual([]);
  });

  test("a clip nothing uses is a problem", () => {
    expect(frameUseProblems([{ clipId: "c1" }, clips[1] ?? { clipId: "c2" }], ["c1", "c2"], photos, ["p1"]).join()).toContain("c1 is not used");
  });

  test("a clip used only through its photo is not used as a clip", () => {
    expect(frameUseProblems([{ clipId: "c1", use: { inVideo: "photo" } }], ["c1"], photos, ["p1"]).join()).toContain("c1 is not used");
  });

  test("a frame not used, one still reserved and one not listed are each a problem", () => {
    const problems = frameUseProblems(clips, ["c1", "c2"], [{ photoId: "p1", used: false, reserved: false }, { photoId: "p2", used: true, reserved: true }], ["p1", "p2", "p3"]);
    expect(problems).toHaveLength(3);
  });
});

describe("the frame", () => {
  test("is 1080 x 1920 at 30 fps", () => {
    expect([MONTAGE_SMOKE.frameWidth, MONTAGE_SMOKE.frameHeight, MONTAGE_SMOKE.frameFps]).toEqual([1080, 1920, 30]);
  });
});
