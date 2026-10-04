import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../node/runFfmpeg";
import { useNativeGlobals } from "../testing/nativeGlobals";
import type { PickedFileIdentity } from "../shared/engine";
import { inspectApng } from "../shared/stickers/apng";
import { manifestTraits } from "./avatars/records";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { pickedIdentityOf } from "./media/identity";
import { createStickerImporter } from "./media/stickerImporter";
import { flatGif } from "./media/stickerFixtures.testkit";
import { encodeStickerFrames } from "./stickers/encodeJob";
import { command, engineSettings, failed, GOOD, jobEnd, ok, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { acceptingVerify } from "./videos/testing/kit";
import { writingRun } from "./videos/testing/serviceKit";
useNativeGlobals();

// 3f.5 in the engine: an own sticker imported by the REAL sticker importer (real ffmpeg for the decode, the real encode job in this thread), used in a
// render, and what `media.delete` does while a render uses it (the 3f.1b review M-3: `EngineDeps.reservedMedia` is the render queue's reserved set).
// ffmpeg of the RENDER is scripted (a gate the test opens).

const dir = useEngineDir("studio-engine-own-stickers-");
const renderTmp = () => join(dir(), "userData", "render-tmp");
const exportDir = () => join(dir(), "export");
const pickedDir = (): string => join(dir(), "picked");
const mediaFolder = (): string => join(dir(), "library", "media");

/** The encode step in this thread: what the worker does, over a raw file read whole. */
const encodeHere = async (job: Parameters<Parameters<typeof createStickerImporter>[0]["encode"]>[0]): Promise<Uint8Array> => {
  const raw = readFileSync(job.rawPath);
  const frameBytes = job.width * job.height * 4;
  return encodeStickerFrames(job, (index, into) => into.set(raw.subarray(index * frameBytes, (index + 1) * frameBytes)));
};

const settingsOf = () => engineSettings(dir(), { renderConcurrency: 1 });
type Started = Awaited<ReturnType<typeof startEngine>>;

async function seedAvatar(): Promise<{ avatarId: string; photoId: string; otherPhotoId: string }> {
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
  return { avatarId: avatar.id, photoId: await eligible(1), otherPhotoId: await eligible(2) };
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

async function startWith(ffmpeg: { run: (opts: RunFfmpegArgvOptions) => Promise<void> }): Promise<Started> {
  await mkdir(exportDir(), { recursive: true });
  const started = await startEngine(dir(), {
    init: { renderTmpDir: renderTmp(), settings: settingsOf() },
    deps: {
      mediaImporters: { sticker: createStickerImporter({ encode: async (job) => encodeHere(job) }) },
      videos: { renderOverrides: { verify: acceptingVerify, runDeps: { run: ffmpeg.run } } },
    },
  });
  await started.engine.settled();
  return started;
}

let calls = 0;
/** Imports `bytes` as a sticker through the real `media.import` and job; the job's end event and the stored id. */
async function importSticker(started: Started, bytes: Uint8Array, name = "party.gif"): Promise<{ end: Awaited<ReturnType<typeof jobEnd>>; mediaId: string | undefined }> {
  await mkdir(pickedDir(), { recursive: true });
  const path = join(pickedDir(), name);
  await writeFile(path, bytes);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  const callId = `call-${String(++calls).padStart(8, "0")}`;
  await started.engine.receive({ kind: "control", type: "media.import", callId, pick: "sticker", path, name, expected });
  const reply = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
  if (reply === undefined || !reply.success || reply.data.mediaJobId === undefined) throw new Error("the import was not started");
  await started.engine.mediaSettled();
  const end = await jobEnd(started.events, reply.data.mediaJobId);
  const listed = ok(await started.engine.handle(command("media.list", { kind: "sticker" }))).result as { media: { mediaId: string }[] };
  return { end, mediaId: listed.media[0]?.mediaId };
}

async function importedSticker(started: Started, name = "party.gif"): Promise<string> {
  const { end, mediaId } = await importSticker(started, flatGif([0, 1, 2], [10, 10, 10]), name);
  expect(end.type).toBe("job.done");
  if (mediaId === undefined) throw new Error("nothing was stored");
  return mediaId;
}

const stickerSpec = (avatarId: string, photoId: string, mediaIds: string[]) => ({
  schemaVersion: 1,
  avatarId,
  layers: mediaIds.map((mediaId, i) => ({ layerId: `layer-0000000${i + 1}`, kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "own", mediaId }, x: 0.5, y: 0.5, size: 0.3 })),
  music: null,
  seed: 7,
  clips: [{ clipId: "clip-00000001", kind: "photo", cell: { photo: { source: "scene", photoId }, focus: null }, motion: "static", durationMs: 4_000, transitionIn: "cut" }],
});

async function renderOf(engine: Started["engine"], spec: unknown): Promise<{ jobId: string }> {
  const answer = ok(await engine.handle(command("videos.render", { spec })));
  if (answer.type !== "videos.render") throw new Error(`expected videos.render, got ${answer.type}`);
  return answer.result;
}

const remove = (engine: Started["engine"], mediaId: string) => engine.handle(command("media.delete", { mediaId }));
const stored = async (): Promise<string[]> => (await readdir(mediaFolder()).catch(() => [])).filter((n) => n !== ".staging").sort();

describe("an own sticker through the engine: the import", () => {
  test("a GIF becomes a stored APNG whose record has the canvas, the loop and the delays on the 30 fps grid", async () => {
    await seedAvatar();
    const started = await startWith(gatedFfmpeg());

    const { end, mediaId } = await importSticker(started, flatGif([0, 1, 2], [10, 10, 10], { width: 10, height: 6 }));

    expect(end.type).toBe("job.done");
    const listed = ok(await started.engine.handle(command("media.list", { kind: "sticker" }))).result as { media: Record<string, unknown>[] };
    expect(listed.media[0]).toMatchObject({ mediaId, kind: "sticker", name: "party.gif", width: 10, height: 6, loopFrames: 9, delayFrames: [3, 3, 3], durationMs: null, sourceFps: null });
    const file = (await stored()).find((name) => name.endsWith(".png"));
    expect(file).toBeDefined();
    const bytes = new Uint8Array(await readFile(join(mediaFolder(), file ?? "")));
    const inspected = inspectApng(bytes);
    expect(inspected.ok && [inspected.info.width, inspected.info.height, inspected.info.loopFrames]).toEqual([10, 6, 9]);
  });

  test("a still GIF is refused with the reason not-animated, and nothing is stored", async () => {
    await seedAvatar();
    const started = await startWith(gatedFfmpeg());

    const { end, mediaId } = await importSticker(started, flatGif([0], [10]));

    expect(end.type).toBe("job.failed");
    expect(JSON.stringify(end.payload)).toContain("not-animated");
    expect(mediaId).toBeUndefined();
    expect(await stored()).toEqual([]);
  });

  test("a hostile GIF (a frame outside the screen) is refused with the reason format", async () => {
    await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const { buildGif } = await import("../shared/stickers/gif.testkit");

    const { end } = await importSticker(started, buildGif({ width: 8, height: 8, frames: [{ x: 6, y: 6, width: 4, height: 4 }, {}] }));

    expect(end.type).toBe("job.failed");
    expect(JSON.stringify(end.payload)).toContain("format");
    expect(await stored()).toEqual([]);
  });
});

describe("media.delete while a render uses the sticker (the reserved provider is the render queue's)", () => {
  test("a RUNNING render refuses the delete with IN_FLIGHT, and the media stays; once the render is done the same delete goes through", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importedSticker(started);
    const { jobId } = await renderOf(started.engine, stickerSpec(avatarId, photoId, [mediaId]));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");

    expect(failed(await remove(started.engine, mediaId)).error.code).toBe("IN_FLIGHT");
    expect(await stored()).toHaveLength(2);
    expect(ok(await started.engine.handle(command("media.list", {}))).result).toMatchObject({ total: 1 });

    ffmpeg.open();
    expect((await jobEnd(started.events, jobId)).type).toBe("job.done");
    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
    expect(await stored()).toEqual([]);
  });

  test("a QUEUED render refuses it too, and so does the sticker of the render ahead of it", async () => {
    const { avatarId, photoId, otherPhotoId } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const first = await importedSticker(started, "a.gif");
    const second = await importedSticker(started, "b.gif");
    const running = await renderOf(started.engine, stickerSpec(avatarId, photoId, [first]));
    const queued = await renderOf(started.engine, stickerSpec(avatarId, otherPhotoId, [second]));
    await until(() => ffmpeg.started() > 0, "the first render's ffmpeg call");

    expect(failed(await remove(started.engine, second)).error.code).toBe("IN_FLIGHT");
    expect(failed(await remove(started.engine, first)).error.code).toBe("IN_FLIGHT");

    ffmpeg.open();
    await jobEnd(started.events, running.jobId);
    await jobEnd(started.events, queued.jobId);
    expect(ok(await remove(started.engine, second)).result).toEqual({ mediaId: second });
    expect(ok(await remove(started.engine, first)).result).toEqual({ mediaId: first });
  });

  test("a sticker that no render uses is deleted at once", async () => {
    await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importedSticker(started);
    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("a render that FAILS lets the sticker go", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const started = await startWith({
      run: async () => {
        throw new Error("ffmpeg broke");
      },
    });
    const mediaId = await importedSticker(started);
    const { jobId } = await renderOf(started.engine, stickerSpec(avatarId, photoId, [mediaId]));

    expect((await jobEnd(started.events, jobId)).type).toBe("job.failed");

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("a render the owner CANCELS lets the sticker go once it has stopped", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importedSticker(started);
    const { jobId } = await renderOf(started.engine, stickerSpec(avatarId, photoId, [mediaId]));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");

    ok(await started.engine.handle(command("videos.cancel", { jobId })));
    ffmpeg.open();
    expect((await jobEnd(started.events, jobId)).type).toMatch(/job\.(cancelled|done)/);

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });
});

describe("an own sticker in a draft and a render, through the engine", () => {
  test("a render of a sticker that was deleted is MONTAGE_INVALID with media-unavailable at its layer, and the draft says the same", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importedSticker(started);
    ok(await remove(started.engine, mediaId));

    const refusal = failed(await started.engine.handle(command("videos.render", { spec: stickerSpec(avatarId, photoId, [mediaId]) })));

    expect(refusal.error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["layers", 0, "sticker"] }] });
  });

  test("montages.get marks a deleted own sticker and leaves a held one alone", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const kept = await importedSticker(started, "a.gif");
    const gone = await importedSticker(started, "b.gif");
    ok(await remove(started.engine, gone));
    const created = ok(await started.engine.handle(command("montages.create", { avatarId, photoIds: [photoId] })));
    const montage = (created.result as { montage: { montageId: string } }).montage;
    const saved = ok(await started.engine.handle(command("montages.save", { montageId: montage.montageId, spec: stickerSpec(avatarId, photoId, [kept, gone]), name: "own" })));
    expect(saved.type).toBe("montages.save");

    const got = ok(await started.engine.handle(command("montages.get", { montageId: montage.montageId })));

    expect((got.result as { issues: unknown[] }).issues).toEqual([{ code: "media-unavailable", path: ["layers", 1, "sticker"] }]);
  });

  test("an own PHOTO's media id used as a sticker is not a sticker: media-unavailable", async () => {
    const { avatarId, photoId } = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const refusal = failed(await started.engine.handle(command("videos.render", { spec: stickerSpec(avatarId, photoId, ["media-00000404"]) })));
    expect(refusal.error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["layers", 0, "sticker"] }] });
  });
});
