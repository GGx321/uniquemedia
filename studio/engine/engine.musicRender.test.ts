import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VideoSummary } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { excerptOf, fakeCdn, JPEG_1X1, listTracks } from "./music/testing/storeKit";
import { makeTaggedTrack, TAG_ARTIST, TAG_HANDLER, TAG_TITLE, tagForms } from "./music/testing/taggedTrack";
import { musicTracks } from "./music/fixtures";
import { TrackStore } from "./music/trackStore";
import { command, engineSettings, failed, GOOD, jobEnd, NOW, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { parseTruePeak } from "./render";
import { probeVideo, runBinary } from "./render/ffmpeg.testkit";
import { ffmpegPath } from "../node/ffmpegBinary";
import { verifyAndHashMp4 } from "./verify";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3c.5 in the engine, with REAL ffmpeg, the real track store, runner, verifier and commit: `videos.render` of a spec with a
// trending track. The CDN is an in-memory fake serving the 3c.1 excerpts; nothing else is faked. Covers the wiring (the store
// reaches `videos.render` and `montages.get`), the measured gain in the record, and the refusals a missing track gets.

const dir = useEngineDir("studio-engine-music-render-");
const musicDir = () => join(dir(), "userData", "music");
const renderTmp = () => join(dir(), "userData", "render-tmp");
const exportDir = () => join(dir(), "export");
const FIXTURES = join(import.meta.dir, "face/fixtures/images");
const PHOTO_FILES = ["render-best-home-1.jpg", "render-median-travel-2.jpg", "render-worst-fitness-3.jpg"];
const REAL_RENDER_TIMEOUT_MS = 120_000;

async function seedAvatar(): Promise<{ avatarId: string; photoIds: string[] }> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("vid") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const base = samplePhotoMeta().source;
  if (base.kind !== "generated") throw new Error("expected a generated sample source");
  const photoIds: string[] = [];
  for (const [i, file] of PHOTO_FILES.entries()) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, file)));
    const photo = await library.addPhoto(avatar.id, bytes, samplePhotoMeta({ mediaType: "image/jpeg", width: 720, height: 1280, source: { ...base, category: "home", attemptId: `run-00000001:slot-${i + 1}#1`, slot: `slot-${i + 1}` } }));
    photoIds.push(photo.id);
  }
  return { avatarId: avatar.id, photoIds };
}

const specOf = (avatarId: string, photoIds: readonly string[], music: unknown) => ({
  schemaVersion: 1,
  avatarId,
  layers: [],
  music,
  seed: 7,
  clips: photoIds.map((photoId, i) => ({ clipId: `clip-0000000${i + 1}`, kind: "photo", cell: { photo: { source: "scene", photoId }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" })),
});

/** A track store holding the first four tracks of the 3c.1 list: hot, threshold, quiet and the 48 kHz one, each as its real excerpt. */
async function storeWithExcerpts(first?: Uint8Array): Promise<{ store: TrackStore; trackIds: string[] }> {
  const cdn = fakeCdn();
  const tracks = listTracks(4);
  tracks.forEach((track, index) => {
    cdn.serve(track.downloadUrl, { bytes: index === 0 && first !== undefined ? first : excerptOf(index) });
    if (track.coverUrl !== null) cdn.serve(track.coverUrl, { bytes: JPEG_1X1 });
  });
  const store = await TrackStore.open({ dir: musicDir(), transport: cdn.transport, clock: () => NOW, log: () => undefined });
  await store.accept({ fetchedAt: NOW - 1000, tracks }, () => undefined, new AbortController().signal);
  return { store, trackIds: tracks.map((track) => track.trackId) };
}

async function startWithStore(store: TrackStore | undefined) {
  return startEngine(dir(), { init: { renderTmpDir: renderTmp(), settings: engineSettings(dir(), { renderConcurrency: 1 }), musicDir: musicDir() }, deps: { ...(store === undefined ? {} : { musicTracks: store }) } });
}

async function listVideos(engine: Awaited<ReturnType<typeof startWithStore>>["engine"], avatarId: string): Promise<VideoSummary[]> {
  const answer = ok(await engine.handle(command("videos.list", { avatarId })));
  if (answer.type !== "videos.list") throw new Error(`expected videos.list, got ${answer.type}`);
  return answer.result.videos;
}

async function trueMeasure(path: string): Promise<number> {
  const r = await runBinary(ffmpegPath(), ["-hide_banner", "-nostdin", "-nostats", "-i", path, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-vn", "-f", "null", "-"]);
  return parseTruePeak(r.stderr);
}

describe("videos.render with a trending track, through the engine", () => {
  test(
    "renders the hot track attenuated to the target: the file holds 48 kHz stereo AAC of the video's exact length, the record keeps the gain, and the verifier is content",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      const { store, trackIds } = await storeWithExcerpts();
      const { engine, events } = await startWithStore(store);
      await engine.settled();

      const answer = ok(await engine.handle(command("videos.render", { spec: specOf(avatarId, photoIds, { source: "trending", trackId: trackIds[0], startMs: 2_000 }) })));
      if (answer.type !== "videos.render") throw new Error("expected videos.render");
      const end = await jobEnd(events, answer.result.jobId);
      expect(end.type).toBe("job.done");

      const [video] = await listVideos(engine, avatarId);
      expect(video?.music).toEqual({ title: expect.any(String), artist: expect.anything(), trackId: trackIds[0] });
      const file = join(exportDir(), video?.relPath ?? "missing");
      const probe = await probeVideo(file);
      const audio = probe.streams.find((s) => s.codec_type === "audio");
      expect({ codec: audio?.codec_name, rate: audio?.sample_rate, channels: audio?.channels }).toEqual({ codec: "aac", rate: "48000", channels: 2 });
      expect((await verifyAndHashMp4(file, { frames: 180 })).result).toEqual({ ok: true });
      expect(await trueMeasure(file)).toBeLessThanOrEqual(-1.4);

      const records = await readdir(join(dir(), "library", "avatars", avatarId, "videos"));
      const recordFile = records.find((name) => name.endsWith(".json"));
      const record = JSON.parse(await readFile(join(dir(), "library", "avatars", avatarId, "videos", recordFile ?? ""), "utf8")) as { audio?: { gainDb: number; startMs: number; trackSha: string }; music: unknown };
      expect(record.audio).toMatchObject({ gainDb: -4.5, startMs: 2_000 });
      expect(record.audio?.trackSha).toMatch(/^[0-9a-f]{64}$/);
    },
    REAL_RENDER_TIMEOUT_MS,
  );

  test(
    "a track that carries title, artist and ID3 tags goes through the store and the render, and none of its text is in the video",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      await mkdir(dir(), { recursive: true });
      // The store's box walker refuses the hand-built ID32 box (a box it does not know), so what a store can hold is the muxer-tagged file:
      // iTunes-style title and artist, and a handler name that is not the engine's.
      await makeTaggedTrack(dir(), musicTracks.hot.file);
      const tagged = join(dir(), "tagged-plain.m4a");
      const { store, trackIds } = await storeWithExcerpts(new Uint8Array(await readFile(tagged)));
      // The store took the tagged file (its walker and decode accepted it), and the render's forbidden list is built from its own bytes.
      expect(store.stored(trackIds[0] ?? "")).not.toBeNull();
      const opened = await store.openForRender(trackIds[0] ?? "", new AbortController().signal);
      expect(opened.forbidden).toEqual(expect.arrayContaining([TAG_TITLE, TAG_ARTIST, TAG_HANDLER]));
      const { engine, events } = await startWithStore(store);
      await engine.settled();

      const answer = ok(await engine.handle(command("videos.render", { spec: specOf(avatarId, photoIds, { source: "trending", trackId: trackIds[0], startMs: 2_000 }) })));
      if (answer.type !== "videos.render") throw new Error("expected videos.render");
      const end = await jobEnd(events, answer.result.jobId);

      expect(end.type).toBe("job.done");
      const [video] = await listVideos(engine, avatarId);
      const bytes = Buffer.from(await readFile(join(exportDir(), video?.relPath ?? "missing")));
      for (const text of [TAG_TITLE, TAG_ARTIST, TAG_HANDLER]) for (const form of tagForms(text)) expect(`${form.label}: ${bytes.includes(Buffer.from(form.bytes))}`).toBe(`${form.label}: false`);
    },
    REAL_RENDER_TIMEOUT_MS,
  );

  test(
    "a track the store does not hold is refused with the contract's code before anything is queued",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      const { store } = await storeWithExcerpts();
      const { engine } = await startWithStore(store);
      await engine.settled();

      const error = failed(await engine.handle(command("videos.render", { spec: specOf(avatarId, photoIds, { source: "trending", trackId: "9999999999", startMs: 0 }) }))).error;

      expect(error.code).toBe("MONTAGE_INVALID");
      expect(error.issues).toEqual([{ code: "track-unavailable", path: ["music"] }]);
      expect(await listVideos(engine, avatarId)).toEqual([]);
    },
    REAL_RENDER_TIMEOUT_MS,
  );

  test(
    "with no track store wired every track is refused the same way",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      const { engine } = await startWithStore(undefined);
      await engine.settled();

      const error = failed(await engine.handle(command("videos.render", { spec: specOf(avatarId, photoIds, { source: "trending", trackId: "4199287736976977", startMs: 0 }) }))).error;

      expect(error.issues).toEqual([{ code: "track-unavailable", path: ["music"] }]);
    },
    REAL_RENDER_TIMEOUT_MS,
  );

  test(
    "a track whose file was swapped after the download fails the JOB as track-unavailable, and no ffmpeg ran on it",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      const { store, trackIds } = await storeWithExcerpts();
      const { engine, events } = await startWithStore(store);
      await engine.settled();
      await Bun.write(join(musicDir(), "tracks", `${trackIds[0]}.m4a`), new Uint8Array(excerptOf(0).byteLength));

      const answer = ok(await engine.handle(command("videos.render", { spec: specOf(avatarId, photoIds, { source: "trending", trackId: trackIds[0], startMs: 0 }) })));
      if (answer.type !== "videos.render") throw new Error("expected videos.render");
      const end = await jobEnd(events, answer.result.jobId);

      expect(end.type).toBe("job.failed");
      expect(end.payload).toMatchObject({ error: { code: "MONTAGE_INVALID", issues: [{ code: "track-unavailable", path: ["music"] }] } });
      expect(await listVideos(engine, avatarId)).toEqual([]);
    },
    REAL_RENDER_TIMEOUT_MS,
  );
});

describe("montages.get with a trending track, through the engine", () => {
  test("lists track-unavailable for a track the store does not hold, and nothing for one it does", async () => {
    await mkdir(exportDir());
    const { avatarId, photoIds } = await seedAvatar();
    const { store, trackIds } = await storeWithExcerpts();
    const { engine } = await startWithStore(store);
    await engine.settled();
    const issuesFor = async (trackId: string | undefined, startMs: number): Promise<string[]> => {
      const created = ok(await engine.handle(command("montages.create", { avatarId, photoIds })));
      if (created.type !== "montages.create") throw new Error("expected montages.create");
      const montage = created.result.montage;
      ok(await engine.handle(command("montages.save", { montageId: montage.montageId, spec: { ...montage.spec, music: { source: "trending", trackId, startMs } }, name: null })));
      const got = ok(await engine.handle(command("montages.get", { montageId: montage.montageId })));
      if (got.type !== "montages.get") throw new Error("expected montages.get");
      return got.result.issues.map((issue) => `${issue.code}@${issue.path.join(".")}`);
    };

    expect(await issuesFor("9999999999", 0)).toContain("track-unavailable@music");
    expect((await issuesFor(trackIds[0], 0)).filter((issue) => issue.endsWith("@music"))).toEqual([]);
    expect(await issuesFor(trackIds[0], 600_000)).toContain("track-too-short@music");
  });
});
