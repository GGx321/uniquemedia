import { expect, test } from "bun:test";
import { PROTOCOL_VERSION, type CommandMessage, type UnsequencedEvent } from "../../shared/engine";
import { createEngineClient } from "./client";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { sidebarCounts } from "./renderJobs";
import { ManualScheduler } from "./scheduler";
import { EngineStore } from "./store";

// Stage 5, 5b.1, S5.V1: the window hears of a clip job as what it is. The store's `job.done` chains are exhaustive over the result kinds, so a clip result must be handled
// (compile-only; S5.V8 gives the window its screens). A clip is never «Генерация» and is never labelled as another kind.

const RAW_BOOT = "boot-raw-clips";
const AVATAR = "avatar-zoe-0001";

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A store on a scripted bridge, so a test can emit exactly one event with nothing around it (as store.test.ts's own `rawHost`). */
async function rawHost(jobs: readonly unknown[] = []) {
  const base = await mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() })).request("engine.snapshot", {});
  if (!base.ok) throw new Error(`expected ok, got ${base.error.code}`);
  const snapshot = { ...base.result, bootId: RAW_BOOT, lastSeq: 0, jobs };
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

test("a clip first heard of at its job.done is a clip job of its avatar, complete, with its result", async () => {
  const { store, emit } = await rawHost();
  await emit({ type: "job.done", payload: { jobId: "job-00000077", result: { kind: "clip", avatarId: AVATAR, clipId: "clip-0000001" } } });

  const job = store.getView().jobs.find((j) => j.jobId === "job-00000077");
  expect(job).toMatchObject({ kind: "clip", avatarId: AVATAR, status: "done", runId: null, montageId: null, videoId: null });
  expect(job?.total).toBeGreaterThan(0);
  expect(job?.done).toBe(job?.total ?? -1);
  expect(job?.result?.kind).toBe("clip");
});

test("a clip's first event may be its job.progress: the store lists it running with the counts it carries", async () => {
  const { store, emit } = await rawHost();
  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000078", avatarId: AVATAR, clipId: "clip-0000002", done: 1, total: 4, phase: "rendering" } });

  expect(store.getView().jobs.find((j) => j.jobId === "job-00000078")).toMatchObject({ kind: "clip", avatarId: AVATAR, status: "running", done: 1, total: 4 });
});

test("a failed clip job is listed failed, and a cancelled one cancelled", async () => {
  const { store, emit } = await rawHost();
  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000079", avatarId: AVATAR, clipId: "clip-0000003", done: 0, total: 4, phase: "preparing" } });
  await emit({ type: "job.cancelled", payload: { kind: "clip", jobId: "job-00000079", avatarId: AVATAR, clipId: "clip-0000003" } });
  await emit({ type: "job.failed", payload: { kind: "clip", jobId: "job-00000080", avatarId: AVATAR, clipId: "clip-0000004", error: { code: "INTERNAL", detail: "x" } } });

  const jobs = store.getView().jobs;
  expect(jobs.find((j) => j.jobId === "job-00000079")).toMatchObject({ kind: "clip", status: "cancelled" });
  expect(jobs.find((j) => j.jobId === "job-00000080")).toMatchObject({ kind: "clip", status: "failed" });
});

test("a clip job in a snapshot is restored as a clip job", async () => {
  const { store } = await rawHost([{ kind: "clip", jobId: "job-00000081", avatarId: AVATAR, clipId: "clip-0000005", status: "running", done: 2, total: 4, phase: "downloading" }]);

  expect(store.getView().jobs).toEqual([
    { jobId: "job-00000081", kind: "clip", avatarId: AVATAR, runId: null, montageId: null, videoId: null, saving: false, status: "running", done: 2, total: 4, result: null, error: null },
  ]);
});

test("a running clip is not «Генерация»: it never joins the photo runs' count", async () => {
  const { store, emit } = await rawHost();
  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000082", avatarId: AVATAR, clipId: "clip-0000006", done: 1, total: 4, phase: "rendering" } });

  const counts = sidebarCounts(store.getView().jobs, new Set());
  expect(counts.generation).toBeNull();
  expect(counts.render).toBeNull();
  expect(counts.scenes).toBeNull();
});
