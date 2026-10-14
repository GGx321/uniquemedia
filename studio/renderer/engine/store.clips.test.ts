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
    // S5.V8: the clip's own identity rides with it (its clip, its phase), so the tiles and the queue row can say where it stands.
    {
      jobId: "job-00000081",
      kind: "clip",
      avatarId: AVATAR,
      runId: null,
      montageId: null,
      videoId: null,
      saving: false,
      status: "running",
      done: 2,
      total: 4,
      result: null,
      error: null,
      clip: { clipId: "clip-0000005", phase: "downloading", model: null, submittedAt: null, proveUntil: null, recovery: false, export: false },
    },
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

// ---------- S5.V8: what the window keeps of a clip job ----------

test("a clip's job.progress carries its phase, its model and the submit time onto the job's view", async () => {
  const { store, emit } = await rawHost();
  const at = "2026-10-11T11:06:00.000Z";
  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000090", avatarId: AVATAR, clipId: "job-00000090", done: 0, total: 4, phase: "rendering", model: "kling", submittedAt: at } });
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000090")?.clip).toEqual({ clipId: "job-00000090", phase: "rendering", model: "kling", submittedAt: at, proveUntil: null, recovery: false, export: false });

  const until = "2026-10-11T11:09:00.000Z";
  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000090", avatarId: AVATAR, clipId: "job-00000090", done: 0, total: 4, phase: "proving", model: "kling", proveUntil: until } });
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000090")?.clip).toMatchObject({ phase: "proving", proveUntil: until, submittedAt: null });
});

test("a restart's recovery job is remembered as one after it moves on (the banner's «Клип был в работе, когда Studio закрылась»)", async () => {
  const { store, emit } = await rawHost();
  const ref = { kind: "clip" as const, jobId: "job-00000091", avatarId: AVATAR, clipId: "clip-0000009" };
  await emit({ type: "job.progress", payload: { ...ref, done: 0, total: 4, phase: "recovering" } });
  await emit({ type: "job.progress", payload: { ...ref, done: 1, total: 4, phase: "downloading" } });
  await emit({ type: "job.done", payload: { jobId: ref.jobId, result: { kind: "clip", avatarId: AVATAR, clipId: ref.clipId } } });
  const job = store.getView().jobs.find((j) => j.jobId === ref.jobId);
  expect(job?.status).toBe("done");
  expect(job?.clip).toMatchObject({ clipId: "clip-0000009", phase: "downloading", recovery: true, export: false });
});

test("an export job is told apart from the clip's own job: `export` from its phase, and from its result", async () => {
  const { store, emit } = await rawHost();
  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000092", avatarId: AVATAR, clipId: "clip-0000010", done: 60, total: 150, phase: "exporting" } });
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000092")?.clip).toMatchObject({ clipId: "clip-0000010", phase: "exporting", export: true });

  await emit({ type: "job.done", payload: { jobId: "job-00000093", result: { kind: "clip", avatarId: AVATAR, clipId: "clip-0000010", exported: { relPath: "Nini/2026-10-11_clip_001.mp4" } } } });
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000093")?.clip).toMatchObject({ clipId: "clip-0000010", export: true });
});

test("a clip job this window just started is listed at once, in its first phase, and its events merge into it", async () => {
  const { store, emit } = await rawHost();
  store.trackClipJob("job-00000094", AVATAR, "job-00000094", "create");
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000094")).toMatchObject({ kind: "clip", status: "queued", total: 4, clip: { clipId: "job-00000094", phase: "preparing", export: false } });
  store.trackClipJob("job-00000095", AVATAR, "clip-0000011", "export");
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000095")?.clip).toMatchObject({ clipId: "clip-0000011", phase: "exporting", export: true });
  store.trackClipJob("job-00000096", AVATAR, "clip-0000012", "retry");
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000096")?.clip).toMatchObject({ clipId: "clip-0000012", phase: "downloading", export: false });

  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000094", avatarId: AVATAR, clipId: "job-00000094", done: 0, total: 4, phase: "submitting", model: "kling" } });
  expect(store.getView().jobs.filter((j) => j.jobId === "job-00000094")).toHaveLength(1);
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000094")).toMatchObject({ status: "running", clip: { phase: "submitting", model: "kling" } });
});

test("a clip job's failure keeps its clip, so a clip that ended with no record (a refused reserve, say) is still the owner's to see", async () => {
  const { store, emit } = await rawHost();
  store.trackClipJob("job-00000097", AVATAR, "job-00000097", "create");
  await emit({ type: "job.failed", payload: { kind: "clip", jobId: "job-00000097", avatarId: AVATAR, clipId: "job-00000097", error: { code: "BUDGET_EXCEEDED", detail: "x" } } });
  expect(store.getView().jobs.find((j) => j.jobId === "job-00000097")).toMatchObject({ status: "failed", error: { code: "BUDGET_EXCEEDED" }, clip: { clipId: "job-00000097", phase: "preparing" } });
});

// Stage 5, 5b.1, S5.V8b: a clip job tells the window what its tile shows, so a window that first hears of the job (a new window, a reload) needs no memory of the click.
const FACTS = {
  photoId: "photo-zoe-0001",
  request: { model: "kling", quality: "std", seconds: 5, fallback: "none" },
  motion: { source: "code", label: "Моргает и улыбается" },
  acceptedWorstMicros: 504_000,
} as const;

test("a clip job's first event, with the facts, gives the job view the facts", async () => {
  const { store, emit } = await rawHost();
  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000079", avatarId: AVATAR, clipId: "job-00000079", done: 0, total: 4, phase: "recovering", ...FACTS } });

  expect(store.getView().jobs.find((j) => j.jobId === "job-00000079")?.clip?.facts).toEqual(FACTS);
});

test("a clip job listed in the snapshot with the facts gives the job view the facts", async () => {
  const { store } = await rawHost([{ kind: "clip", jobId: "job-00000080", avatarId: AVATAR, clipId: "job-00000080", status: "running", done: 0, total: 4, phase: "recovering", ...FACTS }]);

  expect(store.getView().jobs.find((j) => j.jobId === "job-00000080")?.clip?.facts).toEqual(FACTS);
});

test("a later event of the job keeps the facts an earlier one told", async () => {
  const { store, emit } = await rawHost();
  const ref = { kind: "clip", jobId: "job-00000081", avatarId: AVATAR, clipId: "job-00000081", total: 4 } as const;
  await emit({ type: "job.progress", payload: { ...ref, done: 0, phase: "preparing", ...FACTS } });
  await emit({ type: "job.progress", payload: { ...ref, done: 0, phase: "submitting", model: "kling" } });

  expect(store.getView().jobs.find((j) => j.jobId === "job-00000081")?.clip).toMatchObject({ phase: "submitting", facts: FACTS });
});

test("a clip job of an older engine, with no facts, has none", async () => {
  const { store, emit } = await rawHost();
  await emit({ type: "job.progress", payload: { kind: "clip", jobId: "job-00000082", avatarId: AVATAR, clipId: "job-00000082", done: 0, total: 4, phase: "preparing" } });

  expect(store.getView().jobs.find((j) => j.jobId === "job-00000082")?.clip?.facts).toBeUndefined();
});
