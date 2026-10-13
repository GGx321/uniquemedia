import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { JobRegistry } from "../jobs";
import type { Library } from "../library";
import { Budget } from "../money/budget";
import { Ledger } from "../money/ledger";
import { CommitTracker } from "../videos/live";
import { ClipService, type ClipServiceDeps } from "./service";
import { SHORT_CLIP_TIMINGS } from "./timings";
import { clipAttemptId } from "./journal";
import { ensureClipsDir, readClipRecord, writeClipRecord } from "./store";
import { useClipFixtures } from "./testing/clipFixtures";
import { AVATAR, CLIP, NOW, failedRecord, readyRecord, reserve, settle } from "./testing/recordsRig";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a2: the records are registered on the clip service, which gives them its neighbours: the library's clips folder, the budget's ledger, the export folder, the busy set that a
// delete and a library switch look at, and the face check. The engine's dispatch of these commands is S5.V4a1's file; here the service is driven directly.

const clip = useClipFixtures();
const UNTIL = new Date(NOW + 30 * 60_000).toISOString();
let dir = "";

afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = "";
});

interface World {
  service: ClipService;
  clipsDir: string;
  jobs: JobRegistry;
  events: string[];
  state: { photo: boolean; export: Awaited<ReturnType<ClipServiceDeps["exportStatus"]>> };
}

async function world(options: { download?: () => Promise<void> } = {}): Promise<World> {
  dir = await mkdtemp(join(tmpdir(), "studio-clip-service-"));
  const clipsDir = join(dir, "avatars", AVATAR, "clips");
  await ensureClipsDir(clipsDir);
  const ledgerPath = join(dir, "ledger.jsonl");
  const lines = [reserve(clipAttemptId(CLIP, 1), CLIP, 504_000), settle(clipAttemptId(CLIP, 1), 420_000, false)];
  await writeFile(ledgerPath, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const budget = new Budget(await Ledger.open(ledgerPath), { runCapMicros: () => 50_000_000, monthlyBudgetMicros: 50_000_000, clock: () => NOW, monotonic: () => NOW });
  const source = await clip({ width: 720, height: 1280, seconds: 5 });
  const jobs = new JobRegistry();
  const events: string[] = [];
  const state: World["state"] = { photo: false, export: { ok: false, reason: "not-writable" } };
  const library = {
    getAvatar: (id: string) => (id === AVATAR ? { id, status: "active" } : undefined),
    avatarDirPath: (id: string) => join(dir, "avatars", id),
    getPhoto: () => undefined,
  };
  const fail = (what: string) => () => Promise.reject(new Error(`${what} is not used by the records`));
  const deps: ClipServiceDeps = {
    newId: (() => {
      let n = 0;
      return () => `job-${String(++n).padStart(8, "0")}`;
    })(),
    clock: () => NOW,
    currentLibrary: () => library as unknown as Library,
    liveLibrary: fail("liveLibrary"),
    usableKey: () => "sk-test",
    paidBudget: () => budget,
    budget: () => budget,
    prices: fail("prices"),
    checkAccepted: () => undefined,
    checkMonthlyRoom: () => undefined,
    monthFits: () => true,
    paidStart: () => undefined,
    paidEnd: () => undefined,
    setCap: () => undefined,
    clearCap: () => undefined,
    openRouter: () => ({
      downloadVideo: async (_id: string, toPath: string) => {
        await options.download?.();
        await copyFile(source, toPath);
        return { kind: "saved", bytes: (await readFile(source)).byteLength };
      },
    }) as unknown as ReturnType<ClipServiceDeps["openRouter"]>,
    jobs,
    emit: (event) => void events.push(event.type),
    emitMoney: () => undefined,
    markKeyRejected: () => undefined,
    pendingDelete: () => false,
    assertAvatarOnDisk: fail("assertAvatarOnDisk"),
    readRunPlan: fail("readRunPlan"),
    faceGate: () => null,
    timings: SHORT_CLIP_TIMINGS,
    log: () => undefined,
    exportStatus: async () => state.export,
    liveCommits: new CommitTracker(),
    withRootLock: (_root, work) => work(),
    exportNumbers: () => null,
  };
  const service = new ClipService(deps);
  return { service, clipsDir, jobs, events, state };
}

describe("the clip records on the clip service", () => {
  test("lists a clip with the cost the budget's ledger holds", async () => {
    const w = await world();
    await writeClipRecord(w.clipsDir, readyRecord());
    const { clips } = await w.service.list({ avatarId: AVATAR });
    expect(clips.map((c) => [c.clipId, c.cost])).toEqual([[CLIP, { micros: 420_000, kind: "billed" }]]);
  });

  test("marks a clip seen and reads it back", async () => {
    const w = await world();
    await writeClipRecord(w.clipsDir, readyRecord());
    await w.service.markSeen({ avatarId: AVATAR, clipId: CLIP });
    expect((await w.service.get({ avatarId: AVATAR, clipId: CLIP })).clip.seen).toBe(true);
  });

  test("deletes a clip", async () => {
    const w = await world();
    await writeClipRecord(w.clipsDir, readyRecord());
    await w.service.delete({ avatarId: AVATAR, clipId: CLIP });
    expect((await w.service.list({ avatarId: AVATAR })).clips).toEqual([]);
  });

  test("says elsewhere for an export when the export folder is unusable, and unchecked when it did not answer", async () => {
    const w = await world();
    const line = { rootId: "root-0000001", relPath: "Nini/2026-10-13_clip_001.mp4", profile: "1080p30-interp" as const, at: "2026-10-13T11:00:00.000Z", bytes: 2_000, sha256: "b".repeat(64) };
    await writeClipRecord(w.clipsDir, readyRecord({ exports: [line] }));
    expect((await w.service.get({ avatarId: AVATAR, clipId: CLIP })).clip.exports.map((e) => e.fileState)).toEqual(["elsewhere"]);
    w.state.export = { ok: false, reason: "not-writable", unanswered: true };
    expect((await w.service.get({ avatarId: AVATAR, clipId: CLIP })).clip.exports.map((e) => e.fileState)).toEqual(["unchecked"]);
  });

  test("counts a retry as clip work, refuses a delete while it runs, and gives the clip back when it ends", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = await world({ download: () => gate });
    await writeClipRecord(w.clipsDir, failedRecord("download-failed", UNTIL));
    const { jobId } = await w.service.retryDownload({ avatarId: AVATAR, clipId: CLIP });
    expect([w.service.busy(), w.service.isClipBusy(CLIP)]).toEqual([true, true]);
    await expect(w.service.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject({ error: { code: "IN_FLIGHT", clipReason: "job-running" } });
    release();
    for (let waited = 0; w.jobs.stateOf(jobId)?.status === "running" && waited < 20_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    expect([w.service.busy(), w.service.isClipBusy(CLIP)]).toEqual([false, false]);
    expect(w.events.at(-1)).toBe("job.done");
    const read = await readClipRecord(w.clipsDir, CLIP);
    expect(read.kind === "record" ? read.record.outcome.status : read.kind).toBe("ready");
  });

  test("keeps the clip, unchecked, when its source photo is gone (the face cannot be judged)", async () => {
    const w = await world();
    await writeClipRecord(w.clipsDir, failedRecord("download-failed", UNTIL));
    const { jobId } = await w.service.retryDownload({ avatarId: AVATAR, clipId: CLIP });
    for (let waited = 0; w.jobs.stateOf(jobId)?.status === "running" && waited < 20_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    const read = await readClipRecord(w.clipsDir, CLIP);
    const outcome = read.kind === "record" ? read.record.outcome : null;
    expect(outcome?.status === "ready" ? outcome.face : null).toEqual({ verdict: "skipped", frames: 0, why: "worker" });
  });

  test("stops a running retry when the service shuts down, leaving the record as it was", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = await world({ download: () => gate });
    const before = failedRecord("download-failed", UNTIL);
    await writeClipRecord(w.clipsDir, before);
    const { jobId } = await w.service.retryDownload({ avatarId: AVATAR, clipId: CLIP });
    w.service.shutdown();
    release();
    for (let waited = 0; w.jobs.stateOf(jobId)?.status === "running" && waited < 20_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(w.jobs.stateOf(jobId)?.status).toBe("cancelled");
    const read = await readClipRecord(w.clipsDir, CLIP);
    expect(read.kind === "record" ? read.record : null).toEqual(before);
  });
});
