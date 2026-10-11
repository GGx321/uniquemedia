import { expect, test } from "bun:test";
import { PROTOCOL_VERSION, type CommandMessage, type UnsequencedEvent } from "../../shared/engine";
import { createEngineClient } from "./client";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { MIA } from "./mockEngine.testkit";
import { MOCK_PORTRAIT_IMAGE_MICROS } from "./mockPortraits";
import { sidebarCounts } from "./renderJobs";
import { ManualScheduler } from "./scheduler";
import { EngineStore } from "./store";

// S5.3d: the window tracks a reference-portrait batch as what it is: an `avatar.portraits` job of five slots, from the command's own reply, from its
// events, and from a `job.done` that is the first thing this window hears of it (never labelled a candidates batch, never «0 / 4»).

const NINI = { ...MIA, avatarId: "avatar-nini-0004", name: "Nini", masterPhotoId: "photo-nini-source" };
const RAW_BOOT = "boot-raw-portraits";

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function started() {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [NINI], portraits: [{ avatarId: NINI.avatarId, sourcePhotoId: NINI.masterPhotoId }] });
  const client = mockEngineClient(engine);
  const store = new EngineStore(client);
  const stop = store.start();
  await settle();
  return { scheduler, engine, client, store, stop };
}

/** A store on a scripted bridge, so a test can emit exactly one event with nothing around it (as store.test.ts's own `rawHost`). */
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

test("trackPortraitsJob records the batch with its five slots before any event, and the sidebar counts 0 / 5", async () => {
  const { store } = await started();
  store.trackPortraitsJob("job-00000042", NINI.avatarId);
  expect(store.getView().jobs).toEqual([
    { jobId: "job-00000042", kind: "avatar.portraits", avatarId: NINI.avatarId, runId: null, montageId: null, videoId: null, saving: false, status: "queued", done: 0, total: 5, result: null, error: null },
  ]);
  expect(sidebarCounts(store.getView().jobs, new Set()).generation).toEqual({ done: 0, total: 5 });
});

test("trackPortraitsJob never overrides progress that beat the reply", async () => {
  const { scheduler, client, store } = await started();
  const reply = await client.request("avatars.generatePortraits", { avatarId: NINI.avatarId, acceptedWorstMicros: 5 * MOCK_PORTRAIT_IMAGE_MICROS });
  if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}`);
  scheduler.next();
  scheduler.next(); // two slots' job.progress land before this window tracks the job
  await settle();

  store.trackPortraitsJob(reply.result.jobId, NINI.avatarId);
  expect(store.getView().jobs.find((j) => j.jobId === reply.result.jobId)).toMatchObject({ kind: "avatar.portraits", status: "running", done: 2, total: 5 });
});

test("a portrait batch first heard of at its job.done is a portrait batch, complete, with its result", async () => {
  const { store, emit } = await rawHost();
  await emit({
    type: "job.done",
    payload: {
      jobId: "job-00000099",
      result: {
        kind: "avatar.portraits",
        avatarId: "avatar-zoe-0001",
        candidates: [{ avatarId: "avatar-zoe-0001", photoId: "photo-00000001", likeness: 0.76 }],
        failedSlots: [
          { slot: 2, reason: "unlike", likeness: 0.48 },
          { slot: 3, reason: "failed", error: { code: "MODERATION_REFUSED" }, reserveLeftOpen: false },
        ],
      },
    },
  });

  const job = store.getView().jobs.find((j) => j.jobId === "job-00000099");
  expect(job).toMatchObject({ kind: "avatar.portraits", avatarId: "avatar-zoe-0001", status: "done", done: 3, total: 3 });
  expect(job?.result?.kind).toBe("avatar.portraits");
});

test("a candidates batch first heard of at its job.done is still a candidates batch", async () => {
  const { store, emit } = await rawHost();
  await emit({
    type: "job.done",
    payload: { jobId: "job-00000098", result: { kind: "avatar.candidates", avatarId: "avatar-zoe-0001", candidates: [], rejectedByAgeCheck: 0, failedSlots: [] } },
  });
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000098")?.kind).toBe("avatar.candidates");
});

test("claimOnce hands a key out once per purpose, for the window's life (review L5: the landing's latch lives here, not in a screen's module)", async () => {
  const { store } = await started();
  const landing = { kind: "imported" };
  expect(store.claimOnce("portraits-landing", landing)).toBe(true);
  expect(store.claimOnce("portraits-landing", landing)).toBe(false);
  expect(store.claimOnce("portraits-landing", { kind: "imported" })).toBe(true);
  expect(store.claimOnce("another-purpose", landing)).toBe(true);
});

test("a portrait batch with no total yet counts its 5 slots in «Генерация», beside a candidates batch's 4", () => {
  const base = { avatarId: "avatar-mia-0001", runId: null, montageId: null, videoId: null, status: "running" as const, saving: false, done: 0, total: 0, result: null, error: null };
  const counts = sidebarCounts(
    [
      { ...base, jobId: "job-00000001", kind: "avatar.portraits" },
      { ...base, jobId: "job-00000002", kind: "avatar.candidates" },
    ],
    new Set(),
  );
  expect(counts.generation).toEqual({ done: 0, total: 9 });
});
