import { describe, expect, test } from "bun:test";
import { copyNameOf } from "../../engine/clips/importClip";
import { MediaSummary } from "../../shared/engine";
import { create, refusal, runUntilEnd, unwrap } from "./mockEngine.clips.testkit";
import {
  AVATAR,
  clipOf,
  clipsOf,
  copyOfNewClip,
  errorOf,
  eventsOfType,
  importCopy,
  importReply,
  makeCopyMock,
  mediaOf,
  readyClip,
  startImport,
} from "./mockEngine.clipCopies.testkit";

// Stage 5, 5b.2, S5.WA3 (plan s5b2 §5.1, I5.59): `media.importClip` in the mock, refusal for refusal and number for number as the engine answers it (engine.importClip.test.ts is the reference).
// The frame rule, the copy lifetime and `ClipSummary.use` have their own files beside this one.

describe("media.importClip: the job", () => {
  test("a clip with no copy answers a job id and starts an import job that names the clip in its ref", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    const jobId = await startImport(m, clipId);
    const first = eventsOfType(m.events, "job.progress").find((e) => e.payload.kind === "import" && e.payload.jobId === jobId);
    expect(first?.payload).toMatchObject({ kind: "import", mediaKind: "video", mediaId: null, done: 0, origin: { kind: "clip", avatarId: AVATAR, clipId } });
    expect(first?.payload.kind === "import" && first.payload.origin?.photoId).toBe((await clipOf(m, clipId)).photoId);
  });

  test("the copy is named «Клип <date> <time>.mp4» from the clip's creation time, as the engine names it", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    const jobId = await startImport(m, clipId);
    const first = eventsOfType(m.events, "job.progress").find((e) => e.payload.kind === "import" && e.payload.jobId === jobId);
    expect(first?.payload.kind === "import" && first.payload.name).toBe(copyNameOf((await clipOf(m, clipId)).createdAt));
  });

  test("job.done carries the copy's summary with its origin: a 30 fps video fitted inside the frame, from a 24 fps source", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    const clip = await clipOf(m, clipId);
    const [copy] = await mediaOf(m);
    expect(MediaSummary.safeParse(copy).success).toBe(true);
    expect(copy).toMatchObject({
      mediaId,
      kind: "video",
      width: 720,
      height: 1280,
      durationMs: 5_000,
      sourceFps: 24,
      hdrToSdr: false,
      origin: { kind: "clip", avatarId: AVATAR, clipId, photoId: clip.photoId },
    });
    const done = eventsOfType(m.events, "job.done").find((e) => e.payload.result.kind === "import");
    expect(done?.payload.result.kind === "import" && done.payload.result.media.origin?.clipId).toBe(clipId);
  });

  test("the stored record is announced upserted before the job ends", async () => {
    const m = makeCopyMock();
    await copyOfNewClip(m);
    const types = m.events.map((e) => e.type);
    expect(types.lastIndexOf("media.changed")).toBeLessThan(types.lastIndexOf("job.done"));
  });

  test("a second import while the copy lives answers its media id at once and starts no job", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    const jobsBefore = eventsOfType(m.events, "job.progress").filter((e) => e.payload.kind === "import").length;
    expect(await unwrap(importReply(m, clipId))).toEqual({ mediaId });
    expect(eventsOfType(m.events, "job.progress").filter((e) => e.payload.kind === "import")).toHaveLength(jobsBefore);
  });

  test("after the copy is deleted a new import makes a new copy", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await unwrap(m.client.request("media.delete", { mediaId }));
    const again = await importCopy(m, clipId);
    expect(again).not.toBe(mediaId);
  });

  test("a story with two clips keeps one copy per clip", async () => {
    const m = makeCopyMock();
    const a = await copyOfNewClip(m);
    const b = await copyOfNewClip(m);
    expect(a.mediaId).not.toBe(b.mediaId);
    expect((await mediaOf(m)).map((x) => x.origin?.clipId).sort()).toEqual([a.clipId, b.clipId].sort());
  });

  test("an import waits its turn behind another import, announced queued", async () => {
    const m = makeCopyMock();
    const a = await readyClip(m);
    const b = await readyClip(m);
    await startImport(m, a);
    const second = await startImport(m, b);
    const announced = eventsOfType(m.events, "job.progress").filter((e) => e.payload.kind === "import" && e.payload.jobId === second);
    expect(announced[0]?.payload).toMatchObject({ queued: true, done: 0 });
  });
});

describe("media.importClip: refusals, in the engine's order", () => {
  test("no library is LIBRARY_UNAVAILABLE, before the avatar or the clip is looked at", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.setLibraryAvailable(false);
    expect((await errorOf(importReply(m, clipId))).code).toBe("LIBRARY_UNAVAILABLE");
    expect((await errorOf(importReply(m, "clip-nobody", "avatar-nobody"))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("an avatar the library does not have is NOT_FOUND with the engine's words", async () => {
    const m = makeCopyMock();
    const error = await errorOf(importReply(m, "clip-0001", "avatar-nobody"));
    expect(error).toMatchObject({ code: "NOT_FOUND", detail: "no avatar avatar-nobody in the open library" });
  });

  test("a clip the avatar does not have is NOT_FOUND with the engine's words", async () => {
    const m = makeCopyMock();
    const error = await errorOf(importReply(m, "clip-nobody"));
    expect(error).toMatchObject({ code: "NOT_FOUND", detail: "no clip clip-nobody in this avatar's clips" });
  });

  test("another avatar's clip is NOT_FOUND for this avatar", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    expect((await errorOf(importReply(m, clipId, "avatar-sofia-0002"))).code).toBe("NOT_FOUND");
  });

  test("a refused import lists no copy afterwards", async () => {
    const m = makeCopyMock();
    await errorOf(importReply(m, "clip-nobody"));
    expect((await mediaOf(m)).filter((x) => x.origin !== undefined)).toEqual([]);
  });

  test("a clip that is not ready is VALIDATION `not-ready`, with no job", async () => {
    const m = makeCopyMock();
    m.engine.scriptNextClip("refused-free");
    const { jobId } = await unwrap(create(m, { fallback: "none", acceptedWorstMicros: 504_000 }));
    runUntilEnd(m, jobId);
    const error = await errorOf(importReply(m, jobId));
    expect(error).toMatchObject({ code: "VALIDATION", clipReason: "not-ready", detail: `clip ${jobId} is not ready, so it has no file to prepare` });
    expect(eventsOfType(m.events, "job.progress").filter((e) => e.payload.kind === "import")).toHaveLength(0);
  });

  test("a second import of a clip whose first still runs is IN_FLIGHT `job-running`", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    await startImport(m, clipId);
    const error = await errorOf(importReply(m, clipId));
    expect(error).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
  });

  test("a file that is not the one the record names is VALIDATION `file-damaged`, with no job", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.damageClipFile(clipId);
    const error = await errorOf(importReply(m, clipId));
    expect(error).toMatchObject({ code: "VALIDATION", clipReason: "file-damaged", detail: `the file of clip ${clipId} is not the one its record names` });
    expect(eventsOfType(m.events, "job.progress").filter((e) => e.payload.kind === "import")).toHaveLength(0);
  });

  test("a damaged file is told after a live copy would have been answered: the copy wins", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    m.engine.damageClipFile(clipId);
    expect(await unwrap(importReply(m, clipId))).toEqual({ mediaId });
  });

  test("a full disk at the start is MEDIA_UNSUPPORTED `no-space`", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.refuseNextClipImport("no-space");
    expect(await errorOf(importReply(m, clipId))).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" });
  });

  test("any other refusal at the start is one INTERNAL", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.refuseNextClipImport("too-many");
    expect((await errorOf(importReply(m, clipId))).code).toBe("INTERNAL");
  });

  test("a refusal at the start leaves the clip free: the next import works", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.refuseNextClipImport("no-space");
    await errorOf(importReply(m, clipId));
    expect(typeof (await importCopy(m, clipId))).toBe("string");
  });
});

describe("media.importClip: the job fails or is cancelled", () => {
  test("a full disk inside the job ends it failed MEDIA_UNSUPPORTED `no-space`, with no record", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.failNextClipImport("no-space");
    const jobId = await startImport(m, clipId);
    runUntilEnd(m, jobId);
    const failed = eventsOfType(m.events, "job.failed").find((e) => e.payload.jobId === jobId);
    expect(failed?.payload.error).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" });
    expect(failed?.payload.kind === "import" && failed.payload.origin?.clipId).toBe(clipId);
    expect(await mediaOf(m)).toEqual([]);
  });

  test("every other failure inside the job is told the clip way: one INTERNAL", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.failNextClipImport("codec");
    const jobId = await startImport(m, clipId);
    runUntilEnd(m, jobId);
    const failed = eventsOfType(m.events, "job.failed").find((e) => e.payload.jobId === jobId);
    expect(failed?.payload.error.code).toBe("INTERNAL");
    expect(failed?.payload.error.mediaReason).toBeUndefined();
  });

  test("a failed import gives the clip back: it can be imported again", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.failNextClipImport("codec");
    runUntilEnd(m, await startImport(m, clipId));
    expect(typeof (await importCopy(m, clipId))).toBe("string");
  });

  test("a cancelled import records nothing, announces job.cancelled with the origin, and gives the clip back", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    const jobId = await startImport(m, clipId);
    await unwrap(m.client.request("media.cancelImport", { jobId }));
    runUntilEnd(m, jobId);
    const cancelled = eventsOfType(m.events, "job.cancelled").find((e) => e.payload.jobId === jobId);
    expect(cancelled?.payload.kind === "import" && cancelled.payload.origin?.clipId).toBe(clipId);
    expect(await mediaOf(m)).toEqual([]);
    expect(typeof (await importCopy(m, clipId))).toBe("string");
  });

  test("a restart drops the running import with its record, and the clip is free again", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    await startImport(m, clipId);
    m.engine.restart();
    expect(await mediaOf(m)).toEqual([]);
    expect(typeof (await importCopy(m, clipId))).toBe("string");
  });

  test("the snapshot lists the import job with its origin while it runs and when it is done", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    const jobId = await startImport(m, clipId);
    const running = (await unwrap(m.client.request("engine.snapshot", {}))).jobs.find((j) => j.kind === "import");
    expect(running).toMatchObject({ jobId, status: "running", origin: { clipId } });
    runUntilEnd(m, jobId);
    const done = (await unwrap(m.client.request("engine.snapshot", {}))).jobs.find((j) => j.kind === "import");
    expect(done).toMatchObject({ jobId, status: "done", origin: { clipId } });
  });
});

describe("the clip lock during the import", () => {
  test("clips.delete and clips.export answer `job-running` while the import runs, and work after it", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    const jobId = await startImport(m, clipId);
    expect(await refusal(m.client.request("clips.delete", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    expect(await refusal(m.client.request("clips.export", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    runUntilEnd(m, jobId);
    await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId }));
    expect(await clipsOf(m)).toEqual([]);
  });

  test("an avatar delete is refused while a clip of the avatar is being prepared for a montage", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    const jobId = await startImport(m, clipId);
    expect(await errorOf(m.client.request("avatars.delete", { avatarId: AVATAR }))).toMatchObject({ code: "IN_FLIGHT", detail: "a clip of this avatar is being prepared for a montage; delete the avatar when it ends" });
    expect((await errorOf(m.client.request("avatars.deletePreview", { avatarId: AVATAR }))).code).toBe("IN_FLIGHT");
    runUntilEnd(m, jobId);
    await unwrap(m.client.request("avatars.delete", { avatarId: AVATAR }));
  });
});
