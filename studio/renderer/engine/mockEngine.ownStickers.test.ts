import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../../shared/engine/montage";
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

});

