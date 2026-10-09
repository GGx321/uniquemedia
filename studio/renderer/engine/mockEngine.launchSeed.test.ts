import { describe, expect, test } from "bun:test";
import type { AvatarSummary, PhotoSummary } from "../../shared/engine";
import { freePhotos, makeMock, MIA, SOFIA, unwrap, type Mock } from "./mockEngine.testkit";

// S4.9c: the mock's renderer controls for the history and the results. `seedLaunch` puts a launch into the history as if it had run: the launch file's word
// (`autopilot.list`, `autopilot.get`) and, for every finished video, a real record of the library (origin «autopilot», the launch's id, photos taken), so
// «Опубликовано» and the delete reach it like any other video. `tearPublishedLog` models a torn `published.jsonl`: the marks read «unknown» until a mark heals it.

const at = (h: number, m: number): string => new Date(2026, 9, 8, h, m).toISOString();

function world(): Mock {
  const photos: PhotoSummary[] = [...freePhotos(8, MIA), ...freePhotos(4, SOFIA)];
  const countOf = (a: AvatarSummary): number => photos.filter((p) => p.avatarId === a.avatarId).length;
  return makeMock({ avatars: [MIA, SOFIA].map((a) => ({ ...a, photoCount: countOf(a), eligibleUnusedCount: countOf(a) })), photos });
}

function seed(mock: Mock): { launchId: string; videoIds: string[] } {
  return mock.engine.seedLaunch({
    createdAt: at(14, 2),
    endedAt: at(14, 31),
    draft: { avatarIds: [MIA.avatarId, SOFIA.avatarId], videosPerAvatar: 2 },
    acceptedMicros: 4_140_000,
    plannedWorstMicros: 4_140_000,
    spentMicros: 1_690_000,
    videos: [
      { avatarId: MIA.avatarId, shape: "single", size: 1, state: "done", durationMs: 7_500, bytes: 1_800_000, published: true },
      { avatarId: MIA.avatarId, shape: "collage", size: 3, state: "done", durationMs: 9_000, bytes: 2_400_000, track: { source: "own", title: "summer-loop.m4a", artist: null } },
      { avatarId: SOFIA.avatarId, shape: "single", size: 1, state: "done" },
      { avatarId: SOFIA.avatarId, shape: "single", size: 1, state: "dropped", dropReason: "not-enough-photos" },
    ],
  });
}

describe("seedLaunch", () => {
  test("the history lists it with the engine's figures, and `autopilot.get` answers its videos", async () => {
    const mock = world();
    const { launchId, videoIds } = seed(mock);
    const list = await unwrap(mock.client.request("autopilot.list", {}));
    expect(list.launches.map((l) => [l.launchId, l.status, l.videosDone, l.videosPlanned, l.spentMicros, l.plannedWorstMicros, l.endedAt])).toEqual([[launchId, "done", 3, 4, 1_690_000, 4_140_000, at(14, 31)]]);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId }));
    expect(got.videos.map((v) => [v.key, v.state, v.videoId])).toEqual([
      ["0-1", "done", videoIds[0]],
      ["0-2", "done", videoIds[1]],
      ["1-1", "done", videoIds[2]],
      ["1-2", "dropped", null],
    ]);
    expect(got.launch.avatars.map((a) => [a.phase, a.videos.done, a.dropped?.count ?? 0])).toEqual([
      ["done", 2, 0],
      ["done", 1, 1],
    ]);
  });

  test("a finished video is a record of the library: its photos used, its mark in the log, the avatar's counts moved", async () => {
    const mock = world();
    const { launchId, videoIds } = seed(mock);
    const listed = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(listed.published).toBe("ok");
    expect(listed.videos.map((v) => [v.videoId, v.origin, v.launchId, v.photoCount, typeof v.publishedAt === "string", v.music?.title])).toEqual([
      [videoIds[1], "autopilot", launchId, 3, false, "summer-loop.m4a"],
      [videoIds[0], "autopilot", launchId, 1, true, "Soft Static"],
    ]);
    const photos = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.photos.filter((p) => p.used).length).toBe(4);
    const avatars = await unwrap(mock.client.request("avatars.list", {}));
    expect(avatars.avatars.find((a) => a.avatarId === MIA.avatarId)).toMatchObject({ videoCount: 2, eligibleUnusedCount: 4 });
  });

  test("«Удалить видео и отклонить фото» reaches a seeded video: its photos rejected, the record gone", async () => {
    const mock = world();
    const { videoIds } = seed(mock);
    const videoId = videoIds[1] ?? "";
    const done = await unwrap(mock.client.request("videos.delete", { videoId, mode: "video", rejectPhotos: true }));
    expect(done.rejectedPhotoIds).toHaveLength(3);
    const listed = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(listed.videos.some((v) => v.videoId === videoId)).toBe(false);
    const photos = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.photos.filter((p) => p.rejected).map((p) => p.photoId).sort()).toEqual([...(done.rejectedPhotoIds ?? [])].sort());
  });
});

describe("tearPublishedLog", () => {
  test("the marks read unknown and every video unmarked; a mark heals the log, keeps a mark's first time, and the marks read again", async () => {
    const mock = world();
    const { videoIds } = seed(mock);
    const marked = (await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos.find((v) => v.videoId === videoIds[0])?.publishedAt;
    mock.engine.tearPublishedLog(MIA.avatarId);
    const torn = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(torn.published).toBe("unknown");
    expect(torn.videos.every((v) => v.publishedAt === undefined)).toBe(true);
    // Sofia's log is her own, and nobody ever marked a video of hers, so she has none (S4.6g L6: the mock used to answer "ok" for her, where the engine has no log to read): the
    // field is absent, as from an avatar with no marks, and the tear of Mia's log does not reach her.
    expect("published" in (await unwrap(mock.client.request("videos.list", { avatarId: SOFIA.avatarId })))).toBe(false);

    await unwrap(mock.client.request("videos.setPublished", { videoId: videoIds[0] ?? "", published: true }));
    const healed = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    expect(healed.published).toBe("ok");
    expect(healed.videos.find((v) => v.videoId === videoIds[0])?.publishedAt).toBe(marked);
  });
});
