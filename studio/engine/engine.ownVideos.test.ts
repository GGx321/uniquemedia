import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../node/runFfmpeg";
import { useNativeGlobals } from "../testing/nativeGlobals";
import type { PickedFileIdentity } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { pickedIdentityOf } from "./media/identity";
import { FIXTURES } from "./media/video/testing/fixtures/index";
import { createVideoImporter } from "./media/videoImporter";
import { command, engineSettings, failed, GOOD, jobEnd, ok, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { acceptingVerify } from "./videos/testing/kit";
import { writingRun } from "./videos/testing/serviceKit";
useNativeGlobals();
setDefaultTimeout(120_000);

// 3f.3b in the engine: an own video imported by the REAL video importer (real ffmpeg: the mezzanine), judged in a draft and a render, and what `media.delete` does while a
// render uses it (the 3f.1b review M-3: `EngineDeps.reservedMedia` is the render queue's reserved set, wired here for video). ffmpeg of the RENDER is scripted (a gate the
// test opens); the mezzanine is still copied, verified and streamed, for real, into the job's folder before it.

const dir = useEngineDir("studio-engine-own-videos-");
const renderTmp = () => join(dir(), "userData", "render-tmp");
const exportDir = () => join(dir(), "export");
const pickedDir = (): string => join(dir(), "picked");
const mediaFolder = (): string => join(dir(), "library", "media");
type Started = Awaited<ReturnType<typeof startEngine>>;

async function seedAvatar(photos = 2): Promise<{ avatarId: string; photoId: string; otherPhotoId: string; photoIds: string[] }> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("own") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const base = samplePhotoMeta().source;
  if (base.kind !== "generated") throw new Error("expected a generated sample source");
  const eligible = async (n: number): Promise<string> => {
    const source = { ...base, category: "home", attemptId: `run-00000001:slot-${n}#1`, slot: `slot-${n}` };
    return (await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source, qa: { age: { adult: true, confidence: 0.95 } } }))).id;
  };
  const photoIds: string[] = [];
  for (let n = 1; n <= photos; n++) photoIds.push(await eligible(n));
  return { avatarId: avatar.id, photoId: photoIds[0] ?? "", otherPhotoId: photoIds[1] ?? "", photoIds };
}

/** A render's ffmpeg that waits for `open()`, then writes its output as a good one would. */
function gatedFfmpeg(): { run: (opts: RunFfmpegArgvOptions) => Promise<void>; open: () => void; started: () => number; calls: string[][] } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const calls: string[][] = [];
  return {
    open,
    calls,
    started: () => calls.length,
    run: async (opts) => {
      calls.push([...opts.argv]);
      await gate;
      await writingRun(opts);
    },
  };
}

async function startWith(ffmpeg: { run: (opts: RunFfmpegArgvOptions) => Promise<void> }): Promise<Started> {
  await mkdir(exportDir(), { recursive: true });
  const started = await startEngine(dir(), {
    init: { renderTmpDir: renderTmp(), settings: engineSettings(dir(), { renderConcurrency: 1 }) },
    deps: {
      mediaImporters: { video: createVideoImporter() },
      videos: { renderOverrides: { verify: acceptingVerify, runDeps: { run: ffmpeg.run } } },
    },
  });
  await started.engine.settled();
  return started;
}

let calls = 0;
/** Imports a committed fixture as an own video through the real `media.import` and job; the job's end event and the stored id. */
async function importVideo(started: Started, fixture: keyof typeof FIXTURES = "h264-bframes.mp4", name = "holiday.mp4"): Promise<{ end: Awaited<ReturnType<typeof jobEnd>>; mediaId: string | undefined }> {
  await mkdir(pickedDir(), { recursive: true });
  const path = join(pickedDir(), name);
  await copyFile(FIXTURES[fixture].file, path);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  const callId = `call-${String(++calls).padStart(8, "0")}`;
  await started.engine.receive({ kind: "control", type: "media.import", callId, pick: "video", path, name, expected });
  const reply = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
  if (reply === undefined || !reply.success || reply.data.mediaJobId === undefined) throw new Error("the import was not started");
  await started.engine.mediaSettled();
  const end = await jobEnd(started.events, reply.data.mediaJobId);
  const listed = ok(await started.engine.handle(command("media.list", { kind: "video" }))).result as { media: { mediaId: string; name: string }[] };
  return { end, mediaId: listed.media.find((m) => m.name === name)?.mediaId };
}

async function importedVideo(started: Started, name = "holiday.mp4"): Promise<string> {
  const { end, mediaId } = await importVideo(started, "h264-bframes.mp4", name);
  expect(end.type).toBe("job.done");
  if (mediaId === undefined) throw new Error("nothing was stored");
  return mediaId;
}

/** A 2 s scene-photo clip, then a 2 s own video clip of `mediaId` (the mezzanine of `h264-bframes.mp4` is 2 s). */
const videoSpec = (avatarId: string, photoId: string, mediaId: string, video: { trimStartMs?: number; durationMs?: number } = {}) => ({
  schemaVersion: 1,
  avatarId,
  layers: [],
  music: null,
  seed: 7,
  clips: [
    { clipId: "clip-00000001", kind: "photo", cell: { photo: { source: "scene", photoId }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" },
    { clipId: "clip-00000002", kind: "video", mediaId, trimStartMs: video.trimStartMs ?? 0, focus: null, durationMs: video.durationMs ?? 2_000, transitionIn: "cut" },
  ],
});

async function renderOf(engine: Started["engine"], spec: unknown): Promise<{ jobId: string }> {
  const answer = ok(await engine.handle(command("videos.render", { spec })));
  if (answer.type !== "videos.render") throw new Error(`expected videos.render, got ${answer.type}`);
  return answer.result;
}

const remove = (engine: Started["engine"], mediaId: string) => engine.handle(command("media.delete", { mediaId }));
const stored = async (): Promise<string[]> => (await readdir(mediaFolder()).catch(() => [])).filter((n) => n !== ".staging").sort();

describe("an own video through the engine: the import", () => {
  test("a clip becomes a stored mezzanine whose record has its size, its length in ms and its source rate", async () => {
    await seedAvatar();
    const started = await startWith(gatedFfmpeg());

    const { end, mediaId } = await importVideo(started);

    expect(end.type).toBe("job.done");
    const listed = ok(await started.engine.handle(command("media.list", { kind: "video" }))).result as { media: Record<string, unknown>[] };
    expect(listed.media[0]).toMatchObject({ mediaId, kind: "video", name: "holiday.mp4", width: 128, height: 72, durationMs: 2_000, sourceFps: 30, hdrToSdr: false, loopFrames: null });
    expect((await stored()).filter((n) => n.endsWith(".mp4"))).toHaveLength(1);
  });
});

describe("media.delete while a render uses the video (the reserved provider is the render queue's)", () => {
  test("a RUNNING render refuses the delete with IN_FLIGHT, and the media stays; once the render is done the same delete goes through", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importedVideo(started);
    const { jobId } = await renderOf(started.engine, videoSpec(avatarId, photoId, mediaId));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");

    expect(failed(await remove(started.engine, mediaId)).error.code).toBe("IN_FLIGHT");
    expect(await stored()).toHaveLength(2);
    expect(ok(await started.engine.handle(command("media.list", {}))).result).toMatchObject({ total: 1 });

    ffmpeg.open();
    expect((await jobEnd(started.events, jobId)).type).toBe("job.done");
    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
    expect(await stored()).toEqual([]);
  });

  test("a QUEUED render refuses it too, and so does the video of the render ahead of it", async () => {
    const { avatarId, photoId, otherPhotoId } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const first = await importedVideo(started, "a.mp4");
    const second = await importedVideo(started, "b.mp4");
    const running = await renderOf(started.engine, videoSpec(avatarId, photoId, first));
    const queued = await renderOf(started.engine, videoSpec(avatarId, otherPhotoId, second));
    await until(() => ffmpeg.started() > 0, "the first render's ffmpeg call");

    expect(failed(await remove(started.engine, second)).error.code).toBe("IN_FLIGHT");
    expect(failed(await remove(started.engine, first)).error.code).toBe("IN_FLIGHT");

    ffmpeg.open();
    await jobEnd(started.events, running.jobId);
    await jobEnd(started.events, queued.jobId);
    expect(ok(await remove(started.engine, second)).result).toEqual({ mediaId: second });
    expect(ok(await remove(started.engine, first)).result).toEqual({ mediaId: first });
  });

  test("a video that no render uses is deleted at once", async () => {
    await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importedVideo(started);
    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
    expect(await stored()).toEqual([]);
  });

  test("a render that FAILS lets the video go", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const started = await startWith({
      run: async () => {
        throw new Error("ffmpeg broke");
      },
    });
    const mediaId = await importedVideo(started);
    const { jobId } = await renderOf(started.engine, videoSpec(avatarId, photoId, mediaId));

    expect((await jobEnd(started.events, jobId)).type).toBe("job.failed");

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("a render the owner CANCELS lets the video go once it has stopped", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importedVideo(started);
    const { jobId } = await renderOf(started.engine, videoSpec(avatarId, photoId, mediaId));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");

    ok(await started.engine.handle(command("videos.cancel", { jobId })));
    ffmpeg.open();
    expect((await jobEnd(started.events, jobId)).type).toMatch(/job\.(cancelled|done)/);

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("a delete and a render asked at the same moment are never both granted: either the render holds the video and the delete is IN_FLIGHT, or the video is gone and the render is refused", async () => {
    const orders = ["render-first", "delete-first", "render-first", "delete-first", "delete-first", "render-first"] as const;
    const { avatarId, photoIds } = await seedAvatar(orders.length);
    // A render that ends at once, so the rounds do not wait for one another.
    const started = await startWith({ run: writingRun });
    for (const [round, order] of orders.entries()) {
      const mediaId = await importedVideo(started, `race-${round}.mp4`);
      const spec = videoSpec(avatarId, photoIds[round] ?? "", mediaId);
      const asked = order === "render-first" ? [started.engine.handle(command("videos.render", { spec })), remove(started.engine, mediaId)] : [remove(started.engine, mediaId), started.engine.handle(command("videos.render", { spec }))];
      const [first, second] = await Promise.all(asked);
      const render = order === "render-first" ? first : second;
      const deletion = order === "render-first" ? second : first;
      if (render === undefined || deletion === undefined) throw new Error("no answer");
      // Exactly one of the two was granted.
      expect([render.ok, deletion.ok].filter(Boolean)).toHaveLength(1);
      if (render.ok) {
        expect(failed(deletion).error.code).toBe("IN_FLIGHT");
        const answer = ok(render);
        if (answer.type !== "videos.render") throw new Error("expected videos.render");
        await jobEnd(started.events, answer.result.jobId);
      } else {
        expect(failed(render).error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 1] }] });
        expect(ok(deletion).result).toEqual({ mediaId });
      }
    }
  });
});

describe("an own video in a draft and a render, through the engine", () => {
  test("a render of a video that was deleted is MONTAGE_INVALID with media-unavailable at its clip", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importedVideo(started);
    ok(await remove(started.engine, mediaId));

    const refusal = failed(await started.engine.handle(command("videos.render", { spec: videoSpec(avatarId, photoId, mediaId) })));

    expect(refusal.error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 1] }] });
  });

  test("a clip that asks past the end of the stored video is MONTAGE_INVALID with video-too-short, never a shorter clip", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importedVideo(started);

    // The mezzanine is 2.0 s: a clip of 2.0 s from 0.1 s ends 0.1 s past it.
    const refusal = failed(await started.engine.handle(command("videos.render", { spec: videoSpec(avatarId, photoId, mediaId, { trimStartMs: 100, durationMs: 2_000 }) })));

    expect(refusal.error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "video-too-short", path: ["clips", 1] }] });
    expect(ffmpeg.started()).toBe(0);
  });

  test("a clip that ends exactly at the end of the stored video renders: the job copies the mezzanine, ffmpeg reads the copy and never the library file", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importedVideo(started);
    const { jobId } = await renderOf(started.engine, videoSpec(avatarId, photoId, mediaId, { trimStartMs: 0, durationMs: 2_000 }));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");
    ffmpeg.open();

    expect((await jobEnd(started.events, jobId)).type).toBe("job.done");
    const everything = ffmpeg.calls.flat();
    expect(everything.some((arg) => arg.endsWith(`own-${mediaId}.mp4`))).toBe(true);
    expect(everything.some((arg) => arg.startsWith(mediaFolder()))).toBe(false);
  });

  test("montages.get marks a deleted own video and a clip that is too long for its video, and leaves a good one alone", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const kept = await importedVideo(started, "a.mp4");
    const gone = await importedVideo(started, "b.mp4");
    ok(await remove(started.engine, gone));
    const created = ok(await started.engine.handle(command("montages.create", { avatarId, photoIds: [photoId] })));
    const montage = (created.result as { montage: { montageId: string } }).montage;
    const base = videoSpec(avatarId, photoId, kept);
    const spec = { ...base, clips: [...base.clips, { clipId: "clip-00000003", kind: "video", mediaId: gone, trimStartMs: 0, focus: null, durationMs: 1_000, transitionIn: "cut" }, { clipId: "clip-00000004", kind: "video", mediaId: kept, trimStartMs: 1_000, focus: null, durationMs: 2_000, transitionIn: "cut" }] };
    expect(ok(await started.engine.handle(command("montages.save", { montageId: montage.montageId, spec, name: "own" }))).type).toBe("montages.save");

    const got = ok(await started.engine.handle(command("montages.get", { montageId: montage.montageId })));

    expect((got.result as { issues: unknown[] }).issues).toEqual([
      { code: "media-unavailable", path: ["clips", 2] },
      { code: "video-too-short", path: ["clips", 3] },
    ]);
  });

  test("an own PHOTO's media id used as a video clip is not a video: media-unavailable", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const refusal = failed(await started.engine.handle(command("videos.render", { spec: videoSpec(avatarId, photoId, "media-00000404") })));
    expect(refusal.error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 1] }] });
  });
});
