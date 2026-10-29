import { describe, expect, test } from "bun:test";
import { draftOf, freePhotos, makeMock, MIA, NORA, PHOTO_IDS, renderDraft, SOFIA, unwrap, type Mock } from "./mockEngine.testkit";

// «Удалить аватар» in the mock, as the engine and main do it: `avatars.deletePreview` counts what would go (and refuses while the avatar is busy),
// `avatars.delete` removes the avatar from every list and announces `avatar.removed`. The Trash itself is main's: here it is the answer of the
// command, and a test that wants it to refuse forces TRASH_UNAVAILABLE.

const [P1, P2, P3, P4] = PHOTO_IDS as [string, string, string, string, string, string];


/** MIA with two draft montages and one finished video, and SOFIA beside her. */
async function withVideo(): Promise<Mock> {
  const mock = makeMock({ avatars: [{ ...MIA, photoCount: 6, eligibleUnusedCount: 6 }, { ...SOFIA, photoCount: 2, eligibleUnusedCount: 2 }, { ...NORA }], photos: [...freePhotos(6), ...freePhotos(2, SOFIA)] });
  const first = await draftOf(mock, [P1, P2]);
  await draftOf(mock, [P3]);
  await renderDraft(mock, first.montageId);
  mock.scheduler.runAll();
  return mock;
}

const deleteOf = (mock: Mock, avatarId: string) => mock.client.request("avatars.delete", { avatarId });

describe("avatars.delete", () => {

  test("removes the avatar from every list: avatars, photos, videos, drafts and the snapshot", async () => {
    const mock = await withVideo();

    await unwrap(deleteOf(mock, MIA.avatarId));

    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars.map((a) => a.avatarId)).not.toContain(MIA.avatarId);
    expect(await mock.client.request("photos.list", { avatarId: MIA.avatarId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await mock.client.request("videos.list", { avatarId: MIA.avatarId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await mock.client.request("montages.list", { avatarId: MIA.avatarId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await unwrap(mock.client.request("montages.list", {}))).items).toEqual([]);
    expect((await unwrap(mock.client.request("engine.snapshot", {}))).avatars.map((a) => a.avatarId)).not.toContain(MIA.avatarId);
  });

  test("is refused with IN_FLIGHT while a render of the avatar runs, and nothing is removed", async () => {
    const mock = await withVideo();
    await renderDraft(mock, (await draftOf(mock, [P4])).montageId);
    const mark = mock.events.length;

    expect(await deleteOf(mock, MIA.avatarId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

    expect(mock.events.slice(mark)).toEqual([]);
    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars.map((a) => a.avatarId)).toContain(MIA.avatarId);
  });

});
