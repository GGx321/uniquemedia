import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFfmpegArgvOptions } from "../node/runFfmpeg";
import { heavyTest } from "../testing/bunTiers";
import { useNativeGlobals } from "../testing/nativeGlobals";
import type { PickedFileIdentity } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { EngineReply } from "./control";
import { createDecodeGate } from "./decode/decodeGate";
import { createWasmImageDecoder } from "./decode/wasmDecode";
import { createRealDecodeBackend } from "./decode/realBackend";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { pickedIdentityOf } from "./media/identity";
import { createPhotoImporter } from "./media/photoImporter";
import { quadrantPicture } from "./media/photoFixtures.testkit";
import { command, engineSettings, failed, GOOD, jobEnd, ok, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { acceptingVerify } from "./videos/testing/kit";
import { writingRun } from "./videos/testing/serviceKit";
useNativeGlobals();

// 3f.2 in the engine: an own photo imported by the REAL photo importer, used in a render, and what `media.delete` does while a render uses it
// (the 3f.1b review M-3: `EngineDeps.reservedMedia` is the render queue's reserved set). ffmpeg of the RENDER is scripted (a gate the test
// opens); the importer's own ffmpeg and the WASM decoders are real.

const dir = useEngineDir("studio-engine-own-photos-");
const renderTmp = () => join(dir(), "userData", "render-tmp");
const exportDir = () => join(dir(), "export");
const pickedDir = (): string => join(dir(), "picked");
const mediaFolder = (): string => join(dir(), "library", "media");
const NODE_MODULES_DIR = join(import.meta.dir, "../../node_modules");

/** The real WASM decode, in this thread: what these tests use where the decode itself is not the point (the engine's own entry uses a worker). */
function inThreadDecode(): ReturnType<typeof createWasmImageDecoder> {
  let decoder: Promise<ReturnType<typeof createWasmImageDecoder>> | undefined;
  return async (bytes, signal) => {
    decoder ??= createRealDecodeBackend(NODE_MODULES_DIR).then((backend) => createWasmImageDecoder(backend));
    return (await decoder)(bytes, signal);
  };
}

const settingsOf = () => engineSettings(dir(), { renderConcurrency: 1 });
type Started = Awaited<ReturnType<typeof startEngine>>;

async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("own") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
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

async function startWith(ffmpeg: { run: (opts: RunFfmpegArgvOptions) => Promise<void> }, extraDeps: Parameters<typeof startEngine>[1] extends infer O ? (O extends { deps?: infer D } ? D : never) : never = {}): Promise<Started> {
  await mkdir(exportDir(), { recursive: true });
  const started = await startEngine(dir(), {
    init: { renderTmpDir: renderTmp(), settings: settingsOf() },
    deps: {
      mediaImporters: { photo: createPhotoImporter({ decode: inThreadDecode() }) },
      videos: { renderOverrides: { verify: acceptingVerify, runDeps: { run: ffmpeg.run } } },
      ...extraDeps,
    },
  });
  await started.engine.settled();
  return started;
}

let calls = 0;
async function importPhoto(started: Started, name = "holiday.png", width = 40, height = 30): Promise<string> {
  await mkdir(pickedDir(), { recursive: true });
  const path = join(pickedDir(), name);
  await writeFile(path, await quadrantPicture(join(dir(), "fixtures"), name, width, height, "png"));
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  const callId = `call-${String(++calls).padStart(8, "0")}`;
  await started.engine.receive({ kind: "control", type: "media.import", callId, pick: "photo", path, name, expected });
  const reply = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
  if (reply === undefined || !reply.success || reply.data.mediaJobId === undefined) throw new Error("the import was not started");
  await started.engine.mediaSettled();
  const end = await jobEnd(started.events, reply.data.mediaJobId);
  expect(end.type).toBe("job.done");
  const listed = ok(await started.engine.handle(command("media.list", {}))).result as { media: { mediaId: string }[] };
  const mediaId = listed.media[0]?.mediaId;
  if (mediaId === undefined) throw new Error("nothing was stored");
  return mediaId;
}

const ownSpec = (avatarId: string, mediaIds: string[]) => ({
  schemaVersion: 1,
  avatarId,
  layers: [],
  music: null,
  seed: 7,
  clips: mediaIds.map((mediaId, i) => ({ clipId: `clip-0000000${i + 1}`, kind: "photo", cell: { photo: { source: "own", mediaId }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" })),
});

async function renderOf(engine: Started["engine"], spec: unknown): Promise<{ jobId: string }> {
  const answer = ok(await engine.handle(command("videos.render", { spec })));
  if (answer.type !== "videos.render") throw new Error(`expected videos.render, got ${answer.type}`);
  return answer.result;
}

const remove = (engine: Started["engine"], mediaId: string) => engine.handle(command("media.delete", { mediaId }));
const stored = async (): Promise<string[]> => (await readdir(mediaFolder()).catch(() => [])).filter((n) => n !== ".staging").sort();

describe("media.delete while a render uses the media (the reserved provider is the render queue's)", () => {
  test("a RUNNING render refuses the delete with IN_FLIGHT, and the media stays; once the render is done the same delete goes through", async () => {
    const avatarId = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importPhoto(started);
    const { jobId } = await renderOf(started.engine, ownSpec(avatarId, [mediaId, mediaId]));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");

    expect(failed(await remove(started.engine, mediaId)).error.code).toBe("IN_FLIGHT");
    expect(await stored()).toHaveLength(2);
    expect(ok(await started.engine.handle(command("media.list", {}))).result).toMatchObject({ total: 1 });

    ffmpeg.open();
    expect((await jobEnd(started.events, jobId)).type).toBe("job.done");
    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
    expect(await stored()).toEqual([]);
  });

  test("a QUEUED render refuses it too, and so does the media of the render ahead of it", async () => {
    const avatarId = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const first = await importPhoto(started, "a.png");
    const second = await importPhoto(started, "b.png", 50, 40);
    const running = await renderOf(started.engine, ownSpec(avatarId, [first, first]));
    const queued = await renderOf(started.engine, ownSpec(avatarId, [second, second]));
    await until(() => ffmpeg.started() > 0, "the first render's ffmpeg call");

    expect(failed(await remove(started.engine, second)).error.code).toBe("IN_FLIGHT");
    expect(failed(await remove(started.engine, first)).error.code).toBe("IN_FLIGHT");

    ffmpeg.open();
    await jobEnd(started.events, running.jobId);
    await jobEnd(started.events, queued.jobId);
    expect(ok(await remove(started.engine, second)).result).toEqual({ mediaId: second });
    expect(ok(await remove(started.engine, first)).result).toEqual({ mediaId: first });
  });

  test("a media that no render uses is deleted at once", async () => {
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importPhoto(started);
    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("a render that FAILS lets the media go", async () => {
    const avatarId = await seedAvatar();
    const started = await startWith({
      run: async () => {
        throw new Error("ffmpeg broke");
      },
    });
    const mediaId = await importPhoto(started);
    const { jobId } = await renderOf(started.engine, ownSpec(avatarId, [mediaId, mediaId]));

    expect((await jobEnd(started.events, jobId)).type).toBe("job.failed");

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("a render the owner CANCELS lets the media go once it has stopped", async () => {
    const avatarId = await seedAvatar();
    const ffmpeg = gatedFfmpeg();
    const started = await startWith(ffmpeg);
    const mediaId = await importPhoto(started);
    const { jobId } = await renderOf(started.engine, ownSpec(avatarId, [mediaId, mediaId]));
    await until(() => ffmpeg.started() > 0, "the render's first ffmpeg call");

    ok(await started.engine.handle(command("videos.cancel", { jobId })));
    ffmpeg.open();
    expect((await jobEnd(started.events, jobId)).type).toMatch(/job\.(cancelled|done)/);

    expect(ok(await remove(started.engine, mediaId)).result).toEqual({ mediaId });
  });

  test("a delete asked for a media that does not exist is NOT_FOUND, not IN_FLIGHT", async () => {
    const started = await startWith(gatedFfmpeg());
    expect(failed(await remove(started.engine, "media-00000404")).error.code).toBe("NOT_FOUND");
  });
});

describe("the owner's own photos in a draft and a render, through the engine", () => {
  test("a render of a media that was deleted is MONTAGE_INVALID with media-unavailable, and the draft says the same", async () => {
    const avatarId = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importPhoto(started);
    ok(await remove(started.engine, mediaId));

    const refusal = failed(await started.engine.handle(command("videos.render", { spec: ownSpec(avatarId, [mediaId, mediaId]) })));

    expect(refusal.error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0, "cell"] }, { code: "media-unavailable", path: ["clips", 1, "cell"] }] });
  });

  test("montages.get marks a deleted own photo and leaves a held one alone", async () => {
    const avatarId = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const kept = await importPhoto(started, "a.png");
    const gone = await importPhoto(started, "b.png", 50, 40);
    ok(await remove(started.engine, gone));
    const created = ok(await started.engine.handle(command("montages.create", { avatarId, photoIds: [] })));
    const montage = (created.result as { montage: { montageId: string; spec: unknown } }).montage;
    const saved = ok(await started.engine.handle(command("montages.save", { montageId: montage.montageId, spec: ownSpec(avatarId, [kept, gone]), name: "own" })));
    expect(saved.type).toBe("montages.save");

    const got = ok(await started.engine.handle(command("montages.get", { montageId: montage.montageId })));

    expect((got.result as { issues: unknown[] }).issues).toEqual([{ code: "media-unavailable", path: ["clips", 1, "cell"] }]);
  });

  test("montages.focus of an own photo with no face gate is no focus, and of a media that is not there is NOT_FOUND", async () => {
    const avatarId = await seedAvatar();
    const started = await startWith(gatedFfmpeg());
    const mediaId = await importPhoto(started);

    expect(ok(await started.engine.handle(command("montages.focus", { avatarId, photo: { source: "own", mediaId } }))).result).toEqual({ focus: null });
    expect(failed(await started.engine.handle(command("montages.focus", { avatarId, photo: { source: "own", mediaId: "media-00000404" } }))).error).toMatchObject({ code: "NOT_FOUND" });
  });

  heavyTest(
    "a real render of own photos: the importer's JPEG is read by the real ffmpeg and the video passes the verifier",
    async () => {
      const avatarId = await seedAvatar();
      const started = await startEngine(dir(), {
        init: { renderTmpDir: renderTmp(), settings: settingsOf() },
        deps: { mediaImporters: { photo: createPhotoImporter({ decode: inThreadDecode() }) } },
      });
      await mkdir(exportDir(), { recursive: true });
      await started.engine.settled();
      const mediaId = await importPhoto(started, "real.png", 720, 1280);
      const { jobId } = await renderOf(started.engine, ownSpec(avatarId, [mediaId, mediaId]));

      const end = await jobEnd(started.events, jobId);

      expect(end.type).toBe("job.done");
      expect(await readdir(renderTmp())).toEqual([]);
    },
    120_000,
  );
});

describe("the decode of an own photo runs in its own thread: the engine stays free, and a cancel ends it (3f.2 fix round 1, H1)", () => {
  /** A decode worker that takes the picture and never answers: a decode that is still running. It records that it was ended. */
  function hungWorker() {
    const state = { posted: 0, ended: 0, onPosted: () => undefined as void };
    const exits: ((code: number) => void)[] = [];
    const worker = {
      postMessage: () => {
        state.posted++;
        state.onPosted();
      },
      on: (event: string, listener: never) => {
        if (event === "exit") exits.push(listener as (code: number) => void);
        return worker;
      },
      terminate: async () => {
        state.ended++;
        for (const exit of exits) exit(1);
        return 1;
      },
    };
    return { state, worker };
  }

  async function startWithHungDecode() {
    const hung = hungWorker();
    const gate = createDecodeGate({ spawnWorker: () => hung.worker, idleRecycleMs: 60_000, timeoutMs: 600_000 });
    const started = await startWith(gatedFfmpeg(), { mediaImporters: { photo: createPhotoImporter({ decode: gate.decode }) } });
    return { started, hung };
  }

  async function startImport(started: Started, name: string): Promise<string> {
    await mkdir(pickedDir(), { recursive: true });
    const path = join(pickedDir(), name);
    await writeFile(path, await quadrantPicture(join(dir(), "fixtures"), name, 40, 30, "png"));
    const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
    const callId = `call-${String(++calls).padStart(8, "0")}`;
    await started.engine.receive({ kind: "control", type: "media.import", callId, pick: "photo", path, name, expected });
    const reply = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
    if (reply === undefined || !reply.success || reply.data.mediaJobId === undefined) throw new Error("the import was not started");
    return reply.data.mediaJobId;
  }

  test("while a decode is running an engine command answers", async () => {
    const { started, hung } = await startWithHungDecode();
    const jobId = await startImport(started, "slow.png");
    await until(() => hung.state.posted > 0, "the decode to be handed to its worker");

    const snapshot = ok(await started.engine.handle(command("engine.snapshot")));
    expect(snapshot.type).toBe("engine.snapshot");
    expect(ok(await started.engine.handle(command("media.list", {}))).result).toMatchObject({ total: 0 });

    ok(await started.engine.handle(command("media.cancelImport", { jobId })));
    await started.engine.mediaSettled();
  });

  test("media.cancelImport during the decode ends its worker, and the job ends cancelled within the grace window with nothing left staged", async () => {
    const { started, hung } = await startWithHungDecode();
    const jobId = await startImport(started, "slow.png");
    await until(() => hung.state.posted > 0, "the decode to be handed to its worker");

    ok(await started.engine.handle(command("media.cancelImport", { jobId })));
    await started.engine.mediaSettled();

    expect((await jobEnd(started.events, jobId)).type).toBe("job.cancelled");
    expect(hung.state.ended).toBe(1);
    expect(await readdir(join(mediaFolder(), ".staging")).catch(() => [])).toEqual([]);
    expect(await stored()).toEqual([]);
  });
});
