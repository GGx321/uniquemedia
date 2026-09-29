import { afterEach, describe, expect, test } from "bun:test";
import { configureFfmpegEnv, configuredFfmpegEnv } from "../node/ffmpegEnv";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhotoSummary, RenderResult } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import type { RenderContext, RenderSubmission } from "./renderQueue/queue";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { command, engineSettings, failed, GOOD, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Task 3a.6 in the engine: it owns one render queue. It sweeps render-tmp
// when it starts, its queued and running renders show in the snapshot, block a
// library switch, and reserve their photos; the pool's size comes from the
// settings. `videos.render` itself is not wired yet (3a.8b).

const dir = useEngineDir("studio-engine-renders-");
const renderTmp = () => join(dir(), "userData", "render-tmp");

function result(n: number, avatarId: string): RenderResult {
  return { kind: "render", videoId: `video-0000000${n}`, avatarId, bytes: 1000, durationMs: 4000, videoKind: "photo", relPath: "Mia/2026-09-29_photo_001.mp4" };
}

/** A render job the test ends by hand. */
function job(n: number, avatarId: string, photoIds: string[] = []): RenderSubmission & { finish(): void; context: () => RenderContext } {
  let finish: () => void = () => {};
  let ctx: RenderContext | undefined;
  const done = new Promise<RenderResult>((resolve) => {
    finish = () => resolve(result(n, avatarId));
  });
  return {
    jobId: `job-0000000${n}`,
    ref: { videoId: `video-0000000${n}`, avatarId, montageId: null },
    totalFrames: 120,
    photoIds,
    execute: (c) => {
      ctx = c;
      return done;
    },
    finish,
    context: () => {
      if (ctx === undefined) throw new Error("not started");
      return ctx;
    },
  };
}

async function seedAvatar(count: number): Promise<{ avatarId: string; photoIds: string[] }> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("render") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const photoIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = samplePhotoMeta().source;
    if (base.kind !== "generated") throw new Error("expected a generated sample source");
    const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...base, category: "home", attemptId: `run-00000001:slot-${i + 1}#1`, slot: `slot-${i + 1}` }, qa: { age: { adult: true, confidence: 0.95 } } }));
    photoIds.push(photo.id);
  }
  return { avatarId: avatar.id, photoIds };
}

async function listPhotos(engine: Awaited<ReturnType<typeof startEngine>>["engine"], avatarId: string): Promise<PhotoSummary[]> {
  const answer = ok(await engine.handle(command("photos.list", { avatarId })));
  if (answer.type !== "photos.list") throw new Error(`expected photos.list, got ${answer.type}`);
  return answer.result.photos;
}

describe("the engine sweeps render-tmp when it starts", () => {
  test("removes the job folders a crash left behind", async () => {
    await mkdir(join(renderTmp(), "job-00000009"), { recursive: true });
    await writeFile(join(renderTmp(), "job-00000009", "clip-00.mkv"), "half a clip");
    await writeFile(join(renderTmp(), "stray.tmp"), "x");

    await startEngine(dir(), { init: { renderTmpDir: renderTmp() } });

    expect(await readdir(renderTmp())).toEqual([]);
  });

  test("starts anyway when the folder cannot be swept", async () => {
    await mkdir(join(dir(), "userData"), { recursive: true });
    await writeFile(renderTmp(), "a file where the folder should be");

    const { engine } = await startEngine(dir(), { init: { renderTmpDir: renderTmp() } });

    expect(ok(await engine.handle(command("engine.snapshot"))).type).toBe("engine.snapshot");
  });

  test("starts when the folder does not exist yet, and when main names none", async () => {
    await startEngine(dir(), { init: { renderTmpDir: renderTmp() } });
    await startEngine(dir());
  });
});

/** One render at a time, so what is queued and what runs does not depend on the machine «Авто» runs on. */
const ONE_AT_A_TIME = () => ({ settings: engineSettings(dir(), { renderConcurrency: 1 }) });

describe("the engine hands ffmpeg its environment", () => {
  afterEach(() => configureFfmpegEnv(undefined));

  test("configures every ffmpeg child from the init's ffmpegEnv, through the allowlist", async () => {
    await startEngine(dir(), { init: { ffmpegEnv: { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-secret" } } });

    expect(configuredFfmpegEnv()).toEqual({ PATH: "/usr/bin" });
  });

  test("leaves the configuration alone when main sent none", async () => {
    configureFfmpegEnv({ PATH: "/before" });

    await startEngine(dir());

    expect(configuredFfmpegEnv()).toEqual({ PATH: "/before" });
  });
});

describe("the engine's render queue, review round 1", () => {
  test("avatars.cancel does not stop a render: it answers NOT_FOUND, as for an unknown id, and the render goes on", async () => {
    const { avatarId } = await seedAvatar(0);
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { renderConcurrency: 1 }) } });
    engine.renders.submit(job(1, avatarId));

    const answer = failed(await engine.handle(command("avatars.cancel", { jobId: "job-00000001" })));

    expect(answer.error.code).toBe("NOT_FOUND");
    expect(engine.renders.states().map((j) => j.status)).toEqual(["running"]);
  });

  test("raising the render concurrency in the settings starts the waiting jobs at once", async () => {
    const { avatarId } = await seedAvatar(0);
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { renderConcurrency: 1 }) } });
    engine.renders.submit(job(1, avatarId));
    engine.renders.submit(job(2, avatarId));
    expect(engine.renders.states().map((j) => j.status)).toEqual(["running", "queued"]);

    await engine.applyControl({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { renderConcurrency: 2 }) });

    expect(engine.renders.states().map((j) => j.status)).toEqual(["running", "running"]);
  });
});

describe("the engine's render queue", () => {
  test("lists queued and running renders in the snapshot", async () => {
    const { avatarId } = await seedAvatar(0);
    const { engine } = await startEngine(dir(), { init: ONE_AT_A_TIME() });
    engine.renders.submit(job(1, avatarId));
    engine.renders.submit(job(2, avatarId));

    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error("expected a snapshot");

    expect(snapshot.result.jobs.map((j) => `${j.kind}:${j.status}`)).toEqual(["render:running", "render:queued"]);
  });

  test("a library switch is refused with IN_FLIGHT while a render is queued or running, and allowed once they end", async () => {
    const { avatarId } = await seedAvatar(0);
    const { engine, posted } = await startEngine(dir(), { init: ONE_AT_A_TIME() });
    await mkdir(join(dir(), "other"));
    const open = (callId: string) => ({ kind: "control", type: "library.open", callId, path: join(dir(), "other") });
    const running = job(1, avatarId);
    engine.renders.submit(running);
    engine.renders.submit(job(2, avatarId));

    await engine.receive(open("call-00000001"));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });

    engine.renders.cancel("job-00000002");
    await engine.receive(open("call-00000002"));
    expect(posted.at(-1)).toMatchObject({ callId: "call-00000002", error: { code: "IN_FLIGHT" } }); // still one running

    engine.renders.cancel("job-00000001");
    running.finish();
    await engine.renders.idle();
    await engine.receive(open("call-00000003"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000003" });
  });

  test("provides the library's reserved photos: queued and running specs hold theirs, until they end", async () => {
    const { avatarId, photoIds } = await seedAvatar(3);
    const { engine } = await startEngine(dir(), { init: ONE_AT_A_TIME() });
    const [p1, p2, p3] = photoIds;
    engine.renders.submit(job(1, avatarId, [p1 ?? ""]));
    engine.renders.submit(job(2, avatarId, [p2 ?? ""]));

    const held = await listPhotos(engine, avatarId);
    expect(held.filter((p) => p.reserved).map((p) => p.photoId).sort()).toEqual([p1 ?? "", p2 ?? ""].sort());
    expect(held.find((p) => p.photoId === p3)).toMatchObject({ reserved: false, eligible: true });

    engine.renders.cancel("job-00000002");
    expect((await listPhotos(engine, avatarId)).filter((p) => p.reserved).map((p) => p.photoId)).toEqual([p1 ?? ""]);
  });

  test("an injected reserved provider still wins, for tests of the library's own rule", async () => {
    const { avatarId, photoIds } = await seedAvatar(2);
    const { engine } = await startEngine(dir(), { deps: { reservedPhotos: () => new Set([photoIds[1] ?? ""]) } });
    engine.renders.submit(job(1, avatarId, [photoIds[0] ?? ""]));

    const photos = await listPhotos(engine, avatarId);

    expect(photos.filter((p) => p.reserved).map((p) => p.photoId)).toEqual([photoIds[1] ?? ""]);
  });

  test("runs as many renders at once as the setting says", async () => {
    const { avatarId } = await seedAvatar(0);
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { renderConcurrency: 2 }) } });
    for (const n of [1, 2, 3]) engine.renders.submit(job(n, avatarId));

    const statuses = engine.renders.states().map((j) => j.status);

    expect(statuses).toEqual(["running", "running", "queued"]);
  });

  test("«Авто» runs at least one render at once, whatever the machine", async () => {
    const { avatarId } = await seedAvatar(0);
    const { engine } = await startEngine(dir());
    engine.renders.submit(job(1, avatarId));

    expect(engine.renders.states().map((j) => j.status)).toEqual(["running"]);
  });
});
