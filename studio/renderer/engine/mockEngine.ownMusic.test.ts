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
const peaks = (mock: Mock, mediaId: string, startMs = 0, durationMs = 4_000, bars = 16) => mock.client.request("music.peaks", { track: { source: "own", mediaId }, startMs, durationMs, bars });

describe("videos.render: an own track as the music", () => {
  test("a track the library holds is no longer refused: the render is queued and ends done", async () => {
    const mock = makeMock();
    const mediaId = await storeTrack(mock);

    const { jobId } = await unwrap(render(mock, specWith(mediaId)));
    mock.scheduler.runAll();

    expect(mock.events.some((e) => e.type === "job.done" && e.payload.jobId === jobId)).toBe(true);
  });

  test("a media that is not there is MONTAGE_INVALID with media-unavailable at music, and nothing is queued", async () => {
    const mock = makeMock();

    const reply = await render(mock, specWith("media-00000404"));

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] } });
    expect(await unwrap(mock.client.request("engine.snapshot", {})).then((s) => s.jobs.filter((j) => j.kind === "render"))).toEqual([]);
  });

  test("a media held as another kind (a photo) is the same", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([{ name: "lake.jpg", accept: { kind: "photo", bytes: 120 } }]);
    await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    mock.scheduler.runAll();
    const [photo] = (await unwrap(mock.client.request("media.list", {}))).media;

    expect(await render(mock, specWith(photo?.mediaId ?? ""))).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["music"] }] } });
  });

  test("a track one millisecond short of startMs plus the montage is track-too-short; one exactly as long renders", async () => {
    const mock = makeMock();
    const mediaId = await storeTrack(mock, song("short.mp3", 5_499));
    expect(await render(mock, specWith(mediaId, 1_500))).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "track-too-short", path: ["music"] }] } });

    const exact = await storeTrack(mock, song("exact.mp3", 5_500));
    expect((await render(mock, specWith(exact, 1_500))).ok).toBe(true);
  });

  test("a spec with a structural issue is refused for it alone: the media is not looked at", async () => {
    const mock = makeMock();
    const reply = await render(mock, { ...specWith("media-00000404"), clips: [] });

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID" } });
    if (reply.ok) throw new Error("expected a refusal");
    expect((reply.error.issues ?? []).map((i) => i.code)).toEqual(["no-clips"]);
  });

  test("an own photo and an own track are judged together, the photo first", async () => {
    const mock = makeMock();
    const spec: MontageDraft = { ...specWith("media-00000404"), clips: [{ clipId: "clip-00000001", kind: "photo", cell: { photo: { source: "own", mediaId: "media-00000405" }, focus: null }, motion: "static", durationMs: 4_000, transitionIn: "cut" }] };

    const reply = await render(mock, spec);

    expect(reply).toMatchObject({ ok: false, error: { issues: [{ code: "media-unavailable", path: ["clips", 0, "cell"] }, { code: "media-unavailable", path: ["music"] }] } });
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

  test("a render that waits for a slot holds it too", async () => {
    const mock = makeMock();
    const first = await storeTrack(mock, song("a.mp3"));
    const second = await storeTrack(mock, song("b.mp3"));
    await unwrap(render(mock, specWith(first)));
    await unwrap(render(mock, specWith(second, 0, [PHOTO_IDS[2] ?? "", PHOTO_IDS[3] ?? ""])));

    expect(await remove(mock, second)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  });

  test("it goes through once the render is done, was cancelled, or failed", async () => {
    const done = makeMock();
    const a = await storeTrack(done);
    await unwrap(render(done, specWith(a)));
    done.scheduler.runAll();
    expect(await unwrap(remove(done, a))).toEqual({ mediaId: a });

    const cancelled = makeMock();
    const b = await storeTrack(cancelled);
    const { jobId } = await unwrap(render(cancelled, specWith(b)));
    await unwrap(cancelled.client.request("videos.cancel", { jobId }));
    cancelled.scheduler.runAll();
    expect(await unwrap(remove(cancelled, b))).toEqual({ mediaId: b });

    const failing = makeMock();
    const c = await storeTrack(failing);
    failing.engine.failNextRender({ code: "RENDER_FAILED", detail: "ffmpeg failed" }, "encode");
    await unwrap(render(failing, specWith(c)));
    failing.scheduler.runAll();
    expect(await unwrap(remove(failing, c))).toEqual({ mediaId: c });
  });

  test("a track the render does not name is not held", async () => {
    const mock = makeMock();
    const used = await storeTrack(mock, song("a.mp3"));
    const other = await storeTrack(mock, song("b.mp3"));
    await unwrap(render(mock, specWith(used)));

    expect(await unwrap(remove(mock, other))).toEqual({ mediaId: other });
  });
});

describe("a draft's issues for an own track", () => {
  async function draftWith(mock: Mock, spec: MontageDraft): Promise<string> {
    const created = await unwrap(mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [] }));
    await unwrap(mock.client.request("montages.save", { montageId: created.montage.montageId, spec, name: "own" }));
    return created.montage.montageId;
  }

  test("montages.get marks a deleted track at the music, a track too short for its start, and leaves a held one alone", async () => {
    const mock = makeMock();
    const kept = await storeTrack(mock);
    const montageId = await draftWith(mock, specWith(kept));
    expect((await unwrap(mock.client.request("montages.get", { montageId }))).issues).toEqual([]);

    await unwrap(mock.client.request("montages.save", { montageId, spec: specWith(kept, 8_000), name: "own" }));
    expect((await unwrap(mock.client.request("montages.get", { montageId }))).issues).toEqual([{ code: "track-too-short", path: ["music"] }]);

    await unwrap(remove(mock, kept));
    expect((await unwrap(mock.client.request("montages.get", { montageId }))).issues).toEqual([{ code: "media-unavailable", path: ["music"] }]);
  });

  test("montages.list says the same for each draft", async () => {
    const mock = makeMock();
    const montageId = await draftWith(mock, specWith("media-00000404"));

    const listed = await unwrap(mock.client.request("montages.list", {}));

    expect(listed.items.find((i) => i.montage.montageId === montageId)?.issues).toEqual([{ code: "media-unavailable", path: ["music"] }]);
  });
});

describe("music.peaks of an own track", () => {
  test("is the waveform the script gave, windowed as a trending track's is", async () => {
    const mock = makeMock();
    const waveform = Array.from({ length: 180 }, (_, i) => (i * 50) % 1001);
    const mediaId = await storeTrack(mock, song("wave.mp3", 9_000, waveform));

    const answer = await unwrap(peaks(mock, mediaId, 0, 9_000, 18));

    expect(answer.peaks).toHaveLength(18);
    // 18 bars over 180 steps: ten steps a bar, each the largest of its ten.
    expect(answer.peaks[0]).toBe(Math.max(...waveform.slice(0, 10)));
    expect(answer.peaks[17]).toBe(Math.max(...waveform.slice(170, 180)));
  });

  test("with no waveform in the script it is a stable one of the track's own length, 0 to 1000", async () => {
    const mock = makeMock();
    const mediaId = await storeTrack(mock);

    const first = await unwrap(peaks(mock, mediaId, 0, 9_000, 72));
    const second = await unwrap(peaks(mock, mediaId, 0, 9_000, 72));

    expect(second).toEqual(first);
    expect(first.peaks).toHaveLength(72);
    expect(first.peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 1000)).toBe(true);
    expect(Math.max(...first.peaks)).toBeGreaterThan(0);
  });

  test("a window past the end of the track is silence there", async () => {
    const mock = makeMock();
    const mediaId = await storeTrack(mock);

    expect((await unwrap(peaks(mock, mediaId, 60_000, 4_000, 16))).peaks).toEqual(new Array<number>(16).fill(0));
  });

  test("a media that is not there, one that is not a track, and a deleted track are NOT_FOUND with the engine's detail", async () => {
    const mock = makeMock();
    const detail = "own music is not available yet";
    expect(await peaks(mock, "media-00000404")).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail } });

    mock.engine.pickMediaNext([{ name: "lake.jpg", accept: { kind: "photo", bytes: 120 } }]);
    await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    mock.scheduler.runAll();
    const [photo] = (await unwrap(mock.client.request("media.list", { kind: "photo" }))).media;
    expect(await peaks(mock, photo?.mediaId ?? "")).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail } });

    const gone = await storeTrack(mock);
    await unwrap(remove(mock, gone));
    expect(await peaks(mock, gone)).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail } });
  });

  test("the contract's bounds still hold: 15 bars is VALIDATION", async () => {
    const mock = makeMock();
    const mediaId = await storeTrack(mock);

    expect(await peaks(mock, mediaId, 0, 4_000, 15)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
});

describe("the dev build's seed of own media", () => {
  test("the demo preset holds one own track, so the editor can show a «свой трек» with a name, a length and a waveform", async () => {
    const mock = makeMock({ preset: "demo" });
    const listed = await unwrap(mock.client.request("media.list", { kind: "audio" }));

    expect(listed.total).toBe(1);
    const track = listed.media[0];
    expect(track).toMatchObject({ kind: "audio", name: "demo-voiceover.mp3" });
    expect(track?.durationMs).toBeGreaterThan(8_000);
    expect((await unwrap(peaks(mock, track?.mediaId ?? "", 0, 4_000, 16))).peaks).toHaveLength(16);
  });

  test("a mock that is not the demo holds none", async () => {
    const mock = makeMock();
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });

  test("seedOwnMedia puts records in the library as if they had been imported", async () => {
    const mock = makeMock();
    mock.engine.seedOwnMedia([{ kind: "audio", name: "seed.mp3", bytes: 5_000, facts: { durationMs: 12_000 } }]);

    const listed = await unwrap(mock.client.request("media.list", { kind: "audio" }));

    expect(listed.media.map((m) => [m.name, m.durationMs])).toEqual([["seed.mp3", 12_000]]);
  });
});
