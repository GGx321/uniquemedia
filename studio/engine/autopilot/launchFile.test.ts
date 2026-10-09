import { describe, expect, test } from "bun:test";
import { LaunchFile, LAUNCH_FILE_SCHEMA_VERSION } from "./launchFile";
import { A, B, newLaunchFile } from "./testing/launchFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a (plan §3.3): the launch file as `autopilot.start` builds it, and the strict schema every read goes through.

const stamped = (file = newLaunchFile()) => ({ ...file, schemaVersion: LAUNCH_FILE_SCHEMA_VERSION, revision: 1, updatedAt: file.createdAt });

describe("the launch file a start builds", () => {
  test("starts running, unpaused and unheld, with nothing spent, and carries the click and the recomputed figures", () => {
    const file = newLaunchFile({}, "launch-fixture-0001", 20_000_000);
    expect(file).toMatchObject({
      launchId: "launch-fixture-0001",
      status: "running",
      paused: null,
      paidHold: null,
      freeHold: null,
      endedAt: null,
      activeMs: 0,
      activeSince: file.createdAt,
      spentMicros: 0,
      acceptedMicros: 20_000_000,
      priceSource: "fallback",
      pricesAsOf: "2026-10-09",
    });
    expect(file.plannedWorstMicros).toBeGreaterThan(0);
    expect(file.plannedWorstMicros).toBeLessThanOrEqual(file.acceptedMicros);
    expect(file.plannedExpectedMicros).toBeLessThanOrEqual(file.plannedWorstMicros);
  });

  test("the plan totals are the planner's, over the avatars that are not blocked", () => {
    expect(newLaunchFile().plan).toEqual({ videos: 4, photos: 10, fromLibrary: 0, toGenerate: 10 });
  });

  test("an avatar is planned, with its two allocations and its set and run ids issued before any call", () => {
    const [row] = newLaunchFile().avatars;
    expect(row?.avatarId).toBe(A);
    expect(row?.phase).toBe("planned");
    expect(row?.allocation.composeMicros).toBeGreaterThan(0);
    expect(row?.allocation.drawMicros).toBe(10 * 210_000);
    expect(row?.generation).toEqual({ sceneSetId: "fixture-0001", setRunId: "fixture-0002", split: [{ ref: "home", count: 10 }], review: false });
  });

  test("the scene review switch is recorded on the avatar's generation", () => {
    expect(newLaunchFile({ sceneReview: true }).avatars[0]?.generation?.review).toBe(true);
  });

  test("rows follow the draft's order, and each avatar's ids are its own", () => {
    const file = newLaunchFile({ avatarIds: [B, A] });
    expect(file.avatars.map((a) => a.avatarId)).toEqual([B, A]);
    const ids = file.avatars.flatMap((a) => (a.generation === null ? [] : [a.generation.sceneSetId, a.generation.setRunId]));
    expect(new Set(ids).size).toBe(4);
  });

  test("videos are listed in key order, planned, with their shape, size and category and no photos yet", () => {
    const videos = newLaunchFile().avatars[0]?.videos ?? [];
    expect(videos.map((v) => v.key)).toEqual(["0-1", "0-2", "0-3", "0-4"]);
    expect(videos.every((v) => v.state === "planned" && v.source === "generated" && v.photoIds.length === 0 && v.dropReason === null && v.videoId === null)).toBe(true);
    expect(videos.map((v) => `${v.shape}:${v.size}`).sort()).toEqual(["collage:3", "single:1", "single:1", "slides:5"]);
  });

  test("a launch that generates nothing issues no ids and has no allocation to spend", () => {
    const file = newLaunchFile({ generate: false });
    expect(file.avatars[0]?.generation).toBeNull();
    expect(file.avatars[0]?.allocation).toEqual({ composeMicros: 0, drawMicros: 0 });
    expect(file.plannedWorstMicros).toBe(0);
  });

  test("a video the library cannot fill and generation is off is listed dropped for lack of photos", () => {
    const videos = newLaunchFile({ generate: false }).avatars[0]?.videos ?? [];
    expect(videos).toHaveLength(4);
    expect(videos.every((v) => v.state === "dropped" && v.dropReason === "not-enough-photos")).toBe(true);
  });
});

describe("the launch file schema", () => {
  test("accepts a file as the store writes it", () => {
    expect(LaunchFile.safeParse(stamped()).success).toBe(true);
  });

  test("is strict: an unknown field is refused, so a newer build's file is never half-read", () => {
    expect(LaunchFile.safeParse({ ...stamped(), extra: 1 }).success).toBe(false);
    const file = stamped();
    expect(LaunchFile.safeParse({ ...file, avatars: [{ ...file.avatars[0], extra: 1 }] }).success).toBe(false);
  });

  test.each([
    ["a schema version that is not 1", { schemaVersion: 2 }],
    ["a revision below 1", { revision: 0 }],
    ["a launch id of another shape", { launchId: "run-fixture-0001" }],
    ["a fractional amount", { acceptedMicros: 1.5 }],
    ["a planned worst case above the accepted one", { plannedWorstMicros: 30_000_000 }],
    ["an expected cost above the worst case", { plannedExpectedMicros: 99_000_000, plannedWorstMicros: 5_000_000 }],
    ["a status that is not stored (pausing)", { status: "pausing" }],
    ["a paused status without its cause", { status: "paused", paused: null }],
    ["a pause on a running launch", { paused: { cause: "owner", at: "2026-10-09T10:05:00.000Z" } }],
    ["an end on a running launch", { endedAt: "2026-10-09T10:05:00.000Z" }],
    ["a done launch with no end", { status: "done", activeSince: null }],
    ["an active start on a launch that is not running", { status: "paused", paused: { cause: "owner", at: "2026-10-09T10:05:00.000Z" } }],
    ["no avatar rows", { avatars: [] }],
    ["an avatar row the draft does not name", { avatars: [{ ...newLaunchFile().avatars[0], avatarId: "avatar-nobody-0404" }] }],
  ])("refuses %s", (_name, patch) => {
    expect(LaunchFile.safeParse({ ...stamped(), ...patch }).success).toBe(false);
  });

  test("refuses allocations that do not add up to the planned worst case (L15)", () => {
    const file = stamped();
    const row = file.avatars[0];
    if (row === undefined) throw new Error("no row");
    expect(LaunchFile.safeParse({ ...file, avatars: [{ ...row, allocation: { ...row.allocation, drawMicros: row.allocation.drawMicros + 1 } }] }).success).toBe(false);
  });

  test("refuses a video whose size does not belong to its shape, and a dropped video with no reason", () => {
    const file = stamped();
    const row = file.avatars[0];
    const video = row?.videos[0];
    const withVideo = (patch: object) => ({ ...file, avatars: [{ ...row, videos: [{ ...video, ...patch }] }] });
    expect(LaunchFile.safeParse(withVideo({ shape: "single", size: 3 })).success).toBe(false);
    expect(LaunchFile.safeParse(withVideo({ state: "dropped", dropReason: null })).success).toBe(false);
    expect(LaunchFile.safeParse(withVideo({ state: "planned", dropReason: "render-failed" })).success).toBe(false);
  });

  test("refuses a waiting phase without its reason and a skipped phase without its own", () => {
    const file = stamped();
    const row = file.avatars[0];
    expect(LaunchFile.safeParse({ ...file, avatars: [{ ...row, phase: "waiting" }] }).success).toBe(false);
    expect(LaunchFile.safeParse({ ...file, avatars: [{ ...row, phase: "skipped" }] }).success).toBe(false);
    expect(LaunchFile.safeParse({ ...file, avatars: [{ ...row, phase: "waiting", waiting: { reason: "avatar-busy" } }] }).success).toBe(true);
    expect(LaunchFile.safeParse({ ...file, avatars: [{ ...row, phase: "skipped", skipped: { reason: "archived" } }] }).success).toBe(true);
  });
});

describe("what a video carries once its photos are assigned (S4.6c1, plan §3.3)", () => {
  const withVideo = (patch: object) => {
    const file = stamped();
    const row = file.avatars[0];
    const video = row?.videos[0];
    return { ...file, avatars: [{ ...row, videos: [{ ...video, ...patch }] }] };
  };

  test("a video written before the free steps existed reads as it is: no music, no sticker memory", () => {
    const parsed = LaunchFile.parse(stamped());
    const video = parsed.avatars[0]?.videos[0];
    expect(video !== undefined && "music" in video).toBe(false);
    expect(video !== undefined && "previousStickerId" in video).toBe(false);
  });

  test("a trending track with its start, and the sticker the previous video had, are kept", () => {
    const music = { source: "trending", trackId: "track-00000001", startMs: 1500 };
    const parsed = LaunchFile.parse(withVideo({ state: "assigned", shape: "single", size: 1, photoIds: ["photo-00000001"], music, previousStickerId: "sticker-heart" }));
    expect(parsed.avatars[0]?.videos[0]).toMatchObject({ music, previousStickerId: "sticker-heart" });
  });

  test("an own track keeps its media id and start", () => {
    const music = { source: "own", mediaId: "media-00000001", startMs: 0 };
    expect(LaunchFile.parse(withVideo({ music })).avatars[0]?.videos[0]).toMatchObject({ music });
  });

  test("no sticker before it is the explicit null", () => {
    expect(LaunchFile.parse(withVideo({ previousStickerId: null })).avatars[0]?.videos[0]).toMatchObject({ previousStickerId: null });
  });

  test.each([
    ["a source it does not know", { source: "jamendo", trackId: "track-00000001", startMs: 0 }],
    ["a trending track with a media id", { source: "trending", mediaId: "media-00000001", startMs: 0 }],
    ["a negative start", { source: "trending", trackId: "track-00000001", startMs: -1 }],
    ["a start past the contract's furthest", { source: "trending", trackId: "track-00000001", startMs: 600_001 }],
    ["a field it does not know", { source: "trending", trackId: "track-00000001", startMs: 0, title: "x" }],
  ])("refuses music with %s", (_name, music) => {
    expect(LaunchFile.safeParse(withVideo({ music })).success).toBe(false);
  });
});
