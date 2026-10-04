import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../node/runFfmpeg";
import { heavyTest } from "../testing/bunTiers";
import { useNativeGlobals } from "../testing/nativeGlobals";
import type { PickedFileIdentity } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { EngineReply } from "./control";
import { NODE_EXPORT_ROOT_FS } from "./exportRoot";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { pickedIdentityOf } from "./media/identity";
import { fixtureBytes, type MusicFixtureName } from "./media/fixtures/music";
import { createMusicImporter } from "./media/musicImporter";
import { wavOf } from "./media/musicFixtures.testkit";
import { command, engineSettings, failed, GOOD, jobEnd, ok, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { probeVideo } from "./render/ffmpeg.testkit";
import { verifyAndHashMp4 } from "./verify";
import { acceptingVerify } from "./videos/testing/kit";
import { writingRun } from "./videos/testing/serviceKit";
useNativeGlobals();

// 3f.4 in the engine: an own track imported by the REAL music importer (real ffmpeg), used as a montage's music, and what the engine says of it: `music.peaks`
// from the waveform its record keeps, `montages.get` and `videos.render` judging it, and `media.delete` while a render uses it (`EngineDeps.reservedMedia` is
// the render queue's reserved set, the 3f.1b review M-3). The RENDER's own ffmpeg is scripted (a gate the test opens) except in the heavy test at the end.

const dir = useEngineDir("studio-engine-own-music-");
const renderTmp = () => join(dir(), "userData", "render-tmp");
const exportDir = () => join(dir(), "export");
const pickedDir = (): string => join(dir(), "picked");
const mediaFolder = (): string => join(dir(), "library", "media");

const settingsOf = () => engineSettings(dir(), { renderConcurrency: 1 });
type Started = Awaited<ReturnType<typeof startEngine>>;

async function seedAvatar(): Promise<{ avatarId: string; photoIds: string[] }> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("own") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const base = samplePhotoMeta().source;
  if (base.kind !== "generated") throw new Error("expected a generated sample source");
  const photoIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } }, source: { ...base, category: "home", attemptId: `run-00000001:slot-${i + 1}#1`, slot: `slot-${i + 1}` } }));
    photoIds.push(photo.id);
  }
  return { avatarId: avatar.id, photoIds };
}

/** A render's ffmpeg that waits for `open()`, then writes its output as a good one would. */
function gatedFfmpeg(): { run: (opts: RunFfmpegArgvOptions) => Promise<void>; open: () => void; started: () => number } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let calls = 0;
  return {
    open,
    started: () => calls,
    run: async (opts) => {
      calls++;
      await gate;
      await writingRun(opts);
    },
  };
}

type Extra = NonNullable<Parameters<typeof startEngine>[1]>["deps"];

async function startWith(ffmpeg: { run: (opts: RunFfmpegArgvOptions) => Promise<void> } | null, extraDeps: Extra = {}): Promise<Started> {
  await mkdir(exportDir(), { recursive: true });
  const started = await startEngine(dir(), {
    init: { renderTmpDir: renderTmp(), settings: settingsOf() },
    deps: {
      mediaImporters: { audio: createMusicImporter({ minDurationMs: 0 }) },
      ...(ffmpeg === null ? {} : { videos: { renderOverrides: { verify: acceptingVerify, runDeps: { run: ffmpeg.run, measure: async () => -5.7 } } } }),
      ...extraDeps,
    },
  });
  await started.engine.settled();
  return started;
}

let calls = 0;
async function importTrack(started: Started, fixture: MusicFixtureName | Uint8Array = "mp3", name = "song.mp3", pick: "audio" | "photo" = "audio"): Promise<string> {
  await mkdir(pickedDir(), { recursive: true });
  const path = join(pickedDir(), `${++calls}-${name}`);
  await writeFile(path, typeof fixture === "string" ? fixtureBytes(fixture) : fixture);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  const callId = `call-${String(++calls).padStart(8, "0")}`;
  await started.engine.receive({ kind: "control", type: "media.import", callId, pick, path, name, expected });
  const reply = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
  if (reply === undefined || !reply.success || reply.data.mediaJobId === undefined) throw new Error("the import was not started");
  await started.engine.mediaSettled();
  const end = await jobEnd(started.events, reply.data.mediaJobId);
  expect(end.type).toBe("job.done");
  const listed = ok(await started.engine.handle(command("media.list", { kind: pick }))).result as { media: { mediaId: string; durationMs: number }[] };
  const mediaId = listed.media[0]?.mediaId;
  if (mediaId === undefined) throw new Error("nothing was stored");
  return mediaId;
}

/** A montage of one 2 s scene-photo clip per photo (`clipMs` to say otherwise; the shortest montage is 4 s) with the own track as its music. */
const trackSpec = (avatarId: string, photoIds: readonly string[], mediaId: string, startMs = 0, clipMs = 2_000) => ({
  schemaVersion: 1,
  avatarId,
  layers: [],
  music: { source: "own", mediaId, startMs },
  seed: 7,
  clips: photoIds.map((photoId, i) => ({ clipId: `clip-0000000${i + 1}`, kind: "photo", cell: { photo: { source: "scene", photoId }, focus: null }, motion: "static", durationMs: clipMs, transitionIn: "cut" })),
});

async function renderOf(engine: Started["engine"], spec: unknown): Promise<{ jobId: string }> {
  const answer = ok(await engine.handle(command("videos.render", { spec })));
  if (answer.type !== "videos.render") throw new Error(`expected videos.render, got ${answer.type}`);
  return answer.result;
}

const remove = (engine: Started["engine"], mediaId: string) => engine.handle(command("media.delete", { mediaId }));
const stored = async (): Promise<string[]> => (await readdir(mediaFolder()).catch(() => [])).filter((n) => n !== ".staging").sort();
const peaksOf = (engine: Started["engine"], mediaId: string, startMs: number, durationMs: number, bars: number) =>
  engine.handle(command("music.peaks", { track: { source: "own", mediaId }, startMs, durationMs, bars }));

/** A WAV long enough for the montage (4 s clips of a 6 s track): 8 kHz mono, a quiet square wave. */
const LONG = (): Uint8Array => wavOf(9 * 8000, 8000);

describe("music.peaks of an own track", () => {
  test("is the waveform the importer found, windowed by the same function as a trending track's", async () => {
    const started = await startWith(null);
    const mediaId = await importTrack(started, LONG(), "long.wav");

    const whole = ok(await peaksOf(started.engine, mediaId, 0, 9_000, 72)).result as { peaks: number[] };

    expect(whole.peaks).toHaveLength(72);
    expect(whole.peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 1000)).toBe(true);
    // The square wave is loud everywhere: a waveform with real audio in it, not zeros.
    expect(Math.min(...whole.peaks)).toBeGreaterThan(50);
  });

  test("a window past the end of the track is silence there, like a trending track's", async () => {
    const started = await startWith(null);
    const mediaId = await importTrack(started, LONG(), "long.wav");

    const past = ok(await peaksOf(started.engine, mediaId, 60_000, 4_000, 16)).result as { peaks: number[] };

    expect(past.peaks).toEqual(new Array<number>(16).fill(0));
  });

  test("a track that is not there is NOT_FOUND with the answer's old detail", async () => {
    const started = await startWith(null);

    expect(failed(await peaksOf(started.engine, "media-00000404", 0, 4_000, 16)).error).toEqual({ code: "NOT_FOUND", detail: "own music is not available yet" });
  });

  test("a media that is not a track is NOT_FOUND too", async () => {
    const started = await startWith(null, { mediaImporters: { audio: createMusicImporter({ minDurationMs: 0 }), photo: async () => ({ ok: true, facts: { width: 10, height: 10, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } }) } });
    const photo = await importTrack(started, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]), "p.jpg", "photo");

    expect(failed(await peaksOf(started.engine, photo, 0, 4_000, 16)).error.code).toBe("NOT_FOUND");
  });

  test("a deleted track is NOT_FOUND", async () => {
    const started = await startWith(null);
    const mediaId = await importTrack(started, LONG(), "long.wav");
    ok(await remove(started.engine, mediaId));

    expect(failed(await peaksOf(started.engine, mediaId, 0, 4_000, 16)).error.code).toBe("NOT_FOUND");
  });

  test("the contract's bounds still hold: 15 and 257 bars, and a zero window, are VALIDATION", async () => {
    const started = await startWith(null);
    const mediaId = await importTrack(started, LONG(), "long.wav");

    expect(failed(await peaksOf(started.engine, mediaId, 0, 4_000, 15)).error.code).toBe("VALIDATION");
    expect(failed(await peaksOf(started.engine, mediaId, 0, 4_000, 257)).error.code).toBe("VALIDATION");
    expect(failed(await peaksOf(started.engine, mediaId, 0, 0, 16)).error.code).toBe("VALIDATION");
  });
});

describe("media.delete while a render uses the track (the reserved provider is the render queue's)", () => {
  test("a RUNNING render refuses the delete with IN_FLIGHT, and the track stays; once the render is done the same delete goes through", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importTrack(started, LONG(), "long.wav");
    const { jobId } = await renderOf(started.engine, trackSpec(avatarId, photoIds.slice(0, 2), mediaId));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");

    expect(failed(await remove(started.engine, mediaId)).error.code).toBe("IN_FLIGHT");
    expect(await stored()).toHaveLength(2);
    expect(ok(await started.engine.handle(command("media.list", {}))).result).toMatchObject({ total: 1 });

    ffmpeg.open();
    expect((await jobEnd(started.events, jobId)).type).toBe("job.done");
    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
    expect(await stored()).toEqual([]);
  });

  test("a QUEUED render refuses it too, and so does the track of the render ahead of it", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const first = await importTrack(started, LONG(), "a.wav");
    const second = await importTrack(started, wavOf(10 * 8000, 8000), "b.wav");
    const running = await renderOf(started.engine, trackSpec(avatarId, [photoIds[0] ?? "", photoIds[1] ?? ""], first));
    const queued = await renderOf(started.engine, trackSpec(avatarId, [photoIds[2] ?? ""], second, 0, 4_000));
    await until(() => ffmpeg.started() > 0, "the first render's ffmpeg call");

    expect(failed(await remove(started.engine, second)).error.code).toBe("IN_FLIGHT");
    expect(failed(await remove(started.engine, first)).error.code).toBe("IN_FLIGHT");

    ffmpeg.open();
    await jobEnd(started.events, running.jobId);
    await jobEnd(started.events, queued.jobId);
    expect(ok(await remove(started.engine, second)).result).toEqual({ mediaId: second });
    expect(ok(await remove(started.engine, first)).result).toEqual({ mediaId: first });
  });

  test("a track that no render uses is deleted at once, and its file and record go", async () => {
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importTrack(started, "mp3");
    expect(await stored()).toHaveLength(2);

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
    expect(await stored()).toEqual([]);
  });

  test("a render that FAILS lets the track go", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const started = await startWith({
      run: async () => {
        throw new Error("ffmpeg broke");
      },
    });
    const mediaId = await importTrack(started, LONG(), "long.wav");
    const { jobId } = await renderOf(started.engine, trackSpec(avatarId, photoIds.slice(0, 2), mediaId));

    expect((await jobEnd(started.events, jobId)).type).toBe("job.failed");

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("a render the owner CANCELS lets the track go once it has stopped", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importTrack(started, LONG(), "long.wav");
    const { jobId } = await renderOf(started.engine, trackSpec(avatarId, photoIds.slice(0, 2), mediaId));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");

    ok(await started.engine.handle(command("videos.cancel", { jobId })));
    ffmpeg.open();
    expect((await jobEnd(started.events, jobId)).type).toMatch(/job\.(cancelled|done)/);

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("the track is held while the render's EXPORT CHECK hangs, before the render is submitted: the delete is IN_FLIGHT, and goes through once the check has failed the render", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    let hang = false;
    let asked: () => void = () => undefined;
    const exportCheckBegan = new Promise<void>((resolve) => (asked = resolve));
    const exportRootFs = {
      ...NODE_EXPORT_ROOT_FS,
      stat: (path: string) => {
        if (!hang) return NODE_EXPORT_ROOT_FS.stat(path);
        asked();
        return new Promise<never>(() => undefined);
      },
    };
    const started = await startWith(gatedFfmpeg(), { exportRootFs, exportCheckTimeoutMs: 600 });
    const mediaId = await importTrack(started, LONG(), "long.wav");

    hang = true;
    const rendering = started.engine.handle(command("videos.render", { spec: trackSpec(avatarId, photoIds.slice(0, 2), mediaId) }));
    // The export check is asked AFTER the admission has found the track and holds it, and before any job exists: only the admission's hold keeps it now.
    await exportCheckBegan;
    expect(failed(await remove(started.engine, mediaId)).error.code).toBe("IN_FLIGHT");

    expect(failed(await rendering).error.code).toBe("EXPORT_UNAVAILABLE");
    hang = false;
    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });
});

describe("an own track in a draft and a render, through the engine", () => {
  test("a render of a track that was deleted is MONTAGE_INVALID with media-unavailable at the music, and the draft says the same", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importTrack(started, LONG(), "long.wav");
    ok(await remove(started.engine, mediaId));

    const refusal = failed(await started.engine.handle(command("videos.render", { spec: trackSpec(avatarId, photoIds.slice(0, 2), mediaId) })));

    expect(refusal.error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] });
  });

  test("montages.get marks a deleted own track, a track too short for its start, and leaves a held one alone", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const kept = await importTrack(started, LONG(), "long.wav");
    const created = ok(await started.engine.handle(command("montages.create", { avatarId, photoIds: [] })));
    const montageId = (created.result as { montage: { montageId: string } }).montage.montageId;
    const saveWith = async (mediaId: string, startMs: number): Promise<unknown[]> => {
      ok(await started.engine.handle(command("montages.save", { montageId, spec: trackSpec(avatarId, photoIds.slice(0, 2), mediaId, startMs), name: "own" })));
      return ((ok(await started.engine.handle(command("montages.get", { montageId }))).result as { issues: unknown[] }).issues);
    };

    expect(await saveWith(kept, 0)).toEqual([]);
    expect(await saveWith(kept, 8_000)).toEqual([{ code: "track-too-short", path: ["music"] }]);
    expect(await saveWith("media-00000404", 0)).toEqual([{ code: "media-unavailable", path: ["music"] }]);
  });

  test("a track that is a photo is media-unavailable, never held", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const started = await startWith(gatedFfmpeg(), { mediaImporters: { audio: createMusicImporter({ minDurationMs: 0 }), photo: async () => ({ ok: true, facts: { width: 10, height: 10, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } }) } });
    const photo = await importTrack(started, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]), "p.jpg", "photo");

    const refusal = failed(await started.engine.handle(command("videos.render", { spec: trackSpec(avatarId, photoIds.slice(0, 2), photo) })));

    expect(refusal.error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] });
  });

  heavyTest(
    "a real render with an own track: the importer's M4A is read by the real chain, the file holds 48 kHz stereo AAC of the video's exact length, and the verifier is content",
    async () => {
      const { avatarId, photoIds } = await seedAvatar();
      const started = await startEngine(dir(), { init: { renderTmpDir: renderTmp(), settings: settingsOf() }, deps: { mediaImporters: { audio: createMusicImporter({ minDurationMs: 0 }) } } });
      await mkdir(exportDir(), { recursive: true });
      await started.engine.settled();
      const mediaId = await importTrack(started, LONG(), "long.wav");
      const { jobId } = await renderOf(started.engine, trackSpec(avatarId, photoIds.slice(0, 2), mediaId, 1_000));

      const end = await jobEnd(started.events, jobId);

      expect(end.type).toBe("job.done");
      const listed = ok(await started.engine.handle(command("videos.list", { avatarId }))).result as { videos: { relPath: string; music: unknown }[] };
      const video = listed.videos[0];
      expect(video?.music).toEqual({ title: "long.wav", artist: null, trackId: null });
      const file = join(exportDir(), video?.relPath ?? "missing");
      const audio = (await probeVideo(file)).streams.find((s) => s.codec_type === "audio");
      expect({ codec: audio?.codec_name, rate: audio?.sample_rate, channels: audio?.channels }).toEqual({ codec: "aac", rate: "48000", channels: 2 });
      expect((await verifyAndHashMp4(file, { frames: 120 })).result).toEqual({ ok: true });
      expect(await readdir(renderTmp())).toEqual([]);
    },
    180_000,
  );
});
