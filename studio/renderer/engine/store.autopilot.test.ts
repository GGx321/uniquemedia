import { expect, test } from "bun:test";
import { freePhotos, makeMock, MIA, unwrap } from "./mockEngine.testkit";
import { EngineStore } from "./store";

// Stage 4, S4.1: the store keeps the latest word of the engine on the library's launch, whole: from the snapshot a window opens with, then from `autopilot.changed`.

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const draft = {
  avatarIds: [MIA.avatarId],
  videosPerAvatar: 2,
  mix: { single: 100, collage: 0, slides: 0 },
  categories: ["home" as const],
  poses: { profile: false, back: false },
  library: true,
  generate: true,
  sceneReview: false,
  stickers: false,
};

function world() {
  const photos = freePhotos(6);
  return makeMock({ avatars: [{ ...MIA, photoCount: 6, eligibleUnusedCount: 6 }], photos });
}

async function startLaunch(mock: ReturnType<typeof world>) {
  const { preview } = await unwrap(mock.client.request("autopilot.estimate", { draft }));
  return (await unwrap(mock.client.request("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros }))).launch;
}

test("with no launch the view holds none", async () => {
  const mock = world();
  const store = new EngineStore(mock.client);
  const stop = store.start();
  await flush();
  expect(store.getView().autopilot).toBeNull();
  stop();
});

test("a window opened while a launch runs shows it from the snapshot", async () => {
  const mock = world();
  const launch = await startLaunch(mock);
  const store = new EngineStore(mock.client);
  const stop = store.start();
  await flush();
  expect(store.getView().autopilot).toEqual(launch);
  stop();
});

test("autopilot.changed replaces the launch in the view, without a resync", async () => {
  const mock = world();
  const store = new EngineStore(mock.client);
  const stop = store.start();
  await flush();
  const launch = await startLaunch(mock);
  await flush();
  expect(store.getView().autopilot?.launchId).toBe(launch.launchId);
  expect(store.getView().autopilot?.status).toBe("running");

  await unwrap(mock.client.request("autopilot.pause", { launchId: launch.launchId }));
  await flush();
  expect(store.getView().autopilot?.status).toBe("paused");
  expect(store.getView().autopilot?.paused).toMatchObject({ cause: "owner" });

  await unwrap(mock.client.request("autopilot.stop", { launchId: launch.launchId }));
  await flush();
  expect(store.getView().autopilot?.status).toBe("stopped");
  stop();
});

test("a fresh snapshot after the launch ended drops it", async () => {
  const mock = world();
  const launch = await startLaunch(mock);
  await unwrap(mock.client.request("autopilot.stop", { launchId: launch.launchId }));
  const store = new EngineStore(mock.client);
  const stop = store.start();
  await flush();
  expect(store.getView().autopilot).toBeNull();
  stop();
});
