import { describe, expect, test } from "bun:test";
import { JobState, MediaSummary, type EventMessage } from "../../shared/engine";
import { makeMock, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.1b: the mock's own media. An accepted file starts an import job on the mock's clock, ends in a record (listed, deleted, announced
// with `media.changed`), and a cancelled job stores nothing: as the engine does (the parity suite holds the two side by side). The mock
// holds no file and no path: the dialog's script names files by display name.

const photo = { name: "lake.jpg", accept: { kind: "photo", bytes: 120 } } as const;
const video = { name: "walk.mov", accept: { kind: "video", bytes: 5000 } } as const;

async function pick(mock: Mock, files: Parameters<Mock["engine"]["pickMediaNext"]>[0], kind: "photo" | "video" | "any" = "photo") {
  mock.engine.pickMediaNext(files);
  return unwrap(mock.client.request("media.pickImport", { kind }));
}

const importEvents = (mock: Mock): EventMessage[] => mock.events.filter((e) => e.type === "job.progress" || e.type === "job.done" || e.type === "job.cancelled" || e.type === "job.failed" || e.type === "media.changed");

describe("a picked file the script accepts", () => {
  test("starts a job: its id is answered, it is announced at zero of the file's size, and nothing is stored yet", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [photo]);
    expect(answer).toMatchObject({ picked: true, refused: [], skipped: 0 });
    if (!answer.picked) throw new Error("not picked");
    const [jobId] = answer.jobIds;
    expect(answer.jobIds).toHaveLength(1);
    const events = importEvents(mock);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ kind: "import", jobId, mediaKind: "photo", name: "lake.jpg", mediaId: null, done: 0, total: 120 });
    expect(await unwrap(mock.client.request("media.list", {}))).toEqual({ media: [], total: 0 });
  });

  test("ends on the mock's clock in the engine's order: progress at the total, the record, media.changed, job.done", async () => {
    const mock = makeMock();
    await pick(mock, [photo]);
    mock.scheduler.runAll();
    const events = importEvents(mock);
    expect(typesOf(events)).toEqual(["job.progress", "job.progress", "media.changed", "job.done"]);
    expect(events[1]?.payload).toMatchObject({ kind: "import", done: 120, total: 120 });
    const listed = await unwrap(mock.client.request("media.list", {}));
    expect(listed.total).toBe(1);
    const media = MediaSummary.parse(listed.media[0]);
    expect(media).toMatchObject({ kind: "photo", name: "lake.jpg", bytes: 120 });
    const done = events[3];
    expect(done?.type === "job.done" && done.payload.result).toEqual({ kind: "import", mediaId: media.mediaId, media });
    expect(events[2]?.payload).toEqual({ change: "upserted", media });
  });

  test("a job in the snapshot is an import with its end, and fits the contract", async () => {
    const mock = makeMock();
    await pick(mock, [photo]);
    mock.scheduler.runAll();
    const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
    const job = snapshot.jobs.find((j) => j.kind === "import");
    expect(JobState.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({ kind: "import", status: "done", done: 120, total: 120 });
  });

  test("a video and a track get the facts their kind has, and every record fits the contract", async () => {
    const mock = makeMock();
    await pick(mock, [video, { name: "track.m4a", accept: { kind: "audio", bytes: 900 } }, { name: "wave.gif", accept: { kind: "sticker", bytes: 300 } }], "any");
    mock.scheduler.runAll();
    const listed = await unwrap(mock.client.request("media.list", {}));
    expect(listed.media.map((m) => m.kind).sort()).toEqual(["audio", "sticker", "video"]);
    for (const media of listed.media) expect(MediaSummary.safeParse(media).success).toBe(true);
  });

  test("facts the script gives are the ones the record has", async () => {
    const mock = makeMock();
    await pick(mock, [{ name: "a.jpg", accept: { kind: "photo", bytes: 10, facts: { width: 640, height: 480 } } }]);
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("media.list", {}))).media[0]).toMatchObject({ width: 640, height: 480 });
  });

  test("the mock holds no path: nothing it answers or announces has a folder in it", async () => {
    const mock = makeMock();
    await pick(mock, [photo]);
    mock.scheduler.runAll();
    const text = JSON.stringify([importEvents(mock), await unwrap(mock.client.request("media.list", {}))]);
    expect(text).not.toMatch(/[\\/]/);
  });
});

describe("a pick that mixes accepted and refused files", () => {
  test("lists the jobs and the refusals, each in the order the dialog gave them", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [photo, { name: "notes.jpg", reason: "format" }, video, { name: "IMG.HEIC", reason: "heic" }], "any");
    if (!answer.picked) throw new Error("not picked");
    expect(answer.jobIds).toHaveLength(2);
    expect(answer.refused).toEqual([
      { name: "notes.jpg", reason: "format" },
      { name: "IMG.HEIC", reason: "heic" },
    ]);
  });

  test("a pick of refused files only starts no job and announces nothing", async () => {
    const mock = makeMock();
    await pick(mock, [{ name: "notes.jpg", reason: "format" }]);
    expect(importEvents(mock)).toEqual([]);
  });

  test("the jobs end one after another, in the order they were picked", async () => {
    const mock = makeMock();
    await pick(mock, [photo, { name: "second.jpg", accept: { kind: "photo", bytes: 130 } }]);
    mock.scheduler.runAll();
    const done = importEvents(mock).filter((e) => e.type === "job.done");
    expect(done.map((e) => (e.type === "job.done" && e.payload.result.kind === "import" ? e.payload.result.media.name : ""))).toEqual(["lake.jpg", "second.jpg"]);
  });
});

describe("media.list", () => {
  test("newest first, with a kind filter and the total of that kind", async () => {
    const mock = makeMock();
    await pick(mock, [photo, video], "any");
    mock.scheduler.runAll();
    const all = await unwrap(mock.client.request("media.list", {}));
    expect(all.media.map((m) => m.name)).toEqual(["walk.mov", "lake.jpg"]);
    const videos = await unwrap(mock.client.request("media.list", { kind: "video" }));
    expect(videos.media.map((m) => m.name)).toEqual(["walk.mov"]);
    expect(videos.total).toBe(1);
  });
});

describe("media.delete", () => {
  test("removes the record and says so, once", async () => {
    const mock = makeMock();
    await pick(mock, [photo]);
    mock.scheduler.runAll();
    const [media] = (await unwrap(mock.client.request("media.list", {}))).media;
    if (media === undefined) throw new Error("nothing stored");
    const mark = mock.events.length;
    expect(await unwrap(mock.client.request("media.delete", { mediaId: media.mediaId }))).toEqual({ mediaId: media.mediaId });
    expect(mock.events.slice(mark).map((e) => e.payload)).toEqual([{ change: "removed", mediaId: media.mediaId }]);
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });

  test("an unknown id is NOT_FOUND with the engine's words, and tells nothing", async () => {
    const mock = makeMock();
    const mark = mock.events.length;
    const reply = await mock.client.request("media.delete", { mediaId: "media-00000404" });
    expect(reply).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail: "no own media media-00000404 in the open library" } });
    expect(mock.events.length).toBe(mark);
  });
});

describe("media.cancelImport", () => {
  test("a held job is cancelled: no record, and job.cancelled when the clock has run", async () => {
    const mock = makeMock();
    mock.engine.holdImports(true);
    const answer = await pick(mock, [photo]);
    if (!answer.picked) throw new Error("not picked");
    const [jobId] = answer.jobIds as [string];
    expect(await unwrap(mock.client.request("media.cancelImport", { jobId }))).toEqual({ jobId });
    mock.engine.holdImports(false);
    mock.scheduler.runAll();
    expect(typesOf(importEvents(mock))).toEqual(["job.progress", "job.cancelled"]);
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
    const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.find((j) => j.jobId === jobId)).toMatchObject({ status: "cancelled", mediaId: null });
  });

  test("a job that is over is answered as it ended, and an unknown one is NOT_FOUND", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [photo]);
    if (!answer.picked) throw new Error("not picked");
    const [jobId] = answer.jobIds as [string];
    mock.scheduler.runAll();
    expect(await unwrap(mock.client.request("media.cancelImport", { jobId }))).toEqual({ jobId });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(1);
    expect(await mock.client.request("media.cancelImport", { jobId: "job-00000404" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail: "no import job job-00000404 in this engine" } });
  });

  test("a job that is not an import is not stopped by it", async () => {
    const mock = makeMock();
    const reply = await mock.client.request("media.cancelImport", { jobId: "job-render-0001" });
    expect(reply).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("a cancel that nothing holds ends the job soon, on the clock", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [photo]);
    if (!answer.picked) throw new Error("not picked");
    const [jobId] = answer.jobIds as [string];
    await unwrap(mock.client.request("media.cancelImport", { jobId }));
    mock.scheduler.runAll();
    expect(typesOf(importEvents(mock))).toEqual(["job.progress", "job.cancelled"]);
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });
});

describe("holding imports", () => {
  test("a job started while imports are held does not end until they are let go", async () => {
    const mock = makeMock();
    mock.engine.holdImports(true);
    await pick(mock, [photo]);
    mock.scheduler.runAll();
    expect(typesOf(importEvents(mock))).toEqual(["job.progress"]);
    mock.engine.holdImports(false);
    mock.scheduler.runAll();
    expect(typesOf(importEvents(mock))).toEqual(["job.progress", "job.progress", "media.changed", "job.done"]);
  });
});

describe("a restart", () => {
  test("keeps the records, which are on disk, and drops the jobs, which are not", async () => {
    const mock = makeMock();
    await pick(mock, [photo]);
    mock.scheduler.runAll();
    mock.engine.restart();
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(1);
    const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.filter((j) => j.kind === "import")).toEqual([]);
  });

  test("a job that was running is gone with the process and stores nothing", async () => {
    const mock = makeMock();
    mock.engine.holdImports(true);
    await pick(mock, [photo]);
    mock.engine.restart();
    mock.engine.holdImports(false);
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });
});

// The 3f.1b review: the engine holds the library for an import (L-2, probe P7) and queues the jobs that wait for their turn.
describe("a library switch while an import runs", () => {
  test("is refused IN_FLIGHT, as the engine refuses it, and goes through once the job is over", async () => {
    const mock = makeMock();
    mock.engine.holdImports(true);
    await pick(mock, [photo]);
    expect(await mock.client.request("settings.setLibraryPath", { path: "/Users/someone/OtherLibrary" })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    mock.engine.holdImports(false);
    mock.scheduler.runAll();
    expect(await mock.client.request("settings.setLibraryPath", { path: "/Users/someone/OtherLibrary" })).toMatchObject({ ok: true });
  });

  test("a cancelled job gives the library back too", async () => {
    const mock = makeMock();
    mock.engine.holdImports(true);
    const answer = await pick(mock, [photo]);
    if (!answer.picked) throw new Error("not picked");
    await unwrap(mock.client.request("media.cancelImport", { jobId: answer.jobIds[0] as string }));
    mock.engine.holdImports(false);
    mock.scheduler.runAll();
    expect(await mock.client.request("settings.setLibraryPath", { path: "/Users/someone/OtherLibrary" })).toMatchObject({ ok: true });
  });
});

describe("jobs that wait for their turn", () => {
  test("the second of two picked files is queued, announced queued at zero, and announced again when it runs", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [photo, { name: "second.jpg", accept: { kind: "photo", bytes: 130 } }]);
    if (!answer.picked) throw new Error("not picked");
    const [first, second] = answer.jobIds as [string, string];
    const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.find((j) => j.jobId === first)).toMatchObject({ status: "running" });
    expect(snapshot.jobs.find((j) => j.jobId === second)).toMatchObject({ status: "queued" });
    const zero = (jobId: string): unknown[] => importEvents(mock).flatMap((e) => (e.type === "job.progress" && e.payload.kind === "import" && e.payload.jobId === jobId && e.payload.done === 0 ? [e.payload.queued === true] : []));
    expect(zero(second)).toEqual([true]);
    mock.scheduler.runAll();
    expect(zero(second)).toEqual([true, false]);
    expect(zero(first)).toEqual([false]);
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(2);
  });

  test("a queued job's cancel is answered first and its end follows, as the engine's does: job.cancelled comes on the clock, never before the answer", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [photo, { name: "second.jpg", accept: { kind: "photo", bytes: 130 } }]);
    if (!answer.picked) throw new Error("not picked");
    const [, second] = answer.jobIds as [string, string];
    const before = importEvents(mock).length;
    await unwrap(mock.client.request("media.cancelImport", { jobId: second }));
    expect(importEvents(mock).length).toBe(before);
    mock.scheduler.runAll();
    const cancelled = importEvents(mock).filter((e) => e.type === "job.cancelled");
    expect(cancelled).toHaveLength(1);
    expect((await unwrap(mock.client.request("media.list", {}))).media.map((m) => m.name)).toEqual(["lake.jpg"]);
    const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.find((j) => j.jobId === second)).toMatchObject({ status: "cancelled" });
  });

  test("a cancelled queued job never takes the turn: the job behind it runs when the first ends", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [photo, { name: "second.jpg", accept: { kind: "photo", bytes: 130 } }, { name: "third.jpg", accept: { kind: "photo", bytes: 140 } }]);
    if (!answer.picked) throw new Error("not picked");
    await unwrap(mock.client.request("media.cancelImport", { jobId: answer.jobIds[1] as string }));
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("media.list", {}))).media.map((m) => m.name)).toEqual(["third.jpg", "lake.jpg"]);
  });
});

describe("the most imports that wait at once (the engine's cap of 40)", () => {
  const many = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ name: `p${from + i}.jpg`, accept: { kind: "photo" as const, bytes: 100 + i } }));

  test("a file beyond 40 queued and running is refused too-many by name, and the jobs taken go on (a pick takes at most 20 files)", async () => {
    const mock = makeMock();
    const first = await pick(mock, many(0, 20));
    const second = await pick(mock, many(20, 20));
    const third = await pick(mock, many(40, 5));
    if (!first.picked || !second.picked || !third.picked) throw new Error("not picked");
    expect(first.jobIds).toHaveLength(20);
    expect(second.jobIds).toHaveLength(20);
    expect(third.jobIds).toEqual([]);
    expect(third.refused).toEqual(many(40, 5).map((f) => ({ name: f.name, reason: "too-many" })));
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(40);
  });

  test("a pick that reaches the cap half way is split: the files that fit start jobs, the rest are refused", async () => {
    const mock = makeMock();
    await pick(mock, many(0, 20));
    await pick(mock, many(20, 15));
    const edge = await pick(mock, many(35, 10));
    if (!edge.picked) throw new Error("not picked");
    expect(edge.jobIds).toHaveLength(5);
    expect(edge.refused).toHaveLength(5);
  });

  test("room frees as jobs end: the cap counts the jobs not yet over", async () => {
    const mock = makeMock();
    await pick(mock, many(0, 20));
    await pick(mock, many(20, 20));
    mock.scheduler.runAll();
    const again = await pick(mock, many(40, 2));
    if (!again.picked) throw new Error("not picked");
    expect(again.jobIds).toHaveLength(2);
    expect(again.refused).toEqual([]);
  });
});
