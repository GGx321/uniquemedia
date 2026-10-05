import { describe, expect, test } from "bun:test";
import type { AvatarSummary } from "../../shared/engine";
import { draftOf, freePhotos, makeMock, MIA, PHOTO_IDS, renderDraft, scenePhoto, SOFIA, unwrap, type Mock } from "./mockEngine.testkit";

// 3e.2: what the Photos screen asks of the mock, the way the engine answers it: an avatar's usage on its summary
// (`AvatarSummary.usage`) and the two recoveries, `videos.get` by id, the video's title, first clip and track id, and main's
// «Папка «Готовые видео»» (`videos.revealFolder`). The mock has no disk: an avatar's broken records or marks are the usage it
// was seeded with, and the recoveries clear their own reason, as the engine's do once the disk is put right.

const [P1, P2] = PHOTO_IDS as [string, string];

function withUsage(usage: AvatarSummary["usage"], extra: Parameters<typeof makeMock>[0] = {}): Mock {
  const photos = freePhotos(6);
  return makeMock({ photos, avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: 0, usage }], ...extra });
}

const avatarEvents = (mock: Mock, mark: number) => mock.events.slice(mark).flatMap((e) => (e.type === "avatar.changed" ? [e.payload.avatar] : []));

async function avatarOf(mock: Mock, avatarId = MIA.avatarId): Promise<AvatarSummary | undefined> {
  return (await unwrap(mock.client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === avatarId);
}

describe("AvatarSummary.usage", () => {
  test("the demo's avatars, and every avatar the mock makes, have a sound usage", async () => {
    const mock = makeMock({ preset: "demo", avatars: undefined, photos: undefined });
    for (const avatar of (await unwrap(mock.client.request("avatars.list", {}))).avatars) expect(avatar.usage).toEqual({ state: "ok" });
  });
});

describe("the dev build's demo videos (preset «demo»)", () => {
  test("the demo without `demoVideos` has none: the older demo facts stand", async () => {
    const mock = makeMock({ preset: "demo", avatars: undefined, photos: undefined });
    const mia = (await unwrap(mock.client.request("avatars.list", {}))).avatars.find((a) => a.name === "Mia");
    expect(mia?.videoCount).toBe(0);
  });

  test("Mia has videos in every file state the tab draws, their photos used and her counts in step", async () => {
    const mock = makeMock({ preset: "demo", demoVideos: true, avatars: undefined, photos: undefined });
    const mia = (await unwrap(mock.client.request("avatars.list", {}))).avatars.find((a) => a.name === "Mia");
    if (mia === undefined) throw new Error("no demo Mia");
    const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: mia.avatarId }));
    expect(videos.map((v) => v.fileState).sort()).toEqual(["changed", "elsewhere", "missing", "present", "present"]);
    expect(videos.every((v) => v.title !== null && v.firstClip !== null)).toBe(true);
    expect(videos.some((v) => v.music?.trackId !== null && v.music !== null)).toBe(true);
    const { photos } = await unwrap(mock.client.request("photos.list", { avatarId: mia.avatarId }));
    const used = photos.filter((p) => p.used).length;
    expect(used).toBe(videos.reduce((sum, v) => sum + v.photoCount, 0));
    expect(mia.videoCount).toBe(videos.length);
    expect(mia.eligibleUnusedCount).toBe(photos.filter((p) => p.eligible && !p.used && !p.reserved).length);
  });
});

describe("videos.quarantineRecords", () => {
  test("clears a broken record: answers 1, and the avatar, trusted again, is announced with its counts back", async () => {
    const mock = withUsage({ state: "unknown", reasons: ["record-unreadable"] });
    const mark = mock.events.length;

    const answer = await unwrap(mock.client.request("videos.quarantineRecords", { avatarId: MIA.avatarId }));

    expect(answer).toEqual({ avatarId: MIA.avatarId, quarantined: 1 });
    expect(avatarEvents(mock, mark)).toEqual([expect.objectContaining({ usage: { state: "ok" }, eligibleUnusedCount: 6 })]);
    expect((await avatarOf(mock))?.usage).toEqual({ state: "ok" });
  });

  test("a repeat, or a sound avatar, moves nothing and announces nothing", async () => {
    const mock = withUsage({ state: "unknown", reasons: ["record-unreadable"] });
    await unwrap(mock.client.request("videos.quarantineRecords", { avatarId: MIA.avatarId }));
    const mark = mock.events.length;

    expect(await unwrap(mock.client.request("videos.quarantineRecords", { avatarId: MIA.avatarId }))).toEqual({ avatarId: MIA.avatarId, quarantined: 0 });
    expect(avatarEvents(mock, mark)).toEqual([]);
  });

  test("keeps the other reasons: a newer record and broken marks are not its business", async () => {
    const mock = withUsage({ state: "unknown", reasons: ["library-too-new", "record-unreadable", "rejects-unreadable"] });
    await unwrap(mock.client.request("videos.quarantineRecords", { avatarId: MIA.avatarId }));
    expect((await avatarOf(mock))?.usage).toEqual({ state: "unknown", reasons: ["library-too-new", "rejects-unreadable"] });
  });

  test("an unknown avatar is NOT_FOUND", async () => {
    const mock = makeMock();
    const reply = await mock.client.request("videos.quarantineRecords", { avatarId: "avatar-nobody" });
    expect(reply.ok ? null : reply.error.code).toBe("NOT_FOUND");
  });
});

describe("photos.rebuildRejected", () => {
  test("rebuilds broken marks: the rejected photos are kept, one line dropped, and the avatar is announced trusted", async () => {
    const photos = [scenePhoto(1, { rejected: true, eligible: false }), scenePhoto(2), scenePhoto(3, { rejected: true, eligible: false })];
    const mock = makeMock({ photos, avatars: [{ ...MIA, photoCount: 3, eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["rejects-unreadable"] } }] });
    const mark = mock.events.length;

    expect(await unwrap(mock.client.request("photos.rebuildRejected", { avatarId: MIA.avatarId }))).toEqual({ avatarId: MIA.avatarId, rebuilt: true, kept: 2, dropped: 1 });
    expect(avatarEvents(mock, mark)).toEqual([expect.objectContaining({ usage: { state: "ok" }, eligibleUnusedCount: 1 })]);
  });

  test("a sound log answers rebuilt false, with the marks it holds, and announces nothing", async () => {
    const photos = [scenePhoto(1, { rejected: true, eligible: false }), scenePhoto(2)];
    const mock = makeMock({ photos, avatars: [{ ...MIA, photoCount: 2, eligibleUnusedCount: 1, usage: { state: "ok" } }] });
    const mark = mock.events.length;

    expect(await unwrap(mock.client.request("photos.rebuildRejected", { avatarId: MIA.avatarId }))).toEqual({ avatarId: MIA.avatarId, rebuilt: false, kept: 1, dropped: 0 });
    expect(avatarEvents(mock, mark)).toEqual([]);
  });

  test("an unknown avatar is NOT_FOUND", async () => {
    const mock = makeMock();
    const reply = await mock.client.request("photos.rebuildRejected", { avatarId: "avatar-nobody" });
    expect(reply.ok ? null : reply.error.code).toBe("NOT_FOUND");
  });
});

describe("videos.get", () => {
  test("answers one video as videos.list shows it; an unknown one is NOT_FOUND", async () => {
    const mock = makeMock();
    const { videoId } = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();

    const { video } = await unwrap(mock.client.request("videos.get", { videoId }));
    const [listed] = (await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos;
    expect(video).toEqual(listed ?? null);
    const unknown = await mock.client.request("videos.get", { videoId: "video-unknown-0001" });
    expect(unknown.ok ? null : unknown.error.code).toBe("NOT_FOUND");
  });

  test("tells a file state the test sets, `unchecked` included", async () => {
    const mock = makeMock();
    const { videoId } = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();
    mock.engine.setVideoFileState(videoId, "unchecked");

    expect((await unwrap(mock.client.request("videos.get", { videoId }))).video.fileState).toBe("unchecked");
  });
});

describe("a video's title, first clip and track", () => {
  test("the title is the draft's name when it was rendered, kept after a rename; the first clip is what was rendered", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    await unwrap(mock.client.request("montages.save", { montageId: draft.montageId, spec: draft.spec, name: "утро дома" }));
    const { videoId } = await renderDraft(mock, draft.montageId);
    mock.scheduler.runAll();
    await unwrap(mock.client.request("montages.save", { montageId: draft.montageId, spec: draft.spec, name: "вечер" }));

    const { video } = await unwrap(mock.client.request("videos.get", { videoId }));
    expect(video.title).toBe("утро дома");
    expect(video.firstClip).toEqual(draft.spec.clips[0] ?? null);
  });

  test("an unnamed draft has no title", async () => {
    const mock = makeMock();
    const { videoId } = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("videos.get", { videoId }))).video.title).toBeNull();
  });
});

describe("a render whose commit finishes late (the engine's stuck commit past its claim)", () => {
  test("`failNextRender(error, \"late\")`: job.failed, then a step later the record lands anyway: video.changed upserted and the avatar announced, its photos used", async () => {
    const mock = makeMock();
    mock.engine.failNextRender({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" }, "late");
    const { jobId, videoId } = await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    for (let i = 0; i < 6; i++) mock.scheduler.next();
    const failedAt = mock.events.findIndex((e) => e.type === "job.failed" && e.payload.jobId === jobId);
    expect(failedAt).toBeGreaterThan(-1);
    expect(mock.events.some((e) => e.type === "video.changed")).toBe(false);

    mock.scheduler.runAll();

    const after = mock.events.slice(failedAt + 1);
    expect(after.map((e) => e.type)).toEqual(["avatar.changed", "video.changed", "avatar.changed"]);
    expect(after[1]?.type === "video.changed" && after[1].payload.change === "upserted" ? after[1].payload.video.videoId : null).toBe(videoId);
    expect((await avatarOf(mock))?.videoCount).toBe(1);
    expect((await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos.filter((p) => p.used).map((p) => p.photoId).sort()).toEqual([P1, P2].sort());
  });
});

describe("videos.revealFolder (main's, as the mock plays it)", () => {
  test("opens the avatar's folder when it has a video in this export folder, else the export folder itself", async () => {
    const mock = makeMock({ avatars: [{ ...MIA, photoCount: 6, eligibleUnusedCount: 6 }, { ...SOFIA, photoCount: 0, eligibleUnusedCount: 0 }] });
    await renderDraft(mock, (await draftOf(mock, [P1, P2])).montageId);
    mock.scheduler.runAll();

    expect(await unwrap(mock.client.request("videos.revealFolder", { avatarId: MIA.avatarId }))).toEqual({ opened: "avatar" });
    expect(await unwrap(mock.client.request("videos.revealFolder", { avatarId: SOFIA.avatarId }))).toEqual({ opened: "root" });
    expect(mock.engine.revealedFolders).toEqual([MIA.avatarId, SOFIA.avatarId]);
  });

  test("an export folder that cannot be used is EXPORT_UNAVAILABLE with its reason; an unknown avatar is NOT_FOUND", async () => {
    const mock = makeMock();
    const unknown = await mock.client.request("videos.revealFolder", { avatarId: "avatar-nobody" });
    expect(unknown.ok ? null : unknown.error.code).toBe("NOT_FOUND");
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    const away = await mock.client.request("videos.revealFolder", { avatarId: MIA.avatarId });
    expect(away.ok ? null : away.error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
  });
});

describe("corruptPhotoSidecar (test support: a photo gone from the gallery while a window shows it)", () => {
  test("photos.list leaves the photo out and counts it in skippedTotal, as the engine does with a sidecar it cannot read", async () => {
    const mock = makeMock();
    mock.engine.corruptPhotoSidecar(P1);
    const list = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(list.photos.map((p) => p.photoId)).toEqual([...PHOTO_IDS].reverse().filter((id) => id !== P1));
    expect(list.skippedTotal).toBe(1);
  });
});
