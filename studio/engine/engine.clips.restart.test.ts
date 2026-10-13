import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MoneyStatus, ReconcileResult } from "../shared/engine";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { clipAttemptId } from "./clips/journal";
import { SHORT_CLIP_TIMINGS, type ClipTimings } from "./clips/timings";
import type { ClipRecord } from "./clips/schemas";
import { clipNetwork, clipsDir, command, create, jobEnd, jobIdOf, phasesOf, seedClipAvatar, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { journalOf, readClipRecord } from "./clips/store";
import { engineInit, engineSettings, ledgerLines, NOW, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V6 (plan s5b1 §5.12, I5.48, I5.49): a quit with a clip in flight, then a new engine on the same folders (the C4 pattern). Recovery is free and never writes the ledger; the
// earlier process's reserve waits for the owner's reconcile, which answers TOO_SOON while the clip may still bill and then closes the reserve at worst. A library switch recovers too.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clips-restart-");
const libraryDir = () => join(dir(), "library");
const ledgerPath = () => join(dir(), "userData", "ledger.jsonl");
const MIN = 60_000;
/** The short set, but with a long give-up time (a slow machine must not turn a recovery into `late`) and a terminal hold that outlasts the test's reads. */
const TIMINGS: ClipTimings = { ...SHORT_CLIP_TIMINGS, lateGiveUpMs: 10 * MIN, holdTerminalMs: 30_000, holdUncertainMs: 30_000, holdSubmittedMs: 10 * MIN };

async function moneyStatus(engine: ClipEngine): Promise<Extract<MoneyStatus, { ledger: "open" }>> {
  const answer = await engine.engine.handle(command("money.status"));
  if (!answer.ok || answer.type !== "money.status" || answer.result.ledger !== "open") throw new Error(`no open money status: ${JSON.stringify(answer)}`);
  return answer.result;
}

async function reconcile(engine: ClipEngine): Promise<{ ok: true; result: ReconcileResult } | { ok: false; code: string }> {
  const answer = await engine.engine.handle(command("money.reconcile"));
  if (!answer.ok) return { ok: false, code: answer.error.code };
  if (answer.type !== "money.reconcile") throw new Error("wrong answer");
  return { ok: true, result: answer.result };
}

/** The end of a clip job whose id is not known to the test (a recovery job is the engine's own). */
async function clipJobDone(engine: ClipEngine): Promise<void> {
  await until(() => engine.events().some((e) => e.type === "job.done" && e.payload.result.kind === "clip"), "a clip job's end");
}

async function recordOf(avatarId: string, clipId: string): Promise<ClipRecord> {
  const read = await readClipRecord(clipsDir(libraryDir(), avatarId), clipId);
  if (read.kind !== "record") throw new Error(`expected a record, got ${read.kind}`);
  return read.record;
}

/** A clip in `rendering` when the process stops: its reserve and journal are on disk, its job is gone. */
async function quitMidClip(): Promise<{ avatarId: string; photoId: string; clipId: string }> {
  const { avatarId, photoId } = await seedClipAvatar(libraryDir());
  const first = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }), timings: TIMINGS });
  const clipId = jobIdOf(await create(first, { avatarId, photoId }));
  await until(() => phasesOf(first, clipId).includes("rendering"), "rendering");
  await first.engine.shutdown();
  await jobEnd(first, clipId);
  return { avatarId, photoId, clipId };
}

describe("a quit while a clip renders, then a new engine on the same folders", () => {
  test("recovers the clip for free: a ready, recovered record, and not one more ledger line", async () => {
    const { avatarId, clipId } = await quitMidClip();
    const before = await readFile(ledgerPath(), "utf8");
    expect(ledgerLines(dir()).map((l) => l.type)).toEqual(["reserve"]);

    const second = await startClipEngine(dir(), { timings: TIMINGS });
    await clipJobDone(second);

    expect(await recordOf(avatarId, clipId)).toMatchObject({ recovered: true, outcome: { status: "ready" }, provider: { attempts: [{ providerCostMicros: 420_000, costSource: "none" }] } });
    expect(await readFile(ledgerPath(), "utf8")).toBe(before);
    expect(existsSync(join(clipsDir(libraryDir(), avatarId), `${clipId}.journal.jsonl`))).toBe(false);
    expect(second.net.posts()).toHaveLength(0);
  });

  test("announces the recovery as a `clip` job in the phase `recovering`", async () => {
    const { clipId } = await quitMidClip();
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    await clipJobDone(second);
    const progress = second.events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" ? [e.payload] : []));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ kind: "clip", clipId, phase: "recovering" });
  });

  test("refuses paid commands with RECONCILE_REQUIRED until the owner reconciles", async () => {
    const { avatarId, photoId } = await quitMidClip();
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    await clipJobDone(second);
    const refused = await create(second, { avatarId, photoId });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("RECONCILE_REQUIRED");
  });

  test("keeps the reconcile TOO_SOON until the terminal status is 2 min old, then closes the reserve at worst", async () => {
    const { clipId } = await quitMidClip();
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    await clipJobDone(second);

    const held = await reconcile(second);
    expect(held).toMatchObject({ ok: true, result: { status: "too-early" } });
    if (!held.ok || held.result.status !== "too-early") throw new Error("unreachable");
    expect(held.result.retryAfterMs).toBeGreaterThan(0);
    expect(held.result.retryAfterMs).toBeLessThanOrEqual(TIMINGS.holdTerminalMs);

    second.clocks.skew(10 * MIN);
    expect(await reconcile(second)).toMatchObject({ ok: true, result: { status: "done", closedReserves: 1 } });
    const lines = ledgerLines(dir());
    expect(lines.map((l) => l.type)).toEqual(["reserve", "settle", "reconcile"]);
    expect(lines[1]).toMatchObject({ attemptId: clipAttemptId(clipId, 1), costMicros: 504_000, estimated: true });
  });

  test("money.status names the open reserve as a reason, and says when the reconcile can run", async () => {
    await quitMidClip();
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    await clipJobDone(second);
    const status = await moneyStatus(second);
    expect(status).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"], unsettledMicros: 504_000, unsettledCount: 1 });
    // The engine's clock starts at NOW; the quiet wait after a restart is about 5 min, so the time is ahead of it.
    expect(Date.parse(String(status.reconcileAvailableAt))).toBeGreaterThan(NOW);
  });

  test("sweeps the temp files a crash left in the clips folder", async () => {
    const { avatarId } = await quitMidClip();
    const folder = clipsDir(libraryDir(), avatarId);
    await writeFile(join(folder, ".0a1b2c3d4e5f.in.tmp"), "x");
    await mkdir(join(folder, ".frames-0a1b2c3d4e5f.tmp"));
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    await clipJobDone(second);
    expect((await readdir(folder)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("a journal and a reserve of an earlier process, with nothing else", () => {
  async function crashedBeforeSubmit(reserveAt: number): Promise<{ avatarId: string; clipId: string }> {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const clipId = "clip-00000042";
    const folder = clipsDir(libraryDir(), avatarId);
    await mkdir(folder, { recursive: true });
    await journalOf(folder, clipId).requested({
      clipId,
      photoId,
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
      acceptedWorstMicros: 850_000,
      at: new Date(reserveAt).toISOString(),
    });
    await writeLedger(dir(), [{ type: "reserve", attemptId: clipAttemptId(clipId, 1), jobId: clipId, scope: { avatarJobId: clipId }, model: "kwaivgi/kling-video-o1", worstMicros: 504_000, at: new Date(reserveAt).toISOString() }]);
    return { avatarId, clipId };
  }

  test("records the clip `lost`, holds its reserve 20 min from the reserve line, and says so", async () => {
    const reserveAt = NOW;
    const { avatarId, clipId } = await crashedBeforeSubmit(reserveAt);
    // A hold longer than the quiet wait, so the hold is what money.status names.
    const holdUncertainMs = 30 * MIN;
    const second = await startClipEngine(dir(), { timings: { ...TIMINGS, holdUncertainMs } });
    await clipJobDone(second);
    expect((await recordOf(avatarId, clipId)).outcome).toEqual({ status: "failed", reason: "lost" });
    const status = await moneyStatus(second);
    expect(status.reconcileAvailableAt).toBe(new Date(reserveAt + holdUncertainMs).toISOString());
    expect(second.net.calls.filter((c) => c.url.includes("/videos"))).toHaveLength(0);
    await second.engine.shutdown();
  });
});

describe("the holds of a restart that read the ledger alone", () => {
  const CLIP_ID = "clip-00000045";
  const openReserve = () => ({ type: "reserve" as const, attemptId: clipAttemptId(CLIP_ID, 1), jobId: CLIP_ID, scope: { avatarJobId: CLIP_ID }, model: "kwaivgi/kling-video-o1", worstMicros: 504_000, at: new Date(NOW).toISOString() });
  const held = (): string => new Date(NOW + TIMINGS.holdSubmittedMs).toISOString();

  test("hold a clip's reserve 60 min from its `at` when no library is open at the start", async () => {
    await writeLedger(dir(), [openReserve()]);
    const settings = { ...engineInit(dir()).settings, libraryPath: join(dir(), "unmounted") };
    const engine = await startClipEngine(dir(), { timings: TIMINGS, init: { settings } });
    expect(engine.engine.library).toBeNull();
    expect((await moneyStatus(engine)).reconcileAvailableAt).toBe(held());
    expect(await reconcile(engine)).toMatchObject({ ok: true, result: { status: "too-early" } });
    await engine.engine.shutdown();
  });

  test("hold it the same when the clip's journal is in another library than the open one", async () => {
    await writeLedger(dir(), [openReserve()]);
    const engine = await startClipEngine(dir(), { timings: TIMINGS });
    expect((await moneyStatus(engine)).reconcileAvailableAt).toBe(held());
    await engine.engine.shutdown();
  });

  test("keep the longer hold when a library switch brings in the journal that says less", async () => {
    await writeLedger(dir(), [openReserve()]);
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    const { avatarId, photoId } = await seedClipAvatar(other);
    const folder = clipsDir(other, avatarId);
    await mkdir(folder, { recursive: true });
    const journal = journalOf(folder, CLIP_ID);
    await journal.requested({
      clipId: CLIP_ID,
      photoId,
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
      acceptedWorstMicros: 850_000,
      at: new Date(NOW).toISOString(),
    });
    await journal.submitted({ attemptId: clipAttemptId(CLIP_ID, 1), model: "kling", providerJobId: "job-kling-1", at: new Date(NOW).toISOString() });
    await journal.ended({ attemptId: clipAttemptId(CLIP_ID, 1), status: "refused", costSource: "proof", at: new Date(NOW).toISOString() });
    const engine = await startClipEngine(dir(), { timings: TIMINGS });
    await engine.engine.receive({ kind: "control", type: "library.open", callId: "call-00000010", path: other });
    await engine.engine.receive({ kind: "control", type: "library.confirm", callId: "call-00000011", path: other });
    await clipJobDone(engine);
    expect((await moneyStatus(engine)).reconcileAvailableAt).toBe(held());
    await engine.engine.shutdown();
  });
});

describe("money.status after a restart, when no hold applies", () => {
  test("carries the reconcile's quiet wait (about 5 min) for a clip's reserve of an earlier process", async () => {
    await seedClipAvatar(libraryDir());
    await writeLedger(dir(), [{ type: "reserve", attemptId: clipAttemptId("clip-00000042", 1), jobId: "clip-00000042", scope: { avatarJobId: "clip-00000042" }, model: "kwaivgi/kling-video-o1", worstMicros: 504_000, at: new Date(NOW - 60 * MIN).toISOString() }]);
    const engine = await startClipEngine(dir(), { timings: TIMINGS });
    const status = await moneyStatus(engine);
    expect(status).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"] });
    const waitMs = Date.parse(String(status.reconcileAvailableAt)) - (NOW + 1_000);
    expect(waitMs).toBeGreaterThan(4 * MIN);
    expect(waitMs).toBeLessThanOrEqual(5 * MIN + 5_000);
  });

  test("carries nothing for a photo's reserve of an earlier process: the photo path is unchanged", async () => {
    await seedClipAvatar(libraryDir());
    await writeLedger(dir(), [{ type: "reserve", attemptId: "old-0001", jobId: "old-0001", scope: { avatarJobId: "old-0001" }, model: "x-ai/grok-4.3", worstMicros: 1000, at: new Date(NOW - 60 * MIN).toISOString() }]);
    const engine = await startClipEngine(dir(), { timings: TIMINGS });
    const status = await moneyStatus(engine);
    expect(status).toMatchObject({ reconcileNeeded: true });
    expect(status).not.toHaveProperty("reconcileAvailableAt");
  });

  test("carries nothing when the ledger holds no open reserve at all", async () => {
    await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { timings: TIMINGS });
    expect(await moneyStatus(engine)).not.toHaveProperty("reconcileAvailableAt");
  });
});

describe("a recovery job is a clip job like any other", () => {
  async function submittedOnDisk(): Promise<{ avatarId: string; clipId: string }> {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const clipId = "clip-00000043";
    const folder = clipsDir(libraryDir(), avatarId);
    await mkdir(folder, { recursive: true });
    const journal = journalOf(folder, clipId);
    await journal.requested({
      clipId,
      photoId,
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
      acceptedWorstMicros: 850_000,
      at: new Date(NOW).toISOString(),
    });
    await journal.submitted({ attemptId: clipAttemptId(clipId, 1), model: "kling", providerJobId: "job-kling-1", at: new Date(NOW).toISOString() });
    await writeLedger(dir(), [{ type: "reserve", attemptId: clipAttemptId(clipId, 1), jobId: clipId, scope: { avatarJobId: clipId }, model: "kwaivgi/kling-video-o1", worstMicros: 504_000, at: new Date(NOW).toISOString() }]);
    return { avatarId, clipId };
  }

  const reply = async (engine: ClipEngine, call: unknown): Promise<EngineReply> => {
    await engine.engine.receive(call);
    return EngineReply.parse(engine.posted.at(-1));
  };

  test("an avatar delete waits for it", async () => {
    const { avatarId } = await submittedOnDisk();
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }), timings: TIMINGS });
    await until(() => engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip"), "the recovery job");

    const deletePrepare = await reply(engine, { kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });
    expect(deletePrepare.error?.code).toBe("IN_FLIGHT");

    engine.net.release("kling");
    await clipJobDone(engine);
  });

  test("a library switch does not wait for it: it stops, with its journal and its holds kept for the next open", async () => {
    const { avatarId, clipId } = await submittedOnDisk();
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }), timings: TIMINGS });
    await until(() => engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip"), "the recovery job");

    expect((await reply(engine, { kind: "control", type: "library.open", callId: "call-00000002", path: other })).error).toBeUndefined();
    expect((await reply(engine, { kind: "control", type: "library.confirm", callId: "call-00000005", path: other })).error).toBeUndefined();
    await until(() => engine.events().some((e) => e.type === "job.cancelled" && e.payload.kind === "clip"), "the recovery job's stop");

    expect(existsSync(join(clipsDir(libraryDir(), avatarId), `${clipId}.journal.jsonl`))).toBe(true);
    expect(existsSync(join(clipsDir(libraryDir(), avatarId), `${clipId}.json`))).toBe(false);
    // The submitted attempt is held 60 min (here the short set's 10 min) from its submit, which is later than the quiet wait: the exact time, not just «some time».
    expect((await moneyStatus(engine)).reconcileAvailableAt).toBe(new Date(NOW + TIMINGS.holdSubmittedMs).toISOString());
  });

  test("a switch into LIBRARY_UNAVAILABLE stops it too", async () => {
    const { avatarId, clipId } = await submittedOnDisk();
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }), timings: TIMINGS });
    await until(() => engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip"), "the recovery job");

    await engine.engine.receive({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { libraryPath: join(dir(), "does-not-exist") }) });
    await until(() => engine.events().some((e) => e.type === "job.cancelled" && e.payload.kind === "clip"), "the recovery job's stop");
    expect(existsSync(join(clipsDir(libraryDir(), avatarId), `${clipId}.journal.jsonl`))).toBe(true);
  });

  test("a cancel of it says so in every phase, not only `recovering`", async () => {
    await submittedOnDisk();
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { content: "held" } }), timings: TIMINGS });
    await until(() => engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.phase === "downloading"), "the download");
    const progress = engine.events().find((e) => e.type === "job.progress" && e.payload.kind === "clip");
    const jobId = progress?.type === "job.progress" ? progress.payload.jobId : "";

    const answer = await engine.engine.handle(command("avatars.cancel", { jobId }));
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("unreachable");
    expect(answer.error).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });

    engine.net.releaseContent("kling");
    await clipJobDone(engine);
  });

  test("a cancel of it says the clip is being worked on, not that it was sent", async () => {
    await submittedOnDisk();
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }), timings: TIMINGS });
    await until(() => engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip"), "the recovery job");
    const progress = engine.events().find((e) => e.type === "job.progress" && e.payload.kind === "clip");
    const jobId = progress?.type === "job.progress" ? progress.payload.jobId : "";

    const answer = await engine.engine.handle(command("avatars.cancel", { jobId }));
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("unreachable");
    expect(answer.error).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });

    engine.net.release("kling");
    await clipJobDone(engine);
  });

  test("a library switch into a folder with a journal recovers it there", async () => {
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    const { avatarId, photoId } = await seedClipAvatar(other);
    const folder = clipsDir(other, avatarId);
    await mkdir(folder, { recursive: true });
    await journalOf(folder, "clip-00000044").requested({
      clipId: "clip-00000044",
      photoId,
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
      acceptedWorstMicros: 850_000,
      at: new Date(NOW).toISOString(),
    });
    const engine = await startClipEngine(dir(), { timings: TIMINGS });
    expect(engine.events().some((e) => e.type === "job.done")).toBe(false);

    expect((await reply(engine, { kind: "control", type: "library.open", callId: "call-00000003", path: other })).error).toBeUndefined();
    const answer = await reply(engine, { kind: "control", type: "library.confirm", callId: "call-00000004", path: other });
    expect(answer.error).toBeUndefined();
    await clipJobDone(engine);
    const read = await readClipRecord(folder, "clip-00000044");
    expect(read.kind === "record" ? read.record.outcome : null).toEqual({ status: "failed", reason: "lost" });
  });
});
