import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClipBatchSummary, ResponseMessage } from "../shared/engine";
import { IDLE_STEPS } from "./autopilot/steps";
import { BATCHES_DIR, batchSummaryPath, startBatchFile } from "./clips/batchSummary";
import { clipAttemptId, clipJournalPath } from "./clips/journal";
import { journalOf, writeClipRecord } from "./clips/store";
import { batchOf, createBatch, jobsOf, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { clipNetwork, clipsDir, command, create, jobEnd, phasesOf, startClipEngine, until, type ClipEngine, type VideoScript } from "./clips/testing/engineClipKit";
import { readyRecord } from "./clips/testing/recordsRig";
import { SHORT_CLIP_TIMINGS, type ClipTimings } from "./clips/timings";
import { NOW, ledgerLines, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2d: the follow-ups of the whole-part money review of part B1, in the real engine with a fake OpenRouter.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clip-batch-followups-");
const libraryDir = () => join(dir(), "library");
const BUDGET = 10_000_000;
const MIN = 60_000;
/** The short set, with a long give-up time (a slow machine must not turn a recovery into `late`) and holds that outlast the test's reads. */
const TIMINGS: ClipTimings = { ...SHORT_CLIP_TIMINGS, lateGiveUpMs: 10 * MIN, holdTerminalMs: 30_000, holdUncertainMs: 30_000, holdSubmittedMs: 10 * MIN };

async function started(opts: Parameters<typeof startClipEngine>[1] = {}): Promise<ClipEngine> {
  return startClipEngine(dir(), { monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS }, ...opts });
}

describe("L2: a batch does not start while a clip's money is still open", () => {
  test("after an uncertain submit the same process refuses a new batch, free: no job, no POST, no hold, no new ledger line", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { submit: { status: 502 } } : undefined) }) });
    const first = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) }));
    await jobEnd(engine, first.jobIds[0] ?? "");
    await until(() => engine.engine.budget?.ledger.openReserves().length === 1, "the open reserve");
    const jobsBefore = (await jobsOf(engine)).length;
    const linesBefore = ledgerLines(dir()).length;

    // The batch gives the unit back a moment after its member's money closed: wait it out, so the refusal is about the money and not about the unit.
    let answer = await createBatch(engine, { avatarId, photoIds: photoIds.slice(1) });
    for (let i = 0; i < 200 && !answer.ok && answer.error.clipReason === "batch-running"; i++) {
      await Bun.sleep(5);
      answer = await createBatch(engine, { avatarId, photoIds: photoIds.slice(1) });
    }

    expect(answer).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "one-at-a-time" } });
    expect((await jobsOf(engine)).length).toBe(jobsBefore);
    expect(ledgerLines(dir())).toHaveLength(linesBefore);
    expect(engine.net.posts("kling")).toHaveLength(1);
    expect(engine.engine.budget?.status().heldMicros).toBe(0);
  });

  test("a batch is allowed again when no clip reserve is open", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started();
    const one = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) }));
    await jobEnd(engine, one.jobIds[0] ?? "");
    await until(() => engine.engine.budget?.ledger.openReserves().length === 0, "the closed reserve");

    let answer = await createBatch(engine, { avatarId, photoIds: photoIds.slice(1) });
    for (let i = 0; i < 200 && !answer.ok && answer.error.clipReason === "batch-running"; i++) {
      await Bun.sleep(5);
      answer = await createBatch(engine, { avatarId, photoIds: photoIds.slice(1) });
    }
    const two = batchOf(answer);
    await jobEnd(engine, two.jobIds[0] ?? "");
  });
});

/** `clips.list` as the window reads it: the batch's summary. */
async function summaryOf(engine: ClipEngine, avatarId: string, batchId: string): Promise<ClipBatchSummary> {
  const response = await engine.engine.handle(command("clips.list", { avatarId }));
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (!response.ok || response.type !== "clips.list") throw new Error(`expected clips.list, got ${JSON.stringify(response)}`);
  const found = response.result.batches?.find((summary) => summary.batchId === batchId);
  if (found === undefined) throw new Error(`clips.list carries no summary of batch ${batchId}`);
  return found;
}

/** A batch of one member the summary still has queued (the crash took the writes that followed), in a library with one gallery photo. */
async function crashedBatch(clipId: string): Promise<{ avatarId: string; photoId: string; folder: string; batchId: string; at: string }> {
  const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
  const folder = clipsDir(libraryDir(), avatarId);
  await mkdir(join(folder, BATCHES_DIR), { recursive: true });
  const batchId = "batch-00000077";
  const at = new Date(NOW - 2 * MIN).toISOString();
  await writeFile(batchSummaryPath(folder, batchId), JSON.stringify(startBatchFile({ batchId, avatarId, createdAt: at, clipIds: [clipId] })));
  return { avatarId, photoId: photoIds[0] ?? "", folder, batchId, at };
}

/** The engine after the crash, and its batch's summary once the restart's pass has ended the batch. */
async function afterRestart(avatarId: string, batchId: string): Promise<{ engine: ClipEngine; summary: ClipBatchSummary }> {
  const engine = await startClipEngine(dir(), { timings: TIMINGS, monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS } });
  let summary = await summaryOf(engine, avatarId, batchId);
  for (let i = 0; i < 200 && summary.endedAt === undefined; i++) {
    await Bun.sleep(10);
    summary = await summaryOf(engine, avatarId, batchId);
  }
  return { engine, summary };
}

const REQUEST = { model: "kling", quality: "std", seconds: 5, fallback: "auto" } as const;
const MOTION = { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" } as const;

describe("L5: a member is never left `running` by a journal that nothing will recover", () => {
  test("a journal next to a record is stale: the member ends as the record says, not running", async () => {
    const clipId = "clip-00000071";
    const { avatarId, photoId, folder, batchId, at } = await crashedBatch(clipId);
    const journal = journalOf(folder, clipId);
    await journal.requested({ clipId, photoId, request: REQUEST, motion: MOTION, acceptedWorstMicros: 850_000, batch: { batchId, batchIndex: 1, batchSize: 1 }, at });
    await journal.submitted({ attemptId: clipAttemptId(clipId, 1), model: "kling", providerJobId: "job-kling-1", at });
    await writeClipRecord(folder, readyRecord({ id: clipId, avatarId, sourcePhotoId: photoId, batchId, batchIndex: 1, batchSize: 1 }));

    const { engine, summary } = await afterRestart(avatarId, batchId);

    expect(summary.members[0]?.outcome).toBe("ready");
    await engine.engine.shutdown();
  });

  test("a journal with no `requested` line and a reserve in the ledger: the member failed, its money open", async () => {
    const clipId = "clip-00000072";
    const { avatarId, folder, batchId, at } = await crashedBatch(clipId);
    await writeFile(clipJournalPath(folder, clipId), "{not json\n");
    await writeLedger(dir(), [{ type: "reserve", attemptId: clipAttemptId(clipId, 1), jobId: clipId, scope: { avatarJobId: clipId }, model: "kwaivgi/kling-v3.0-std", worstMicros: 504_000, at }]);

    const { engine, summary } = await afterRestart(avatarId, batchId);

    expect(summary.members[0]).toMatchObject({ outcome: "failed", costMicros: 504_000, costKind: "open" });
    await engine.engine.shutdown();
  });

  test("a journal with no `requested` line and nothing in the ledger: the member was dropped, free", async () => {
    const clipId = "clip-00000073";
    const { avatarId, folder, batchId } = await crashedBatch(clipId);
    await writeFile(clipJournalPath(folder, clipId), "");

    const { engine, summary } = await afterRestart(avatarId, batchId);

    expect(summary.members[0]).toMatchObject({ outcome: "dropped", costMicros: 0, costKind: "free" });
    await engine.engine.shutdown();
  });

  test("a journal with a `requested` line and no record is still the recovery's: the member ends as the recovery's record says", async () => {
    const clipId = "clip-00000074";
    const { avatarId, photoId, folder, batchId, at } = await crashedBatch(clipId);
    const journal = journalOf(folder, clipId);
    await journal.requested({ clipId, photoId, request: REQUEST, motion: MOTION, acceptedWorstMicros: 850_000, batch: { batchId, batchIndex: 1, batchSize: 1 }, at });
    await journal.submitted({ attemptId: clipAttemptId(clipId, 1), model: "kling", providerJobId: "job-kling-1", at });
    await writeLedger(dir(), [{ type: "reserve", attemptId: clipAttemptId(clipId, 1), jobId: clipId, scope: { avatarJobId: clipId }, model: "kwaivgi/kling-v3.0-std", worstMicros: 504_000, at }]);

    const engine = await startClipEngine(dir(), { timings: TIMINGS, monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS } });
    await until(() => engine.events().some((e) => e.type === "job.done" && e.payload.result.kind === "clip"), "the recovery's record");

    expect((await summaryOf(engine, avatarId, batchId)).members[0]?.outcome).toBe("ready");
    await engine.engine.shutdown();
  });
});

const firstHeld = (n: number): VideoScript | undefined => (n === 1 ? { held: true } : undefined);

describe("L6: a member's turn never hangs on its photo", () => {
  test("a photo read that never answers ends its member `photo-unreadable`, free, and the batch goes on", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    const library = engine.engine.library;
    if (library === undefined || library === null) throw new Error("no library");
    const read = library.readPhotoVerified.bind(library);
    library.readPhotoVerified = (photoId: string) => (photoId === photoIds[1] ? new Promise<Uint8Array>(() => {}) : read(photoId));
    engine.net.releaseNth("kling", 1);

    const ends = await Promise.all(jobIds.map((id) => jobEnd(engine, id)));

    expect(ends.map((end) => end.type)).toEqual(["job.done", "job.cancelled", "job.done"]);
    expect(ends[1]?.type === "job.cancelled" && ends[1].payload.kind === "clip" ? ends[1].payload.detail : undefined).toBe("photo-unreadable");
    expect(ledgerLines(dir()).some((line) => String(line.attemptId).startsWith(jobIds[1] ?? "-"))).toBe(false);
    expect(engine.net.posts("kling")).toHaveLength(2);
    expect(engine.engine.budget?.status().heldMicros).toBe(0);
  });
});

describe("L3: a lost summary write plus a crash does not under-count the batch", () => {
  test("a 429's retry the summary never listed is recovered and joins its member, its money in the batch's total", async () => {
    const first = "clip-00000081";
    const retry = "clip-00000082";
    const { avatarId, photoId, folder, batchId, at } = await crashedBatch(first);
    // The first clip ended `rate-limited`, free; the write that told the retry was lost to the crash, then the retry's POST left and its reserve stands.
    await writeClipRecord(folder, readyRecord({ id: first, avatarId, sourcePhotoId: photoId, batchId, batchIndex: 1, batchSize: 1, provider: { model: "kling-std", attempts: [] }, outcome: { status: "failed", reason: "rate-limited" } }));
    const journal = journalOf(folder, retry);
    await journal.requested({ clipId: retry, photoId, request: REQUEST, motion: MOTION, acceptedWorstMicros: 850_000, batch: { batchId, batchIndex: 1, batchSize: 1 }, at });
    await journal.submitted({ attemptId: clipAttemptId(retry, 1), model: "kling", providerJobId: "job-kling-1", at });
    await writeLedger(dir(), [{ type: "reserve", attemptId: clipAttemptId(retry, 1), jobId: retry, scope: { avatarJobId: retry }, model: "kwaivgi/kling-v3.0-std", worstMicros: 504_000, at }]);

    const engine = await startClipEngine(dir(), { timings: TIMINGS, monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS } });
    await until(() => engine.events().some((e) => e.type === "job.done" && e.payload.result.kind === "clip"), "the recovery's record");

    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary.members[0]).toMatchObject({ outcome: "ready", clipIds: [first, retry], costMicros: 504_000, costKind: "open" });
    expect(summary.cost).toEqual({ micros: 504_000, kind: "open" });
    await engine.engine.shutdown();
  });
});

describe("L11 (engine side): a lost member that never reserved is free in its record and in the summary", () => {
  test("a crash between the `requested` line and the reserve: the record is `lost` with no attempt, the member's cost is free, and the ledger is untouched", async () => {
    const clipId = "clip-00000091";
    const { avatarId, photoId, folder, batchId, at } = await crashedBatch(clipId);
    await journalOf(folder, clipId).requested({ clipId, photoId, request: REQUEST, motion: MOTION, acceptedWorstMicros: 850_000, batch: { batchId, batchIndex: 1, batchSize: 1 }, at });

    const engine = await startClipEngine(dir(), { timings: TIMINGS, monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS } });
    await until(() => engine.events().some((e) => e.type === "job.done" && e.payload.result.kind === "clip"), "the recovery's record");

    const listed = await engine.engine.handle(command("clips.list", { avatarId }));
    if (!listed.ok || listed.type !== "clips.list") throw new Error(`expected clips.list, got ${JSON.stringify(listed)}`);
    expect(listed.result.clips.find((c) => c.clipId === clipId)).toMatchObject({ status: "failed", failure: { reason: "lost" }, cost: { micros: 0, kind: "free" } });
    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary.members[0]).toMatchObject({ outcome: "failed", costMicros: 0, costKind: "free" });
    expect(summary.cost).toEqual({ micros: 0, kind: "free" });
    expect(ledgerLines(dir())).toEqual([]);
    await engine.engine.shutdown();
  });
});

describe("part C's guard: the whole batch holds the clip money unit, gaps between members included (WB2d)", () => {
  // Part C's `suggestMotions` / `translateIdea` answer `clip-busy` from the same decision `ClipService.unitRefusal` makes for `clips.create` and `clips.createBatch` (its "ONE place"). The service is private to the
  // engine, so the guard is read through the seam that exists: a single clip's create, whose FIRST check is that decision. Any other answer than `batch-running` would be a window for part C's call in a gap.
  test("a single clip is refused `batch-running` at every sample from the batch's start to its last member's render, between members too", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(4));
    const engine = await started({ net: clipNetwork({ klingBy: () => ({ held: true }) }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 3) }));
    const answers: string[] = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const answer = await create(engine, { avatarId, photoId: photoIds[3] ?? "" });
        answers.push(answer.ok ? "ok" : (answer.error.clipReason ?? answer.error.code));
        await Bun.sleep(1);
      }
    })();
    for (const [i, jobId] of jobIds.entries()) {
      await until(() => phasesOf(engine, jobId).includes("rendering"), `member ${i + 1} rendering`);
      if (i < jobIds.length - 1) engine.net.releaseNth("kling", i + 1);
    }
    polling = false;
    await poll;
    engine.net.releaseNth("kling", 3);
    await Promise.all(jobIds.map((id) => jobEnd(engine, id)));

    expect(answers.length).toBeGreaterThan(3);
    expect(new Set(answers)).toEqual(new Set(["batch-running"]));
    expect(engine.net.posts("kling")).toHaveLength(3);
  });
});

describe("L7: a lost library is not a deleted photo", () => {
  test("a library that is no longer the open one at a member's turn stops the batch `cancelled`, free: no member is called `photo-gone`", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    // The volume goes away while member 1 renders: the engine has no open library for the next turn (its getter is what the clip service reads).
    Object.defineProperty(engine.engine, "library", { configurable: true, get: () => null });
    engine.net.releaseNth("kling", 1);

    const ends = await Promise.all(jobIds.map((id) => jobEnd(engine, id)));
    Reflect.deleteProperty(engine.engine, "library");

    expect(ends.map((end) => end.type)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    const details = ends.map((end) => (end.type === "job.cancelled" && end.payload.kind === "clip" ? end.payload.detail : undefined));
    expect(details).toEqual([undefined, "cancelled", "cancelled"]);
    expect(engine.net.posts("kling")).toHaveLength(1);
    expect(engine.engine.budget?.status().heldMicros).toBe(0);
  });
});
