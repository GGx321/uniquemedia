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

});

