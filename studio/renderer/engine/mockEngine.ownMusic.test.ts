import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../../shared/engine/montage";
import { makeMock, MIA, PHOTO_IDS, scene, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.4 in the mock: an own track plays as the engine plays it. It renders when the library holds it as a track long enough for its start and is
// `media-unavailable` (or `track-too-short`) when it does not; a queued or running render holds it against `media.delete` (IN_FLIGHT) until it ends;
// `music.peaks` answers its waveform, windowed by the same function as a trending track's, and NOT_FOUND with the engine's detail for anything else.
// The parity suite holds this and the engine side by side.

interface TrackFile {
  readonly name: string;
  readonly accept: { kind: "audio"; bytes: number; facts?: { durationMs?: number }; waveform?: number[] };
}
const song = (name = "song.mp3", durationMs = 9_000, waveform?: number[]): TrackFile => ({ name, accept: { kind: "audio", bytes: 4_000, facts: { durationMs }, ...(waveform === undefined ? {} : { waveform }) } });

/** Imports one track to the end and answers its media id. */
async function storeTrack(mock: Mock, file: TrackFile = song()): Promise<string> {
  mock.engine.pickMediaNext([file]);
  await unwrap(mock.client.request("media.pickImport", { kind: "audio" }));
  mock.scheduler.runAll();
  const listed = await unwrap(mock.client.request("media.list", { kind: "audio" }));
  const media = listed.media.find((m) => m.name === file.name);
  if (media === undefined) throw new Error("the track was not stored");
  return media.mediaId;
}

/** A 4 s montage of two scene-photo clips with the own track as its music. */
const specWith = (mediaId: string, startMs = 0, photos: readonly string[] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""]): MontageDraft => ({
  schemaVersion: 1,
  avatarId: MIA.avatarId,
  layers: [],
  music: { source: "own", mediaId, startMs },
  seed: 7,
  clips: photos.map((photoId, i) => ({ clipId: `clip-0000000${i + 1}`, kind: "photo" as const, cell: { photo: scene(photoId), focus: null }, motion: "static" as const, durationMs: 2_000, transitionIn: "cut" as const })),
});
const render = (mock: Mock, spec: MontageDraft) => mock.client.request("videos.render", { spec });
const remove = (mock: Mock, mediaId: string) => mock.client.request("media.delete", { mediaId });

describe("videos.render: an own track as the music", () => {
  test("a track the library holds is no longer refused: the render is queued and ends done", async () => {
    const mock = makeMock();
    const mediaId = await storeTrack(mock);

    const { jobId } = await unwrap(render(mock, specWith(mediaId)));
    mock.scheduler.runAll();

    expect(mock.events.some((e) => e.type === "job.done" && e.payload.jobId === jobId)).toBe(true);
  });

});

describe("media.delete while a render uses the track", () => {
  test("a queued or running render refuses it with IN_FLIGHT, and the track stays listed", async () => {
    const mock = makeMock();
    const mediaId = await storeTrack(mock);
    await unwrap(render(mock, specWith(mediaId)));

    expect(await remove(mock, mediaId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(1);
  });

});

