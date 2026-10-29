import { describe, expect, test } from "bun:test";
import type { AvatarSummary, PhotoSummary } from "../../shared/engine";
import type { MockEngineOptions } from "./mockEngine";
import { freePhotos, makeMock, MIA, SOFIA, unwrap, type Mock } from "./mockEngine.testkit";

// S4.6g: the mock answers `autopilot.get` and `autopilot.list` as the engine does once the owner has marked or deleted a launch's videos: `publishedAt` is the log's word,
// a deleted video is `removed` and no longer counted in `videosDone`, and a log that cannot be read is `unknown`. The engine's side is engine.autopilotVideos.test.ts; both
// run the same shared join (`shared/autopilot/videoFacts.ts`).

const at = (h: number, m: number): string => new Date(2026, 9, 8, h, m).toISOString();

function world(options: Pick<MockEngineOptions, "launchRun"> = {}): Mock {
  const photos: PhotoSummary[] = [...freePhotos(8, MIA), ...freePhotos(4, SOFIA)];
  const countOf = (a: AvatarSummary): number => photos.filter((p) => p.avatarId === a.avatarId).length;
  return makeMock({ avatars: [MIA, SOFIA].map((a) => ({ ...a, photoCount: countOf(a), eligibleUnusedCount: countOf(a) })), photos, ...options });
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
      { avatarId: MIA.avatarId, shape: "single", size: 1, state: "done", published: true },
      { avatarId: MIA.avatarId, shape: "collage", size: 3, state: "done" },
      { avatarId: SOFIA.avatarId, shape: "single", size: 1, state: "done" },
      { avatarId: SOFIA.avatarId, shape: "single", size: 1, state: "dropped", dropReason: "not-enough-photos" },
    ],
  });
}

const doneOf = async (mock: Mock, launchId: string) => (await unwrap(mock.client.request("autopilot.get", { launchId }))).videos.filter((v) => v.state === "done");
const countedOf = async (mock: Mock): Promise<number | undefined> => (await unwrap(mock.client.request("autopilot.list", {}))).launches[0]?.videosDone;

describe("autopilot.get and autopilot.list after a delete", () => {
  test("a deleted video is removed in the view, keeps its mark, and the history stops counting it", async () => {
    const mock = world();
    const { launchId, videoIds } = seed(mock);
    expect(await countedOf(mock)).toBe(3);
    const mark = (await doneOf(mock, launchId))[0]?.publishedAt;
    await unwrap(mock.client.request("videos.delete", { videoId: videoIds[0] ?? "", mode: "video" }));
    expect((await doneOf(mock, launchId)).map((v) => [v.videoId, v.removed ?? false])).toEqual([
      [videoIds[0], true],
      [videoIds[1], false],
      [videoIds[2], false],
    ]);
    expect((await doneOf(mock, launchId))[0]?.publishedAt).toBe(mark);
    expect(await countedOf(mock)).toBe(2);
  });

});

// S4.8: a launch the mock RUNS renders real records (mockEngine.launchRun.test.ts pins that). The CANNED launch (`launchRun: "canned"`, the S4.1 fixture) still has no record behind its
// finished videos, which is why the fixture is not what the window is developed against any more.

