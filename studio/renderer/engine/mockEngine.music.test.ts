import { describe, expect, test } from "bun:test";
import { draftOf, makeMock, PHOTO_IDS, unwrap } from "./mockEngine.testkit";

// 3c.5: the mock follows the real engine for a montage's music. N9 is lifted for a trending track, whose referential answer is
// `track-unavailable` (the mock holds no tracks, like an engine with no track store), by the same function the engine uses;
// an own track is still `not-yet-supported` until 3f.4. The parity suite (studio/engine/parity) holds the two side by side.

const [P1, P2] = PHOTO_IDS as [string, string, string, string, string, string] as unknown as [string, string];
const trending = { source: "trending" as const, trackId: "4199287736976977", startMs: 1_500 };
const own = { source: "own" as const, mediaId: "media-0000001", startMs: 0 };

async function withMusic(music: typeof trending | typeof own) {
  const mock = makeMock();
  const draft = await draftOf(mock, [P1, P2]);
  const saved = await unwrap(mock.client.request("montages.save", { montageId: draft.montageId, spec: { ...draft.spec, music }, name: null }));
  return { mock, montageId: saved.montage.montageId, spec: saved.montage.spec };
}

describe("the mock's music", () => {
  test("videos.render refuses a trending track the mock does not hold as track-unavailable at music, and queues nothing", async () => {
    const { mock, montageId } = await withMusic(trending);

    const reply = await mock.client.request("videos.render", { montageId });

    expect(reply).toEqual({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "track-unavailable", path: ["music"] }] } });
    const { jobs } = await unwrap(mock.client.request("engine.snapshot", {}));
    expect(jobs).toEqual([]);
  });

  test("videos.render {spec} says the same for a headless spec", async () => {
    const { mock, spec } = await withMusic(trending);

    const reply = await mock.client.request("videos.render", { spec });

    expect(reply).toEqual({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "track-unavailable", path: ["music"] }] } });
  });

  test("montages.get lists track-unavailable for the draft, as the engine does", async () => {
    const { mock, montageId } = await withMusic(trending);

    const { issues } = await unwrap(mock.client.request("montages.get", { montageId }));

    expect(issues).toEqual([{ code: "track-unavailable", path: ["music"] }]);
  });

  test("an own track is still not-yet-supported, and no track issue is added to it", async () => {
    const { mock, montageId } = await withMusic(own);

    const { issues } = await unwrap(mock.client.request("montages.get", { montageId }));
    const reply = await mock.client.request("videos.render", { montageId });

    expect(issues).toEqual([{ code: "not-yet-supported", path: ["music"] }]);
    expect(reply).toEqual({ ok: false, error: { code: "MONTAGE_INVALID", issues: [{ code: "not-yet-supported", path: ["music"] }] } });
  });

  test("a montage with no music has no music issue", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);

    const { issues } = await unwrap(mock.client.request("montages.get", { montageId: draft.montageId }));

    expect(issues).toEqual([]);
  });
});
