import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClipBatchSummary, ResponseMessage, type EventMessage } from "../shared/engine";
import { BATCHES_DIR, ClipBatchFile, batchSummaryPath, startBatchFile } from "./clips/batchSummary";
import { clipAttemptId } from "./clips/journal";
import { writeClipRecord } from "./clips/store";
import { batchOf, cancelBatch, createBatch, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { clipNetwork, clipsDir, command, jobEnd, listing, phasesOf, startClipEngine, until, type ClipEngine, type VideoScript } from "./clips/testing/engineClipKit";
import { readyRecord } from "./clips/testing/recordsRig";
import { SHORT_CLIP_TIMINGS, type ClipTimings } from "./clips/timings";
import { IDLE_STEPS } from "./autopilot/steps";
import { NOW, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2c (plan s5b2 §5.2, I5.62, I5.63; the UI review's money MEDIUM): the batch's summary as the ENGINE writes it, so the «Клипы» header never says a money sentence about a batch that its records
// cannot back. Before this, a batch clip the owner deleted read, after a restart, as a member that was dropped unshot («не снимался 1 … бесплатно»), and the batch's total lost its cost. The engine now writes
// `clips/batches/<batchId>.json` at every member transition and `clips.list` carries it; a delete never touches it, and the money of each member is the ledger's for its clip ids.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clip-batch-summary-");
const libraryDir = () => join(dir(), "library");
const BUDGET = 10_000_000;
const MIN = 60_000;
const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";
/** The short set, with a long give-up time (a slow machine must not turn a recovery into `late`) and holds that outlast the test's reads. */
const TIMINGS: ClipTimings = { ...SHORT_CLIP_TIMINGS, lateGiveUpMs: 10 * MIN, holdTerminalMs: 30_000, holdUncertainMs: 30_000, holdSubmittedMs: 10 * MIN };

async function started(opts: Parameters<typeof startClipEngine>[1] = {}): Promise<ClipEngine> {
  return startClipEngine(dir(), { monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS }, ...opts });
}

async function endsOf(engine: ClipEngine, jobIds: readonly string[]): Promise<EventMessage[]> {
  const ends: EventMessage[] = [];
  for (const id of jobIds) ends.push(await jobEnd(engine, id));
  return ends;
}

/** `clips.list` as the window reads it, checked against the contract. */
async function listOf(engine: ClipEngine, avatarId: string): Promise<{ clips: { clipId: string }[]; batches?: ClipBatchSummary[] }> {
  const response = await engine.engine.handle(command("clips.list", { avatarId }));
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (!response.ok || response.type !== "clips.list") throw new Error(`expected clips.list, got ${JSON.stringify(response)}`);
  return response.result;
}

/** The one batch summary `clips.list` carries for this batch. */
async function summaryOf(engine: ClipEngine, avatarId: string, batchId: string): Promise<ClipBatchSummary> {
  const found = (await listOf(engine, avatarId)).batches?.find((summary) => summary.batchId === batchId);
  if (found === undefined) throw new Error(`clips.list carries no summary of batch ${batchId}`);
  return found;
}

const shape = (summary: ClipBatchSummary): [number, string, number, string, number][] => summary.members.map((m) => [m.batchIndex, m.outcome, m.costMicros, m.costKind, m.clipIds.length]);

describe("the engine writes a batch's summary, and clips.list carries it", () => {
  test("a clean batch: every member made at its bill, the batch's one total, its end, and the file on disk", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started();
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary).toMatchObject({ batchId, avatarId, size: 3, cost: { micros: 1_260_000, kind: "billed" } });
    expect(summary.members).toEqual(jobIds.map((clipId, i) => ({ batchIndex: i + 1, outcome: "ready", costMicros: 420_000, costKind: "billed", clipIds: [clipId] })));
    expect(summary.endedAt).toBeDefined();
    expect(summary.stop).toBeUndefined();
    const onDisk = ClipBatchFile.parse(JSON.parse(await readFile(batchSummaryPath(clipsDir(libraryDir(), avatarId), batchId), "utf8")));
    expect(onDisk).toMatchObject({ schemaVersion: 1, batchId, size: 3 });
    expect(onDisk.members.map((m) => m.outcome)).toEqual(["ready", "ready", "ready"]);
  });

  test("while the batch runs, the members still waiting are queued in it and the queue has no end", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { held: true } : undefined) }) });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary.members.map((m) => m.outcome)).toEqual(["running", "queued", "queued"]);
    expect(summary.members[0]).toMatchObject({ costMicros: 504_000, costKind: "open" });
    expect(summary.cost).toEqual({ micros: 504_000, kind: "open" });
    expect(summary.endedAt).toBeUndefined();
    engine.net.releaseNth("kling", 1);
    await endsOf(engine, jobIds);
  });

  test("an avatar that made no batch has no `batches` in its list", async () => {
    const { avatarId } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const engine = await started();
    expect(await listOf(engine, avatarId)).toEqual({ clips: [] });
  });
});

describe("a batch clip the owner deletes (the UI review's money MEDIUM)", () => {
  test("stays made in the summary, with its cost in the batch's total", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started();
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);
    const before = await summaryOf(engine, avatarId, batchId);

    expect((await engine.engine.handle(command("clips.delete", { avatarId, clipId: jobIds[1] }))).ok).toBe(true);
    const listed = await listOf(engine, avatarId);
    expect(listed.clips.map((clip) => clip.clipId)).not.toContain(jobIds[1]);
    expect(listed.batches?.find((summary) => summary.batchId === batchId)).toEqual(before);
    expect(before.members[1]).toMatchObject({ outcome: "ready", costMicros: 420_000, costKind: "billed" });
    expect(before.cost).toEqual({ micros: 1_260_000, kind: "billed" });
  });

  test("and a restart leaves it so: no member reads as dropped, and the total keeps the deleted clip's cost", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const first = await started();
    const { batchId, jobIds } = batchOf(await createBatch(first, { avatarId, photoIds }));
    await endsOf(first, jobIds);
    expect((await first.engine.handle(command("clips.delete", { avatarId, clipId: jobIds[1] }))).ok).toBe(true);
    const before = await summaryOf(first, avatarId, batchId);
    await first.engine.shutdown();

    const second = await started();
    const after = await summaryOf(second, avatarId, batchId);
    expect(after).toEqual(before);
    expect(after.members.some((m) => m.outcome === "dropped")).toBe(false);
    expect(after.cost).toEqual({ micros: 1_260_000, kind: "billed" });
    await second.engine.shutdown();
  });
});

describe("each end of a member, as the summary tells it", () => {
  test("a member refused for free and made on Grok is made, at Grok's bill; a «Смелая» member refused is refused, free", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), [{}, { category: "nightwear" }]);
    const refused: VideoScript = { terminal: { status: "failed", error: RISK_CONTROL } };
    const engine = await started({ net: clipNetwork({ klingBy: () => refused }) });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds, acceptedWorstMicros: 850_000 + 504_000 }));
    await endsOf(engine, jobIds);

    const summary = await summaryOf(engine, avatarId, batchId);
    expect(shape(summary)).toEqual([
      [1, "ready", 420_000, "billed", 1],
      [2, "refused", 0, "free", 1],
    ]);
    expect(summary.cost).toEqual({ micros: 420_000, kind: "billed" });
  });

  test("a 429 at a member's submit: the member names both its clips, and its money is the second's bill (the first was free)", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const rateLimited: VideoScript = { submit: { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } } };
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 2 ? rateLimited : undefined) }), timings: { ...SHORT_CLIP_TIMINGS, rateLimitPauseMs: 50 } });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);
    await until(() => engine.net.posts("kling").length === 3, "the retry's POST");
    const retry = engine.events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.batchIndex === 2 && !jobIds.includes(e.payload.jobId) ? [e.payload.jobId] : []))[0] ?? "";
    await jobEnd(engine, retry);

    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary.members[1]).toEqual({ batchIndex: 2, outcome: "ready", costMicros: 420_000, costKind: "billed", clipIds: [jobIds[1], retry] });
    expect(summary.cost).toEqual({ micros: 840_000, kind: "billed" });
  });

  test("a price stop: the members it cancelled say why, free, and the batch tells the stop", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const state = { perSecond: "0.084" };
    const net = clipNetwork({
      klingBy: (n) => (n === 1 ? { held: true } : undefined),
      listing: () => listing({ std: { image_to_video_duration_seconds_720p: state.perSecond, image_to_video_duration_seconds_1080p: state.perSecond } }),
    });
    const engine = await started({ net });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    state.perSecond = "0.2";
    engine.clocks.skew(11 * MIN);
    engine.net.releaseNth("kling", 1);
    await endsOf(engine, jobIds);

    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary.stop).toBe("price-changed");
    expect(summary.members.map((m) => [m.outcome, m.detail, m.costKind])).toEqual([
      ["ready", undefined, "billed"],
      ["cancelled", "price-changed", "free"],
      ["cancelled", "price-changed", "free"],
    ]);
    expect(summary.endedAt).toBeDefined();
  });

  test("the owner's cancel is the batch's stop `cancelled`; one queued member cancelled alone stops nothing", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(4));
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { held: true } : undefined) }) });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect((await engine.engine.handle(command("avatars.cancel", { jobId: jobIds[1] }))).ok).toBe(true);
    expect((await summaryOf(engine, avatarId, batchId)).stop).toBeUndefined();
    expect(await cancelBatch(engine, avatarId, batchId)).toMatchObject({ ok: true, result: { cancelled: 2 } });
    engine.net.releaseNth("kling", 1);
    await endsOf(engine, jobIds);

    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary.stop).toBe("cancelled");
    expect(summary.members.map((m) => [m.outcome, m.detail])).toEqual([
      ["ready", undefined],
      ["cancelled", "cancelled"],
      ["cancelled", "cancelled"],
      ["cancelled", "cancelled"],
    ]);
  });

  test("an uncertain submit: the member failed with its reserve open at worst, the queue stopped money-uncertain, the total open", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { submit: { status: 502 } } : undefined) }) });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary.stop).toBe("money-uncertain");
    expect(shape(summary)).toEqual([
      [1, "failed", 504_000, "open", 1],
      [2, "cancelled", 0, "free", 1],
      [3, "cancelled", 0, "free", 1],
    ]);
    expect(summary.cost).toEqual({ micros: 504_000, kind: "open" });
  });
});

describe("a restart ends the batch it finds running (I5.63)", () => {
  test("the queued members are dropped, free; the member that was sent stays at work until its recovery records it, then is made with its money still open (the reconcile's)", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const first = await startClipEngine(dir(), { net: clipNetwork({ klingBy: (k) => (k === 1 ? { held: true } : undefined) }), timings: TIMINGS, monthlyBudgetMicros: BUDGET });
    const { batchId, jobIds } = batchOf(await createBatch(first, { avatarId, photoIds }));
    await until(() => phasesOf(first, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    await first.engine.shutdown();
    for (const id of jobIds) await jobEnd(first, id);

    const second = await startClipEngine(dir(), { timings: TIMINGS, monthlyBudgetMicros: BUDGET });
    await until(() => second.events().some((e) => e.type === "job.done" && e.payload.result.kind === "clip"), "the recovery's record");

    const summary = await summaryOf(second, avatarId, batchId);
    expect(shape(summary)).toEqual([
      [1, "ready", 504_000, "open", 1],
      [2, "dropped", 0, "free", 1],
      [3, "dropped", 0, "free", 1],
    ]);
    expect(summary.endedAt).toBeDefined();
    expect(summary.cost).toEqual({ micros: 504_000, kind: "open" });
    await second.engine.shutdown();
  });

  test("a member the summary had at work whose record stands ends as its record says; one with only a reserve failed; one with nothing was dropped", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const folder = clipsDir(libraryDir(), avatarId);
    await mkdir(join(folder, BATCHES_DIR), { recursive: true });
    const batchId = "batch-00000077";
    const clipIds = ["clip-00000071", "clip-00000072", "clip-00000073"];
    const file = startBatchFile({ batchId, avatarId, createdAt: new Date(NOW - 10 * MIN).toISOString(), clipIds });
    await writeFile(batchSummaryPath(folder, batchId), JSON.stringify({ ...file, members: file.members.map((m) => ({ ...m, outcome: "running" })) }));
    await writeClipRecord(folder, readyRecord({ id: "clip-00000071", avatarId, sourcePhotoId: photoIds[0] ?? "", batchId, batchIndex: 1, batchSize: 3 }));
    await writeLedger(dir(), [
      { type: "reserve", attemptId: clipAttemptId("clip-00000071", 1), jobId: "clip-00000071", scope: { avatarJobId: "clip-00000071" }, model: "kwaivgi/kling-v3.0-std", worstMicros: 504_000, at: new Date(NOW - 9 * MIN).toISOString() },
      { type: "settle", attemptId: clipAttemptId("clip-00000071", 1), costMicros: 420_000, estimated: false, at: new Date(NOW - 8 * MIN).toISOString() },
      { type: "reserve", attemptId: clipAttemptId("clip-00000072", 1), jobId: "clip-00000072", scope: { avatarJobId: "clip-00000072" }, model: "kwaivgi/kling-v3.0-std", worstMicros: 504_000, at: new Date(NOW - 7 * MIN).toISOString() },
    ]);

    const engine = await started();
    const summary = await summaryOf(engine, avatarId, batchId);
    expect(shape(summary)).toEqual([
      [1, "ready", 420_000, "billed", 1],
      [2, "failed", 504_000, "open", 1],
      [3, "dropped", 0, "free", 1],
    ]);
    expect(summary.endedAt).toBeDefined();
    await engine.engine.shutdown();
  });
});

describe("round 2 (the money review)", () => {
  test("a summary write that fails loses no transition: the 429's requeue is kept, and the member's clip and money come through", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const rateLimited: VideoScript = { submit: { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } } };
    let failed = 0;
    const engine = await started({
      net: clipNetwork({ klingBy: (n) => (n === 2 ? rateLimited : undefined) }),
      timings: { ...SHORT_CLIP_TIMINGS, rateLimitPauseMs: 50 },
      deps: {
        launchSteps: IDLE_STEPS,
        // The write that would first tell the member's second clip fails (a full disk for a moment).
        clipBatchSummaryBeforeWrite: (file) => {
          if (failed === 0 && file.members.some((member) => member.clipIds.length === 2)) {
            failed++;
            throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
          }
        },
      },
    });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);
    await until(() => engine.net.posts("kling").length === 3, "the retry's POST");
    const retry = engine.events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.batchIndex === 2 && !jobIds.includes(e.payload.jobId) ? [e.payload.jobId] : []))[0] ?? "";
    await jobEnd(engine, retry);

    expect(failed).toBe(1);
    const summary = await summaryOf(engine, avatarId, batchId);
    expect(summary.members[1]).toEqual({ batchIndex: 2, outcome: "ready", costMicros: 420_000, costKind: "billed", clipIds: [jobIds[1], retry] });
    expect(summary.cost).toEqual({ micros: 840_000, kind: "billed" });
    const onDisk = ClipBatchFile.parse(JSON.parse(await readFile(batchSummaryPath(clipsDir(libraryDir(), avatarId), batchId), "utf8")));
    expect(onDisk.members[1]).toMatchObject({ outcome: "ready", clipIds: [jobIds[1], retry], costMicros: 420_000, costKind: "billed" });
  });
});

describe("a failed download fetched again", () => {
  test("turns its member from failed to made", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const folder = clipsDir(libraryDir(), avatarId);
    await mkdir(join(folder, BATCHES_DIR), { recursive: true });
    const batchId = "batch-00000088";
    const clipId = "clip-00000081";
    const file = startBatchFile({ batchId, avatarId, createdAt: new Date(NOW - 10 * MIN).toISOString(), clipIds: [clipId] });
    await writeFile(batchSummaryPath(folder, batchId), JSON.stringify({ ...file, endedAt: new Date(NOW - 5 * MIN).toISOString(), members: file.members.map((m) => ({ ...m, outcome: "failed" })) }));
    await writeClipRecord(
      folder,
      readyRecord({
        id: clipId,
        avatarId,
        sourcePhotoId: photoIds[0] ?? "",
        batchId,
        batchIndex: 1,
        batchSize: 1,
        provider: { model: "kling-std", attempts: [{ attemptId: clipAttemptId(clipId, 1), providerJobId: "job-kling-1", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }] },
        outcome: { status: "failed", reason: "download-failed", retryDownloadUntil: new Date(NOW + 30 * MIN).toISOString() },
      }),
    );
    const engine = await started();
    expect((await summaryOf(engine, avatarId, batchId)).members[0]?.outcome).toBe("failed");

    const retried = await engine.engine.handle(command("clips.retryDownload", { avatarId, clipId }));
    if (!retried.ok || retried.type !== "clips.retryDownload") throw new Error(`expected a retry, got ${JSON.stringify(retried)}`);
    await jobEnd(engine, retried.result.jobId);
    expect((await summaryOf(engine, avatarId, batchId)).members[0]?.outcome).toBe("ready");
    await engine.engine.shutdown();
  });
});

describe("an avatar keeps its newest 20 batch summaries", () => {
  test("a new batch forgets the oldest ones past 20 whose queue ended and whose money is closed", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const folder = clipsDir(libraryDir(), avatarId);
    await mkdir(join(folder, BATCHES_DIR), { recursive: true });
    const old = Array.from({ length: 21 }, (_, i) => `batch-${String(i + 1).padStart(8, "0")}`);
    for (const [i, batchId] of old.entries()) {
      const file = startBatchFile({ batchId, avatarId, createdAt: new Date(NOW - (60 - i) * MIN).toISOString(), clipIds: [`clip-${String(i + 1).padStart(8, "0")}`] });
      await writeFile(batchSummaryPath(folder, batchId), JSON.stringify({ ...file, endedAt: file.createdAt, members: file.members.map((m) => ({ ...m, outcome: "dropped" })) }));
    }
    const engine = await started();
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    const kept = (await listOf(engine, avatarId)).batches?.map((summary) => summary.batchId) ?? [];
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe(batchId);
    expect(kept).not.toContain(old[0]);
    expect(kept).not.toContain(old[1]);
    expect((await readdir(join(folder, BATCHES_DIR))).sort()).toEqual([...old.slice(2), batchId].map((id) => `${id}.json`).sort());
    expect(existsSync(batchSummaryPath(folder, old[0] ?? ""))).toBe(false);
  });
});
