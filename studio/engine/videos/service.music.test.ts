import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { EngineError } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import { EngineFailure } from "../engineFailure";
import { TrackUnavailableError, type RenderTrack, type RenderTrackSource } from "../music/renderTrack";
import { specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, until } from "./testing/serviceKit";
useNativeGlobals();

// `videos.render` with music (3c.5): a trending track is judged against the track store BEFORE anything is queued, and the job
// that follows asks the store for the file by id. The renderer never supplies a path: the spec carries an id and a start.

const world = useWorld();
const TRACK_ID = "4199287736976977";
const photoId = (w: World, i: number): string => w.photos[i]?.id ?? "";
const withMusic = (w: World, startMs: number, trackId = TRACK_ID): MontageDraft => ({ ...specOf(w.avatar.id, [photoId(w, 0)], 4_000), music: { source: "trending", trackId, startMs } });

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const trackOf = (decodedMs: number): RenderTrack => ({ data: new Uint8Array([1, 2, 3]), check: async () => undefined, bytes: 1, sha256: "c".repeat(64), decodedMs, title: "A Song Title", artist: null, forbidden: [] });

function store(decodedMs: number | null, opened: string[] = []): RenderTrackSource {
  return {
    stored: (trackId) => (trackId === TRACK_ID && decodedMs !== null ? { decodedMs } : null),
    openForRender: async (trackId) => {
      opened.push(trackId);
      if (decodedMs === null) throw new TrackUnavailableError("not-stored");
      return trackOf(decodedMs);
    },
  };
}

/** The scripted measurement: the fake track is no file ffmpeg could read. */
const measured = { renderOverrides: { runDeps: { measure: async () => -5.7 } } };

async function expectNothingTouched(r: ReturnType<typeof serviceRig>): Promise<void> {
  expect(r.queue.states()).toEqual([]);
  expect(r.tracker.liveJobIds().size).toBe(0);
  expect(existsSync(join(r.w.exportRoot, "Mia"))).toBe(false);
  expect(await readdir(r.w.renderTmp)).toEqual([]);
  expect(r.w.library.videoCount(r.w.avatar.id)).toBe(0);
}

describe("videos.render: the music track is judged before anything is queued", () => {
  test("a track the store does not hold is MONTAGE_INVALID track-unavailable at music, and nothing is touched", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { tracks: store(null) } });

    const error = await failureOf(r.service.render({ spec: withMusic(w, 0) }));

    expect(error.code).toBe("MONTAGE_INVALID");
    expect(error.issues).toEqual([{ code: "track-unavailable", path: ["music"] }]);
    expect(r.checks).toHaveLength(0);
    await expectNothingTouched(r);
  });

  test("with no track store at all the answer is the same", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: withMusic(w, 0) }));

    expect(error.issues).toEqual([{ code: "track-unavailable", path: ["music"] }]);
    await expectNothingTouched(r);
  });

  test("a track shorter than startMs plus the montage is track-too-short, one millisecond short included", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { tracks: store(5_999) } });

    const error = await failureOf(r.service.render({ spec: withMusic(w, 2_000) }));

    expect(error.issues).toEqual([{ code: "track-too-short", path: ["music"] }]);
    await expectNothingTouched(r);
  });

  test("a track exactly as long as startMs plus the montage is accepted", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { tracks: store(6_000), ...measured } });

    await r.service.render({ spec: withMusic(w, 2_000) });
    await r.queue.idle();

    expect(r.queue.states()[0]).toMatchObject({ status: "done" });
  });

  test("an own track is judged by the media store, never the track store (3f.4): with none wired it is media-unavailable, and the track store is not asked", async () => {
    const w = world();
    const opened: string[] = [];
    const r = serviceRig(w, { deps: { tracks: store(8_000, opened) } });

    const error = await failureOf(r.service.render({ spec: { ...specOf(w.avatar.id, [photoId(w, 0)], 4_000), music: { source: "own", mediaId: "media-0000001", startMs: 0 } } }));

    expect(error.issues).toEqual([{ code: "media-unavailable", path: ["music"] }]);
    expect(opened).toEqual([]);
    await expectNothingTouched(r);
  });

  test("a structurally invalid spec with music lists its structural issues and the track's together", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { tracks: store(null) } });

    const error = await failureOf(r.service.render({ spec: { ...withMusic(w, 0), clips: [] } }));

    expect(error.issues?.map((i) => i.code)).toEqual(["no-clips", "track-unavailable"]);
  });
});

describe("videos.render: the job asks the store for the track by id", () => {
  test("queues the render, and the job opens exactly the id the spec names", async () => {
    const w = world();
    const opened: string[] = [];
    const r = serviceRig(w, { deps: { tracks: store(8_000, opened), ...measured } });

    await r.service.render({ spec: withMusic(w, 1_500) });
    await r.queue.idle();

    expect(opened).toEqual([TRACK_ID]);
    expect(r.queue.states()[0]).toMatchObject({ status: "done" });
  });

  test("a store that refuses the file at the job's start (it changed since the record was read) fails the job, not the command", async () => {
    const w = world();
    const refusing: RenderTrackSource = { stored: () => ({ decodedMs: 8_000 }), openForRender: async () => Promise.reject(new TrackUnavailableError("changed")) };
    const r = serviceRig(w, { deps: { tracks: refusing } });

    await r.service.render({ spec: withMusic(w, 0) });
    await r.queue.idle();
    await until(() => r.queue.states()[0]?.status === "failed", "the job to fail");

    expect(r.queue.states()[0]).toMatchObject({ status: "failed", error: { code: "MONTAGE_INVALID", issues: [{ code: "track-unavailable", path: ["music"] }] } });
    expect(r.w.library.videoCount(r.w.avatar.id)).toBe(0);
  });

  test("a montage with no music never touches the store", async () => {
    const w = world();
    const opened: string[] = [];
    const r = serviceRig(w, { deps: { tracks: store(8_000, opened) } });

    await r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 4_000) });
    await r.queue.idle();

    expect(opened).toEqual([]);
  });
});
