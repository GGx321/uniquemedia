import { expect, test } from "bun:test";
import { ENGINE_GONE_DETAIL, type AvatarSummary, type CommandMessage, type EventMessage } from "../../shared/engine";
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

// M5: a dead engine must not leave a job looking alive just because no
// event will ever arrive to say otherwise (nothing polls on its own).
test("going offline fails every active job, so it cannot go on looking alive forever (M5)", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);
  scheduler.next(); // one slot lands; the job is genuinely "running", not just queued
  expect(store.getView().jobs.find((j) => j.jobId === job.result.jobId)?.status).toBe("running");

  engine.failNext("engine.snapshot", { code: "INTERNAL", detail: ENGINE_GONE_DETAIL });
  store.reload();
  await settle();

  expect(store.getView().phase).toBe("offline");
  const view = store.getView().jobs.find((j) => j.jobId === job.result.jobId);
  expect(view?.status).toBe("failed");
  expect(view?.error).toEqual({ code: "INTERNAL", detail: ENGINE_GONE_DETAIL });
  // A finished job (done/cancelled/failed already) must not be disturbed by going offline.
  expect(store.getView().jobs.filter((j) => j.status === "queued" || j.status === "running")).toEqual([]);
});

// A resync failure that is NOT the engine dying for good (a broken event
// stream, a merely-unlucky snapshot fetch) must not lie about a job that is
// still genuinely alive on the engine's side: only ENGINE_GONE_DETAIL means
// there is no engine left to ever correct the guess.
test("an ordinary offline (not dead for good) leaves an active job's own status alone", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);
  scheduler.next();
  expect(store.getView().jobs.find((j) => j.jobId === job.result.jobId)?.status).toBe("running");

  engine.failNext("engine.snapshot", { code: "INTERNAL" }); // no detail: an ordinary, possibly transient failure
  store.reload();
  await settle();

  expect(store.getView().phase).toBe("offline");
  expect(store.getView().jobs.find((j) => j.jobId === job.result.jobId)?.status).toBe("running");
});

test("a job already done or cancelled before the engine goes offline keeps its own outcome", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);
  scheduler.runAll();
  expect(store.getView().jobs.find((j) => j.jobId === job.result.jobId)?.status).toBe("done");

  engine.failNext("engine.snapshot", { code: "INTERNAL" });
  store.reload();
  await settle();

  expect(store.getView().jobs.find((j) => j.jobId === job.result.jobId)?.status).toBe("done");
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

// Optimistic cancel: the real engine's avatars.cancel answers before the job
// actually ends (engine.ts's #runCandidates settles the job later). The
// store must not call a job cancelled just because its own command was
// accepted — only a real end (job.cancelled, or the job no longer active in
// a fresh snapshot) may do that.
test("markCancelling keeps the job active until job.cancelled actually arrives", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);
  const jobId = job.result.jobId;
  scheduler.next();

  store.markCancelling(jobId);
  expect(store.getView().cancellingJobs.has(jobId)).toBe(true);
  // Accepting the cancel does not end the job on its own: it is still what it was.
  expect(store.getView().jobs.find((j) => j.jobId === jobId)?.status).toBe("running");

  await client.request("avatars.cancel", { jobId });
  scheduler.runAll(); // the mock's own job.cancelled lands later than its command reply
  await settle();
  expect(store.getView().jobs.find((j) => j.jobId === jobId)?.status).toBe("cancelled");
  expect(store.getView().cancellingJobs.has(jobId)).toBe(false);
});

test("markCancelling is a no-op for a job that is not active (nothing to wait for)", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);
  scheduler.runAll();
  expect(store.getView().jobs.find((j) => j.jobId === job.result.jobId)?.status).toBe("done");

  store.markCancelling(job.result.jobId);
  expect(store.getView().cancellingJobs.size).toBe(0);
});

test("an engine restart (bootId change) ends the cancelling state along with the job", async () => {
  const { engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);
  store.trackCandidatesJob(job.result.jobId, created.result.draft.avatarId);
  store.markCancelling(job.result.jobId);
  expect(store.getView().cancellingJobs.has(job.result.jobId)).toBe(true);

  engine.restart();
  await settle();

  expect(store.getView().cancellingJobs.size).toBe(0);
});

test("going offline dead-for-good (M5) also ends the cancelling state: it fails every active job", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);
  scheduler.next();
  store.markCancelling(job.result.jobId);
  expect(store.getView().cancellingJobs.has(job.result.jobId)).toBe(true);

  engine.failNext("engine.snapshot", { code: "INTERNAL", detail: ENGINE_GONE_DETAIL });
  store.reload();
  await settle();

  expect(store.getView().cancellingJobs.size).toBe(0);
  expect(store.getView().jobs.find((j) => j.jobId === job.result.jobId)?.status).toBe("failed");
});

// The race the reviewer asked to pin explicitly: cancel is sent, but the
// batch finishes (job.done) before the abort actually takes effect — a real
// possibility since avatars.cancel only asks the engine to stop, it does not
// freeze the job in place. "Отменяем…" must clear all the same: the job is
// no longer active, whatever it ended as.
test("a job that finishes (job.done) while a cancel is pending clears «Отменяем…» too", async () => {
  const { scheduler, engine, store } = await started();
  const client = mockEngineClient(engine);
  const created = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  if (!created.ok) throw new Error(created.error.code);
  const job = await client.request("avatars.generateCandidates", { avatarId: created.result.draft.avatarId, acceptedWorstMicros: 223_000 });
  if (!job.ok) throw new Error(job.error.code);
  const jobId = job.result.jobId;
  scheduler.next();

  store.markCancelling(jobId);
  expect(store.getView().cancellingJobs.has(jobId)).toBe(true);

  // The cancel is never actually sent to the engine here — this pins the
  // store's own bookkeeping: whatever the real end turns out to be, pending
  // or not, "cancelling" must not survive it.
  scheduler.runAll();
  expect(store.getView().jobs.find((j) => j.jobId === jobId)?.status).toBe("done");
  expect(store.getView().cancellingJobs.has(jobId)).toBe(false);
});

test("avatars.rewriteDescriptor recovers an unreadable avatar into the store's normal list, dropped from unreadableAvatars (H1, full stack)", async () => {
  const { engine, store } = await started();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0001", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Mia", traits: DEFAULT_TRAITS, masterPhotoId: "photo-broken-0001", photoCount: 1 },
  );
  await store.refreshAvatars();
  expect(store.getView().unreadableAvatars).toHaveLength(1);
  const client = mockEngineClient(engine);

  const est = await client.request("avatars.estimateRewriteDescriptor", { avatarId: "avatar-broken-0001" });
  if (!est.ok) throw new Error(est.error.code);
  const rw = await client.request("avatars.rewriteDescriptor", { avatarId: "avatar-broken-0001", acceptedWorstMicros: est.result.worstMicros });
  if (!rw.ok) throw new Error(rw.error.code);
  await settle();

  const view = store.getView();
  expect(view.avatars.map((a) => a.avatarId)).toContain("avatar-broken-0001");
  expect(view.unreadableAvatars).toEqual([]);
});

test("money.reconcileNeeded refreshes the money status, so the reserve count is current", async () => {
  const { engine } = await started();
  const before = count(engine.calls, "money.status");
  engine.requireReconcile(["open-reserves"]);
  await settle();
  expect(count(engine.calls, "money.status")).toBe(before + 1);
});

test("two engine notices with the same code show once, the latest replacing the earlier", async () => {
  const { engine, store } = await started();
  engine.emitNotice({ noticeId: "notice-0001", code: "engine-restarted", at: "2026-09-24T10:00:00.000Z", count: 1 });
  engine.emitNotice({ noticeId: "notice-0002", code: "engine-restarted", at: "2026-09-24T10:05:00.000Z", count: 2 });

  expect(store.getView().notices).toHaveLength(1);
  expect(store.getView().notices[0]).toMatchObject({ noticeId: "notice-0002", count: 2 });
});

test("notices of different codes are kept apart", async () => {
  const { engine, store } = await started();
  engine.emitNotice({ noticeId: "notice-0001", code: "engine-restarted", at: "2026-09-24T10:00:00.000Z", count: 1 });
  engine.emitNotice({ noticeId: "notice-0002", code: "settings-reset", at: "2026-09-24T10:05:00.000Z", count: 1 });

  expect(store.getView().notices.map((n) => n.code)).toEqual(["engine-restarted", "settings-reset"]);
});

test("a repeated engine.notice delivery (same noticeId) is not duplicated", async () => {
  const { engine, store } = await started();
  const notice = { noticeId: "notice-0001", code: "engine-restarted" as const, at: "2026-09-24T10:00:00.000Z", count: 1 };
  engine.emitNotice(notice);
  engine.emitNotice(notice);

  expect(store.getView().notices).toHaveLength(1);
});

// Dedupe by code used to keep whichever arrived last, trusting delivery
// order; it must instead keep the larger `count` (or, tied, the newer
// `at`), so an out-of-order delivery cannot make a notice regress.
test("a notice with a smaller count arriving after one with a larger count does not replace it", async () => {
  const { engine, store } = await started();
  engine.emitNotice({ noticeId: "notice-0002", code: "engine-restarted", at: "2026-09-24T10:05:00.000Z", count: 2 });
  engine.emitNotice({ noticeId: "notice-0001", code: "engine-restarted", at: "2026-09-24T10:00:00.000Z", count: 1 });

  expect(store.getView().notices).toHaveLength(1);
  expect(store.getView().notices[0]).toMatchObject({ noticeId: "notice-0002", count: 2 });
});

test("when two notices of the same code tie on count, the one with the newer `at` wins", async () => {
  const { engine, store } = await started();
  engine.emitNotice({ noticeId: "notice-0001", code: "settings-reset", at: "2026-09-24T10:00:00.000Z", count: 1 });
  engine.emitNotice({ noticeId: "notice-0002", code: "settings-reset", at: "2026-09-24T09:00:00.000Z", count: 1 });

  expect(store.getView().notices).toHaveLength(1);
  expect(store.getView().notices[0]).toMatchObject({ noticeId: "notice-0001", count: 1 });
});

// The pair above alone cannot tell "the newer `at` wins" apart from "the
// first one to arrive wins": there, the newer-`at` notice also happens to
// arrive first. Reversing the arrival order (the newer-`at` one arrives
// second) is what actually pins the rule down to `at`, not arrival order.
test("...and the newer `at` still wins when it is the one that arrives second", async () => {
  const { engine, store } = await started();
  engine.emitNotice({ noticeId: "notice-0001", code: "settings-reset", at: "2026-09-24T09:00:00.000Z", count: 1 });
  engine.emitNotice({ noticeId: "notice-0002", code: "settings-reset", at: "2026-09-24T10:00:00.000Z", count: 1 });

  expect(store.getView().notices).toHaveLength(1);
  expect(store.getView().notices[0]).toMatchObject({ noticeId: "notice-0002", count: 1 });
});

// In the tests above `count` and `at` always point the same way, so they
// cannot tell "count decides, `at` only breaks a tie" from the reverse.
test("a larger count wins over a newer `at`, whichever arrives first", async () => {
  const larger = { code: "engine-restarted" as const, at: "2026-09-24T09:00:00.000Z", count: 3 };
  const newer = { code: "engine-restarted" as const, at: "2026-09-24T10:00:00.000Z", count: 2 };

  const first = await started();
  first.engine.emitNotice({ noticeId: "notice-0001", ...larger });
  first.engine.emitNotice({ noticeId: "notice-0002", ...newer });
  expect(first.store.getView().notices).toHaveLength(1);
  expect(first.store.getView().notices[0]).toMatchObject({ noticeId: "notice-0001", count: 3 });

  const second = await started();
  second.engine.emitNotice({ noticeId: "notice-0002", ...newer });
  second.engine.emitNotice({ noticeId: "notice-0001", ...larger });
  expect(second.store.getView().notices).toHaveLength(1);
  expect(second.store.getView().notices[0]).toMatchObject({ noticeId: "notice-0001", count: 3 });
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
