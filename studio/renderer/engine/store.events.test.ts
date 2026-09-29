// The store's handling of the events and snapshot fields added for Studio
// task T6a: notices, settings, saved avatars, drafts and cancelled jobs. A
// scripted host serves one snapshot and emits contract events in seq order;
// every test also checks that the store never had to resync for them.
import { expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  type AvatarSummary,
  type CommandMessage,
  type Draft,
  type EngineNotice,
  type Snapshot,
  type UnsequencedEvent,
} from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { createEngineClient } from "./client";
import { MockEngine, mockDescriptor, mockEngineClient, MOCK_ESTIMATE } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore } from "./store";

const BOOT = "boot-engine-0001";

const RESET: EngineNotice = { noticeId: "notice-0001", code: "settings-reset", detail: "settings.json was reset", at: "2026-09-24T10:00:00.000Z", count: 1 };
const RESTART: EngineNotice = { noticeId: "notice-0002", code: "engine-restarted", at: "2026-09-24T10:05:00.000Z", count: 1 };

const DRAFT: Draft = {
  avatarId: "avatar-draft-0001",
  traits: DEFAULT_TRAITS,
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  candidates: [{ avatarId: "avatar-draft-0001", photoId: "photo-draft-0001" }],
  hiddenBelowThreshold: 0,
  estimate: { ...MOCK_ESTIMATE },
};

const SAVED: AvatarSummary = {
  avatarId: "avatar-draft-0001",
  name: "Lena",
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  masterPhotoId: "photo-draft-0001",
  createdAt: "2026-09-24T10:10:00.000Z",
  status: "active",
  photoCount: 1,
  videoCount: 0,
  eligibleUnusedCount: 0,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function baseSnapshot(): Promise<Snapshot> {
  const reply = await mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() })).request("engine.snapshot", {});
  if (!reply.ok) throw new Error(reply.error.code);
  return reply.result;
}

/** A host that answers engine.snapshot with `snapshot` and lets the test emit events with the next seq. */
async function host(patch: Partial<Snapshot> = {}) {
  let snapshot: Snapshot = { ...(await baseSnapshot()), bootId: BOOT, lastSeq: 0, ...patch };
  const listeners = new Set<(e: unknown) => void>();
  let seq = snapshot.lastSeq;
  let snapshots = 0;
  const bridge = {
    async request(cmd: CommandMessage): Promise<unknown> {
      const head = { v: PROTOCOL_VERSION, id: cmd.id, kind: "response", type: cmd.type };
      if (cmd.type === "engine.snapshot") {
        snapshots += 1;
        return { ...head, ok: true, result: { ...snapshot, lastSeq: seq } };
      }
      return { ...head, ok: false, error: { code: "INTERNAL" } };
    },
    subscribe(l: (e: unknown) => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const store = new EngineStore(createEngineClient(bridge, "window"));
  const stop = store.start();
  await flush();
  return {
    store,
    stop,
    snapshots: () => snapshots,
    /** What the next engine.snapshot answers (e.g. the lists of another library). */
    setSnapshot: (next: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...next };
    },
    emit: async (event: Omit<UnsequencedEvent, "v" | "id" | "kind">) => {
      seq += 1;
      const message = { v: PROTOCOL_VERSION, id: `evt-${String(seq).padStart(8, "0")}`, kind: "event", seq, bootId: BOOT, ...event };
      for (const l of [...listeners]) l(message);
      await flush();
    },
  };
}

test("the snapshot's avatar records it could not read are kept, with the count derived from the list's length", async () => {
  const unreadableAvatars: Snapshot["unreadableAvatars"] = [
    { avatarId: "avatar-broken-0001", name: "Ana", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { avatarId: null, name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
  ];
  const h = await host({ unreadableAvatars, unreadableTotal: 200 });
  expect(h.store.getView().unreadableAvatars).toEqual(unreadableAvatars);
  expect(h.store.getView().unreadableAvatars).toHaveLength(2);
  // L1: the total can exceed the (possibly cut) list's own length.
  expect(h.store.getView().unreadableTotal).toBe(200);
  h.stop();
});

test("a settings.changed that names another library folder refetches the snapshot: the lists belong to the old library", async () => {
  const h = await host({ drafts: [DRAFT] });
  const current = h.store.getView().settings;
  if (current === null) throw new Error("expected settings");
  h.setSnapshot({ avatars: [SAVED], drafts: [], settings: { ...current, libraryPath: "/Users/studio/Other/library" } });

  await h.emit({ type: "settings.changed", payload: { settings: { ...current, libraryPath: "/Users/studio/Other/library" }, librarySwitchGeneration: 1 } });
  await flush();

  expect(h.snapshots()).toBe(2);
  expect(h.store.getView()).toMatchObject({ avatars: [SAVED], drafts: [] });
});

test("a settings.changed with the same library-switch generation refetches nothing, even if the path string happens to differ", async () => {
  const h = await host();
  const current = h.store.getView().settings;
  if (current === null) throw new Error("expected settings");
  await h.emit({ type: "settings.changed", payload: { settings: { ...current, monthlyBudgetMicros: 20_000_000 }, librarySwitchGeneration: 0 } });
  await flush();
  expect(h.snapshots()).toBe(1);
  h.stop();
});

test("a settings.changed whose path string differs but the generation is unchanged (the same folder, another spelling) refetches nothing", async () => {
  const h = await host();
  const current = h.store.getView().settings;
  if (current === null) throw new Error("expected settings");
  // The engine did not consider this a switch (same folder identity, a
  // different spelling reached e.g. through a Windows network share): the
  // generation says so even though the path string differs.
  await h.emit({ type: "settings.changed", payload: { settings: { ...current, libraryPath: `${current.libraryPath}/` }, librarySwitchGeneration: 0 } });
  await flush();
  expect(h.snapshots()).toBe(1);
  h.stop();
});

test("a library folder changed by this window's own command still refetches when the event confirms it", async () => {
  const h = await host({ drafts: [DRAFT] });
  const current = h.store.getView().settings;
  if (current === null) throw new Error("expected settings");
  const moved = { ...current, libraryPath: "/Users/studio/Other/library" };
  h.setSnapshot({ drafts: [], settings: moved });
  // The command's answer lands first and updates the settings, then the event arrives.
  h.store.setSettings(moved);
  await h.emit({ type: "settings.changed", payload: { settings: moved, librarySwitchGeneration: 1 } });
  await flush();

  expect(h.snapshots()).toBe(2);
  expect(h.store.getView().drafts).toEqual([]);
  h.stop();
});

test("the snapshot brings the pending notices, and they are not an engine error", async () => {
  const h = await host({ notices: [RESET] });
  expect(h.store.getView()).toMatchObject({ phase: "ready", notices: [RESET], engineError: null });
  h.stop();
});

// The snapshot's own notices (not just ones added later by engine.notice)
// must go through the same code-dedupe merge.
test("the snapshot's own notices are deduped by code too: the larger count wins", async () => {
  const smaller: EngineNotice = { noticeId: "notice-0003", code: "engine-restarted", at: "2026-09-24T10:00:00.000Z", count: 1 };
  const larger: EngineNotice = { noticeId: "notice-0004", code: "engine-restarted", at: "2026-09-24T10:05:00.000Z", count: 2 };
  const h = await host({ notices: [smaller, larger] });

  expect(h.store.getView().notices).toEqual([larger]);
  h.stop();
});

test("engine.notice adds a notice once, even when the snapshot already had it", async () => {
  const h = await host({ notices: [RESET] });
  await h.emit({ type: "engine.notice", payload: { notice: RESET } });
  await h.emit({ type: "engine.notice", payload: { notice: RESTART } });

  expect(h.store.getView().notices).toEqual([RESET, RESTART]);
  expect(h.store.getView().lastSeq).toBe(2);
  expect(h.snapshots()).toBe(1);
  h.stop();
});

test("settings.changed replaces the settings, the key status included", async () => {
  const h = await host();
  const current = h.store.getView().settings;
  if (current === null) throw new Error("expected settings");
  const next = { ...current, apiKey: { ...current.apiKey, rejected: true }, monthlyBudgetMicros: 25_000_000 };

  await h.emit({ type: "settings.changed", payload: { settings: next, librarySwitchGeneration: 0 } });

  expect(h.store.getView().settings).toEqual(next);
  expect(h.store.getView().lastSeq).toBe(1);
  expect(h.snapshots()).toBe(1);
  h.stop();
});

// A job event is often the FIRST this window ever hears of a job it did not
// start itself (another window's batch or run, say): every job event carries
// the job's kind, avatar and (a run) runId, so the store knows all three from
// that first event and nothing downstream has to guess them.
test("job.progress alone gives a candidates job its kind and avatarId, and no runId", async () => {
  const h = await host();
  await h.emit({ type: "job.progress", payload: { kind: "avatar.candidates", jobId: "job-00000009", avatarId: DRAFT.avatarId, done: 1, total: 4 } });

  expect(h.store.getView().jobs).toEqual([{ jobId: "job-00000009", kind: "avatar.candidates", avatarId: DRAFT.avatarId, runId: null, status: "running", done: 1, total: 4, result: null, error: null }]);
  h.stop();
});

test("job.progress alone gives a run job its kind, runId and avatarId", async () => {
  const h = await host();
  await h.emit({ type: "job.progress", payload: { kind: "run", jobId: "job-00000010", runId: "run-00000010", avatarId: SAVED.avatarId, done: 3, total: 20 } });

  expect(h.store.getView().jobs).toEqual([{ jobId: "job-00000010", kind: "run", avatarId: SAVED.avatarId, runId: "run-00000010", status: "running", done: 3, total: 20, result: null, error: null }]);
  h.stop();
});

// The engine announces a run the moment it launches (done 0), before its writer has answered: a window that did not
// start it sees it running, with its runId, and can cancel it at once.
test("a run's launch announcement (done 0) makes it a running, cancellable job in a window that never started it", async () => {
  const h = await host();
  await h.emit({ type: "job.progress", payload: { kind: "run", jobId: "job-00000013", runId: "run-00000013", avatarId: SAVED.avatarId, done: 0, total: 20 } });

  expect(h.store.getView().jobs).toEqual([{ jobId: "job-00000013", kind: "run", avatarId: SAVED.avatarId, runId: "run-00000013", status: "running", done: 0, total: 20, result: null, error: null }]);
  h.stop();
});

test("job.failed as the first event of a run (it failed before its first progress) still creates the run's job, named and failed", async () => {
  const h = await host();
  await h.emit({ type: "job.failed", payload: { kind: "run", jobId: "job-00000011", runId: "run-00000011", avatarId: SAVED.avatarId, error: { code: "MASTER_FACE_UNUSABLE" } } });

  expect(h.store.getView().jobs).toMatchObject([{ jobId: "job-00000011", kind: "run", runId: "run-00000011", avatarId: SAVED.avatarId, status: "failed", error: { code: "MASTER_FACE_UNUSABLE" } }]);
  h.stop();
});

test("job.cancelled as the first event of a run creates the run's job, named and cancelled", async () => {
  const h = await host();
  await h.emit({ type: "job.cancelled", payload: { kind: "run", jobId: "job-00000012", runId: "run-00000012", avatarId: SAVED.avatarId } });

  expect(h.store.getView().jobs).toMatchObject([{ jobId: "job-00000012", kind: "run", runId: "run-00000012", avatarId: SAVED.avatarId, status: "cancelled" }]);
  h.stop();
});

test("draft.changed adds a draft, then replaces it", async () => {
  const h = await host();
  await h.emit({ type: "draft.changed", payload: { draft: { ...DRAFT, candidates: [] } } });
  expect(h.store.getView().drafts).toEqual([{ ...DRAFT, candidates: [] }]);

  await h.emit({ type: "draft.changed", payload: { draft: DRAFT } });
  expect(h.store.getView().drafts).toEqual([DRAFT]);
  expect(h.store.getView().lastSeq).toBe(2);
  expect(h.snapshots()).toBe(1);
  h.stop();
});

test("avatar.changed adds the saved avatar and drops the draft it came from", async () => {
  const h = await host({ drafts: [DRAFT] });
  await h.emit({ type: "avatar.changed", payload: { avatar: SAVED } });

  expect(h.store.getView().avatars).toEqual([SAVED]);
  expect(h.store.getView().drafts).toEqual([]);
  expect(h.store.getView().lastSeq).toBe(1);
  h.stop();
});

test("avatar.changed replaces an avatar the store already lists", async () => {
  const h = await host({ avatars: [SAVED] });
  await h.emit({ type: "avatar.changed", payload: { avatar: { ...SAVED, status: "archived" } } });

  expect(h.store.getView().avatars).toEqual([{ ...SAVED, status: "archived" }]);
  h.stop();
});

// H1: after avatars.rewriteDescriptor recovers a record, it is listed
// normally and dropped from unreadableAvatars in the same patch — otherwise
// every open window still shows it as unreadable until the next snapshot,
// and a second rewrite attempt on it answers VALIDATION (nothing to fix).
test("avatar.changed drops the avatar from unreadableAvatars: a rewrite recovers it into the list, not into both", async () => {
  const h = await host({ unreadableAvatars: [{ avatarId: SAVED.avatarId, name: "Lena", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" }], unreadableTotal: 1 });
  await h.emit({ type: "avatar.changed", payload: { avatar: SAVED } });

  expect(h.store.getView().avatars).toEqual([SAVED]);
  expect(h.store.getView().unreadableAvatars).toEqual([]);
  // L1: the local patch keeps the total in step with the list it just shrank.
  expect(h.store.getView().unreadableTotal).toBe(0);
  h.stop();
});

test("avatar.changed leaves unreadableTotal alone when the avatar was not the one counted (a stale, cut-off entry)", async () => {
  const h = await host({ unreadableAvatars: [], unreadableTotal: 5 });
  await h.emit({ type: "avatar.changed", payload: { avatar: SAVED } });

  expect(h.store.getView().unreadableTotal).toBe(5);
  h.stop();
});

test("draft.changed drops the draft from unreadableAvatars too", async () => {
  const h = await host({ unreadableAvatars: [{ avatarId: DRAFT.avatarId, name: "Draft", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" }] });
  await h.emit({ type: "draft.changed", payload: { draft: DRAFT } });

  expect(h.store.getView().drafts).toEqual([DRAFT]);
  expect(h.store.getView().unreadableAvatars).toEqual([]);
  h.stop();
});

test("saveAvatar and upsertDraft (local updates after a command answers) drop the entry from unreadableAvatars too", async () => {
  const h = await host({ unreadableAvatars: [{ avatarId: SAVED.avatarId, name: "Lena", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" }] });
  h.store.saveAvatar(SAVED);

  expect(h.store.getView().avatars).toEqual([SAVED]);
  expect(h.store.getView().unreadableAvatars).toEqual([]);
  h.stop();
});

test("job.cancelled cancels a running job", async () => {
  const running = { kind: "avatar.candidates" as const, jobId: "job-00000001", avatarId: DRAFT.avatarId, status: "running" as const, done: 1, total: 4 };
  const h = await host({ drafts: [DRAFT], jobs: [running] });

  await h.emit({ type: "job.cancelled", payload: { kind: "avatar.candidates", jobId: "job-00000001", avatarId: DRAFT.avatarId } });

  expect(h.store.getView().jobs).toMatchObject([{ jobId: "job-00000001", status: "cancelled", done: 1 }]);
  expect(h.store.getView().lastSeq).toBe(1);
  h.stop();
});

test("job.cancelled leaves a job that already finished alone", async () => {
  const result = { kind: "avatar.candidates" as const, avatarId: DRAFT.avatarId, candidates: DRAFT.candidates, rejectedByAgeCheck: 0, failedSlots: [] };
  const done = { kind: "avatar.candidates" as const, jobId: "job-00000001", avatarId: DRAFT.avatarId, status: "done" as const, done: 4, total: 4, result };
  const h = await host({ drafts: [DRAFT], jobs: [done] });

  await h.emit({ type: "job.cancelled", payload: { kind: "avatar.candidates", jobId: "job-00000001", avatarId: DRAFT.avatarId } });

  expect(h.store.getView().jobs).toMatchObject([{ jobId: "job-00000001", status: "done" }]);
  h.stop();
});

// Stage 3 (protocol 5): render jobs and video records.
const RENDER_REF = { kind: "render", jobId: "job-render-0001", videoId: "video-0000001", avatarId: "avatar-draft-0001", montageId: "montage-0000001" } as const;
const RENDER_RESULT = {
  kind: "render",
  videoId: "video-0000001",
  avatarId: "avatar-draft-0001",
  bytes: 3_100_000,
  durationMs: 8_000,
  videoKind: "photo",
  relPath: "Lena/2026-09-29_photo_001.mp4",
} as const;

test("a snapshot that lists a queued render restores it as a render job with no runId", async () => {
  const queued: Snapshot["jobs"][number] = { ...RENDER_REF, status: "queued", done: 0, total: 240 };
  const h = await host({ jobs: [queued] });
  expect(h.store.getView().jobs).toEqual([
    { jobId: "job-render-0001", kind: "render", avatarId: "avatar-draft-0001", runId: null, status: "queued", done: 0, total: 240, result: null, error: null },
  ]);
  h.stop();
});

test("job.progress of a render the window never started creates its view and counts frames", async () => {
  const h = await host();
  await h.emit({ type: "job.progress", payload: { ...RENDER_REF, done: 60, total: 240 } });
  expect(h.store.getView().jobs).toMatchObject([{ jobId: "job-render-0001", kind: "render", avatarId: "avatar-draft-0001", runId: null, status: "running", done: 60, total: 240 }]);
  expect(h.snapshots()).toBe(1);
  h.stop();
});

test("job.done of a render whose progress was never heard reads as complete, not 0 of 0: the frame count comes from the video's length", async () => {
  const h = await host();
  await h.emit({ type: "job.done", payload: { jobId: RENDER_REF.jobId, result: RENDER_RESULT } });
  expect(h.store.getView().jobs).toMatchObject([{ kind: "render", status: "done", done: 240, total: 240, result: RENDER_RESULT }]);
  h.stop();
});

test("job.failed of a render keeps its error, and job.cancelled of another render cancels only that one", async () => {
  const h = await host();
  const other = { ...RENDER_REF, jobId: "job-render-0002", videoId: "video-0000002" };
  await h.emit({ type: "job.progress", payload: { ...RENDER_REF, done: 1, total: 240 } });
  await h.emit({ type: "job.progress", payload: { ...other, done: 1, total: 240 } });
  await h.emit({ type: "job.failed", payload: { ...RENDER_REF, error: { code: "RENDER_FAILED", detail: "ffmpeg exited with code 1" } } });
  await h.emit({ type: "job.cancelled", payload: other });
  expect(h.store.getView().jobs).toMatchObject([
    { jobId: "job-render-0001", status: "failed", error: { code: "RENDER_FAILED" } },
    { jobId: "job-render-0002", status: "cancelled" },
  ]);
  h.stop();
});

test("video.changed moves lastSeq on and changes nothing else: the video lists arrive with the Photos «Видео» tab", async () => {
  const h = await host();
  const before = h.store.getView();
  const video = {
    videoId: "video-0000001",
    avatarId: "avatar-draft-0001",
    kind: "photo",
    durationMs: 8_000,
    bytes: 3_100_000,
    createdAt: "2026-09-29T12:00:00.000Z",
    relPath: "Lena/2026-09-29_photo_001.mp4",
    fileState: "present",
  } as const;
  await h.emit({ type: "video.changed", payload: { change: "upserted", video } });
  await h.emit({ type: "video.changed", payload: { change: "removed", videoId: video.videoId, avatarId: video.avatarId } });
  expect(h.store.getView()).toEqual({ ...before, lastSeq: before.lastSeq + 2 });
  expect(h.snapshots()).toBe(1);
  h.stop();
});
