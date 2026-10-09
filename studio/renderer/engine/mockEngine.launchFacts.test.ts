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

describe("autopilot.get joins the owner's marks", () => {
  test("a seeded mark is the video's publishedAt, and the answer says the marks were read", async () => {
    const mock = world();
    const { launchId, videoIds } = seed(mock);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId }));
    const listed = await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }));
    const mark = listed.videos.find((v) => v.videoId === videoIds[0])?.publishedAt ?? null;
    expect(typeof mark).toBe("string");
    expect(got.videos.filter((v) => v.state === "done").map((v) => [v.videoId, v.publishedAt])).toEqual([
      [videoIds[0], mark],
      [videoIds[1], null],
      [videoIds[2], null],
    ]);
    expect(got.published).toBe("ok");
  });

  test("a mark made after the launch shows in the next get, and clearing it takes it away again", async () => {
    const mock = world();
    const { launchId, videoIds } = seed(mock);
    await unwrap(mock.client.request("videos.setPublished", { videoId: videoIds[1] ?? "", published: true }));
    expect((await doneOf(mock, launchId))[1]?.publishedAt).toEqual(expect.any(String));
    await unwrap(mock.client.request("videos.setPublished", { videoId: videoIds[1] ?? "", published: false }));
    expect((await doneOf(mock, launchId))[1]?.publishedAt).toBeNull();
  });

  test("an avatar whose published log is torn says unknown on its videos only, and the answer says so", async () => {
    const mock = world();
    const { launchId } = seed(mock);
    mock.engine.tearPublishedLog(MIA.avatarId);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId }));
    expect(got.published).toBe("unknown");
    const done = got.videos.filter((v) => v.state === "done");
    expect(done.map((v) => [v.avatarId, v.publishedAt, v.publishedUnknown ?? false])).toEqual([
      [MIA.avatarId, null, true],
      [MIA.avatarId, null, true],
      [SOFIA.avatarId, null, false],
    ]);
  });

  test("before any mark was ever made there is no log: no `published` in the answer, as videos.list has none", async () => {
    const mock = world();
    const { launchId } = mock.engine.seedLaunch({
      createdAt: at(9, 0),
      endedAt: at(9, 20),
      draft: { avatarIds: [MIA.avatarId] },
      videos: [{ avatarId: MIA.avatarId, shape: "single", size: 1, state: "done" }],
    });
    const got = await unwrap(mock.client.request("autopilot.get", { launchId }));
    expect("published" in got).toBe(false);
    expect(got.videos[0]?.publishedAt).toBeNull();
  });
});

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

  test("a delete with the photos rejected removes the video the same way", async () => {
    const mock = world();
    const { launchId, videoIds } = seed(mock);
    await unwrap(mock.client.request("videos.delete", { videoId: videoIds[1] ?? "", mode: "video", rejectPhotos: true }));
    expect((await doneOf(mock, launchId)).map((v) => v.removed ?? false)).toEqual([false, true, false]);
  });

  test("a deleted avatar's finished videos are removed, and the history counts none of them", async () => {
    const mock = world();
    const { launchId } = seed(mock);
    await unwrap(mock.client.request("avatars.delete", { avatarId: SOFIA.avatarId }));
    expect((await doneOf(mock, launchId)).map((v) => [v.avatarId, v.removed ?? false])).toEqual([
      [MIA.avatarId, false],
      [MIA.avatarId, false],
      [SOFIA.avatarId, true],
    ]);
    expect(await countedOf(mock)).toBe(2);
  });
});

describe("loseTrackOfRecords", () => {
  test("an engine that cannot look at the records calls nothing removed: not knowing is not a delete", async () => {
    const mock = world();
    const { launchId, videoIds } = seed(mock);
    await unwrap(mock.client.request("videos.delete", { videoId: videoIds[0] ?? "", mode: "video" }));
    mock.engine.loseTrackOfRecords();
    expect((await doneOf(mock, launchId)).some((v) => v.removed === true)).toBe(false);
    expect(await countedOf(mock)).toBe(3);
  });
});

describe("timeOutNextDelete", () => {
  test("answers EXPORT_UNAVAILABLE with an unknown outcome while the delete goes on: the video is gone afterwards", async () => {
    const mock = world();
    const { launchId, videoIds } = seed(mock);
    mock.engine.timeOutNextDelete();
    const reply = await mock.client.request("videos.delete", { videoId: videoIds[1] ?? "", mode: "video", rejectPhotos: true });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", outcome: "unknown" });
    expect((await doneOf(mock, launchId))[1]?.removed).toBe(true);
    const photos = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.photos.filter((p) => p.rejected)).toHaveLength(3);
  });

  test("M2: the refusal comes first and the video.changed (removed) after it, as the engine's late finish does: nothing is announced before the answer", async () => {
    const mock = world();
    const { videoIds } = seed(mock);
    mock.engine.timeOutNextDelete();
    const before = mock.events.filter((e) => e.type === "video.changed").length;
    await mock.client.request("videos.delete", { videoId: videoIds[1] ?? "", mode: "video" });
    expect(mock.events.filter((e) => e.type === "video.changed")).toHaveLength(before);
    mock.scheduler.runAll();
    const late = mock.events.filter((e) => e.type === "video.changed");
    expect(late).toHaveLength(before + 1);
    expect(late.at(-1)?.payload).toMatchObject({ change: "removed", videoId: videoIds[1], avatarId: MIA.avatarId });
  });

  test("is for one delete only: the next answers as usual", async () => {
    const mock = world();
    const { videoIds } = seed(mock);
    mock.engine.timeOutNextDelete();
    await mock.client.request("videos.delete", { videoId: videoIds[0] ?? "", mode: "video" });
    const next = await unwrap(mock.client.request("videos.delete", { videoId: videoIds[1] ?? "", mode: "video" }));
    expect(next.videoId).toBe(videoIds[1]);
  });
});

// S4.8: a launch the mock RUNS renders real records (mockEngine.launchRun.test.ts pins that). The CANNED launch (`launchRun: "canned"`, the S4.1 fixture) still has no record behind its
// finished videos, which is why the fixture is not what the window is developed against any more.
describe("a CANNED launch (launchRun: canned)", () => {
  test("its canned finished videos have no record in the mock, so they read removed and the history does not count them (the window never drew them)", async () => {
    const mock = world({ launchRun: "canned" });
    mock.engine.setRunImagePrice(70_000);
    const draft = { avatarIds: [MIA.avatarId, SOFIA.avatarId], videosPerAvatar: 3, mix: { single: 70, collage: 20, slides: 10 }, categories: ["home" as const], poses: { profile: false, back: false }, library: true, generate: true, sceneReview: false, stickers: false };
    const preview = (await unwrap(mock.client.request("autopilot.estimate", { draft }))).preview;
    const started = await unwrap(mock.client.request("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros }));
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launch.launchId }));
    const finished = got.videos.filter((v) => v.state === "done");
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.every((v) => v.removed === true)).toBe(true);
    expect((await unwrap(mock.client.request("autopilot.list", {}))).launches[0]?.videosDone).toBe(0);
  });
});
