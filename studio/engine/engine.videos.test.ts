import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PhotoSummary, VideoSummary } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { formatExportDate } from "./exportName";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { videoPaths } from "./videos/record";
import { CrashError, faultyFs, listTree } from "./videos/testing/kit";
import { command, engineSettings, failed, GOOD, jobEnd, NOW, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3a.8b.2 end to end in the engine: `videos.render` of a REAL spec (two 2 s photo clips, the shortest a spec may be, 4 s)
// through the real runner, verifier and commit; its events, its record, `videos.list`, `videos.delete`; a crash and a
// restart settled by the recovery the library opening starts; and the lifecycle around it. Only ffmpeg's input photos
// are fixtures; the focus resolver runs with no face gate (the stand-in point), as an engine whose models did not load does.

const dir = useEngineDir("studio-engine-videos-");
const renderTmp = () => join(dir(), "userData", "render-tmp");
const exportDir = () => join(dir(), "export");
const FIXTURES = join(import.meta.dir, "face/fixtures/images");
const PHOTO_FILES = ["render-best-home-1.jpg", "render-median-travel-2.jpg", "render-worst-fitness-3.jpg"];
const REAL_RENDER_TIMEOUT_MS = 90_000;

/** One render at a time, so the second of two is queued whatever machine «Авто» would pick for. */
const settingsOf = (patch: Parameters<typeof engineSettings>[1] = {}) => engineSettings(dir(), { renderConcurrency: 1, ...patch });

/** An avatar with a master and three scene photos that are real 720x1280 JPEGs, seeded before the engine opens the library. */
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
    const photo = await library.addPhoto(avatar.id, bytes, samplePhotoMeta({ mediaType: "image/jpeg", width: 720, height: 1280, source: { ...base, category: "home", attemptId: `run-00000001:slot-${i + 1}#1`, slot: `slot-${i + 1}` }, qa: { age: { adult: true, confidence: 0.95 } } }));
    photoIds.push(photo.id);
  }
  return { avatarId: avatar.id, photoIds };
}

function specOf(avatarId: string, photoIds: readonly string[], clipMs = 2_000) {
  return {
    schemaVersion: 1,
    avatarId,
    layers: [],
    music: null,
    seed: 7,
    clips: photoIds.map((photoId, i) => ({ clipId: `clip-0000000${i + 1}`, kind: "photo", cell: { photo: { source: "scene", photoId }, focus: null }, motion: "static", durationMs: clipMs, transitionIn: "cut" })),
  };
}

type Started = Awaited<ReturnType<typeof startEngine>>;

const start = (over: Parameters<typeof startEngine>[1] = {}): Promise<Started> =>
  startEngine(dir(), { ...over, init: { renderTmpDir: renderTmp(), ...over.init }, deps: { ...over.deps } });

async function listVideos(engine: Started["engine"], avatarId: string): Promise<VideoSummary[]> {
  const answer = ok(await engine.handle(command("videos.list", { avatarId })));
  if (answer.type !== "videos.list") throw new Error(`expected videos.list, got ${answer.type}`);
  return answer.result.videos;
}

async function listPhotos(engine: Started["engine"], avatarId: string): Promise<PhotoSummary[]> {
  const answer = ok(await engine.handle(command("photos.list", { avatarId })));
  if (answer.type !== "photos.list") throw new Error(`expected photos.list, got ${answer.type}`);
  return answer.result.photos;
}

async function render(engine: Started["engine"], spec: unknown): Promise<{ jobId: string; videoId: string }> {
  const answer = ok(await engine.handle(command("videos.render", { spec })));
  if (answer.type !== "videos.render") throw new Error(`expected videos.render, got ${answer.type}`);
  return answer.result;
}

describe("a real render through videos.render", () => {
  test(
    "renders, commits and announces: job events, the record, videos.list present, the photos used, then videos.delete undoes it",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      const { engine, events } = await start({ init: { settings: settingsOf() } });
      await engine.settled();

      const { jobId, videoId } = await render(engine, specOf(avatarId, photoIds.slice(0, 2)));
      const end = await jobEnd(events, jobId);

      // The job's events, in order, and never a raw cause
      expect(end.type).toBe("job.done");
      const ofJob = events().filter((e) => "jobId" in e.payload && e.payload.jobId === jobId);
      expect(ofJob[0]?.type).toBe("job.progress");
      expect(ofJob[0]?.payload).toMatchObject({ kind: "render", jobId, videoId, avatarId, montageId: null, done: 0, total: 120 });
      const dones = ofJob.flatMap((e) => (e.type === "job.progress" ? [e.payload.done] : []));
      expect(dones).toEqual([...dones].sort((a, b) => a - b));
      expect(Math.max(...dones)).toBeLessThan(120);
      const relPath = `Mia/${formatExportDate(new Date(NOW))}_photo_001.mp4`;
      expect(end.payload).toMatchObject({ jobId, result: { kind: "render", videoId, avatarId, durationMs: 4000, videoKind: "photo", relPath } });
      const kinds = events().map((e) => e.type);
      expect(kinds.indexOf("video.changed")).toBeLessThan(kinds.indexOf("job.done"));
      // nothing about a job or a video names the owner's folders (the settings event legitimately does)
      const aboutRender = events().filter((e) => e.type.startsWith("job.") || e.type === "video.changed");
      expect(aboutRender.length).toBeGreaterThan(3);
      expect(JSON.stringify(aboutRender)).not.toContain(dir());

      // The file, once, in the export folder; the record in the library
      const file = join(exportDir(), relPath);
      expect(statSync(file).size).toBeGreaterThan(1000);
      expect(await listTree(videoPaths(join(dir(), "library"), avatarId).videosDir)).toEqual([`${videoId}.json`]); // and no intent left in .pending
      expect(await readdir(join(exportDir(), "Mia"))).toEqual([relPath.slice("Mia/".length)]);

      // videos.list: present, with the contract's fields
      const [video] = await listVideos(engine, avatarId);
      expect(video).toMatchObject({ videoId, avatarId, kind: "photo", durationMs: 4000, relPath, fileState: "present", montageId: null, photoCount: 2, music: null, hasPoster: false, bytes: statSync(file).size });

      // The photos are used, the third one is not
      const photos = await listPhotos(engine, avatarId);
      expect(photos.filter((p) => p.used).map((p) => p.photoId).sort()).toEqual(photoIds.slice(0, 2).sort());

      // A cancel of a job that has ended is ok, and changes nothing
      ok(await engine.handle(command("videos.cancel", { jobId })));
      expect(await listVideos(engine, avatarId)).toHaveLength(1);

      // videos.delete: the file, the record, the used marks, and the announcement
      const before = events().length;
      ok(await engine.handle(command("videos.delete", { videoId })));
      expect(existsSync(file)).toBe(false);
      expect(await listVideos(engine, avatarId)).toEqual([]);
      expect((await listPhotos(engine, avatarId)).filter((p) => p.used)).toEqual([]);
      expect(events().slice(before).map((e) => [e.type, e.payload])).toContainEqual(["video.changed", { change: "removed", videoId, avatarId }]);
    },
    REAL_RENDER_TIMEOUT_MS,
  );

  test("a photo used by that video is refused for the next render until the video is deleted", async () => {
    await mkdir(exportDir());
    const { avatarId, photoIds } = await seedAvatar();
    const { engine, events } = await start({ init: { settings: settingsOf() } });
    const first = await render(engine, specOf(avatarId, photoIds.slice(0, 2)));
    await jobEnd(events, first.jobId);

    const refused = failed(await engine.handle(command("videos.render", { spec: specOf(avatarId, [photoIds[0] ?? "", photoIds[2] ?? ""]) })));

    expect(refused.error.code).toBe("PHOTO_UNAVAILABLE");
    expect(refused.error.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  }, REAL_RENDER_TIMEOUT_MS);

  test("two renders asked at once for the same photos: one is queued, the other is PHOTO_UNAVAILABLE, and nothing is written for it", async () => {
    await mkdir(exportDir());
    const { avatarId, photoIds } = await seedAvatar();
    const hang = new Promise<void>(() => undefined);
    const { engine } = await start({ init: { settings: settingsOf() }, deps: { videos: { renderOverrides: { runDeps: { run: () => hang } } } } });
    const spec = specOf(avatarId, photoIds.slice(0, 2));

    const answers = await Promise.all([engine.handle(command("videos.render", { spec })), engine.handle(command("videos.render", { spec }))]);

    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    const refused = answers.find((a) => !a.ok);
    expect(refused?.ok === false ? refused.error.code : null).toBe("PHOTO_UNAVAILABLE");
    expect(engine.renders.states()).toHaveLength(1);
    await engine.shutdown(50);
  });

  test("videos.cancel stops a queued render through the engine, and answers NOT_FOUND for an id that is not a render job", async () => {
    await mkdir(exportDir());
    const { avatarId, photoIds } = await seedAvatar();
    const hang = new Promise<void>(() => undefined);
    const { engine, events } = await start({ init: { settings: settingsOf() }, deps: { videos: { renderOverrides: { runDeps: { run: () => hang } } } } });
    const first = await render(engine, specOf(avatarId, photoIds.slice(0, 2)));
    const second = await render(engine, specOf(avatarId, [photoIds[2] ?? ""], 4_000)); // waits behind the first: one at a time

    ok(await engine.handle(command("videos.cancel", { jobId: second.jobId })));

    expect((await jobEnd(events, second.jobId)).type).toBe("job.cancelled");
    expect(failed(await engine.handle(command("videos.cancel", { jobId: "job-nobody-001" }))).error.code).toBe("NOT_FOUND");
    void first;
    await engine.shutdown(50);
  });
});

describe("a crash and a restart: the recovery the library opening starts settles it", () => {
  test(
    "a kill between the rename and the record: the next start adopts the video, announces it, and marks its photos used",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      const fs = faultyFs();
      const first = await start({
        init: { settings: settingsOf() },
        deps: {
          videos: {
            renderOverrides: {
              fs,
              hooks: {
                reached: (step) => {
                  if (step === "renamed") {
                    fs.die(); // the process is gone: nothing after this runs on the disk
                    throw new CrashError(step);
                  }
                },
              },
            },
          },
        },
      });
      const { jobId, videoId } = await render(first.engine, specOf(avatarId, photoIds.slice(0, 2)));
      await jobEnd(first.events, jobId);
      // What the crash left: the finished file under its final name, the intent, and no record
      expect(await readdir(join(exportDir(), "Mia"))).toEqual([`${formatExportDate(new Date(NOW))}_photo_001.mp4`]);
      expect(existsSync(videoPaths(join(dir(), "library"), avatarId).intent(videoId))).toBe(true);
      expect(existsSync(videoPaths(join(dir(), "library"), avatarId).record(videoId))).toBe(false);

      // The restart
      const second = await start({ init: { settings: settingsOf() } });
      await second.engine.settled();

      const [video] = await listVideos(second.engine, avatarId);
      expect(video).toMatchObject({ videoId, fileState: "present", durationMs: 4000 });
      expect((await listPhotos(second.engine, avatarId)).filter((p) => p.used).map((p) => p.photoId).sort()).toEqual(photoIds.slice(0, 2).sort());
      const announced = second.events().find((e) => e.type === "video.changed");
      expect(announced?.type === "video.changed" && announced.payload.change === "upserted" ? announced.payload.video.videoId : null).toBe(videoId);
      expect(existsSync(videoPaths(join(dir(), "library"), avatarId).intent(videoId))).toBe(false);
    },
    REAL_RENDER_TIMEOUT_MS,
  );

  test("a kill in the middle of pass 2: the next start leaves no file under a final name, no record, no used mark and no temp", async () => {
    await mkdir(exportDir());
    const { avatarId, photoIds } = await seedAvatar();
    let pass = 0;
    let midway: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      midway = resolve;
    });
    const first = await start({
      init: { settings: settingsOf() },
      deps: {
        videos: {
          renderOverrides: {
            runDeps: {
              run: async (opts) => {
                await mkdir(dirname(opts.output), { recursive: true });
                await writeFile(opts.output, new Uint8Array(4096).fill(1));
                if (++pass < 3) return; // pass 1: the two clips
                midway();
                await new Promise<never>(() => undefined); // pass 2 never ends: the process is killed here
              },
            },
          },
        },
      },
    });
    const { jobId } = await render(first.engine, specOf(avatarId, photoIds.slice(0, 2)));
    await reached;
    expect((await readdir(join(exportDir(), "Mia"))).some((name) => name.startsWith(".studio-part-"))).toBe(true);

    const second = await start({ init: { settings: settingsOf() } });
    await second.engine.settled();

    expect(await readdir(join(exportDir(), "Mia"))).toEqual([]);
    expect(await listVideos(second.engine, avatarId)).toEqual([]);
    expect((await listPhotos(second.engine, avatarId)).filter((p) => p.used)).toEqual([]);
    expect(await readdir(renderTmp())).not.toContain(jobId);
    await first.engine.shutdown(50);
  }, REAL_RENDER_TIMEOUT_MS);
});

describe("stopping the engine", () => {
  test("a shutdown call from main cancels the renders, answers, and refuses any render after it", async () => {
    await mkdir(exportDir());
    const { avatarId, photoIds } = await seedAvatar();
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { engine, events, posted } = await start({
      init: { settings: settingsOf() },
      deps: {
        videos: {
          renderOverrides: {
            runDeps: {
              run: (opts) =>
                new Promise<void>((_resolve, reject) => {
                  started();
                  opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
                }),
            },
          },
        },
      },
    });
    const { jobId } = await render(engine, specOf(avatarId, photoIds.slice(0, 2)));
    await running;

    await engine.receive({ kind: "control", type: "engine.shutdown", callId: "call-00000001" });

    expect((await jobEnd(events, jobId)).type).toBe("job.cancelled");
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001" });
    expect(failed(await engine.handle(command("videos.render", { spec: specOf(avatarId, photoIds.slice(0, 2)) }))).error.code).toBe("INTERNAL");
  });
});

describe("the export folder's case probe (3a.8b.1) keeps its place in the wiring", () => {
  test("is asked only after the default export folder exists, and not at all for a folder the overlap check refused", async () => {
    const seen: Array<{ root: string; existed: boolean }> = [];
    const caseProbe = {
      isCaseInsensitive: async (root: string) => {
        seen.push({ root, existed: existsSync(root) });
        return false;
      },
    };
    const fresh = join(dir(), "userData", "export");

    const { engine } = await start({ init: { defaultExportPath: fresh, settings: settingsOf({ exportPath: fresh }) }, deps: { caseProbe } });
    await engine.settled();

    expect(existsSync(fresh)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.existed)).toBe(true);

    seen.length = 0;
    const inside = join(dir(), "library", "out");
    await start({ init: { settings: settingsOf({ exportPath: inside }) }, deps: { caseProbe } });
    expect(seen).toEqual([]);
  });
});
