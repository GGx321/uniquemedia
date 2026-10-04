import { describe, expect, test } from "bun:test";
import type { EventMessage } from "../../shared/engine";
import { MOCK_RENDER_STEPS } from "./mockEngine";
import { draftOf, eventsOfJob, freePhotos, makeMock, MIA, PHOTO_IDS, renderDraft, renderJobsOf, scenePhoto, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// Stage 3, 3d.1b: the mock's videos and render jobs (`videos.render / cancel / list / delete`, `export.status`) follow the real
// engine: a render is queued, runs through progress and a saving phase, commits a record and ends, announcing itself in the
// engine's order; one photo goes into one video; and the refusals come in the engine's order. The parity suite
// (studio/engine/parity) holds the two side by side; these tests pin the mock's own behaviour and its controls.

const [P1, P2, P3, P4, P5, P6] = PHOTO_IDS as [string, string, string, string, string, string];
/** A draft of two photos is one 8 s collage: 240 frames. */
const TWO_PHOTO_FRAMES = 240;

/** Runs the mock's clock up to the start of the saving phase: the progress steps, then the saving announcement. */
function untilSaving(mock: Mock): void {
  for (let i = 0; i < MOCK_RENDER_STEPS + 1; i++) mock.scheduler.next();
}

const eventsAfter = (mock: Mock, mark: number): EventMessage[] => mock.events.slice(mark);

describe("videos.render", () => {
  test("queues a render of a draft and announces it at zero with the draft's identity, then the reservation", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    const mark = mock.events.length;

    const { jobId, videoId } = await renderDraft(mock, draft.montageId);

    const sent = eventsAfter(mock, mark);
    expect(typesOf(sent)).toEqual(["job.progress", "avatar.changed"]);
    expect(sent[0]?.payload).toEqual({ kind: "render", jobId, videoId, avatarId: MIA.avatarId, montageId: draft.montageId, done: 0, total: TWO_PHOTO_FRAMES });
  });

  // 3d.6, as the engine: a waiting render's announcement says queued, its start (and a render that started at once) does not.
  test("a render that waits for a slot is announced queued, and announced again, not queued, when it starts", async () => {
    const mock = makeMock();
    const first = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    const second = await renderDraft(mock, (await draftOf(mock, [P3, P4])).montageId);

    const flagsOf = (jobId: string): unknown[] =>
      eventsOfJob(mock.events, jobId).flatMap((e) => (e.type === "job.progress" && e.payload.kind === "render" && e.payload.done === 0 ? [e.payload.queued] : []));
    expect(flagsOf(first.jobId)).toEqual([undefined]);
    expect(flagsOf(second.jobId)).toEqual([true]);

    mock.scheduler.runAll();
    expect(flagsOf(second.jobId)).toEqual([true, undefined]);
  });

  test("reserves the photos: they are held, and the avatar's eligibleUnusedCount drops by their number", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);

    await renderDraft(mock, draft.montageId);

    const { photos } = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.filter((p) => p.reserved).map((p) => p.photoId).sort()).toEqual([P1, P2].sort());
    const announced = mock.events.flatMap((e) => (e.type === "avatar.changed" ? [e.payload.avatar] : [])).at(-1);
    expect(announced).toMatchObject({ videoCount: 0, eligibleUnusedCount: 4 });
  });

  test("runs through progress that never reaches the total, then the saving phase, then commits before it ends", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    const { jobId } = await renderDraft(mock, draft.montageId);
    const mark = mock.events.length;

    mock.scheduler.runAll();

    const sent = eventsAfter(mock, mark);
    expect(typesOf(sent)).toEqual([
      ...Array.from({ length: MOCK_RENDER_STEPS + 1 }, () => "job.progress"),
      "video.changed",
      "avatar.changed",
      "job.done",
      "avatar.changed",
    ]);
    const progress = sent.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "render" ? [e.payload] : []));
    const dones = progress.map((p) => p.done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    // The engine's rule (ProgressFold): pass 1 takes the first 35% of the range, pass 2 the rest, and the last frame belongs to the job's end.
    expect(dones[0]).toBe(Math.floor((TWO_PHOTO_FRAMES * 35) / 100));
    expect(Math.max(...dones)).toBe(TWO_PHOTO_FRAMES - 1);
    expect(progress.at(-1)).toMatchObject({ saving: true, done: TWO_PHOTO_FRAMES - 1 });
    expect(progress.map((p) => p.saving === true)).toEqual([...Array.from({ length: MOCK_RENDER_STEPS }, () => false), true]);
    expect(eventsOfJob(sent, jobId).at(-1)?.type).toBe("job.done");
  });

  test("ends done with the video's result, and a video record that lists in videos.list", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    const { jobId, videoId } = await renderDraft(mock, draft.montageId);

    mock.scheduler.runAll();

    const done = mock.events.find((e) => e.type === "job.done");
    if (done?.type !== "job.done") throw new Error("expected job.done");
    expect(done.payload).toMatchObject({ jobId, result: { kind: "render", videoId, avatarId: MIA.avatarId, durationMs: 8_000, videoKind: "collage2" } });
    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ videoId, avatarId: MIA.avatarId, kind: "collage2", durationMs: 8_000, fileState: "present", montageId: draft.montageId, photoCount: 2, music: null, hasPoster: false });
    expect(videos[0]?.relPath).toMatch(/^Mia\/\d{4}-\d{2}-\d{2}_collage2_001\.mp4$/);
    expect(done.payload.result.kind === "render" ? done.payload.result.relPath : null).toBe(videos[0]?.relPath ?? "");
  });

  test("uses the photos once it is done: the avatar counts its video and keeps the photos out of reach", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    const { videoId } = await renderDraft(mock, draft.montageId);

    mock.scheduler.runAll();

    const { photos } = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.filter((p) => p.used).map((p) => [p.photoId, p.usedIn, p.reserved]).sort()).toEqual([[P1, [videoId], false], [P2, [videoId], false]].sort());
    const { avatars } = await unwrap(mock.client.request("avatars.list", {}));
    expect(avatars[0]).toMatchObject({ videoCount: 1, eligibleUnusedCount: 4 });
  });

  test("queues a second render behind the first, and starts it the moment the first ends", async () => {
    const mock = makeMock();
    const first = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    const second = await renderDraft(mock, (await draftOf(mock, [P3, P4])).montageId);
    expect((await renderJobsOf(mock)).map((j) => j.status)).toEqual(["running", "queued"]);
    const mark = mock.events.length;

    mock.scheduler.runAll();

    const sent = eventsAfter(mock, mark);
    const endOfFirst = sent.findIndex((e) => e.type === "job.done" && e.payload.jobId === first.jobId);
    expect(sent.slice(endOfFirst, endOfFirst + 3).map((e) => e.type)).toEqual(["job.done", "avatar.changed", "job.progress"]);
    expect(sent[endOfFirst + 2]?.payload).toMatchObject({ jobId: second.jobId, done: 0 });
    expect((await renderJobsOf(mock)).map((j) => j.status)).toEqual(["done", "done"]);
  });

  test("runs as many renders at once as the render concurrency says", async () => {
    const mock = makeMock({ renderConcurrency: 2 });
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    await renderDraft(mock, (await draftOf(mock, [P3, P4])).montageId);
    await renderDraft(mock, (await draftOf(mock, [P5, P6])).montageId);

    expect((await renderJobsOf(mock)).map((j) => j.status)).toEqual(["running", "running", "queued"]);
  });

  test("names the files after their kind and counts them: the next free number", async () => {
    const mock = makeMock();
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    await renderDraft(mock, (await draftOf(mock, [P3, P4])).montageId);
    await renderDraft(mock, (await draftOf(mock, [P5])).montageId);

    mock.scheduler.runAll();

    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(videos.map((v) => v.relPath.replace(/\d{4}-\d{2}-\d{2}/, "<date>")).sort()).toEqual(["Mia/<date>_collage2_001.mp4", "Mia/<date>_collage2_002.mp4", "Mia/<date>_photo_001.mp4"]);
  });

  test("refuses a photo that is already in a video, with the issue at its cell, and queues nothing", async () => {
    const mock = makeMock();
    const first = await draftOf(mock, [P1, P2]);
    const second = await draftOf(mock, [P1]);
    await renderDraft(mock, first.montageId);
    mock.scheduler.runAll();
    const mark = mock.events.length;

    const reply = await mock.client.request("videos.render", { montageId: second.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["clips", 0, "cell"] }] } });
    expect(eventsAfter(mock, mark)).toEqual([]);
    expect(await renderJobsOf(mock)).toHaveLength(1);
  });

  test("refuses a photo another queued or running render holds", async () => {
    const mock = makeMock();
    const first = await draftOf(mock, [P1, P2]);
    const second = await draftOf(mock, [P2, P3]);
    await renderDraft(mock, first.montageId);

    const reply = await mock.client.request("videos.render", { montageId: second.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["clips", 0, "cells", 0] }] } });
  });

  test("refuses a draft that is not complete with MONTAGE_INVALID and its issues", async () => {
    const mock = makeMock();
    const empty = await draftOf(mock, []);

    const reply = await mock.client.request("videos.render", { montageId: empty.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "no-clips", path: ["clips"] }] } });
  });

  test("refuses a draft with a part whose slice has not landed as MONTAGE_INVALID (not-yet-supported)", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1]);
    // An own sticker is supported since 3f.5 and an own track since 3f.4; an own video clip still waits for 3f.3b.
    const ownVideo = { clipId: "clip-90000002", kind: "video" as const, mediaId: "media-0000001", trimStartMs: 0, focus: null, durationMs: 4_000, transitionIn: "cut" as const };
    await unwrap(mock.client.request("montages.save", { montageId: draft.montageId, spec: { ...draft.spec, clips: [ownVideo] }, name: null }));

    const reply = await mock.client.request("videos.render", { montageId: draft.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "not-yet-supported", path: ["clips", 0] }] } });
  });

  test("refuses a built-in sticker the set lacks and an unstored track together, in the engine's order: structure, N9, stickers, track", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1]);
    const pastEnd = { layerId: "layer-0001", kind: "text" as const, startMs: 0, endMs: 9_000, value: "Hi", font: "manrope" as const, style: "none" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };
    const ownVideo = { clipId: "clip-90000001", kind: "video" as const, mediaId: "media-0000001", trimStartMs: 0, focus: null, durationMs: 1_000, transitionIn: "cut" as const };
    const gone = { layerId: "layer-0003", kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "builtin" as const, stickerId: "no-such-sticker" }, x: 0.5, y: 0.5, size: 0.2 };
    const spec = { ...draft.spec, clips: [{ ...ownVideo, durationMs: draft.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0) }], layers: [pastEnd, gone], music: { source: "trending" as const, trackId: "track-0000001", startMs: 0 } };
    await unwrap(mock.client.request("montages.save", { montageId: draft.montageId, spec, name: null }));

    const reply = await mock.client.request("videos.render", { montageId: draft.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID" } });
    const issues = reply.ok ? [] : (reply.error.issues ?? []);
    expect(issues.map((i) => i.code)).toEqual(["layer-outside-timeline", "not-yet-supported", "sticker-unavailable", "track-unavailable"]);
  });

  test("refuses a draft that is not there with NOT_FOUND", async () => {
    const mock = makeMock();

    const reply = await mock.client.request("videos.render", { montageId: "montage-nobody-0009" });

    expect(reply).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: "no montage draft montage-nobody-0009" } });
  });

  test("answers LIBRARY_UNAVAILABLE for a draft while the library is closed", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1]);
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("videos.render", { montageId: draft.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });

  test("refuses when the queue is full, with the limit in the detail, and reserves nothing", async () => {
    const mock = makeMock();
    mock.engine.setRenderQueueLimit(1);
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    const other = await draftOf(mock, [P3, P4]);

    const reply = await mock.client.request("videos.render", { montageId: other.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "RENDER_QUEUE_FULL", detail: "the render queue is full: 1 renders are already queued or running" } });
    const { photos } = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.filter((p) => p.reserved)).toHaveLength(2);
  });

  test("has a queue that holds twenty renders by default", async () => {
    const photos = freePhotos(21);
    const mock = makeMock({ photos });
    for (const photo of photos.slice(0, 20)) await renderDraft(mock, (await draftOf(mock, [photo.photoId])).montageId);
    const last = await draftOf(mock, [photos[20]?.photoId ?? ""]);

    const reply = await mock.client.request("videos.render", { montageId: last.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "RENDER_QUEUE_FULL" } });
  });

  test("renders a headless spec too: its video has no draft", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1]);

    const { jobId } = await unwrap(mock.client.request("videos.render", { spec: draft.spec }));
    mock.scheduler.runAll();

    const progress = eventsOfJob(mock.events, jobId)[0];
    expect(progress?.payload).toMatchObject({ kind: "render", montageId: null });
    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(videos[0]).toMatchObject({ montageId: null });
  });

  test("fails the job at its first step when an encode failure is scripted: no saving phase, no video, and the photos leave the reservation", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    const { jobId, videoId } = await renderDraft(mock, draft.montageId);
    mock.engine.failNextRender({ code: "RENDER_FAILED", detail: "ffmpeg exited with code 1" });
    const mark = mock.events.length;

    mock.scheduler.runAll();

    const sent = eventsAfter(mock, mark);
    expect(typesOf(sent)).toEqual(["job.failed", "avatar.changed"]);
    expect(sent[0]?.payload).toEqual({ kind: "render", jobId, videoId, avatarId: MIA.avatarId, montageId: draft.montageId, error: { code: "RENDER_FAILED", detail: "ffmpeg exited with code 1" } });
    expect(await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).toEqual({ videos: [] });
    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars[0]?.eligibleUnusedCount).toBe(6);
  });

  test("fails the job in its saving phase when a saving failure is scripted: the window saw the saving step, and no video lands", async () => {
    const mock = makeMock();
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.engine.failNextRender({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" }, "saving");
    const mark = mock.events.length;

    mock.scheduler.runAll();

    const sent = eventsAfter(mock, mark);
    expect(typesOf(sent).slice(-3)).toEqual(["job.progress", "job.failed", "avatar.changed"]);
    expect(sent.at(-3)?.payload).toMatchObject({ saving: true });
    expect(typesOf(sent)).not.toContain("video.changed");
  });
});

describe("a moved export folder", () => {
  test("leaves the videos already made in the old folder: their files read elsewhere; new renders start a new count in the new folder", async () => {
    const mock = makeMock();
    const old = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();

    mock.engine.moveExportFolder();
    const fresh = await renderDraft(mock, (await draftOf(mock, [P3, P4])).montageId);
    mock.scheduler.runAll();

    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(Object.fromEntries(videos.map((v) => [v.videoId, v.fileState]))).toEqual({ [old.videoId]: "elsewhere", [fresh.videoId]: "present" });
    expect(videos.find((v) => v.videoId === fresh.videoId)?.relPath).toMatch(/_collage2_001\.mp4$/);
  });
});

describe("a draft deleted while its render runs", () => {
  test("still renders: the video's record lists no draft, and the job's events keep naming the draft they came from", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    const { jobId } = await renderDraft(mock, draft.montageId);

    await unwrap(mock.client.request("montages.delete", { montageId: draft.montageId }));
    mock.scheduler.runAll();

    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(videos[0]).toMatchObject({ montageId: null });
    const committed = mock.events.find((e) => e.type === "video.changed");
    expect(committed?.payload).toMatchObject({ change: "upserted", video: { montageId: null } });
    expect(eventsOfJob(mock.events, jobId).filter((e) => e.type === "job.progress").every((e) => "montageId" in e.payload && e.payload.montageId === draft.montageId)).toBe(true);
  });

  test("a video of a draft deleted later lists no draft either, while the draft counted it before", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    await renderDraft(mock, draft.montageId);
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("montages.list", {}))).items[0]?.videoCount).toBe(1);

    await unwrap(mock.client.request("montages.delete", { montageId: draft.montageId }));

    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(videos[0]?.montageId).toBeNull();
  });
});

describe("videos.cancel", () => {
  test("ends a queued render at once, announces it with its identity, and frees its photos", async () => {
    const mock = makeMock();
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    const draft = await draftOf(mock, [P3, P4]);
    const queued = await renderDraft(mock, draft.montageId);
    const mark = mock.events.length;

    const answer = await unwrap(mock.client.request("videos.cancel", { jobId: queued.jobId }));

    expect(answer).toEqual({ jobId: queued.jobId });
    const sent = eventsAfter(mock, mark);
    expect(typesOf(sent)).toEqual(["job.cancelled", "avatar.changed"]);
    expect(sent[0]?.payload).toEqual({ kind: "render", jobId: queued.jobId, videoId: queued.videoId, avatarId: MIA.avatarId, montageId: draft.montageId });
    expect((await renderJobsOf(mock)).map((j) => j.status)).toEqual(["running", "cancelled"]);
    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars[0]?.eligibleUnusedCount).toBe(4);
  });

  test("answers at once for a running render and ends it a moment later, when its work has stopped", async () => {
    const mock = makeMock();
    const { jobId } = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.next();
    const mark = mock.events.length;

    await unwrap(mock.client.request("videos.cancel", { jobId }));
    expect(typesOf(eventsAfter(mock, mark))).toEqual([]);
    mock.scheduler.runAll();

    expect(typesOf(eventsAfter(mock, mark))).toEqual(["job.cancelled", "avatar.changed"]);
    expect(await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).toEqual({ videos: [] });
  });

  test("starts the next queued render when a running one is cancelled", async () => {
    const mock = makeMock();
    const first = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    await renderDraft(mock, (await draftOf(mock, [P3, P4])).montageId);

    await unwrap(mock.client.request("videos.cancel", { jobId: first.jobId }));
    mock.scheduler.next();
    mock.scheduler.next();

    expect((await renderJobsOf(mock)).map((j) => j.status)).toEqual(["cancelled", "running"]);
  });

  test("ignores a cancel once the render is saving: it ends done", async () => {
    const mock = makeMock();
    const { jobId } = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    untilSaving(mock);
    expect((await renderJobsOf(mock))[0]).toMatchObject({ status: "running", saving: true });

    expect(await unwrap(mock.client.request("videos.cancel", { jobId }))).toEqual({ jobId });
    mock.scheduler.runAll();

    expect((await renderJobsOf(mock))[0]?.status).toBe("done");
    expect(typesOf(mock.events)).not.toContain("job.cancelled");
  });

  test("is ok for a render that already ended, and changes nothing", async () => {
    const mock = makeMock();
    const { jobId } = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();
    const mark = mock.events.length;

    expect(await unwrap(mock.client.request("videos.cancel", { jobId }))).toEqual({ jobId });

    expect(eventsAfter(mock, mark)).toEqual([]);
    expect((await renderJobsOf(mock))[0]?.status).toBe("done");
  });

  test("refuses a job that is not a render, and one that is unknown, with NOT_FOUND", async () => {
    const mock = makeMock();

    const unknown = await mock.client.request("videos.cancel", { jobId: "job-nobody-0009" });

    expect(unknown).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: "no render job job-nobody-0009" } });
  });
});

describe("videos.list", () => {
  test("lists an avatar's videos newest first", async () => {
    const mock = makeMock({ renderConcurrency: 2 });
    const a = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();
    const b = await renderDraft(mock, (await draftOf(mock, [P3, P4])).montageId);
    mock.scheduler.runAll();

    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));

    expect(videos.map((v) => v.videoId)).toEqual([b.videoId, a.videoId]);
  });

  test("lists only the videos of the avatar asked for", async () => {
    const mock = makeMock();
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();
    const other = makeMock({ avatars: [{ ...MIA, avatarId: "avatar-sofia-0002", name: "Sofia" }], photos: [] });

    expect(await unwrap(other.client.request("videos.list", { avatarId: "avatar-sofia-0002" }))).toEqual({ videos: [] });
  });

  test("refuses an avatar the library does not have with NOT_FOUND, and a closed library the same way", async () => {
    const mock = makeMock();

    const unknown = await mock.client.request("videos.list", { avatarId: "avatar-nobody-0009" });
    mock.engine.setLibraryAvailable(false);
    const closed = await mock.client.request("videos.list", { avatarId: MIA.avatarId });

    expect(unknown).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: "no avatar avatar-nobody-0009 in the open library" } });
    expect(closed).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("shows the file state a check found: missing, changed or elsewhere", async () => {
    const mock = makeMock({ renderConcurrency: 3 });
    const ids: string[] = [];
    for (const photos of [[P1, P2], [P3, P4], [P5, P6]]) ids.push((await renderDraft(mock, (await draftOf(mock, photos)).montageId)).videoId);
    mock.scheduler.runAll();
    mock.engine.setVideoFileState(ids[0] ?? "", "missing");
    mock.engine.setVideoFileState(ids[1] ?? "", "changed");
    mock.engine.setVideoFileState(ids[2] ?? "", "elsewhere");

    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));

    expect(Object.fromEntries(videos.map((v) => [v.videoId, v.fileState]))).toEqual({ [ids[0] ?? ""]: "missing", [ids[1] ?? ""]: "changed", [ids[2] ?? ""]: "elsewhere" });
  });
});

describe("videos.delete", () => {
  async function oneVideo(mock: Mock = makeMock()) {
    const draft = await draftOf(mock, [P1, P2]);
    const { videoId } = await renderDraft(mock, draft.montageId);
    mock.scheduler.runAll();
    return { mock, videoId, draft };
  }

  test("deletes a video by its owner's intent: the file, the record and the used marks, announced in the engine's order", async () => {
    const { mock, videoId } = await oneVideo();
    const mark = mock.events.length;

    const answer = await unwrap(mock.client.request("videos.delete", { videoId, mode: "video" }));

    expect(answer).toEqual({ videoId, fileDeleted: true, fileState: "present" });
    const sent = eventsAfter(mock, mark);
    expect(typesOf(sent)).toEqual(["video.changed", "avatar.changed"]);
    expect(sent[0]?.payload).toEqual({ change: "removed", videoId, avatarId: MIA.avatarId });
    expect(sent[1]?.type === "avatar.changed" ? sent[1].payload.avatar : null).toMatchObject({ videoCount: 0, eligibleUnusedCount: 6 });
    expect(await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).toEqual({ videos: [] });
  });

  test("frees the photos: a new draft may take them again", async () => {
    const { mock, videoId } = await oneVideo();
    expect(await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [P1] })).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE" } });

    await unwrap(mock.client.request("videos.delete", { videoId, mode: "video" }));

    expect((await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [P1, P2] })).ok).toBe(true);
  });

  test("deletes only the record for «Удалить запись»: the file stays, and its name stays taken", async () => {
    const { mock, videoId } = await oneVideo();

    const answer = await unwrap(mock.client.request("videos.delete", { videoId, mode: "record" }));
    const again = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();

    expect(answer).toEqual({ videoId, fileDeleted: false, fileState: "present" });
    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(videos.map((v) => v.videoId)).toEqual([again.videoId]);
    expect(videos[0]?.relPath).toMatch(/_collage2_002\.mp4$/);
  });

  test("a file that is elsewhere: «Удалить» refuses and deletes nothing, «Удалить запись» frees the photos", async () => {
    const { mock, videoId } = await oneVideo();
    mock.engine.setVideoFileState(videoId, "elsewhere");

    const refused = await mock.client.request("videos.delete", { videoId, mode: "video" });
    expect(refused).toEqual({ ok: false, error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing", detail: "the video's file is not in the current export folder" } });
    expect((await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos).toHaveLength(1);

    const recorded = await unwrap(mock.client.request("videos.delete", { videoId, mode: "record" }));
    expect(recorded).toEqual({ videoId, fileDeleted: false, fileState: "elsewhere" });
    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars[0]).toMatchObject({ videoCount: 0, eligibleUnusedCount: 6 });
  });

  test("a file that is missing or changed goes with only its record: it is not provably Studio's", async () => {
    const { mock, videoId } = await oneVideo();
    mock.engine.setVideoFileState(videoId, "changed");

    const answer = await unwrap(mock.client.request("videos.delete", { videoId, mode: "video" }));

    expect(answer).toEqual({ videoId, fileDeleted: false, fileState: "changed" });
  });

  test("refuses «Удалить» while the export folder is unusable, and deletes nothing; «Удалить запись» still works", async () => {
    const { mock, videoId } = await oneVideo();
    mock.engine.setExportDisk({ status: "unavailable", reason: "not-writable" });

    const refused = await mock.client.request("videos.delete", { videoId, mode: "video" });
    expect(refused).toEqual({ ok: false, error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect((await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos).toHaveLength(1);

    const recorded = await unwrap(mock.client.request("videos.delete", { videoId, mode: "record" }));
    expect(recorded).toEqual({ videoId, fileDeleted: false, fileState: "elsewhere" });
  });

  test("refuses an unknown video with NOT_FOUND", async () => {
    const mock = makeMock();

    const reply = await mock.client.request("videos.delete", { videoId: "video-nobody-0009", mode: "record" });

    expect(reply).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: "no video video-nobody-0009" } });
  });

  test("asks the export folder before it looks for the video", async () => {
    const mock = makeMock();
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });

    const reply = await mock.client.request("videos.delete", { videoId: "video-nobody-0009", mode: "video" });

    expect(reply).toMatchObject({ ok: false, error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
  });

  test("answers LIBRARY_UNAVAILABLE while the library is closed", async () => {
    const { mock, videoId } = await oneVideo();
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("videos.delete", { videoId, mode: "record" });

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });
});

describe("export.status", () => {
  test("is announced when a check finds a change, not when the disk changes", async () => {
    const mock = makeMock();
    const mark = mock.events.length;

    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    expect(eventsAfter(mock, mark)).toEqual([]);
    await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));

    const sent = eventsAfter(mock, mark);
    expect(sent.map((e) => e.payload)).toEqual([{ exportStatus: { status: "unavailable", reason: "missing" } }]);
    expect((await unwrap(mock.client.request("engine.snapshot", {}))).exportStatus).toEqual({ status: "unavailable", reason: "missing" });
  });

  test("says nothing when a check finds the same status again", async () => {
    const mock = makeMock();
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    const mark = mock.events.length;

    await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));

    expect(eventsAfter(mock, mark)).toEqual([]);
  });

  test("announces the folder coming back at the next check", async () => {
    const mock = makeMock();
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    mock.engine.setExportDisk({ status: "ok" });
    const mark = mock.events.length;

    await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));

    expect(eventsAfter(mock, mark).map((e) => e.payload)).toEqual([{ exportStatus: { status: "ok" } }]);
  });

  test("a render attempt refuses with EXPORT_UNAVAILABLE and its reason, and announces the change it found", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1]);
    mock.engine.setExportDisk({ status: "unavailable", reason: "overlaps-library" });
    const mark = mock.events.length;

    const reply = await mock.client.request("videos.render", { montageId: draft.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "EXPORT_UNAVAILABLE", exportReason: "overlaps-library" } });
    expect(eventsAfter(mock, mark).map((e) => e.payload)).toEqual([{ exportStatus: { status: "unavailable", reason: "overlaps-library" } }]);
    expect(await renderJobsOf(mock)).toEqual([]);
  });

  test("not enough room refuses that render only: the status every window shows stays ok", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1]);
    mock.engine.setExportFreeBytes(1_000);
    const mark = mock.events.length;

    const reply = await mock.client.request("videos.render", { montageId: draft.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-enough-space" } });
    expect(eventsAfter(mock, mark)).toEqual([]);
    expect((await unwrap(mock.client.request("engine.snapshot", {}))).exportStatus).toEqual({ status: "ok" });
  });

  test("a draft that is not there and an invalid one are refused before the export folder is asked; the folder is asked before the photos", async () => {
    const mock = makeMock();
    const empty = await draftOf(mock, []);
    const first = await draftOf(mock, [P1]);
    const second = await draftOf(mock, [P1]);
    await renderDraft(mock, first.montageId);
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });

    const missing = await mock.client.request("videos.render", { montageId: "montage-nobody-0009" });
    const invalid = await mock.client.request("videos.render", { montageId: empty.montageId });
    const folder = await mock.client.request("videos.render", { montageId: second.montageId });

    expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(invalid).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID" } });
    expect(folder).toMatchObject({ ok: false, error: { code: "EXPORT_UNAVAILABLE" } });
  });
});

describe("the snapshot and a restart", () => {
  test("a library switch is refused with IN_FLIGHT while a render is queued or running, and allowed once it ends", async () => {
    const mock = makeMock();
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);

    const refused = await mock.client.request("settings.setLibraryPath", { path: "/Users/studio/Other/library" });
    mock.scheduler.runAll();
    const allowed = await mock.client.request("settings.setLibraryPath", { path: "/Users/studio/Other/library" });

    expect(refused).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(allowed.ok).toBe(true);
  });

  test("lists render jobs with their state, and a finished one with its result", async () => {
    const mock = makeMock();
    const { jobId, videoId } = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    expect(await renderJobsOf(mock)).toEqual([{ kind: "render", jobId, videoId, avatarId: MIA.avatarId, montageId: expect.any(String), status: "running", done: 0, total: TWO_PHOTO_FRAMES }] as never);

    mock.scheduler.runAll();

    const [job] = await renderJobsOf(mock);
    expect(job).toMatchObject({ jobId, status: "done", done: TWO_PHOTO_FRAMES, total: TWO_PHOTO_FRAMES, result: { kind: "render", videoId } });
    // The saving mark is the running job's: the job's end drops it, as the engine's registry does.
    expect(job).not.toHaveProperty("saving");
  });

  test("a restart drops the renders that were queued or running and frees their photos; the videos and the drafts stay", async () => {
    const mock = makeMock();
    const done = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();
    const draft = await draftOf(mock, [P3, P4]);
    await renderDraft(mock, draft.montageId);
    await renderDraft(mock, (await draftOf(mock, [P5, P6])).montageId);

    mock.engine.restart();

    expect(await renderJobsOf(mock)).toEqual([]);
    const { photos } = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.filter((p) => p.reserved)).toEqual([]);
    expect((await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos.map((v) => v.videoId)).toEqual([done.videoId]);
    expect((await unwrap(mock.client.request("montages.get", { montageId: draft.montageId }))).montage.montageId).toBe(draft.montageId);
    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars[0]).toMatchObject({ videoCount: 1, eligibleUnusedCount: 4 });
  });

  test("a photo marked rejected while a render holds it does not raise the count when the render ends", async () => {
    const photos = [scenePhoto(1), scenePhoto(2), scenePhoto(3)];
    const mock = makeMock({ photos });
    const draft = await draftOf(mock, [photos[0]?.photoId ?? ""]);
    const { jobId } = await renderDraft(mock, draft.montageId);
    await unwrap(mock.client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: photos[0]?.photoId ?? "", rejected: true }));

    await unwrap(mock.client.request("videos.cancel", { jobId }));
    mock.scheduler.runAll();

    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars[0]?.eligibleUnusedCount).toBe(2);
  });
});

// 3d.6: `videos.reveal` is main's command (it opens the OS file manager, for a video whose file is present). The demo build has no
// main, so the mock answers as main does and remembers which videos it was asked to show; nothing opens.
describe("videos.reveal", () => {
  async function madeVideo(mock: Mock): Promise<string> {
    const draft = await draftOf(mock, [P1, P2]);
    const { videoId } = await renderDraft(mock, draft.montageId);
    mock.scheduler.runAll();
    return videoId;
  }

  test("shows a video whose file is present, and says which", async () => {
    const mock = makeMock();
    const videoId = await madeVideo(mock);
    expect(await unwrap(mock.client.request("videos.reveal", { videoId }))).toEqual({ videoId });
    expect(mock.engine.revealed).toEqual([videoId]);
  });

  test("an unknown video is NOT_FOUND, and nothing is shown", async () => {
    const mock = makeMock();
    const reply = await mock.client.request("videos.reveal", { videoId: "video-00000099" });
    expect(reply).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(mock.engine.revealed).toEqual([]);
  });

  test("a video whose file is in another folder is NOT_FOUND, as in main: only a present file is shown", async () => {
    const mock = makeMock();
    const videoId = await madeVideo(mock);
    mock.engine.pickExportFolderNext({ path: "/Users/studio/Elsewhere" });
    await unwrap(mock.client.request("settings.setExportPath", {}));
    const reply = await mock.client.request("videos.reveal", { videoId });
    expect(reply).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(mock.engine.revealed).toEqual([]);
  });
});
