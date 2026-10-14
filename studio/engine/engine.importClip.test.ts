import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { copyNameOf } from "./clips/importClip";
import { answerOf, copiesOf, factsOfFile, importClipCommand, plantReadyClip, rewriteClipRecord, videosOf, type PlantedClip } from "./clips/testing/copyKit";
import { useClipFixtures } from "./clips/testing/clipFixtures";
import { command, jobEnd, seedClipAvatar, startClipEngine, type ClipEngine } from "./clips/testing/engineClipKit";
import type { MediaImporter } from "./media/imports";
import { createVideoImporter, type VideoImporterOptions } from "./media/videoImporter";
import { useEngineDir } from "./testing/engineHarness";
useNativeGlobals();
setDefaultTimeout(120_000);

// 5b.2, S5.WA2 in the engine: a READY clip of the avatar becomes the editor's own video through the REAL video importer (real ffmpeg: the mezzanine). The clips are planted on disk (no provider, no
// money); the library's mp4 is the provider's bytes. What is pinned here is the copy, the clip lock, the import's ends and the clip service's wiring; the order of the refusals is pinned with the media
// service faked in clips/importClip.test.ts.

const dir = useEngineDir("studio-engine-import-clip-");
const libraryDir = (): string => join(dir(), "library");
const mediaFolder = (): string => join(libraryDir(), "media");
const stagingFolder = (): string => join(mediaFolder(), ".staging");
const sourceClip = useClipFixtures();

const stored = async (): Promise<string[]> => (await readdir(mediaFolder()).catch(() => [])).filter((n) => n !== ".staging").sort();
const staged = async (): Promise<string[]> => (await readdir(stagingFolder()).catch(() => [])).sort();
const sha256Of = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

async function start(options: { importer?: VideoImporterOptions; wrap?: (real: MediaImporter) => MediaImporter } = {}): Promise<ClipEngine & { avatarId: string; photoId: string }> {
  const seeded = await seedClipAvatar(libraryDir());
  const real = createVideoImporter(options.importer);
  const started = await startClipEngine(dir(), { deps: { mediaImporters: { video: options.wrap === undefined ? real : options.wrap(real) } } });
  await started.engine.settled();
  return { ...started, avatarId: seeded.avatarId, photoId: seeded.photoId };
}

/** A gate: an importer wrapped with it does not start its work until `open()`; `entered` resolves once it was called. */
function gated(): { wrap: (real: MediaImporter) => MediaImporter; open: () => void; entered: Promise<void> } {
  let open: () => void = () => undefined;
  const door = new Promise<void>((resolve) => (open = resolve));
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  return {
    open,
    entered,
    wrap: (real) => async (request) => {
      enter();
      await door;
      return real(request);
    },
  };
}

async function plant(started: { avatarId: string; photoId: string }, spec = { width: 720, height: 1280, seconds: 5, fps: 24, audio: true }, options = {}): Promise<PlantedClip> {
  return plantReadyClip(libraryDir(), started.avatarId, started.photoId, await sourceClip(spec), options);
}

async function importOf(started: ClipEngine, planted: PlantedClip) {
  return started.engine.handle(importClipCommand(planted.avatarId, planted.clipId));
}

/** Imports the clip and waits for the job; the copy it made. */
async function copyThrough(started: ClipEngine, planted: PlantedClip) {
  const answer = answerOf(await importOf(started, planted));
  if (!("jobId" in answer)) throw new Error("expected an import job");
  const end = await jobEnd(started, answer.jobId);
  expect(end.type).toBe("job.done");
  const [copy] = await copiesOf(started);
  if (copy === undefined) throw new Error("no copy was stored");
  return { jobId: answer.jobId, copy };
}

describe("the copy a clip import makes", () => {
  test("is a 30 fps constant-rate H.264 mezzanine with no audio inside 1080 x 1920, from a 24 fps clip with a stray sound track", async () => {
    const started = await start();
    const planted = await plant(started);

    const { copy } = await copyThrough(started, planted);

    const facts = await factsOfFile(join(mediaFolder(), `${copy.mediaId}.mp4`));
    expect(facts.video.codec).toBe("h264");
    expect(facts.audioTracks).toBe(0);
    expect(facts.video.variableFrameRate).toBe(false);
    expect(facts.video.sourceFps).toBeCloseTo(30, 1);
    expect(facts.video.width).toBeLessThanOrEqual(1080);
    expect(facts.video.height).toBeLessThanOrEqual(1920);
    expect(copy).toMatchObject({ kind: "video", width: 720, height: 1280, sourceFps: 24, hdrToSdr: false });
    expect(Math.abs((copy.durationMs ?? 0) - 5_000)).toBeLessThanOrEqual(100);
  });

  test("leaves the library's clip byte for byte as it was (I5.54)", async () => {
    const started = await start();
    const planted = await plant(started);
    const before = await readFile(planted.file);

    await copyThrough(started, planted);

    expect(await readFile(planted.file)).toEqual(before);
    expect(await sha256Of(planted.file)).toBe(planted.sha256);
  });

  test("carries the clip's origin: in the summary, in job.done and in the record on disk", async () => {
    const started = await start();
    const planted = await plant(started);

    const { jobId, copy } = await copyThrough(started, planted);

    const origin = { kind: "clip" as const, avatarId: planted.avatarId, clipId: planted.clipId, photoId: planted.photoId };
    expect(copy.origin).toEqual(origin);
    const done = started.events().find((e) => e.type === "job.done" && e.payload.jobId === jobId);
    expect(done?.type === "job.done" && done.payload.result.kind === "import" ? done.payload.result.media.origin : undefined).toEqual(origin);
    const record = JSON.parse(await readFile(join(mediaFolder(), `${copy.mediaId}.json`), "utf8")) as { origin?: unknown };
    expect(record.origin).toEqual(origin);
  });

  test("is named «Клип <date> <time>.mp4» after the clip's creation time", async () => {
    const started = await start();
    const createdAt = new Date(2026, 9, 14, 22, 17).toISOString();
    const planted = await plant(started, undefined, { createdAt });

    const { copy } = await copyThrough(started, planted);

    expect(copy.name).toBe("Клип 2026-10-14 22-17.mp4");
    expect(copy.name).toBe(copyNameOf(createdAt));
  });

  test("the import job's ref carries the origin while it runs and when it ends", async () => {
    const gate = gated();
    const started = await start({ wrap: gate.wrap });
    const planted = await plant(started);
    const answer = answerOf(await importOf(started, planted));
    if (!("jobId" in answer)) throw new Error("expected an import job");
    await gate.entered;

    const snapshot = await started.engine.handle(command("engine.snapshot"));
    const running = snapshot.ok && snapshot.type === "engine.snapshot" ? snapshot.result.jobs.find((j) => j.jobId === answer.jobId) : undefined;
    expect(running).toMatchObject({ kind: "import", status: "running", origin: { clipId: planted.clipId } });
    gate.open();
    expect((await jobEnd(started, answer.jobId)).type).toBe("job.done");
    const progress = started.events().flatMap((e) => (e.type === "job.progress" && e.payload.jobId === answer.jobId ? [e.payload] : []));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.kind === "import" && p.origin?.clipId === planted.clipId)).toBe(true);
  });

  test("a 1080 x 1920 clip is not scaled", async () => {
    const started = await start();
    const planted = await plant(started, { width: 1080, height: 1920, seconds: 2, fps: 24, audio: false }, { width: 1080, height: 1920, durationMs: 2_000 });
    const { copy } = await copyThrough(started, planted);
    expect(copy).toMatchObject({ width: 1080, height: 1920 });
  });
});

describe("one copy per clip", () => {
  test("a second import answers the copy's media id at once and starts no job", async () => {
    const started = await start();
    const planted = await plant(started);
    const { copy } = await copyThrough(started, planted);
    const jobsBefore = started.events().filter((e) => e.type === "job.done").length;

    expect(answerOf(await importOf(started, planted))).toEqual({ mediaId: copy.mediaId });

    expect(started.events().filter((e) => e.type === "job.done")).toHaveLength(jobsBefore);
    expect(await stored()).toHaveLength(2);
  });

  test("once the copy is gone, an import makes a new one", async () => {
    const started = await start();
    const planted = await plant(started);
    const first = await copyThrough(started, planted);
    expect((await started.engine.handle(command("media.delete", { mediaId: first.copy.mediaId }))).ok).toBe(true);
    expect(await copiesOf(started)).toEqual([]);

    const second = await copyThrough(started, planted);

    expect(second.copy.mediaId).not.toBe(first.copy.mediaId);
    expect(await copiesOf(started)).toHaveLength(1);
  });

  test("the copy is a media of the library, listed with its origin (the window keeps it out of «Мои»)", async () => {
    const started = await start();
    const planted = await plant(started);
    await copyThrough(started, planted);
    expect((await videosOf(started)).filter((m) => m.origin !== undefined)).toHaveLength(1);
  });
});

describe("the refusals", () => {
  test("a clip the avatar does not have is NOT_FOUND", async () => {
    const started = await start();
    const answer = await started.engine.handle(importClipCommand(started.avatarId, "clip-0000099"));
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error.code).toBe("NOT_FOUND");
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    const started = await start();
    const planted = await plant(started);
    const answer = await started.engine.handle(importClipCommand("avatar-nobody-0001", planted.clipId));
    expect(!answer.ok && answer.error.code).toBe("NOT_FOUND");
  });

  test("a clip that is not ready is VALIDATION not-ready", async () => {
    const started = await start();
    const planted = await plant(started);
    await rewriteClipRecord(libraryDir(), planted.avatarId, planted.clipId, (record) => ({ ...record, outcome: { status: "failed", reason: "refused-free" } }));
    const answer = await importOf(started, planted);
    expect(!answer.ok && answer.error).toMatchObject({ code: "VALIDATION", clipReason: "not-ready" });
  });

  test("a clip file that is not the one its record names is VALIDATION file-damaged: no job, no file, and the clip is free", async () => {
    const started = await start();
    const planted = await plant(started);
    await appendFile(planted.file, Buffer.from([0]));

    const answer = await importOf(started, planted);

    expect(!answer.ok && answer.error).toMatchObject({ code: "VALIDATION", clipReason: "file-damaged" });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
    expect(started.events().some((e) => e.type === "job.progress")).toBe(false);
    // The lock is back: the clip can be deleted.
    expect((await started.engine.handle(command("clips.delete", { avatarId: planted.avatarId, clipId: planted.clipId }))).ok).toBe(true);
  });

  test("a second import of the clip while the first runs is IN_FLIGHT job-running", async () => {
    const gate = gated();
    const started = await start({ wrap: gate.wrap });
    const planted = await plant(started);
    const first = answerOf(await importOf(started, planted));
    if (!("jobId" in first)) throw new Error("expected an import job");
    await gate.entered;

    const second = await importOf(started, planted);

    expect(!second.ok && second.error).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    gate.open();
    expect((await jobEnd(started, first.jobId)).type).toBe("job.done");
    expect(await copiesOf(started)).toHaveLength(1);
  });
});

describe("the clip lock during the import (Windows holds an open file)", () => {
  test("clips.delete and clips.export answer IN_FLIGHT job-running, and the clip is intact", async () => {
    const gate = gated();
    const started = await start({ wrap: gate.wrap });
    const planted = await plant(started);
    const answer = answerOf(await importOf(started, planted));
    if (!("jobId" in answer)) throw new Error("expected an import job");
    await gate.entered;

    const deleted = await started.engine.handle(command("clips.delete", { avatarId: planted.avatarId, clipId: planted.clipId }));
    const exported = await started.engine.handle(command("clips.export", { avatarId: planted.avatarId, clipId: planted.clipId }));

    expect(!deleted.ok && deleted.error).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    expect(!exported.ok && exported.error).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    expect(await sha256Of(planted.file)).toBe(planted.sha256);
    gate.open();
    expect((await jobEnd(started, answer.jobId)).type).toBe("job.done");
  });

  test("is given back when the import ends: the same delete then goes through", async () => {
    const started = await start();
    const planted = await plant(started);
    await copyThrough(started, planted);
    await started.engine.mediaSettled();

    const deleted = await started.engine.handle(command("clips.delete", { avatarId: planted.avatarId, clipId: planted.clipId }));

    expect(deleted.ok).toBe(true);
  });
});

describe("how an import that fails is told", () => {
  test("a full disk ends the job MEDIA_UNSUPPORTED with mediaReason no-space, and leaves no file, no staged copy and no record", async () => {
    const started = await start({ importer: { freeBytes: async () => 0 } });
    const planted = await plant(started);
    const answer = answerOf(await importOf(started, planted));
    if (!("jobId" in answer)) throw new Error("expected an import job");

    const end = await jobEnd(started, answer.jobId);

    expect(end.type).toBe("job.failed");
    expect(end.type === "job.failed" ? end.payload.error : undefined).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
    expect(await sha256Of(planted.file)).toBe(planted.sha256);
  });

  test("any other outcome of the importer ends the job INTERNAL, with no media reason", async () => {
    const started = await start({ importer: { minDurationMs: 60_000 } });
    const planted = await plant(started);
    const answer = answerOf(await importOf(started, planted));
    if (!("jobId" in answer)) throw new Error("expected an import job");

    const end = await jobEnd(started, answer.jobId);

    expect(end.type).toBe("job.failed");
    const error = end.type === "job.failed" ? end.payload.error : undefined;
    expect(error?.code).toBe("INTERNAL");
    expect(error?.mediaReason).toBeUndefined();
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("the clip is free after a failed import: the next import works", async () => {
    let fail = true;
    const started = await start({ wrap: (real) => async (request) => (fail ? { ok: false, reason: "failed" } : real(request)) });
    const planted = await plant(started);
    const first = answerOf(await importOf(started, planted));
    if (!("jobId" in first)) throw new Error("expected an import job");
    expect((await jobEnd(started, first.jobId)).type).toBe("job.failed");
    await started.engine.mediaSettled();

    fail = false;
    const { copy } = await copyThrough(started, planted);
    expect(copy.origin?.clipId).toBe(planted.clipId);
  });
});
