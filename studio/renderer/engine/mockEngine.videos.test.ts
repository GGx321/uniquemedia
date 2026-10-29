import { describe, expect, test } from "bun:test";
import type { EventMessage } from "../../shared/engine";
import { draftOf, makeMock, MIA, PHOTO_IDS, renderDraft, renderJobsOf, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// Stage 3, 3d.1b: the mock's videos and render jobs (`videos.render / cancel / list / delete`, `export.status`) follow the real
// engine: a render is queued, runs through progress and a saving phase, commits a record and ends, announcing itself in the
// engine's order; one photo goes into one video; and the refusals come in the engine's order. The parity suite
// (studio/engine/parity) holds the two side by side; these tests pin the mock's own behaviour and its controls.

const [P1, P2, P3, P4] = PHOTO_IDS as [string, string, string, string];
/** A draft of two photos is one 8 s collage: 240 frames. */
const TWO_PHOTO_FRAMES = 240;


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

  test("refuses a photo that is already in a video, with the issue at its cell, and queues nothing", async () => {
    const mock = makeMock();
    const first = await draftOf(mock, [P1, P2]);
    const second = await draftOf(mock, [P1]);
    await renderDraft(mock, first.montageId);
    mock.scheduler.runAll();
    const mark = mock.events.length;

    const reply = await mock.client.request("videos.render", { montageId: second.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "in-video", issues: [{ code: "photo-unavailable", path: ["clips", 0, "cell"] }] } });
    expect(eventsAfter(mock, mark)).toEqual([]);
    expect(await renderJobsOf(mock)).toHaveLength(1);
  });

  test("refuses a draft that is not complete with MONTAGE_INVALID and its issues", async () => {
    const mock = makeMock();
    const empty = await draftOf(mock, []);

    const reply = await mock.client.request("videos.render", { montageId: empty.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "no-clips", path: ["clips"] }] } });
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

});

// 3d.6: `videos.reveal` is main's command (it opens the OS file manager, for a video whose file is present). The demo build has no
// main, so the mock answers as main does and remembers which videos it was asked to show; nothing opens.

