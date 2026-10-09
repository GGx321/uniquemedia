import { describe, expect, test } from "bun:test";
import { LaunchView, type EventMessage } from "../../shared/engine";
import { MIA, runUntil, runWorld, SOFIA, startRun, tick, toDone, unwrap, viewOf, type Mock } from "./mockLaunchRun.testkit";

// Stage 4, S4.8 (the engine's H1, S4.6w, and S4.6g L6): the mock tells the window about the unfinished launch whenever the money or the settings change, as the engine's `#emitMoney` and
// `#emitSettings` call `Orchestrator.refresh()`; it announces once per pass, not once per cent; and its marks and deleted videos are per avatar, as the engine's logs are.

const announced = (mock: Mock): LaunchView[] => mock.events.flatMap((e: EventMessage) => (e.type === "autopilot.changed" ? [e.payload.launch] : []));

describe("the engine's H1 re-announce", () => {
  test.each([
    ["a budget change", (mock: Mock) => unwrap(mock.client.request("settings.setBudget", { monthlyBudgetMicros: 9_000_000 }))],
    ["a key stored", (mock: Mock) => unwrap(mock.client.request("settings.setApiKey", { key: "sk-or-v1-abcdef0123456789-test" }))],
    ["a key cleared", (mock: Mock) => unwrap(mock.client.request("settings.clearApiKey", {}))],
    ["a reconcile", (mock: Mock) => unwrap(mock.client.request("money.reconcile", {}))],
  ])("%s tells the window the current launch again, in a view that meets the contract", async (_name, change) => {
    const mock = runWorld();
    const started = await startRun(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    const before = announced(mock).length;
    await change(mock);
    const told = announced(mock).slice(before);
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((v) => v.launchId === started.launchId && LaunchView.safeParse(v).success)).toBe(true);
    expect(told.at(-1)).toEqual(await viewOf(mock, started.launchId));
  });

  test("the view it tells carries what the money change moved: a key cleared closes «Продолжить» as «key», and a new one opens it", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    await unwrap(mock.client.request("settings.clearApiKey", {}));
    expect(announced(mock).at(-1)).toMatchObject({ resumeBlockedBy: "key" });
    await unwrap(mock.client.request("settings.setApiKey", { key: "sk-or-v1-abcdef0123456789-test" }));
    expect(announced(mock).at(-1)).toMatchObject({ resumeBlockedBy: null });
  });

  test("with no launch, and after one has ended, a money or settings change announces no launch", async () => {
    const mock = runWorld();
    await unwrap(mock.client.request("settings.setBudget", { monthlyBudgetMicros: 9_000_000 }));
    mock.engine.touchMoney();
    expect(announced(mock)).toEqual([]);
    const started = await startRun(mock);
    await toDone(mock, started.launchId);
    const before = announced(mock).length;
    await unwrap(mock.client.request("settings.setBudget", { monthlyBudgetMicros: 8_000_000 }));
    mock.engine.touchMoney();
    expect(announced(mock).length).toBe(before);
  });

  test("a pass announces the launch once, however many cents it settled", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await runUntil(mock, started.launchId, "drawing", (v) => v.avatars[0]?.phase === "drawing" && v.inFlight.requests > 0);
    const before = announced(mock).length;
    const money = mock.events.filter((e) => e.type === "money.changed").length;
    tick(mock);
    expect(announced(mock).length - before).toBe(1);
    expect(mock.events.filter((e) => e.type === "money.changed").length - money).toBeGreaterThan(1);
  });

  test("the first announcement of a started launch is the answer to the start", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    expect(announced(mock)[0]).toEqual(started);
  });
});

describe("the marks are per avatar (S4.6g L6)", () => {
  test("an avatar nobody marked a video of has no log: its launch videos say nothing of marks, and a deleted mark of another avatar does not give it one", async () => {
    const mock = runWorld();
    const at = "2026-10-08T14:00:00.000Z";
    const miaLaunch = mock.engine.seedLaunch({
      createdAt: at,
      endedAt: "2026-10-08T14:30:00.000Z",
      draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 1 },
      videos: [{ avatarId: MIA.avatarId, shape: "single", size: 1, state: "done", published: true }],
    });
    const sofiaLaunch = mock.engine.seedLaunch({
      createdAt: "2026-10-08T15:00:00.000Z",
      endedAt: "2026-10-08T15:30:00.000Z",
      draft: { avatarIds: [SOFIA.avatarId], videosPerAvatar: 1 },
      videos: [{ avatarId: SOFIA.avatarId, shape: "single", size: 1, state: "done" }],
    });
    expect((await unwrap(mock.client.request("autopilot.get", { launchId: miaLaunch.launchId }))).published).toBe("ok");
    expect("published" in (await unwrap(mock.client.request("autopilot.get", { launchId: sofiaLaunch.launchId })))).toBe(false);
    expect("published" in (await unwrap(mock.client.request("videos.list", { avatarId: SOFIA.avatarId })))).toBe(false);
    // Mia's marked video is deleted: its mark stays in HER log, and Sofia still has none.
    await unwrap(mock.client.request("videos.delete", { videoId: miaLaunch.videoIds[0] ?? "", mode: "video" }));
    expect((await unwrap(mock.client.request("autopilot.get", { launchId: miaLaunch.launchId }))).published).toBe("ok");
    expect("published" in (await unwrap(mock.client.request("autopilot.get", { launchId: sofiaLaunch.launchId })))).toBe(false);
  });

  test("marking one avatar's video gives that avatar a log and nobody else", async () => {
    const mock = runWorld();
    const miaLaunch = mock.engine.seedLaunch({
      createdAt: "2026-10-08T14:00:00.000Z",
      endedAt: "2026-10-08T14:30:00.000Z",
      draft: { avatarIds: [MIA.avatarId, SOFIA.avatarId], videosPerAvatar: 1 },
      videos: [
        { avatarId: MIA.avatarId, shape: "single", size: 1, state: "done" },
        { avatarId: SOFIA.avatarId, shape: "single", size: 1, state: "done" },
      ],
    });
    await unwrap(mock.client.request("videos.setPublished", { videoId: miaLaunch.videoIds[0] ?? "", published: true }));
    expect((await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).published).toBe("ok");
    expect("published" in (await unwrap(mock.client.request("videos.list", { avatarId: SOFIA.avatarId })))).toBe(false);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: miaLaunch.launchId }));
    expect(got.published).toBe("ok");
    expect(got.videos.map((v) => [v.avatarId, typeof v.publishedAt === "string"])).toEqual([
      [MIA.avatarId, true],
      [SOFIA.avatarId, false],
    ]);
  });
});

describe("a launch the mock runs shows its results (S4.6g L6: «Результаты · 0»)", () => {
  test("its finished videos are records of the library, not removed: the history counts them and the results list can draw and act on them", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await toDone(mock, started.launchId);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    const finished = got.videos.filter((v) => v.state === "done");
    expect(finished).toHaveLength(4);
    expect(finished.every((v) => v.removed === undefined)).toBe(true);
    expect((await unwrap(mock.client.request("autopilot.list", {}))).launches[0]?.videosDone).toBe(4);
    const listed = (await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos.map((v) => v.videoId).sort();
    expect(finished.map((v) => v.videoId).sort()).toEqual(listed);
    // The owner marks one «Опубликовано» and deletes another: the launch says so, as the engine's does.
    const [first, second] = finished;
    await unwrap(mock.client.request("videos.setPublished", { videoId: first?.videoId ?? "", published: true }));
    await unwrap(mock.client.request("videos.delete", { videoId: second?.videoId ?? "", mode: "video" }));
    const after = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(after.videos.find((v) => v.key === first?.key)).toMatchObject({ publishedAt: expect.any(String) });
    expect(after.videos.find((v) => v.key === second?.key)).toMatchObject({ removed: true });
    expect((await unwrap(mock.client.request("autopilot.list", {}))).launches[0]?.videosDone).toBe(3);
  });
});
