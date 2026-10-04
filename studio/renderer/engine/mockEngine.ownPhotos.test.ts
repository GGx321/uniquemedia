import { describe, expect, test } from "bun:test";
import { JobState } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import { MOCK_RENDER_STEPS } from "./mockEngine";
import { makeMock, MIA, PHOTO_IDS, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.2 in the mock: own photos play as the engine plays them. An own photo in a cell renders when the library holds it as a photo and is
// `media-unavailable` when it does not; a queued or running render holds the media against `media.delete` (IN_FLIGHT) until it ends; the
// draft's issues and the focus of an own photo say what the engine says; an importer can refuse a file inside its job. The parity suite
// holds the two side by side.

const lake = { name: "lake.jpg", accept: { kind: "photo", bytes: 120 } } as const;

/** Imports one photo to the end and answers its media id. */
async function storePhoto(mock: Mock, file: { name: string; accept: { kind: "photo"; bytes: number; face?: boolean } } = lake): Promise<string> {
  mock.engine.pickMediaNext([file]);
  await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
  mock.scheduler.runAll();
  const listed = await unwrap(mock.client.request("media.list", {}));
  const media = listed.media.find((m) => m.name === file.name);
  if (media === undefined) throw new Error("the photo was not stored");
  return media.mediaId;
}

const ownClip = (n: number, mediaId: string): MontageDraft["clips"][number] => ({ clipId: `clip-0000000${n}`, kind: "photo", cell: { photo: { source: "own", mediaId }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" });
const specOf = (...mediaIds: string[]): MontageDraft => ({ schemaVersion: 1, avatarId: MIA.avatarId, layers: [], music: null, seed: 7, clips: mediaIds.map((id, i) => ownClip(i + 1, id)) });
const render = (mock: Mock, spec: MontageDraft) => mock.client.request("videos.render", { spec });
const remove = (mock: Mock, mediaId: string) => mock.client.request("media.delete", { mediaId });

describe("videos.render: an own photo in a cell", () => {
  test("a photo the library holds is no longer refused: the render is queued and ends done", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock);

    const { jobId } = await unwrap(render(mock, specOf(mediaId, mediaId)));
    mock.scheduler.runAll();

    expect(mock.events.some((e) => e.type === "job.done" && e.payload.jobId === jobId)).toBe(true);
  });

  test("a media that is not there is MONTAGE_INVALID with media-unavailable at each cell, and nothing is queued", async () => {
    const mock = makeMock();

    const reply = await render(mock, specOf("media-00000404", "media-00000404"));

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0, "cell"] }, { code: "media-unavailable", path: ["clips", 1, "cell"] }] } });
    expect(await unwrap(mock.client.request("engine.snapshot", {})).then((s) => s.jobs.filter((j) => j.kind === "render"))).toEqual([]);
  });

  test("a media held as another kind is the same", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([{ name: "walk.mov", accept: { kind: "video", bytes: 500 } }]);
    await unwrap(mock.client.request("media.pickImport", { kind: "video" }));
    mock.scheduler.runAll();
    const [video] = (await unwrap(mock.client.request("media.list", {}))).media;

    expect(await render(mock, specOf(video?.mediaId ?? "", video?.mediaId ?? ""))).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable" }, { code: "media-unavailable" }] } });
  });

  test("a spec with a structural issue is refused for it alone: the media is not looked at", async () => {
    const mock = makeMock();
    const short = { ...specOf("media-00000404"), clips: [{ ...ownClip(1, "media-00000404"), durationMs: 1_000 }] };

    const reply = await render(mock, short);

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID" } });
    if (reply.ok) throw new Error("expected a refusal");
    expect((reply.error.issues ?? []).map((i) => i.code)).toEqual(["duration-too-short"]);
  });

  test("an own video clip is judged like any own media (3f.3b): one the library does not hold is media-unavailable at its clip", async () => {
    const mock = makeMock();
    const spec = { ...specOf(), clips: [{ clipId: "clip-00000001", kind: "video" as const, mediaId: "media-00000001", trimStartMs: 0, focus: null, durationMs: 4_000, transitionIn: "cut" as const }] };

    expect(await render(mock, spec)).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0] }] } });
  });
});

describe("media.delete while a render uses the media", () => {
  test("a queued or running render refuses it with IN_FLIGHT, and the media stays listed", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock);
    await unwrap(render(mock, specOf(mediaId, mediaId)));

    expect(await remove(mock, mediaId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(1);
  });

  test("a render that waits for a slot holds it too", async () => {
    const mock = makeMock();
    const first = await storePhoto(mock, { name: "a.jpg", accept: { kind: "photo", bytes: 100 } });
    const second = await storePhoto(mock, { name: "b.jpg", accept: { kind: "photo", bytes: 100 } });
    await unwrap(render(mock, specOf(first, first)));
    await unwrap(render(mock, specOf(second, second)));

    expect(await remove(mock, second)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  });

  test("it goes through once the render is done", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock);
    await unwrap(render(mock, specOf(mediaId, mediaId)));
    mock.scheduler.runAll();

    expect(await unwrap(remove(mock, mediaId))).toEqual({ mediaId });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });

  test("it goes through once the render was cancelled", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock);
    const { jobId } = await unwrap(render(mock, specOf(mediaId, mediaId)));
    await unwrap(mock.client.request("videos.cancel", { jobId }));
    mock.scheduler.runAll();

    expect(await unwrap(remove(mock, mediaId))).toEqual({ mediaId });
  });

  test("it goes through once the render failed", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock);
    mock.engine.failNextRender({ code: "RENDER_FAILED", detail: "ffmpeg failed" }, "encode");
    await unwrap(render(mock, specOf(mediaId, mediaId)));
    mock.scheduler.runAll();

    expect(await unwrap(remove(mock, mediaId))).toEqual({ mediaId });
  });

  test("a media no render uses is deleted at once, and a media that does not exist is NOT_FOUND, not IN_FLIGHT", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock);
    expect(await remove(mock, "media-00000404")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await unwrap(remove(mock, mediaId))).toEqual({ mediaId });
  });

  test("a media the render does not name is not held", async () => {
    const mock = makeMock();
    const used = await storePhoto(mock, { name: "a.jpg", accept: { kind: "photo", bytes: 100 } });
    const other = await storePhoto(mock, { name: "b.jpg", accept: { kind: "photo", bytes: 100 } });
    await unwrap(render(mock, specOf(used, used)));

    expect(await unwrap(remove(mock, other))).toEqual({ mediaId: other });
  });
});

describe("a draft's issues for an own photo", () => {
  async function draftWith(mock: Mock, spec: MontageDraft): Promise<string> {
    const created = await unwrap(mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [] }));
    await unwrap(mock.client.request("montages.save", { montageId: created.montage.montageId, spec, name: "own" }));
    return created.montage.montageId;
  }

  test("montages.get marks a deleted own photo at its cell and leaves a held one alone", async () => {
    const mock = makeMock();
    const kept = await storePhoto(mock, { name: "a.jpg", accept: { kind: "photo", bytes: 100 } });
    const gone = await storePhoto(mock, { name: "b.jpg", accept: { kind: "photo", bytes: 100 } });
    await unwrap(remove(mock, gone));
    const montageId = await draftWith(mock, specOf(kept, gone));

    expect((await unwrap(mock.client.request("montages.get", { montageId }))).issues).toEqual([{ code: "media-unavailable", path: ["clips", 1, "cell"] }]);
  });

  test("montages.list says the same for each draft", async () => {
    const mock = makeMock();
    const kept = await storePhoto(mock);
    const montageId = await draftWith(mock, specOf(kept, "media-00000404"));

    const listed = await unwrap(mock.client.request("montages.list", {}));

    expect(listed.items.find((i) => i.montage.montageId === montageId)?.issues).toEqual([{ code: "media-unavailable", path: ["clips", 1, "cell"] }]);
  });

  test("scene photos and own photos are judged in clip order", async () => {
    const mock = makeMock();
    const spec: MontageDraft = { ...specOf("media-00000404"), clips: [ownClip(1, "media-00000404"), { clipId: "clip-00000002", kind: "photo", cell: { photo: { source: "scene", photoId: PHOTO_IDS[0] ?? "" }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" }] };
    const montageId = await draftWith(mock, spec);

    expect((await unwrap(mock.client.request("montages.get", { montageId }))).issues).toEqual([{ code: "media-unavailable", path: ["clips", 0, "cell"] }]);
  });
});

describe("montages.focus of an own photo", () => {
  test("is no focus for a photo with no face", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock);

    expect(await unwrap(mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: { source: "own", mediaId } }))).toEqual({ focus: null });
  });

  test("is the face's point for a photo the script says has one", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock, { name: "face.jpg", accept: { kind: "photo", bytes: 100, face: true } });

    const answer = await unwrap(mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: { source: "own", mediaId } }));

    expect(answer.focus).not.toBeNull();
  });

  test("a media that is not there is NOT_FOUND", async () => {
    const mock = makeMock();

    expect(await mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: { source: "own", mediaId: "media-00000404" } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("a media held as another kind is NOT_FOUND", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([{ name: "walk.mov", accept: { kind: "video", bytes: 500 } }]);
    await unwrap(mock.client.request("media.pickImport", { kind: "video" }));
    mock.scheduler.runAll();
    const [video] = (await unwrap(mock.client.request("media.list", {}))).media;

    expect(await mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: { source: "own", mediaId: video?.mediaId ?? "" } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("an importer that refuses a file inside its job", () => {
  const dot = { name: "dot.png", accept: { kind: "photo", bytes: 100, failWith: "too-small" } } as const;

  test("the job fails with MEDIA_UNSUPPORTED and the importer's reason, in the engine's event order, and stores nothing", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([dot]);
    const answer = await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    if (!answer.picked) throw new Error("not picked");
    expect(answer.refused).toEqual([]);
    const mark = mock.events.length;

    mock.scheduler.runAll();

    const sent = mock.events.slice(mark);
    expect(typesOf(sent)).toEqual(["job.progress", "job.failed"]);
    expect(sent[1]?.payload).toMatchObject({ kind: "import", name: "dot.png", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "too-small" } });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });

  test("the failed job is in the snapshot as the contract's failed import", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([dot]);
    await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    mock.scheduler.runAll();

    const job = (await unwrap(mock.client.request("engine.snapshot", {}))).jobs.find((j) => j.kind === "import");

    expect(JobState.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({ status: "failed", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "too-small" } });
  });

  test("the next job takes its turn after a failed one", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([dot, lake]);
    await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    mock.scheduler.runAll();

    expect((await unwrap(mock.client.request("media.list", {}))).media.map((m) => m.name)).toEqual(["lake.jpg"]);
  });
});

void MOCK_RENDER_STEPS;
