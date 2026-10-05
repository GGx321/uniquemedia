import { describe, expect, test } from "bun:test";
import type { Draft } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { draftOf, freePhotos, makeMock, MIA, NORA, PHOTO_IDS, renderDraft, SOFIA, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// «Удалить аватар» in the mock, as the engine and main do it: `avatars.deletePreview` counts what would go (and refuses while the avatar is busy),
// `avatars.delete` removes the avatar from every list and announces `avatar.removed`. The Trash itself is main's: here it is the answer of the
// command, and a test that wants it to refuse forces TRASH_UNAVAILABLE.

const [P1, P2, P3, P4] = PHOTO_IDS as [string, string, string, string, string, string];

const A_DRAFT: Draft = { avatarId: "avatar-draft-0009", traits: DEFAULT_TRAITS, descriptor: MIA.descriptor, candidates: [], hiddenBelowThreshold: 0, estimate: null };

/** MIA with two draft montages and one finished video, and SOFIA beside her. */
async function withVideo(): Promise<Mock> {
  const mock = makeMock({ avatars: [{ ...MIA, photoCount: 6, eligibleUnusedCount: 6 }, { ...SOFIA, photoCount: 2, eligibleUnusedCount: 2 }, { ...NORA }], photos: [...freePhotos(6), ...freePhotos(2, SOFIA)] });
  const first = await draftOf(mock, [P1, P2]);
  await draftOf(mock, [P3]);
  await renderDraft(mock, first.montageId);
  mock.scheduler.runAll();
  return mock;
}

const previewOf = (mock: Mock, avatarId: string) => mock.client.request("avatars.deletePreview", { avatarId });
const deleteOf = (mock: Mock, avatarId: string) => mock.client.request("avatars.delete", { avatarId });

describe("avatars.deletePreview", () => {
  test("counts the photos, the drafts, the videos and the video files that would go", async () => {
    const mock = await withVideo();

    expect(await unwrap(previewOf(mock, MIA.avatarId))).toEqual({ avatarId: MIA.avatarId, photos: 6, candidates: 0, drafts: 2, videos: 1, videoFilesFound: 1 });
  });

  test("a video whose file is not in the export folder now is a video but not a file found", async () => {
    const mock = await withVideo();
    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    mock.engine.setVideoFileState(videos[0]?.videoId ?? "", "missing");

    expect(await unwrap(previewOf(mock, MIA.avatarId))).toMatchObject({ videos: 1, videoFilesFound: 0 });
  });

  test("an export folder that is unplugged finds no file", async () => {
    const mock = await withVideo();
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });

    expect(await unwrap(previewOf(mock, MIA.avatarId))).toMatchObject({ videos: 1, videoFilesFound: 0 });
  });

  test("an archived avatar is counted too", async () => {
    const mock = await withVideo();

    expect(await unwrap(previewOf(mock, NORA.avatarId))).toEqual({ avatarId: NORA.avatarId, photos: 0, candidates: 0, drafts: 0, videos: 0, videoFilesFound: 0 });
  });

  test("a draft counts its candidates", async () => {
    const mock = makeMock({ drafts: [{ ...A_DRAFT, candidates: [{ avatarId: A_DRAFT.avatarId, photoId: "photo-cand-0001" }, { avatarId: A_DRAFT.avatarId, photoId: "photo-cand-0002" }], hiddenBelowThreshold: 1 }] });

    expect(await unwrap(previewOf(mock, A_DRAFT.avatarId))).toEqual({ avatarId: A_DRAFT.avatarId, photos: 0, candidates: 3, drafts: 0, videos: 0, videoFilesFound: 0 });
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    const mock = await withVideo();

    expect(await previewOf(mock, "avatar-nobody-1")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("with no library open it is LIBRARY_UNAVAILABLE", async () => {
    const mock = await withVideo();
    mock.engine.setLibraryAvailable(false);

    expect(await previewOf(mock, MIA.avatarId)).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });

  test("a render of the avatar that is queued or running refuses it with IN_FLIGHT, and the others are not affected", async () => {
    const mock = await withVideo();
    await renderDraft(mock, (await draftOf(mock, [P4])).montageId);

    expect(await previewOf(mock, MIA.avatarId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(await previewOf(mock, SOFIA.avatarId)).toMatchObject({ ok: true });
  });

  test("a video intent a crash left pending refuses it with IN_FLIGHT", async () => {
    const mock = await withVideo();
    mock.engine.holdPendingVideoPhotos(MIA.avatarId, [P4]);

    expect(await previewOf(mock, MIA.avatarId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  });

  test("changes nothing: the avatar is still listed and no event is sent", async () => {
    const mock = await withVideo();
    const mark = mock.events.length;

    await previewOf(mock, MIA.avatarId);

    expect(mock.events.slice(mark)).toEqual([]);
    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars.map((a) => a.avatarId)).toContain(MIA.avatarId);
  });
});

describe("avatars.delete", () => {
  test("answers how many video files went to the Trash and none stayed", async () => {
    const mock = await withVideo();

    expect(await unwrap(deleteOf(mock, MIA.avatarId))).toEqual({ avatarId: MIA.avatarId, videoFilesTrashed: 1, videoFilesKept: 0 });
  });

  test("a test can have the next delete report video files that stayed behind: they are kept, not trashed", async () => {
    const mock = await withVideo();
    mock.engine.keepVideoFilesOnDelete(2);

    expect(await unwrap(deleteOf(mock, MIA.avatarId))).toEqual({ avatarId: MIA.avatarId, videoFilesTrashed: 1, videoFilesKept: 2 });
    // used once
    expect(await unwrap(deleteOf(mock, SOFIA.avatarId))).toMatchObject({ videoFilesKept: 0 });
  });

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

  test("announces avatar.removed once", async () => {
    const mock = await withVideo();
    const mark = mock.events.length;

    await unwrap(deleteOf(mock, MIA.avatarId));

    const sent = mock.events.slice(mark);
    expect(typesOf(sent)).toEqual(["avatar.removed"]);
    expect(sent[0]?.payload).toEqual({ avatarId: MIA.avatarId });
  });

  test("another avatar keeps its photos", async () => {
    const mock = await withVideo();

    await unwrap(deleteOf(mock, MIA.avatarId));

    expect((await unwrap(mock.client.request("photos.list", { avatarId: SOFIA.avatarId }))).photos).toHaveLength(2);
  });

  test("the finished jobs of the avatar leave the snapshot", async () => {
    const mock = await withVideo();
    expect((await unwrap(mock.client.request("engine.snapshot", {}))).jobs.length).toBeGreaterThan(0);

    await unwrap(deleteOf(mock, MIA.avatarId));

    expect((await unwrap(mock.client.request("engine.snapshot", {}))).jobs).toEqual([]);
  });

  test("an archived avatar and a draft can be deleted too", async () => {
    const mock = makeMock({ avatars: [{ ...NORA }], drafts: [A_DRAFT] });

    await unwrap(deleteOf(mock, NORA.avatarId));
    await unwrap(deleteOf(mock, A_DRAFT.avatarId));

    const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
    expect(snapshot.avatars).toEqual([]);
    expect(snapshot.drafts).toEqual([]);
  });

  test("is refused with IN_FLIGHT while a render of the avatar runs, and nothing is removed", async () => {
    const mock = await withVideo();
    await renderDraft(mock, (await draftOf(mock, [P4])).montageId);
    const mark = mock.events.length;

    expect(await deleteOf(mock, MIA.avatarId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

    expect(mock.events.slice(mark)).toEqual([]);
    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars.map((a) => a.avatarId)).toContain(MIA.avatarId);
  });

  test("is refused with IN_FLIGHT while a library switch is being surveyed", async () => {
    const mock = await withVideo();
    mock.engine.setLibrarySwitching(true);

    expect(await deleteOf(mock, MIA.avatarId)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  });

  test("a Trash that refuses leaves the avatar as it was", async () => {
    const mock = await withVideo();
    mock.engine.failNext("avatars.delete", { code: "TRASH_UNAVAILABLE" });

    expect(await deleteOf(mock, MIA.avatarId)).toMatchObject({ ok: false, error: { code: "TRASH_UNAVAILABLE" } });

    expect((await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos).toHaveLength(1);
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    const mock = await withVideo();

    expect(await deleteOf(mock, "avatar-nobody-1")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("a second delete of the same avatar is NOT_FOUND and announces nothing more", async () => {
    const mock = await withVideo();
    await unwrap(deleteOf(mock, MIA.avatarId));
    const mark = mock.events.length;

    expect(await deleteOf(mock, MIA.avatarId)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(mock.events.slice(mark)).toEqual([]);
  });

  test("costs nothing: the money status does not move", async () => {
    const mock = await withVideo();
    const before = await unwrap(mock.client.request("money.status", {}));

    await unwrap(deleteOf(mock, MIA.avatarId));

    expect(await unwrap(mock.client.request("money.status", {}))).toEqual(before);
  });
});
