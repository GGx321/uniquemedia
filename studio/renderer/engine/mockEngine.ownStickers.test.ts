import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../../shared/engine/montage";
import { inspectApng } from "../../shared/stickers/apng";
import { draftOf, makeMock, PHOTO_IDS, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.5 in the mock: own stickers play as the engine plays them. An own sticker in a layer renders when the library holds it as a sticker and is
// `media-unavailable` when it does not; a queued or running render holds the media against `media.delete` (IN_FLIGHT) until it ends; the draft's
// issues say what the engine says; `media.stickerBytes` answers the bytes of the stored sticker's stand-in, as main answers the stored file; an
// importer can refuse a file inside its job with the sticker reasons. The parity suite holds the two side by side.

interface StickerFile {
  name: string;
  accept: { kind: "sticker"; bytes: number; facts?: { width?: number; height?: number; loopFrames?: number; delayFrames?: number[] } };
}

const party: StickerFile = { name: "party.gif", accept: { kind: "sticker", bytes: 90_000, facts: { width: 12, height: 8, loopFrames: 6, delayFrames: [3, 3] } } };

/** Imports one sticker to the end and answers its media id. */
async function storeSticker(mock: Mock, file: StickerFile = party): Promise<string> {
  mock.engine.pickMediaNext([file]);
  await unwrap(mock.client.request("media.pickImport", { kind: "sticker" }));
  mock.scheduler.runAll();
  const listed = await unwrap(mock.client.request("media.list", { kind: "sticker" }));
  const media = listed.media.find((m) => m.name === file.name);
  if (media === undefined) throw new Error("the sticker was not stored");
  return media.mediaId;
}

const ownLayer = (n: number, mediaId: string): MontageDraft["layers"][number] => ({ layerId: `layer-0000000${n}`, kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "own", mediaId }, x: 0.5, y: 0.5, size: 0.3 });

/** A spec of one scene photo for 4 s (the mock's demo avatar has usable photos) with these own stickers as layers. */
async function specWith(mock: Mock, ...mediaIds: string[]): Promise<MontageDraft> {
  const draft = await draftOf(mock, [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""]);
  const got = await unwrap(mock.client.request("montages.get", { montageId: draft.montageId }));
  return { ...got.montage.spec, layers: mediaIds.map((id, i) => ownLayer(i + 1, id)) };
}

const render = (mock: Mock, spec: MontageDraft) => mock.client.request("videos.render", { spec });
const remove = (mock: Mock, mediaId: string) => mock.client.request("media.delete", { mediaId });

describe("videos.render: an own sticker in a layer", () => {
  test("a sticker the library holds is no longer refused: the render is queued and ends done", async () => {
    const mock = makeMock();
    const mediaId = await storeSticker(mock);

    const { jobId } = await unwrap(render(mock, await specWith(mock, mediaId)));
    mock.scheduler.runAll();

    expect(mock.events.some((e) => e.type === "job.done" && e.payload.jobId === jobId)).toBe(true);
  });

  test("a media that is not there is MONTAGE_INVALID with media-unavailable at its layer's sticker, and nothing is queued", async () => {
    const mock = makeMock();

    const reply = await render(mock, await specWith(mock, "media-00000404", "media-00000404"));

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["layers", 0, "sticker"] }, { code: "media-unavailable", path: ["layers", 1, "sticker"] }] } });
    expect(await unwrap(mock.client.request("engine.snapshot", {})).then((s) => s.jobs.filter((j) => j.kind === "render"))).toEqual([]);
  });

  test("a media held as a PHOTO is not a sticker: the same refusal", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([{ name: "lake.jpg", accept: { kind: "photo", bytes: 120 } }]);
    await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    mock.scheduler.runAll();
    const [photo] = (await unwrap(mock.client.request("media.list", {}))).media;

    expect(await render(mock, await specWith(mock, photo?.mediaId ?? ""))).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["layers", 0, "sticker"] }] } });
  });

  test("a spec with a structural issue is refused for it alone: the media is not looked at", async () => {
    const mock = makeMock();
    const spec = await specWith(mock, "media-00000404");
    const short = { ...spec, clips: spec.clips.map((clip) => ({ ...clip, durationMs: 500 })) };

    const reply = await render(mock, short);

    expect(reply).toMatchObject({ ok: false, error: { code: "MONTAGE_INVALID" } });
    if (reply.ok) throw new Error("expected a refusal");
    expect((reply.error.issues ?? []).every((i) => i.code !== "media-unavailable")).toBe(true);
  });

  test("a missing own photo and a missing own sticker are both reported, the photo first", async () => {
    const mock = makeMock();
    const spec = await specWith(mock, "media-00000404");
    const withOwnPhoto = { ...spec, clips: [{ clipId: "clip-90000001", kind: "photo" as const, cell: { photo: { source: "own" as const, mediaId: "media-00000405" }, focus: null }, motion: "static" as const, durationMs: 4_000, transitionIn: "cut" as const }] };

    const reply = await render(mock, withOwnPhoto);

    expect(reply).toMatchObject({
      ok: false,
      error: { code: "MONTAGE_INVALID", issues: [{ code: "media-unavailable", path: ["clips", 0, "cell"] }, { code: "media-unavailable", path: ["layers", 0, "sticker"] }] },
    });
  });
});

describe("media.delete while a render uses the sticker", () => {
  test("a queued or running render refuses it with IN_FLIGHT, and the media stays listed; once the render ends the same delete goes through", async () => {
    const mock = makeMock();
    const mediaId = await storeSticker(mock);
    const { jobId } = await unwrap(render(mock, await specWith(mock, mediaId)));

    expect(await remove(mock, mediaId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect((await unwrap(mock.client.request("media.list", { kind: "sticker" }))).total).toBe(1);

    mock.scheduler.runAll();
    expect(mock.events.some((e) => e.type === "job.done" && e.payload.jobId === jobId)).toBe(true);
    expect(await remove(mock, mediaId)).toMatchObject({ ok: true });
  });

  test("a sticker that no render uses is deleted at once", async () => {
    const mock = makeMock();
    const mediaId = await storeSticker(mock);
    expect(await remove(mock, mediaId)).toMatchObject({ ok: true });
  });

  test("a render the owner cancels lets the sticker go", async () => {
    const mock = makeMock();
    const mediaId = await storeSticker(mock);
    const { jobId } = await unwrap(render(mock, await specWith(mock, mediaId)));

    await unwrap(mock.client.request("videos.cancel", { jobId }));
    mock.scheduler.runAll();

    expect(await remove(mock, mediaId)).toMatchObject({ ok: true });
  });
});

describe("montages.get: an own sticker in a draft", () => {
  test("a held sticker is no issue, a deleted one is media-unavailable at its layer's sticker", async () => {
    const mock = makeMock();
    const kept = await storeSticker(mock);
    const gone = await storeSticker(mock, { ...party, name: "other.gif" });
    await unwrap(remove(mock, gone));
    const draft = await draftOf(mock, [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""]);
    const spec = { ...(await specWith(mock, kept, gone)) };
    await unwrap(mock.client.request("montages.save", { montageId: draft.montageId, spec, name: null }));

    const got = await unwrap(mock.client.request("montages.get", { montageId: draft.montageId }));

    expect(got.issues).toEqual([{ code: "media-unavailable", path: ["layers", 1, "sticker"] }]);
  });
});

describe("media.stickerBytes: the stored sticker's bytes for the preview", () => {
  const bytesOf = (base64: string): Uint8Array => Uint8Array.from(Buffer.from(base64, "base64"));

  test("a held sticker answers an APNG with the record's canvas, loop and delays", async () => {
    const mock = makeMock();
    const mediaId = await storeSticker(mock);

    const { apngBase64, mediaId: echoed } = await unwrap(mock.client.request("media.stickerBytes", { mediaId }));

    expect(echoed).toBe(mediaId);
    const inspected = inspectApng(bytesOf(apngBase64));
    if (!inspected.ok) throw new Error(`${inspected.code}: ${inspected.detail}`);
    expect([inspected.info.width, inspected.info.height, inspected.info.loopFrames]).toEqual([12, 8, 6]);
    expect(inspected.info.frames.map((f) => f.delayFrames)).toEqual([3, 3]);
  });

  test("an id the library does not hold is NOT_FOUND, with the engine's fixed text", async () => {
    const mock = makeMock();
    expect(await mock.client.request("media.stickerBytes", { mediaId: "media-00000404" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail: "no such own sticker" } });
  });

  test("an own photo's id is NOT_FOUND too: the kind must be sticker", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([{ name: "lake.jpg", accept: { kind: "photo", bytes: 120 } }]);
    await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    mock.scheduler.runAll();
    const [photo] = (await unwrap(mock.client.request("media.list", {}))).media;
    expect(await mock.client.request("media.stickerBytes", { mediaId: photo?.mediaId ?? "" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("a deleted sticker is NOT_FOUND", async () => {
    const mock = makeMock();
    const mediaId = await storeSticker(mock);
    await unwrap(remove(mock, mediaId));
    expect(await mock.client.request("media.stickerBytes", { mediaId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("a sticker's bytes never name a path", async () => {
    const mock = makeMock();
    const mediaId = await storeSticker(mock);
    const reply = await mock.client.request("media.stickerBytes", { mediaId });
    expect(JSON.stringify({ ...reply, result: undefined })).not.toMatch(/\.png|\.json|\//);
  });
});

describe("an own sticker's import inside its job", () => {
  test("a still file is refused with not-animated, a long one with loop-too-long, and nothing is stored", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([
      { name: "still.png", accept: { kind: "sticker", bytes: 100, failWith: "not-animated" } },
      { name: "long.gif", accept: { kind: "sticker", bytes: 100, failWith: "loop-too-long" } },
    ]);
    await unwrap(mock.client.request("media.pickImport", { kind: "sticker" }));
    mock.scheduler.runAll();

    const failures = mock.events.filter((e) => e.type === "job.failed");
    expect(failures.map((e) => (e.payload as { error: { mediaReason?: string } }).error.mediaReason)).toEqual(["not-animated", "loop-too-long"]);
    expect((await unwrap(mock.client.request("media.list", { kind: "sticker" }))).total).toBe(0);
  });

  test("an imported sticker's record has the facts the script gave: canvas, loop and per-frame delays that add up", async () => {
    const mock = makeMock();
    await storeSticker(mock);
    const [sticker] = (await unwrap(mock.client.request("media.list", { kind: "sticker" }))).media;
    expect(sticker).toMatchObject({ kind: "sticker", width: 12, height: 8, loopFrames: 6, delayFrames: [3, 3] });
  });
});

describe("the dev seed", () => {
  test("a demo mock can hold a seeded own sticker, listed as a sticker, with its bytes", async () => {
    const mock = makeMock({ preset: "demo", seedOwnSticker: true });

    const listed = await unwrap(mock.client.request("media.list", { kind: "sticker" }));

    expect(listed.total).toBe(1);
    expect(listed.media[0]?.kind).toBe("sticker");
    expect(await mock.client.request("media.stickerBytes", { mediaId: listed.media[0]?.mediaId ?? "" })).toMatchObject({ ok: true });
  });

  test("a mock without the option holds none", async () => {
    const mock = makeMock({ preset: "demo" });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });
});

describe("a draft that names an own sticker", () => {
  test("is no longer refused as not-yet-supported", async () => {
    const mock = makeMock();
    const mediaId = await storeSticker(mock);
    const draft = await draftOf(mock, [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""]);
    await unwrap(mock.client.request("montages.save", { montageId: draft.montageId, spec: await specWith(mock, mediaId), name: null }));

    const got = await unwrap(mock.client.request("montages.get", { montageId: draft.montageId }));

    expect(got.issues.map((i) => i.code)).not.toContain("not-yet-supported");
  });
});
