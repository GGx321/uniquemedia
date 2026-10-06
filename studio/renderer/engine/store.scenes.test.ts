import { describe, expect, test } from "bun:test";
import type { AvatarSummary } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { sidebarCounts } from "./renderJobs";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore, type SceneSetSignal } from "./store";

// CS.4a: the store follows a scene set's writer job like a run's (trackScenesJob, job.* events, the snapshot), counts it with the photo-side jobs in the
// sidebar, and hands `scenes.changed` to its listeners in seq order, once each, with `resynced` after a snapshot taken again.

const MIA: AvatarSummary = {
  avatarId: "avatar-mia-0001",
  name: "Mia",
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  masterPhotoId: "photo-mia-0001",
  createdAt: "2026-09-24T09:00:00.000Z",
  status: "active",
  photoCount: 1,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function started() {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA] });
  const client = mockEngineClient(engine);
  const store = new EngineStore(client);
  store.start();
  await settle();
  return { scheduler, engine, client, store };
}

const compose = (h: Awaited<ReturnType<typeof started>>, count: number) =>
  h.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: Math.ceil(count / 25) * 75_000 });

describe("a scenes job in the store", () => {
  test("tracked at its launch with the scenes it writes as the total, and counted with the photo-side jobs in the sidebar", async () => {
    const h = await started();
    const composed = await compose(h, 30);
    if (!composed.ok || composed.result.jobId === null) throw new Error("compose failed");
    h.store.trackScenesJob(composed.result.jobId, composed.result.sceneSetId, MIA.avatarId, 30);
    await settle();

    const job = h.store.getView().jobs.find((j) => j.jobId === composed.result.jobId);
    expect(job).toMatchObject({ kind: "scenes", avatarId: MIA.avatarId, status: "running", total: 30 });
    const counts = sidebarCounts(h.store.getView().jobs, new Set());
    expect(counts.queue).toBe(1);
    expect(counts.generation).toEqual({ done: 0, total: 30 });
    expect(counts.render).toBeNull();
  });

  test("progress and the end come by events: the job is done at its total with the result, after the set's last scenes.changed", async () => {
    const h = await started();
    const heard: string[] = [];
    h.store.subscribeSceneSets((signal) => heard.push(`set:${signal.change}`));
    const composed = await compose(h, 30);
    if (!composed.ok || composed.result.jobId === null) throw new Error("compose failed");
    h.scheduler.runAll();
    await settle();

    const job = h.store.getView().jobs.find((j) => j.jobId === composed.result.jobId);
    expect(job).toMatchObject({ kind: "scenes", status: "done", done: 30, total: 30, result: { kind: "scenes", written: 30, unwritten: 0 } });
    expect(heard.length).toBeGreaterThan(0);
    expect(sidebarCounts(h.store.getView().jobs, new Set()).queue).toBe(0);
  });

  test("a job first heard of at its end still has its total from the result", async () => {
    const h = await started();
    const composed = await compose(h, 30);
    if (!composed.ok || composed.result.jobId === null) throw new Error("compose failed");
    h.scheduler.runAll();
    await settle();
    expect(h.store.getView().jobs.find((j) => j.jobId === composed.result.jobId)).toMatchObject({ status: "done", total: 30, done: 30 });
  });

  test("a failed job keeps its error, and a snapshot taken again restores the job", async () => {
    const h = await started();
    h.engine.failNextSceneAttempt("rate-limited");
    const composed = await compose(h, 5);
    if (!composed.ok || composed.result.jobId === null) throw new Error("compose failed");
    h.scheduler.runAll();
    await settle();
    expect(h.store.getView().jobs.find((j) => j.kind === "scenes")).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED" } });

    h.store.reload();
    await settle();
    expect(h.store.getView().jobs.find((j) => j.kind === "scenes")).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED" } });
  });

  test("a deleted avatar's scenes job leaves the view with it", async () => {
    const h = await started();
    await compose(h, 5);
    h.scheduler.runAll();
    await settle();
    await h.client.request("avatars.delete", { avatarId: MIA.avatarId });
    await settle();
    expect(h.store.getView().jobs.filter((j) => j.kind === "scenes")).toEqual([]);
  });
});

describe("the scene set listeners", () => {
  test("hear each scenes.changed in order, and `resynced` after a snapshot taken again (never on the first one)", async () => {
    const h = await started();
    const heard: SceneSetSignal[] = [];
    const stop = h.store.subscribeSceneSets((signal) => heard.push(signal));

    const empty = await h.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 0, categories: [], poses: { profile: false, back: false }, acceptedWorstMicros: 0 });
    if (!empty.ok) throw new Error("compose failed");
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted"]);

    await h.client.request("scenes.discard", { sceneSetId: empty.result.sceneSetId });
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted", "removed"]);

    h.store.reload();
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted", "removed", "resynced"]);

    stop();
    h.store.reload();
    await settle();
    expect(heard).toHaveLength(3);
  });

  test("the event keeps the view's seq moving without putting a set in the view", async () => {
    const h = await started();
    const before = h.store.getView().lastSeq;
    await h.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 0, categories: [], poses: { profile: false, back: false }, acceptedWorstMicros: 0 });
    await settle();
    expect(h.store.getView().lastSeq).toBeGreaterThan(before);
  });
});
