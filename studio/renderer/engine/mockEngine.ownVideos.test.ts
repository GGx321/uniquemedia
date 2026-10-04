import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../../shared/engine/montage";
import { makeMock, MIA, PHOTO_IDS, scene, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.3b in the mock: an own video clip plays as the engine plays it. It renders when the library holds the media as a video long enough for the clip
// (`trimStartMs` plus its length) and is `media-unavailable` (or `video-too-short`) when it does not; a queued or running render holds it against `media.delete`
// (IN_FLIGHT) until it ends; a draft's issues say the same as a render's refusal. The dev build holds a demo video so the editor has something to place.
// The parity suite holds this and the engine side by side.

interface VideoFile {
  readonly name: string;
  readonly accept: { kind: "video"; bytes: number; facts?: { durationMs?: number; width?: number; height?: number } };
}
const clipFile = (name = "holiday.mov", durationMs = 9_000, size: { width?: number; height?: number } = {}): VideoFile => ({ name, accept: { kind: "video", bytes: 4_000_000, facts: { durationMs, ...size } } });

/** Imports one video to the end and answers its media id. */
async function storeVideo(mock: Mock, file: VideoFile = clipFile()): Promise<string> {
  mock.engine.pickMediaNext([file]);
  await unwrap(mock.client.request("media.pickImport", { kind: "video" }));
  mock.scheduler.runAll();
  const listed = await unwrap(mock.client.request("media.list", { kind: "video" }));
  const media = listed.media.find((m) => m.name === file.name);
  if (media === undefined) throw new Error("the video was not stored");
  return media.mediaId;
}

const videoClip = (n: number, mediaId: string, trimStartMs: number, durationMs: number): MontageDraft["clips"][number] => ({ clipId: `clip-0000000${n}`, kind: "video", mediaId, trimStartMs, focus: null, durationMs, transitionIn: "cut" });
const photoClip = (n: number, photoId: string, durationMs: number): MontageDraft["clips"][number] => ({ clipId: `clip-0000000${n}`, kind: "photo", cell: { photo: scene(photoId), focus: null }, motion: "static", durationMs, transitionIn: "cut" });

/** A 4 s montage: a 2 s scene-photo clip, then a 2 s clip of the own video from `trimStartMs`. */
const specWith = (mediaId: string, trimStartMs = 0, durationMs = 2_000): MontageDraft => ({
  schemaVersion: 1,
  avatarId: MIA.avatarId,
  layers: [],
  music: null,
  seed: 7,
  clips: [photoClip(1, PHOTO_IDS[0] ?? "", 2_000), videoClip(2, mediaId, trimStartMs, durationMs)],
});
const render = (mock: Mock, spec: MontageDraft) => mock.client.request("videos.render", { spec });
const remove = (mock: Mock, mediaId: string) => mock.client.request("media.delete", { mediaId });
const issuesOf = async (mock: Mock, spec: MontageDraft) => {
  const created = await unwrap(mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [PHOTO_IDS[0] ?? ""] }));
  await unwrap(mock.client.request("montages.save", { montageId: created.montage.montageId, spec, name: null }));
  return (await unwrap(mock.client.request("montages.get", { montageId: created.montage.montageId }))).issues;
};

describe("videos.render: an own video clip", () => {
  test("a video the library holds is no longer refused: the render is queued and ends done", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);

    const { jobId } = await unwrap(render(mock, specWith(mediaId, 1_000)));
    mock.scheduler.runAll();

    expect(mock.events.some((e) => e.type === "job.done" && e.payload.jobId === jobId)).toBe(true);
  });

  test("a render with an own video reports the progress of its copy when it runs, before any step of its own, as the engine's job does (M-2)", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);
    const { jobId } = await unwrap(render(mock, specWith(mediaId)));
    const progress = (): number[] => mock.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "render" && e.payload.jobId === jobId ? [e.payload.done] : []));

    expect(progress()).toEqual([0]);
    mock.scheduler.runAll();

    // Announced at zero, then the copy: a share of the bar that is more than nothing and far from the end, then the steps.
    expect(progress().length).toBeGreaterThan(2);
    expect(progress()[0]).toBe(0);
    expect(progress()[1]).toBeGreaterThan(0);
    expect(progress()[1]).toBeLessThan(40);
  });

  test("a render with no own video has no copy to report: its first progress is its first step", async () => {
    const mock = makeMock();
    const reply = await unwrap(render(mock, { ...specWith("media-x"), clips: [{ clipId: "clip-00000001", kind: "photo", cell: { photo: scene(PHOTO_IDS[0] ?? ""), focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" }, { clipId: "clip-00000002", kind: "photo", cell: { photo: scene(PHOTO_IDS[1] ?? ""), focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" }] }));
    const first = mock.events.filter((e) => e.type === "job.progress" && e.payload.kind === "render" && e.payload.jobId === reply.jobId);
    expect(first).toHaveLength(1);
    mock.scheduler.runAll();
    const steps = mock.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "render" && e.payload.jobId === reply.jobId ? [e.payload.done] : []));
    expect(steps[1]).toBeGreaterThanOrEqual(steps[0] ?? 0);
  });

  test("the finished video is a mix: a video clip is not a photo", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);
    await unwrap(render(mock, specWith(mediaId)));
    mock.scheduler.runAll();

    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));

    expect(videos[0]?.kind).toBe("mix");
  });

  test("a media that is not there is MONTAGE_INVALID with media-unavailable at its clip, and nothing is queued", async () => {
    const mock = makeMock();

    const reply = await render(mock, specWith("media-00000404"));

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 1] }] } });
    expect(await unwrap(mock.client.request("engine.snapshot", {})).then((s) => s.jobs.filter((j) => j.kind === "render"))).toEqual([]);
  });

  test("a media held as another kind (a photo) is the same", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([{ name: "lake.jpg", accept: { kind: "photo", bytes: 120 } }]);
    await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    mock.scheduler.runAll();
    const [photo] = (await unwrap(mock.client.request("media.list", {}))).media;

    expect(await render(mock, specWith(photo?.mediaId ?? ""))).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 1] }] } });
  });

  test("a clip that ends exactly at the video's end is rendered", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock, clipFile("exact.mov", 5_000));

    expect((await render(mock, specWith(mediaId, 3_000, 2_000))).ok).toBe(true);
  });

  test("a clip that asks one step past the video's end is video-too-short at its clip, never a shorter clip, and nothing is queued", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock, clipFile("short.mov", 5_000));

    const reply = await render(mock, specWith(mediaId, 3_100, 2_000));

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "video-too-short", path: ["clips", 1] }] } });
    expect(await unwrap(mock.client.request("engine.snapshot", {})).then((s) => s.jobs.filter((j) => j.kind === "render"))).toEqual([]);
  });

  test("the issues come in the engine's order: own photos, then own videos, then own stickers, then the music", async () => {
    const mock = makeMock();
    const spec: MontageDraft = {
      ...specWith("media-00000404"),
      clips: [{ clipId: "clip-00000001", kind: "photo", cell: { photo: { source: "own", mediaId: "media-00000405" }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" }, videoClip(2, "media-00000404", 0, 2_000)],
      layers: [{ layerId: "layer-00000001", kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "own", mediaId: "media-00000406" }, x: 0.5, y: 0.5, size: 0.3 }],
      music: { source: "own", mediaId: "media-00000407", startMs: 0 },
    };

    const reply = await render(mock, spec);

    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: "MONTAGE_INVALID",
        issues: [
          { code: "media-unavailable", path: ["clips", 0, "cell"] },
          { code: "media-unavailable", path: ["clips", 1] },
          { code: "media-unavailable", path: ["layers", 0, "sticker"] },
          { code: "media-unavailable", path: ["music"] },
        ],
      },
    });
  });
});

describe("media.delete while a render uses the video", () => {
  test("a RUNNING or QUEUED render refuses the delete with IN_FLIGHT, and the media stays; once the render ends the same delete goes through", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);
    await unwrap(render(mock, specWith(mediaId)));

    expect(await remove(mock, mediaId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(1);

    mock.scheduler.runAll();
    expect(await unwrap(remove(mock, mediaId))).toEqual({ mediaId });
  });

  test("a video that no render uses is deleted at once", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);

    expect(await unwrap(remove(mock, mediaId))).toEqual({ mediaId });
  });

  test("a render the owner cancels lets the video go once it has stopped", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);
    const { jobId } = await unwrap(render(mock, specWith(mediaId)));

    await unwrap(mock.client.request("videos.cancel", { jobId }));
    mock.scheduler.runAll();

    expect(await unwrap(remove(mock, mediaId))).toEqual({ mediaId });
  });
});

describe("montages.get: an own video clip", () => {
  test("a video the library holds, long enough, is no issue", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);

    expect(await issuesOf(mock, specWith(mediaId, 1_000))).toEqual([]);
  });

  test("a video that was deleted is media-unavailable at its clip, as a render says", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);
    await unwrap(remove(mock, mediaId));

    expect(await issuesOf(mock, specWith(mediaId))).toEqual([{ code: "media-unavailable", path: ["clips", 1] }]);
  });

  test("a clip that outgrows its video is video-too-short at its clip, the same issue a render refuses with", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock, clipFile("short.mov", 5_000));

    expect(await issuesOf(mock, specWith(mediaId, 3_100, 2_000))).toEqual([{ code: "video-too-short", path: ["clips", 1] }]);
  });

  test("N9 is lifted: nothing is `not-yet-supported` any more", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);

    expect((await issuesOf(mock, specWith(mediaId))).map((i) => i.code)).not.toContain("not-yet-supported");
  });
});

describe("the mock holds a video as the engine does: with a size and a length (L-6)", () => {
  test.each([
    ["no width", { width: null }],
    ["no height", { height: null }],
    ["no length", { durationMs: null }],
  ])("a stored video with %s is not one a render can read: media-unavailable at its clip", async (_name, facts) => {
    const mock = makeMock();
    mock.engine.seedOwnMedia([{ kind: "video", name: "odd.mov", bytes: 1_000, facts }]);

    const reply = await render(mock, specWith("media-demo-0001"));

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 1] }] } });
  });

  test("the same video with all three is held and renders", async () => {
    const mock = makeMock();
    mock.engine.seedOwnMedia([{ kind: "video", name: "ok.mov", bytes: 1_000, facts: { width: 100, height: 200, durationMs: 9_000 } }]);

    expect((await render(mock, specWith("media-demo-0001"))).ok).toBe(true);
  });
});

describe("the dev build's seed of an own video", () => {
  test("the demo preset holds one own video, as well as the track, so the editor can place a video clip with a name, a size and a length", async () => {
    const mock = makeMock({ preset: "demo" });
    const listed = await unwrap(mock.client.request("media.list", { kind: "video" }));

    expect(listed.total).toBe(1);
    const video = listed.media[0];
    expect(video).toMatchObject({ kind: "video", name: "demo-clip.mov", hdrToSdr: false, loopFrames: null });
    expect(video?.durationMs).toBeGreaterThan(8_000);
    expect(video?.width).not.toBeNull();
    expect(video?.height).not.toBeNull();
  });

  test("the demo still holds its track first: the own track keeps its id", async () => {
    const mock = makeMock({ preset: "demo" });
    const track = (await unwrap(mock.client.request("media.list", { kind: "audio" }))).media[0];
    expect(track?.mediaId).toBe("media-demo-0001");
  });

  test("a mock that is not the demo holds none", async () => {
    const mock = makeMock();
    expect((await unwrap(mock.client.request("media.list", { kind: "video" }))).total).toBe(0);
  });
});
