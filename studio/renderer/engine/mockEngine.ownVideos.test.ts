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

describe("videos.render: an own video clip", () => {
  test("a video the library holds is no longer refused: the render is queued and ends done", async () => {
    const mock = makeMock();
    const mediaId = await storeVideo(mock);

    const { jobId } = await unwrap(render(mock, specWith(mediaId, 1_000)));
    mock.scheduler.runAll();

    expect(mock.events.some((e) => e.type === "job.done" && e.payload.jobId === jobId)).toBe(true);
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

});

