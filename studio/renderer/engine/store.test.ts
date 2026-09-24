import { expect, test } from "bun:test";
import type { AvatarSummary, CommandMessage, EventMessage } from "../../shared/engine";
import type { EngineClient } from "./client";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore } from "./store";

function zoe(): AvatarSummary {
  return {
    avatarId: "avatar-zoe-0001",
    name: "Zoe",
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    masterPhotoId: "photo-zoe-0001",
    createdAt: "2026-09-24T09:00:00.000Z",
    status: "active",
    photoCount: 3,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function count(calls: readonly CommandMessage[], type: CommandMessage["type"]): number {
  return calls.filter((c) => c.type === type).length;
}

async function started(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, ...options });
  const store = new EngineStore(mockEngineClient(engine));
  const stop = store.start();
  await settle();
  return { scheduler, engine, store, stop };
}

test("loads the snapshot, then applies events in seq order", async () => {
  const { engine, store } = await started({ money: { monthlyBudgetMicros: 5_000_000 } });
  expect(store.getView()).toMatchObject({ phase: "ready", bootId: engine.currentBootId, lastSeq: 0 });
  expect(store.getView().money?.monthlyBudgetMicros).toBe(5_000_000);

  engine.requireReconcile(["torn-ledger-line"]);
  expect(store.getView().lastSeq).toBe(1);
  expect(store.getView().money).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["torn-ledger-line"] });
  expect(count(engine.calls, "engine.snapshot")).toBe(1);
});

test("a seq hole is filled from engine.events, without a new snapshot", async () => {
  const { engine, store } = await started();
  engine.setDelivery(false);
  engine.requireReconcile(["open-reserves"]); // seq 1, missed
  engine.setDelivery(true);
  engine.touchMoney(); // seq 2 arrives first
  await settle();

  expect(count(engine.calls, "engine.events")).toBe(1);
  expect(engine.calls.find((c) => c.type === "engine.events")?.payload).toEqual({ afterSeq: 0, bootId: engine.currentBootId });
  expect(count(engine.calls, "engine.snapshot")).toBe(1);
  expect(store.getView().lastSeq).toBe(2);
  expect(store.getView().money?.reconcileReasons).toEqual(["open-reserves"]);
});

test("a gap (evicted events) refetches the snapshot", async () => {
  const { engine, store } = await started({ eventCapacity: 2 });
  engine.setDelivery(false);
  engine.addAvatarSilently(zoe());
  engine.touchMoney();
  engine.touchMoney();
  engine.touchMoney(); // seq 1 is evicted from a ring of 2
  engine.setDelivery(true);
  engine.touchMoney();
  await settle();

  expect(count(engine.calls, "engine.events")).toBe(1);
  expect(count(engine.calls, "engine.snapshot")).toBe(2);
  expect(store.getView().avatars.map((a) => a.name)).toEqual(["Zoe"]);
  expect(store.getView().lastSeq).toBe(4);
});

test("an event from another bootId (engine restart) refetches the snapshot", async () => {
  const { engine, store } = await started();
  engine.touchMoney();
  const firstBoot = store.getView().bootId;
  engine.addAvatarSilently(zoe());
  engine.restart();
  await settle();

  expect(count(engine.calls, "engine.snapshot")).toBe(2);
  expect(store.getView().bootId).toBe(engine.currentBootId);
  expect(store.getView().bootId).not.toBe(firstBoot);
  expect(store.getView().lastSeq).toBe(1);
  expect(store.getView().avatars.map((a) => a.name)).toEqual(["Zoe"]);
});

test("duplicates and stale events are ignored", async () => {
  const { engine, store } = await started();
  engine.touchMoney();
  engine.touchMoney();
  const seq = store.getView().lastSeq;
  store.reconnect();
  await settle();
  expect(store.getView().lastSeq).toBe(seq);
  expect(count(engine.calls, "engine.snapshot")).toBe(1);
});

test("reconnect catches up by events when nothing was lost", async () => {
  const { engine, store } = await started();
  engine.setDelivery(false);
  engine.touchMoney();
  engine.touchMoney();
  engine.setDelivery(true);
  store.reconnect();
  await settle();
  expect(store.getView().lastSeq).toBe(2);
  expect(count(engine.calls, "engine.events")).toBe(1);
  expect(count(engine.calls, "engine.snapshot")).toBe(1);
});

test("job events update the job and merge candidates into the draft", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  store.upsertDraft(created.result.draft);
  const started_ = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!started_.ok) throw new Error(started_.error.code);
  const { jobId } = started_.result;

  scheduler.next();
  scheduler.next();
  expect(store.getView().jobs.find((j) => j.jobId === jobId)).toMatchObject({ status: "running", done: 2, total: 4 });

  store.trackCandidatesJob(jobId, created.result.draft.avatarId);
  scheduler.runAll();
  expect(store.getView().jobs.find((j) => j.jobId === jobId)).toMatchObject({ status: "done", kind: "avatar.candidates" });
  expect(store.getView().drafts[0]?.candidates).toHaveLength(4);
});

test("a failed snapshot leaves the store offline, and reload recovers", async () => {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler });
  engine.failNext("engine.snapshot", { code: "INTERNAL" });
  const store = new EngineStore(mockEngineClient(engine));
  store.start();
  await settle();
  expect(store.getView()).toMatchObject({ phase: "offline", failure: { code: "INTERNAL" } });
  store.reload();
  await settle();
  expect(store.getView().phase).toBe("ready");
});

test("after stop, late answers and events change nothing (StrictMode remount)", async () => {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler });
  const store = new EngineStore(mockEngineClient(engine));
  const stop = store.start();
  stop();
  const restart = store.start();
  await settle();
  expect(store.getView().phase).toBe("ready");
  engine.touchMoney();
  expect(store.getView().lastSeq).toBe(1);
  restart();
  engine.touchMoney();
  expect(store.getView().lastSeq).toBe(1);
});

test("progress that arrives after a local cancel does not revive the job", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);

  scheduler.next();
  store.markJobCancelled(job.result.jobId);
  scheduler.next(); // the engine had already queued this progress
  expect(store.getView().jobs.find((j) => j.jobId === job.result.jobId)?.status).toBe("cancelled");
  expect(store.getView().lastSeq).toBeGreaterThan(0);
});

test("money.reconcileNeeded refreshes the money status, so the reserve count is current", async () => {
  const { engine } = await started();
  const before = count(engine.calls, "money.status");
  engine.requireReconcile(["open-reserves"]);
  await settle();
  expect(count(engine.calls, "money.status")).toBe(before + 1);
});

test("a gap that never heals stops after a few resyncs and goes offline", async () => {
  const source = new MockEngine({ scheduler: new ManualScheduler() });
  const snap = await mockEngineClient(source).request("engine.snapshot", {});
  if (!snap.ok) throw new Error(snap.error.code);
  const sink: { listener: ((e: EventMessage) => void) | null } = { listener: null };
  let snapshots = 0;
  const broken: EngineClient = {
    kind: "mock",
    async request(type, payload) {
      if (type === "engine.snapshot") snapshots += 1;
      return mockEngineClient(source).request(type, payload);
    },
    subscribe(l) {
      sink.listener = l;
      return () => {
        sink.listener = null;
      };
    },
  };
  const store = new EngineStore(broken);
  store.start();
  await settle();
  // The engine keeps sending seq 50 from a boot whose snapshot says lastSeq 0 and whose log is empty.
  const stray: EventMessage = {
    v: 1,
    id: "evt-stray-01",
    kind: "event",
    seq: 50,
    bootId: snap.result.bootId,
    type: "money.changed",
    payload: { status: snap.result.money },
  };
  for (let i = 0; i < 5; i++) {
    sink.listener?.(stray);
    for (let j = 0; j < 40; j++) await settle();
  }
  expect(snapshots).toBeLessThanOrEqual(5);
  expect(store.getView().phase).toBe("offline");
});
