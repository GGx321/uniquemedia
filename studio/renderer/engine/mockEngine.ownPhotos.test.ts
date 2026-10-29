import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../../shared/engine/montage";
import { MOCK_RENDER_STEPS } from "./mockEngine";
import { makeMock, MIA, unwrap, type Mock } from "./mockEngine.testkit";

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

});

describe("media.delete while a render uses the media", () => {
  test("a queued or running render refuses it with IN_FLIGHT, and the media stays listed", async () => {
    const mock = makeMock();
    const mediaId = await storePhoto(mock);
    await unwrap(render(mock, specOf(mediaId, mediaId)));

    expect(await remove(mock, mediaId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(1);
  });

});

void MOCK_RENDER_STEPS;
