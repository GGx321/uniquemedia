import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type AvatarSummary, type CommandMessage, type UnsequencedEvent } from "../../shared/engine";
import { createEngineClient } from "./client";
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

const RAW_BOOT = "boot-raw-scenes";

/**
 * A store wired to a scripted bridge, so a test can emit exactly the one event it wants with nothing else around it. A real mock job always sends
 * a job.progress first, which would hide a store that ignores trackScenesJob or reads the total off the result wrongly (as store.test.ts's own rawHost).
 */
async function rawHost() {
  const base = await mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() })).request("engine.snapshot", {});
  if (!base.ok) throw new Error(`expected ok, got ${base.error.code}`);
  const snapshot = { ...base.result, bootId: RAW_BOOT, lastSeq: 0 };
  let seq = 0;
  const listeners = new Set<(e: unknown) => void>();
  const bridge = {
    async request(cmd: CommandMessage): Promise<unknown> {
      const head = { v: PROTOCOL_VERSION, id: cmd.id, kind: "response" as const, type: cmd.type };
      if (cmd.type === "engine.snapshot") return { ...head, ok: true, result: { ...snapshot, lastSeq: seq } };
      return { ...head, ok: false, error: { code: "INTERNAL" as const } };
    },
    subscribe(l: (e: unknown) => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const store = new EngineStore(createEngineClient(bridge, "window"));
  store.start();
  await settle();
  return {
    store,
    emit: async (event: Omit<UnsequencedEvent, "v" | "id" | "kind">) => {
      seq += 1;
      const message = { v: PROTOCOL_VERSION, id: `evt-${String(seq).padStart(8, "0")}`, kind: "event" as const, seq, bootId: RAW_BOOT, ...event };
      for (const l of [...listeners]) l(message);
      await settle();
    },
  };
}

const compose = (h: Awaited<ReturnType<typeof started>>, count: number) =>
  h.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: Math.ceil(count / 25) * 75_000 });

describe("a scenes job in the store", () => {
  test("tracked at its launch with the scenes it writes as the total, before any event is heard, and counted in the sidebar's queue on a row of its own", async () => {
    const { store } = await rawHost();
    store.trackScenesJob("job-00000777", "set-00000777", MIA.avatarId, 30);

    const job = store.getView().jobs.find((j) => j.jobId === "job-00000777");
    expect(job).toMatchObject({ kind: "scenes", avatarId: MIA.avatarId, status: "queued", done: 0, total: 30 });
    const counts = sidebarCounts(store.getView().jobs, new Set());
    expect(counts.queue).toBe(1);
    // CS.6 (Sidebar.dc.html `queue`: «Сцены 0 / 20»): scenes, not photos — its own row, not «Генерация».
    expect(counts.scenes).toEqual({ done: 0, total: 30 });
    expect(counts.generation).toBeNull();
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

  test("a job first heard of at its end, with no progress before it, has its total from the result: the scenes written and the ones left", async () => {
    const { store, emit } = await rawHost();
    await emit({ type: "job.done", payload: { jobId: "job-00000778", result: { kind: "scenes", sceneSetId: "set-00000778", avatarId: MIA.avatarId, written: 28, unwritten: 2 } } });

    expect(store.getView().jobs.find((j) => j.jobId === "job-00000778")).toMatchObject({ kind: "scenes", status: "done", total: 30, done: 30 });
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
